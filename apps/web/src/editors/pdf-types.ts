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
export type PdfImageDraftInfo={id:string;page:number;x:number;y:number;width:number;height:number}
export type PdfImageTools={editsAreDrafts?:boolean;read:(page?:number,signal?:AbortSignal)=>Promise<readonly PdfImageInfo[]>;edit:(operation:PdfImageOperation,signal?:AbortSignal)=>Promise<boolean>;insertDraft?:(input:Extract<PdfImageContentInput,{op:'insert_image'}>,signal?:AbortSignal)=>Promise<PdfImageDraftInfo>;content?:(input:PdfImageContentInput,signal?:AbortSignal)=>Promise<boolean>}
export type PdfAnnotation={page:number;text:string;type:'highlight'|'underline'|'strikeout'|'note';contents?:string;occurrence:number}
