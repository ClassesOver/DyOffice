import {afterEach,expect,test} from 'vitest'
import {hideAccountRecoveryPortals} from '../../src/shell/account-recovery-portals'
afterEach(()=>{document.body.innerHTML=''})
test('session recovery hides and disables custom Home and AntD portals without removing their nodes',()=>{
 document.body.innerHTML='<div class="row-menu" role="menu" style="display:block"><button>打开</button></div><div class="folder-menu" role="menu"><button>新建文件夹</button></div><div class="ant-modal-root"><input type="password"/></div><div class="ant-dropdown"><button>个人设置</button></div><main class="account-session-recovery"><button>重新加载</button></main>'
 const portals=[...document.querySelectorAll<HTMLElement>('.row-menu,.folder-menu,.ant-modal-root,.ant-dropdown')]
 const cleanup=hideAccountRecoveryPortals()
 for(const portal of portals){expect(portal.isConnected).toBe(true);expect(portal.inert).toBe(true);expect(portal.style.display).toBe('none');expect(portal.style.visibility).toBe('hidden')}
 expect(document.querySelector<HTMLElement>('.account-session-recovery')?.style.display).toBe('')
 cleanup()
 for(const portal of portals){expect(portal.style.visibility).toBe('');expect(portal.inert).not.toBe(true)}
 expect(portals[0].style.display).toBe('block');expect(portals[1].style.display).toBe('')
})
test('hiding an active account modal transfers keyboard focus to the recovery action after portals are disabled',()=>{
 document.body.innerHTML='<div class="ant-modal-root"><input aria-label="旧密码表单" /></div><main class="account-session-recovery" role="alertdialog"><button>重新加载并核对登录状态</button></main>'
 const password=document.querySelector<HTMLInputElement>('input')!,recovery=document.querySelector<HTMLButtonElement>('.account-session-recovery button')!,portal=document.querySelector<HTMLElement>('.ant-modal-root')!
 password.focus();expect(document.activeElement).toBe(password)
 let hiddenAtFocus=false
 recovery.addEventListener('focus',()=>{hiddenAtFocus=portal.inert&&portal.style.display==='none'})
 const cleanup=hideAccountRecoveryPortals()
 try{expect(document.activeElement).toBe(recovery);expect(hiddenAtFocus).toBe(true)}finally{cleanup()}
})
