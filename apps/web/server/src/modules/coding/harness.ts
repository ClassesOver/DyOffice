import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {mkdtemp, mkdir, readdir, open, rm, realpath, stat, readFile, writeFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, relative, dirname, isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveCodexCliPath, attachBoundedRpcStdout} from '../../../../../../packages/ai-provider/src/codex-app-server.ts'
import type {HarnessDataGrant} from '../../../../../../packages/web-contracts/src/harness-data.ts'
import type {CodingTask,CodingResult} from '../../../../../../packages/agent-core/src/coding-skill.ts'

export interface CodingHarnessModel {baseUrl:string;apiKey:string;modelId:string}
export interface CodingHarnessOptions {cliPath?:string;analysisPython?:string;workspaceRoot?:string;timeoutMs?:number;dataHelper?:string}
const defaultAnalysisPython=fileURLToPath(new URL('../../../../../../.dyoffice-analysis-build/runtime/bin/python',import.meta.url))
const defaultDataHelper=fileURLToPath(new URL('../../../../../../.dyoffice-analysis-build/harness-data.mjs',import.meta.url))
export interface CodingHarnessData {baseUrl:string;grant:HarnessDataGrant;socketPath?:string;mailboxDirectory?:string}
const aborted=()=>Object.assign(new Error('Coding task cancelled'),{name:'AbortError'})
/** Separate scratch workspace and restricted reads; inference is Office-owned. */
export function createCodingHarness(options:CodingHarnessOptions={}) {
  if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>600000))throw Error('Invalid coding timeout')
  return {async run(input:CodingTask,signal:AbortSignal,model:CodingHarnessModel,data?:CodingHarnessData):Promise<CodingResult> {
    if(!model||!/^http:\/\/127\.0\.0\.1:[0-9]+\/v1$/.test(model.baseUrl)||!model.apiKey||!model.modelId)throw Error('Office model gateway required')
    if(process.platform==='win32')throw Error('Coding process-tree isolation unavailable on this platform')
    if(signal.aborted)throw aborted()
    if(typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>16000||
      (input.context!==undefined&&(typeof input.context!=='string'||input.context.length>32000)))throw Error('Invalid coding task')
    const cli=await resolveCodexCliPath(options.cliPath)
    if(signal.aborted)throw aborted()
    const executable=await realpath(cli)
    // npm's codex.js execs the native binary in its own installation package.
    const runtimePath=executable.endsWith('.js')?dirname(dirname(executable)):executable
    const analysisPython=options.analysisPython??((await stat(defaultAnalysisPython).catch(()=>null))?.isFile()?defaultAnalysisPython:undefined)
    if(analysisPython&&(!isAbsolute(analysisPython)||!(await stat(join(dirname(dirname(analysisPython)),'pyvenv.cfg')).catch(()=>null))?.isFile()))throw Error('Analysis runtime must be an installed virtual environment')
    const analysisRoot=analysisPython?await realpath(dirname(dirname(analysisPython))):undefined
    const analysisExecutable=analysisPython?await realpath(analysisPython):undefined
    const runtimeManifest=analysisRoot?join(dirname(analysisRoot),'manifest.json'):undefined
    const runtimeManifestBytes=runtimeManifest?await readFile(runtimeManifest).catch(()=>undefined):undefined
    const runtimeManifestSha256=runtimeManifestBytes?createHash('sha256').update(runtimeManifestBytes).digest('hex'):undefined
    const dataHelper=data?await realpath(options.dataHelper??defaultDataHelper):undefined
    const nodeExecutable=data?await realpath(process.execPath):undefined
    if(data&&(!data.grant?.credential||!data.grant.taskId||!data.baseUrl||data.socketPath&&!isAbsolute(data.socketPath)||data?.mailboxDirectory&&!isAbsolute(data.mailboxDirectory)))throw Error('Invalid task data grant')
    const cwd=await mkdtemp(join(options.workspaceRoot??tmpdir(),'office-coding-'))
    try {
      const codexHome=join(cwd,'.codex-runtime');await mkdir(codexHome,{mode:0o700})
      const credentialFile=data?join(cwd,'.office-data-credential'):undefined
      if(credentialFile)await writeFile(credentialFile,data!.grant.credential,{mode:0o600,flag:'wx'})
      const shellEnv={PATH:(analysisPython?dirname(analysisPython)+':':'')+'/usr/bin:/bin',HOME:cwd,
        PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PIP_NO_INDEX:'1',UV_OFFLINE:'1',
        OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',POLARS_MAX_THREADS:'2',
        MPLBACKEND:'Agg',MPLCONFIGDIR:join(cwd,'.matplotlib'),XDG_CACHE_HOME:join(cwd,'.cache'),
        ...(analysisRoot?{VIRTUAL_ENV:analysisRoot}:{}),
        ...(runtimeManifestSha256?{OFFICE_ANALYSIS_RUNTIME_MANIFEST_SHA256:runtimeManifestSha256}:{}),
        ...(data?{OFFICE_HARNESS_DATA_URL:data.baseUrl,OFFICE_HARNESS_TASK_ID:data.grant.taskId,OFFICE_HARNESS_DATA_CREDENTIAL_FILE:credentialFile!,
          ...(data.socketPath?{OFFICE_HARNESS_DATA_SOCKET:data.socketPath}:{}),
          ...(data.mailboxDirectory?{OFFICE_HARNESS_DATA_MAILBOX:data.mailboxDirectory}:{})}:{})}
      const permissions={':minimal':'read',[cwd]:'write',[runtimePath]:'read',
        ...(analysisRoot?{[analysisRoot]:'read'}:{}),...(analysisExecutable?{[analysisExecutable]:'read'}:{}),
        ...(dataHelper?{[dataHelper]:'read'}:{}),...(nodeExecutable?{[nodeExecutable]:'read'}:{}),
        ...(data?.socketPath?{[dirname(data.socketPath)]:'read'}:{}),
        ...(data?.mailboxDirectory?{[data.mailboxDirectory]:'write'}:{})}
      const tomlObject=(value:Record<string,unknown>)=>'{'+Object.entries(value).map(([key,v])=>JSON.stringify(key)+'='+JSON.stringify(v)).join(',')+'}'
      const summary=await new Promise<string>((resolve,reject)=>{
        if(signal.aborted){reject(aborted());return}
        const child=spawn(cli,['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules',
          '--skip-git-repo-check','--strict-config',
          '-c','model_provider="office"','-c','model='+JSON.stringify(model.modelId),
          '-c','model_providers.office='+tomlObject({name:'Office',base_url:model.baseUrl,env_key:'OFFICE_CODING_PROXY_KEY',wire_api:'responses',requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}),
          '-c','default_permissions="office_coding"',
          '-c','permissions.office_coding.filesystem='+tomlObject(permissions),
          '-c','shell_environment_policy.inherit="none"',
          '-c','shell_environment_policy.set='+tomlObject(shellEnv),
          '-c','approval_policy="never"','--color','never','-'],
          {cwd,env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>[
            'PATH','HOME','USERPROFILE','SystemRoot','SYSTEMROOT','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR',
            'LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
          ].includes(key))),HOME:codexHome,CODEX_HOME:codexHome,OFFICE_CODING_PROXY_KEY:model.apiKey},detached:true,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false})
        let failure:Error|undefined,final='',completed=false,total=0
        let killTimer:ReturnType<typeof setTimeout>|undefined
        const killGroup=(kind:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,kind)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}}
        const stop=(error:Error)=>{failure??=error;killGroup('SIGTERM');killTimer??=setTimeout(()=>killGroup('SIGKILL'),1000)}
        const cancel=()=>stop(aborted())
        const timer=setTimeout(()=>stop(Error('Codex coding task timed out')),options.timeoutMs??600000)
        signal.addEventListener('abort',cancel,{once:true})
        child.stdin.on('error',()=>{})
        child.stderr.on('data',()=>{})
        child.once('error',error=>{failure=error})
        attachBoundedRpcStdout(child,line=>{
          total+=Buffer.byteLength(line)
          if(total>2*1024*1024){stop(Error('Codex output limit exceeded'));return}
          try {
            const event=JSON.parse(line)
            if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')final=event.item.text.slice(0,32000)
            if(event.type==='turn.completed')completed=true
            if(event.type==='turn.failed'||event.type==='error')stop(Error('Codex coding task failed'))
          } catch {stop(Error('Invalid Codex event'))}
        },stop)
        child.once('close',code=>{
          killGroup('SIGKILL')
          clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',cancel)
          if(failure)reject(failure)
          else if(code!==0||!completed)reject(Error('Codex coding task did not complete'))
          else resolve(final||'Coding task completed')
        })
        child.stdin.end('You are a coding agent delegated by Office. Work in the provided temporary workspace. '+
          'Implement and test code when needed. Return a concise report. '+(data?'Local text and downloaded rows are not collected; deliver files only through artifacts.stage and artifacts.commit.\n':'Generated text files are collected automatically.\n')+
          (analysisPython?'Offline analysis Python: '+analysisPython+'. Use its preinstalled libraries; do not download packages or assets.\n':'Offline analysis libraries are not installed. Do not download packages; report missing dependencies when needed.\n')+
          (data?'Task-scoped Office data helper: '+JSON.stringify(nodeExecutable)+' '+JSON.stringify(dataHelper)+'. Commands: execute <operation> --args <JSON> (or --args-file <localJSONFile> for artifacts and large payloads), manifest <resultId>, receipt <commandId>, download <resultId> --out <localFile>. If a commit response is lost, recover with receipt and the original commandId; do not requery or repeat artifacts.commit. Authorization is already in environment; never print it. Use only these APIs for sources.list, sources.describe, sources.query, results.get_manifest. Download and verify frozen results before local processing; never put data rows in chat. Submit generated artifacts using artifacts.stage (name, mediaType, role, sha256, inputResultIds, bytesBase64), then artifacts.commit (commandId, summary, artifactIds, inputs, runtimeManifestSha256, limitations) with their ids and exact input provenance from manifest.artifact. Do not write Office documents directly; return conclusions and committed artifact references. Runtime manifest SHA-256: '+(runtimeManifestSha256??'unavailable; report missing runtime evidence')+'. Allowed inputs: '+JSON.stringify(data.grant.inputs)+'.\n':'')+
          JSON.stringify({instruction:input.instruction,context:input.context??'',...(input.dataInputs?{dataInputs:input.dataInputs}:{})}))
      })
      const outputs:string[]=[]
      let bytes=0
      async function collect(dir:string,depth=0):Promise<void> {
        if(depth>3||outputs.length>=12||bytes>=64000)return
        for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
          if(entry.name.startsWith('.')||['node_modules','__pycache__'].includes(entry.name))continue
          const path=join(dir,entry.name)
          if(entry.isDirectory())await collect(path,depth+1)
          else if(entry.isFile()&&outputs.length<12&&bytes<64000) {
            const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
            try {
              const stat=await handle.stat()
              if(!stat.isFile()||stat.size>16000||stat.nlink!==1)continue
              const buffer=Buffer.alloc(Math.min(16001,64000-bytes))
              const read=await handle.read(buffer,0,buffer.length,0)
              const data=buffer.subarray(0,read.bytesRead)
              if(data.includes(0))continue
              bytes+=data.length;outputs.push(relative(cwd,path)+'\n'+data.toString('utf8'))
            } finally {await handle.close()}
          }
        }
      }
      // 数据任务的下载快照、上传请求不可自动回灌 Office 模型。
      // 可交付文件仅通过带 provenance 的 stage/commit 返回。
      if(!data)await collect(cwd)
      return {summary,output:outputs.join('\n\n')}
    } finally {await rm(cwd,{recursive:true,force:true})}
  }}
}
