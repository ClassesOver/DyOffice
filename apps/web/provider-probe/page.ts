import type {createAdminAiProbeController} from '../../../packages/browser-host/src/ai-probe.ts'
type Client=ReturnType<typeof createAdminAiProbeController>
export function mountProviderProbe(root:HTMLElement,client:Client){
 const document=root.ownerDocument
 function element<K extends keyof HTMLElementTagNameMap>(tag:K,text=''){const node=document.createElement(tag);node.textContent=text;return node}
 const title=element('h1','管理员合成探针'),notice=element('p','本地实验 · 仅发送固定 hello 合成文本，不读取文档，不执行工具。完成不等于真实模型已验收。'),select=element('select'),label=element('label','模型 '),status=element('p','正在读取配置…'),output=element('pre'),home=element('a','返回首页')
 select.setAttribute('aria-label','模型');label.append(select);status.setAttribute('role','status');status.setAttribute('aria-live','polite');output.setAttribute('aria-label','合成响应');home.href='/'
 function button(action:string,text:string){const b=element('button',text);b.type='button';b.dataset.action=action;return b}
 const start=button('start','运行固定探针'),cancel=button('cancel','取消'),refresh=button('refresh','刷新配置')
 root.replaceChildren(title,notice,label,start,cancel,refresh,status,output,home)
 let disposed=false,running=false,loading=false,generation=0,failed=false,canceled=false
 function controls(){select.disabled=disposed||running||loading;start.disabled=disposed||running||loading||!select.value;cancel.disabled=disposed||!running||canceled;refresh.disabled=disposed||running||loading}
 async function load(){if(disposed||running||loading)return;const current=++generation;loading=true;status.textContent='正在读取配置…';controls();try{const result=await client.status();if(disposed||current!==generation)return;select.replaceChildren(...result.entries.map(e=>{const o=element('option',e.label);o.value=e.id;return o}));status.textContent=result.entries.length?'就绪：等待手动运行固定合成文本。':'没有可用的实验模型。'}catch{if(!disposed&&current===generation){select.replaceChildren();status.textContent='无法读取配置，请确认已登录管理员账户且实验功能已启用。'}}finally{if(!disposed&&current===generation){loading=false;controls()}}}
 start.onclick=()=>{if(disposed||running||loading||!select.value)return;const current=++generation;running=true;failed=false;canceled=false;output.textContent='';status.textContent='正在运行固定合成探针…';controls();try{client.run(select.value,{
  onDelta(text){if(disposed||current!==generation||canceled||failed)return;if((output.textContent?.length??0)+text.length>65536){failed=true;status.textContent='响应过长，已请求取消。';client.cancel();return}output.append(document.createTextNode(text))},
  onError(){if(disposed||current!==generation||canceled)return;failed=true;status.textContent='探针失败；没有验证真实模型可用性。'},
  onDone(){if(disposed||current!==generation)return;running=false;if(!failed&&!canceled)status.textContent='合成响应流已结束；这不是生产或真实模型验收。';controls()},
 })}catch{running=false;failed=true;status.textContent='无法启动探针，请刷新配置后重试。';controls()}}
 cancel.onclick=()=>{if(disposed||!running||canceled)return;canceled=true;status.textContent='已请求取消；已发送的请求无法撤回。';controls();client.cancel()}
 refresh.onclick=()=>{void load()};select.onchange=controls
 controls();void load()
 return {dispose(){if(disposed)return;disposed=true;generation++;client.dispose();controls();start.onclick=null;cancel.onclick=null;refresh.onclick=null;select.onchange=null}}
}
/** A BFCache-restored page has a disposed controller; reload only its read-only UI. */
export function bindProbeLifecycle(target:Pick<Window,'addEventListener'>|EventTarget,dispose:()=>void,reload:()=>void){
 target.addEventListener('pagehide',dispose,{once:true})
 target.addEventListener('pageshow',event=>{if((event as PageTransitionEvent).persisted)reload()})
}
