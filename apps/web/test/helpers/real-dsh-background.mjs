// Opt-in acceptance driver. Launches the official DSH; adds no plugin or HTTP connector.
import {spawn} from 'node:child_process'
import {copyFile,mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'

export async function realDshBackground(t){
 const config=JSON.parse(await readFile(process.env.DYOFFICE_REAL_DSH_CONFIG,'utf8'))
 for(const field of ['bin','home','patch','workspaceRoot'])if(typeof config[field]!=='string')throw Error('Real DSH acceptance configuration missing')
 await mkdir(config.workspaceRoot,{recursive:true,mode:0o700})
 const workspace=await mkdtemp(join(config.workspaceRoot,'office-channel-'))
 t.after(()=>rm(workspace,{recursive:true,force:true}))
 const save=(name,value)=>writeFile(join(workspace,name),JSON.stringify(value),{mode:0o600})
 async function run(stage,prompt){
  const child=spawn(process.execPath,[config.bin,'--profile','headless','--patch',config.patch,'--permission-mode','danger-full-access','--approval-policy','never','--json','-'],{cwd:workspace,env:{...process.env,DSH_HOME:config.home},stdio:['pipe','pipe','pipe']})
  const output=[],errors=[]
  child.stdout.on('data',b=>output.push(b));child.stderr.on('data',b=>errors.push(b))
  const timer=setTimeout(()=>child.kill('SIGKILL'),180000)
  child.stdin.end('Use only your built-in shell and Node fetch to perform this authorized DyOffice acceptance task. Do not install packages, plugins, connectors or genoffice. Work only in the current directory. Never print authorization tokens or secrets. '+prompt)
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}).finally(()=>clearTimeout(timer))
  const events=Buffer.concat(output).toString()
  // Logs stay in a private disposable directory; test failures never dump them.
  await writeFile(join(workspace,stage+'.jsonl'),events,{mode:0o600})
  await writeFile(join(workspace,stage+'.err'),Buffer.concat(errors),{mode:0o600})
  const final=events.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).findLast(e=>e.type==='final')
  if(code!==0||final?.reason?.kind!=='completed')throw Error('Real DSH '+stage+' did not complete: '+(final?.reason?.error?.code??'PROCESS_FAILED'))
  t.diagnostic('Official DSH '+stage+' completed; session '+final.sessionId)
  return final.text
 }
 return {
  entry:config.entry,
  async deliverDelegate(baseURL,memberToken,taskId,marker,resultId){
   await save('delegate-input.json',{baseURL,memberToken,taskId,marker,resultId})
   await copyFile(new URL('./dsh-delivery-fixture.mjs',import.meta.url),join(workspace,'deliver.mjs'))
   await run('deliver-delegate','Run exactly this command once: node deliver.mjs. It claims the assigned synthetic task, computes the total and commits the report. Do not open delegate-input.json or print any credentials. If the command fails, report the stage and stop. If it succeeds, confirm completion.')
   return JSON.parse(await readFile(join(workspace,'delivery-receipt.json'),'utf8'))
  },
  async execute(baseURL,memberToken,format){
   await save('task-input.json',{baseURL,memberToken})
   const text=await run('background',`The owner authorized a saved ${format.toUpperCase()} document and closed their browser. Read baseURL and memberToken from task-input.json privately. Use the same Authorization: Bearer memberToken header in all requests. GET baseURL + '/member', then read conversationId and member.membershipId from that JSON. POST to baseURL + '/members/' + membershipId + '/actions' with JSON {requestId: crypto.randomUUID(), conversationId, to:'office', action:{kind:'delegate', instruction:'请读取已保存文档，回答预算总额及单位，并标明所用保存版本。', execution:'saved-revision'}}. Poll GET baseURL + '/members/' + membershipId + '/tasks/' + taskId every 1 second for up to 90 seconds. If any HTTP request is non-200, stop and report only status and stage. Save the full task response to result.json when state is succeeded, failed, cancelled or unknown_outcome. Print JSON.stringify({taskId: result.taskId, savedRevision: result.savedRevision, state: result.state, summary: result.summary}) from the saved file. Copy that JSON verbatim as your final answer. Do not read any document directly.`)
   const result=JSON.parse(await readFile(join(workspace,'result.json'),'utf8'))
   if(!text.includes(result.taskId)||!text.includes(result.savedRevision))throw Error('DSH final answer omitted task or saved version')
   return result
  },
 }
}
