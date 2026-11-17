import type {Editor} from '@tiptap/core'
import type {NativeAnalysisEditor} from '../../../../packages/web-contracts/src/analysis-document'
import {literalHtml} from '../../../../packages/browser-host/src/analysis-literal-content'
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
