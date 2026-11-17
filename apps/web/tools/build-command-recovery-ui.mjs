import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url)),
  out = root + 'apps/web/dist-command-recovery'
await mkdir(out, { recursive: true })
await build({
  stdin: {
    contents: `import {createHttpCommandRecoveryClient,installCommandRecoveryPage} from './packages/browser-host/src/command-recovery-ui.ts'; const config=JSON.parse(document.getElementById('recovery-config').textContent); installCommandRecoveryPage(document.querySelector('main'),{fileId:config.fileId,commandId:config.commandId,createClient:()=>createHttpCommandRecoveryClient({getCsrfToken:async()=>{const r=await fetch('/api/v1/auth/csrf',{mode:'same-origin',redirect:'error',credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('Session unavailable');return (await r.json()).csrfToken}})});`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: out + '/recovery.js',
  minify: true,
})
console.log('Built isolated recovery module: ' + out + '/recovery.js')
