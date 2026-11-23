import {parseReasoningSignature,reasoningSignature} from '../../../../../../packages/ai-provider/src/protocols/openai-responses.ts'
import type {CodingProgress} from '../../../../../../packages/agent-core/src/coding-skill.ts'
import {createServer} from 'node:http'
import {randomBytes,randomUUID} from 'node:crypto'
import type {AgentMessage,AgentToolDef} from '../../../../../../packages/agent-core/src/types.ts'
import type {TurnEvent} from '../providers/turns.ts'

export interface CodingModelTurns {
  run(input:{token:string;modelId:string;turnId:string;request:unknown;signal?:AbortSignal},emit:(event:TurnEvent)=>void|Promise<void>):Promise<void>
}
const invalid=()=>Error('Unsupported coding model request')
const object=(v:any):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw invalid();return v}
const text=(v:unknown):string=>{if(typeof v!=='string')throw invalid();return v}
const id=(v:unknown):string=>{const s=text(v);if(!/^[A-Za-z0-9_-]{1,128}$/.test(s))throw invalid();return s}
export const CODING_MODEL_TOOLS=new Set(['exec_command','write_stdin','apply_patch','shell','shell_command','update_plan'])

/** Codex speaks Responses; Office's gateway accepts normalized turns.
 * This task-local adapter translates text and native coding tool calls only.
 * Upstream model, destination, credentials and spending remain gateway-owned.
 */
function convert(body:Record<string,any>) {
  if(body.previous_response_id||body.stream!==true||!Array.isArray(body.tools)||body.tools.length>64)throw invalid()
  const custom=new Set<string>(),tools:AgentToolDef[]=[]
  for(const raw of body.tools) {
    const tool=object(raw)
    if(tool.type!=='function'&&tool.type!=='custom')continue
    const name=id(tool.name)
    if(!CODING_MODEL_TOOLS.has(name))continue
    if(tool.type!=='function'&&tool.type!=='custom')throw invalid()
    if(tool.type==='custom')custom.add(name)
    tools.push({name,description:typeof tool.description==='string'?tool.description:'',inputSchema:tool.type==='custom'
      ?{type:'object',properties:{input:{type:'string'}},required:['input'],additionalProperties:false}:object(tool.parameters)})
  }
  const messages:AgentMessage[]=[],system=[typeof body.instructions==='string'?body.instructions:'']
  let signature:string|undefined
 const names=new Map<string,string>()
  const items=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input
  if(!Array.isArray(items)||items.length>512)throw invalid()
  function content(value:unknown):string {
    if(typeof value==='string')return value
    if(!Array.isArray(value))throw invalid()
    return value.map(raw=>{const p=object(raw);if(!['input_text','output_text'].includes(p.type))throw invalid();return text(p.text)}).join('\n')
  }
  for(const raw of items) {
    const item=object(raw)
    if(item.type==='reasoning'){
      signature=typeof item.id==='string'&&typeof item.encrypted_content==='string'?reasoningSignature(item.id,item.encrypted_content):undefined
      continue
    }
    if(item.type==='function_call'||item.type==='custom_tool_call') {
      const name=id(item.name),callId=id(item.call_id)
      if(!tools.some(t=>t.name===name)||names.has(callId))throw invalid()
      names.set(callId,name)
      const call={id:callId,name,...(signature?{signature}:{}),input:item.type==='custom_tool_call'?{input:text(item.input)}:object(JSON.parse(text(item.arguments)))}
      signature=undefined
      const last=messages.at(-1)
      if(last?.role==='assistant') (last.toolCalls??=[]).push(call)
      else messages.push({role:'assistant',text:'',toolCalls:[call]})
    } else if(item.type==='function_call_output'||item.type==='custom_tool_call_output') {
      const callId=id(item.call_id),name=names.get(callId)
      if(!name)throw invalid()
      const result={id:callId,name,output:content(item.output)}
      const last=messages.at(-1)
      if(last?.role==='tool')last.results.push(result)
      else messages.push({role:'tool',results:[result]})
    } else if(item.type==='message'||item.type===undefined) {
      const value=content(item.content)
      if(item.role==='system'||item.role==='developer')system.push(value)
      else if(item.role==='assistant') {
        const last=messages.at(-1)
        if(last?.role==='assistant'&&last.toolCalls?.length)last.text=[last.text,value].filter(Boolean).join('\n')
        else messages.push({role:'assistant',text:value})
      } else if(item.role==='user')messages.push({role:'user',text:value})
      else throw invalid()
    } else throw invalid()
  }
  return {request:{system:system.filter(Boolean).join('\n\n'),messages,tools},custom}
}

export async function createCodingModelBridge(options:{turns:CodingModelTurns;token:string;modelId:string;signal:AbortSignal;onProgress?:(event:CodingProgress)=>void}) {
  if(options.signal.aborted)throw Error('Coding task cancelled')
  const apiKey=randomBytes(32).toString('hex'),active=new Set<AbortController>()
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404).end();return}
    if(req.headers.authorization!=='Bearer '+apiKey){res.writeHead(401).end();return}
    const control=new AbortController();active.add(control)
    const disconnect=()=>{if(!res.writableEnded)control.abort()}
    res.on('close',disconnect)
    let sequence=0
    const event=(type:string,value:Record<string,unknown>)=>{
      if(control.signal.aborted||options.signal.aborted||res.destroyed)throw Error('Coding model disconnected')
      res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:sequence++,...value})+'\n\n')
    }
    const responseId='resp_'+randomBytes(12).toString('hex')
    try {
      let size=0;const chunks:Buffer[]=[]
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw invalid();chunks.push(chunk)}
      const {request,custom}=convert(object(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'})
      const base={id:responseId,object:'response',created_at:Math.floor(Date.now()/1000),model:options.modelId,output:[]}
      event('response.created',{response:{...base,status:'in_progress'}})
      const calls:Extract<TurnEvent,{type:'tool_call'}>[]=[]
      let inputTokens:number|undefined,outputTokens:number|undefined
      let outputText='',bytes=0
      options.onProgress?.({kind:'status',text:'Generating response'})
      await options.turns.run({token:options.token,modelId:options.modelId,turnId:randomUUID(),request,signal:control.signal},value=>{
        bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>2*1024*1024)throw invalid()
        if(value.type==='delta'){outputText+=value.text;options.onProgress?.({kind:'output',text:value.text})}
        else if(value.type==='tool_call')calls.push(value)
        else if(value.type==='usage') {
          inputTokens=value.inputTokens??inputTokens
          outputTokens=value.outputTokens??outputTokens
        } else if(value.type==='stop_reason')throw Error('Coding model output truncated')
      })
      if(outputText)options.onProgress?.({kind:'output',text:'\n\n'})
      // Expose executable candidates only after the gateway has settled this round.
      const output:Record<string,unknown>[]=[]
      for(const call of calls) {
        const reasoning=parseReasoningSignature(call.signature)
        if(reasoning){
          const item={type:'reasoning',id:reasoning.id,encrypted_content:reasoning.encrypted,summary:[]}
          event('response.output_item.added',{output_index:output.length,item})
          event('response.output_item.done',{output_index:output.length,item})
          output.push(item)
        }
        const index=output.length,customCall=custom.has(call.name)
        const item=customCall
          ?{type:'custom_tool_call',id:'ctc_'+call.id,call_id:call.id,name:call.name,input:text(call.input.input),status:'completed'}
          :{type:'function_call',id:'fc_'+call.id,call_id:call.id,name:call.name,arguments:JSON.stringify(call.input),status:'completed'}
        output.push(item)
        event('response.output_item.added',{output_index:index,item:{...item,status:'in_progress'}})
        event('response.output_item.done',{output_index:index,item})
      }
      if(outputText) {
        const index=output.length,item={type:'message',id:'msg_'+randomBytes(8).toString('hex'),role:'assistant',status:'completed',content:[{type:'output_text',text:outputText,annotations:[]}]}
        output.push(item)
        event('response.output_item.added',{output_index:index,item:{...item,status:'in_progress',content:[]}})
        event('response.content_part.added',{output_index:index,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}})
        event('response.output_text.delta',{output_index:index,item_id:item.id,content_index:0,delta:outputText})
        event('response.output_item.done',{output_index:index,item})
      }
      const usage=inputTokens!==undefined&&outputTokens!==undefined
        ?{input_tokens:inputTokens,output_tokens:outputTokens,total_tokens:inputTokens+outputTokens}
        :undefined
      event('response.completed',{response:{...base,status:'completed',output,...(usage?{usage}:{})}})
      res.end()
    } catch {
      if(!res.destroyed) {
        if(!res.headersSent)res.writeHead(400,{'content-type':'text/event-stream','cache-control':'no-store'})
        if(!control.signal.aborted&&!options.signal.aborted)event('response.failed',{response:{id:responseId,status:'failed',error:{code:'office_model_unavailable',message:'Office model or shared quota unavailable'}}})
        res.end()
      }
    } finally {active.delete(control);res.off('close',disconnect)}
  })
  const abort=()=>{for(const control of active)control.abort();server.closeAllConnections()}
  options.signal.addEventListener('abort',abort,{once:true})
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve()})})
    const address=server.address();if(!address||typeof address==='string'||options.signal.aborted)throw invalid()
    return {baseUrl:'http://127.0.0.1:'+address.port+'/v1',apiKey,
      async close(){options.signal.removeEventListener('abort',abort);abort();await new Promise<void>(resolve=>server.close(()=>resolve()))},
    }
  } catch(error) {options.signal.removeEventListener('abort',abort);abort();server.close();throw error}
}
