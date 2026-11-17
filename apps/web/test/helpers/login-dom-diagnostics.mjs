// Failure-only, fixed-schema UI state. Never read input values or arbitrary text.
export function loginDomSnapshot() {
 const count = selector => Math.min(100,document.querySelectorAll(selector).length)
 const buttons=[...document.querySelectorAll('button[type="submit"]')]
 return {
  login:count('.dy-login'),home:count('.home'),recovery:count('.account-session-recovery'),
  passwordAction:count('section[aria-label="激活或重置密码"]'),
  forms:count('.dy-login form'),inputs:count('.dy-login input'),disabledInputs:count('.dy-login input:disabled'),
  submits:Math.min(100,buttons.length),disabledSubmits:Math.min(100,buttons.filter(b=>b.disabled).length),
  loadingSubmits:Math.min(100,buttons.filter(b=>b.classList.contains('ant-btn-loading')).length),
  loginLabel:buttons.some(b=>b.textContent==='登录'),spacedLoginLabel:buttons.some(b=>b.textContent==='登 录'),
  reloadLabel:buttons.some(b=>b.textContent==='重新加载工作区'),
 }
}
const countKeys=['login','home','recovery','passwordAction','forms','inputs','disabledInputs','submits','disabledSubmits','loadingSubmits']
const flagKeys=['loginLabel','spacedLoginLabel','reloadLabel']
export async function reportLoginDom(page,emit=line=>console.error(line)) {
 let timer
 try {
  const result=await Promise.race([page.evaluate(loginDomSnapshot),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1000)})])
  const snapshot={available:result!==null&&typeof result==='object'}
  if(snapshot.available){
   for(const key of countKeys)if(Number.isInteger(result[key])&&result[key]>=0&&result[key]<=100)snapshot[key]=result[key]
   for(const key of flagKeys)if(typeof result[key]==='boolean')snapshot[key]=result[key]
  }
  emit('login-dom '+JSON.stringify(snapshot))
 }catch{try{emit('login-dom {"available":false}')}catch{}}
 finally{clearTimeout(timer)}
}
