import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const target = 'wasm32-wasip1'
const cargoTarget = resolve(root, process.env.CARGO_TARGET_DIR || '.dyoffice-native-build/wasi-target')
const manifest = join(root, 'apps/sheets/native/xlsx-engine/Cargo.toml')
const output = join(root, 'apps/web/dist-sheets-server/xlsx-refresh-wasi.mjs')

await new Promise((complete, reject) => {
  const cargo = spawn('cargo', ['build', '--locked', '--release', '--target', target,
    '--target-dir', cargoTarget, '--jobs', '1', '--manifest-path', manifest],
  { cwd: root, stdio: 'inherit' })
  cargo.once('error', reject)
  cargo.once('close', code => code === 0 ? complete() : reject(new Error('XLSX WASI build failed: '+code)))
})

const wasm = await readFile(join(cargoTarget, target, 'release/xlsx-sidecar.wasm'))
if (wasm.length < 8 || wasm.readUInt32LE(0) !== 0x6d736100) throw new Error('Invalid XLSX WASI artifact')
// Snapshot the runner and its module together through the existing script
// digest check, so execution never reopens an unverified WASM path.
const runner = `import { WASI } from 'node:wasi'
const wasi = new WASI({version:'preview1', env:{TMPDIR:'/work'}, preopens:{'/work':process.cwd()}})
const binary = Buffer.from('${wasm.toString('base64')}','base64')
const {instance} = await WebAssembly.instantiate(binary,wasi.getImportObject())
process.exitCode = wasi.start(instance)
`
if (Buffer.byteLength(runner) > 32*1024*1024) throw new Error('XLSX WASI runner exceeds script snapshot limit')
await mkdir(dirname(output), {recursive:true})
const temporary=output+'.'+randomUUID()+'.tmp'
try {
  await writeFile(temporary, runner, {flag:'wx'})
  await rename(temporary,output)
} finally {
  await rm(temporary,{force:true})
}
console.log('XLSX WASI refresh runner: '+output)
