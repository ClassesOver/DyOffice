import { createSessionFileHost } from '../../../../packages/browser-host/src/files.ts'
import { mountDocsEditor } from './native-docs.tsx'
import { messages } from './messages.ts'

async function bootstrap() {
  const host = createSessionFileHost(), fileId = new URL(location.href).searchParams.get('fileId') ?? ''
  try {
    const mounted = await mountDocsEditor(host,document.getElementById('root')!,fileId)
    window.addEventListener('pagehide',() => { void host.releaseLease(fileId,true).catch(() => {}); mounted.dispose(); host.dispose() },{ once: true })
  } catch (error) { host.dispose(); throw error }
}
void bootstrap().catch(() => { document.getElementById('root')!.textContent = messages.zh.failed })
