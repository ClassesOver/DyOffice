import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {officeBrowserAsset as dist} from '../helpers/office-browser-assets.mjs'
import {createStaticAssets} from '../../server/static-assets.mjs'
import {launchTestBrowser} from '../helpers/browser.mjs'

test('built XLSX entry imports its schemas without eval under the native CSP',{timeout:30000},async t=>{
 const assets=await createStaticAssets({assetMode:'built',assetDirectory:process.env.DYOFFICE_TEST_SHEETS_DIST??process.env.DYOFFICE_TEST_SHEETS_DIRECTORY??dist('sheets'),pages:['index.html'],assetInventory:'.vite/native-assets.json'})
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' blob:")
  if(req.url.startsWith('/native-xlsx/')){
   try{if(await assets(req,res,new URL(req.url,'http://localhost').pathname.slice('/native-xlsx'.length)))return}catch{}
   res.writeHead(404);res.end();return
  }
  res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Unauthorized'}))
 })
 let browser
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 browser=await launchTestBrowser();const page=await browser.newPage(),errors=[]
 page.on('pageerror',error=>errors.push(error.message))
 await page.addInitScript(()=>{globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>globalThis.cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}))})
 await page.goto(`http://127.0.0.1:${server.address().port}/native-xlsx/?fileId=synthetic`)
 // 拒绝登录是夹具行为；到达明确错误界面证明所有入口模块已执行。
 await page.getByText('无法打开文档。',{exact:true}).waitFor()
 assert.deepEqual(errors,[])
 assert.deepEqual((await page.evaluate(()=>globalThis.cspViolations)).filter(event=>event.blocked==='eval'),[])
})
