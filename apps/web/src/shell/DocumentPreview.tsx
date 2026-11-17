import {useEffect,useRef,useState} from 'react'
import {Alert,Button,Card,Spin} from 'antd'
import JSZip from 'jszip'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'

// XML prefixes are aliases. Accept the two OOXML namespace families, never a
// same-local-name element or relationship attribute from an unrelated namespace.
const previewNamespaces = {
 spreadsheet: ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'],
 presentation: ['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'],
 drawing: ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
 relationships: ['http://schemas.openxmlformats.org/package/2006/relationships'],
 relationshipIds: ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
}
function previewElements(node: Document | Element, family: keyof typeof previewNamespaces, localName: string) {
 return [...node.getElementsByTagNameNS('*', localName)].filter(element => previewNamespaces[family].includes(element.namespaceURI ?? ''))
}

type PreviewPage={name:string;rows:string[][]}
type Metadata={file:{fileId:string;revision:string};downloadEndpoint:string}
export function resolvePreviewContentUrl(fileId:string,metadata:Metadata){
 const revision=metadata?.file?.revision
 const expected=`/api/v1/files/${encodeURIComponent(fileId)}/content?revision=${encodeURIComponent(revision)}`
 if(metadata?.file?.fileId!==fileId||typeof revision!=='string'||!revision||metadata.downloadEndpoint!==expected)throw Error('文件版本地址无效。')
 return expected
}
export async function parseOfficePreview(bytes:Uint8Array,format:'xlsx'|'pptx'):Promise<PreviewPage[]>{
 if(bytes.byteLength>16*1024*1024)throw Error('预览文件超过限制，请下载原件。')
 const zip=await JSZip.loadAsync(bytes),entries=Object.values(zip.files)
 if(entries.length>512)throw Error('文档条目过多，请下载原件。')
 let size=0
 for(const entry of entries){const declared=(entry as unknown as {_data?:{uncompressedSize?:number}})._data?.uncompressedSize??0;size+=declared;if(declared>8*1024*1024||size>32*1024*1024)throw Error('文档解压大小超过预览限制。')}
 async function xml(path:string){const file=zip.file(path);if(!file)return null;const content=await file.async('uint8array');if(content.byteLength>8*1024*1024)throw Error('文档内容超过预览限制。');const source=new TextDecoder().decode(content);if(/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('文档 XML 不支持。');const document=new DOMParser().parseFromString(source,'application/xml');if(document.getElementsByTagName('parsererror').length)throw Error('文档 XML 无效。');return document}
 const pages:PreviewPage[]=[]
 let paths=entries.filter(entry=>!entry.dir&&(format==='xlsx'?/^xl\/worksheets\/sheet\d+\.xml$/:/^ppt\/slides\/slide\d+\.xml$/).test(entry.name)).sort((a,b)=>Number(a.name.match(/\d+/)?.[0])-Number(b.name.match(/\d+/)?.[0])).map(entry=>({path:entry.name,name:''}))
 const base=format==='xlsx'?'xl':'ppt',indexPath=format==='xlsx'?'workbook':'presentation'
 const index=await xml(`${base}/${indexPath}.xml`),relationships=await xml(`${base}/_rels/${indexPath}.xml.rels`)
 if(index){
  if(!relationships)throw Error('文档页索引缺失，请下载原件。')
  const nodes=format==='xlsx'?previewElements(index,'spreadsheet','sheet'):previewElements(index,'presentation','sldId')
  paths=nodes.map(node=>{
   const id=previewNamespaces.relationshipIds.map(namespace=>node.getAttributeNS(namespace,'id')).find(value=>value!==null)
   const relationship=previewElements(relationships,'relationships','Relationship').find(item=>item.getAttribute('Id')===id)
   const target=relationship?.getAttribute('Target')??''
   const path=target.startsWith(`/${base}/`)?target.slice(1):`${base}/${target.replace(/^\.\//,'')}`
   const allowed=format==='xlsx'?/^xl\/worksheets\/[^/]+\.xml$/:/^ppt\/slides\/[^/]+\.xml$/
   if(relationship?.getAttribute('TargetMode')==='External'||!allowed.test(path)||!zip.file(path))throw Error('文档页索引无效，请下载原件。')
   return {path,name:format==='xlsx'?node.getAttribute('name')??'':''}
  })
 }
 if(paths.length>100)throw Error('文档页数超过预览限制。')
 const strings=format==='xlsx'?await xml('xl/sharedStrings.xml'):null
 const shared=strings?previewElements(strings,'spreadsheet','si').map(node=>node.textContent??''):[]
 let cells=0
 for(const path of paths){const doc=await xml(path.path);if(!doc)continue
  const rows:string[][]=[]
  if(format==='xlsx')for(const row of previewElements(doc,'spreadsheet','row').slice(0,200)){
   const values:string[]=[]
   for(const cell of previewElements(row,'spreadsheet','c')){if(++cells>20000)throw Error('单元格数量超过预览限制。');const ref=cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0];const index=ref?[...ref].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1:values.length;if(index>199)continue;while(values.length<index)values.push('');const value=previewElements(cell,'spreadsheet','v')[0]?.textContent??'';values[index]=cell.getAttribute('t')==='s'?shared[Number(value)]??'':cell.getAttribute('t')==='inlineStr'?previewElements(cell,'spreadsheet','is')[0]?.textContent??'':value}
   rows.push(values)
  }
  else for(const text of previewElements(doc,'drawing','t')){if(++cells>20000)throw Error('文本数量超过预览限制。');rows.push([text.textContent??''])}
  pages.push({name:path.name||(format==='xlsx'?`工作表 ${pages.length+1}`:`幻灯片 ${pages.length+1}`),rows})
 }
 if(!pages.length)throw Error('此文档没有可预览的内容，请下载原件。')
 return pages
}
export function DocumentPreview({fileId,name,format,request}:{fileId:string;name:string;format:'docx'|'xlsx'|'pptx'|'pdf';request:SettingsRequest}){
 const [pages,setPages]=useState<PreviewPage[]>([]),[url,setUrl]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(true)
 const host=useRef<HTMLDivElement>(null),loading=useRef(true)
 const [attempt,setAttempt]=useState(0)
 function retry(){if(loading.current)return;loading.current=true;setBusy(true);setAttempt(value=>value+1)}
 useEffect(()=>{let alive=true;const abort=new AbortController();const target=host.current;loading.current=true;setPages([]);setUrl('');setError('');setBusy(true)
 void(async()=>{try{
  const metadata=await request<Metadata>(`/api/v1/files/${encodeURIComponent(fileId)}`)
  const endpoint=resolvePreviewContentUrl(fileId,metadata);if(!alive)return;setUrl(endpoint)
  if(format==='docx')throw Error('当前 Word 编辑器未启用，请下载原件。')
  const response=await fetch(endpoint,{credentials:'same-origin',signal:abort.signal,redirect:'error'})
  if(!response.ok){await response.body?.cancel();throw Error('文件读取失败。')}
  const limit=format==='pdf'?64*1024*1024:16*1024*1024
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('文件超过预览大小限制。')}
  const reader=response.body?.getReader();if(!reader)throw Error('文件内容不可读取。')
  const chunks:Uint8Array[]=[];let size=0
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('文件超过预览大小限制。')}chunks.push(value)}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
  if(!alive)return
  if(format==='pdf'){const {mountPdfEditor}=await import('../editors/pdf-viewer');if(alive&&target)await mountPdfEditor(target,bytes,abort.signal)}
  else {const result=await parseOfficePreview(bytes,format);if(alive)setPages(result)}
 }catch{if(alive)setError('无法生成只读预览，可下载原件查看。')}finally{if(alive){loading.current=false;setBusy(false)}}})()
 return()=>{alive=false;abort.abort();target?.replaceChildren()}
 },[fileId,format,request,attempt])
 return <section style={{height:'100%',overflow:'auto',padding:24}}><Card title={name} extra={url&&<Button href={url} download={name}>下载原件</Button>}>
 <Alert type="info" showIcon title="只读预览" description={format==='pdf'?'仅显示原始 PDF 页面，不提供编辑。':'仅提取文本与缓存数值，不执行公式或外部连接，不保证原始排版。每张工作表最多显示 200 行、200 列。'}/>
 {busy&&<Spin tip="正在读取文档"/>}{error&&<Alert type="error" title={error} action={<Button disabled={busy} onClick={retry}>重新加载预览</Button>}/>}
 <div ref={host}/>{pages.map((page,index)=><Card key={index} title={page.name} style={{marginTop:16}}><div style={{overflow:'auto'}}><table><tbody>{page.rows.map((row,i)=><tr key={i}>{row.map((value,j)=><td key={j} style={{border:'1px solid var(--border)',padding:'6px 10px',whiteSpace:'pre-wrap'}}>{value}</td>)}</tr>)}</tbody></table></div></Card>)}
 </Card></section>
}
