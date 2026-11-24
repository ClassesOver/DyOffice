import {XMLParser} from 'fast-xml-parser'
import {relsPathFor,resolveRelTarget} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-drawing-add'
import {decodeAttribute} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-sheets'
import {parseRef} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-table-add'
import {parseLegacyComments,parseSheetCommentThreads} from '../../../../packages/xlsx-gateway/src/gateway/xlsx-threaded-comments'
import {sheetThreadSchema,type WorkbookFile} from '../../../sheets/src/shared/desktop-api'

type ZipText=(path:string)=>Promise<string>
type XmlAttributes={ [key: `@_${string}`]: string|undefined }
type SheetComments=WorkbookFile['sheets'][number]['comments']
const workbookPath='xl/workbook.xml'
const commentXml=new XMLParser({
  ignoreAttributes:false,removeNSPrefix:true,processEntities:false,parseTagValue:false,
  isArray:(_tag,path)=>path==='Relationships.Relationship'||path==='xml.shape',
})
const attribute=(node:XmlAttributes|undefined,name:string)=>decodeAttribute(node?.[`@_${name}`]??'')

async function relationships(text:ZipText,path:string):Promise<XmlAttributes[]>{
  return commentXml.parse(await text(relsPathFor(path))).Relationships?.Relationship??[]
}

function relatedPart(source:string,rels:readonly XmlAttributes[],kind:string){
  const rel=rels.find(entry=>attribute(entry,'Type').endsWith('/'+kind)&&attribute(entry,'TargetMode')!=='External')
  const target=attribute(rel,'Target')
  return target?resolveRelTarget(source,target):undefined
}

async function notePictures(text:ZipText,worksheet:string,rels:readonly XmlAttributes[]){
  const pictures=new Map<string,string>()
  try {
    const vml=relatedPart(worksheet,rels,'vmlDrawing')
    if(!vml)return pictures
    const shapes=commentXml.parse(await text(vml)).xml?.shape??[]
    if(!shapes.length)return pictures
    const drawingRels=await relationships(text,vml)
    for(const shape of shapes){
      const cell=shape.ClientData
      if(attribute(cell,'ObjectType')!=='Note'||!/^\d+$/.test(cell.Row??'')||!/^\d+$/.test(cell.Column??''))continue
      const fill=attribute(shape.fill,'type')==='frame'?shape.fill:undefined
      const id=attribute(fill,'relid')||attribute(fill,'id')||
        attribute(shape.imagedata,'relid')||attribute(shape.imagedata,'id')
      if(!id)continue
      const media=relatedPart(vml,drawingRels.filter(rel=>attribute(rel,'Id')===id),'image')
      // The existing Node media command resolves these filenames under xl/media.
      const filename=media&&/^xl\/media\/([^/]+\.(?:png|jpe?g|gif))$/i.exec(media)?.[1]
      if(filename)pictures.set(`${Number(cell.Row)}:${Number(cell.Column)}`,filename)
    }
  } catch {
    // VML is optional. Its contents are carried by the package writer.
  }
  return pictures
}

/** Load the existing notes before the editor can send a full-sheet note snapshot. */
export async function readNodeSheetComments(text:ZipText,worksheet:string):Promise<SheetComments>{
  const rels=await relationships(text,worksheet)
  const legacyPath=relatedPart(worksheet,rels,'comments')
  const threadPath=relatedPart(worksheet,rels,'threadedComment')
  if(!legacyPath&&!threadPath)return []
  const personPath=threadPath&&relatedPart(workbookPath,await relationships(text,workbookPath),'person')
  const [legacyXml,threadXml,personsXml,pictures]=await Promise.all([
    legacyPath?text(legacyPath):'',threadPath?text(threadPath):'',
    threadPath?text(personPath??'xl/persons/person.xml'):'',
    notePictures(text,worksheet,rels),
  ])
  const legacy=parseLegacyComments(legacyXml),threads=parseSheetCommentThreads(threadXml,personsXml)
  const comments:SheetComments=[]
  for(const ref of new Set([...legacy.keys(),...threads.keys()])){
    const anchor=ref.split(':',1)[0]!.replaceAll('$','').toUpperCase()
    if(!/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(anchor))continue
    const {startRow:row,startColumn:column}=parseRef(anchor)
    if(row>=1_048_576||column>=16_384)continue
    const saved=threads.get(ref),original=legacy.get(ref),imageId=pictures.get(`${row}:${column}`)
    const image=imageId?{image:{id:imageId}}:{}
    if(saved){
      const {structured,displayText,text:rootText,...thread}=saved
      if(structured&&sheetThreadSchema.safeParse(thread).success){
        comments.push({row,column,author:thread.author,text:displayText,thread:{...thread,replies:[...thread.replies],text:rootText},...image})
      }else{
        // Passing the original or display-only mirror back keeps the thread XML
        // when saving other notes, even when its metadata cannot be edited.
        comments.push({row,column,...(original??{author:thread.author,text:displayText}),...image})
      }
    }else if(original){
      comments.push({row,column,...original,...image})
    }
  }
  return comments
}
