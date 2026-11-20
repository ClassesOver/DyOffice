import type {PdfSavedImageOperation} from './pdf-saved-image-drafts'
import type {SettingsRequest} from '../../../../packages/browser-host/src/preferences'
import type {PendingImageInsert} from './pdf-image-drafts'
import type {PdfTextInsert} from '../shell/pdf-preview-skill'
export type PdfDraftPreview={revision:string;pages:{page:number;width:number;height:number;png:string}[]}
export async function queryPdfDraftPreview(request:SettingsRequest,fileId:string,revision:string,operation:{texts:readonly PdfTextInsert[];images:readonly PendingImageInsert[];imageEdits?:readonly PdfSavedImageOperation[]},signal:AbortSignal):Promise<PdfDraftPreview>{
 const result=await request<PdfDraftPreview>(`/api/v1/files/${encodeURIComponent(fileId)}/pdf/draft-inserts/query`,'POST',{revision,operation},signal)
 signal.throwIfAborted()
 const expected=new Set([...operation.texts,...operation.images,...operation.imageEdits??[]].map(item=>item.page));let pixels=0,encoded=0
 if(result.revision!==revision||!Array.isArray(result.pages)||result.pages.length!==expected.size||new Set(result.pages.map(page=>page.page)).size!==expected.size||result.pages.some(page=>!expected.has(page.page)||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0||Math.ceil(page.width)*Math.ceil(page.height)>16000000||(pixels+=Math.ceil(page.width)*Math.ceil(page.height))>64000000||typeof page.png!=='string'||!page.png.startsWith('iVBORw0KGgo')||page.png.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(page.png)||(encoded+=page.png.length)>Math.ceil(24*1024*1024/3)*4))throw Error('图片预览无法核对，请重新生成预览。')
 await Promise.all(result.pages.map(async page=>{const image=new Image();image.src='data:image/png;base64,'+page.png;await image.decode?.();signal.throwIfAborted()}))
 return result
}
export function mountPdfDraftPreview(host:HTMLElement,preview:PdfDraftPreview){
 const cleanup:(()=>void)[]=[]
 try{
  for(const page of preview.pages){
   const surface=host.querySelector<HTMLElement>(`figure[data-pdf-page="${page.page}"] .pdf-page-surface`),canvas=surface?.querySelector('canvas')
   if(!surface||!canvas)throw Error('PDF 页面已变化，请重新生成预览。')
   const image=document.createElement('img'),visibility=canvas.style.visibility
   image.className='pdf-draft-raster';image.alt=`待保存图片预览第 ${page.page} 页`;image.src='data:image/png;base64,'+page.png;image.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0'
   surface.append(image);canvas.style.visibility='hidden'
   cleanup.push(()=>{image.remove();canvas.style.visibility=visibility})
  }
 }catch(error){for(const undo of cleanup)undo();throw error}
 return ()=>{for(const undo of cleanup)undo()}
}
