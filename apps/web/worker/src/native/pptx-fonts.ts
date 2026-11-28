import {createHash} from 'node:crypto'
import {listEmbeddedFonts,type OpenedPptx} from '@genoffice/pptx-engine'
import {OpentypeMetrics,parseEmbeddedFontMetrics,type OpentypeFontLike} from '@genoffice/pptx-render'
import {WEB_EMBEDDED_FONT_LIMITS,type SlidesEmbeddedTypeface} from '../../../../slides/src/shared/embedded-font-limits'

function styleKey(family:string,bold:boolean,italic:boolean):string {
  return JSON.stringify([family.trim().toLowerCase(),bold,italic])
}

export function readEmbeddedTypefaces(state:OpenedPptx) {
  const faces:SlidesEmbeddedTypeface[]=[]
  const fonts=new Map<string,OpentypeFontLike>()
  for(const face of listEmbeddedFonts(state.archive,WEB_EMBEDDED_FONT_LIMITS)){
    const bold=face.style==='bold'||face.style==='boldItalic'
    const italic=face.style==='italic'||face.style==='boldItalic'
    const key=styleKey(face.typeface,bold,italic)
    if(fonts.has(key))continue
    const font=parseEmbeddedFontMetrics(face.sfnt)
    if(!font)continue
    fonts.set(key,font)
    const id=createHash('sha256').update(key).update(face.sfnt).digest('hex')
    faces.push({id,family:face.typeface,bold,italic,bytes:face.sfnt})
  }
  const metrics=fonts.size?new OpentypeMetrics(style=>
    fonts.get(styleKey(style.fontFamily,style.bold,style.italic)) ??
    fonts.get(styleKey(style.fontFamily,false,false)),
  ):undefined
  return {metrics,faces}
}
