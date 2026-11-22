import type {Editor} from '@tiptap/core'
import type {NativeAnalysisEditor} from '../../../../packages/web-contracts/src/analysis-document'
import {literalHtml} from '../../../../packages/browser-host/src/analysis-literal-content'
import {literalImage} from '../../../../packages/browser-host/src/analysis-image'
import {captureSaveMetadata} from './save-metadata'
import type {FileActionContext} from './file-actions'
import {executeTool,markDocSeen} from './ai/tools'
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
    onApplied()
    markDocSeen(editor)
    const tracked=editor.storage.trackChanges?.enabled?{author:authorName()}:undefined
    const picture=await executeTool(editor,{id:crypto.randomUUID(),name:'insert_picture',input:{url:`data:${image.mediaType};base64,${image.base64}`,width:`${Math.min(image.width,600)}px`,altText:image.alt}},{bullet:null,ordered:null},tracked)
    if(picture.mutated!==true||picture.isError)return false
    if(!image.provenance?.length)return true
    const notes=executeTool(editor,{id:crypto.randomUUID(),name:'insert_content',input:{html:literalHtml({kind:'text',text:image.provenance.join('\n')})}},{bullet:null,ordered:null},tracked)
    if(notes instanceof Promise)throw new Error('Unexpected asynchronous document tool')
    return notes.mutated===true&&!notes.isError
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
