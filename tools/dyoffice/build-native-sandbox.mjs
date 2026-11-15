import { spawn } from 'node:child_process'
import { mkdir,readFile,readdir,copyFile,chmod,chown,writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve,join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../',import.meta.url))
const cache = resolve(process.env.DYOFFICE_NATIVE_BUILD_CACHE || join(root,'.dyoffice-native-build'))
const builder = 'rust@sha256:7c7d4eb4d05b7781187a327809466cfddf29753f6defdc3d19a0e291951b7a37'
const runtime = 'debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc'
const withProbe = process.argv.includes('--with-probe')
if (process.argv.slice(2).some(arg => arg !== '--with-probe')) throw new Error('Unknown build argument')
const uid = process.getuid?.() || 10001, gid = process.getuid?.() ? process.getgid() : 10001
async function run(args,capture = false) {
  return new Promise((resolve,reject) => {
    const child = spawn('/usr/bin/docker',args,{ stdio: ['ignore',capture ? 'pipe' : 'inherit','inherit'] })
    let output = ''; if (capture) child.stdout.setEncoding('utf8').on('data',chunk => { output += chunk })
    child.once('error',reject); child.once('close',code => code === 0 ? resolve(output.trim()) : reject(new Error('Native image build step failed: ' + code)))
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
await mkdir(cache,{ recursive: true,mode: 0o755 })
if (process.getuid?.() === 0) await chown(cache,uid,gid)
const source = join(root,'apps/sheets/native/xlsx-engine'), sourceSha256 = await sourceDigest(source)
await run(['pull',builder]); await run(['pull',runtime])
await run(['run','--rm','--memory=1536m','--memory-swap=1536m','--cpus=1','--pids-limit=128','--user',`${uid}:${gid}`,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--tmpfs','/tmp:rw,size=256m','--mount',`type=bind,src=${source},dst=/src,readonly`,'--mount',`type=bind,src=${cache},dst=/cache`,'--workdir','/src','--env','CARGO_HOME=/cache/cargo','--env','CARGO_TARGET_DIR=/cache/target',builder,'cargo','build','--locked','--release','-j','1'])
await run(['run','--rm','--network=none','--memory=256m','--cpus=1','--user',`${uid}:${gid}`,'--read-only','--cap-drop=ALL','--tmpfs','/tmp:rw,size=64m','--mount',`type=bind,src=${join(root,'apps/web/worker/src/native/artifact-io.rs')},dst=/io.rs,readonly`,'--mount',`type=bind,src=${cache},dst=/cache`,builder,'rustc','--edition=2024','-O','/io.rs','-o','/cache/artifact-io'])
await run(['run','--rm','--network=none','--memory=256m','--cpus=1','--user',`${uid}:${gid}`,'--read-only','--cap-drop=ALL','--tmpfs','/tmp:rw,size=64m','--mount',`type=bind,src=${join(root,'apps/web/worker/src/native/supervisor.rs')},dst=/supervisor.rs,readonly`,'--mount',`type=bind,src=${cache},dst=/cache`,builder,'rustc','--edition=2024','-O','/supervisor.rs','-o','/cache/supervisor'])
const nativeContext = join(cache,'native-image'); await mkdir(nativeContext,{ recursive: true })
await copyFile(join(cache,'supervisor'),join(nativeContext,'supervisor')); await chmod(join(nativeContext,'supervisor'),0o555)
await copyFile(join(cache,'artifact-io'),join(nativeContext,'artifact-io')); await chmod(join(nativeContext,'artifact-io'),0o555)
await copyFile(join(cache,'target/release/xlsx-sidecar'),join(nativeContext,'xlsx-sidecar')); await chmod(join(nativeContext,'xlsx-sidecar'),0o555)
const sidecarSha256 = createHash('sha256').update(await readFile(join(nativeContext,'xlsx-sidecar'))).digest('hex')
const nativeTag = 'dyoffice-native-xlsx:' + sourceSha256.slice(0,16)
await run(['build','--network=none','--pull=false','--file',join(root,'apps/web/worker/native.Dockerfile'),'--label','dyoffice.native-source=' + sourceSha256,'--label','dyoffice.sidecar-sha256=' + sidecarSha256,'--tag',nativeTag,nativeContext])
const manifest = { builderImage: builder,runtimeImage: runtime,sourceSha256,sidecarSha256,supervisorSha256: createHash('sha256').update(await readFile(join(cache,'supervisor'))).digest('hex'),artifactIoSha256: createHash('sha256').update(await readFile(join(cache,'artifact-io'))).digest('hex'),nativeImage: await run(['image','inspect','--format','{{.Id}}',nativeTag],true) }
if (withProbe) {
  await run(['run','--rm','--network=none','--memory=256m','--cpus=1','--user',`${uid}:${gid}`,'--read-only','--cap-drop=ALL','--tmpfs','/tmp:rw,size=64m','--mount',`type=bind,src=${join(root,'apps/web/test/fixtures/sandbox-probe.c')},dst=/probe.c,readonly`,'--mount',`type=bind,src=${cache},dst=/cache`,builder,'cc','-O2','-o','/cache/sandbox-probe','/probe.c'])
  const context = join(cache,'probe-image'); await mkdir(context,{ recursive: true }); await copyFile(join(cache,'supervisor'),join(context,'supervisor')); await chmod(join(context,'supervisor'),0o555); await copyFile(join(cache,'artifact-io'),join(context,'artifact-io')); await chmod(join(context,'artifact-io'),0o555); await copyFile(join(cache,'sandbox-probe'),join(context,'sandbox-probe')); await chmod(join(context,'sandbox-probe'),0o555)
  const tag = 'dyoffice-sandbox-probe:' + createHash('sha256').update(await readFile(join(context,'sandbox-probe'))).digest('hex').slice(0,16)
  await run(['build','--network=none','--pull=false','--file',join(root,'apps/web/test/fixtures/sandbox-probe.Dockerfile'),'--tag',tag,context])
  manifest.probeImage = await run(['image','inspect','--format','{{.Id}}',tag],true)
}
await writeFile(join(cache,'manifest.json'),JSON.stringify(manifest,null,2) + '\n',{ mode: 0o600 })
console.log('Native sandbox manifest: ' + join(cache,'manifest.json'))
