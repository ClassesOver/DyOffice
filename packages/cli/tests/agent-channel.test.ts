import {afterEach, describe, expect, it, vi} from 'vitest'
import {watch} from 'node:fs'
import {createServer, type Server, type RequestListener} from 'node:http'
import {mkdtemp, readFile, stat, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {agentCommand} from '../src/commands/agent'
import {parseArgs} from '../src/args'
import {ChannelClient} from '../src/agent-channel/client'
import {readState, writeState, runAdapter,watchChannel} from '../src/agent-channel/connector'

let server: Server | undefined
let directory: string | undefined
afterEach(async () => {await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server=undefined; if(directory)await rm(directory,{recursive:true,force:true})})
async function serve(handler: RequestListener) {
  server=createServer(handler); await new Promise<void>(resolve => server!.listen(0,'127.0.0.1',resolve))
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`
}
describe('external channel transport',()=>{
  it('sends member bearer without cookies and does not follow redirects',async()=>{
    let seen=''
    const origin=await serve((req,res)=>{seen=String(req.headers.authorization); expect(req.headers.cookie).toBeUndefined(); res.writeHead(302,{location:'/secret'});res.end('private upstream body')})
    await expect(new ChannelClient(origin).request('GET','/members/id/tasks','member-secret')).rejects.toThrow('redirect')
    expect(seen).toBe('Bearer member-secret')
  })
  it('rejects non-loopback HTTP and credential-bearing origins',()=>{
    expect(()=>new ChannelClient('http://example.com')).toThrow()
    expect(()=>new ChannelClient('https://user:secret@example.com')).toThrow()
  })
  it('bounds response bytes and hides remote error bodies',async()=>{
    const origin=await serve((_req,res)=>{res.end('x'.repeat(300_000))})
    await expect(new ChannelClient(origin).request('GET','/applications/id','app-secret')).rejects.toThrow('limit')
  })
  it('persists credentials privately and refuses public state files',async()=>{
    directory=await mkdtemp(join(tmpdir(),'agent-channel-')); const path=join(directory,'state.json')
    const state={origin:'https://office.example',applicationId:'a',applicationToken:'secret'}
    await writeState(path,state); expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readState(path)).toEqual(state)
    await writeFile(path,await readFile(path),{mode:0o644}); const {chmod}=await import('node:fs/promises'); await chmod(path,0o644)
    await expect(readState(path)).rejects.toThrow('0600')
  })
  it('runs explicit executable argv and passes task JSON only over stdin',async()=>{
    const result=await runAdapter({command:process.execPath,args:['-e',"process.stdin.on('data',d=>process.stdout.write(JSON.stringify({summary:JSON.parse(d).task.instruction,outcome:'succeeded'})))"]},{task:{instruction:'hello'},claim:{claimId:'c'},connectionEpoch:1},{})
    expect(result).toEqual({summary:'hello',outcome:'succeeded'})
  })
})

it('joins once, saves application bearer, and never prints it',async()=>{
  directory=await mkdtemp(join(tmpdir(),'agent-channel-'));const invite=join(directory,'invite');const state=join(directory,'state.json');await writeFile(invite,'invitation-secret')
  let requests=0
  const origin=await serve((req,res)=>{requests++;let body='';req.on('data',c=>body+=c);req.on('end',()=>{expect(JSON.parse(body)).toEqual({inviteToken:'invitation-secret',name:'Test',kind:'custom'});res.setHeader('content-type','application/json');res.end(JSON.stringify({applicationId:'a',applicationToken:'application-secret'}))})})
  const ctx={cwd:directory,env:{},log:()=>{},warn:()=>{}}
  const args=parseArgs(['join','--origin',origin,'--invite-file',invite,'--state-file',state,'--name','Test'])
  const result=await agentCommand.run(args,ctx)
  expect(JSON.stringify(result)).not.toContain('secret');expect((await readState(state)).applicationToken).toBe('application-secret')
  await expect(agentCommand.run(args,ctx)).rejects.toThrow('exists');expect(requests).toBe(1)
})

it('claims the explicit task and submits a scoped result with the current epoch',async()=>{
  directory=await mkdtemp(join(tmpdir(),'agent-channel-'));const state=join(directory,'state.json');const adapter=join(directory,'adapter.json')
  const actions:unknown[]=[]
  const origin=await serve((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    expect(req.headers.authorization).toBe('Bearer member-secret')
    res.setHeader('content-type','application/json')
    if(req.url?.endsWith('/claim')){expect(JSON.parse(body)).toEqual({taskId:'task-one',connectionId:'connection-one',connectionEpoch:7});res.end(JSON.stringify({claimId:'claim-one',instruction:'assigned instruction'}))}
    else {actions.push(JSON.parse(body));res.end(JSON.stringify({messageId:'message-one'}))}
  })})
  await writeState(state,{origin,memberId:'member-one',memberToken:'member-secret',conversationId:'channel-one',connectionId:'connection-one',connectionEpoch:7})
  await writeFile(adapter,JSON.stringify({command:process.execPath,args:['-e',"process.stdin.on('data',d=>process.stdout.write(JSON.stringify({summary:JSON.parse(d).task.instruction,outcome:'succeeded'})))"]}))
  const result=await agentCommand.run(parseArgs(['run','--state-file',state,'--adapter-file',adapter,'--task','task-one']),{cwd:directory,env:{},log:()=>{},warn:()=>{}})
  expect(result.detail).toEqual({messageId:'message-one'})
  expect(actions).toEqual([{requestId:expect.any(String),conversationId:'channel-one',to:'office',action:{kind:'result',taskId:'task-one',claimId:'claim-one',connectionEpoch:7,summary:'assigned instruction',outcome:'succeeded'}}])
})

it('does not echo malformed credential file contents in errors',async()=>{
  directory=await mkdtemp(join(tmpdir(),'agent-channel-'));const state=join(directory,'state.json')
  await writeFile(state,'{"memberToken":"super-secret", nope}',{mode:0o600})
  try{await readState(state);expect.fail('expected rejection')}catch(error){expect(String(error)).not.toContain('super-secret')}
})

it('aborts the adapter process group rather than leaving its child running',async()=>{
 const {kill}=process;const controller=new AbortController()
 directory=await mkdtemp(join(tmpdir(),'agent-channel-'));const marker=join(directory,'child.pid')
 const script="const{spawn}=require('node:child_process');const{writeFileSync,renameSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});const marker=process.argv[1];writeFileSync(marker+'.tmp',String(c.pid));renameSync(marker+'.tmp',marker);setInterval(()=>{},1000)"
 const started=new Promise<void>(resolve=>{const watcher=watch(directory!,(_,name)=>{if(name==='child.pid'){watcher.close();resolve()}})})
 const work=runAdapter({command:process.execPath,args:['-e',script,marker]}, {},{},controller.signal)
 const outcome=expect(work).rejects.toThrow('adapter')
 // File observation is asynchronous; no subprocess output or busy polling is needed.
 await started
 const pid=Number(await readFile(marker,'utf8'));controller.abort();await outcome
 expect(pid).toBeGreaterThan(0)
 await vi.waitFor(()=>expect(()=>kill(pid,0)).toThrow(),{timeout:3000})
})

it('watches once per claim and disconnects without replaying a lost result response',async()=>{
 const {watchChannel}=await import('../src/agent-channel/connector')
 let claims=0,results=0,disconnected=false
 const controller=new AbortController()
 const origin=await serve((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  res.setHeader('content-type','application/json')
  if(req.url?.endsWith('/connect'))res.end(JSON.stringify({connectionEpoch:2}))
  else if(req.url?.endsWith('/tasks'))res.end(JSON.stringify({member:{connectionEpoch:2},tasks:[{taskId:'one',state:'queued',to:'member'}]}))
  else if(req.url?.endsWith('/claim')){claims++;res.end(JSON.stringify({claimId:'claim',instruction:'work'}))}
  else if(req.url?.endsWith('/actions')){results++;res.writeHead(503);res.end('{}')}
  else if(req.url?.endsWith('/disconnect')){disconnected=true;res.end('{}')}
 })})
 await expect(watchChannel({client:new ChannelClient(origin),state:{origin,memberId:'member',memberToken:'secret',conversationId:'channel'},adapter:{command:process.execPath,args:['-e',"process.stdin.on('data',()=>process.stdout.write(JSON.stringify({summary:'done',outcome:'succeeded'})))"]},env:{},signal:controller.signal,save:async()=>{}})).rejects.toThrow('503')
 expect(claims).toBe(1);expect(results).toBe(1);expect(disconnected).toBe(true)
})

it('exchanges task data only after claim and passes its capability over adapter stdin without printing secrets',async()=>{
 directory=await mkdtemp(join(tmpdir(),'agent-channel-data-'));const state=join(directory,'state.json'),adapter=join(directory,'adapter.json')
 const order:string[]=[]
 const origin=await serve((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  res.setHeader('content-type','application/json')
  if(req.url?.endsWith('/claim')){order.push('claim');res.end(JSON.stringify({claimId:'claim',instruction:'Analyze',dataInputs:{sourceIds:[],resultIds:['result']}}))}
  else if(req.url?.endsWith('/data-grant')){order.push('data');expect(JSON.parse(body)).toEqual({claimId:'claim',connectionEpoch:3});res.end(JSON.stringify({baseUrl:origin+'/api/v1/agents',grant:{taskId:'data-task',credential:'data-secret',inputs:{sourceIds:[],resultIds:['result']}}}))}
  else {order.push('result');expect(JSON.parse(body).action.summary).toBe('Data capability received');res.end(JSON.stringify({messageId:'done'}))}
 })})
 await writeState(state,{origin,memberId:'member',memberToken:'member-secret',conversationId:'channel',connectionId:'connection',connectionEpoch:3})
 const script="process.stdin.on('data',d=>{const v=JSON.parse(d);if(v.data.grant.credential!=='data-secret'||v.data.grant.taskId!=='data-task'||process.argv.some(a=>a.includes('data-secret')))process.exit(1);process.stdout.write(JSON.stringify({summary:'Data capability received',outcome:'succeeded'}))})"
 await writeFile(adapter,JSON.stringify({command:process.execPath,args:['-e',script]}))
 const result=await agentCommand.run(parseArgs(['run','--state-file',state,'--adapter-file',adapter,'--task','task']),{cwd:directory,env:{},log:()=>{},warn:()=>{}})
 expect(order).toEqual(['claim','data','result']);expect(JSON.stringify(result)).not.toContain('secret')
})

it.each([
 {scenario:'one-shot source grant',mode:'run',sources:['sales'],deadline:600_000,revoked:false,success:true},
 {scenario:'watched source grant',mode:'watch',sources:['sales'],deadline:600_000,revoked:false,success:true},
 {scenario:'ordinary 60 s task',mode:'run',sources:[],deadline:600_000,revoked:false,success:false},
 {scenario:'earlier channel deadline',mode:'run',sources:['sales'],deadline:80_000,revoked:false,success:false},
 {scenario:'replaced claim',mode:'run',sources:['sales'],deadline:600_000,revoked:true,success:false},
])('keeps the managed adapter within its claim and runtime for $scenario',async({mode,sources,deadline,revoked,success})=>{
 directory=await mkdtemp(join(tmpdir(),'agent-channel-duration-'))
 const root=directory,statePath=join(root,'state.json'),adapterPath=join(root,'adapter.json')
 const stop=new AbortController()
 let claimed=false,renewals=0,submissions=0
 const origin=await serve((req,res)=>{
  req.resume()
  res.setHeader('content-type','application/json')
  if(req.url?.endsWith('/connect'))res.end(JSON.stringify({connectionEpoch:3}))
  else if(req.url?.endsWith('/claim')){
   claimed=true
   res.end(JSON.stringify({claimId:'claim',instruction:'Analyze',deadlineAt:new Date(Date.now()+deadline).toISOString(),dataInputs:{sourceIds:sources,resultIds:[]}}))
  }else if(req.url?.endsWith('/data-grant'))res.end(JSON.stringify({baseUrl:origin+'/api/v1/agents',grant:{credential:'cap',inputs:{sourceIds:sources,resultIds:[]}}}))
  else if(req.url?.endsWith('/tasks')){
   if(claimed)renewals++
   res.end(JSON.stringify({paused:false,member:{connectionEpoch:3},tasks:[{taskId:'task',to:'member',state:claimed?'running':'queued',claimId:revoked?'replacement':claimed?'claim':null,connectionEpoch:3}]}))
  }else if(req.url?.endsWith('/actions')){
   submissions++;res.end(JSON.stringify({messageId:'done'}));stop.abort()
  }else res.end('{}')
 })
 const state={origin,memberId:'member',memberToken:'secret',conversationId:'channel',connectionId:'connection',connectionEpoch:3}
 const adapter={command:process.execPath,args:['-e',`
  const fs=require('node:fs'), path=require('node:path'), dir=process.argv[1];
  process.stdin.resume();
  const watcher=fs.watch(dir,(_,name)=>{if(name==='release'){watcher.close();process.stdout.write(JSON.stringify({summary:'done',outcome:'succeeded'}))}});
  fs.writeFileSync(path.join(dir,'started'),'');
 `,root]}
 await writeState(statePath,state);await writeFile(adapterPath,JSON.stringify(adapter))
 const started=new Promise<void>(resolve=>{const watcher=watch(root,(_,name)=>{if(name==='started'){watcher.close();resolve()}})})
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','setInterval','clearInterval']})
 try{
  const work=mode==='run'?agentCommand.run(parseArgs(['run','--state-file',statePath,'--adapter-file',adapterPath,'--task','task']),{cwd:root,env:{},log:()=>{},warn:()=>{}}):
   watchChannel({client:new ChannelClient(origin),state,adapter,env:{},signal:stop.signal,save:async()=>{}})
  const result=work.then(()=>true,()=>false)
  await started
  vi.advanceTimersByTime(revoked?15_000:sources.length?245_500:60_500)
  vi.useRealTimers()
  if(revoked){
   let timer:ReturnType<typeof setTimeout>|undefined
   try{
    expect(await Promise.race([result,new Promise<'still running'>(resolve=>{timer=setTimeout(()=>resolve('still running'),2000)})])).toBe(false)
   }finally{clearTimeout(timer);await writeFile(join(root,'release'),'')}
  }else await writeFile(join(root,'release'),'')
  expect(await result).toBe(success)
  expect(submissions).toBe(success?1:0)
  if(success||revoked)expect(renewals).toBeGreaterThan(0)
 }finally{vi.useRealTimers();stop.abort()}
})
