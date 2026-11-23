import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import {chromium} from 'playwright-core'
import {workspaceAliases} from '../../workspace-aliases.mjs'

test('real Chromium renders channel sharing and saved task results at desktop and mobile widths',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),output=await mkdtemp(join(tmpdir(),'dyoffice-background-ui-'))
 t.after(()=>rm(output,{recursive:true,force:true}))
 await build({configFile:false,root,define:{'process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic',jsxDev:false},resolve:{alias:workspaceAliases(),dedupe:['react','react-dom']},build:{outDir:output,emptyOutDir:true,lib:{entry:join(root,'apps/web/test/fixtures/background-workspace-preview.tsx'),name:'Preview',formats:['iife'],fileName:()=> 'preview.js'},cssCodeSplit:false},logLevel:'error'})
 const css=(await readdir(output)).find(name=>name.endsWith('.css'))
 const server=createServer(async(req,res)=>{
  if(req.url==='/'||req.url.startsWith('/?')){res.setHeader('content-type','text/html');res.end(`<html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/${css}"><style>html,body{margin:0;font:14px sans-serif}</style><div id="root"></div><script src="/preview.js"></script></html>`);return}
  const name=req.url.slice(1)
  if(![css,'preview.js'].includes(name)){res.writeHead(404).end();return}
  res.setHeader('content-type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join(output,name)))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close())
 for(const width of [1280,360]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:'+server.address().port)
  await page.getByRole('button',{name:'创建频道',exact:true}).click()
  await page.getByRole('checkbox',{name:'允许 DSH 在我的工作区创建新文档'}).check()
  await page.getByRole('button',{name:'生成 DSH 授权 Token',exact:true}).click()
  assert.equal(await page.getByLabel('DSH 授权 Token',{exact:true}).inputValue(),'synthetic-dsh-token')
  await page.getByText('DSH 验证实例 · 已授权，离线',{exact:true}).waitFor()
  await page.getByRole('button',{name:'选择授权文档',exact:true}).click()
  await page.getByRole('combobox',{name:'授权的文档'}).selectOption('file')
  await page.getByRole('button',{name:'允许后台读取已保存版本',exact:true}).click()
  await page.getByRole('button',{name:'关闭后台读取',exact:true}).waitFor()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'channel page overflows at '+width)
  await page.getByRole('button',{name:'后台任务入口',exact:true}).click()
  await page.getByRole('button',{name:'查看结果',exact:true}).click()
  await page.getByText('已保存版本预算为42万元',{exact:true}).waitFor()
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'task page overflows at '+width)
  assert.deepEqual(errors,[])
  await page.close()
  const stress=await browser.newPage({viewport:{width,height:900}})
  await stress.goto('http://127.0.0.1:'+server.address().port+'/?stress=1&failure=1')
  await stress.getByRole('navigation',{name:'频道列表',exact:true}).getByRole('button').first().click()
  if(width<640){await stress.getByRole('button',{name:'返回频道列表',exact:true}).click();assert.ok(await stress.getByRole('navigation',{name:'频道列表',exact:true}).getByRole('button').first().evaluate(element=>document.activeElement===element));await stress.getByRole('navigation',{name:'频道列表',exact:true}).getByRole('button').first().click();assert.equal(await stress.getByRole('navigation',{name:'频道列表',exact:true}).isVisible(),false)}
  assert.ok(await stress.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'long channel list overflows at '+width)
  await mkdir('test-results/configuration-layout',{recursive:true})
  await stress.screenshot({animations:'disabled',path:`test-results/configuration-layout/channels-long-${width}.png`})
  await stress.getByRole('button',{name:'后台任务入口',exact:true}).click()
  await stress.getByText('正在加载后台任务…',{exact:true}).waitFor()
  assert.equal(await stress.getByText('暂无后台任务。',{exact:true}).count(),0)
  await stress.getByText('后台任务暂时无法加载。',{exact:true}).waitFor()
  assert.equal(await stress.getByText('暂无后台任务。',{exact:true}).count(),0)
  await stress.getByRole('button',{name:'刷新',exact:true}).click()
  await stress.getByRole('button',{name:'查看结果',exact:true}).last().click()
  const detail=stress.getByRole('article',{name:'任务详情',exact:true})
  assert.ok(await detail.evaluate(element=>document.activeElement===element),'task detail did not receive focus')
  assert.ok((await detail.boundingBox()).y<300,'task detail is outside viewport')
  assert.ok(await stress.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'long task result overflows at '+width)
  await stress.screenshot({animations:'disabled',path:`test-results/configuration-layout/task-result-long-${width}.png`})
  await stress.getByRole('button',{name:'关闭详情',exact:true}).click()
  assert.equal(await stress.getByRole('button',{name:'查看结果',exact:true}).last().evaluate(element=>document.activeElement===element),true)
  await stress.getByLabel('任务状态',{exact:true}).selectOption('running')
  await stress.getByText('没有符合当前状态的任务。',{exact:false}).waitFor()
  await stress.getByRole('button',{name:'查看全部任务',exact:true}).click()
  assert.equal(await stress.getByRole('button',{name:'查看结果',exact:true}).count(),30)
  await stress.close()
 }
})
