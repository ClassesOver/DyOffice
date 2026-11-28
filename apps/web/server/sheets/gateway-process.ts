import {open,writeFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {planWorkbookSave,planFromWorkbook,readWorkbookPackage} from './gateway.ts'
import {encodeGatewayPlan} from '../../worker/src/native/gateway.ts'
import {decodeCsvBuffer} from '../../../../packages/xlsx-gateway/src/gateway/csv-import.ts'
import {csvToXlsxBufferForOpen} from '../../../../packages/xlsx-gateway/src/gateway/csv-import-xlsx.ts'
import {read,utils,write,type WorkSheet} from '@e965/xlsx'

// This entry is bundled and executed only inside the host sandbox. It receives
// no SQL/S3/session credentials and never accepts input/output workbook paths.
const MAX=32*1024*1024,REQUEST_MAX=4*1024*1024
const workDir=process.env.DYOFFICE_WORK_DIR || '/work'
const resolveWorkPath=(logicalPath:string)=>workDir==='/work'?logicalPath:`${workDir}/${logicalPath.slice('/work/'.length)}`
const invalidInput=()=>Object.assign(new Error('INVALID_INPUT'),{statusCode:400})
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const compoundFileMagic=Buffer.from('d0cf11e0a1b11ae1','hex')
function convertLegacyXls(bytes:Buffer):Buffer {
  if(!bytes.subarray(0,8).equals(compoundFileMagic))throw invalidInput()
  const source=read(bytes,{type:'buffer',cellFormula:false,cellNF:true,cellHTML:false,cellText:false,bookVBA:false})
  if(!source.SheetNames.length||source.SheetNames.length>256)throw invalidInput()
  const workbook=utils.book_new()
  workbook.Workbook={WBProps:{date1904:source.Workbook?.WBProps?.date1904===true}}
  for(const name of source.SheetNames){
    const sheet:WorkSheet={},original=source.Sheets[name]
    if(original['!ref'])sheet['!ref']=original['!ref']
    for(const [address,cell] of Object.entries(original)){
      if(!/^[A-Z]{1,2}[1-9][0-9]{0,4}$/.test(address)||!cell||!['b','e','n','s'].includes(cell.t)||cell.v===undefined)continue
      const {t,v,z}=cell
      sheet[address]=typeof z==='string'?{t,v,z}:{t,v}
    }
    utils.book_append_sheet(workbook,sheet,name)
  }
  return write(workbook,{type:'buffer',bookType:'xlsx',compression:true})
}
async function readBounded(path:string,max:number) {
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0))
  try {
    const stat=await file.stat()
    if(!stat.isFile()||stat.size<1||stat.size>max)throw invalidInput()
    const bytes=Buffer.alloc(stat.size+1);let length=0
    while(length<bytes.length){const part=await file.read(bytes,length,bytes.length-length,null);if(!part.bytesRead)break;length+=part.bytesRead}
    if(length!==stat.size)throw invalidInput()
    return bytes.subarray(0,length)
  }finally{await file.close()}
}
async function execute(packet:Record<string,unknown>) {
  if(Object.keys(packet).sort().join(',')!=='command,path,requestId,version'||packet.version!==1||!['gateway_package','gateway_plan','gateway_convert_merge_source'].includes(packet.command as string)||typeof packet.path!=='string'||!/^\/work\/part-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(packet.path))throw new Error('INVALID_INPUT')
  const requestBytes=await readBounded(resolveWorkPath(packet.path),REQUEST_MAX)
  let request:unknown;try{request=JSON.parse(requestBytes.toString('utf8'))}catch{throw invalidInput()}
  if(!record(request))throw invalidInput()
  const bytes=await readBounded(resolveWorkPath('/work/input.xlsx'),MAX)
  let result:unknown
  if(packet.command==='gateway_convert_merge_source'){
    const keys=Object.keys(request).sort().join(',')
    const allowEmpty=keys==='allowEmpty,format'&&(request.format==='csv'||request.format==='tsv')&&request.allowEmpty===true
    if((keys!=='format'&&!allowEmpty)||(request.format!=='csv'&&request.format!=='tsv'&&request.format!=='xls'))throw invalidInput()
    try{
      if(request.format==='xls')result=convertLegacyXls(bytes)
      else{
        const converted=await csvToXlsxBufferForOpen(decodeCsvBuffer(bytes),'Sheet1',request.format==='tsv'?'\t':undefined)
        if(converted.empty&&!allowEmpty)throw invalidInput()
        result=converted.buffer
      }
    }catch{throw invalidInput()}
  }else if(packet.command==='gateway_package') {
    if(Object.keys(request).length===0) result=await readWorkbookPackage(bytes)
    else if(Object.keys(request).join(',')==='externalLinks'&&request.externalLinks===true) result=await readWorkbookPackage(bytes,undefined,{externalLinks:true})
    else if(Object.keys(request).join(',')==='webQuery'&&typeof request.webQuery==='string'&&request.webQuery.length>0&&request.webQuery.length<=200)
      result=await readWorkbookPackage(bytes,undefined,{webQuery:request.webQuery})
    else {
      if(Object.keys(request).sort().join(',')!=='cachePath,path'||typeof request.path!=='string'||typeof request.cachePath!=='string')throw invalidInput()
      result=await readWorkbookPackage(bytes,undefined,{path:request.path,cachePath:request.cachePath})
    }
  }else{
    // Absence of sheets selects the workbook-derived contract. Extra keys,
    // including a caller mapping beside it, never enter that mode.
    if(Object.keys(request).join(',')==='request') {
      result=encodeGatewayPlan(await planFromWorkbook(bytes,request.request))
    }else{
      if(Object.keys(request).sort().join(',')!=='request,sheets'||!Array.isArray(request.sheets)||request.sheets.length>256)throw invalidInput()
      const ids=new Set<string>(),names=new Set<string>()
      const sheets=request.sheets.map(sheet=>{
        if(!record(sheet)||Object.keys(sheet).sort().join(',')!=='id,name'||typeof sheet.id!=='string'||!sheet.id.length||sheet.id.length>512||typeof sheet.name!=='string'||!sheet.name.length||sheet.name.length>255||ids.has(sheet.id)||names.has(sheet.name))throw invalidInput()
        ids.add(sheet.id);names.add(sheet.name);return {id:sheet.id,name:sheet.name}
      })
      result=encodeGatewayPlan(await planWorkbookSave(bytes,sheets,request.request))
    }
  }
  const output=Buffer.isBuffer(result)?result:Buffer.from(JSON.stringify(result))
  if(output.length<1||output.length>MAX)throw new Error('INVALID_INPUT')
  await writeFile(resolveWorkPath('/work/output.xlsx'),output,{flag:'wx',mode:0o600})
  return {written:true}
}
let pending=Buffer.alloc(0),total=0,handled=false
for await(const chunk of process.stdin) {
  const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)
  total+=bytes.length
  if(total>65536){process.exitCode=1;break}
  pending=Buffer.concat([pending,bytes])
  for(;;){
    const end=pending.indexOf(10);if(end<0)break
    const line=pending.subarray(0,end);pending=pending.subarray(end+1)
    let requestId:string|undefined
    try {
      const packet:unknown=JSON.parse(line.toString('utf8'))
      if(!record(packet)||typeof packet.requestId!=='string'||!/^host-[1-9][0-9]{0,9}$/.test(packet.requestId))throw new Error('INVALID_INPUT')
      requestId=packet.requestId
      if(handled)throw new Error('INVALID_INPUT')
      handled=true
      const result=await execute(packet)
      process.stdout.write(JSON.stringify({version:1,requestId,ok:true,result})+'\n')
    }catch(error){
      // No stack, archive content, filesystem path or original parser message.
      const controlled=record(error)&&error.statusCode===400
      process.stdout.write(JSON.stringify(controlled?{version:1,requestId:requestId??'',ok:true,result:{error:'INVALID_INPUT'}}:{version:1,requestId:requestId??'',ok:false,error:'INVALID_INPUT'})+'\n')
    }
  }
}
if(pending.length)process.exitCode=1
