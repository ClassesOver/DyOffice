import {expect,test,vi} from 'vitest'
import {createBrowserVideoFiles} from '../../src/editors/slides-browser-video'

test('browser MP4 output applies positioned rewrites across block boundaries',async()=>{
  const download=vi.fn()
  const {api,active}=createBrowserVideoFiles(()=>true,download)
  const name=await api.pickExportVideoPath('Deck?.mp4')
  expect(name).toBe('Deck_.mp4')
  const id=await api.videoFileOpen(name!)
  const tail=1024*1024-2
  await api.videoFileWrite({id,position:tail,data:Uint8Array.of(1,2,3,4)})
  await api.videoFileWrite({id,position:tail+1,data:Uint8Array.of(9,8)})
  await api.videoFileClose(id,false)
  expect(active()).toBe(false)
  const [blob,filename]=download.mock.calls[0] as [Blob,string]
  expect(filename).toBe('Deck_.mp4')
  expect(blob.type).toBe('video/mp4')
  expect(blob.size).toBe(tail+4)
  const reader=new FileReader()
  const tailBytes=await new Promise<ArrayBuffer>((resolve,reject)=>{
    reader.onload=()=>resolve(reader.result as ArrayBuffer)
    reader.onerror=reject
    reader.readAsArrayBuffer(blob.slice(tail))
  })
  expect([...new Uint8Array(tailBytes)]).toEqual([1,9,8,4])
})

test('discard, overflow, and lost authorization never download partial video',async()=>{
  const download=vi.fn()
  let allowed=true
  const {api,active}=createBrowserVideoFiles(()=>allowed,download)
  let id=await api.videoFileOpen('cancelled.mp4')
  await api.videoFileClose(id,true)
  expect(active()).toBe(false)
  id=await api.videoFileOpen('oversized.mp4')
  await expect(api.videoFileWrite({id,position:128*1024*1024,data:Uint8Array.of(1)})).rejects.toThrow('128 MiB')
  expect(active()).toBe(false)
  id=await api.videoFileOpen('revoked.mp4')
  await api.videoFileWrite({id,position:0,data:Uint8Array.of(1,2,3)})
  allowed=false
  await expect(api.videoFileClose(id,false)).rejects.toThrow('no longer active')
  expect(active()).toBe(false)
  expect(download).not.toHaveBeenCalled()
})
