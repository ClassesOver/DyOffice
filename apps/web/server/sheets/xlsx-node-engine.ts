import { open, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'
import {XMLParser} from 'fast-xml-parser'
import {parseSheetElements,parseRelationships,readAttribute,decodeAttribute} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets.ts'
import {relsPathFor,resolveRelTarget} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add.ts'
import {parseRef} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-table-add.ts'
import {resolvedStyleEntries} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-style-entries.ts'
import {parseSheetProtectionAttributes} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-protection.ts'
import {pivotBandMetadata,pivotTheme} from './pivot-band-metadata'
import type {WorkbookCellStyle,WorkbookFile,WorkbookRangeResult} from '../../../sheets/src/shared/desktop-api.ts'
import { readBasicWorkbook } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway.ts'

// Isolated Node fallback sidecar for XLSX when the Rust xlsx-sidecar binary is not compiled.
// Executed inside createCrossPlatformProcess with SHA-256 verification, 2-slot concurrency,
// 32 MiB input/output caps, and a 30s wall-clock kill timeout.
const MAX = 32 * 1024 * 1024
const workDir = process.env.DYOFFICE_WORK_DIR || '/work'
const resolveWorkPath = (logicalPath: string) =>
  workDir === '/work' || !logicalPath.startsWith('/work/')
    ? logicalPath
    : `${workDir}/${logicalPath.slice('/work/'.length)}`

interface ParsedCell {
  row: number
  column: number
  value: string | number | boolean | null
  styleIndex?: number
  formula?: string
}

type SheetMetadata=Pick<WorkbookRangeResult,'sheetProtection'|'protectedRanges'|'autoFilter'|'autoFilterColumns'>
type FilterColumn=WorkbookRangeResult['autoFilterColumns'][number]
const EMPTY_SHEET_METADATA:SheetMetadata={sheetProtection:null,protectedRanges:[],autoFilter:null,autoFilterColumns:[]}

interface ParsedSheet extends SheetMetadata {
  id: string
  name: string
  cells: ParsedCell[]
  rowCount: number
  columnCount: number
  valueCellCount: number
  valueRowCount: number
  valueColumnCount: number
}

const sessions = new Map<string, { sheets: ParsedSheet[]; zip: JSZip }>()

const star=Symbol('star'),one=Symbol('one')
function matchFindText(query:string,matchCase:boolean,whole:boolean,wildcards:boolean){
  const fold=(text:string)=>matchCase?text:text.toLowerCase()
  const needle=fold(query.trim())
  if(!needle)throw new Error('INVALID_FIND_QUERY')
  if(!wildcards)return (text:string)=>whole?fold(text).replace(/^ +| +$/g,'')===needle:fold(text).includes(needle)
  const chars=Array.from(needle),tokens: (string|typeof star|typeof one)[]=[]
  for(let i=0;i<chars.length;i++){
    const ch=chars[i]!
    if(ch==='~')tokens.push(chars[i+1]===undefined?'~':chars[++i]!)
    else if(ch==='*'){if(tokens.at(-1)!==star)tokens.push(star)}
    else tokens.push(ch==='?'?one:ch)
  }
  if(!whole){if(tokens[0]!==star)tokens.unshift(star);if(tokens.at(-1)!==star)tokens.push(star)}
  return (text:string)=>{
    const input=Array.from(fold(whole?text.replace(/^ +| +$/g,''):text))
    let i=0,j=0,backtrack=-1,start=0
    while(i<input.length){
      const token=tokens[j]
      if(token===star){backtrack=j++;start=i}
      else if(token===one||token===input[i]){i++;j++}
      else if(backtrack!==-1){j=backtrack+1;i=++start}
      else return false
    }
    while(tokens[j]===star)j++
    return j===tokens.length
  }
}

type ZipText=(path:string)=>Promise<string>
type XmlElement={ [name: `@_${string}`]: string|undefined }
const metadataXml=new XMLParser({
  ignoreAttributes:false,removeNSPrefix:true,processEntities:false,parseTagValue:false,trimValues:false,
  stopNodes:['*.sheetData'],isArray:(_name,path)=>[
    'worksheet.protectedRanges.protectedRange','worksheet.autoFilter','worksheet.autoFilter.filterColumn',
    'worksheet.autoFilter.filterColumn.filters.filter','worksheet.autoFilter.filterColumn.customFilters.customFilter',
  ].includes(path),
})
const attribute=(element:XmlElement|undefined,name:string)=>{
  const value=element?.['@_'+name]
  return value===undefined?undefined:decodeAttribute(value)
}
const enabled=(value:string|undefined)=>value==='1'||value==='true'
const disabled=(value:string|undefined)=>value==='0'||value==='false'

function readWorkbookProtection(xml:string):WorkbookFile['workbookProtection']{
  if(!xml.includes('workbookProtection'))return undefined
  const element=metadataXml.parse(xml).workbook?.workbookProtection
  if(element===undefined)return undefined
  return {lockStructure:enabled(attribute(element,'lockStructure')),
    hasPassword:attribute(element,'workbookPassword')!==undefined||attribute(element,'workbookHashValue')!==undefined}
}

const filterOperators=['notEqual','greaterThan','greaterThanOrEqual','lessThan','lessThanOrEqual'] as const

function readWorksheetMetadata(xml:string):SheetMetadata{
  if(!xml.includes('sheetProtection')&&!xml.includes('protectedRanges')&&!xml.includes('autoFilter'))return EMPTY_SHEET_METADATA
  const worksheet=metadataXml.parse(xml).worksheet
  const element=worksheet?.sheetProtection
  const parsed=element===undefined?null:parseSheetProtectionAttributes(name=>attribute(element,name))
  const protectedRanges:SheetMetadata['protectedRanges']=[]
  for(const range of worksheet?.protectedRanges?.protectedRange??[]){
    const name=attribute(range,'name'),sqref=attribute(range,'sqref')
    if(name===undefined||sqref===undefined)continue
    protectedRanges.push({name,sqref,hasPassword:attribute(range,'password')!==undefined||attribute(range,'hashValue')!==undefined||
      attribute(range,'securityDescriptor')!==undefined||range.securityDescriptor!==undefined})
  }
  const sheetProtection=parsed&&{
    protected:parsed.protected,allow:parsed.allow,hasPassword:parsed.password!==null,
    ...(parsed.password?{password:parsed.password}:{}),
  }
  return {sheetProtection,protectedRanges,...readAutoFilter(worksheet?.autoFilter?.[0])}
}

type AutoFilterXml=XmlElement & {filterColumn?:Array<XmlElement & {
  filters?:XmlElement & {filter?:XmlElement[]}
  customFilters?:XmlElement & {customFilter?:XmlElement[]}
}>}

function readAutoFilter(element:AutoFilterXml|undefined):Pick<SheetMetadata,'autoFilter'|'autoFilterColumns'> {
  const ref=attribute(element,'ref')
  let autoFilter:SheetMetadata['autoFilter']=null
  if(ref&&/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/i.test(ref)){
    const area=parseRef(ref.toUpperCase())
    if(area.startRow<=area.endRow&&area.endRow<1_048_576&&area.startColumn<=area.endColumn&&area.endColumn<16_384)autoFilter=area
  }
  const autoFilterColumns:FilterColumn[]=[]
  if(autoFilter)for(const column of element?.filterColumn??[]){
    const id=attribute(column,'colId')
    if(id===undefined||!/^\d+$/.test(id))continue
    const colId=Number(id)
    if(colId>autoFilter.endColumn-autoFilter.startColumn)continue
    const filters=column.filters
    const custom=column.customFilters
    const values=filters?.filter?.flatMap(filter=>{
      const val=attribute(filter,'val')
      return val!==undefined&&val.length<=32_767?[val]:[]
    }).slice(0,10_000)
    const comparisonInputs=custom?.customFilter?.flatMap(filter=>{
      const val=attribute(filter,'val')
      return val===undefined?[]:[{val,name:attribute(filter,'operator')}]
    }).slice(0,2)
    const comparisons=comparisonInputs?.map(({val,name})=>({val,name,operator:filterOperators.find(item=>item===name)}))
    const validComparisons=comparisons?.length&&comparisons.every(({val,name,operator})=>
      val.length<=32_767&&(name===undefined||name==='equal'||operator!==undefined))
      ?comparisons.map(({val,operator})=>({val,...(operator?{operator}:{})})):undefined
    if(filters===undefined&&!validComparisons)continue
    autoFilterColumns.push({colId,...(filters!==undefined?{values:values??[],...(enabled(attribute(filters,'blank'))?{blank:true}:{})}:{}),
      ...(validComparisons?{customs:{filters:validComparisons,...(enabled(attribute(custom,'and'))?{and:true}:{})}}:{})})
    if(autoFilterColumns.length===1_000)break
  }
  return {autoFilter,autoFilterColumns}
}

/** Inflates each part at most once per command; the readers below share workbook.xml and its rels. */
function zipText(zip:JSZip):ZipText{
  const cache=new Map<string,Promise<string>>()
  return path=>{let text=cache.get(path);if(!text){text=zip.file(path)?.async('string').then(value=>value??'')??Promise.resolve('');cache.set(path,text)}return text}
}

async function readPivotMetadata(text:ZipText){
  const workbookPath='xl/workbook.xml',theme=pivotTheme(await text('xl/theme/theme1.xml'))
  const workbookRels=parseRelationships(await text(relsPathFor(workbookPath)))
  const result=new Map<string,Pick<WorkbookFile['sheets'][number],'pivotTables'|'pivotRanges'>>()
  for(const sheet of parseSheetElements(await text(workbookPath))){
    const rel=workbookRels.find(rel=>rel.id===sheet.relationshipId&&!rel.external&&rel.type.endsWith('/worksheet'))
    if(!rel)continue
    const sheetPath=resolveRelTarget(workbookPath,rel.target)
    const pivotTables:WorkbookFile['sheets'][number]['pivotTables']=[]
    for(const pivotRel of parseRelationships(await text(relsPathFor(sheetPath)))){
      if(pivotRel.external||!pivotRel.type.endsWith('/pivotTable'))continue
      const path=resolveRelTarget(sheetPath,pivotRel.target),xml=await text(path)
      const location=/<(?:[\w.-]+:)?location\b[^>]*>/.exec(xml)?.[0]
      const outputRef=location&&readAttribute(location,'ref')
      if(!outputRef)continue
      const cacheRel=parseRelationships(await text(relsPathFor(path))).find(rel=>!rel.external&&rel.type.endsWith('/pivotCacheDefinition'))
      pivotTables.push({...pivotBandMetadata(xml,theme),path,cachePath:cacheRel?resolveRelTarget(path,cacheRel.target):null,outputRef:decodeAttribute(outputRef),firstDataRow:Number(readAttribute(location,'firstDataRow')??1),firstDataCol:Number(readAttribute(location,'firstDataCol')??1)})
    }
    result.set(sheet.name,{pivotTables,pivotRanges:pivotTables.map(pivot=>parseRef(pivot.outputRef))})
  }
  return result
}

const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'mm-dd-yy', 15: 'd-mmm-yy',
  16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm',
  21: 'h:mm:ss', 22: 'm/d/yy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
}

async function readWorkbookStyles(text: ZipText) {
  const xml = await text('xl/styles.xml')
  const section = (name: string) => new RegExp(`<(?:(?:\\w+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${name}\\s*>`).exec(xml)?.[1] ?? ''
  const formats = new Map<number, string>()
  for (const id of Object.keys(BUILTIN_NUMBER_FORMATS)) formats.set(Number(id), BUILTIN_NUMBER_FORMATS[Number(id)]!)
  for (const entry of resolvedStyleEntries(section('numFmts'), 'numFmt')) {
    const id = Number(readAttribute(entry, 'numFmtId'))
    const code = readAttribute(entry, 'formatCode')
    if (Number.isInteger(id) && code !== null) formats.set(id, decodeAttribute(code))
  }
  const hasStyleProtection=xml.includes('protection')
  const namedProtection=hasStyleProtection?resolvedStyleEntries(section('cellStyleXfs'),'xf')
    .map(entry=>metadataXml.parse(entry).xf?.protection):[]
  const styles=resolvedStyleEntries(section('cellXfs'), 'xf').map(entry => {
    const id = Number(readAttribute(entry, 'numFmtId') ?? 0)
    const xf=hasStyleProtection?metadataXml.parse(entry).xf:undefined
    const protection=enabled(attribute(xf,'applyProtection'))?xf?.protection:namedProtection[Number(attribute(xf,'xfId')??0)]
    const style: WorkbookCellStyle = {
      bold: false, italic: false, underline: false, strikethrough: false,
      wrapText: false, diagonalUp: false, diagonalDown: false,
    }
    const format = formats.get(id)
    if (format !== undefined) style.numberFormat = format
    if(disabled(attribute(protection,'locked')))style.locked=false
    if(enabled(attribute(protection,'hidden')))style.hidden=true
    return style
  })
  if(styles[0]?.locked===false)for(const style of styles.slice(1))style.locked??=true
  return styles
}

async function readSheetMetadata(text: ZipText) {
  const workbookPath = 'xl/workbook.xml'
  const workbookRels = parseRelationships(await text(relsPathFor(workbookPath)))
  const sheets = new Map<string, SheetMetadata & {styleIndexes:Map<string,number>}>()
  for (const sheet of parseSheetElements(await text(workbookPath))) {
    const rel = workbookRels.find(item => item.id === sheet.relationshipId && !item.external && item.type.endsWith('/worksheet'))
    if (!rel) continue
    const path = resolveRelTarget(workbookPath, rel.target)
    const xml = await text(path)
    const cells = new Map<string, number>()
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>/g)) {
      const attrs = match[1]!
      const style = /(?:^|\s)s="(\d+)"/.exec(attrs)?.[1]
      if (style === undefined) continue
      const address = /(?:^|\s)r="([^"]*)"/.exec(attrs)?.[1]
      if (address) cells.set(decodeAttribute(address), Number(style))
    }
    sheets.set(sheet.name,{styleIndexes:cells,...readWorksheetMetadata(xml)})
  }
  return sheets
}


function parseA1(address: string): { row: number; column: number } | null {
  const match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(address)
  if (!match) return null
  let col = 0
  for (const ch of match[1]!) col = col * 26 + (ch.charCodeAt(0) - 64)
  const row = Number(match[2]!)
  return row <= 1048576 && col <= 16384 ? { row: row - 1, column: col - 1 } : null
}

async function readBounded(path: string, max: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new Error('INVALID_INPUT')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const part = await file.read(bytes, length, bytes.length - length, null)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (length !== stat.size) throw new Error('INVALID_INPUT')
    return bytes.subarray(0, length)
  } finally {
    await file.close()
  }
}

async function entryDigests(zip: JSZip) {
  const entries: { name: string; crc32: number; uncompressedSize: number }[] = []
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue
    const buf = await file.async('nodebuffer')
    entries.push({ name, crc32: crc32(buf) >>> 0, uncompressedSize: buf.byteLength })
  }
  return entries
}

type Bounds = {startRow: number; endRow: number; startColumn: number; endColumn: number}
function readRange(sheet: ParsedSheet,r: Bounds) {
  const cells = sheet.cells.filter(
    c => c.row >= r.startRow && c.row <= r.endRow && c.column >= r.startColumn && c.column <= r.endColumn,
  )
  return {
    cells,
    rows: [],
    merges: [],
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: sheet.autoFilter,
    autoFilterColumns: sheet.autoFilterColumns,
    dataValidations: [],
    sheetProtection: sheet.sheetProtection,
    rowBreaks: [],
    colBreaks: [],
    pageSetup: null,
    protectedRanges: sheet.protectedRanges,
    indexedThroughRow: sheet.rowCount-1,
    indexingComplete: true,
  }
}

// The fallback viewport is 80 rows × 26 columns with an 80-row / 8-column buffer.
// Keep the optional first read small even when many cells reference one large shared string.
function openingViewport(sheet: ParsedSheet) {
  const endRow=Math.min(159,sheet.rowCount-1),endColumn=Math.min(33,sheet.columnCount-1)
  const result=readRange(sheet,{startRow:0,endRow,startColumn:0,endColumn})
  const limit=256*1024
  let chars=0
  for(const cell of result.cells){
    chars+=(typeof cell.value==='string'?cell.value.length:0)+(cell.formula?.length??0)
    if(chars>limit)return undefined
  }
  if(Buffer.byteLength(JSON.stringify(result))>limit)return undefined
  return {sheetId:sheet.id,endRow,endColumn,result}
}

async function handleCommand(packet: Record<string, unknown>): Promise<unknown> {
  const cmd = String(packet.command ?? '')
  if (cmd === 'open') {
    const path = String(packet.path ?? '/work/input.xlsx')
    if (path === '/work/input.xlsx' && packet.locale === undefined) {
      // Startup health check probe from configuredSheetsRuntime ('sheets-startup').
      return { sessionId: randomUUID(), sheets: [{ id: 'sheet-1', name: 'Sheet1' }] }
    }
    const bytes = await readBounded(resolveWorkPath(path), MAX)
    const zip = await JSZip.loadAsync(bytes)
    const text = zipText(zip)
    const [imported, pivots, styles, metadata, workbookXml] = await Promise.all([
      readBasicWorkbook(bytes, { includeFormulaCache: true }),
      readPivotMetadata(text), readWorkbookStyles(text), readSheetMetadata(text),text('xl/workbook.xml'),
    ])
    let entryCount = 0
    for (const file of Object.values(zip.files)) if (!file.dir) entryCount++
    const parsedSheets: ParsedSheet[] = imported.snapshot.sheets.map(s => {
      const sheetMetadata=metadata.get(s.name)
      const cells: ParsedCell[] = []
      let rowCount=1,columnCount=1,valueCellCount=0,valueRowCount=0,valueColumnCount=0
      for (const [addr, cell] of Object.entries(s.cells)) {
        const pos = parseA1(addr)
        if (!pos) continue
        const value = cell.rawValue !== undefined ? cell.rawValue : cell.value
        rowCount=Math.max(rowCount,pos.row+1)
        columnCount=Math.max(columnCount,pos.column+1)
        if(value!==null||cell.formula){
          valueCellCount++
          valueRowCount=Math.max(valueRowCount,pos.row+1)
          valueColumnCount=Math.max(valueColumnCount,pos.column+1)
        }
        const styleIndex=sheetMetadata?.styleIndexes.get(addr)
        cells.push({
          row: pos.row,
          column: pos.column,
          value,
          ...(styleIndex === undefined ? {} : { styleIndex }),
          ...(cell.formula ? { formula: cell.formula } : {}),
        })
      }
      for(const area of pivots.get(s.name)?.pivotRanges??[]){
        rowCount=Math.max(rowCount,area.endRow+1)
        columnCount=Math.max(columnCount,area.endColumn+1)
      }
      cells.sort((a,b)=>a.row-b.row||a.column-b.column)
      return { id: s.id, name: s.name, cells, rowCount, columnCount, valueCellCount, valueRowCount, valueColumnCount,
        sheetProtection:sheetMetadata?.sheetProtection??null,protectedRanges:sheetMetadata?.protectedRanges??[],
        autoFilter:sheetMetadata?.autoFilter??null,autoFilterColumns:sheetMetadata?.autoFilterColumns??[] }
    })
    const sessionId = randomUUID()
    sessions.set(sessionId, { sheets: parsedSheets, zip })
    const workbookProtection=readWorkbookProtection(workbookXml)
    const inspection = {
      sessionId,
      entryCount,
      sheets: parsedSheets.map(s => ({
        id: s.id,
        name: s.name,
        rowCount:s.rowCount,
        columnCount:s.columnCount,
        storedCellCount:s.cells.length,
        valueCellCount:s.valueCellCount,
        valueRowCount:s.valueRowCount,
        valueColumnCount:s.valueColumnCount,
        columnWidths: [],
        defaultRowHeight: null,
        defaultColumnWidth: null,
        freeze: null,
        hidden: false,
        tabColor: null,
        showGridLines: true,
        tables: [],
        comments: [],
        pivotRanges: pivots.get(s.name)?.pivotRanges ?? [],
        pivotTables: pivots.get(s.name)?.pivotTables ?? [],
        sparklines: [],
        cellImages: [],
      })),
      activeTab: 0,
      styles,
      dxfStyles: [],
      visuals: [],
      definedNames: [],
      ...(workbookProtection?{workbookProtection}:{}),
    }
    if(packet.openingViewport===true&&Buffer.byteLength(JSON.stringify(inspection))<=256*1024){
      return {...inspection,openingViewport:openingViewport(parsedSheets[inspection.activeTab]!)}
    }
    return inspection
  }
  if (cmd === 'close') {
    sessions.delete(String(packet.sessionId ?? ''))
    return { closed: true }
  }
  if (cmd === 'read_range') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const sheet = session?.sheets.find(s => s.id === packet.sheetId)
    if (!sheet) throw new Error('UNKNOWN_SHEET')
    const r = (packet.range ?? { startRow: 0, endRow: 0, startColumn: 0, endColumn: 0 }) as {
      startRow: number
      endRow: number
      startColumn: number
      endColumn: number
    }
    return readRange(sheet,r)
  }
  if (cmd === 'find_cells') {
    const sheet=sessions.get(String(packet.sessionId??''))?.sheets.find(s=>s.id===packet.sheetId)
    if(!sheet)throw new Error('UNKNOWN_SHEET')
    const start=packet.resumeAt as {row:number;column:number}|undefined
    const matches=[],limit=Number(packet.limit),deadline=Date.now()+8000
    const match=matchFindText(String(packet.query),packet.matchCase===true,packet.matchEntireCell===true,packet.wildcards===true)
    for(const {row,column,value,formula} of sheet.cells){
      if(start&&(row<start.row||row===start.row&&column<start.column))continue
      const cursor={sheetId:sheet.id,row,column}
      if(Date.now()>=deadline)return {matches,complete:false,nextCursor:cursor,indexingComplete:true}
      const valueText=value===null?null:typeof value==='boolean'?(value?'1':'0'):String(value)
      const values=()=>valueText!==null&&match(valueText)
      const formulas=()=>formula!==undefined&&match(formula)
      const hit=packet.lookIn==='values'?values():packet.lookIn==='formulas_only'?formulas():packet.lookIn==='formulas'?(formula===undefined?values():formulas()):values()||formulas()
      if(!hit)continue
      if(matches.length>=limit)return {matches,complete:false,nextCursor:cursor,indexingComplete:true}
      matches.push({...cursor,value,valueText,...(formula===undefined?{}:{formulaText:formula})})
    }
    return {matches,complete:true,indexingComplete:true}
  }
  if (cmd === 'read_formula_cells') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const sheet = session?.sheets.find(s => s.id === packet.sheetId)
    if (!sheet) throw new Error('UNKNOWN_SHEET')
    return {
      cells: sheet.cells.filter(c => Boolean(c.formula)),
      sharedGroups: [],
      indexingComplete: true,
      truncated: false,
    }
  }
  if (cmd === 'read_row_outline') {
    return { rows: [], indexingComplete: true }
  }
  if (cmd === 'read_media') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const visualId = String(packet.visualId ?? '')
    const file = session?.zip.file(`xl/media/${visualId}`) ?? null
    if (!file) throw new Error('MEDIA_NOT_FOUND')
    const bytes = await file.async('nodebuffer')
    const ext = visualId.split('.').pop()?.toLowerCase() ?? 'png'
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png'
    return { mimeType, dataBase64: bytes.toString('base64') }
  }
  if (cmd === 'recalc_cells') {
    const reads = (packet.reads ?? []) as {
      sheet: string
      range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
    }[]
    const out: {
      sheet: string
      row: number
      column: number
      formatted: string
      number?: number
      isError?: boolean
      isFormula: boolean
    }[] = []
    for (const session of sessions.values()) {
      for (const read of reads) {
        const sheet = session.sheets.find(s => s.name === read.sheet)
        if (!sheet) continue
        for (const c of sheet.cells) {
          if (
            c.row >= read.range.startRow &&
            c.row <= read.range.endRow &&
            c.column >= read.range.startColumn &&
            c.column <= read.range.endColumn
          ) {
            out.push({
              sheet: sheet.name,
              row: c.row,
              column: c.column,
              formatted: c.value === null ? '' : String(c.value),
              ...(typeof c.value === 'number' ? { number: c.value } : {}),
              isFormula: Boolean(c.formula),
            })
          }
        }
      }
    }
    return { cells: out }
  }
  if (cmd === 'save_archive') {
    const sourcePath = resolveWorkPath(String(packet.sourcePath ?? '/work/input.xlsx'))
    const targetPath = resolveWorkPath(String(packet.targetPath ?? '/work/output.xlsx'))
    const sourceBytes = await readBounded(sourcePath, MAX)
    const beforeZip = await JSZip.loadAsync(sourceBytes)
    const beforeEntries = await entryDigests(beforeZip)
    const removals = (packet.removals ?? []) as string[]
    const replacements = (packet.replacements ?? []) as { name: string; contentPath: string }[]
    const additions = (packet.additions ?? []) as { name: string; contentPath: string }[]
    for (const name of removals) beforeZip.remove(name)
    for (const item of [...replacements, ...additions]) {
      const partBytes = await readBounded(resolveWorkPath(item.contentPath), MAX)
      beforeZip.file(item.name, partBytes, { createFolders: false })
    }
    const outputBytes = await beforeZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    if (outputBytes.byteLength < 1 || outputBytes.byteLength > MAX) throw new Error('OUTPUT_LIMIT')
    await writeFile(targetPath, outputBytes, { flag: 'wx', mode: 0o600 })
    const afterZip = await JSZip.loadAsync(outputBytes)
    const afterEntries = await entryDigests(afterZip)
    return { beforeEntries, afterEntries }
  }
  throw new Error('UNSUPPORTED_COMMAND')
}

let pending = Buffer.alloc(0)
let total = 0
for await (const chunk of process.stdin) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  total += bytes.length
  if (total > 4 * 1024 * 1024) {
    process.exitCode = 1
    break
  }
  pending = Buffer.concat([pending, bytes])
  for (;;) {
    const end = pending.indexOf(10)
    if (end < 0) break
    const line = pending.subarray(0, end)
    pending = pending.subarray(end + 1)
    let requestId = ''
    try {
      const packet = JSON.parse(line.toString('utf8')) as Record<string, unknown>
      requestId = typeof packet.requestId === 'string' ? packet.requestId : ''
      if (packet.version !== 1 || !requestId) throw new Error('INVALID_PROTOCOL')
      const result = await handleCommand(packet)
      process.stdout.write(JSON.stringify({ version: 1, requestId, ok: true, result }) + '\n')
    } catch {
      process.stdout.write(JSON.stringify({ version: 1, requestId, ok: false, error: 'NATIVE_FAILED' }) + '\n')
    }
  }
}
