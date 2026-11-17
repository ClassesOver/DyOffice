export function hideAccountRecoveryPortals(){
 const portals=[...document.querySelectorAll<HTMLElement>('.ant-modal-root,.ant-dropdown,.row-menu,.folder-menu')].map(node=>({node,inert:node.inert,visibility:node.style.visibility,display:node.style.display}))
 for(const {node} of portals){node.inert=true;node.style.visibility='hidden';node.style.display='none'}
 return()=>{for(const {node,inert,visibility,display} of portals){node.inert=inert;node.style.visibility=visibility;node.style.display=display}}
}
