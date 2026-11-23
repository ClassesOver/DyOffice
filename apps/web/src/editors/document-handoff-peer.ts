/** Native editors are inside the DyOffice shell in both a popup and the DSH sidebar. */
export function documentHandoffPeer(win: Window = window) {
 const shell=win.parent
 try {
  if(shell!==win&&shell!==shell.parent&&new URL(shell.location.href).searchParams.get('dshEmbed')==='1'){
   return {shell,peer:shell.parent,embedded:true}
  }
  const top=win.top,opener=top?.opener as Window|null
  if(top&&opener)return {shell:top,peer:opener,embedded:false}
 }catch{ /* A different embedding page is not a handoff peer. */ }
 return null
}
