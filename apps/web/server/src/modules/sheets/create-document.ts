import { sheetCsvToXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import-xlsx'
import { isUtf8 } from 'node:buffer'
import { authError } from '../auth/sessions.ts'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import { fitFileStem, type FileService } from '../files/service.ts'

type Files = Pick<FileService,'stageUpload'|'receiveUpload'|'finishUpload'|'cancelUpload'>

export type AiXlsxInput = {title:string;sheetName?:string;content:string;layout?:import('@genoffice/xlsx-gateway/gateway/csv-import').SheetExportLayout}
export async function createAiXlsxDocument(files:Files,token:string,input:AiXlsxInput){
  const title=String(input.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,80).trim()||'Untitled'
  const bytes=await sheetCsvToXlsxBuffer(input.content,input.sheetName||'Sheet1',{layout:input.layout})
  if(bytes.byteLength>MAX_OBJECT_BYTES)throw new Error('The generated workbook exceeds the Web file size limit.')
  return publishGeneratedDocument(files,token,`${title}.xlsx`,bytes)
}
export async function createAiCsvDocument(files:Files,token:string,title:string,input:Buffer){
  if(input.length > MAX_OBJECT_BYTES-3)throw authError(413)
  if(!input.length||!isUtf8(input))throw authError(400)
  const cleaned=title.trim().replace(/\.csv$/i,'').replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,'_')
    .trim().replace(/^\.+/,'').trim()
  const stem=Array.from(cleaned).slice(0,80).join('').trim()||'Untitled'
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),input])
  return publishGeneratedDocument(files,token,`${fitFileStem(stem,'.csv')}.csv`,bytes,true)
}
async function publishGeneratedDocument(files:Files,token:string,name:string,bytes:Buffer,uniqueGeneratedName=false){
  const upload=await files.stageUpload(token,{name,size:bytes.byteLength})
  try{
    await files.receiveUpload(token,upload.uploadId,bytes)
    return await files.finishUpload(token,upload.uploadId,undefined,{uniqueGeneratedName})
  }catch(error){
    await files.cancelUpload(token,upload.uploadId).catch(()=>{})
    throw error
  }
}
