import type {SlidesApi,VideoFileWrite} from '../../../slides/src/shared/ipc'
import {browserFileName,downloadBrowserFile} from './browser-download'

const BLOCK_BYTES=1024*1024
const MAX_VIDEO_BYTES=128*BLOCK_BYTES

type VideoFile={id:number;name:string;size:number;blocks:Map<number,Uint8Array<ArrayBuffer>>}

/** Emulate the muxer's positioned file writes, including its final MP4 header patches. */
export function createBrowserVideoFiles(canDownload:()=>boolean,download=downloadBrowserFile){
  let nextId=0
  let file:VideoFile|undefined
  const nameFor=(name:string)=>browserFileName(name.replace(/\.mp4$/i,''),'Presentation')+'.mp4'
  const api:Pick<SlidesApi,'pickExportVideoPath'|'videoFileOpen'|'videoFileWrite'|'videoFileClose'>={
    async pickExportVideoPath(name){return canDownload()?nameFor(name):null},
    async videoFileOpen(name){
      if(file||!canDownload())throw Error('Video export is unavailable.')
      file={id:++nextId,name:nameFor(name),size:0,blocks:new Map()}
      return file.id
    },
    async videoFileWrite({id,data,position}:VideoFileWrite){
      if(!file||file.id!==id||!canDownload())throw Error('Video export is no longer active.')
      const end=position+data.byteLength
      if(!Number.isSafeInteger(position)||position<0||end>MAX_VIDEO_BYTES){
        file=undefined
        throw Error('The video exceeded the 128 MiB browser export limit.')
      }
      for(let offset=0;offset<data.byteLength;){
        const at=position+offset,index=Math.floor(at/BLOCK_BYTES),within=at%BLOCK_BYTES
        const count=Math.min(data.byteLength-offset,BLOCK_BYTES-within)
        let block=file.blocks.get(index)
        if(!block){block=new Uint8Array(BLOCK_BYTES);file.blocks.set(index,block)}
        block.set(data.subarray(offset,offset+count),within)
        offset+=count
      }
      file.size=Math.max(file.size,end)
    },
    async videoFileClose(id,discard){
      if(!file||file.id!==id){if(discard)return;throw Error('Video export is no longer active.')}
      const video=file
      file=undefined
      if(discard)return
      if(!video.size||!canDownload())throw Error('Video export is no longer active.')
      const parts:Uint8Array<ArrayBuffer>[]=[]
      for(let offset=0;offset<video.size;offset+=BLOCK_BYTES){
        const count=Math.min(BLOCK_BYTES,video.size-offset)
        const block=video.blocks.get(offset/BLOCK_BYTES)
        parts.push(block?.subarray(0,count)??new Uint8Array(count))
      }
      download(new Blob(parts,{type:'video/mp4'}),video.name)
    },
  }
  return {api,active:()=>file!==undefined,dispose:()=>{file=undefined}}
}
