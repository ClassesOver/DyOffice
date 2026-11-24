import { sheetCsvToXlsxBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import-xlsx'
import { MAX_OBJECT_BYTES } from '../../storage/object-store.ts'
import type { FileService } from '../files/service.ts'

type Files = Pick<FileService,'stageUpload'|'receiveUpload'|'finishUpload'|'cancelUpload'>

export type AiXlsxInput = {title:string;sheetName?:string;content:string;layout?:import('@genoffice/xlsx-gateway/gateway/csv-import').SheetExportLayout}
export async function createAiXlsxDocument(files:Files,token:string,input:AiXlsxInput){
  const title=String(input.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,80).trim()||'Untitled'
  const bytes=await sheetCsvToXlsxBuffer(input.content,input.sheetName||'Sheet1',{layout:input.layout})
  if(bytes.byteLength>MAX_OBJECT_BYTES)throw new Error('The generated workbook exceeds the Web file size limit.')
  const upload=await files.stageUpload(token,{name:`${title}.xlsx`,size:bytes.byteLength})
  try{
    await files.receiveUpload(token,upload.uploadId,bytes)
    return await files.finishUpload(token,upload.uploadId)
  }catch(error){
    await files.cancelUpload(token,upload.uploadId).catch(()=>{})
    throw error
  }
}
