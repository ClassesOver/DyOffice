import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const lock = JSON.parse(await readFile(new URL('./runtime-lock.json', import.meta.url), 'utf8'))
const workflowRoot = new URL('../../.github/workflows/', import.meta.url)
const fail = message => { throw new Error('Runtime lock: ' + message) }
export function validateNodeRuntime({version,platform,arch,sha256}) {
  if (version !== lock.node.version || platform !== 'linux' || arch !== 'x64' || sha256 !== lock.node.binarySha256) fail('Node version/platform/executable differs from verified release')
}
export async function checkWorkflows(supplied) {
  const names = supplied ? Object.keys(supplied) : (await readdir(workflowRoot)).filter(n => /^dyoffice-.*\.yml$/.test(n))
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...lock.workflows].sort())) fail('workflow inventory changed; review runtime coverage')
  for (const name of names) {
    const source = supplied ? supplied[name] : await readFile(new URL(name, workflowRoot), 'utf8')
    // Fail closed for the reviewed workflows' literal YAML layout. This is not
    // a general YAML interpreter: new jobs/layouts require explicit review.
    const body=source.split(/^jobs:\s*$/m)[1]
    if(!body) fail(name + ' has no literal jobs section')
    const jobs=[...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\s*$|(?![\s\S]))/gm)]
    if(!jobs.length) fail(name + ' has no reviewed jobs')
    for(const [,job,content] of jobs) {
      const parts=content.split(/^    steps:\s*$/m)
      if(parts.length!==2 || /^    (?:if|continue-on-error)\s*:/m.test(parts[0])) fail(name + '/' + job + ' can skip or ignore runtime checks')
      const steps=parts[1].split(/^      - /m).slice(1)
      const setups=steps.map((step,index)=>step.includes('uses: actions/setup-node@')?index:-1).filter(index=>index>=0)
      const guards=steps.map((step,index)=>/^        run: node tools\/dyoffice\/runtime-lock\.mjs --runtime\s*$/m.test(step)?index:-1).filter(index=>index>=0)
      if(setups.length!==1 || guards.length!==1 || guards[0]!==setups[0]+1) fail(name + '/' + job + ' requires an immediate runtime check after setup-node')
      if(steps.slice(0,setups[0]).some(step=>/^(?:run:|        run:)/m.test(step))) fail(name + '/' + job + ' runs commands before runtime admission')
      const setup=steps[setups[0]], guard=steps[guards[0]]
      if(!/^name: Verify immutable Node runtime\n        run: node tools\/dyoffice\/runtime-lock\.mjs --runtime\s*$/.test(guard)) fail(name + '/' + job + ' has unreviewed runtime step keys or syntax')
      const version=setup.match(/^          node-version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
      if(version!==lock.node.version || /^(?:if\s*:|continue-on-error\s*:|        (?:if|continue-on-error|shell)\s*:)/m.test(setup+'\n'+guard)) fail(name + '/' + job + ' must unconditionally verify exact Node and propagate failure')
      if(/^(?:    defaults\s*:|    continue-on-error\s*:)/m.test(content) || /^defaults\s*:/m.test(source)) fail(name + '/' + job + ' has unreviewed shell defaults')
    }
    const images = [...source.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(m => m[1])
    if (images.some(i => !Object.values(lock.images).includes(i))) fail(name + ' contains an unreviewed image')
    if (!source.includes("'tools/dyoffice/runtime-lock*'")) fail(name + ' does not run when runtime lock changes')
  }
}
export async function checkNodeRuntime() {
  const sha256 = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
  validateNodeRuntime({version:process.versions.node,platform:process.platform,arch:process.arch,sha256})
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--runtime') { await checkNodeRuntime(); console.log('Verified Node ' + lock.node.version + ' executable SHA-256') }
    else if (process.argv[2] === '--check') { await checkWorkflows(); console.log('Verified DyOffice CI runtime declarations') }
    else fail('expected --check or --runtime')
  } catch (error) { console.error(error.message); process.exitCode=1 }
}
