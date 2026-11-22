import { setTimeout as delay } from 'node:timers/promises'
import { SandboxError, type SandboxSession } from '../sandbox/contracts.ts'
import { createNativeAdmission, type NativeProcess } from './admission.ts'

export interface RecalcInput {edits: {sheetName: string; row: number; column: number; input: string}[]; reads: {sheetName: string; range: {startRow: number; endRow: number; startColumn: number; endColumn: number}}[]}
export interface FindInput {
  query:string; matchCase:boolean; matchEntireCell:boolean; lookIn:'values'|'formulas'|'formulas_only'|'both'
  wildcards:boolean; limit:number; resumeAt?:{row:number;column:number}
}
type Opened = { sessionId: string; sheets: { id: string; name: string }[] }
function opened(value: unknown): Opened {
  const result = value as Opened
  if (!result || typeof result.sessionId!=='string' || !/^[a-f0-9-]{36}$/.test(result.sessionId) || !Array.isArray(result.sheets) || result.sheets.length<1 || result.sheets.length>256 || result.sheets.some(sheet => !sheet || typeof sheet.id!=='string' || typeof sheet.name!=='string')) throw new SandboxError('INVALID_PROTOCOL')
  return result
}
/** Desktop keeps sessions alive while indexing streams; a Web call must wait
 * in its own session, otherwise every retry would restart the same index. */
async function waitForSheet(io: SandboxSession, sessionId: string, sheetId: string, signal?: AbortSignal) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const result = await io.request('read_range', {sessionId, sheetId, range: {startRow: 0, endRow: 0, startColumn: 0, endColumn: 0}}) as {indexingComplete: boolean}
    if (result?.indexingComplete === true) return
    if (result?.indexingComplete !== false) throw new SandboxError('INVALID_PROTOCOL')
    if (Date.now() >= deadline) throw new SandboxError('INDEX_TIMEOUT')
    await delay(50, undefined, {signal})
  }
}
export interface XlsxMutationPlan {
  replaced: ReadonlyMap<string,string>; added: ReadonlyMap<string,string>; addedBinary: ReadonlyMap<string,Uint8Array>; removedEntries: readonly string[]
}

export interface BoundWorkbookSource {
  index: number
  bytes: Uint8Array
}
/** Uses the original sidecar's archive writer. This is an archive roundtrip,
 * not an editor or persisted recalculation implementation. */
export function createXlsxNativeWorker(process: NativeProcess) {
  const native = createNativeAdmission(process)
  let refreshing = false
  return {
    async refreshExternalLinks(input: Uint8Array, sources: readonly BoundWorkbookSource[], signal?: AbortSignal) {
      if (!(input instanceof Uint8Array) || !Array.isArray(sources) || sources.length > 256) {
        throw new SandboxError('INPUT_LIMIT')
      }
      let total = input.byteLength
      const indices = new Set<number>()
      for (const source of sources) {
        if (!Number.isInteger(source?.index) || source.index < 1 || source.index > 256 ||
            indices.has(source.index) || !(source.bytes instanceof Uint8Array) || !source.bytes.byteLength) {
          throw new SandboxError('INVALID_REQUEST')
        }
        indices.add(source.index)
        total += source.bytes.byteLength
      }
      if (total > 32 * 1024 * 1024) throw new SandboxError('INPUT_LIMIT')
      if (signal?.aborted) throw new SandboxError('ABORTED')
      // Source snapshots also wait for native admission. Only one refresh may
      // hold these extra captured bytes across the normal worker queue.
      if (refreshing) throw Object.assign(new SandboxError('SANDBOX_BUSY'), {statusCode:429,retryAfter:1})
      refreshing = true
      try {
        const captured = sources.map(({index, bytes}) => ({index, bytes: Buffer.from(bytes)}))
        return await native.run(input, async io => {
          const bindings: {index: number; part: string}[] = []
          for (const {index, bytes} of captured) {
            const path = await io.writePart(bytes)
            bindings.push({index, part: path.slice('/work/'.length)})
          }
          return io.request('refresh_bound_external_links', {path:'/work/input.xlsx', sources:bindings})
        }, {signal})
      } finally {
        refreshing = false
      }
    },
    readMedia(input: Uint8Array,visualId:string,signal?:AbortSignal) {
      if(typeof visualId!=='string'||visualId.length<1||visualId.length>512||visualId.includes('/')||visualId.includes('\\'))return Promise.reject(new SandboxError('INPUT_LIMIT'))
      return native.run(input,async io=>{
        const source=opened(await io.request('open',{path:'/work/input.xlsx',locale:'en'}))
        try {return await io.request('read_media',{sessionId:source.sessionId,visualId})}
        finally {await io.request('close',{sessionId:source.sessionId})}
      },{signal})
    },
    recalculate(input: Uint8Array, request: RecalcInput, signal?: AbortSignal) {
      const coordinate=(n:number,max:number)=>Number.isInteger(n)&&n>=0&&n<max
      const named=(name:string)=>typeof name==='string'&&name.length>0&&name.length<=255
      let count=0
      if (!request || !Array.isArray(request.edits) || !Array.isArray(request.reads) || request.edits.length>10000 || request.reads.length>200 || request.edits.some(e=>!named(e.sheetName)||!coordinate(e.row,1048576)||!coordinate(e.column,16384)||typeof e.input!=='string'||e.input.length>32767) || request.reads.some(r=>{
        const a=r.range
        if(!named(r.sheetName)||!a||!coordinate(a.startRow,1048576)||!coordinate(a.endRow,1048576)||!coordinate(a.startColumn,16384)||!coordinate(a.endColumn,16384)||a.endRow<a.startRow||a.endColumn<a.startColumn)return true
        count+=(a.endRow-a.startRow+1)*(a.endColumn-a.startColumn+1)
        return count>20000
      })) return Promise.reject(new SandboxError('INPUT_LIMIT'))
      // Snapshot caller-owned containers before native admission can queue.
      request = {edits: request.edits.map(e=>({...e})), reads: request.reads.map(r=>({...r,range:{...r.range}}))}
      return native.run(input,async io=>{
        const source=opened(await io.request('open',{path:'/work/input.xlsx',locale:'en'}))
        try {
          const names=new Set(source.sheets.map(s=>s.name))
          if([...request.edits,...request.reads].some(e=>!names.has(e.sheetName)))throw new SandboxError('UNKNOWN_SHEET')
          return await io.request('recalc_cells',{path:'/work/input.xlsx',edits:request.edits.map(({sheetName,...e})=>({sheet:sheetName,...e})),reads:request.reads.map(({sheetName,range})=>({sheet:sheetName,range}))}) as {cells:{sheet:string;row:number;column:number;formatted:string;number?:number;isError?:boolean;isFormula:boolean}[]}
        } finally {await io.request('close',{sessionId:source.sessionId})}
      },{signal})
    },
    inspect(input:Uint8Array,signal?:AbortSignal){
      return native.run(input,async io=>{
        const result=await io.request('open',{path:'/work/input.xlsx',locale:'en'}) as Record<string,unknown>
        const source=opened(result)
        await io.request('close',{sessionId:source.sessionId})
        const {sessionId: _session,path: _path,...metadata}=result
        return {...metadata,sheets:source.sheets}
      },{signal})
    },
    readSheet(input: Uint8Array, sheetName: string, kind: 'formulas' | 'outline', signal?: AbortSignal) {
      if (kind !== 'formulas' && kind !== 'outline') return Promise.reject(new SandboxError('UNSUPPORTED_COMMAND'))
      return native.run(input, async io => {
        const source = opened(await io.request('open', {path: '/work/input.xlsx', locale: 'en'}))
        try {
          const sheet = source.sheets.find(sheet => sheet.name === sheetName)
          if (!sheet) throw new SandboxError('UNKNOWN_SHEET')
          await waitForSheet(io, source.sessionId, sheet.id, signal)
          return await io.request(kind === 'formulas' ? 'read_formula_cells' : 'read_row_outline', {sessionId: source.sessionId, sheetId: sheet.id})
        } finally { await io.request('close', {sessionId: source.sessionId}) }
      }, {signal})
    },
    findCells(input:Uint8Array,sheetName:string,request:FindInput,signal?:AbortSignal){
      const {resumeAt,...options}=request
      return native.run(input,async io=>{
        const source=opened(await io.request('open',{path:'/work/input.xlsx',locale:'en'}))
        try{
          const sheet=source.sheets.find(sheet=>sheet.name===sheetName)
          if(!sheet)throw new SandboxError('UNKNOWN_SHEET')
          await waitForSheet(io,source.sessionId,sheet.id,signal)
          return await io.request('find_cells',{...options,sessionId:source.sessionId,sheetId:sheet.id,...(resumeAt?{resumeAt:{...resumeAt,sheetId:sheet.id}}:{})})
        }finally{await io.request('close',{sessionId:source.sessionId})}
      },{signal})
    },
    readRange(input:Uint8Array,sheetName:string,range:{startRow:number;endRow:number;startColumn:number;endColumn:number},signal?:AbortSignal){
      if(!range||Object.keys(range).sort().join(',')!=='endColumn,endRow,startColumn,startRow'||Object.values(range).some(value=>!Number.isInteger(value)||value<0)||range.endRow<range.startRow||range.endColumn<range.startColumn||range.endRow>=1048576||range.endColumn>=16384||(range.endRow-range.startRow+1)*(range.endColumn-range.startColumn+1)>20000)return Promise.reject(new SandboxError('INPUT_LIMIT'))
      range={...range}
      return native.run(input,async io=>{
        const source=opened(await io.request('open',{path:'/work/input.xlsx',locale:'en'}))
        try{
          const sheet=source.sheets.find(sheet=>sheet.name===sheetName)
          if(!sheet)throw new SandboxError('UNKNOWN_SHEET')
          await waitForSheet(io, source.sessionId, sheet.id, signal)
          return await io.request('read_range',{sessionId:source.sessionId,sheetId:sheet.id,range})
        }finally{await io.request('close',{sessionId:source.sessionId})}
      },{signal})
    },
    savePlan(input: Uint8Array,plan: XlsxMutationPlan,signal?: AbortSignal) {
      return native.run(input,async io=>{
        const validName=(name:string)=>typeof name==='string'&&name.length>0&&name.length<=1024&&!name.startsWith('/')&&!name.includes('\\')&&!name.split('/').some(part=>part==='..'||part==='.'||part==='')
        const replacementNames=[...plan.replaced.keys()],additionNames=[...plan.added.keys(),...plan.addedBinary.keys()],removed=[...plan.removedEntries]
        const names=[...replacementNames,...additionNames,...removed]
        if(names.length>256||names.some(name=>!validName(name))||new Set(names).size!==names.length)throw new SandboxError('INVALID_PLAN')
        const replacements: {name:string;contentPath:string}[]=[],additions: {name:string;contentPath:string}[]=[]
        for(const [name,content] of plan.replaced)replacements.push({name,contentPath:await io.writePart(Buffer.from(content))})
        for(const [name,content] of plan.added)additions.push({name,contentPath:await io.writePart(Buffer.from(content))})
        for(const [name,content] of plan.addedBinary)additions.push({name,contentPath:await io.writePart(content)})
        const result=await io.request('save_archive',{sourcePath:'/work/input.xlsx',targetPath:'/work/output.xlsx',replacements,removals:removed,additions}) as {beforeEntries:{name:string;crc32:number;uncompressedSize:number}[];afterEntries:{name:string;crc32:number;uncompressedSize:number}[]}
        if(!Array.isArray(result?.beforeEntries)||!Array.isArray(result?.afterEntries))throw new SandboxError('INVALID_PROTOCOL')
        const before=new Map(result.beforeEntries.map(entry=>[entry.name,entry])),after=new Map(result.afterEntries.map(entry=>[entry.name,entry]))
        const expected=new Set([...before.keys()].filter(name=>!removed.includes(name)).concat(additionNames))
        if(expected.size!==after.size||[...expected].some(name=>!after.has(name)))throw new SandboxError('INVALID_OUTPUT')
        for(const [name,entry] of before){if(replacementNames.includes(name)||removed.includes(name))continue;const saved=after.get(name);if(!saved||saved.crc32!==entry.crc32||saved.uncompressedSize!==entry.uncompressedSize)throw new SandboxError('INVALID_OUTPUT')}
        const saved=opened(await io.request('open',{path:'/work/output.xlsx',locale:'en'}))
        const bytes=await io.readOutput();await io.request('close',{sessionId:saved.sessionId})
        return {bytes,sheetCount:saved.sheets.length}
      },{signal})
    },
    roundtrip(input: Uint8Array,signal?: AbortSignal) {
      return native.run(input,async io => {
        const source = opened(await io.request('open',{ path: '/work/input.xlsx',locale: 'en' }))
        await io.request('save_archive',{ sourcePath: '/work/input.xlsx',targetPath: '/work/output.xlsx',replacements: [],removals: [],additions: [] })
        const saved = opened(await io.request('open',{ path: '/work/output.xlsx',locale: 'en' }))
        if (source.sheets.length!==saved.sheets.length || source.sheets.some((sheet,i) => sheet.name!==saved.sheets[i].name)) throw new SandboxError('INVALID_OUTPUT')
        const output = await io.readOutput()
        for (const sessionId of [source.sessionId,saved.sessionId]) await io.request('close',{ sessionId })
        return { bytes: output,sheetCount: saved.sheets.length }
      },{ signal })
    },
  }
}
