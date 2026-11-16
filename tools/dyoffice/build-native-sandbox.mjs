import { spawn } from 'node:child_process'
import { mkdir,readFile,readdir,copyFile,chmod,writeFile,rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve,join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url))
const cache=resolve(process.env.DYOFFICE_NATIVE_BUILD_CACHE || join(root,'.dyoffice-native-build'))
const withProbe=process.argv.includes('--with-probe')
if(process.argv.slice(2).some(arg=>arg!=='--with-probe'))throw new Error('Unknown build argument')
async function run(command,args,capture=false) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env:{...process.env,CARGO_TARGET_DIR:join(cache,'host-target')},stdio:['ignore',capture?'pipe':'inherit','inherit']})
    let output='';if(capture)child.stdout.setEncoding('utf8').on('data',chunk=>{output+=chunk})
    child.once('error',reject);child.once('close',code=>code===0?resolve(output.trim()):reject(new Error('Native host build failed: '+code)))
  })
}
async function sourceDigest(directory) {
  const hash = createHash('sha256')
  async function visit(path,prefix = '') {
    for (const item of (await readdir(path,{ withFileTypes: true })).sort((a,b) => a.name<b.name ? -1 : a.name>b.name ? 1 : 0)) {
      if (['target','.git'].includes(item.name)) continue
      const relative = prefix + item.name
      if (item.isDirectory()) await visit(join(path,item.name),relative + '/')
      else if (item.isFile()) { hash.update(relative + '\0'); hash.update(await readFile(join(path,item.name))) }
      else throw new Error('Native source cannot contain symlinks')
    }
  }
  await visit(directory); return hash.digest('hex')
}
await mkdir(cache,{recursive:true,mode:0o755})
const source=join(root,'apps/sheets/native/xlsx-engine'),sourceSha256=await sourceDigest(source)
const rustcVersion=await run('rustc',['--version','--verbose'],true),cargoVersion=await run('cargo',['--version'],true)
await run('cargo',['build','--manifest-path',join(source,'Cargo.toml'),'--locked','--release','-j','1'])
if(await sourceDigest(source)!==sourceSha256)throw new Error('Native source changed during build')
const nativeBinary=join(cache,'xlsx-sidecar')
await copyFile(join(cache,'host-target/release/xlsx-sidecar'),nativeBinary);await chmod(nativeBinary,0o555)
const hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
const manifest={sourceSha256,rustcVersion,cargoVersion,nativeBinary,nativeSha256:await hash(nativeBinary)}
if(withProbe){
  const probeBinary=join(cache,'host-sandbox-probe')
  await run('cc',['-O2','-o',probeBinary,join(root,'apps/web/test/fixtures/sandbox-probe.c')]);await chmod(probeBinary,0o555)
  Object.assign(manifest,{probeBinary,probeSha256:await hash(probeBinary)})
}
const destination=join(cache,'host-manifest.json'),temporary=destination+'.tmp'
await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,destination)
console.log('Native host manifest: '+destination)
