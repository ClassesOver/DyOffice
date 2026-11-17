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
