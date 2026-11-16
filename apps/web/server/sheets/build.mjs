import {build} from 'esbuild'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {resolve} from 'node:path'

export async function buildSheetsGateway(outfile = fileURLToPath(new URL('../../dist-sheets-server/gateway.mjs',import.meta.url))) {
  await build({entryPoints:[fileURLToPath(new URL('./gateway.ts',import.meta.url))],bundle:true,platform:'node',target:'node22',format:'esm',outfile,banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},logLevel:'silent'})
  return outfile
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await buildSheetsGateway()
