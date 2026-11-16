import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {buildSheetsGateway} from '../../server/sheets/build.mjs'
export async function sheetsGateway(t) {
 const directory=await mkdtemp(join(tmpdir(),'dyoffice-gateway-'))
 t.after(()=>rm(directory,{recursive:true,force:true}))
 const outfile=join(directory,'gateway.mjs')
 await buildSheetsGateway(outfile)
 return import(pathToFileURL(outfile).href)
}
