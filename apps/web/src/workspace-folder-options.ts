import type {WorkspaceFolder} from '../../../packages/web-contracts/src/workspace'

export function folderChoices(folders:WorkspaceFolder[]){
 const byId=new Map(folders.map(folder=>[folder.id,folder]))
 return folders.flatMap(folder=>{
  const names:string[]=[],seen=new Set<string>()
  let current:WorkspaceFolder|undefined=folder
  while(current&&!seen.has(current.id)){
   names.unshift(current.name);seen.add(current.id)
   if(current.parentId===null)return [{id:folder.id,name:names.join(' / ')}]
   current=byId.get(current.parentId)
  }
  return []
 }).sort((a,b)=>a.name.localeCompare(b.name))
}
