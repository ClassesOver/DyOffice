import {XMLParser} from 'fast-xml-parser'
import {relsPathFor,resolveRelTarget} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add'
import {decodeAttribute} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets'
import type {EntrySource} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-gateway'
import type {ExternalLinksResult} from '../../../sheets/src/shared/external-links-contract'

type Reference = {'@_id'?:string}
type Relationship = {'@_Id'?:string;'@_Type'?:string;'@_Target'?:string;'@_TargetMode'?:string}
type PackageXml = {
  workbook?:{externalReferences?:{externalReference?:Reference[]}}
  Relationships?:{Relationship?:Relationship[]}
  externalLink?:{externalBook?:Reference & {sheetNames?:{sheetName?:{'@_val'?:string}[]}}}
}

const workbook='xl/workbook.xml'
const repeated=new Set(['externalReference','Relationship','sheetName'])
const parser=new XMLParser({
  ignoreAttributes:false,removeNSPrefix:true,processEntities:false,parseTagValue:false,trimValues:false,
  isArray:(name)=>repeated.has(name),
})

/** Return only metadata stored in the authorized package. External targets
 * stay inert strings and are never resolved on the server. */
export async function readWorkbookExternalLinks(source:EntrySource):Promise<ExternalLinksResult>{
  async function read(path:string):Promise<PackageXml>{
    if(!await source.has(path))return {}
    const text=await source.readText(path)
    if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('Unsupported workbook XML')
    return parser.parse(text,true) as PackageXml
  }
  const references=(await read(workbook)).workbook?.externalReferences?.externalReference??[]
  if(references.length>256)throw new Error('Too many external links')
  if(!references.length)return {links:[]}
  const relationships=(await read(relsPathFor(workbook))).Relationships?.Relationship??[]
  const links:ExternalLinksResult['links']=[]
  for(const [position,reference] of references.entries()){
    if(!reference['@_id'])continue
    const relationship=relationships.find(item=>item['@_Id']===reference['@_id'])
    if(!relationship?.['@_Type']?.endsWith('/externalLink')||relationship['@_TargetMode']==='External'||!relationship['@_Target'])continue
    const path=resolveRelTarget(workbook,decodeAttribute(relationship['@_Target']))
    const book=(await read(path)).externalLink?.externalBook
    if(!book?.['@_id'])continue
    const target=(await read(relsPathFor(path))).Relationships?.Relationship?.find(item=>
      item['@_Id']===book['@_id']&&item['@_Type']?.endsWith('/externalLinkPath')&&item['@_TargetMode']==='External')
    const rawTarget=decodeAttribute(target?.['@_Target']??'')
    const sheetNames=(book.sheetNames?.sheetName??[]).flatMap(sheet=>
      sheet['@_val']===undefined?[]:[decodeAttribute(sheet['@_val'])])
    if(rawTarget.length>8192||sheetNames.length>256||sheetNames.some(name=>name.length>255))throw new Error('External link metadata exceeds limits')
    links.push({index:position+1,rawTarget,sheetNames,source:null})
  }
  return {links}
}
