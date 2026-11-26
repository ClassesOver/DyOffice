import { open, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'
import {XMLParser,type X2jOptions} from 'fast-xml-parser'
import {readWorksheetValidations} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-dv.ts'
import {parseSheetElements,parseRelationships,readAttribute,decodeAttribute} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets.ts'
import {relsPathFor,resolveRelTarget} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add.ts'
import {parseRef} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-table-add.ts'
import {parseRange} from '../../../../packages/xlsx-gateway/src/domain/cell-address.ts'
import {childElements,resolvedStyleEntries} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-style-entries.ts'
import {parseSheetProtectionAttributes} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-protection.ts'
import {withoutFutureFunctionMarkers} from '../../../../packages/xlsx-gateway/src/gateway/future-functions.ts'
import {normalizeOoxmlPartPrefix} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-namespace.ts'
import {inferWorksheetAddresses} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-structure.ts'
import {readPivotPartMetadata,pivotTheme} from './pivot-band-metadata'
import {readNodeSheetComments} from './xlsx-node-comments'
import {readCustomTableStyles,readWorksheetTables,type TableDxf} from './xlsx-node-tables'
import {mixHexColors,readHeaderFooterPictures,readWorkbookVisuals,visualMediaType} from './xlsx-node-visuals'
import {cellImageKey,readCellImageSources,readSheetCellImages,readWorkbookImage} from './xlsx-node-cell-images'
import {applyTint} from '../../../sheets/src/renderer/table-styles'
import type {WorkbookCellStyle,WorkbookFile,WorkbookRangeResult,WorkbookSharedFormulaGroup} from '../../../sheets/src/shared/desktop-api.ts'
import { readWorkbookWithCellDetails } from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway.ts'
import type { WorkbookRichRun } from '../../../../packages/xlsx-gateway/src/shared/edit-schemas.ts'
import {MAX_GRID_COLUMNS,MAX_GRID_ROWS} from '../../../../packages/xlsx-gateway/src/shared/grid-bounds.ts'

// Isolated Node fallback sidecar for XLSX when the Rust xlsx-sidecar binary is not compiled.
// Executed inside createCrossPlatformProcess with SHA-256 verification, 2-slot concurrency,
// 32 MiB input/output caps, and a 30s wall-clock kill timeout.
const MAX = 32 * 1024 * 1024
const MAX_FORMULA_CELLS = 100_000
const MAX_HEADER_FOOTER_PICTURE_BYTES = 2 * 1024 * 1024
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
  arrayRef?: string
  rich?: WorkbookRichRun[]
}

type SheetViewMetadata=Pick<WorkbookFile['sheets'][number],'tabColor'|'showGridLines'|'showFormulas'|'showRowColHeaders'|'rightToLeft'|'zoomScale'|'outlineLevelRow'|'outlineLevelCol'|'outlineSummaryBelow'|'outlineSummaryRight'>
type SheetMetadata=Pick<WorkbookRangeResult,'sheetProtection'|'protectedRanges'|'autoFilter'|'autoFilterColumns'|'rows'|'merges'|'conditionalRules'|'hyperlinks'|'dataValidations'|'rowBreaks'|'colBreaks'|'pageSetup'>
  & Pick<WorkbookFile['sheets'][number],'columnWidths'|'defaultRowHeight'|'defaultColumnWidth'|'defaultRowHeightFixed'|'baseColumnWidth'|'freeze'|'comments'|'tables'|'sparklines'>
  & { view: SheetViewMetadata; dimension?: Bounds; rowExtent: number }
type FilterColumn=WorkbookRangeResult['autoFilterColumns'][number]
const EMPTY_SHEET_METADATA:SheetMetadata={sheetProtection:null,protectedRanges:[],autoFilter:null,autoFilterColumns:[],
  rows:[],merges:[],conditionalRules:[],hyperlinks:[],columnWidths:[],defaultRowHeight:null,defaultColumnWidth:null,freeze:null,
  dataValidations:[],rowBreaks:[],colBreaks:[],pageSetup:null,comments:[],tables:[],sparklines:[],rowExtent:0,view:{tabColor:null,showGridLines:true}}

interface ParsedSheet extends SheetMetadata {
  id: string
  name: string
  cells: ParsedCell[]
  formulaCells: ParsedCell[]
  sharedGroups: WorkbookSharedFormulaGroup[]
  cellImages: WorkbookFile['sheets'][number]['cellImages']
  rowCount: number
  columnCount: number
  storedCellCount: number
  valueCellCount: number
  valueRowCount: number
  valueColumnCount: number
}

const sessions = new Map<string, { sheets: ParsedSheet[]; mediaById: Map<string,string>; zip: JSZip }>()

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
const metadataXmlOptions:X2jOptions={
  ignoreAttributes:false,removeNSPrefix:true,processEntities:false,parseTagValue:false,trimValues:false,
  cdataPropName:'#cdata',
  // The basic workbook reader already imports cell values. Keep only row headers with layout here.
  stopNodes:['worksheet.sheetData.row'],
  isArray:(_name,path)=>typeof path==='string'&&[
    'Relationships.Relationship',
    'fill.gradientFill.stop','dxf.fill.gradientFill.stop',
    'worksheet.sheetData.row',
    'worksheet.cols.col','worksheet.mergeCells.mergeCell','worksheet.sheetViews.sheetView','worksheet.conditionalFormatting',
    'worksheet.conditionalFormatting.cfRule','worksheet.conditionalFormatting.cfRule.colorScale.cfvo',
    'worksheet.conditionalFormatting.cfRule.colorScale.color',
    'worksheet.conditionalFormatting.cfRule.formula','worksheet.conditionalFormatting.cfRule.dataBar.cfvo',
    'worksheet.conditionalFormatting.cfRule.dataBar.color','worksheet.conditionalFormatting.cfRule.iconSet.cfvo',
    'worksheet.conditionalFormatting.cfRule.extLst.ext',
    'worksheet.extLst.ext.conditionalFormattings.conditionalFormatting',
    'worksheet.extLst.ext.conditionalFormattings.conditionalFormatting.cfRule',
    'worksheet.extLst.ext.conditionalFormattings.conditionalFormatting.cfRule.dataBar.cfvo',
    'worksheet.hyperlinks.hyperlink',
    'worksheet.extLst.ext',
    'worksheet.extLst.ext.sparklineGroups.sparklineGroup',
    'worksheet.extLst.ext.sparklineGroups.sparklineGroup.sparklines.sparkline',
    'worksheet.rowBreaks.brk','worksheet.colBreaks.brk',
    'worksheet.protectedRanges.protectedRange','worksheet.autoFilter','worksheet.autoFilter.filterColumn',
    'worksheet.autoFilter.filterColumn.filters.filter','worksheet.autoFilter.filterColumn.customFilters.customFilter',
  ].includes(path),
}
const metadataXml=new XMLParser(metadataXmlOptions)
const attribute=(element:XmlElement|undefined,name:string)=>{
  const value=element?.[`@_${name}`]
  return value===undefined?undefined:decodeAttribute(value)
}
const enabled=(value:string|undefined)=>value==='1'||value==='true'
const disabled=(value:string|undefined)=>value==='0'||value==='false'

type OrderedXml = {':@'?:XmlElement;'#text'?:string;'#cdata'?:OrderedXml[];[name:string]:unknown}
const workbookMetadataXml=new XMLParser({
  ignoreAttributes:false,removeNSPrefix:true,processEntities:false,parseTagValue:false,trimValues:false,
  preserveOrder:true,cdataPropName:'#cdata',
})
function readWorkbookMetadata(xml:string,readableSheets:readonly {name:string}[]){
  const elements=(nodes:OrderedXml[],tag:string)=>nodes.flatMap(node=>
    Array.isArray(node[tag])?[{attrs:node[':@'],children:node[tag] as OrderedXml[]}]:[])
  const children=(nodes:OrderedXml[],tag:string)=>elements(nodes,tag)[0]?.children??[]
  const nonnegativeIndex=(raw:string|undefined)=>{
    const index=Number(raw)
    return raw!==undefined&&/^\d+$/.test(raw)&&Number.isSafeInteger(index)?index:undefined
  }
  const workbook=children(workbookMetadataXml.parse(xml),'workbook')
  const declarations=elements(children(workbook,'sheets'),'sheet').map(({attrs})=>({
    name:attribute(attrs,'name'),
    state:attribute(attrs,'state'),
  }))
  const visibility=new Map(declarations.flatMap(({name,state})=>name===undefined?[]:[[name,state]] as const))
  const readableIndexes=new Map(readableSheets.map(({name},index)=>[name,index]))
  const readableIndex=(declaredIndex:number)=>{
    const name=declarations[declaredIndex]?.name
    return name===undefined?undefined:readableIndexes.get(name)
  }
  let savedTab=0
  for(const {attrs} of elements(children(workbook,'bookViews'),'workbookView')){
    const activeTab=attribute(attrs,'activeTab')
    if(activeTab!==undefined)savedTab=nonnegativeIndex(activeTab)??0
  }
  const definedNames:WorkbookFile['definedNames']=[]
  const scopedSheets=new Set<number>()
  const printNames=new Map<number,Pick<WorkbookFile['sheets'][number],'printArea'|'printTitles'>>()
  for(const {attrs,children:body} of elements(children(workbook,'definedNames'),'definedName')){
    const name=attribute(attrs,'name')
    if(!name)continue
    const local=nonnegativeIndex(attribute(attrs,'localSheetId'))
    const sheetIndex=local===undefined?undefined:readableIndex(local)
    if(local!==undefined&&sheetIndex===undefined)continue
    if(sheetIndex!==undefined)scopedSheets.add(sheetIndex)
    const formula=body.map(node=>node['#cdata']?.[0]?.['#text']??decodeAttribute(node['#text']??'')).join('')
    if(!formula)continue
    if(name==='_xlnm.Print_Area'||name==='_xlnm.Print_Titles'){
      if(sheetIndex!==undefined&&formula.length<=2_000){
        const names=printNames.get(sheetIndex)??{}
        if(name==='_xlnm.Print_Area')names.printArea=formula
        else names.printTitles=formula
        printNames.set(sheetIndex,names)
      }
      continue
    }
    if(!name.startsWith('_xlnm')&&!enabled(attribute(attrs,'hidden'))){
      definedNames.push({name,formula:withoutFutureFunctionMarkers(formula),...(sheetIndex===undefined?{}:{sheetIndex})})
    }
  }
  const protection=elements(workbook,'workbookProtection')[0]
  const workbookProtection=protection&&{lockStructure:enabled(attribute(protection.attrs,'lockStructure')),
    hasPassword:attribute(protection.attrs,'workbookPassword')!==undefined||attribute(protection.attrs,'workbookHashValue')!==undefined}
  const date1904=enabled(attribute(elements(workbook,'workbookPr')[0]?.attrs,'date1904'))
  return {activeTab:readableIndex(savedTab)??0,visibility,definedNames,scopedSheets,printNames,workbookProtection,date1904}
}

const filterOperators=['notEqual','greaterThan','greaterThanOrEqual','lessThan','lessThanOrEqual'] as const

// OOXML is 1-based; the desktop protocol uses inclusive, 0-based areas.
function sheetArea(ref:string|undefined){
  if(!ref||!/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}(?::\$?[A-Z]{1,3}\$?[1-9]\d{0,6})?$/i.test(ref))return null
  const area=parseRef(ref.toUpperCase())
  return area.startRow<=area.endRow&&area.endRow<1_048_576&&area.startColumn<=area.endColumn&&area.endColumn<16_384?area:null
}

function sizeAttribute(element:XmlElement|undefined,name:string){
  const raw=attribute(element,name)
  const n=Number(raw)
  return raw?.trim()&&Number.isFinite(n)&&n>=0?n:undefined
}

type ElementText = string | { '#text'?: string; '#cdata'?: string }
function elementText(node: ElementText | undefined): string {
  if (typeof node === 'string') return decodeAttribute(node)
  return decodeAttribute(node?.['#text']??'') + (node?.['#cdata']??'')
}

type SparklineExtension = XmlElement & {
  sparklineGroups?: { sparklineGroup?: (XmlElement & {
    colorSeries?: XmlElement
    colorNegative?: XmlElement
    sparklines?: { sparkline?: { f?: ElementText; sqref?: ElementText }[] }
  })[] }
}

const sparklineExtension = '{05c60535-1f16-4fd2-b633-f4f36f0b64e0}'
function readSparklines(extensions: readonly SparklineExtension[], resolveColor: ResolveColor): SheetMetadata['sparklines'] {
  const result: SheetMetadata['sparklines'] = []
  for (const extension of extensions) {
    if (attribute(extension, 'uri')?.toLowerCase() !== sparklineExtension) continue
    for (const group of extension.sparklineGroups?.sparklineGroup ?? []) {
      const cells: SheetMetadata['sparklines'][number]['cells'] = []
      for (const item of group.sparklines?.sparkline ?? []) {
        const sourceRef = elementText(item.f).trim()
        const cell = (elementText(item.sqref).trim().split(/\s+/, 1)[0] ?? '').replaceAll('$', '').toUpperCase()
        if (!sourceRef || !parseA1(cell)) continue
        cells.push({ cell, sourceRef })
        if (cells.length === 500) break
      }
      if (!cells.length) continue
      const kind = attribute(group, 'type')
      result.push({
        type: kind === 'column' || kind === 'stacked' ? kind : 'line',
        color: resolveColor(group.colorSeries).rgb,
        negativeColor: resolveColor(group.colorNegative).rgb,
        cells,
      })
      if (result.length === 100) return result
    }
  }
  return result
}

function outlineLevel(value: string | undefined): number {
  return value && /^\d+$/.test(value) ? Math.min(7, Number(value)) : 0
}

function readDataValidations(xml: string): SheetMetadata['dataValidations'] {
  return readWorksheetValidations(xml).flatMap(({attributes, sqref, formulas})=>{
    const ranges = sqref.trim().split(/\s+/).map(sheetArea).filter(area=>area!==null)
    if (!ranges.length) return []
    return [{
      ranges,ruleType:attributes.get('type')??'none',operator:attributes.get('operator'),formulas,
      allowBlank:enabled(attributes.get('allowBlank')),suppressDropdown:enabled(attributes.get('showDropDown')),
      showInputMessage:enabled(attributes.get('showInputMessage')),showErrorMessage:enabled(attributes.get('showErrorMessage')),
      errorStyle:attributes.get('errorStyle'),errorTitle:attributes.get('errorTitle'),error:attributes.get('error'),
      promptTitle:attributes.get('promptTitle'),prompt:attributes.get('prompt'),
    }]
  })
}

type PageSetup = NonNullable<SheetMetadata['pageSetup']>
const headerFooterSections = ['oddHeader','oddFooter','evenHeader','evenFooter','firstHeader','firstFooter'] as const
type SheetPrintElements = {
  sheetPr?: {pageSetUpPr?: XmlElement}
  pageSetup?: XmlElement
  pageMargins?: XmlElement
  printOptions?: XmlElement
  headerFooter?: XmlElement & Partial<Record<(typeof headerFooterSections)[number],ElementText>>
}

function integerAttribute(element: XmlElement | undefined, name: string, min: number, max: number) {
  const value = sizeAttribute(element,name)
  return value!==undefined && Number.isInteger(value) && value>=min && value<=max ? value : undefined
}

function readPageSetup(worksheet: SheetPrintElements | undefined): SheetMetadata['pageSetup'] {
  const setup=worksheet?.pageSetup, options=worksheet?.printOptions, footer=worksheet?.headerFooter
  const orientation=attribute(setup,'orientation')
  const keys=['left','right','top','bottom','header','footer'] as const
  const margins=keys.map(key=>sizeAttribute(worksheet?.pageMargins,key))
  const print:PageSetup={
    orientation:orientation==='portrait'||orientation==='landscape'?orientation:undefined,
    paperSize:integerAttribute(setup,'paperSize',1,256),scale:integerAttribute(setup,'scale',10,400),
    fitToWidth:integerAttribute(setup,'fitToWidth',0,32_767),fitToHeight:integerAttribute(setup,'fitToHeight',0,32_767),
    fitToPage:enabled(attribute(worksheet?.sheetPr?.pageSetUpPr,'fitToPage'))||undefined,
    printGridlines:enabled(attribute(options,'gridLines'))||undefined,
    printHeadings:enabled(attribute(options,'headings'))||undefined,
    differentOddEven:enabled(attribute(footer,'differentOddEven'))||undefined,
    differentFirst:enabled(attribute(footer,'differentFirst'))||undefined,
    headerFooterFixedSize:disabled(attribute(footer,'scaleWithDoc'))||undefined,
  }
  if (margins.every(value=>value!==undefined&&value<=10)) {
    print.margins={left:margins[0]!,right:margins[1]!,top:margins[2]!,bottom:margins[3]!,header:margins[4]!,footer:margins[5]!}
  }
  for(const section of headerFooterSections){
    const content=elementText(footer?.[section])
    if(content.length>0&&content.length<=500)print[section]=content
  }
  return Object.values(print).some(value=>value!==undefined)?print:null
}

function readManualBreaks(items: readonly XmlElement[], max: number): number[] {
  const breaks = new Set<number>()
  for (const item of items) {
    if (!enabled(attribute(item,'man'))) continue
    const id = integerAttribute(item,'id',0,max)
    if (id!==undefined) breaks.add(id)
    if (breaks.size===1_023) break
  }
  return [...breaks].sort((a,b)=>a-b)
}

type ResolveColor=(element:XmlElement|undefined)=>{rgb:string|undefined}
type SheetConditionalRule=SheetMetadata['conditionalRules'][number]
type CfThresholdXml=XmlElement & { f?: ElementText }
type CfPayload=XmlElement & { cfvo?: CfThresholdXml[]; color?: XmlElement[] }
type CfRuleExtension=XmlElement & { id?: ElementText }
type CfRuleXml=XmlElement & {
  formula?: ElementText[]
  colorScale?: CfPayload
  dataBar?: CfPayload
  iconSet?: CfPayload
  extLst?: { ext?: CfRuleExtension[] }
}
type CfBlockXml=XmlElement & { cfRule?: CfRuleXml[] }
type EnhancedDataBarXml=CfPayload & { axisColor?: XmlElement; negativeFillColor?: XmlElement; fillColor?: XmlElement }
type EnhancedCfBlockXml={ cfRule?: (XmlElement & { dataBar?: EnhancedDataBarXml })[] }
type EnhancedCfExtension=XmlElement & {
  conditionalFormattings?: { conditionalFormatting?: EnhancedCfBlockXml[] }
}

const conditionalFormattingExtension = '{78c0d931-6437-407d-a8ee-f0aad7539e65}'
const conditionalRuleIdExtension = '{b025f937-c7b1-47d3-b67f-a62eff666e3e}'

function enhancedDataBars(extensions: readonly EnhancedCfExtension[]): ReadonlyMap<string, EnhancedDataBarXml> {
  const bars = new Map<string, EnhancedDataBarXml>()
  for (const extension of extensions) {
    if (attribute(extension, 'uri')?.toLowerCase() !== conditionalFormattingExtension) continue
    for (const block of extension.conditionalFormattings?.conditionalFormatting ?? []) {
      for (const rule of block.cfRule ?? []) {
        if (attribute(rule, 'type') !== 'dataBar' || !rule.dataBar) continue
        const id = attribute(rule, 'id')?.trim().toLowerCase()
        if (id) bars.set(id, rule.dataBar)
      }
    }
  }
  return bars
}

function cfInteger(node: XmlElement | undefined, key: string) {
  const raw = attribute(node, key)
  const value = Number(raw)
  return raw !== undefined && /^\d+$/.test(raw) && Number.isSafeInteger(value) ? value : undefined
}

function readCfThresholds(
  nodes: readonly CfThresholdXml[],
  base: SheetConditionalRule['cfvos'] = [],
): SheetConditionalRule['cfvos'] {
  return nodes.flatMap((stop, index) => {
    const kind = attribute(stop, 'type')
    if (!kind) return []
    const gte = attribute(stop, 'gte')
    const fallback = base[index]?.kind === kind ? base[index] : undefined
    return [{
      kind,
      value: (elementText(stop.f).trim() || attribute(stop, 'val')) ?? fallback?.value,
      gte: gte === undefined ? fallback?.gte : !disabled(gte),
    }]
  })
}

function mergeEnhancedDataBar(rule: SheetConditionalRule, twin: EnhancedDataBarXml, resolveColor: ResolveColor): SheetConditionalRule {
  const axis = attribute(twin, 'axisPosition')
  const gradient = attribute(twin, 'gradient')
  const showValue = attribute(twin, 'showValue')
  const fillColor = resolveColor(twin.fillColor).rgb
  const cfvos = readCfThresholds(twin.cfvo ?? [], rule.cfvos)
  return {
    ...rule,
    cfvos: cfvos.length === 2 ? cfvos : rule.cfvos,
    colors: fillColor === undefined ? rule.colors : [fillColor],
    showValue: showValue === undefined ? rule.showValue : !disabled(showValue),
    axisPosition: axis === 'automatic' || axis === 'middle' || axis === 'none' ? axis : undefined,
    axisColor: resolveColor(twin.axisColor).rgb,
    gradient: gradient === undefined ? undefined : !disabled(gradient),
    negativeColor: resolveColor(twin.negativeFillColor).rgb,
    negativeSameAsPositive: !disabled(attribute(twin, 'negativeBarColorSameAsPositive')),
    minLength: Math.min(100, cfInteger(twin, 'minLength') ?? 0),
    maxLength: Math.min(100, cfInteger(twin, 'maxLength') ?? 100),
  }
}

function readConditionalRules(
  blocks: readonly CfBlockXml[],
  extensions: readonly EnhancedCfExtension[],
  resolveColor: ResolveColor,
): SheetConditionalRule[] {
  const bars = enhancedDataBars(extensions)
  const rules: SheetConditionalRule[] = []
  for (const block of blocks) {
    const ranges = (attribute(block, 'sqref') ?? '').split(/\s+/).map(sheetArea).filter(area => area !== null)
    if (!ranges.length) continue
    for (const node of block.cfRule ?? []) {
      const ruleType = attribute(node, 'type') ?? 'unknown'
      const { colorScale, dataBar, iconSet } = node
      const payload = colorScale ?? dataBar ?? iconSet
      const colors = (payload?.color ?? []).flatMap(color => {
        const rgb = resolveColor(color).rgb
        return rgb ? [rgb] : []
      })
      const cfvos = readCfThresholds(payload?.cfvo ?? [])
      if (ruleType === 'colorScale' && (colors.length < 2 || colors.length !== cfvos.length ||
        cfvos.length !== colorScale?.cfvo?.length || colors.length !== colorScale?.color?.length)) continue
      const rule: SheetConditionalRule = {
        ranges, ruleType, colors, cfvos,
        operator: attribute(node, 'operator'),
        formulas: (node.formula ?? []).map(elementText),
        text: attribute(node, 'text'),
        dxfIndex: cfInteger(node, 'dxfId'),
        priority: cfInteger(node, 'priority') ?? 0,
        stopIfTrue: enabled(attribute(node, 'stopIfTrue')),
        rank: cfInteger(node, 'rank'),
        percent: enabled(attribute(node, 'percent')),
        bottom: enabled(attribute(node, 'bottom')),
        iconSetName: iconSet === undefined ? undefined : attribute(iconSet, 'iconSet') ?? '3TrafficLights1',
        iconReverse: enabled(attribute(iconSet, 'reverse')),
        showValue: !disabled(attribute(payload, 'showValue')),
        minLength: dataBar === undefined ? undefined : Math.min(100, cfInteger(dataBar, 'minLength') ?? 10),
        maxLength: dataBar === undefined ? undefined : Math.min(100, cfInteger(dataBar, 'maxLength') ?? 90),
      }
      const idExtension = ruleType === 'dataBar' && node.extLst?.ext?.find(extension =>
        attribute(extension, 'uri')?.toLowerCase() === conditionalRuleIdExtension)
      const twin = idExtension ? bars.get(elementText(idExtension.id).trim().toLowerCase()) : undefined
      rules.push(twin === undefined ? rule : mergeEnhancedDataBar(rule, twin, resolveColor))
    }
  }
  return rules
}
function readWorksheetMetadata(xml:string,resolveColor:ResolveColor,linkTargets:ReadonlyMap<string,string>):Omit<SheetMetadata,'comments'|'tables'>{
  let rowExtent=0
  const worksheet=new XMLParser({
    ...metadataXmlOptions,
    updateTag:(name,path,attrs)=>{
      // For stopped nodes the parser reports the parent path.
      if(name!=='row'||path!=='worksheet.sheetData')return name
      const row=Number(attribute(attrs,'r'))
      if(Number.isInteger(row)&&row>=1&&row<=MAX_GRID_ROWS)rowExtent=Math.max(rowExtent,row)
      // Plain rows contribute to the extent without needing a layout record.
      return attrs?.['@_ht']!==undefined||attrs?.['@_hidden']!==undefined||attrs?.['@_collapsed']!==undefined
        ||attrs?.['@_outlineLevel']!==undefined||attrs?.['@_s']!==undefined?name:false
    },
  }).parse(xml).worksheet
  const dimension=sheetArea(attribute(worksheet?.dimension,'ref'))
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
  const columns:SheetMetadata['columnWidths']=[]
  const format=worksheet?.sheetFormatPr
  const outline=worksheet?.sheetPr?.outlinePr
  let outlineLevelCol=outlineLevel(attribute(format,'outlineLevelCol'))
  let outlineLevelRow=outlineLevel(attribute(format,'outlineLevelRow'))
  for(const col of worksheet?.cols?.col??[]){
    const first=Number(attribute(col,'min')),last=Number(attribute(col,'max'))
    if(!Number.isInteger(first)||!Number.isInteger(last)||first<1||last<first||last>MAX_GRID_COLUMNS)continue
    const level=outlineLevel(attribute(col,'outlineLevel')),width=sizeAttribute(col,'width')
    const hidden=enabled(attribute(col,'hidden')),collapsed=enabled(attribute(col,'collapsed'))
    const styleIndex=positiveStyle(attribute(col,'style'))
    if(width===undefined&&!hidden&&!collapsed&&!level&&styleIndex===undefined)continue
    outlineLevelCol=Math.max(outlineLevelCol,level)
    columns.push({startColumn:first-1,endColumn:last-1,width,hidden,
      styleIndex,outlineLevel:level||undefined,collapsed:collapsed||undefined})
  }
  const merges:SheetMetadata['merges']=[]
  for(const merge of worksheet?.mergeCells?.mergeCell??[]){
    const area=sheetArea(attribute(merge,'ref'))
    if(area)merges.push(area)
  }
  const hyperlinks:SheetMetadata['hyperlinks']=[]
  for(const link of worksheet?.hyperlinks?.hyperlink??[]){
    // A hyperlink on a range is anchored at its first cell, as in the Rust reader.
    const anchor=attribute(link,'ref')?.split(':',1)[0]?.replaceAll('$','').toUpperCase()
    const cell=anchor&&parseA1(anchor)
    if(!cell)continue
    const id=attribute(link,'id'),location=attribute(link,'location')
    const target=id!==undefined?linkTargets.get(id):location!==undefined?'#'+location:undefined
    if(target!==undefined)hyperlinks.push({...cell,target})
  }
  const conditionalRules = readConditionalRules(worksheet?.conditionalFormatting ?? [], worksheet?.extLst?.ext ?? [], resolveColor)
  const rows:SheetMetadata['rows']=[]
  for(const node of worksheet?.sheetData?.row??[]){
    const r=Number(attribute(node,'r'))
    if(!Number.isInteger(r)||r<1||r>MAX_GRID_ROWS)continue
    const level=outlineLevel(attribute(node,'outlineLevel')),height=sizeAttribute(node,'ht')
    const hidden=enabled(attribute(node,'hidden')),collapsed=enabled(attribute(node,'collapsed'))
    const styleIndex=enabled(attribute(node,'customFormat'))?positiveStyle(attribute(node,'s')):undefined
    if(height===undefined&&!hidden&&!collapsed&&!level&&styleIndex===undefined)continue
    outlineLevelRow=Math.max(outlineLevelRow,level)
    rows.push({row:r-1,height,customHeight:(height!==undefined&&enabled(attribute(node,'customHeight')))||undefined,
      hidden,styleIndex,outlineLevel:level||undefined,collapsed:collapsed||undefined})
  }
  const view=worksheet?.sheetViews?.sheetView?.at(-1)
  const pane=view?.pane
  const viewKind=attribute(view,'view')
  const zoomAttribute=(name:string)=>sizeAttribute(view,name)||undefined
  const savedZoom=viewKind==='pageBreakPreview'||viewKind==='pageLayout'
    ?zoomAttribute('zoomScaleNormal'):zoomAttribute('zoomScale')??zoomAttribute('zoomScaleNormal')
  const zoomScale=savedZoom===undefined?100:Math.max(10,Math.min(400,Math.round(savedZoom)))
  const split=(name:string,max:number)=>{const n=Number(attribute(pane,name));return Number.isInteger(n)&&n>=0&&n<=max?n:0}
  const frozenRows=split('ySplit',1_048_576),frozenColumns=split('xSplit',16_384)
  const frozen=['frozen','frozenSplit'].includes(attribute(pane,'state')??'')
  return {sheetProtection,protectedRanges,...readAutoFilter(worksheet?.autoFilter?.[0]),rows,rowExtent,columnWidths:columns,merges,conditionalRules,hyperlinks,
    ...(dimension?{dimension}:{}),
    dataValidations:readDataValidations(xml),
    sparklines:readSparklines(worksheet?.extLst?.ext??[],resolveColor),
    rowBreaks:readManualBreaks(worksheet?.rowBreaks?.brk??[],1_048_575),
    colBreaks:readManualBreaks(worksheet?.colBreaks?.brk??[],16_383),
    pageSetup:readPageSetup(worksheet),
    view:{
      tabColor:resolveColor(worksheet?.sheetPr?.tabColor).rgb??null,
      showGridLines:!disabled(attribute(view,'showGridLines')),
      showFormulas:enabled(attribute(view,'showFormulas'))||undefined,
      showRowColHeaders:disabled(attribute(view,'showRowColHeaders'))?false:undefined,
      rightToLeft:enabled(attribute(view,'rightToLeft'))||undefined,
      zoomScale:zoomScale===100?undefined:zoomScale,
      outlineLevelRow:outlineLevelRow||undefined,
      outlineLevelCol:outlineLevelCol||undefined,
      outlineSummaryBelow:disabled(attribute(outline,'summaryBelow'))?false:undefined,
      outlineSummaryRight:disabled(attribute(outline,'summaryRight'))?false:undefined,
    },
    freeze:frozen&&(frozenRows||frozenColumns)?{frozenRows,frozenColumns}:null,
    defaultRowHeight:sizeAttribute(format,'defaultRowHeight')||null,defaultColumnWidth:sizeAttribute(format,'defaultColWidth')||null,
    defaultRowHeightFixed:enabled(attribute(format,'customHeight'))||undefined,baseColumnWidth:sizeAttribute(format,'baseColWidth')||null}
}

function positiveStyle(raw:string|undefined){
  const n=Number(raw)
  return Number.isSafeInteger(n)&&n>0?n:undefined
}

type AutoFilterXml=XmlElement & {filterColumn?:Array<XmlElement & {
  filters?:XmlElement & {filter?:XmlElement[];dateGroupItem?:unknown}
  customFilters?:XmlElement & {customFilter?:XmlElement[]}
  top10?:unknown
  dynamicFilter?:unknown
  colorFilter?:unknown
  iconFilter?:unknown
  extLst?:unknown
}>}

function readAutoFilter(element:AutoFilterXml|undefined):Pick<SheetMetadata,'autoFilter'|'autoFilterColumns'> {
  const ref=attribute(element,'ref')
  const autoFilter=sheetArea(ref)
  const autoFilterColumns:FilterColumn[]=[]
  if(autoFilter)for(const column of element?.filterColumn??[]){
    const id=attribute(column,'colId')
    if(id===undefined||!/^\d+$/.test(id))continue
    const colId=Number(id)
    if(colId>autoFilter.endColumn-autoFilter.startColumn)continue
    const filters=column.filters
    const custom=column.customFilters
    if(column.top10!==undefined||column.dynamicFilter!==undefined
      ||column.colorFilter!==undefined||column.iconFilter!==undefined||column.extLst!==undefined)continue
    const values=filters?.filter?.flatMap(filter=>{
      const val=attribute(filter,'val')
      return val!==undefined&&val.length<=32_767?[val]:[]
    }).slice(0,10_000)
    const blank=enabled(attribute(filters,'blank'))
    // Keep a mixed date filter opaque if the editor cannot round-trip its value list.
    if(filters?.dateGroupItem!==undefined&&((!values?.length&&!blank)
      ||(values?.length??0)!==(filters.filter?.length??0)))continue
    const comparisonInputs=custom?.customFilter?.flatMap(filter=>{
      const val=attribute(filter,'val')
      return val===undefined?[]:[{val,name:attribute(filter,'operator')}]
    }).slice(0,2)
    const comparisons=comparisonInputs?.map(({val,name})=>({val,name,operator:filterOperators.find(item=>item===name)}))
    const validComparisons=comparisons?.length&&comparisons.every(({val,name,operator})=>
      val.length<=32_767&&(name===undefined||name==='equal'||operator!==undefined))
      ?comparisons.map(({val,operator})=>({val,...(operator?{operator}:{})})):undefined
    if(filters===undefined&&!validComparisons)continue
    autoFilterColumns.push({colId,...(filters!==undefined?{values:values??[],...(blank?{blank:true}:{})}:{}),
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
    const pivotRanges:WorkbookFile['sheets'][number]['pivotRanges']=[]
    for(const pivotRel of parseRelationships(await text(relsPathFor(sheetPath)))){
      if(pivotRel.external||!pivotRel.type.endsWith('/pivotTable'))continue
      const path=resolveRelTarget(sheetPath,pivotRel.target),xml=await text(path)
      const pivot=readPivotPartMetadata(xml,theme)
      if(!pivot)continue
      const cacheRel=parseRelationships(await text(relsPathFor(path))).find(rel=>!rel.external&&rel.type.endsWith('/pivotCacheDefinition'))
      pivotTables.push({...pivot,path,cachePath:cacheRel?resolveRelTarget(path,cacheRel.target):null})
      try {
        const range=parseRange(pivot.outputRef.toUpperCase())
        if(range.endRow<MAX_GRID_ROWS&&range.endColumn<MAX_GRID_COLUMNS)pivotRanges.push(range)
      } catch {
        // Keep the pivot part visible in metadata, but a broken ref cannot lock cells.
      }
    }
    result.set(sheet.name,{pivotTables,pivotRanges})
  }
  return result
}

// The Web worker opens files with locale "en", matching GenOffice's English fallbacks.
const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
  18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'hh:mm', 21: 'hh:mm:ss', 22: 'm/d/yy hh:mm',
  27: 'm/d/yyyy', 28: 'm/d/yyyy', 29: 'm/d/yyyy', 30: 'm/d/yyyy', 31: 'yyyy/m/d',
  32: 'm/d/yyyy', 33: 'm/d/yyyy', 34: 'm/d/yyyy', 35: 'm/d/yyyy', 36: 'm/d/yyyy',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
  50: 'm/d/yyyy', 51: 'm/d/yyyy', 52: 'm/d/yyyy', 53: 'm/d/yyyy', 54: 'm/d/yyyy',
  55: 'm/d/yyyy', 56: 'm/d/yyyy', 57: 'm/d/yyyy', 58: 'm/d/yyyy',
  59: '0', 60: '0.00', 61: '#,##0', 62: '#,##0.00', 67: '0%', 68: '0.00%',
  69: '# ?/?', 70: '# ??/??', 71: 'd/m/yyyy', 72: 'd-mmm-yy', 73: 'd-mmm', 74: 'mmm-yy',
  75: 'h:mm', 76: 'h:mm:ss', 77: 'd/m/yyyy h:mm', 78: 'mm:ss', 79: '[h]:mm:ss', 80: 'mm:ss.0', 81: 'd/m/yy',
}

type StyleFontXml = Partial<Record<'color' | 'name' | 'rFont' | 'sz' | 'scheme' | 'vertAlign' | 'b' | 'i' | 'u' | 'strike', XmlElement>>
type BorderSide = 'top' | 'bottom' | 'left' | 'right' | 'diagonal' | 'horizontal' | 'vertical'
type BorderEdgeXml = XmlElement & { color?: XmlElement }
type StyleBorderXml = XmlElement & Partial<Record<BorderSide, BorderEdgeXml>>
type StyleFillXml = {
  patternFill?: XmlElement & { fgColor?: XmlElement; bgColor?: XmlElement }
  gradientFill?: { stop?: (XmlElement & { color?: XmlElement })[] }
}

function readThemeFonts(xml: string): WorkbookFile['themeFonts'] {
  if (!xml) return undefined
  const scheme = metadataXml.parse(xml)?.theme?.themeElements?.fontScheme
  const major = attribute(scheme?.majorFont?.latin, 'typeface')
  const minor = attribute(scheme?.minorFont?.latin, 'typeface')
  const minorEa = attribute(scheme?.minorFont?.ea, 'typeface')
  return major && minor ? { major, minor, ...(minorEa ? { minorEa } : {}) } : undefined
}

async function readWorkbookStyles(text: ZipText) {
  const [xml, themeXml] = await Promise.all([text('xl/styles.xml'), text('xl/theme/theme1.xml')])
  const localName = (name: string) => name.slice(name.lastIndexOf(':') + 1)
  const root = childElements(xml).find(element => localName(element.name) === 'styleSheet')
  const sections = childElements(root?.inner ?? '')
  const section = (name: string, elements = sections) => elements.find(element => localName(element.name) === name)?.inner
  const entries = (name: string, tag: string) => resolvedStyleEntries(section(name) ?? '', tag, true)
  const formats = new Map<number, string>()
  for (const id of Object.keys(BUILTIN_NUMBER_FORMATS)) formats.set(Number(id), BUILTIN_NUMBER_FORMATS[Number(id)]!)
  for (const entry of entries('numFmts', 'numFmt')) {
    const id = Number(readAttribute(entry, 'numFmtId'))
    const code = readAttribute(entry, 'formatCode')
    if (Number.isInteger(id) && code !== undefined) formats.set(id, decodeAttribute(code))
  }
  const parseEntries = (name:string, tag:string) =>
    entries(name,tag).map(entry=>metadataXml.parse(entry)[tag])
  const theme=pivotTheme(themeXml)
  const themeFonts = readThemeFonts(themeXml)
  const hex=(value:string|undefined)=>/^(?:[0-9a-f]{2})?[0-9a-f]{6}$/i.test(value??'')?'#'+value!.slice(-6).toUpperCase():undefined
  const colors = childElements(section('colors') ?? '')
  const indexed = resolvedStyleEntries(section('indexedColors', colors) ?? section('indexedColors') ?? '', 'rgbColor', true)
    .map(entry => hex(attribute(metadataXml.parse(entry).rgbColor, 'rgb')))
  // ECMA-376 default indexed palette, followed by system text/background.
  const palette='000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333 000000 FFFFFF'.split(' ')
  const index=(value:string|undefined)=>value!==undefined&&/^\d+$/.test(value)?Number(value):-1
  function color(node:XmlElement|undefined) {
    const slot=index(attribute(node,'theme')), base=theme[slot]
    const rawTint=Number(attribute(node,'tint')??0)
    const tint=Number.isFinite(rawTint)?Math.max(-1,Math.min(1,rawTint)):0
    if(base)return {rgb:applyTint(base,tint),slot,tint}
    const id=index(attribute(node,'indexed')), rgb=hex(attribute(node,'rgb'))??
      (id<64?indexed[id]:undefined)??hex(palette[id])
    return {rgb,slot:undefined,tint:undefined}
  }
  function gradientColor(gradient: StyleFillXml['gradientFill']) {
    const stops = (gradient?.stop ?? []).flatMap(stop => {
      const rawPosition = attribute(stop, 'position')
      const position = Number(rawPosition)
      const { rgb } = color(stop.color)
      return rawPosition && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawPosition)
        && Number.isFinite(position) && rgb ? [{ position, rgb }] : []
    }).sort((a, b) => a.position - b.position)
    const first = stops[0], last = stops.at(-1)
    return first && last ? mixHexColors(first.rgb, last.rgb) : undefined
  }
  function cellFillColor(fill: StyleFillXml | undefined): ReturnType<typeof color> {
    const pattern = fill?.patternFill
    const patternType = attribute(pattern, 'patternType')
    if (pattern === undefined) {
      return { rgb: gradientColor(fill?.gradientFill), slot: undefined, tint: undefined }
    }
    if (patternType === 'none') return color(undefined)
    const foreground = color(pattern.fgColor)
    const background = color(pattern.bgColor)
    if (patternType !== undefined && patternType !== 'solid' && foreground.rgb && background.rgb) {
      return { rgb: mixHexColors(foreground.rgb, background.rgb), slot: undefined, tint: undefined }
    }
    return foreground.rgb ? foreground : background
  }
  const on = (node: XmlElement | undefined) => node !== undefined && !disabled(attribute(node, 'val'))
  function readRunStyle(xml: string): Omit<WorkbookRichRun, 'text'> {
    const font = (xml ? metadataXml.parse(xml).rPr : undefined) as StyleFontXml | undefined
    const family = attribute(font?.rFont, 'val')
    const size = Number(attribute(font?.sz, 'val'))
    const rgb = color(font?.color).rgb
    const vertAlign = attribute(font?.vertAlign, 'val')
    return {
      bold: on(font?.b),
      italic: on(font?.i),
      underline: on(font?.u) && attribute(font?.u, 'val') !== 'none',
      strikethrough: on(font?.strike),
      ...(family === undefined ? {} : { family }),
      ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      ...(rgb === undefined ? {} : { color: rgb }),
      ...(vertAlign === 'subscript' || vertAlign === 'superscript' ? { vertAlign } : {}),
    }
  }
  const borderEdge = (node: BorderEdgeXml | undefined) => {
    const style = attribute(node, 'style')
    return style && style !== 'none' ? { style, color: color(node?.color).rgb } : undefined
  }
  const fontAndBorder = (font: StyleFontXml | undefined, border: StyleBorderXml | undefined) => {
    const fontColor = color(font?.color)
    const fontSize = Number(attribute(font?.sz, 'val'))
    const fontScheme = attribute(font?.scheme, 'val')
    const vertAlign = attribute(font?.vertAlign, 'val')
    return {
      fontFamily: attribute(font?.name, 'val'),
      fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : undefined,
      bold: on(font?.b), italic: on(font?.i), underline: on(font?.u) && attribute(font?.u, 'val') !== 'none',
      strikethrough: on(font?.strike),
      vertAlign: vertAlign === 'superscript' || vertAlign === 'subscript' ? vertAlign : undefined,
      fontScheme: fontScheme === 'major' || fontScheme === 'minor' ? fontScheme : undefined,
      fontColor: fontColor.rgb, fontColorTheme: fontColor.slot, fontColorTint: fontColor.tint,
      borderTop: borderEdge(border?.top), borderBottom: borderEdge(border?.bottom),
      borderLeft: borderEdge(border?.left), borderRight: borderEdge(border?.right),
      borderDiagonal: borderEdge(border?.diagonal), diagonalUp: enabled(attribute(border, 'diagonalUp')),
      diagonalDown: enabled(attribute(border, 'diagonalDown')),
    } satisfies Partial<WorkbookCellStyle>
  }
  const fonts=parseEntries('fonts','font'),fills=parseEntries('fills','fill'),borders=parseEntries('borders','border')
  const namedProtection=parseEntries('cellStyleXfs','xf').map(xf=>xf?.protection)
  const cellXfs = parseEntries('cellXfs', 'xf')
  // The grid's column widths use the original face even when the theme replaces it for display.
  const normalFontName = attribute(fonts[index(attribute(cellXfs[0], 'fontId'))]?.name, 'val')
  const styles:WorkbookCellStyle[] = cellXfs.map(xf => {
    const id=Number(attribute(xf,'numFmtId')??0)
    const font=fonts[index(attribute(xf,'fontId'))]
    const fillColor = cellFillColor(fills[index(attribute(xf, 'fillId'))])
    const border=borders[index(attribute(xf,'borderId'))]
    const alignment=xf?.alignment
    const protection=enabled(attribute(xf,'applyProtection'))?xf?.protection:namedProtection[Number(attribute(xf,'xfId')??0)]
    const indent=index(attribute(alignment,'indent')),textRotation=index(attribute(alignment,'textRotation'))
    const fontStyle = fontAndBorder(font, border)
    return {
      ...fontStyle,
      fontFamily: (fontStyle.fontScheme && themeFonts?.[fontStyle.fontScheme]) ?? fontStyle.fontFamily,
      fillColor:fillColor.rgb,fillColorTheme:fillColor.slot,fillColorTint:fillColor.tint,
      wrapText:enabled(attribute(alignment,'wrapText')),shrinkToFit:enabled(attribute(alignment,'shrinkToFit'))||undefined,
      horizontalAlignment:attribute(alignment,'horizontal'),verticalAlignment:attribute(alignment,'vertical'),
      indent:indent>0&&Number.isSafeInteger(indent)?indent:undefined,
      textRotation:textRotation>0&&textRotation<=255?textRotation:undefined,
      numberFormat:formats.get(id),locked:disabled(attribute(protection,'locked'))?false:undefined,
      hidden:enabled(attribute(protection,'hidden'))||undefined,
    }
  })
  if(styles[0]?.locked===false)for(const style of styles.slice(1))style.locked??=true
  const dxfs: TableDxf[] = parseEntries('dxfs', 'dxf').map(dxf => {
    const fill = dxf?.fill as StyleFillXml | undefined
    const pattern = fill?.patternFill
    const fillColor = color(pattern?.bgColor ?? pattern?.fgColor)
    const format = attribute(dxf?.numFmt, 'formatCode')
    const border = dxf?.border as StyleBorderXml | undefined
    const style: WorkbookCellStyle = {
      ...fontAndBorder(dxf?.font, border),
      wrapText: false,
      fillColor: pattern === undefined ? gradientColor(fill?.gradientFill) : fillColor.rgb,
      fillColorTheme: fillColor.slot,
      fillColorTint: fillColor.tint,
      numberFormat: format && format !== 'General' ? format : undefined,
    }
    return { style, horizontal: borderEdge(border?.horizontal), vertical: borderEdge(border?.vertical) }
  })
  const dxfStyles = dxfs.map(({style}) => style)
  const customTableStyles = readCustomTableStyles(section('tableStyles'), dxfs)
  return {styles,theme,themeFonts,normalFontName,color,dxfStyles,readRunStyle,customTableStyles}
}

async function readSheetMetadata(text: ZipText,resolveColor:ResolveColor,theme:readonly string[],
  imageSources:Awaited<ReturnType<typeof readCellImageSources>>,hasPart:(path:string)=>boolean,
  customTableStyles:ReturnType<typeof readCustomTableStyles>) {
  const workbookPath = 'xl/workbook.xml'
  const workbookRels = parseRelationships(await text(relsPathFor(workbookPath)))
  const sheets = new Map<string, SheetMetadata & {
    styleIndexes:Map<string,number>; imageCells:ReturnType<typeof readSheetCellImages>; headerFooterMedia:Map<string,string>
  }>()
  for (const [sheetIndex,sheet] of parseSheetElements(await text(workbookPath)).entries()) {
    const rel = workbookRels.find(item => item.id === sheet.relationshipId && !item.external && item.type.endsWith('/worksheet'))
    if (!rel) continue
    const path = resolveRelTarget(workbookPath, rel.target)
    const xml = inferWorksheetAddresses(normalizeOoxmlPartPrefix(await text(path)))
    const linkTargets=new Map<string,string>()
    if(xml.includes('hyperlink')){
      const linkRelationships=metadataXml.parse(await text(relsPathFor(path))).Relationships?.Relationship??[]
      for(const relation of linkRelationships){
        const id=attribute(relation,'Id'),target=attribute(relation,'Target')
        if(id!==undefined&&target!==undefined&&attribute(relation,'Type')?.endsWith('/hyperlink')){
          linkTargets.set(id,target)
        }
      }
    }
    const cells = new Map<string, number>()
    for (const match of xml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>/g)) {
      const address = readAttribute(match[1]!, 'r')
      const style = readAttribute(match[1]!, 's')
      if (address && style !== undefined && /^\d+$/.test(style)) cells.set(decodeAttribute(address), Number(style))
    }
    const [comments,tables,headerPictures]=await Promise.all([
      readNodeSheetComments(text,path),
      readWorksheetTables(text,path,xml,theme,customTableStyles),
      xml.includes('legacyDrawingHF') ? readHeaderFooterPictures(text,path,sheetIndex,hasPart) : [],
    ])
    const metadata=readWorksheetMetadata(xml,resolveColor,linkTargets)
    const headerFooterMedia=new Map<string,string>()
    if(headerPictures.length) {
      const headerFooterPictures=headerPictures.map(({mediaPath,...picture})=>{
        headerFooterMedia.set(picture.id,mediaPath)
        return picture
      })
      metadata.pageSetup={...metadata.pageSetup,headerFooterPictures}
    }
    sheets.set(sheet.name,{styleIndexes:cells,...metadata,comments,tables,headerFooterMedia,
      imageCells:readSheetCellImages(xml,imageSources)})
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
const compareCellPosition = (a: ParsedCell, b: ParsedCell) => a.row - b.row || a.column - b.column

function sharedFormulaGroup(
  si: number,
  master: ParsedCell & { formula: string },
  followers: ParsedCell[],
  range: Bounds | undefined,
): WorkbookSharedFormulaGroup {
  const { row, column, formula } = master
  if (range && (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1) === followers.length + 1) {
    const inside = (cell: ParsedCell) => cell.row >= range.startRow && cell.row <= range.endRow
      && cell.column >= range.startColumn && cell.column <= range.endColumn
    if (inside(master) && followers.every(inside)) return { si, row, column, formula, range }
  }
  return { si, row, column, formula, cells: followers.map(({ row, column }) => [row, column]) }
}

function readRange(sheet: ParsedSheet,r: Bounds) {
  const cells = sheet.cells.filter(
    c => c.row >= r.startRow && c.row <= r.endRow && c.column >= r.startColumn && c.column <= r.endColumn,
  )
  return {
    cells,
    rows:sheet.rows.filter(row=>row.row>=r.startRow&&row.row<=r.endRow),
    merges:sheet.merges.filter(area=>area.startRow<=r.endRow&&area.endRow>=r.startRow&&area.startColumn<=r.endColumn&&area.endColumn>=r.startColumn),
    hyperlinks: sheet.hyperlinks.filter(link=>link.row>=r.startRow&&link.row<=r.endRow&&link.column>=r.startColumn&&link.column<=r.endColumn),
    conditionalRules: sheet.conditionalRules,
    autoFilter: sheet.autoFilter,
    autoFilterColumns: sheet.autoFilterColumns,
    dataValidations: sheet.dataValidations,
    sheetProtection: sheet.sheetProtection,
    rowBreaks: sheet.rowBreaks,
    colBreaks: sheet.colBreaks,
    pageSetup: sheet.pageSetup,
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
    for(const run of cell.rich??[]) {
      chars+=64+run.text.length+(run.family?.length??0)
      if(chars>limit)return undefined
    }
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
    const styling=readWorkbookStyles(text)
    const hasPart=(path:string)=>zip.file(path)!==null
    const imageSources=readCellImageSources(text,hasPart)
    const [imported, pivots, {styles,theme,themeFonts,normalFontName,dxfStyles}, metadata, workbookXml] = await Promise.all([
      styling.then(({readRunStyle})=>readWorkbookWithCellDetails(bytes,readRunStyle)),
      readPivotMetadata(text), styling, Promise.all([styling,imageSources]).then(([{color,theme,customTableStyles},images])=>readSheetMetadata(text,color,theme,images,hasPart,customTableStyles)),
      text('xl/workbook.xml'),
    ])
    let entryCount = 0
    for (const file of Object.values(zip.files)) if (!file.dir) entryCount++
    const mediaById = new Map<string,string>()
    let imageCount=0
    const parsedSheets: ParsedSheet[] = imported.snapshot.sheets.map(s => {
      const {styleIndexes,imageCells,headerFooterMedia,dimension,...sheetMetadata}=metadata.get(s.name)??{...EMPTY_SHEET_METADATA,styleIndexes:undefined,imageCells:undefined,headerFooterMedia:undefined}
      for(const [id,mediaPath] of headerFooterMedia??[])mediaById.set(id,mediaPath)
      const cells: ParsedCell[] = []
      const formulaCells: ParsedCell[] = []
      const masters = new Map<number, { cell: ParsedCell & { formula: string }; range?: Bounds }>()
      const followers = new Map<number, ParsedCell[]>()
      const cellImages: ParsedSheet['cellImages'] = []
      let rowCount=1,columnCount=1,valueCellCount=0,valueRowCount=0,valueColumnCount=0
      if(dimension){
        // Full-axis declarations describe the grid, rather than the used extent.
        if(dimension.endRow+1<MAX_GRID_ROWS)rowCount=dimension.endRow+1
        if(dimension.endColumn+1<MAX_GRID_COLUMNS)columnCount=dimension.endColumn+1
      }
      rowCount=Math.max(rowCount,sheetMetadata.rowExtent)
      for (const [addr, cell] of Object.entries(s.cells)) {
        const pos = parseA1(addr)
        if (!pos) continue
        const isCellImage = imageCells?.has(cellImageKey(pos.row,pos.column)) === true
        const value = isCellImage ? null : cell.rawValue !== undefined ? cell.rawValue : cell.value
        const formula = isCellImage || !cell.formula ? undefined : withoutFutureFunctionMarkers(cell.formula)
        rowCount=Math.max(rowCount,pos.row+1)
        columnCount=Math.max(columnCount,pos.column+1)
        if(value!==null||formula){
          valueCellCount++
          valueRowCount=Math.max(valueRowCount,pos.row+1)
          valueColumnCount=Math.max(valueColumnCount,pos.column+1)
        }
        const styleIndex = styleIndexes?.get(addr) ?? (value !== null || formula ? 0 : undefined)
        const parsedCell: ParsedCell = {
          row: pos.row,
          column: pos.column,
          value,
          ...(styleIndex === undefined ? {} : { styleIndex }),
          ...(formula ? { formula } : {}),
          ...(isCellImage || cell.arrayRef === undefined ? {} : { arrayRef: cell.arrayRef }),
          ...(isCellImage || cell.rich === undefined ? {} : { rich: cell.rich }),
        }
        cells.push(parsedCell)
        if (!formula) continue
        if (cell.sharedFormulaMaster) {
          const { si, range } = cell.sharedFormulaMaster
          masters.set(si, { cell: { ...parsedCell, formula }, range })
        }
        if (cell.sharedFormulaFollower !== undefined) {
          const si = cell.sharedFormulaFollower
          const group = followers.get(si)
          if (group) group.push(parsedCell)
          else followers.set(si, [parsedCell])
        } else {
          formulaCells.push(parsedCell)
        }
      }
      const sharedGroups: WorkbookSharedFormulaGroup[] = []
      for (const [si, group] of followers) {
        const master = masters.get(si)
        if (master) sharedGroups.push(sharedFormulaGroup(si, master.cell, group, master.range))
        else for (const follower of group) formulaCells.push(follower)
      }
      sharedGroups.sort((a, b) => a.si - b.si)
      if (imageCells) for (const {row,column,mediaPath} of imageCells.values()) {
        const id=`cell-image-${imageCount++}`
        mediaById.set(id,mediaPath)
        cellImages.push({id,row,column})
        rowCount=Math.max(rowCount,row+1)
        columnCount=Math.max(columnCount,column+1)
      }
      for(const area of [...(pivots.get(s.name)?.pivotRanges??[]),...sheetMetadata.merges,...sheetMetadata.tables.map(table=>table.range)]){
        rowCount=Math.max(rowCount,area.endRow+1)
        columnCount=Math.max(columnCount,area.endColumn+1)
      }
      for(const cell of [...sheetMetadata.hyperlinks,...sheetMetadata.comments]){
        rowCount=Math.max(rowCount,cell.row+1)
        columnCount=Math.max(columnCount,cell.column+1)
      }
      cells.sort(compareCellPosition)
      formulaCells.sort(compareCellPosition)
      return { id: s.id, name: s.name, cells, formulaCells, sharedGroups, cellImages, rowCount, columnCount,
        storedCellCount: s.storedCellCount ?? cells.length, valueCellCount, valueRowCount, valueColumnCount,
        ...sheetMetadata }
    })
    const {activeTab,visibility,definedNames,scopedSheets,printNames,workbookProtection,date1904}=readWorkbookMetadata(workbookXml,parsedSheets)
    const sourceSheets = new Map(imported.snapshot.sheets.map(sheet => [sheet.name.toLowerCase(), sheet]))
    const visuals=await readWorkbookVisuals(text,parsedSheets,theme,hasPart,reference=>{
      const separator = reference.lastIndexOf('!')
      if (separator < 1) return undefined
      const name = reference.slice(0, separator)
      const sheet = sourceSheets.get((name.startsWith("'") && name.endsWith("'")
        ? name.slice(1, -1).replaceAll("''", "'") : name).toLowerCase())
      const address = reference.slice(separator + 1).split(':', 1)[0]?.replaceAll('$', '').toUpperCase()
      if (!sheet || !address || !parseA1(address) || !sheet.cells[address]) return undefined
      const index = metadata.get(sheet.name)?.styleIndexes.get(address) ?? 0
      const format = styles[index]?.numberFormat
      return format && format !== 'General' && format !== '@' ? format : undefined
    })
    for (const {id,mediaPath,fillMediaPath} of visuals) {
      const path=mediaPath??fillMediaPath
      if(path)mediaById.set(id,path)
    }
    for (const sheet of parsedSheets) for (const {image} of sheet.comments) {
      if(image&&!mediaById.has(image.id))mediaById.set(image.id,`xl/media/${image.id}`)
    }
    const sessionId = randomUUID()
    sessions.set(sessionId, { sheets: parsedSheets, mediaById, zip })
    const inspection = {
      sessionId,
      entryCount,
      sheets: parsedSheets.map((s,index) => {
        const state=visibility.get(s.name)
        return {
          id: s.id,
          name: s.name,
          rowCount:s.rowCount,
          columnCount:s.columnCount,
          storedCellCount:s.storedCellCount,
          valueCellCount:s.valueCellCount,
          valueRowCount:s.valueRowCount,
          valueColumnCount:s.valueColumnCount,
          columnWidths:s.columnWidths,defaultRowHeight:s.defaultRowHeight,defaultRowHeightFixed:s.defaultRowHeightFixed,
          defaultColumnWidth:s.defaultColumnWidth,baseColumnWidth:s.baseColumnWidth,freeze:s.freeze,
          hidden: state==='hidden'||state==='veryHidden',
          ...(state==='veryHidden'?{veryHidden:true}:{}),
          ...(scopedSheets.has(index)?{hasScopedDefinedNames:true}:{}),
          ...printNames.get(index),
          ...s.view,
          tables:s.tables,
          comments:s.comments,
          pivotRanges: pivots.get(s.name)?.pivotRanges ?? [],
          pivotTables: pivots.get(s.name)?.pivotTables ?? [],
          sparklines: s.sparklines,
          cellImages: s.cellImages,
        }
      }),
      activeTab,
      styles,
      ...(theme.length?{themeColors:theme}:{}),
      ...(themeFonts ? { themeFonts } : {}),
      ...(normalFontName === undefined ? {} : { normalFontName }),
      dxfStyles,
      visuals,
      definedNames,
      ...(date1904?{date1904}:{}),
      ...(workbookProtection?{workbookProtection}:{}),
    }
    if(packet.openingViewport===true&&Buffer.byteLength(JSON.stringify(inspection))<=256*1024){
      const visible=inspection.sheets[activeTab]?.hidden
        ?inspection.sheets.findIndex(sheet=>!sheet.hidden):activeTab
      const sheet=parsedSheets[visible]
      if(sheet)return {...inspection,openingViewport:openingViewport(sheet)}
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
    const cells: ParsedCell[] = []
    let bytes = 0
    let truncated = false
    const expanded = packet.expandSharedFormulas === true
    for (const cell of expanded ? sheet.cells : sheet.formulaCells) {
      if (!cell.formula) continue
      bytes += Buffer.byteLength(JSON.stringify(cell)) + 1
      // Leave room for the reply envelope around the cells.
      if (cells.length === MAX_FORMULA_CELLS || bytes > MAX - 1024) {
        truncated = true
        break
      }
      cells.push(cell)
    }
    if (!expanded && !truncated) {
      for (const group of sheet.sharedGroups) {
        bytes += Buffer.byteLength(JSON.stringify(group)) + 1
        if (bytes > MAX - 1024) {
          truncated = true
          break
        }
      }
    }
    return {
      cells,
      sharedGroups: expanded || truncated ? [] : sheet.sharedGroups,
      indexingComplete: true,
      truncated,
    }
  }
  if (cmd === 'read_row_outline') {
    const sheet = sessions.get(String(packet.sessionId ?? ''))?.sheets.find(s => s.id === packet.sheetId)
    if (!sheet) throw new Error('UNKNOWN_SHEET')
    return {
      rows: sheet.rows.flatMap(({ row, outlineLevel, collapsed, hidden }) =>
        outlineLevel || collapsed ? [{ row, level: outlineLevel ?? 0, collapsed, hidden }] : []),
      indexingComplete: true,
    }
  }
  if (cmd === 'read_media') {
    const session = sessions.get(String(packet.sessionId ?? ''))
    const visualId = String(packet.visualId ?? '')
    const path = session?.mediaById.get(visualId)
    const mediaType = path && visualMediaType(path)
    const file = path && session?.zip.file(path)
    if (!file || !mediaType) throw new Error('MEDIA_NOT_FOUND')
    return readWorkbookImage(file,mediaType,visualId.startsWith('hf-picture-') ? MAX_HEADER_FOOTER_PICTURE_BYTES : undefined)
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
