import {narrationSpids, type OpenedPptx} from '@genoffice/pptx-engine'
import type {Op} from '@genoffice/pptx-ops'
import {MAX_PPTX_ADVANCE_MS, MAX_PPTX_MEDIA_BYTES, MAX_PPTX_RECORDING_BYTES, MAX_PPTX_RECORDING_SLIDES, type SlidesRecordingCommand} from './pptx-session-host'

const mediaTypes: Readonly<Record<string,string>> = {
  mp4:'video/mp4',m4v:'video/mp4',mov:'video/mp4',webm:'video/webm',avi:'video/x-msvideo',
  mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',aac:'audio/aac',ogg:'audio/ogg',
}

export function embeddedMediaData(opened:OpenedPptx,index:number,sourceId:string) {
  const node=opened.deck.slides[index]?.elements.find(element=>element.id===sourceId)
  if(node?.type!=='picture'||!node.media?.target||node.media.external)return null
  const {kind,target}=node.media
  const ext=target.split('.').at(-1)?.toLowerCase()
  const mime=ext&&Object.hasOwn(mediaTypes,ext)?mediaTypes[ext]:undefined
  if(!mime)return null
  const bytes=opened.archive.readBytes(target)
  if(!bytes?.byteLength||bytes.byteLength>MAX_PPTX_MEDIA_BYTES)return null
  return {kind,dataUrl:`data:${mime};base64,${Buffer.from(bytes).toString('base64')}`}
}

function validRecordingWav(bytes:Uint8Array) {
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<46||bytes.byteLength>MAX_PPTX_MEDIA_BYTES||bytes.byteLength%2!==0)return false
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength)
  const matches=(at:number,tag:string)=>Array.from(tag).every((value,i)=>view.getUint8(at+i)===value.charCodeAt(0))
  const sampleRate=view.getUint32(24,true)
  return matches(0,'RIFF')&&matches(8,'WAVEfmt ')&&matches(36,'data')
    &&view.getUint32(4,true)===bytes.byteLength-8&&view.getUint32(16,true)===16
    &&view.getUint16(20,true)===1&&view.getUint16(22,true)===1
    &&sampleRate>=8000&&sampleRate<=96000&&view.getUint32(28,true)===2*sampleRate
    &&view.getUint16(32,true)===2&&view.getUint16(34,true)===16
    &&view.getUint32(40,true)===bytes.byteLength-44
}

export function recordingOps(opened:OpenedPptx,input:SlidesRecordingCommand):Op[] {
  if(input?.kind!=='save'&&input?.kind!=='clear')throw new Error('INVALID_MEDIA')
  const slides=opened.deck.slides
  if(input.kind==='save'&&(!Array.isArray(input.slides)||input.slides.some(take=>!take)))throw new Error('INVALID_MEDIA')
  const indexes=input.kind==='save'?input.slides.map(take=>take.slideIndex):input.indexes
  if(!Array.isArray(indexes)||!indexes.length||indexes.length>MAX_PPTX_RECORDING_SLIDES||
    new Set(indexes).size!==indexes.length||indexes.some(index=>!Number.isSafeInteger(index)||index<0||index>=slides.length)){
    throw new Error('INVALID_MEDIA')
  }
  if(input.kind==='clear'){
    return indexes.filter(index=>narrationSpids(slides[index]!).length!==0).map(slide=>({op:'clearNarration',target:{slide}}))
  }
  let byteLength=0
  for(const take of input.slides){
    if(!validRecordingWav(take.bytes)||!Number.isSafeInteger(take.durationMs)||take.durationMs<1||
      take.durationMs>MAX_PPTX_ADVANCE_MS||!Number.isSafeInteger(take.advanceMs)||
      take.advanceMs<1||take.advanceMs>MAX_PPTX_ADVANCE_MS)throw new Error('INVALID_MEDIA')
    byteLength+=take.bytes.byteLength
    if(byteLength>MAX_PPTX_RECORDING_BYTES)throw new Error('INPUT_LIMIT')
  }
  return input.slides.flatMap(({slideIndex,bytes,durationMs,advanceMs})=>[
    {op:'addNarration',target:{slide:slideIndex},bytes,ext:'wav',durationMs},
    {op:'setAdvanceTime',target:{slide:slideIndex},ms:advanceMs},
  ])
}
import {AUDIO_EXTS,VIDEO_EXTS} from '../../../../slides/src/shared/media-kinds'
import {audioFrame,videoFrame,videoSize} from '../../../../slides/src/main/video-size'
import type {SlidesMediaInsert} from './pptx-session-host'

export function mediaInsertOp(opened:OpenedPptx,input:SlidesMediaInsert):Op {
  const {slide,kind,ext,bytes,name,fitWidthPx,centerPx}=input
  const extensions:readonly string[]=kind==='video'?VIDEO_EXTS:kind==='audio'?AUDIO_EXTS:[]
  if(!Number.isSafeInteger(slide)||slide<0||slide>=opened.deck.slides.length||!extensions.includes(ext)||
    !(bytes instanceof Uint8Array)||bytes.byteLength<12||bytes.byteLength>MAX_PPTX_MEDIA_BYTES||
    !Number.isInteger(fitWidthPx)||fitWidthPx<320||fitWidthPx>4096||
    (name!==undefined&&(typeof name!=='string'||name.length>255||/[\u0000-\u001f\u007f]/u.test(name)))||
    (centerPx!==undefined&&(!centerPx||![centerPx.x,centerPx.y].every(value=>Number.isFinite(value)&&Math.abs(value)<=100000))))throw Error('INVALID_MEDIA')
  const tag=(offset:number,length:number)=>String.fromCharCode(...bytes.subarray(offset,offset+length))
  const frameSync=bytes[0]===0xff&&(bytes[1]!&0xe0)===0xe0
  const matches=ext==='wav'?tag(0,4)==='RIFF'&&tag(8,4)==='WAVE'
    :ext==='avi'?tag(0,4)==='RIFF'&&tag(8,4)==='AVI '
    :ext==='webm'?bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3
    :ext==='mp3'?tag(0,3)==='ID3'||frameSync
    :ext==='aac'?tag(0,4)==='ADIF'||frameSync
    :ext==='ogg'?tag(0,4)==='OggS'
    :tag(4,4)==='ftyp'||ext==='mov'&&['moov','mdat','wide'].includes(tag(4,4))
  if(!matches)throw Error('INVALID_MEDIA')
  const {cx,cy}=opened.deck.size,size={width:cx,height:cy},scale=cx/fitWidthPx
  const center=centerPx?{x:centerPx.x*scale,y:centerPx.y*scale}:undefined
  const offset=kind==='video'?videoFrame(size,videoSize(bytes,ext),center):audioFrame(size,center)
  return {op:'addMedia',target:{slide},kind,ext,bytes,offset,...(name?{name}:{})}
}
