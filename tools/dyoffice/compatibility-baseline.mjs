import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baselinePath = 'docs/dyoffice/inventory/compatibility-lock.json'
export const configuration = {
  inputs: [
    'package.json', 'package-lock.json', 'apps/web/package.json', 'apps/web/package-lock.json',
    ...['docs','sheets','slides','pdf'].map(app=>`apps/${app}/package.json`),
    'apps/sheets/native/xlsx-engine/Cargo.toml', 'apps/sheets/native/xlsx-engine/Cargo.lock',
    'apps/sheets/native/xlsx-engine/.cargo/config.toml',
    'apps/sheets/native/win-clipboard-helper/Cargo.toml', 'apps/sheets/native/win-clipboard-helper/Cargo.lock',
    'apps/sheets/native/win-clipboard-helper/.cargo/config.toml',
    'apps/docs/src/renderer/fonts/README.md', 'apps/docs/src/renderer/fonts/LICENSE-OFL.txt', 'NOTICE', 'LICENSE',
  ],
  fonts: ['apps/docs/src/renderer/fonts', 'packages/ui/src/fonts'],
  npm: {
    'package-lock.json': ['typescript', 'electron', '@modelcontextprotocol/sdk', '@embedpdf/pdfium', 'pdfjs-dist', 'pdf-lib', '@univerjs/core'],
    'apps/web/package-lock.json': ['@modelcontextprotocol/sdk', 'typescript', 'fastify', '@fastify/rate-limit', '@types/node'],
  },
  cargo: ['apps/sheets/native/xlsx-engine/Cargo.lock', 'apps/sheets/native/win-clipboard-helper/Cargo.lock'],
}

async function fontFiles(base, path) {
  const found=[]
  for (const entry of await readdir(join(base,path), {withFileTypes:true})) {
    const next=path+'/'+entry.name
    if(entry.isDirectory()) found.push(...await fontFiles(base,next))
    else if(entry.isFile() && /\.(ttf|otf|woff2?)$/i.test(entry.name)) found.push(next)
  }
  return found
}

export async function buildBaseline(base=root, config=configuration) {
  const files={}
  const paths=new Set(config.inputs)
  for(const path of config.fonts) {
    const fonts=await fontFiles(base,path)
    if(!fonts.length) throw new Error(`No font assets found in ${path}`)
    for(const file of fonts) paths.add(file)
  }
  for(const path of [...paths].sort()) {
    const bytes=await readFile(join(base,path))
    files[path]={sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length}
  }
  const npm={}
  for(const [path,names] of Object.entries(config.npm)) {
    const lock=JSON.parse(await readFile(join(base,path),'utf8'))
    if(lock.lockfileVersion!==3) throw new Error(`Unsupported npm lockfile version: ${path}`)
    npm[path]={}
    for(const name of [...names].sort()) {
      const entry=lock.packages?.['node_modules/'+name]
      if(!entry?.version || !entry.integrity) throw new Error(`Missing locked version/integrity for ${name} in ${path}`)
      npm[path][name]={version:entry.version,integrity:entry.integrity}
    }
  }
  const cargo={}
  for(const path of config.cargo) {
    const lock=await readFile(join(base,path),'utf8')
    cargo[path]=lock.split(/^\[\[package\]\]\s*$/m).slice(1).map(block=>{
      const field=name=>block.match(new RegExp('^'+name+' = "([^"\\n]+)"','m'))?.[1]
      const name=field('name'),version=field('version'),checksum=field('checksum')
      if(!name || !version) throw new Error(`Invalid Cargo package record in ${path}`)
      return {name,version,...(checksum?{checksum}:{})}
    }).sort((a,b)=>a.name.localeCompare(b.name,'en')||a.version.localeCompare(b.version,'en'))
    if(!cargo[path].length) throw new Error(`No Cargo package records in ${path}`)
  }
  return {schemaVersion:1,files,npm,cargo}
}

export function compareBaseline(expected,actual) {
  const changes=[]
  if(expected.schemaVersion!==actual.schemaVersion) changes.push('schemaVersion')
  for(const group of ['files','npm','cargo']) {
    for(const key of [...new Set([...Object.keys(expected[group]??{}),...Object.keys(actual[group]??{})])].sort()) {
      if(JSON.stringify(expected[group]?.[key])!==JSON.stringify(actual[group]?.[key])) changes.push(group+'.'+key)
    }
  }
  return changes
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const mode=process.argv[2]??'--check'
  if(!['--check','--write'].includes(mode) || process.argv.length>3) throw new Error('Usage: node tools/dyoffice/compatibility-baseline.mjs [--check|--write]')
  const actual=await buildBaseline()
  if(mode==='--write') {
    await writeFile(join(root,baselinePath),JSON.stringify(actual,null,2)+'\n')
    console.log(`Recorded ${Object.keys(actual.files).length} input files in ${baselinePath}; this is not runtime compatibility acceptance.`)
  } else {
    const expected=JSON.parse(await readFile(join(root,baselinePath),'utf8'))
    const changes=compareBaseline(expected,actual)
    for(const path of changes) console.error(`Compatibility baseline drift: ${path}`)
    console.log(`Compatibility input baseline: ${Object.keys(actual.files).length} files, ${changes.length} changes. Runtime compatibility not tested.`)
    if(changes.length) process.exitCode=1
  }
}
