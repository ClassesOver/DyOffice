import assert from 'node:assert/strict'
import {expect} from '@playwright/test'

// Capture actual renderer nodes/state, not a mocked editor or fabricated draft.
export async function captureRecoveryState(page){
 const home=await page.locator('.home').elementHandle()
 assert.ok(home)
 const search=await home.$('input[type="search"]')
 assert.ok(search)
 const value=await search.inputValue(),url=page.url(),navigations=[]
 const onNavigation=frame=>{if(frame===page.mainFrame())navigations.push(frame.url())}
 page.on('framenavigated',onNavigation)
 return {home,search,value,url,navigations,onNavigation}
}

export async function expectRecoveryThenReload(page,state){
 const recovery=page.getByRole('alertdialog',{name:'登录状态需要核对',exact:true})
 await expect(recovery).toBeVisible()
 await expect(recovery).toContainText('已打开的文档仍保留在当前页面')
 const reload=recovery.getByRole('button',{name:'重新加载并核对登录状态',exact:true})
 await expect(reload).toBeFocused()
 assert.equal(page.url(),state.url)
 assert.deepEqual(state.navigations,[])
 assert.equal(await state.home.evaluate(node=>node.isConnected),true)
 assert.equal(await state.search.inputValue(),state.value)
 assert.equal(await state.home.evaluate(node=>!!node.closest('[inert]')),true)
 await expect(page.locator('.home')).toBeHidden()
 await expect(page.getByLabel('用户名',{exact:true})).toHaveCount(0)
 assert.equal(await page.locator('.ant-modal-root,.ant-dropdown,.row-menu,.folder-menu').evaluateAll(nodes=>nodes.every(node=>node.inert&&node.style.display==='none')),true)
 page.off('framenavigated',state.onNavigation)
 await Promise.all([page.waitForEvent('load'),reload.click()])
 await expect(page.getByLabel('用户名',{exact:true})).toBeVisible()
 await expect(page.locator('.home')).toHaveCount(0)
 await expect(recovery).toHaveCount(0)
}
