import type {Node} from '@tiptap/pm/model'
import type {EditorState} from '@tiptap/pm/state'
import {TRACK_IGNORE} from './editor/revisions'

// DOCX 重解析会重建段落锚点和文本标记。只同步属性变化，避免用整文档
// replace 步骤覆盖另一端在保存期间刚插入的内容。
export function wordSaveNormalization(state:EditorState,saved:Node) {
  const current=state.doc,tr=state.tr.setMeta(TRACK_IGNORE,true).setMeta('addToHistory',false)
  if(current.eq(saved))return tr
  if(current.content.size!==saved.content.size||current.textContent!==saved.textContent)return null
  let compatible=true
  const shapes=(doc:Node)=>{const keys:string[]=[];doc.descendants((n,p)=>{if(!n.isText)keys.push(p+':'+n.type.name+':'+n.nodeSize)});return keys}
  const initial=shapes(current),final=shapes(saved)
  if(initial.length!==final.length||initial.some((v,i)=>v!==final[i]))return null
  saved.descendants((n,pos)=>{
    if(n.isText){
      // 切分出的标记区间不一定等同于原文本节点的边界。
      const end=pos+n.nodeSize
      if(current.textBetween(pos,end)!==n.text){compatible=false;return}
      current.nodesBetween(pos,end,(other,p)=>{
        if(!other.isText)return
        const from=Math.max(p,pos),to=Math.min(p+other.nodeSize,end)
        for(const m of other.marks)if(!m.isInSet(n.marks))tr.removeMark(from,to,m)
        for(const m of n.marks)if(!m.isInSet(other.marks))tr.addMark(from,to,m)
      })
    }else {
      const old=current.nodeAt(pos)!
      for(const [key,value] of Object.entries(n.attrs))if(JSON.stringify(old.attrs[key])!==JSON.stringify(value))tr.setNodeAttribute(pos,key,value)
      for(const m of old.marks)if(!m.isInSet(n.marks))tr.removeNodeMark(pos,m)
      for(const m of n.marks)if(!m.isInSet(old.marks))tr.addNodeMark(pos,m)
    }
  })
  return compatible&&tr.doc.eq(saved)?tr:null
}
