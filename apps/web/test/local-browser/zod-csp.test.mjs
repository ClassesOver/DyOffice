import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {build} from 'esbuild'
import {fileURLToPath} from 'node:url'
import {launchTestBrowser} from '../helpers/browser.mjs'

test('Web schema validation runs under strict CSP without probing eval',async t=>{
 const result=await build({stdin:{contents:`import './apps/web/src/editors/zod-csp.ts'; import {z} from 'zod'; const schema=z.object({value:z.number()}); globalThis.schemaResult=[schema.safeParse({value:1}).success,schema.safeParse({value:'x'}).success]`,resolveDir:fileURLToPath(new URL('../../../../',import.meta.url)),sourcefile:'csp-entry.ts'},bundle:true,write:false,format:'esm',platform:'browser'})
 const code=result.outputFiles[0].text
 const server=createServer((req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'")
  res.setHeader('Content-Type',req.url==='/app.js'?'text/javascript':'text/html')
  res.end(req.url==='/app.js'?code:'<!doctype html><script type="module" src="/app.js"></script>')
 })
 let browser
 t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 browser=await launchTestBrowser();const page=await browser.newPage()
 await page.addInitScript(()=>{globalThis.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>globalThis.cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}))})
 await page.goto(`http://127.0.0.1:${server.address().port}`)
 await page.waitForFunction(()=>globalThis.schemaResult)
 assert.deepEqual(await page.evaluate(()=>globalThis.schemaResult),[true,false])
 assert.deepEqual(await page.evaluate(()=>globalThis.cspViolations),[])
})
