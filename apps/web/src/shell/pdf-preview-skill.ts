import type {PdfPendingPlan,PdfPendingSnapshot} from '../editors/pdf-pending-ops'
import type {PdfApplyOperation} from '../../../../packages/web-contracts/src/pdf-apply-ops'
import {validatePdfApplyOperations} from '../../../../packages/web-contracts/src/pdf-apply-ops'
import {validatePdfFormFieldOperations,type PdfFormFieldOperation} from '../../../../packages/web-contracts/src/pdf-form-fields'
import {validatePdfFormMark,type PdfFormMarkInput} from '../editors/pdf-form-marks'
import {validatePdfStampOperation,type PdfStampOperation} from '../../../../packages/web-contracts/src/pdf-stamp-ops'
import type {FormField} from '../../../pdf/src/renderer/form-catalog'
import {findPattern,REDACT_PATTERNS,type RedactPattern} from '../../../pdf/src/renderer/redact-patterns'
import type {PdfPageLayout} from '../editors/pdf-extraction'
import {PDF_PAPER_SIZES,parsePdfPageRanges} from './pdf-page-inputs'
import {validatePdfPageOperations,type PdfPageOperation} from '../../../../packages/web-contracts/src/pdf-page-ops'
import type {AgentSkill,AgentToolDef} from '@genoffice/agent-core'

export interface PdfPendingTools {
 apply:(operations:readonly PdfApplyOperation[],options:{dryRun:boolean;signal?:AbortSignal})=>PdfPendingPlan|Promise<PdfPendingPlan>
 annotate?:(annotation:PdfAnnotation,signal?:AbortSignal)=>Promise<{markups:readonly {id:string;pageIndex:number}[];notes:readonly {id:string;input:{pageIndex:number}}[]}>
 annotations?:()=>Pick<PdfPendingSnapshot,'markups'|'notes'|'deleted'>
}
export interface PdfPreviewOptions {pending?:PdfPendingTools}

export type PreviewPage={page:number;text:string;width?:number;height?:number;annotations?:readonly {id:string;type:string;author:string;contents:string;replyTo?:string}[]}
export type PdfTextInsert={page:number;text:string;anchor_text?:string;placement?:'right'|'below'|'above';x?:number;y?:number;font_size?:number;color?:string;max_width?:number;align?:'left'|'center'|'right';font?:'arial'|'times'|'courier';bold?:boolean;italic?:boolean}
export type PdfTextDraftInfo={id:string;page:number;text:string;x:number;y:number;width:number;height:number;font_size:number;color:string;align:'left'|'center'|'right';font?:'arial'|'times'|'courier';bold?:boolean;italic?:boolean;max_width?:number;line_widths?:readonly number[]}
export type PdfTextDraftTools={
 list:(page?:number)=>readonly PdfTextDraftInfo[];
 insert:(input:PdfTextInsert,signal?:AbortSignal)=>Promise<PdfTextDraftInfo>;
 edit:(input:{id:string;text?:string;font_size?:number;color?:string;align?:'left'|'center'|'right'},signal?:AbortSignal)=>Promise<PdfTextDraftInfo>;
 move:(input:{id:string;x?:number;y?:number;dx?:number;dy?:number},signal?:AbortSignal)=>Promise<PdfTextDraftInfo>;
 remove:(id:string,signal?:AbortSignal)=>void|Promise<void>;
 removeMany?:(ids:readonly string[],signal?:AbortSignal)=>Promise<void>;
}
export type PdfImageInfo={page:number;image_number:number;x:number;y:number;width:number;height:number;layer:'above_text'|'below_text';pending?:boolean}
export type PdfImageBakeOperation={op:'flip_image';page:number;image_number:number;axis:'horizontal'|'vertical'}|{op:'set_image_opacity';page:number;image_number:number;opacity:number}|{op:'crop_image';page:number;image_number:number;left?:number;top?:number;right?:number;bottom?:number}|{op:'remove_image_background';page:number;image_number:number;tolerance?:number}
export type PdfImageOperation={op:'transform_image';page:number;image_number:number;x?:number;y?:number;width?:number;height?:number;layer?:'above_text'|'below_text'}|{op:'rotate_image';page:number;image_number:number;direction?:'cw'|'ccw'|'180'}|{op:'delete_image';page:number;image_number:number}|PdfImageBakeOperation
export type PdfImageContentInput={op:'insert_image';page:number;url:string;anchor_text?:string;placement?:'above'|'below'|'left'|'right';x?:number;y?:number;width?:number;layer?:'above_text'|'below_text'}|{op:'replace_image';page:number;image_number:number;url:string}
export type PdfImageBytes={base64:string;mime:'image/png'|'image/jpeg'}
export type PdfImageContentOperation=(Omit<Extract<PdfImageContentInput,{op:'insert_image'}>,'url'>|Omit<Extract<PdfImageContentInput,{op:'replace_image'}>,'url'>)&{image:PdfImageBytes}
export type PdfFormMarkOutcome={draft:PdfImageDraftInfo}|{fieldName:string}
export type PdfImageDraftInfo={id:string;page:number;x:number;y:number;width:number;height:number}
export type PdfImageTools={editsAreDrafts?:boolean;read:(page?:number,signal?:AbortSignal)=>Promise<readonly PdfImageInfo[]>;edit:(operation:PdfImageOperation,signal?:AbortSignal)=>Promise<boolean>;insertDraft?:(input:Extract<PdfImageContentInput,{op:'insert_image'}>,signal?:AbortSignal)=>Promise<PdfImageDraftInfo>;content?:(input:PdfImageContentInput,signal?:AbortSignal)=>Promise<boolean>}
function pendingImageDescription(name:string){
 const actions:Record<string,string>={
  transform_image:'Move or resize the saved image, or change its layer relative to text. x/y are displayed top-left points. Omitted values are retained; one size dimension preserves aspect ratio.',
  rotate_image:'Rotate the saved image about its center. cw is 90 degrees clockwise, ccw counter-clockwise, and 180 a half turn.',
  delete_image:'Delete the saved image from page content; the user can undo before saving.',
  flip_image:'Mirror the saved image horizontally (left-right) or vertically (top-bottom) as displayed, keeping footprint and order.',
  set_image_opacity:'Set absolute pixel opacity over the source saved image: 0 invisible, 1 unchanged. Preserve footprint and order.',
  crop_image:'Trim displayed-edge margins, given as fractions of current width/height. Opposing sums stay below 1. Snap to pixel edges and shrink the footprint so retained pixels keep position and scale. This is not redaction.',
  remove_image_background:'Make edge-connected background transparent with the PC flood-fill algorithm. tolerance 0–100 defaults to 30; best for plain backgrounds.',
  replace_image:'Replace saved image pixels with a PNG/JPEG HTTPS or generated data URL. Keep the transform and painting order, stretching new pixels to the original footprint. WebP is unsupported.',
 }
 return `${actions[name]} This is an unsaved edit. Call list_page_images first and use its source revision page/image_number. Only one pending edit per image is allowed; undo or save before editing it again. Only the user Save action creates a revision.`
}
function pendingImageResult(input:Record<string,unknown>){return {output:`Image ${input.image_number} on page ${input.page} has an unsaved edit. Only the user clicking Save creates a revision. The user can undo before saving; do not edit this image again until saved or undone.`,summary:'Edit unsaved PDF image',mutated:true}}
export type PdfBlockMove={page:number;paragraph_text:string;dx:number;dy:number}
export type PdfBlockEdit={page:number;paragraph_text:string;new_text:string;font_size?:number;color?:string;font?:'arial'|'times'|'courier';bold?:boolean;italic?:boolean;align?:'left'|'center'|'right'}
export type PdfTextEdit={page:number;oldText:string;newText:string;occurrence:number}
export type PdfAnnotation={page:number;text:string;type:'highlight'|'underline'|'strikeout'|'note';contents?:string;occurrence:number}
export type PdfAnnotationDelete={page:number;annotationId:string}
export type PdfFormValueOperation={op:'setFormValue';value:{name:string;value?:string;checked?:boolean}}
export type PdfExtractionResult={ok:boolean;error?:string}
export type PdfNoteUpdate={page:number;annotationId:string;action:'reply'|'edit';text:string}
export function searchPdfPreview(pages:readonly PreviewPage[],query:string){
 const needle=query.trim().toLocaleLowerCase()
 if(!needle)return []
 return pages.flatMap(page=>{
  const index=page.text.toLocaleLowerCase().indexOf(needle)
  if(index<0)return []
  const start=Math.max(0,index-80)
  const end=Math.min(page.text.length,index+Math.min(needle.length,120)+80)
  return [{page:page.page,excerpt:page.text.slice(start,end)}]
 }).slice(0,20)
}
export function scrollPdfPreviewToPage(container:Pick<HTMLElement,'querySelector'>|null,page:number):boolean{
 const target=container?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`)
 if(!target)return false
 target.scrollIntoView({block:'start',behavior:'smooth'})
 return true
}
const PREVIEW_TOOLS:AgentToolDef[]=[
 {name:'read_pages',description:'Read text from a PDF page range. At most 10 pages per call.',inputSchema:{type:'object',properties:{start:{type:'integer',description:'Start page number (1-based)'},end:{type:'integer',description:'End page number (inclusive); if omitted, only the start page is read'}},required:['start']}},
 {name:'search_text',description:'Search rendered PDF text and return matching page numbers and excerpts.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Text to search for (case-insensitive)'}},required:['query']}},
 {name:'goto_page',description:'Scroll the PDF preview to the given page.',inputSchema:{type:'object',properties:{page:{type:'integer',description:'Page number (1-based)'}},required:['page']}},
 {name:'get_outline',description:'Read the PDF bookmark titles in tree order.',inputSchema:{type:'object',properties:{}}},
 {name:'list_form_fields',description:'Read saved PDF form fields with name, type, current value, options and page. This reads a saved snapshot; filling is possible only through an explicitly offered setFormValue writer.',inputSchema:{type:'object',properties:{}}},
 {name:'find_sensitive_info',description:'Find phone, email, credit card (Luhn), SSN, date and IBAN (mod-97) candidates in extracted PDF text only. Scanned pages need OCR, which is not provided here. Read-only; mark:true is unavailable and no redaction is performed.',inputSchema:{type:'object',properties:{patterns:{type:'array',items:{type:'string',enum:[...REDACT_PATTERNS]},description:'Patterns to look for; omit for all'},mark:{type:'boolean',description:'Defaults to false; marking is unavailable in Web'}}}},
 {name:'read_annotations',description:'Read saved PDF comments and text markup, including page, author and contents.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100}}}},
]
const ROTATE_TOOL:AgentToolDef={name:'rotate_pages',description:'Rotate selected PDF pages by a multiple of 90 degrees and save a new document version. Page numbers are 1-based.',inputSchema:{type:'object',properties:{operations:{type:'array',minItems:1,maxItems:100,items:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1},degrees:{type:'integer',multipleOf:90}},required:['page','degrees']}}},required:['operations']}}
const INSERT_TEXT_TOOL:AgentToolDef={name:'insert_text',description:'Add new text and save a new PDF revision. Use anchor_text verbatim from read_pages with placement right/below/above, or x/y in points from the displayed page top-left. Defaults to horizontally centered at y=72. max_width wraps paragraphs; align aligns lines inside the block. Existing text is not replaced or reflowed. Saved inserts are ordinary content, editable with edit_text; no pending text ID is returned.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},text:{type:'string',minLength:1,maxLength:10000},anchor_text:{type:'string',maxLength:2000},placement:{type:'string',enum:['right','below','above']},x:{type:'number'},y:{type:'number'},font_size:{type:'number',exclusiveMinimum:0,maximum:1000},color:{type:'string',pattern:'^#?[0-9a-fA-F]{6}$'},max_width:{type:'number',exclusiveMinimum:0,maximum:100000},align:{type:'string',enum:['left','center','right']},font:{type:'string',enum:['arial','times','courier']},bold:{type:'boolean'},italic:{type:'boolean'}},required:['page','text']}}
const DRAFT_ID={type:'string',minLength:1,maxLength:100}
const DRAFT_TEXT_TOOLS:AgentToolDef[]=[
 {...INSERT_TEXT_TOOL,description:'Create unsaved text with a pending T ID, using coordinates or an exact text anchor. Coordinates use displayed page top-left points. max_width wraps text. Use edit_inserted_text, move_inserted_text or delete_inserted_text with this ID until the user clicks Save, which creates a new PDF revision. Existing page text is unchanged.'},
 {name:'list_inserted_text',description:'List unsaved inserted text and its pending IDs, optionally on one page. IDs exist until user Save creates a revision; saved text becomes ordinary page content for edit_text.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100}}}},
 {name:'edit_inserted_text',description:'Edit unsaved text or its font size, color and alignment by pending ID. Omitted fields are retained. User Save creates a revision; this tool does not save.',inputSchema:{type:'object',additionalProperties:false,properties:{id:DRAFT_ID,text:{type:'string',minLength:1,maxLength:10000},font_size:{type:'number',exclusiveMinimum:0,maximum:1000},color:{type:'string',pattern:'^#?[0-9a-fA-F]{6}$'},align:{type:'string',enum:['left','center','right']}},required:['id']}},
 {name:'move_inserted_text',description:'Move unsaved text by pending ID. x/y are absolute displayed top-left points; dx/dy are offsets (positive right/down). Do not mix x with dx or y with dy. User Save creates a revision; this tool does not save.',inputSchema:{type:'object',additionalProperties:false,properties:{id:DRAFT_ID,...Object.fromEntries(['x','y','dx','dy'].map(key=>[key,{type:'number',minimum:-100000,maximum:100000}]))},required:['id']}},
 {name:'delete_inserted_text',description:'Delete one unsaved inserted text by pending ID. This does not delete saved page text. User Save creates a revision with remaining drafts.',inputSchema:{type:'object',additionalProperties:false,properties:{id:DRAFT_ID},required:['id']}},
]
const IMAGE_ID_PROPERTIES={page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000}}
const IMAGE_TOOLS:AgentToolDef[]=[
 {name:'list_page_images',description:'List embedded images in the current saved revision, with per-page image_number and displayed top-left x/y, width/height in points, and text layer. Call before editing. Re-list after any document mutation because numbering may change.',inputSchema:{type:'object',additionalProperties:false,properties:{page:IMAGE_ID_PROPERTIES.page}}},
 {name:'transform_image',description:'Move or resize an existing image, or change its layer relative to text; saves a new revision. First call list_page_images. x/y use displayed page top-left points. A single width or height preserves aspect ratio; omitted values are retained. Size and position fit within the displayed page like the PC tool. Re-list afterward.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,x:{type:'number'},y:{type:'number'},width:{type:'number',exclusiveMinimum:0},height:{type:'number',exclusiveMinimum:0},layer:{type:'string',enum:['above_text','below_text']}},required:['page','image_number']}},
 {name:'rotate_image',description:'Rotate an existing embedded image about its center and save a new revision. First call list_page_images. cw (default) is 90 degrees clockwise, ccw counter-clockwise, 180 a half turn. Re-list afterward.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,direction:{type:'string',enum:['cw','ccw','180']}},required:['page','image_number']}},
 {name:'delete_image',description:'Delete an existing embedded image from the PDF content and save a new revision. First call list_page_images; select its per-page image_number. Re-list afterward. No pending-image undo is offered.',inputSchema:{type:'object',additionalProperties:false,properties:IMAGE_ID_PROPERTIES,required:['page','image_number']}},
]
const IMAGE_BAKE_TOOLS:AgentToolDef[]=[
 {name:'flip_image',description:'Mirror an existing image horizontally (left-right) or vertically (top-bottom) as the page is displayed, keeping its footprint and painting order, and save a new revision. First call list_page_images. Re-list after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,axis:{type:'string',enum:['horizontal','vertical']}},required:['page','image_number','axis']}},
 {name:'set_image_opacity',description:'Multiply the current saved image pixel alpha by opacity (0 invisible, 1 unchanged), preserving its footprint and painting order, and save a new revision. First call list_page_images. Each call saves immediately: repeating 0.5 on the next saved revision compounds to 0.25; this is not an absolute slider over unsaved original pixels. Re-list after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,opacity:{type:'number',minimum:0,maximum:1}},required:['page','image_number','opacity']}},
 {name:'crop_image',description:'Trim margins from an existing image and save a new revision. left/top/right/bottom are fractions of the current displayed width or height to remove from each edge; omitted values are zero. At least one must be positive; opposing sums must stay below 1. Crop boundaries snap to pixel edges. The footprint shrinks to the kept region so retained pixels keep their position and scale; painting order stays. First call list_page_images, then re-list after saving. This is not document redaction.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,...Object.fromEntries(['left','top','right','bottom'].map(side=>[side,{type:'number',minimum:0,exclusiveMaximum:1}]))},required:['page','image_number']}},
 {name:'remove_image_background',description:'Make the edge-connected background of an existing image transparent using the PC color-tolerance flood-fill algorithm, preserving its footprint and painting order, and save a new revision. Best for plain backgrounds. tolerance 0–100 defaults to 30. First call list_page_images, then re-list after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,tolerance:{type:'number',minimum:0,maximum:100}},required:['page','image_number']}},
]
const IMAGE_CONTENT_TOOLS:AgentToolDef[]=[
 {name:'insert_image',description:'Insert a PNG/JPEG image from an HTTPS URL or generated PNG/JPEG data URL and save a new PDF revision. Position using verbatim anchor_text with placement (default below, 8-point gap), or displayed top-left x/y in points; otherwise center on the page. width preserves aspect ratio; default natural size capped at half page width. layer defaults below_text. Re-list images after saving. WebP is unsupported.',inputSchema:{type:'object',additionalProperties:false,properties:{page:IMAGE_ID_PROPERTIES.page,url:{type:'string',minLength:1},anchor_text:{type:'string',minLength:1,maxLength:2000},placement:{type:'string',enum:['below','above','right','left']},x:{type:'number'},y:{type:'number'},width:{type:'number',exclusiveMinimum:0},layer:{type:'string',enum:['above_text','below_text']}},required:['page','url']}},
 {name:'replace_image',description:'Replace an existing image with a PNG/JPEG HTTPS URL or generated PNG/JPEG data URL and save a new revision. Call list_page_images first; use its per-page image_number. Keeps the original position, transform and painting order, stretching new pixels to the existing footprint. Re-list afterward. WebP is unsupported.',inputSchema:{type:'object',additionalProperties:false,properties:{...IMAGE_ID_PROPERTIES,url:{type:'string',minLength:1}},required:['page','image_number','url']}},
]
const MOVE_BLOCK_TOOL:AgentToolDef={name:'move_text_block',description:'Move a uniquely identified paragraph without rewriting its text, fonts, colors or spacing, saving a new PDF revision. Read the page first. paragraph_text must identify exactly one paragraph. dx/dy are displayed-page point offsets: positive dx moves right, positive dy moves down. Other content stays in place. Movement does not automatically avoid overlap or page edges; choose a clear target area within the page. Only report success after a confirmed save.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},paragraph_text:{type:'string',minLength:1,maxLength:2000},dx:{type:'number',minimum:-100000,maximum:100000},dy:{type:'number',minimum:-100000,maximum:100000}},required:['page','paragraph_text','dx','dy']}}
const EDIT_BLOCK_TOOL:AgentToolDef={name:'edit_block',description:'Rewrite the entire uniquely identified paragraph in original PDF content and save a new revision. Read first; paragraph_text must identify exactly one paragraph. new_text replaces the whole paragraph and wraps within its original width; empty text deletes it. Content below does not move. Optional font, size, style, color and alignment control the replacement. Only confirm a change after a successful saved result.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},paragraph_text:{type:'string',minLength:1,maxLength:2000},new_text:{type:'string',maxLength:10000},font_size:{type:'number',exclusiveMinimum:0,maximum:1000},color:{type:'string',pattern:'^#?[0-9a-fA-F]{6}$'},font:{type:'string',enum:['arial','times','courier']},bold:{type:'boolean'},italic:{type:'boolean'},align:{type:'string',enum:['left','center','right']}},required:['page','paragraph_text','new_text']}}
const FORM_MARK_TOOL:AgentToolDef={name:'add_form_mark',description:'Place a check or cross on a static printed form as an unsaved movable image draft. Position using exact anchor_text plus placement (default right), or x/y as displayed top-left points; size defaults 12pt. Fits a nearby printed checkbox automatically. If the position is an editable interactive checkbox, queue its checked value instead of drawing. Read-only widgets cannot be marked. Only user Save persists these changes.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},kind:{type:'string',enum:['check','cross']},anchor_text:{type:'string',minLength:1,maxLength:2000},placement:{type:'string',enum:['left','right','above','below']},x:{type:'number'},y:{type:'number'},size:{type:'number',exclusiveMinimum:0,maximum:1000}},required:['page','kind']}}
const EDIT_TEXT_TOOL:AgentToolDef={name:'edit_text',description:'Replace one occurrence of original PDF text in the page content and save a new revision. Read the page first; old_text must be verbatim. An empty new_text deletes the text. PDF pages do not reflow.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},old_text:{type:'string',minLength:1,maxLength:2000},new_text:{type:'string',maxLength:4000},occurrence:{type:'integer',minimum:1,maximum:1000}},required:['page','old_text','new_text']}}
const ANNOTATION_TOOLS:AgentToolDef[]=[
 {name:'markup_text',description:'Highlight, underline or strike out a verbatim PDF passage and save a new revision.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},text:{type:'string',minLength:1,maxLength:2000},type:{type:'string',enum:['highlight','underline','strikeout']},occurrence:{type:'integer',minimum:1,maximum:1000}},required:['page','text','type']}},
 {name:'add_note',description:'Attach a sticky comment authored by AI Assistant to a verbatim PDF passage and save a new revision.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},anchor_text:{type:'string',minLength:1,maxLength:2000},contents:{type:'string',minLength:1,maxLength:4000},occurrence:{type:'integer',minimum:1,maximum:1000}},required:['page','anchor_text','contents']}},
]
const DELETE_ANNOTATION_TOOLS:AgentToolDef[]=[
 {name:'delete_markup',description:'Remove saved text markups and save a new revision. Read read_annotations first. Only delete what the user requested. Omit markup_ids to remove all markups on the page; type optionally narrows the selection. At most 20 annotations per call.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},markup_ids:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string'}},type:{type:'string',enum:['highlight','underline','strikeout','squiggly']}},required:['page']}},
 {name:'delete_note',description:'Delete a saved sticky-note thread, including replies, and save a new revision. Read read_annotations first and use its root note ID. Only delete notes the user explicitly requested.',inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},note_id:{type:'string'}},required:['page','note_id']}},
]


const UPDATE_NOTE_TOOLS:AgentToolDef[]=(['reply_note','edit_note'] as const).map(name=>({
 name,description:name==='reply_note'?'Reply to a saved root sticky note as AI Assistant and save a new revision. Read read_annotations first.':'Edit a saved sticky note or reply while preserving its author and thread, then save a new revision. Read read_annotations first.',
 inputSchema:{type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:100},note_id:{type:'string',minLength:1},text:{type:'string',minLength:1,maxLength:4000}},required:['page','note_id','text']},
}))


const PAGE_TOOLS:AgentToolDef[]=[
 {name:'apply_ops',description:'Apply rotating, deleting and reordering pages as one atomic batch and immediately save one new PDF revision. Every page number refers to the original 1-based page numbers at the start of this call. After saving, pages are renumbered: re-read before later edits. Supported operations: rotatePages, deletePage, setPageOrder and setMetadata. setMetadata takes metadata:{title?,author?,subject?,keywords?}; strings only, empty clears, omitted fields retain saved values, null resets earlier metadata patches in this batch. dry_run validates the operation layout only without saving or testing file protection/writability.',inputSchema:{type:'object',additionalProperties:false,properties:{ops:{type:'array',minItems:1,maxItems:50,items:{type:'object',description:'{op:"rotatePages",pages:[page,...],dir:90|-90|180}, {op:"deletePage",page}, or {op:"setPageOrder",order:[every surviving original page,...]|null}, or {op:"setMetadata",metadata:{title?,author?,subject?,keywords?}|null}'}},dry_run:{type:'boolean'}},required:['ops']}},
 {name:'insert_blank_page',description:'Insert a blank page sized and rotated like its neighbor, immediately saving a new PDF revision. after_page is a 1-based page number; 0 inserts before the first page. Pages are renumbered after saving: re-read before later edits.',inputSchema:{type:'object',additionalProperties:false,properties:{after_page:{type:'integer',minimum:0,maximum:100}},required:['after_page']}},
 {name:'set_page_size',description:'Resize every PDF page, uniformly scaling content and annotations to fit, then immediately save a new revision. Pass a paper preset or width and height in points. Re-read page dimensions, text and annotation IDs after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{preset:{type:'string',enum:PDF_PAPER_SIZES.map(size=>size.label)},width:{type:'number',minimum:72,maximum:14400},height:{type:'number',minimum:72,maximum:14400}},oneOf:[{required:['preset'],not:{anyOf:[{required:['width']},{required:['height']}]}},{required:['width','height'],not:{required:['preset']}}]}},
 {name:'crop_pages',description:'Crop the displayed page area by shrinking its CropBox, immediately saving a new revision. This does not redact or delete hidden content; do not use cropping for confidential-data removal. pages is "all" or a range such as "1-3,5"; left/top/right/bottom are kept-area fractions from 0 to 1 in displayed top-left coordinates. Re-read dimensions, text and annotations after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{pages:{type:'string',minLength:1},left:{type:'number',minimum:0,maximum:1},top:{type:'number',minimum:0,maximum:1},right:{type:'number',minimum:0,maximum:1},bottom:{type:'number',minimum:0,maximum:1}},required:['pages','left','top','right','bottom']}},

]

const EXTRACT_TOOL:AgentToolDef={name:'extract_pages',description:'Copy the selected pages into a new PDF in the workspace and open it. pages is a 1-based range such as "1-3,5". Pending page rotations are saved first; extraction keeps every source page unchanged. Only confirm creation after a successful saved-file result.',inputSchema:{type:'object',additionalProperties:false,properties:{pages:{type:'string',minLength:1}},required:['pages']}}

const SPLIT_TOOL:AgentToolDef={name:'split_pdf',description:'Split this PDF into multiple new saved PDF files with pages_per_file pages per file (last may be shorter), then open them in order. Keeps source pages unchanged; saves pending rotations first. At least two outputs, at most 100. If partially created or canceled, confirm the existing save results instead of splitting again.',inputSchema:{type:'object',additionalProperties:false,properties:{pages_per_file:{type:'integer',minimum:1}},required:['pages_per_file']}}

const PAGE_LAYOUT_TOOLS:AgentToolDef[]=[
 {name:'split_pages',description:'Cut every source page into a 2, 4 or 9 cell grid, saving and opening one new PDF. Changes MediaBox/CropBox only; hidden content remains, so this is not redaction. Source pages stay unchanged. Output is limited to 100 pages.',inputSchema:{type:'object',additionalProperties:false,properties:{per_page:{type:'integer',enum:[2,4,9]}},required:['per_page']}},
 {name:'merge_pages',description:'Arrange pages from this single PDF onto sheets in one new saved PDF, then open it. This is single-source N-up, not merging multiple PDFs. Interactive annotations are not copied; source file retains them. Source pages stay unchanged.',inputSchema:{type:'object',additionalProperties:false,properties:{per_sheet:{type:'integer',minimum:2,maximum:16},direction:{type:'string',enum:['horizontal','vertical'],default:'vertical'},separator:{type:'boolean',default:false}},required:['per_sheet']}},
]

const REPLACE_PAGES_TOOL:AgentToolDef={name:'replace_pages',description:'Ask the user to choose a local PDF and confirm replacing the specified current 1-based pages. Removes those pages and inserts ALL source pages contiguously at the first removed position, then saves a new revision. Waits for explicit file selection and confirmation; cancellation does not modify the file. Source visible stamps remain source content; only the target assistant-managed stamps remain editable and page numbers are recalculated. Re-read pages after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{pages:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'integer',minimum:1,maximum:100}}},required:['pages']}}

const STAMP_TOOLS:AgentToolDef[]=[
 {name:'set_watermark',description:'Add or replace an assistant-managed single-line text watermark on every page and save a new PDF revision. text "" removes only this managed watermark. Original document watermarks cannot be removed. Omitted styles retain the previous managed watermark style, otherwise PC defaults: angle 35 degrees counterclockwise, opacity 0.18, color #d0342c, size 0.11 of page width. Re-read pages and images after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{text:{type:'string',maxLength:2000},angle:{type:'number',minimum:-180,maximum:180},opacity:{type:'number',minimum:0,maximum:1},color:{type:'string',pattern:'^#?[a-fA-F0-9]{6}$'},size:{type:'number',minimum:.02,maximum:.5}},required:['text']}},
 {name:'set_header_footer',description:'Replace the assistant-managed header/footer on every page and save a new PDF revision. Six single-line text slots support {page} and {total}; omitted slots are cleared. page_number defaults false and overrides footer_center with "number / total" when true. Defaults: start_at 1, font_size 9, color #666666. All slots empty and page_number false removes only the managed header/footer; original page content is preserved. Re-read pages and images after saving.',inputSchema:{type:'object',additionalProperties:false,properties:{...Object.fromEntries(['header_left','header_center','header_right','footer_left','footer_center','footer_right'].map(key=>[key,{type:'string',maxLength:2000}])),page_number:{type:'boolean'},start_at:{type:'integer',minimum:0,maximum:100000},font_size:{type:'number',minimum:4,maximum:72},color:{type:'string',pattern:'^#?[a-fA-F0-9]{6}$'}}}},
]

const pendingPage={type:'integer',minimum:1,maximum:100}
const pendingIdSchema=(prefix:string)=>({type:'string',minLength:2,maxLength:201,pattern:`^${prefix}[^\\s\\u0000-\\u001f\\u007f]+$`})
const pendingOperation=(op:string,properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',additionalProperties:false,required:['op',...required],properties:{op:{const:op},...properties}})
const PENDING_APPLY_TOOL:AgentToolDef={name:'apply_ops',description:'Apply one atomic batch of unsaved PDF edits in one undo step. Supported operations: removeMarkup (pending P markup only), setNoteContents (pending P note only), removeTextInsert (pending T text only), setFormValue (saved field name; omit kind), addFormField, rotatePages, deletePage, setPageOrder, setMetadata. Mix these categories freely. Page numbers are original 1-based identities, including after earlier edits. addFormField uses displayed top-left points; radio exports must be unique and choices need options. setPageOrder lists every surviving original page. Metadata patches merge; null resets pending overrides. dry_run validates the complete batch without changing pending state. Only user Save persists edits; no revision is created here. Saved annotation IDs use their dedicated tools.',inputSchema:{type:'object',additionalProperties:false,required:['ops'],properties:{dry_run:{type:'boolean'},ops:{type:'array',minItems:1,maxItems:50,items:{oneOf:[
 pendingOperation('removeMarkup',{id:pendingIdSchema('P')}),
 pendingOperation('setNoteContents',{id:pendingIdSchema('P'),contents:{type:'string',minLength:1,maxLength:10000}}),
 pendingOperation('removeTextInsert',{id:pendingIdSchema('T')}),
 pendingOperation('setFormValue',{value:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:1024},value:{type:'string',maxLength:10000},checked:{type:'boolean'}},oneOf:[{required:['value'],not:{required:['checked']}},{required:['checked'],not:{required:['value']}}]}}),
 pendingOperation('addFormField',{field:{type:'object',additionalProperties:false,required:['name','kind','page','x','y','width','height'],properties:{name:{type:'string',minLength:1,maxLength:200},kind:{enum:['text','checkbox','radio','choice','signature']},page:pendingPage,x:{type:'number',minimum:0},y:{type:'number',minimum:0},width:{type:'number',exclusiveMinimum:0},height:{type:'number',exclusiveMinimum:0},required:{type:'boolean'},multiLine:{type:'boolean'},maxLen:{type:'integer',minimum:0,maximum:10000},fontSize:{type:'number',exclusiveMinimum:0,maximum:1000},textAlignment:{enum:['left','center','right']},value:{type:'string',maxLength:10000},checked:{type:'boolean'},exportValue:{type:'string',minLength:1,maxLength:200},options:{type:'array',maxItems:100,uniqueItems:true,items:{type:'string',minLength:1,maxLength:1000}},dateFormat:{type:'string',minLength:1,maxLength:64}}}}),
 pendingOperation('rotatePages',{pages:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:pendingPage},dir:{enum:[-90,90,180]}}),
 pendingOperation('deletePage',{page:pendingPage}),
 pendingOperation('setPageOrder',{order:{anyOf:[{type:'null'},{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:pendingPage}]}}),
 pendingOperation('setMetadata',{metadata:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:Object.fromEntries(['title','author','subject','keywords'].map(key=>[key,{type:'string',maxLength:4000}]))}]}}),
 ]}}}}}

export function createPdfPreviewSkill(getPages:()=>readonly PreviewPage[],gotoPage:(page:number)=>boolean,getOutline:()=>readonly string[]=()=>[],rotatePages?:(operations:readonly {page:number;degrees:number}[],signal?:AbortSignal)=>Promise<boolean>,editText?:(edit:PdfTextEdit,signal?:AbortSignal)=>Promise<boolean>,annotate?:(annotation:PdfAnnotation,signal?:AbortSignal)=>Promise<boolean>,deleteAnnotations?:(operations:readonly PdfAnnotationDelete[],signal?:AbortSignal)=>Promise<boolean>,updateNote?:(operation:PdfNoteUpdate,signal?:AbortSignal)=>Promise<boolean>,pageOperations?:(operations:readonly PdfPageOperation[],signal?:AbortSignal)=>Promise<boolean>,extractPages?:(pages:readonly number[],signal?:AbortSignal)=>Promise<PdfExtractionResult>,splitPdf?:(pagesPerFile:number,signal?:AbortSignal)=>Promise<PdfExtractionResult>,pageLayout?:(operation:PdfPageLayout,signal?:AbortSignal)=>Promise<PdfExtractionResult>,getFormFields:()=>readonly FormField[]|null=()=>null,formValues?:(operations:readonly PdfFormValueOperation[],signal?:AbortSignal)=>Promise<boolean>,insertText?:(input:PdfTextInsert,signal?:AbortSignal)=>Promise<boolean>,editBlock?:(input:PdfBlockEdit,signal?:AbortSignal)=>Promise<boolean>,moveBlock?:(input:PdfBlockMove,signal?:AbortSignal)=>Promise<boolean>,images?:PdfImageTools,stamps?:(operation:PdfStampOperation,signal?:AbortSignal)=>Promise<boolean>,replacePages?:(pages:readonly number[],signal?:AbortSignal)=>Promise<boolean>,markSensitive?:(patterns:readonly RedactPattern[],signal?:AbortSignal)=>Promise<{count:number;truncated:boolean;error?:string}>,drafts?:PdfTextDraftTools,formMark?:(input:PdfFormMarkInput,signal?:AbortSignal)=>Promise<PdfFormMarkOutcome|null>,formFields?:(operations:readonly PdfFormFieldOperation[],signal?:AbortSignal)=>Promise<boolean>,options?:PdfPreviewOptions):AgentSkill{
 const pending=options?.pending
 return {
  id:'pdf-preview',
  get systemPrompt(){if(pending)return 'Use apply_ops for the nine canonical PDF operations, freely mixing categories in one atomic unsaved undo step. dry_run validates without changing pending state. User Save persists pending edits; never claim a revision was saved by apply_ops or pending annotation creation. Read before editing. Original page numbers remain stable until Save. read_annotations labels saved and pending sources: preserve saved IDs exactly; P IDs identify pending annotations. Use removeMarkup for P markups and setNoteContents for P notes only through apply_ops. Saved annotation tools cannot change P IDs. Annotation creation returns pending P IDs when offered. Other tools follow their own documented save behavior. Only confirm edits after successful tool results.';return (formFields?'Use apply_ops addFormField to author real fillable PDF fields. Use a homogeneous creation batch; names must be unique except radio buttons sharing one group with distinct exportValue. Coordinates use the displayed page top-left in points. A successful result saves a new revision; re-read list_form_fields afterward. ':'')+(formMark?'Use add_form_mark for printed checkboxes. Interactive checkboxes are filled, not covered; printed marks are unsaved image drafts until user Save. ':'')+(stamps?'Watermark and header/footer tools replace or remove only assistant-managed stamps, never original page content. They save a new revision immediately. ':'')+(images?'Before editing an embedded image call list_page_images for the current revision. After every mutation re-list images; never reuse stale numbers. '+(images.insertDraft?'insert_image queues unsaved images with pending I IDs; only the user Save action creates their revision. ':'')+(images.editsAreDrafts?'Existing image edits are unsaved: only one pending edit per image; user Save creates the revision. ':'Offered existing image edits save immediately. '):'')+(moveBlock?'Use move_text_block to move existing paragraph objects; displayed dy is positive downward. It saves a new revision. ':'')+(editBlock?'Use edit_block for a uniquely identified whole paragraph; it replaces original content and saves immediately, without moving other content. ':'')+(drafts?'Use insert_text for unsaved text with pending T IDs. List, edit, move or delete these drafts with the inserted_text tools. Only the user Save action creates a revision; never claim drafts are saved. ':insertText?'Use insert_text to add new text with coordinates or an exact text anchor. It saves immediately; no pending T IDs are created. ':'')+(formValues&&getFormFields()!==null?'Use apply_ops setFormValue to fill saved form fields after list_form_fields. Only homogeneous form batches are supported; do not mix them with page operations. A successful write saves one new revision; re-read fields afterward. Signature and read-only fields cannot be filled. ':'') + (formFields||drafts||replacePages||stamps||images||moveBlock||editBlock||insertText||annotate||deleteAnnotations||updateNote||pageOperations
   ?'Use the offered tools to read, navigate, edit and annotate this PDF. Read before modifying; text and anchor_text must be verbatim from the page. '+(drafts||images?.insertDraft||images?.editsAreDrafts?'Tools explicitly marked unsaved create pending edits only; user Save creates their revision. Other write tools save a new revision immediately. ':'Each successful mutation saves a new revision immediately. ')+'PDF pages do not reflow. Cropping changes only the CropBox; it does not redact or delete hidden content. Page operations save immediately; within a batch use original page numbers. After page operations re-read pages and annotations because page numbers and annotation IDs may change. Only confirm changes after a successful tool result. New sticky notes and replies are authored by AI Assistant. Editing a note preserves its author and thread. Reply only to root notes; read_annotations includes replyTo for replies. Use only tools offered in this turn; other unoffered file operations are unavailable.'
   :formValues&&getFormFields()!==null
   ?'Read the PDF and fill supported saved form fields using the offered tools. Only report changes confirmed by a successful saved-revision result; other unoffered changes are unavailable.'
   :extractPages||splitPdf||pageLayout
   ?'Use the offered tools to read this PDF and extract or split pages into new saved PDFs. Source pages are unchanged. A partial or canceled batch is not full success; confirm its existing save results instead of regenerating files. Only claim creation confirmed by a successful tool result; other unoffered modifications are unavailable.'
   :editText
   ?'This PDF supports reading, navigation, original text editing with edit_text, and the other tools offered in this turn. Read the page before editing; old_text must be verbatim. Keep replacements close to the original length because PDF pages do not reflow. Each successful edit saves a new revision immediately. Never cover text to simulate deletion. Only claim changes confirmed by a successful tool result. Annotations and unoffered file operations are unavailable.'
   :rotatePages
   ?'This PDF is open in a Web preview. Use read_pages or search_text before answering questions and goto_page when the user asks to navigate. You may rotate pages with rotate_pages; it saves a new PDF version immediately. Text editing, annotations, and other file operations are unavailable; never claim to have changed anything else.'
   :'This PDF is open in a read-only preview. Use read_pages or search_text before answering questions and goto_page when the user asks to navigate. Editing, annotations, and file operations are unavailable; never claim to have changed the PDF.')},
  get tools(){
   const formsReady=!!formValues&&getFormFields()!==null
   const formTool:AgentToolDef={...PAGE_TOOLS[0]!,description:'Apply one homogeneous batch of setFormValue operations and save one PDF revision. Each operation is {op:"setFormValue",value:{name,value?:string,checked?:boolean}}; never pass kind. Read list_form_fields first; use checked for checkboxes and value for text/radio/choice fields. Read-only and signature fields cannot be filled. Do not mix form and page operations. dry_run checks snapshot field names, types and options only, without testing file protection or writability. Page and setMetadata operations are supported only when the page writer is offered. setMetadata takes metadata:{title?,author?,subject?,keywords?}; strings only, empty clears, omitted fields retain saved values, null resets earlier metadata patches in the batch.',inputSchema:{type:'object',additionalProperties:false,properties:{ops:{type:'array',minItems:1,maxItems:50,items:{type:'object',description:'{op:"setFormValue",value:{name,value?:string,checked?:boolean}} or a supported page/metadata operation; never mix form values with page/metadata operations'}},dry_run:{type:'boolean'}},required:['ops']}}
   const savedApplyTool:AgentToolDef=formFields?{...(formsReady?formTool:PAGE_TOOLS[0]!),description:(formsReady?formTool.description:pageOperations?PAGE_TOOLS[0]!.description:'Only field creation is available through this apply_ops writer. ')+' Author fillable fields with {op:"addFormField",field:{name,kind:"text"|"checkbox"|"radio"|"choice"|"signature",page,x,y,width,height,required?,multiLine?,maxLen?,fontSize?,textAlignment?,value?,checked?,exportValue?,options?,dateFormat?}}. Coordinates are displayed top-left points; page is 1-based. Radio buttons share a group name and each need a unique exportValue. Choice fields need options. dateFormat makes text a date field. Read list_form_fields first. Use only addFormField operations in a creation batch; do not mix page edits or form value edits. Successful creation saves one revision; empty signature fields do not sign the PDF. dry_run validates request shape and page bounds only, not field conflicts or file protection.'}:(formsReady?formTool:PAGE_TOOLS[0]!)
   const applyTool:AgentToolDef=drafts?.removeMany?{...savedApplyTool,description:(pageOperations||formsReady||formFields?savedApplyTool.description+' ':'')+' Remove unsaved text in one undo step with {op:"removeTextInsert",id:"T…"}. Use only text removals in this batch; list_inserted_text provides current IDs. Repeated or unknown T IDs are idempotent no-ops. dry_run validates the batch without modifying drafts. User Save persists remaining drafts; no revision is created by this operation.'}:savedApplyTool
   if(drafts?.removeMany){
    applyTool.inputSchema={type:'object',additionalProperties:false,required:['ops'],properties:{dry_run:{type:'boolean'},ops:{type:'array',minItems:1,maxItems:50,items:{type:'object',description:(pageOperations||formsReady||formFields?'A supported homogeneous saved operation batch, or ':'')+'{op:"removeTextInsert",id:"T…"} for unsaved text removal; do not mix text removal with saved operations.'}}}}
   }
   const selectedApplyTool=pending?PENDING_APPLY_TOOL:applyTool
   return [...PREVIEW_TOOLS.map(tool=>pending&&tool.name==='read_annotations'?{...tool,description:'Read saved and pending PDF annotations with their source and original page. Saved IDs keep their existing format; P IDs are pending and use canonical apply_ops only.'}:tool.name==='find_sensitive_info'&&markSensitive?{...tool,description:'Find sensitive text candidates. mark:true queues reviewable marks for the user, without modifying the PDF. Only the user can confirm creating a permanently redacted separate PDF copy; no AI apply tool exists. Searches extracted text only, not OCR.',inputSchema:{...tool.inputSchema,properties:{patterns:{type:'array',items:{type:'string',enum:[...REDACT_PATTERNS]}},mark:{type:'boolean',description:'Queue candidates for user review; does not erase content'}}}}:tool),...(replacePages?[REPLACE_PAGES_TOOL]:[]),...(formMark?[FORM_MARK_TOOL]:[]),...(stamps?STAMP_TOOLS:[]),...(rotatePages?[ROTATE_TOOL]:[]),...(editText?[EDIT_TEXT_TOOL]:[]),...(drafts?DRAFT_TEXT_TOOLS:insertText?[INSERT_TEXT_TOOL]:[]),...(editBlock?[EDIT_BLOCK_TOOL]:[]),...(moveBlock?[MOVE_BLOCK_TOOL]:[]),...(images?[...IMAGE_TOOLS,...IMAGE_BAKE_TOOLS].map(tool=>images.editsAreDrafts&&tool.name!=='list_page_images'?{...tool,description:pendingImageDescription(tool.name)}:tool):[]),...IMAGE_CONTENT_TOOLS.filter(tool=>tool.name==='insert_image'?images?.insertDraft||images?.content:images?.content).map(tool=>tool.name==='replace_image'&&images?.editsAreDrafts?{...tool,description:pendingImageDescription(tool.name)}:tool.name==='insert_image'&&images?.insertDraft?{...tool,description:tool.description.replace('and save a new PDF revision','as an unsaved draft with a pending I ID; only the user Save action creates a new PDF revision').replace('Re-list images after saving.','list_page_images lists saved images only.')} :tool),...((pending?pending.annotate:annotate)?ANNOTATION_TOOLS.map(tool=>pending?{...tool,description:tool.name==='add_note'?'Create an unsaved sticky note at a verbatim text anchor and return its pending P ID. Only user Save persists it.':'Create unsaved text markup at verbatim page text and return its pending P ID. Only user Save persists it.'}:tool):[]),...(deleteAnnotations?DELETE_ANNOTATION_TOOLS:[]),...(updateNote?UPDATE_NOTE_TOOLS:[]),...(pageOperations?PAGE_TOOLS.map(tool=>tool.name==='apply_ops'?selectedApplyTool:tool):pending||formsReady||formFields||drafts?.removeMany?[selectedApplyTool]:[]),...(extractPages?[EXTRACT_TOOL]:[]),...(splitPdf?[SPLIT_TOOL]:[]),...(pageLayout?PAGE_LAYOUT_TOOLS:[])]},
  async executeTool(call,signal){
   signal?.throwIfAborted()
   const pages=getPages()
   const input=call.input as Record<string,unknown>
   if(pending&&call.name==='apply_ops'){
    const summary='Apply unsaved PDF operations'
    try{
     if(!input||Object.keys(input).some(key=>!['ops','dry_run'].includes(key))||input.dry_run!==undefined&&typeof input.dry_run!=='boolean')throw Error('Invalid pending operation input')
     const operations=validatePdfApplyOperations(input.ops),dryRun=input.dry_run===true
     const result=await pending.apply(operations,{dryRun,...(signal?{signal}:{})})
     if(result.failures.length)return {output:`Nothing was applied (atomic): ${result.failures.map(f=>`ops[${f.index}]: ${f.error}`).join('; ')}`,summary,isError:true,mutated:false}
     return {output:dryRun?'Dry run: the complete pending batch is valid; pending state is unchanged.':'Applied one atomic batch of unsaved PDF edits in one undo step. Only user Save persists these edits.',summary,mutated:!dryRun}
    }catch{
     signal?.throwIfAborted()
     return {output:'Nothing was applied (atomic). The pending operation batch could not be confirmed; re-read pending state before retrying.',summary,isError:true,mutated:false}
    }
   }
   if(pending&&(['delete_markup','delete_note','edit_note','reply_note'].includes(call.name))&&([input.note_id,...(Array.isArray(input.markup_ids)?input.markup_ids:[])].some(id=>typeof id==='string'&&id.startsWith('P'))))return {output:'Pending P IDs use canonical apply_ops only: removeMarkup for pending markups, setNoteContents for pending notes. Saved annotation tools cannot change pending IDs.',summary:'Pending PDF annotations',isError:true,mutated:false}
   if(call.name==='add_form_mark'){
    const summary='Mark PDF form'
    if(!formMark)return {output:'Form marks are unavailable.',summary,isError:true,mutated:false}
    try{
     const operation=validatePdfFormMark(input)
     if(!pages.some(page=>page.page===operation.page))throw Error('The PDF page is not available.')
     const result=await formMark(operation,signal)
     if(!result)return {output:'The form mark or checkbox change could not be confirmed. Check the current draft or save status before retrying.',summary,isError:true,mutated:false}
     return 'draft'in result?{output:`Created unsaved form mark ${result.draft.id} on page ${operation.page}. The user can move, resize or undo the image draft; only user Save creates its revision.`,summary,mutated:true}:{output:`Queued an unsaved check for interactive checkbox ${JSON.stringify(result.fieldName)}. Only user Save persists the change.`,summary,mutated:true}
    }catch(error){signal?.throwIfAborted();return {output:error instanceof Error?error.message:'The PDF form mark could not be confirmed.',summary,isError:true,mutated:false}}
   }
   const draftTool=['list_inserted_text','edit_inserted_text','move_inserted_text','delete_inserted_text'].includes(call.name)
   if(draftTool||drafts&&call.name==='insert_text'){
    if(!input||typeof input!=='object'||Array.isArray(input))return {output:'Invalid unsaved PDF text input.',summary:'PDF text draft',isError:true,mutated:false}
   }
   if(draftTool){
    const summary='Unsaved PDF text'
    if(!drafts)return {output:'Unsaved PDF text tools are unavailable.',summary,isError:true,mutated:false}
    const listing=call.name==='list_inserted_text',editing=call.name==='edit_inserted_text',moving=call.name==='move_inserted_text'
    const allowed=listing?['page']:editing?['id','text','font_size','color','align']:moving?['id','x','y','dx','dy']:['id']
    const invalid=Object.keys(input).some(key=>!allowed.includes(key))
     ||(listing?input.page!==undefined&&(!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length):typeof input.id!=='string'||!input.id.trim()||input.id.length>100)
     ||(editing&&(!['text','font_size','color','align'].some(key=>input[key]!==undefined)
      ||input.text!==undefined&&(typeof input.text!=='string'||!input.text.trim()||input.text.length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text))
      ||input.font_size!==undefined&&(typeof input.font_size!=='number'||!Number.isFinite(input.font_size)||input.font_size<=0||input.font_size>1000)
      ||input.color!==undefined&&(typeof input.color!=='string'||!/^#?[0-9a-fA-F]{6}$/.test(input.color))
      ||input.align!==undefined&&(typeof input.align!=='string'||!['left','center','right'].includes(input.align))))
     ||(moving&&(!['x','y','dx','dy'].some(key=>input[key]!==undefined)
      ||input.x!==undefined&&input.dx!==undefined||input.y!==undefined&&input.dy!==undefined
      ||['x','y','dx','dy'].some(key=>input[key]!==undefined&&(typeof input[key]!=='number'||!Number.isFinite(input[key])||Math.abs(Number(input[key]))>100000))))
    if(invalid)return {output:'Invalid unsaved PDF text parameters. Use a pending ID and the documented fields.',summary,isError:true,mutated:false}
    try{
     if(listing)return {output:`Unsaved inserted text: ${JSON.stringify(drafts.list(input.page as number|undefined))}. Only user Save creates a revision.`,summary,mutated:false}
     if(editing||moving){
      const draft=editing?await drafts.edit({...input} as Parameters<PdfTextDraftTools['edit']>[0],signal):await drafts.move({...input} as Parameters<PdfTextDraftTools['move']>[0],signal)
      return {output:`Updated unsaved text ${JSON.stringify(draft)}. Only user Save creates a revision.`,summary,mutated:true}
     }
     await drafts.remove(input.id as string,signal)
     return {output:`Deleted unsaved text ${input.id}. Only user Save creates a revision with remaining drafts.`,summary,mutated:true}
    }catch{return {output:'The unsaved PDF text operation failed. No successful change is confirmed; re-list drafts before retrying.',summary,isError:true,mutated:false}}
   }
   if(call.name==='set_watermark'||call.name==='set_header_footer'){
    const summary=call.name==='set_watermark'?'PDF watermark':'PDF header/footer'
    if(!stamps)return {output:'PDF stamp editing is unavailable.',summary,isError:true,mutated:false}
    let operation:PdfStampOperation
    try{if(Object.hasOwn(input,'op'))throw Error('Invalid stamp input');operation=validatePdfStampOperation({...input,op:call.name})}
    catch{return {output:'Invalid PDF stamp configuration. Use single-line text and the documented parameter ranges.',summary,isError:true,mutated:false}}
    if(!await stamps(operation,signal))return {output:'PDF stamp changes were not confirmed saved.',summary,isError:true,mutated:false}
    return {output:'Saved a new PDF revision with the managed stamp change. Original page content and original stamps are preserved. Re-read pages and image numbers before further edits.',summary,mutated:true}
   }
   if(call.name==='replace_pages'){
    const requested=input.pages
    if(!replacePages||Object.keys(input).some(key=>key!=='pages')||!Array.isArray(requested)||!requested.length||requested.length>100||new Set(requested).size!==requested.length||requested.some(page=>!Number.isSafeInteger(page)||page<1||page>pages.length))return {output:'Invalid page selection or source PDF selection is unavailable.',summary:'Replace PDF pages',isError:true,mutated:false}
    const saved=await replacePages([...requested].sort((a,b)=>a-b),signal)
    return saved?{output:'Selected pages replaced with all pages from the user-selected PDF and a new revision saved. Re-read current pages.',summary:'Replace PDF pages',mutated:true}:{output:'Replacement was canceled or could not be confirmed saved. If a save is pending, confirm its result before retrying.',summary:'Replace PDF pages not saved',isError:true,mutated:false}
   }
   if(call.name==='list_page_images'){
    if(!images||Object.keys(input).some(key=>key!=='page')||(input.page!==undefined&&(!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length)))return {output:'Invalid PDF image page or image reading is unavailable.',summary:'List PDF images',isError:true,mutated:false}
    const list=await images.read(input.page as number|undefined,signal)
    return {output:list.length?JSON.stringify(list):'No embedded images on the requested pages.',summary:`Read ${list.length} PDF images`,mutated:false}
   }
   if(call.name==='insert_image'||call.name==='replace_image'){
    const replacing=call.name==='replace_image'
    const allowed=['page','url',...(replacing?['image_number']:['anchor_text','placement','x','y','width','layer'])]
    const invalid=Object.keys(input).some(key=>!allowed.includes(key))||!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length||typeof input.url!=='string'||!input.url.trim()||input.url.length>7*1024*1024||(replacing&&(!Number.isSafeInteger(input.image_number)||Number(input.image_number)<1||Number(input.image_number)>1000))||['x','y','width'].some(key=>input[key]!==undefined&&(typeof input[key]!=='number'||!Number.isFinite(input[key])||Math.abs(Number(input[key]))>100000||key==='width'&&Number(input[key])<=0))||(input.anchor_text!==undefined&&(typeof input.anchor_text!=='string'||!input.anchor_text.trim()||input.anchor_text.length>2000))||(input.placement!==undefined&&!['above','below','left','right'].includes(String(input.placement)))||(input.layer!==undefined&&!['above_text','below_text'].includes(String(input.layer)))
    if((replacing?!images?.content:!images?.insertDraft&&!images?.content)||invalid)return {output:'Invalid PDF image input or image insertion/replacement is unavailable.',summary:'Save PDF image',isError:true,mutated:false}
    if(!replacing&&images?.insertDraft){
     try{
      const info=await images.insertDraft({op:'insert_image',...input} as Extract<PdfImageContentInput,{op:'insert_image'}>,signal)
      signal?.throwIfAborted()
      return {output:`Image ${info.id} inserted as an unsaved draft on page ${info.page} at (${info.x}, ${info.y}), size ${info.width} × ${info.height}. Only the user clicking Save creates a new revision. list_page_images lists saved images only.`,summary:'Insert unsaved PDF image',mutated:true}
     }catch(error){
      signal?.throwIfAborted()
      return {output:error instanceof Error?error.message:'PDF image draft could not be inserted.',summary:'PDF image draft failed',isError:true,mutated:false}
     }
    }
    if(!await images!.content!({op:call.name,...input} as PdfImageContentInput,signal))return {output:images?.editsAreDrafts?'The image edit could not be queued. Re-list images; a pending target must be saved or undone before another edit.':'The image change could not be confirmed saved. Re-read the current revision and image list, or confirm a pending save before retrying.',summary:'PDF image save failed',isError:true,mutated:false}
    if(replacing&&images?.editsAreDrafts)return pendingImageResult(input)
    return {output:`Image ${replacing?'replaced':'inserted'} on page ${input.page} and a new revision saved. Re-list images before further image operations.`,summary:replacing?'Replace PDF image':'Insert PDF image',mutated:true}
   }
   if(['flip_image','set_image_opacity','crop_image','remove_image_background'].includes(call.name)){
    const sides=['left','top','right','bottom'],extra=call.name==='flip_image'?['axis']:call.name==='set_image_opacity'?['opacity']:call.name==='crop_image'?sides:['tolerance']
    const invalid=Object.keys(input).some(key=>!['page','image_number',...extra].includes(key))||!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length||!Number.isSafeInteger(input.image_number)||Number(input.image_number)<1||Number(input.image_number)>1000
     ||call.name==='flip_image'&&!['horizontal','vertical'].includes(String(input.axis))
     ||call.name==='set_image_opacity'&&(typeof input.opacity!=='number'||!Number.isFinite(input.opacity)||input.opacity<0||input.opacity>1)
     ||call.name==='remove_image_background'&&input.tolerance!==undefined&&(typeof input.tolerance!=='number'||!Number.isFinite(input.tolerance)||input.tolerance<0||input.tolerance>100)
     ||call.name==='crop_image'&&(sides.some(side=>input[side]!==undefined&&(typeof input[side]!=='number'||!Number.isFinite(input[side])||Number(input[side])<0||Number(input[side])>=1))||Number(input.left??0)+Number(input.right??0)>=1||Number(input.top??0)+Number(input.bottom??0)>=1||!sides.some(side=>Number(input[side])>0))
    if(!images||invalid)return {output:'Invalid PDF image pixel operation or image writing is unavailable.',summary:'Edit PDF image pixels',isError:true,mutated:false}
    if(!await images.edit({op:call.name,...input} as PdfImageBakeOperation,signal))return {output:images.editsAreDrafts?'The image edit could not be queued. Re-list images; a pending target must be saved or undone before another edit.':'The image pixel change could not be confirmed saved. Re-list images for the current revision, or confirm a pending save before retrying.',summary:'PDF image pixel edit failed',isError:true,mutated:false}
    if(images.editsAreDrafts)return pendingImageResult(input)
    return {output:`Image ${input.image_number} on page ${input.page} updated and a new revision saved. Re-list images before further image operations.`,summary:'Edit PDF image pixels',mutated:true}
   }
   if(['transform_image','rotate_image','delete_image'].includes(call.name)){
    const allowed=['page','image_number',...(call.name==='transform_image'?['x','y','width','height','layer']:call.name==='rotate_image'?['direction']:[])]
    const invalid=Object.keys(input).some(key=>!allowed.includes(key))||!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length||!Number.isSafeInteger(input.image_number)||Number(input.image_number)<1||Number(input.image_number)>1000||['x','y','width','height'].some(key=>input[key]!==undefined&&(typeof input[key]!=='number'||!Number.isFinite(input[key])||Math.abs(Number(input[key]))>100000||(['width','height'].includes(key)&&Number(input[key])<=0)))||(input.layer!==undefined&&!['above_text','below_text'].includes(String(input.layer)))||(input.direction!==undefined&&!['cw','ccw','180'].includes(String(input.direction)))
    if(!images||invalid)return {output:'Invalid PDF image operation or image writing is unavailable.',summary:'Edit PDF image',isError:true,mutated:false}
    if(!await images.edit({op:call.name,...input} as PdfImageOperation,signal))return {output:images?.editsAreDrafts?'The image edit could not be queued. Re-list images; a pending target must be saved or undone before another edit.':'The image change could not be confirmed saved. Re-list images for the current version, or confirm any pending save result before retrying.',summary:'PDF image edit failed',isError:true,mutated:false}
    if(images.editsAreDrafts)return pendingImageResult(input)
    return {output:`Image ${input.image_number} on page ${input.page} was ${call.name==='delete_image'?'deleted':call.name==='rotate_image'?'rotated':'adjusted'} and a new revision saved. Re-list images before further image operations.`,summary:'Edit PDF image',mutated:true}
   }
   if(call.name==='list_form_fields'){
    const fields=getFormFields()
    if(fields===null)return {output:'PDF form snapshot is unavailable. Load the current revision before reading fields.',summary:'Read PDF form fields',isError:true,mutated:false}
    const lines=fields.map(field=>`${field.name} (${field.kind}, page ${field.pageIndex+1})${field.options.length?` options[${field.options.join(', ')}]`:''} current value: ${field.kind==='checkbox'?String(field.checked):field.value||'(empty)'}`)
    return {output:`${lines.join('\n')||'The document has no form fields'}\n${formValues||pending?'Fill fields only through the offered apply_ops setFormValue writer.':'Read-only field snapshot; filling forms is unavailable.'}`,summary:`Read ${fields.length} PDF form fields`,mutated:false}
   }
   if(call.name==='find_sensitive_info'){
    if(input.mark===true&&!markSensitive)return {output:'Redaction marking is unavailable in Web. This tool does not mark, cover or remove content.',summary:'Find sensitive information',isError:true,mutated:false}
    if(input.mark!==undefined&&typeof input.mark!=='boolean'||input.patterns!==undefined&&(!Array.isArray(input.patterns)||input.patterns.some(pattern=>!REDACT_PATTERNS.includes(pattern as RedactPattern))))return {output:`Use only these patterns: ${REDACT_PATTERNS.join(', ')}; mark must be false or omitted.`,summary:'Find sensitive information',isError:true,mutated:false}
    if(!pages.length)return {output:'PDF text is unavailable. Load the current revision before searching.',summary:'Find sensitive information',isError:true,mutated:false}
    const patterns=(Array.isArray(input.patterns)&&input.patterns.length?input.patterns:REDACT_PATTERNS) as readonly RedactPattern[]
    if(input.mark===true&&markSensitive){
     const result=await markSensitive(patterns,signal)
     return {output:result.error??`Queued ${result.count} candidate marks for user review.${result.truncated?' Results are incomplete; only the reported candidates were queued.':''} The original PDF is unchanged. The user must review and confirm saving a separate redacted copy; do not claim redaction is applied. Scanned images and unextracted text were not searched.`,summary:'Review sensitive information',mutated:false,...(result.error?{isError:true}:{})}
    }
    const lines:string[]=[]
    let count=0
    for(const page of pages)for(const pattern of new Set(patterns))for(const [start,end] of findPattern(pattern,page.text)){
     count++
     if(lines.length<60)lines.push(`Page ${page.page} [${pattern}]: ${page.text.slice(start,end).replace(/\s+/g,' ')}`)
    }
    if(count>60)lines.push(`(${count} hits total; only the first 60 listed)`)
    const empty=pages.filter(page=>!page.text.trim()).map(page=>page.page)
    lines.push(`Searched extracted PDF text only; no OCR was performed. Images and unextracted text were not searched.${empty.length?` Pages without extracted text: ${empty.join(', ')}.`:''} No marks or redactions were applied.`)
    return {output:`${count?'':'No matches found in extracted text.\n'}${lines.join('\n')}`,summary:`Find sensitive information (${count} hits)`,mutated:false}
   }
   if(call.name==='split_pages'||call.name==='merge_pages'){
    if(!pageLayout)return {output:'PDF page layout creation is unavailable.',summary:'PDF page layout',isError:true,mutated:false}
    let operation:PdfPageLayout
    if(call.name==='split_pages'){
     if(![2,4,9].includes(input.per_page as number))return {output:'per_page must be 2, 4 or 9.',summary:'Split PDF pages',isError:true,mutated:false}
     if(!pages.length||pages.length*Number(input.per_page)>100)return {output:'Splitting would exceed the Web PDF limit of 100 pages. Choose a smaller grid or extract fewer source pages first.',summary:'Split PDF pages',isError:true,mutated:false}
     operation={kind:'split',perPage:input.per_page as 2|4|9}
    }else{
     const count=input.per_sheet,direction=input.direction===undefined?'vertical':input.direction,separator=input.separator===undefined?false:input.separator
     if(typeof count!=='number'||!Number.isSafeInteger(count)||count<2||count>16||!['horizontal','vertical'].includes(direction as string)||typeof separator!=='boolean'||!pages.length)return {output:'per_sheet must be an integer from 2 to 16; direction horizontal or vertical; separator boolean.',summary:'Merge PDF pages',isError:true,mutated:false}
     if(Math.ceil(pages.length/count)>100)return {output:'The output would exceed the Web PDF limit of 100 pages.',summary:'Merge PDF pages',isError:true,mutated:false}
     operation={kind:'merge',perSheet:count,direction:direction as 'horizontal'|'vertical',separator}
    }
    const result=await pageLayout(operation,signal)
    if(!result.ok)return {output:result.error||'New PDF creation could not be confirmed. Confirm the existing save result before trying again.',summary:'PDF page layout incomplete',isError:true,mutated:false}
    return {output:operation.kind==='split'?'Created, saved and opened a new PDF with split pages using tightened MediaBox/CropBox. Hidden content remains; this does not redact content. Source pages are unchanged.':'Created, saved and opened a new PDF arranging pages from this PDF onto sheets (single-source N-up). Interactive annotations are not copied to the output; the source file retains them. Source pages are unchanged.',summary:operation.kind==='split'?'Split PDF pages':'Merge PDF pages',mutated:true}
   }
   if(call.name==='split_pdf'){
    const count=input.pages_per_file
    if(!splitPdf||typeof count!=='number'||!Number.isSafeInteger(count)||count<1||count>=pages.length||Math.ceil(pages.length/count)>100)return {output:'pages_per_file must be a positive integer producing 2 to 100 new PDFs; PDF creation must be available.',summary:'Split PDF',isError:true,mutated:false}
    const result=await splitPdf(count,signal)
    if(!result.ok)return {output:result.error||'PDF splitting could not be fully confirmed. Confirm existing save results before trying again.',summary:'PDF split incomplete',isError:true,mutated:false}
    return {output:`Split this PDF into ${Math.ceil(pages.length/count)} new PDF files, saved them in the workspace and opened them. Source pages are unchanged.`,summary:'Split PDF',mutated:true}
   }
   if(call.name==='extract_pages'){
    const selected=parsePdfPageRanges(input.pages,pages.length)
    if(!extractPages||!selected)return {output:'Select existing PDF pages using a range such as 1-3,5; PDF creation must be available.',summary:'Extract PDF pages',isError:true,mutated:false}
    const result=await extractPages(selected,signal)
    if(!result.ok)return {output:result.error||'PDF extraction could not be confirmed. No successful creation is confirmed.',summary:'PDF extraction failed',isError:true,mutated:false}
    return {output:'Extracted the selected pages into a new PDF, saved it in the workspace and opened it. Source pages are unchanged.',summary:'Extract PDF pages',mutated:true}
   }
   if(call.name==='set_page_size'||call.name==='crop_pages'){
    if(!pageOperations)return {output:'PDF page sizing and cropping are unavailable.',summary:'Edit PDF page geometry',isError:true,mutated:false}
    let operations:readonly PdfPageOperation[]
    try{
     if(call.name==='set_page_size'){
      if(input.preset!==undefined&&(input.width!==undefined||input.height!==undefined))throw Error('Choose preset or dimensions')
      const label=typeof input.preset==='string'?input.preset.toLowerCase():''
      const preset=PDF_PAPER_SIZES.find(size=>size.label.toLowerCase()===label)
      if(input.preset!==undefined&&!preset)throw Error('Invalid preset')
      operations=validatePdfPageOperations([{op:'setPageSize',width:preset?.width??input.width,height:preset?.height??input.height}],pages.length)
     }else{
      const selected=parsePdfPageRanges(input.pages,pages.length)
      if(!selected)throw Error('Invalid page range')
      operations=validatePdfPageOperations([{op:'cropPages',pages:selected,left:input.left,top:input.top,right:input.right,bottom:input.bottom}],pages.length)
     }
    }catch{return {output:'Invalid page size or crop. Choose one paper preset or both dimensions (72–14400 pt); crop current pages to a nonempty, smaller rectangle within 0–1. Nothing was saved.',summary:'Edit PDF page geometry',isError:true,mutated:false}}
    if(!await pageOperations(operations,signal))return {output:'The PDF page geometry change could not be saved. No successful change is confirmed.',summary:'PDF page geometry failed',isError:true,mutated:false}
    return {output:call.name==='crop_pages'?'Saved a new PDF revision with a smaller CropBox. Hidden content has not been redacted or deleted. Re-read page dimensions, text and annotations before further edits.':'Resized PDF pages and saved a new revision. Re-read page dimensions, text and annotations before further edits.',summary:call.name==='crop_pages'?'Crop PDF pages':'Resize PDF pages',mutated:true}
   }
   if(call.name==='apply_ops'&&Array.isArray(input.ops)&&input.ops.some(op=>op?.op==='removeTextInsert')){
    const summary='Remove unsaved PDF text batch'
    try{
     if(!drafts?.removeMany)throw Error('Batch removal of unsaved text is unavailable.')
     if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Reflect.ownKeys(input).some(key=>!['ops','dry_run'].includes(String(key))||!('value'in Object.getOwnPropertyDescriptor(input,key)!))||(input.dry_run!==undefined&&typeof input.dry_run!=='boolean'))throw Error('Invalid pending text batch.')
     const operations=validatePdfApplyOperations(input.ops,pages.length)
     const ids=operations.map(operation=>{
      if(operation.op!=='removeTextInsert')throw Error('Use only removeTextInsert operations in this batch; nothing was applied.')
      return operation.id
     })
     if(input.dry_run===true)return {output:'Dry run: the pending text removal batch is valid. Drafts were not modified; no revision was created.',summary,mutated:false}
     await drafts.removeMany(ids,signal)
     return {output:`Applied ${ids.length} unsaved text removal operation(s) as one undo step. Repeated and unknown T IDs are no-ops. No revision was created; only the user Save action persists the remaining drafts.`,summary,mutated:true}
    }catch(error){signal?.throwIfAborted();return {output:error instanceof Error?error.message:'The pending text batch could not be applied.',summary,isError:true,mutated:false}}
   }
   if(call.name==='apply_ops'&&Array.isArray(input.ops)&&input.ops.some(op=>op?.op==='addFormField')){
    if(!formFields)return {output:'PDF form field creation is unavailable.',summary:'Create PDF form fields',isError:true,mutated:false}
    let operations:readonly PdfFormFieldOperation[]
    try{
     if(input.dry_run!==undefined&&typeof input.dry_run!=='boolean')throw Error('Invalid dry_run')
     operations=validatePdfFormFieldOperations(input.ops,pages.length)
    }catch{return {output:'Invalid PDF field creation batch. Use only addFormField with a valid name, kind, page and displayed rectangle; nothing was applied.',summary:'Create PDF form fields',isError:true,mutated:false}}
    if(input.dry_run===true)return {output:'Dry run: field creation parameters and page bounds are valid. Nothing was changed; field conflicts and file protection have not been checked.',summary:'Validate PDF field creation',mutated:false}
    if(!await formFields(operations,signal))return {output:'The new PDF form fields could not be confirmed saved.',summary:'PDF field creation failed',isError:true,mutated:false}
    return {output:'Saved new fillable PDF form fields as one new revision. Re-read list_form_fields to inspect saved names, values and options.',summary:'Create PDF form fields',mutated:true}
   }
   if(call.name==='apply_ops'&&Array.isArray(input.ops)&&input.ops.some(op=>op?.op==='setFormValue')){
    const fields=getFormFields()
    if(!formValues||fields===null)return {output:'PDF form filling is unavailable until the current field snapshot and writer are ready.',summary:'Fill PDF form fields',isError:true,mutated:false}
    let operations:PdfFormValueOperation[]
    try{
     if(input.ops.length>50||input.ops.some(op=>op?.op!=='setFormValue'))throw Error('Do not mix form and page operations; nothing was applied.')
     if(input.dry_run!==undefined&&typeof input.dry_run!=='boolean')throw Error('dry_run must be boolean')
     operations=input.ops.map(op=>{
      if(!op||Object.keys(op).some(key=>!['op','value'].includes(key)))throw Error('Invalid form operation')
      const value=op.value
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['name','value','checked'].includes(key))||typeof value.name!=='string')throw Error('Use value{name,value?,checked?}; do not pass kind')
      const field=fields.find(field=>field.name===value.name)
      if(!field||field.readOnly||field.kind==='signature')throw Error('Unknown, read-only or signature field; read list_form_fields first')
      if(field.kind==='checkbox'){
       if(typeof value.checked!=='boolean'||value.value!==undefined)throw Error('Checkbox fields require only checked:boolean')
       return {op:'setFormValue',value:{name:field.name,checked:value.checked}}
      }
      if(value.checked!==undefined||value.value!==undefined&&typeof value.value!=='string')throw Error('Text, radio and choice fields require value:string')
      const text=value.value??''
      if(field.kind!=='text'&&text&&!field.options.includes(text))throw Error('The field value must match a listed option')
      return {op:'setFormValue',value:{name:field.name,value:text}}
     })
    }catch(error){return {output:`${error instanceof Error?error.message:'Invalid form batch'}. Nothing was applied.`,summary:'Fill PDF form fields',isError:true,mutated:false}}
    if(input.dry_run===true)return {output:'Dry run: field names, types and options are valid against the current saved snapshot. Nothing was changed; file protection and writability have not been checked.',summary:'Validate PDF form fields',mutated:false}
    if(!await formValues(operations,signal))return {output:'The PDF form changes could not be saved. No successful change is confirmed.',summary:'PDF form fill failed',isError:true,mutated:false}
    return {output:'Saved the PDF form values and appearances as one new revision. Re-read list_form_fields for the saved values.',summary:'Fill PDF form fields',mutated:true}
   }
   if(call.name==='apply_ops'||call.name==='insert_blank_page'){
    if(!pageOperations)return {output:'PDF page operations are unavailable.',summary:'Edit PDF pages',isError:true,mutated:false}
    let operations:readonly PdfPageOperation[]
    try{
     if(call.name==='apply_ops'&&((input.dry_run!==undefined&&typeof input.dry_run!=='boolean')||!Array.isArray(input.ops)||input.ops.length>50||input.ops.some(op=>!op||!['rotatePages','deletePage','setPageOrder','setMetadata'].includes(op.op))))throw Error('Invalid PDF page operation')
     operations=validatePdfPageOperations(call.name==='apply_ops'?input.ops:[{op:'insertBlankPage',afterPage:input.after_page}],pages.length)
    }catch{return {output:'Invalid page operation batch. Use source page numbers, valid rotations, and an exact surviving-page order; at least one page must remain. Nothing was applied.',summary:'Edit PDF pages',isError:true,mutated:false}}
    if(call.name==='apply_ops'&&input.dry_run===true)return {output:'Dry run: the operation layout is valid. The PDF was not modified; protection and writability have not been checked.',summary:'Validate PDF page operations',mutated:false}
    if(!await pageOperations(operations,signal))return {output:'The PDF page changes could not be saved. No successful change is confirmed.',summary:'PDF page operation failed',isError:true,mutated:false}
    return {output:'Saved PDF page or document-property changes as a new version. Page numbers may have changed; re-read pages and annotations before further edits.',summary:call.name==='insert_blank_page'?'Insert blank PDF page':'Edit PDF pages',mutated:true}
   }
   if(call.name==='reply_note'||call.name==='edit_note'){
    const page=pages.find(page=>page.page===input.page)
    const note=page?.annotations?.find(annotation=>annotation.id===input.note_id&&annotation.type==='Text')
    const text=typeof input.text==='string'?input.text.trim():''
    if(!updateNote||!Number.isSafeInteger(input.page)||!note||!text||text.length>4000||(call.name==='reply_note'&&note.replyTo))return {output:'Select a matching saved sticky-note ID from read_annotations and provide nonempty text. Replies require a root note. No change was saved.',summary:'Update PDF note',isError:true,mutated:false}
    const operation:PdfNoteUpdate={page:page!.page,annotationId:note.id,action:call.name==='reply_note'?'reply':'edit',text}
    if(!await updateNote(operation,signal))return {output:'The PDF note update could not be saved. No successful change is confirmed.',summary:'PDF note update failed',isError:true,mutated:false}
    return {output:`${operation.action==='reply'?'Replied to':'Edited'} the PDF note on page ${page!.page} and saved a new version.`,summary:operation.action==='reply'?'Reply to PDF note':'Edit PDF note',mutated:true}
   }
   if(call.name==='delete_markup'||call.name==='delete_note'){
    const page=pages.find(page=>page.page===input.page),types:Record<string,string>={highlight:'Highlight',underline:'Underline',strikeout:'StrikeOut',squiggly:'Squiggly'}
    const ids=call.name==='delete_note'?[input.note_id]:input.markup_ids
    const invalid=!deleteAnnotations||!page||!Number.isSafeInteger(input.page)
     ||(call.name==='delete_markup'&&input.type!==undefined&&(typeof input.type!=='string'||!Object.hasOwn(types,input.type)))
     ||(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length))
    if(invalid)return {output:'Invalid PDF annotation selection or deletion is unavailable.',summary:'Delete PDF annotations',isError:true,mutated:false}
    const annotations=(page!.annotations??[]).filter(annotation=>call.name==='delete_note'?annotation.type==='Text'&&!annotation.replyTo:Object.values(types).includes(annotation.type)&&(input.type===undefined||annotation.type===types[input.type as string]))
    const selected=annotations.filter(annotation=>ids===undefined||(ids as string[]).includes(annotation.id))
    if(!selected.length||selected.length>20||(ids!==undefined&&selected.length!==(ids as string[]).length))return {output:'Select up to 20 matching saved annotation IDs from read_annotations. No annotations were deleted.',summary:'Delete PDF annotations',isError:true,mutated:false}
    if(!await deleteAnnotations!(selected.map(annotation=>({page:page!.page,annotationId:annotation.id})),signal))return {output:'The PDF annotation deletion could not be saved. No successful change is confirmed.',summary:'PDF annotation deletion failed',isError:true,mutated:false}
    return {output:`Deleted ${selected.length} PDF annotation${selected.length===1?'':'s'} and saved a new version.`,summary:'Delete PDF annotations',mutated:true}
   }
   if(call.name==='read_annotations'){
    if(!pages.length||input.page!==undefined&&(!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length))return {output:'The PDF page is not available.',summary:'Read PDF annotations',isError:true,mutated:false}
    const snapshot=pending?.annotations?.(),selected=pages.filter(page=>(input.page===undefined||page.page===input.page)&&!snapshot?.deleted.includes(page.page-1))
    const lines=selected.flatMap(page=>(page.annotations??[]).map(annotation=>`[Page ${page.page}] ${annotation.id}${pending?' [saved]':''}${annotation.replyTo?` (reply to ${annotation.replyTo})`:''} ${annotation.type} (${annotation.author}): ${annotation.contents}`))
    if(snapshot)for(const page of selected){
     for(const m of snapshot.markups.filter(m=>m.pageIndex===page.page-1))lines.push(`[Page ${page.page}] ${m.id} [pending] ${m.type} (AI Assistant):`)
     for(const {id,input:note}of snapshot.notes.filter(n=>n.input.pageIndex===page.page-1))lines.push(`[Page ${page.page}] ${id} [pending] Text (${note.author||'AI Assistant'}): ${note.contents}`)
    }
    return {output:lines.join('\n').slice(0,24000)||'The selected pages have no annotations.',summary:'Read PDF annotations',mutated:false}
   }
   if(call.name==='markup_text'||call.name==='add_note'){
    const page=input.page,text=call.name==='add_note'?input.anchor_text:input.text,type=call.name==='add_note'?'note':input.type,occurrence=input.occurrence??1,contents=input.contents
    if(!(pending?pending.annotate:annotate)||!Number.isSafeInteger(page)||Number(page)<1||Number(page)>pages.length||typeof text!=='string'||!text.trim()||text.length>2000||!['highlight','underline','strikeout','note'].includes(String(type))||!Number.isSafeInteger(occurrence)||Number(occurrence)<1||Number(occurrence)>1000||(type==='note'&&(typeof contents!=='string'||!contents.trim()||contents.length>4000)))return {output:'Invalid PDF annotation or annotation writing is unavailable.',summary:'Annotate PDF',isError:true,mutated:false}
    const annotation:PdfAnnotation={page:Number(page),text,type:type as PdfAnnotation['type'],occurrence:Number(occurrence),...(type==='note'?{contents:contents as string}:{})}
    if(pending){
     try{
      const created=await pending.annotate!(annotation,signal)
      const ids=[...created.markups.map(m=>({id:m.id,page:m.pageIndex+1})),...created.notes.map(n=>({id:n.id,page:n.input.pageIndex+1}))]
      if(ids.length!==1||ids.some(item=>!/^P[^\s\u0000-\u001f\u007f]{1,200}$/.test(item.id)||item.page!==page)||(type==='note'?created.notes.length!==1:created.markups.length!==1))throw Error('Invalid pending annotation result')
      return {output:`Created unsaved PDF annotation ${ids[0]!.id} on page ${page}. Only user Save persists it.`,summary:'Annotate PDF',mutated:true}
     }catch{signal?.throwIfAborted();return {output:'The pending annotation could not be confirmed. Re-read pending annotations before retrying.',summary:'PDF annotation failed',isError:true,mutated:false}}
    }
    if(!await annotate!(annotation,signal))return {output:'The PDF annotation could not be saved. No successful change is confirmed.',summary:'PDF annotation failed',isError:true,mutated:false}
    return {output:`Added a PDF annotation on page ${page} and saved a new version.`,summary:'Annotate PDF',mutated:true}
   }
   if(call.name==='insert_text'){
    const allowed=['page','text','anchor_text','placement','x','y','font_size','color','max_width','align','font','bold','italic']
    const invalid=Object.keys(input).some(key=>!allowed.includes(key))||!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length||typeof input.text!=='string'||!input.text.trim()||input.text.length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)||['x','y','font_size','max_width'].some(key=>input[key]!==undefined&&(typeof input[key]!=='number'||!Number.isFinite(input[key])||(['font_size','max_width'].includes(key)&&Number(input[key])<=0)||Math.abs(Number(input[key]))>(key==='font_size'?1000:100000)))||['bold','italic'].some(key=>input[key]!==undefined&&typeof input[key]!=='boolean')||(input.anchor_text!==undefined&&(typeof input.anchor_text!=='string'||input.anchor_text.length>2000))||(input.placement!==undefined&&!['right','below','above'].includes(String(input.placement)))||(input.align!==undefined&&(typeof input.align!=='string'||!['left','center','right'].includes(input.align)))||(input.font!==undefined&&!['arial','times','courier'].includes(String(input.font)))||(input.color!==undefined&&(typeof input.color!=='string'||!/^#?[0-9a-fA-F]{6}$/.test(input.color)))
    if((!drafts&&!insertText)||invalid)return {output:'Invalid PDF text insertion or insertion writing is unavailable.',summary:'Insert PDF text',isError:true,mutated:false}
    if(drafts){
     try{
      const draft=await drafts.insert({...input} as PdfTextInsert,signal)
      return {output:`Created unsaved PDF text ${JSON.stringify(draft)}. Only user Save creates a revision; use this pending ID for draft edits until saved.`,summary:'Insert unsaved PDF text',mutated:true}
     }catch{return {output:'Could not create unsaved PDF text. No successful change is confirmed.',summary:'PDF draft insertion failed',isError:true,mutated:false}}
    }
    if(!await insertText!({...input} as PdfTextInsert,signal))return {output:'The inserted text could not be confirmed saved. Confirm any pending save result before retrying.',summary:'PDF insertion failed',isError:true,mutated:false}
    return {output:`Inserted new text on page ${input.page} and saved a new revision. It is now page content; use edit_text to change it.`,summary:'Insert PDF text',mutated:true}
   }
   if(call.name==='move_text_block'){
    const invalid=Object.keys(input).some(key=>!['page','paragraph_text','dx','dy'].includes(key))||!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length||typeof input.paragraph_text!=='string'||!input.paragraph_text.trim()||input.paragraph_text.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(String(input.paragraph_text))||['dx','dy'].some(key=>typeof input[key]!=='number'||!Number.isFinite(input[key])||Math.abs(Number(input[key]))>100000)||(input.dx===0&&input.dy===0)
    if(!moveBlock||invalid)return {output:'Invalid PDF paragraph move or moving is unavailable.',summary:'Move PDF paragraph',isError:true,mutated:false}
    if(!await moveBlock({...input} as PdfBlockMove,signal))return {output:'The paragraph move could not be confirmed saved. Confirm any pending save result before retrying.',summary:'PDF paragraph move failed',isError:true,mutated:false}
    return {output:`Moved the paragraph on page ${input.page} and saved a new revision. Re-read its layout to confirm the resulting position.`,summary:'Move PDF paragraph',mutated:true}
   }
   if(call.name==='edit_block'){
    const allowed=['page','paragraph_text','new_text','font_size','color','font','bold','italic','align']
    const invalid=Object.keys(input).some(key=>!allowed.includes(key))||!Number.isSafeInteger(input.page)||Number(input.page)<1||Number(input.page)>pages.length||typeof input.paragraph_text!=='string'||!input.paragraph_text.trim()||input.paragraph_text.length>2000||typeof input.new_text!=='string'||input.new_text.length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(String(input.paragraph_text)+String(input.new_text))||(input.font_size!==undefined&&(typeof input.font_size!=='number'||!Number.isFinite(input.font_size)||input.font_size<=0||input.font_size>1000))||['bold','italic'].some(key=>input[key]!==undefined&&typeof input[key]!=='boolean')||(input.align!==undefined&&(typeof input.align!=='string'||!['left','center','right'].includes(input.align)))||(input.font!==undefined&&!['arial','times','courier'].includes(String(input.font)))||(input.color!==undefined&&(typeof input.color!=='string'||!/^#?[0-9a-fA-F]{6}$/.test(input.color)))
    if(!editBlock||invalid)return {output:'Invalid PDF paragraph edit or paragraph writing is unavailable.',summary:'Edit PDF paragraph',isError:true,mutated:false}
    if(!await editBlock({...input} as PdfBlockEdit,signal))return {output:'The paragraph edit could not be confirmed saved. Confirm any pending save result before retrying.',summary:'PDF paragraph edit failed',isError:true,mutated:false}
    return {output:`${String(input.new_text).trim()?'Replaced':'Deleted'} the paragraph on page ${input.page} and saved a new revision. Other content was not moved.`,summary:'Edit PDF paragraph',mutated:true}
   }
   if(call.name==='edit_text'){
    const {page,old_text:oldText,new_text:newText}=input,occurrence=input.occurrence??1
    if(!editText||!Number.isSafeInteger(page)||Number(page)<1||Number(page)>pages.length||typeof oldText!=='string'||!oldText.trim()||oldText.length>2000||typeof newText!=='string'||newText.length>4000||!Number.isSafeInteger(occurrence)||Number(occurrence)<1||Number(occurrence)>1000)return {output:'Invalid PDF text edit or original text editing is unavailable.',summary:'Edit PDF text',isError:true,mutated:false}
    if(!await editText({page:Number(page),oldText,newText,occurrence:Number(occurrence)},signal))return {output:'The PDF text edit could not be saved. No successful change is confirmed.',summary:'PDF text edit failed',isError:true,mutated:false}
    return {output:`Edited original text on page ${page} and saved a new PDF version.`,summary:'Edit PDF text',mutated:true}
   }
   if(call.name==='rotate_pages'){
    const raw=input.operations
    if(!rotatePages||!Array.isArray(raw)||raw.length<1||raw.length>100)return {output:'Page rotation is unavailable or the operation list is invalid.',summary:'Rotate PDF pages',isError:true,mutated:false}
    const seen=new Set<number>(),operations:{page:number;degrees:number}[]=[]
    for(const value of raw){
     if(!value||typeof value!=='object'||Array.isArray(value))return {output:'Invalid page rotation operation.',summary:'Rotate PDF pages',isError:true,mutated:false}
     const operation=value as Record<string,unknown>,page=operation.page,degrees=operation.degrees
     if(!Number.isSafeInteger(page)||Number(page)<1||Number(page)>pages.length||!Number.isSafeInteger(degrees)||Number(degrees)%90!==0||Number(degrees)%360===0||seen.has(Number(page)))return {output:'Page numbers must be unique pages in this PDF and degrees must be a nonzero multiple of 90.',summary:'Rotate PDF pages',isError:true,mutated:false}
     seen.add(Number(page));operations.push({page:Number(page),degrees:Number(degrees)})
    }
    if(!await rotatePages(operations,signal))return {output:'The PDF rotation could not be saved. No successful change is confirmed.',summary:'PDF rotation failed',isError:true,mutated:false}
    return {output:`Rotated ${operations.length} page${operations.length===1?'':'s'} and saved a new PDF version.`,summary:'Rotate PDF pages',mutated:true}
   }
   if(call.name==='get_outline'){
    if(!pages.length)return {output:'The PDF preview is not ready.',summary:'PDF outline unavailable',isError:true,mutated:false}
    return {output:getOutline().join('\n')||'The document has no outline',summary:'Read PDF outline',mutated:false}
   }
   if(call.name==='read_pages'){
    const start=input.start,end=input.end??start
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||Number(start)<1||Number(end)<Number(start)||Number(end)-Number(start)>=10||Number(end)>pages.length)
     return {output:'Page range is outside the rendered PDF or exceeds 10 pages.',summary:'Invalid page range',isError:true,mutated:false}
    return {output:pages.filter(page=>page.page>=Number(start)&&page.page<=Number(end)).map(page=>`[Page ${page.page}]${page.width!==undefined&&page.height!==undefined?` (${page.width} × ${page.height} pt)`: ''}\n${page.text}`).join('\n\n'),summary:`Read pages ${start}-${end}`,mutated:false}
   }
   if(call.name==='search_text'){
    const query=typeof input.query==='string'?input.query.trim():''
    if(!query)return {output:'Search query is required.',summary:'Empty search',isError:true,mutated:false}
    const matches=pages.flatMap(page=>{
     const index=page.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
     return index<0?[]:[`Page ${page.page}: ${page.text.slice(Math.max(0,index-100),Math.min(page.text.length,index+query.length+100))}`]
    })
    return {output:matches.join('\n')||'No matches.',summary:`Search PDF for ${query}`,mutated:false}
   }
   if(call.name==='goto_page'){
    const page=input.page
    if(!Number.isSafeInteger(page)||Number(page)<1||Number(page)>pages.length||!gotoPage(Number(page)))
     return {output:'Page is not available in the PDF preview.',summary:'Page unavailable',isError:true,mutated:false}
    return {output:`Navigated to page ${page}.`,summary:`Go to page ${page}`,mutated:false}
   }
   return {output:`Unknown PDF preview tool: ${call.name}`,summary:call.name,isError:true,mutated:false}
  },
 }
}
