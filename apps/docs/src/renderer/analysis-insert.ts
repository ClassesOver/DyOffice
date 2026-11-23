import type {Editor} from '@tiptap/core'
import type {NativeAnalysisEditor} from '../../../../packages/web-contracts/src/analysis-document'
import {literalHtml} from '../../../../packages/browser-host/src/analysis-literal-content'
import {literalImage} from '../../../../packages/browser-host/src/analysis-image'
import {captureSaveMetadata} from './save-metadata'
import type {FileActionContext} from './file-actions'
import {executeTool,markDocSeen} from './ai/tools'
import {blockRangePositions} from './ai/doc-utils'
import {authorName} from './author-name'
export function docsAnalysisEditor(editor:Editor,context:()=>FileActionContext,readOnly:()=>boolean,onApplied:()=>void):NativeAnalysisEditor {
 return {captureAnalysis(){
  if(context().saveInFlightRef.current||editor.isDestroyed||!editor.isEditable||readOnly())throw new Error('Editor unavailable')
  const state=editor.state,doc=editor.state.doc,selection=editor.state.selection,meta=captureSaveMetadata(context())
  const matches=()=>!editor.isDestroyed&&editor.isEditable&&!readOnly()&&editor.state===state&&editor.state.doc===doc&&editor.state.selection.eq(selection)&&!meta.changed(context())
  const matchesForSave=()=>!editor.isDestroyed&&editor.state.doc===doc&&!meta.changed(context())
  return {matches,matchesForSave,async apply(content,authorized){
   if(content.kind==='image'){
    // Validated bytes only (header size must match); never a model-supplied URL.
    const image=literalImage(content)
    if(!authorized()||!matches())return false
    // insert_picture defaults to the end of the document; anchor it after the
    // captured cursor block, and put its provenance right after the picture.
    const cursorBlock=editor.state.doc.resolve(editor.state.selection.from).index(0),blocks=editor.state.doc.childCount
    onApplied()
    markDocSeen(editor)
    const tracked=editor.storage.trackChanges?.enabled?{author:authorName()}:undefined
    const picture=await executeTool(editor,{id:crypto.randomUUID(),name:'insert_picture',input:{url:`data:${image.mediaType};base64,${image.base64}`,width:`${Math.min(image.width,600)}px`,altText:image.alt,afterBlockIndex:cursorBlock}},{bullet:null,ordered:null},tracked)
    if(picture.mutated!==true||picture.isError)return false
    if(!image.provenance?.length)return true
    const pictureBlock=cursorBlock+1
    const removePicture=()=>{
     // All or nothing: a picture without its provenance must not stay behind.
     if(editor.isDestroyed||editor.state.doc.childCount!==blocks+1)return
     const {from,to}=blockRangePositions(editor,pictureBlock,pictureBlock)
     editor.chain().command(({tr})=>{tr.delete(from,to);return true}).run()
     markDocSeen(editor)
    }
    if(editor.state.doc.childCount!==blocks+1){removePicture();return false}
    markDocSeen(editor)
    const notes=executeTool(editor,{id:crypto.randomUUID(),name:'insert_content',input:{html:literalHtml({kind:'text',text:image.provenance.join('\n')}),afterBlockIndex:pictureBlock}},{bullet:null,ordered:null},tracked)
    if(notes instanceof Promise)throw new Error('Unexpected asynchronous document tool')
    if(notes.mutated===true&&!notes.isError)return true
    removePicture()
    return false
   }
   const html=literalHtml(content)
   if(!authorized()||!matches())return false
   onApplied() // also block autosave if a tool fails after a partial mutation
   markDocSeen(editor)
   const result=executeTool(editor,{id:crypto.randomUUID(),name:'insert_content',input:{html}}, {bullet:null,ordered:null},editor.storage.trackChanges?.enabled?{author:authorName()}:undefined)
   if(result instanceof Promise)throw new Error('Unexpected asynchronous document tool')
   const applied=result.mutated===true&&!result.isError
   return applied
  }}
 }}
}
