import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
import {PNG} from 'pngjs'
import {createSessionFileHost} from '../../../../packages/browser-host/src/files.ts'
import {launchTestBrowser} from '../helpers/browser.mjs'
import {createSlidesMockServer} from '../native-slides/mock-slides-server.mjs'

test('PPTX converts generated, linked and attached WebP to PNG for native slide operations', {timeout:30000}, async t => {
  const script = await build({entryPoints:[fileURLToPath(new URL('../../src/editors/slides-bridge.ts',import.meta.url))],bundle:true,format:'iife',globalName:'SlidesBridge',write:false,logLevel:'silent'})
  const browser = await launchTestBrowser()
  t.after(()=>browser.close())
  const page = await browser.newPage()
  const server = createSlidesMockServer({slideCount:1})
  const host = createSessionFileHost({fetchImpl:server.fetchImpl})
  t.after(()=>host.dispose())
  const {fileId} = server.file(), requests=[]
  await host.open(fileId)
  await host.acquireLease(fileId)
  await page.exposeFunction('slidesFetch',async(url,init)=>{
    if(url.endsWith('/media')||url.endsWith('/generate-page'))requests.push(JSON.parse(init.body))
    const response=await server.fetchImpl(url,init)
    return {status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()}
  })
  const origin='http://localhost:4285'
  await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>PPTX media test</title>'}))
  await page.goto(origin)
  await page.addScriptTag({content:script.outputFiles[0].text})
  const outcome = await page.evaluate(async ({fileId,state})=>{
    const base64='UklGRhwAAABXRUJQVlA4TA8AAAAvA8AAAAcQ/Y/+ByKi/wEA'
    const link='https://images.example/square.webp',broken='https://images.example/broken.webp'
    const bridge=SlidesBridge.createSlidesBridge({getState:()=>state},fileId,{language:'en',theme:'light'},{
      fetchImpl:async(url,init)=>{const {status,headers,body}=await slidesFetch(url,{method:init.method,headers:init.headers,body:init.body});return new Response(body,{status,headers})},
      mediaApi:{
        async generateImage({prompt}){return {url:'data:image/webp;base64,'+(prompt==='broken'?'AAAA':base64)}},
        async fetchImage(url){return {mime:'image/webp',base64:url===broken?'AAAA':base64}},
      },
    })
    try {
      await bridge.api.openPptx(1280)
      const generated=await bridge.api.generateImage({prompt:'generate'})
      if(!generated.url)return {generated}
      const insert=url=>bridge.api.insertImageUrl({slideIndex:0,url,xPx:10,yPx:10,wPx:50,hPx:50,fitWidthPx:1280})
      const embedded=await insert(generated.url)
      const replaced=await bridge.api.replacePictureUrl({slideIndex:0,sourceId:embedded.sourceId,url:link})
      const attach=bytes=>bridge.api.insertImageUrl({slideIndex:0,base64:bytes,ext:'webp',xPx:65,yPx:10,wPx:50,hPx:50,fitWidthPx:1280})
      const attached=await attach(base64)
      const replacedAttachment=await bridge.api.replacePictureUrl({slideIndex:0,sourceId:embedded.sourceId,base64,ext:'webp',keepSrcRect:true})
      const invalidAttachment=await attach('AAAA')
      const prepared=await bridge.api.localGeneratePage({specJson:JSON.stringify({elements:[generated.url,link].map(url=>({type:'image',url,x:10,y:10,w:50,h:50}))})})
      const landed=await bridge.api.landGeneratedPages([prepared.marker],1280,'append')
      return {generated,replaced:!!replaced,attached:!!attached,replacedAttachment:!!replacedAttachment,invalidAttachment,pictures:landed.slides[1].nodes.length,broken:await insert(broken),invalid:await bridge.api.generateImage({prompt:'broken'})}
    }finally{bridge.dispose()}
  },{fileId,state:host.getState(fileId)})
  assert.match(outcome.generated.url,/^https:\/\/generated-image\.invalid\//)
  assert.match(outcome.generated.previewUrl,/^data:image\/png;base64,/)
  assert.equal(outcome.replaced,true)
  assert.equal(outcome.attached,true)
  assert.equal(outcome.replacedAttachment,true)
  assert.equal(outcome.invalidAttachment,null)
  assert.equal(outcome.pictures,2)
  assert.equal(outcome.broken,null)
  assert.match(outcome.invalid.error,/WebP/)
  assert.equal(requests.length,5)
  assert.equal(requests[3].keepSrcRect,true)
  for(const image of requests.flatMap(request=>request.images??[request])){
    assert.equal(image.ext,'png')
    const png=PNG.sync.read(Buffer.from(image.bytesBase64,'base64'))
    assert.deepEqual([png.width,png.height,...png.data.subarray(0,4)],[4,4,255,0,0,255])
  }
})
