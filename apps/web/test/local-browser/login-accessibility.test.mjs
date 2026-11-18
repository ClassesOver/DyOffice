import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {build} from 'esbuild'
import {expect} from '@playwright/test'
import {launchTestBrowser} from '../helpers/browser.mjs'

// Render the actual Login component in isolation. Authentication remains deferred
// so both pending and the loading icon's exit can be checked without a database.
const source=await readFile(new URL('../../src/shell/local-main.tsx',import.meta.url),'utf8')
const login=source.slice(source.indexOf('function Login('),source.indexOf('function Root('))
const {outputFiles}=await build({write:false,bundle:true,platform:'browser',format:'iife',stdin:{resolveDir:new URL('../..',import.meta.url).pathname,loader:'tsx',contents:`
 import React,{useState} from 'react'
 import {createRoot} from 'react-dom/client'
 import {Alert,Button,Card,ConfigProvider,Form,Input,Typography} from 'antd'
 const logo='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'
 const PasswordActionForm=()=>null
 let finishLogin,failLogin,finishRestore,calls=0,completed=0
 const client={login:()=>{calls++;return new Promise((resolve,reject)=>{finishLogin=resolve;failLogin=reject})}}
 const restore=()=>new Promise(resolve=>{finishRestore=resolve})
 ${login}
 window.fixture={calls:()=>calls,completed:()=>completed,fail:()=>failLogin(Object.assign(Error('rejected'),{status:401})),succeed:()=>finishLogin(),restore:()=>finishRestore()}
 createRoot(document.getElementById('app')).render(<ConfigProvider button={{autoInsertSpace:false}}><Login done={()=>{completed++}}/></ConfigProvider>)
 `}})

test('login keeps its accessible name through loading and permits the original role-based retry',{timeout:30_000},async t=>{
 const browser=await launchTestBrowser();t.after(()=>browser.close())
 const page=await browser.newPage();await page.setContent('<div id="app"></div>');await page.addScriptTag({content:outputFiles[0].text})
 await page.getByLabel('用户名',{exact:true}).fill('alice');await page.getByLabel('密码',{exact:true}).fill('synthetic password')
 await page.getByRole('button',{name:'登录',exact:true}).click()
 const submit=page.locator('button[type=submit]')
 await expect(submit).toHaveClass(/ant-btn-loading/)
 await expect(submit).toHaveAccessibleName('登录')
 await expect(submit).toHaveAttribute('aria-busy','true')
 await page.getByRole('button',{name:'登录',exact:true}).click()
 assert.equal(await page.evaluate(()=>window.fixture.calls()),1)
 await page.evaluate(()=>window.fixture.fail())
 await expect(submit).toHaveAttribute('aria-busy','false')
 await expect(submit).toHaveAccessibleName('登录')
 await expect(page.getByLabel('用户名',{exact:true})).toBeEnabled()
 await page.getByRole('button',{name:'登录',exact:true}).click()
 assert.equal(await page.evaluate(()=>window.fixture.calls()),2)
 await page.evaluate(()=>window.fixture.succeed())
 await expect(submit).toHaveAccessibleName('重新加载工作区')
 await expect(submit).toHaveAttribute('aria-busy','true')
 await page.evaluate(()=>window.fixture.restore())
 await expect(submit).toHaveAttribute('aria-busy','false')
 assert.equal(await page.evaluate(()=>window.fixture.completed()),1)
})
