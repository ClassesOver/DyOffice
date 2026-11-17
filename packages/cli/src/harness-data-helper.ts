import {parseArgs} from './args'
import {HARNESS_DATA_USAGE,runHarnessDataCommand} from './harness-data-command'

// 内置 harness 使用此小入口，避免加载完整 Office 文件引擎或任何 MCP 组件。
const controller=new AbortController()
process.once('SIGTERM',()=>controller.abort())
process.once('SIGINT',()=>controller.abort())
const args=parseArgs(process.argv.slice(2),new Set(['json','help']))
if(args.flags.help||args.positionals.length===0)process.stdout.write(HARNESS_DATA_USAGE+'\n')
else void runHarnessDataCommand(args,{cwd:process.cwd(),env:process.env,signal:controller.signal}).then(result=>{
  process.stdout.write(JSON.stringify({status:'ok',...result})+'\n')
},()=>{
  process.stderr.write('Office task data operation unavailable\n')
  process.exitCode=1
})
