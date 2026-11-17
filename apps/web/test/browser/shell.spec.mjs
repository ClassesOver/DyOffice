import {test,expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {copyFile,mkdir} from 'node:fs/promises';
test('original shell import, fail-closed retired DOCX, return, theme and independent Admin',async({page})=>{
 await mkdir('test-results',{recursive:true});
 // Original repository help screenshot: a historical visual reference, not a fresh desktop run.
 await copyFile(fileURLToPath(new URL('../../../shell/src/renderer/src/i18n/help/topics/img/home-screen.en.png',import.meta.url)),'test-results/original-genoffice-home-reference.png');
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await page.getByLabel('个人访问令牌').fill('visual-test-user');await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.locator('.logo-lockup')).toHaveAttribute('alt','GenOffice');
 await expect(page.locator('.tab-bar')).toBeVisible();
 await expect(page.locator('.quick-card')).toHaveCount(5);
 await expect(page.locator('.sidebar')).toHaveCSS('width','232px');
 await page.screenshot({path:'test-results/genoffice-web-home.png',fullPage:true});
 const rejected=page.waitForResponse(r=>/\/api\/v1\/files\/[^/]+\/docx$/.test(new URL(r.url()).pathname));
 const writes=[];page.on('request',r=>{if(/\/api\/v1\/files\/[^/]+\/(docx|uploads|commits)$/.test(new URL(r.url()).pathname)&&r.method()!=='GET')writes.push(r.url())});
 const chooser=page.waitForEvent('filechooser');await page.locator('.quick-card').last().click();
 await (await chooser).setFiles(fileURLToPath(new URL('../../../shell/build/shell-new/blank.docx',import.meta.url)));
 await expect(page.locator('.tab-item')).toHaveCount(2);
 const frame=page.locator('.web-editor-frame');await expect(frame).toBeVisible();
 const denial=await rejected;expect(denial.status()).toBe(501);
 expect(await denial.json()).toMatchObject({code:'DOCUMENT_ISOLATION_UNAVAILABLE'});
 const editor=page.frameLocator('.web-editor-frame');
 await expect(editor.locator('#status')).toContainText('文档解析入口已停用');
 await expect(editor.locator('textarea')).toHaveCount(0);
 await expect(editor.getByRole('button',{name:'保存',exact:true})).toHaveCount(0);
 // The development compatibility page must not resurrect the retired in-process parser.
 expect(writes).toEqual([]);
 await page.locator('.tab-item').first().click();await expect(page.locator('.home')).toBeVisible();await expect(frame).toBeHidden();
 await expect(page.locator('.home').getByText('blank.docx',{exact:true}).first()).toBeVisible();
 await page.locator('.home .star-btn').first().click();
 await expect(page.locator('.home .star-btn').first()).toHaveClass(/starred/);
 await page.locator('.sidebar-nav .nav-item').nth(1).click();
 await expect(page.locator('.home').getByText('blank.docx',{exact:true}).first()).toBeVisible();
 await page.locator('.sidebar-nav .nav-item').first().click();
 await page.screenshot({path:'test-results/genoffice-web-home-with-document.png',fullPage:true});
 await page.locator('.tab-item').nth(1).click();await expect(frame).toBeVisible();
 await page.locator('.tab-item').first().click();
 await page.locator('.account-btn').click();await page.getByLabel('主题',{exact:true}).selectOption('dark');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.screenshot({path:'test-results/genoffice-web-home-dark.png',fullPage:true});
 await page.getByLabel('主题',{exact:true}).selectOption('light');
 await page.locator('.tab-item').nth(1).locator('.tab-close').click();
 await expect(page.locator('.tab-item')).toHaveCount(1);
 expect(writes).toEqual([]);
 for(const index of [0,1,2]){await page.locator('.quick-card').nth(index).click();await expect(page.locator('.tab-item')).toHaveCount(2);await page.locator('.tab-item').nth(1).locator('.tab-close').click();await expect(page.locator('.tab-item')).toHaveCount(1)}
 await page.goto('/admin');await expect(page.getByRole('heading',{name:'dyoffice Admin'})).toBeVisible();
 expect(await page.evaluate(()=>sessionStorage.getItem('dyoffice-admin-token'))).toBeNull();
 expect(errors).toEqual([]);
});

test('native personal settings explicitly save drafts, preserve failed drafts and retry',async({page})=>{
 await page.goto('/');await page.getByLabel('个人访问令牌').fill('visual-test-user');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.locator('.account-btn').click();await page.getByRole('button',{name:'个人设置',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('不是 Genspark 账户登录');
 await page.screenshot({path:'test-results/genoffice-web-settings-account.png',fullPage:true});
 await dialog.getByRole('button',{name:'通用',exact:true}).click();
 await expect(dialog.locator('#set-author-name')).toBeEnabled();
 await dialog.locator('#set-author-name').fill('Web settings browser author');
 const saved=page.waitForResponse(r=>r.url().endsWith('/api/preferences')&&r.request().method()==='PUT');
 await dialog.getByRole('button',{name:'保存个人偏好',exact:true}).click();expect((await saved).ok()).toBe(true);
 await dialog.locator('.set-pane').evaluate(el=>{el.scrollTop=0});
 await expect(dialog.getByText('灰色项目尚未适配 Web。',{exact:false})).toBeVisible();
 await page.screenshot({path:'test-results/genoffice-web-settings-general.png',fullPage:true});
 await dialog.locator('#set-author-name').scrollIntoViewIfNeeded();
 await page.screenshot({path:'test-results/genoffice-web-settings-general-files.png',fullPage:true});
 await expect(dialog.locator('.set-nav-item:disabled')).toHaveCount(5);
 await dialog.locator('.set-close').click();
 await page.locator('.account-btn').click();await page.getByRole('button',{name:'个人设置',exact:true}).click();
 await dialog.getByRole('button',{name:'通用',exact:true}).click();
 await expect(dialog.locator('#set-author-name')).toHaveValue('Web settings browser author');
 const auto=dialog.getByRole('switch',{name:'所有文档自动保存',exact:true});await expect(auto).toHaveAttribute('aria-checked',/^(true|false)$/);const before=await auto.getAttribute('aria-checked');
 await page.route('**/api/preferences',route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'settings write unavailable'})}):route.continue());
 await auto.click();
 const draft=before==='true'?'false':'true';
 await expect(auto).toHaveAttribute('aria-checked',draft);
 const failed=page.waitForResponse(r=>r.url().endsWith('/api/preferences')&&r.request().method()==='PUT');
 await dialog.getByRole('button',{name:'保存个人偏好',exact:true}).click();expect((await failed).status()).toBe(503);
 await expect(dialog.getByRole('alert')).toHaveText('settings write unavailable');
 // A failed explicit save keeps the draft, rather than pretending to roll it back or persist it.
 await expect(auto).toHaveAttribute('aria-checked',draft);
 await page.unroute('**/api/preferences');
 const retry=page.waitForResponse(r=>r.url().endsWith('/api/preferences')&&r.request().method()==='PUT');
 await dialog.getByRole('button',{name:'保存个人偏好',exact:true}).click();expect((await retry).ok()).toBe(true);
 await dialog.locator('.set-close').click();
 await page.locator('.account-btn').click();await page.getByRole('button',{name:'个人设置',exact:true}).click();
 await dialog.getByRole('button',{name:'通用',exact:true}).click();
 await expect(dialog.getByRole('switch',{name:'所有文档自动保存',exact:true})).toHaveAttribute('aria-checked',draft);
 await expect(dialog.locator('#set-author-name')).toHaveValue('Web settings browser author');

});


test('PDF shell opens CJK with same-origin CMaps and no parser writes', async ({page}) => {
 const {cjkPdf} = await import('../fixtures/cjk-pdf.mjs');
 const errors=[]; page.on('pageerror', error=>errors.push(error.message));
 await page.goto('/'); await page.getByLabel('个人访问令牌').fill('visual-test-user'); await page.getByRole('button',{name:'登录',exact:true}).click();
 const chooser=page.waitForEvent('filechooser'); await page.locator('.quick-card').last().click();
 await (await chooser).setFiles({name:'cjk-review.pdf',mimeType:'application/pdf',buffer:await cjkPdf()});
 const frame=page.locator('.web-editor-frame'); await expect(frame).toHaveAttribute('src',/^\/pdf.html\?file=/);
 const pdf=page.frameLocator('.web-editor-frame'); await expect(pdf.locator('#status')).toContainText('已按原始字节打开');
 await expect(pdf.locator('.pdf-text')).toHaveText('中文'); await expect(pdf.locator('canvas')).toHaveCount(1);
 await page.screenshot({path:'test-results/genoffice-web-pdf-cjk.png',fullPage:true});
 await page.locator('.tab-item').nth(1).locator('.tab-close').click(); await expect(page.locator('.web-editor-frame')).toHaveCount(0);
 expect(errors).toEqual([]);
});
