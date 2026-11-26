import {reportDocumentOpenError} from './document-loading-state'
import {createDraftCopyAuthority,draftCopyParentActive} from './draft-copy-authority'
import { createSessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { mountDocsEditor } from './native-docs.tsx'
import {installEditorCloseLifecycle} from './editor-close-lifecycle'
import { messages } from './messages.ts'

async function bootstrap() {
  const params=new URLSearchParams(location.search),fileId=params.get('fileId')??''
  const guest=params.get('guest')==='1',editorId=params.get('editorId')
  const host=createSessionFileHost({...(guest&&editorId?{editorId}:{}),expectedRevision:params.get('sourceRevision')??undefined})
  installEditorCloseLifecycle(window,{canClose:async()=>false,dispose:async()=>false})
  try {
    const draftAuthority=await createDraftCopyAuthority(()=>draftCopyParentActive(window))
    const mounted = await mountDocsEditor(host,document.getElementById('root')!,fileId,draftAuthority,params.has('sourceRevision'),guest)
    installEditorCloseLifecycle(window,{canClose:mounted.canClose,dispose:async()=>{const closed=await mounted.dispose();if(closed)host.dispose();return closed}})
    window.addEventListener('pagehide',()=>{mounted.unload();host.dispose()},{once:true})
  } catch (error) { await host.releaseLease(fileId).catch(()=>{});host.dispose();installEditorCloseLifecycle(window,{canClose:async()=>true,dispose:async()=>true});throw error }
}
void bootstrap().catch(error => { reportDocumentOpenError(error);document.getElementById('root')!.textContent = messages.zh.failed })
