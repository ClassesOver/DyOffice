import {afterEach,expect,it,vi} from 'vitest'
import {createWebAttachments} from '../../web/src/editors/web-attachments'
import {createFilesSkill} from '../src/renderer/ai/files-skill'

vi.mock('../src/renderer/i18n/locale',()=>({t:(key:string)=>key}))
afterEach(()=>vi.unstubAllGlobals())

it('surfaces truncated Web XLSX extraction as a tool error while preserving the merge source',async()=>{
 const attachments=createWebAttachments(async()=>({ok:true,kind:'text',text:'partial',truncated:true}))
 const file=new File(['original workbook bytes'],'large.xlsx')
 const path=attachments.getPathForFile(file)
 const added=await attachments.addAttachmentPaths([path])
 vi.stubGlobal('window',{desktopApi:{readAttachment:attachments.readAttachment}})
 const skill=createFilesSkill(()=>added.accepted)
 const result=await skill.executeTool({id:'read',name:'read_attachment',input:{index:0}})
 expect(result.isError).toBe(true)
 expect(result.output).toContain('only partial extracted text')
 expect(result.output).toContain('the original spreadsheet remains available for merge')
 expect(result.output).toContain('Reading the full attachment text is unavailable')
 expect(result.output).not.toContain('end of file')
 expect(await attachments.getFileForPath(path)).toBe(file)
 attachments.dispose()
})
