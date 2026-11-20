import {XMLParser} from 'fast-xml-parser'
import {applyTint} from '../../../sheets/src/renderer/table-styles'
import type {WorkbookFile} from '../../../sheets/src/shared/desktop-api'

type Pivot=WorkbookFile['sheets'][number]['pivotTables'][number]
const parser=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false})
const list=(value:any):any[]=>value===undefined?[]:Array.isArray(value)?value:[value]
const integer=(value:unknown,fallback=0)=>/^\d+$/.test(String(value))?Number(value):fallback
const flag=(value:unknown,fallback=false)=>value===undefined?fallback:value==='1'||value==='true'
const defaults=['#4472C4','#ED7D31','#A5A5A5','#FFC000','#5B9BD5','#70AD47']

/** Same complete theme-slot policy as the PC reader, including sysClr caches. */
export function pivotTheme(xml:string):string[]{
 if(!xml)return []
 const scheme=parser.parse(xml)?.theme?.themeElements?.clrScheme
 const colors=['lt1','dk1','lt2','dk2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'].map(slot=>{
  const color=scheme?.[slot],hex=color?.srgbClr?.['@_val']??color?.sysClr?.['@_lastClr']
  return typeof hex==='string'&&/^[a-f\d]{6}$/i.test(hex)?'#'+hex.toUpperCase():null
 })
 return colors.every(color=>color!==null)?colors as string[]:[]
}

/** Port of native table_styles::pivot_style_palette; table palettes differ.
 * Reuse the existing pure HSL tint implementation instead of another color engine. */
function palette(style:string|undefined,theme:readonly string[]):Partial<Pivot>{
 const match=/^PivotStyle(Light|Medium|Dark)(\d+)$/.exec(style??'')
 if(!match)return {}
 const number=Number(match[2]);if(number<1||number>28)return {}
 const index=(number-1)%7,neutral=index===0,black=theme[1]??'#000000',base=neutral?black:theme[3+index]??defaults[index-1]!,white='#FFFFFF'
 const band=(accent:number,gray:number)=>applyTint(base,neutral?gray:accent)
 const light=()=>band(.8,.85),mid=()=>band(.6,.75),deep=()=>band(.4,.65),shade=()=>band(-.25,.5),solid=()=>band(0,.5),gray=(tint:number)=>applyTint(black,tint)
 const variants:Record<string,Partial<Pivot>>={
  'light0':{headerBold:true, stripeFill:light(), columnStripeFill:light(), subheadingBold:true, subheading2FontColor:solid(), subheading2Bold:number!==2, subtotalBold:true, totalRowFill:white, totalRowBold:true},
  'light1':{headerFontColor:black, headerBold:true, wholeTableFontColor:neutral ? black : shade(), subheadingFill:light(), subheadingFontColor:black, subheadingBold:true, subheading2FontColor:black, subheading2Bold:true, subtotalFill:light(), subtotalFontColor:black, subtotalBold:true, totalRowFontColor:black, totalRowBold:true},
  'light2':{headerFill:light(), headerBold:true, stripeFill:gray(0.85), columnStripeFill:gray(0.85), subheadingBold:true, subheading2Bold:true, subtotalBold:true, totalRowFill:light(), totalRowBold:true},
  'light3':{headerBold:neutral, wholeTableFontColor:neutral ? black : shade(), stripeFill:light(), columnStripeFill:light(), firstColumnBold:neutral, subtotalBold:neutral, totalRowBold:neutral},
  'medium0':{headerFill:shade(), headerFontColor:white, headerBold:false, firstHeaderCellBold:true, subheadingFill:deep(), subheadingFontColor:white, subheadingBold:false, subheading2Fill:light(), subheading2Bold:false, subtotalFill:deep(), subtotalFontColor:white, subtotalBold:true, totalRowBold:true},
  'medium1':{headerFill:solid(), headerFontColor:white, headerBold:true, subheadingFill:light(), subheadingBold:true, subheading2Bold:true, subtotalFill:mid(), subtotalBold:true, totalRowBold:true},
  'medium2':{headerFill:black, headerFontColor:white, headerBold:false, wholeTableFill:band(0.8, 0.95), stripeFill:light(), columnStripeFill:light(), subheadingBold:true, subheading2FontColor:gray(0.5), subheading2Bold:true, subtotalBold:true, totalRowFill:black, totalRowFontColor:white, totalRowBold:false},
  'medium3':{headerBold:true, wholeTableFill:light(), wholeTableFontColor:shade(), secondRowStripeFill:mid(), secondColumnStripeFill:mid(), firstColumnFill:mid(), firstColumnBold:true, subheadingFontColor:black, subheadingBold:true, subtotalFontColor:black, subtotalBold:true, totalRowBold:true},
  'dark0':{headerFill:band(-.5,.5), headerFontColor:white, headerBold:true, wholeTableFill:mid(), secondRowStripeFill:deep(), subheadingFill:light(), subheadingBold:true, subheading2Bold:true, subtotalBold:true, totalRowFill:band(-.5,.5), totalRowFontColor:white, totalRowBold:true},
  'dark1':{headerFill:gray(0.25), headerFontColor:white, headerBold:true, wholeTableFill:light(), subheadingFill:mid(), subheadingBold:true, subheading2Bold:true, subtotalFill:mid(), subtotalBold:true, totalRowFill:gray(0.25), totalRowFontColor:white, totalRowBold:true},
  'dark2':{headerFill:black, headerFontColor:white, headerBold:true, wholeTableFill:band(0.0, 0.55), wholeTableFontColor:light(), subheadingFill:shade(), subheadingFontColor:white, subheadingBold:true, subheading2FontColor:white, subheading2Bold:true, subtotalFontColor:white, subtotalBold:true, totalRowFill:black, totalRowFontColor:white, totalRowBold:true},
  'dark3':{headerFill:shade(), headerBold:false, firstHeaderCellFontColor:white, firstHeaderCellBold:true, wholeTableFill:solid(), wholeTableFontColor:light(), secondRowStripeFill:band(0.4, 0.55), secondColumnStripeFill:band(0.4, 0.55), firstColumnFill:shade(), firstColumnBold:false, subheadingFontColor:white, subheadingBold:true, subheading2FontColor:white, subheading2Bold:true, subtotalBold:neutral, totalRowFontColor:white, totalRowBold:true},
 }
 return variants[match[1]!.toLowerCase()+Math.floor((number-1)/7)]!
}

/** Band metadata is distinct from the on-demand recomputation definition. */
export function pivotBandMetadata(xml:string,theme:readonly string[]):Partial<Pivot>{
 const root=parser.parse(xml)?.pivotTableDefinition??{},style=root.pivotTableStyleInfo?.['@_name'],result=palette(style,theme)
 if(!flag(root.pivotTableStyleInfo?.['@_showRowStripes'])){delete result.stripeFill;delete result.secondRowStripeFill}
 if(!flag(root.pivotTableStyleInfo?.['@_showColStripes'])){delete result.columnStripeFill;delete result.secondColumnStripeFill}
 const fields=list(root.pivotFields?.pivotField),outline=list(root.rowFields?.field).map(field=>fields[integer(field['@_x'])]?.['@_outline']!=='0')
 const rowKinds=list(root.rowItems?.i).map(item=>{
  const depth=integer(item['@_r']),kind=item['@_t']??'data'
  if(kind==='grand')return 'g'
  if(kind==='blank')return 'b'
  if(kind!=='data')return 't'
  return depth+1<outline.length&&(outline[depth]??true)?depth===0?'s':'S':'d'
 }).join('')
 return {...result,styled:typeof style==='string'&&style.length>0,rowGrandTotals:flag(root['@_rowGrandTotals'],true),rowKinds}
}
