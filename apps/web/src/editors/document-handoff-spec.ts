const defaultPdfTools=['read_pages','list_inserted_text','insert_text','insert_blank_page'] as const
// find_sensitive_info can also open the redaction review, so it is not offered in follow-ups.
const pdfReadToolNames=new Set([
 'read_pages','search_text','read_annotations',
 'list_inserted_text','list_page_images','list_form_fields','get_outline',
])

export function documentHandoffPdfTools(pdfTools:readonly string[]=defaultPdfTools){
 const read:string[]=[],write:string[]=[]
 for(const name of new Set(pdfTools)){
  if(name==='goto_page')continue
  if(pdfReadToolNames.has(name))read.push(name)
  else write.push(name)
 }
 return {read,write}
}

export function readHandoffSkill(input:unknown) {
 if(!input||typeof input!=='object')return undefined
 const {name,content}=input as Record<string,unknown>
 if(typeof name!=='string'||!/^[\p{L}\p{N}_.-]{1,128}$/u.test(name)||
    typeof content!=='string'||!content.trim()||new TextEncoder().encode(content).length>24000)return undefined
 return {name,content}
}
