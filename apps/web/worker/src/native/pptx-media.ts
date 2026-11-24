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
