import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
// Offline guard for the selector contract. This is not browser acceptance.
test('password completion assertion is scoped to its labelled region, not unrelated dialog status',async()=>{
 const source=await readFile(new URL('../local-browser/session-settings.test.mjs',import.meta.url),'utf8')
 const component=await readFile(new URL('../../src/shell/LocalPasswordForm.tsx',import.meta.url),'utf8')
 assert.ok(source.includes("dialog.getByRole('region',{name:'修改密码',exact:true})"))
 assert.ok(source.includes("passwordRegion.getByRole('status')"))
 assert.ok(!source.includes("dialog.getByRole('status')"))
 assert.ok(source.includes("toHaveText('密码已修改。当前会话已更新，其他旧会话已失效。')"))
 assert.ok(component.includes('aria-labelledby="local-password-title"'))
 assert.ok(component.includes('密码已修改。当前会话已更新，其他旧会话已失效。'))
})
test('browser fixture retains authentication and revocation outcome guards',async()=>{
 const source=await readFile(new URL('../local-browser/session-settings.test.mjs',import.meta.url),'utf8')
 for(const guard of ["me(extra1.token)).statusCode,401", "me(extra2.token)).statusCode,401", "me(token)).statusCode,200", "me(f.bob.token)).statusCode,200", "statusCode,403", "toHaveCount(0)", "me(token)).statusCode,401", "me(beforeRotation)).statusCode,401", "assert.notEqual(token,beforeRotation)", "current.json().user.id,ownerBefore", "await page.reload()"])assert.ok(source.includes(guard),guard)
})
