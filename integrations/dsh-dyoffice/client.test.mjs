import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'

test('creation success and failure do not open the DyOffice sidebar',async()=>{
  const opened=[]
  let executed
  const client=await readFile(new URL('./client.js',import.meta.url),'utf8')
  runInNewContext(client,{URL,window:{__ModuleLoader__:{load({factory}){
    factory(()=>({})).apply({
      locale:{bind(){}}, effect(){},
      on(_,listener){executed=listener},
      sidebarRight:{openTab(tab){opened.push(tab)}},
    })
  }}}})
  executed('session','dyoffice',{kind:'success',text:'已创建 demo.docx\nhttps://office.example/#/file/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})
  executed('session','dyoffice',{kind:'success',text:'已创建 demo.docx\njavascript:alert(1)'})
  executed('session','dyoffice',{kind:'error',text:'创建未获授权'})
  executed('session','dyoffice',{kind:'error',text:'创建文档失败：连接中断'})
  assert.deepEqual(opened,[])
})

test('a DyOffice command activates a fresh conversation without activating it for other commands',async()=>{
  let events,view,activate
  const activated=[]
  runInNewContext(await readFile(new URL('./client.js',import.meta.url),'utf8'),{URL,AbortController,document:{addEventListener(){}},
    window:{location:{href:'http://localhost/'},__ModuleLoader__:{load({factory}){
      factory(()=>({useRef:()=>({current:null}),useState:x=>[x,()=>{}],useEffect:f=>{activate=f}})).apply({
        effect:f=>f(),on(){},locale:{bind(){},register(){}},sidebarRightTabs:{register(){}},
        slots:{inject:(_,f)=>f(),register:(spec,render)=>{if(spec.name==='conversation.input.overlay')render({sessionId:'new'})}},
        uiConversation:{events:{register:v=>{events=v}},views:{register:v=>{view=v}},binding:id=>({activate:target=>activated.push([id,target])})},
      })
    }}},fetch:()=>new Promise(()=>{})})
  activate()
  assert.deepEqual(activated,[['new',view.target]])
  assert.equal(events.match({type:'command/run',data:{commandId:'1',name:'help'}}),null)
  assert.equal(events.match({type:'command/run',data:{commandId:'2',name:'dyoffice'}}).id,'2')
  const projection=view.create()
  assert.equal(view.isActive(projection.empty),false)
  assert.equal(view.isActive(projection.apply({upserts:[events.buildViewNode({id:'2'})]})),true)
  assert.equal(view.isActive(projection.replace({nodes:[]})),false)
})

test('a delivered thumbnail opens in the right preview only on click',async()=>{
  const slots=new Map(),opened=[]
  const react={createElement:(component,props,...children)=>({component,props,children}),useEffect:f=>f(),useState:x=>[x,()=>{}]}
  runInNewContext(await readFile(new URL('./client.js',import.meta.url),'utf8'),{URL,window:{location:{href:'http://localhost/'},__ModuleLoader__:{load({factory}){
    factory(()=>react).apply({locale:{bind(){},register(){}},effect:f=>f(),on(){},sidebarRightTabs:{register(){}},
      uiConversation:{views:{register(){}},events:{register(){}}},
      slots:{inject:(_,f)=>f(),register:(spec,component)=>{
        if(spec.name==='conversation.chat.turnTail')assert.equal(spec.id,'dyoffice-snapshot')
        slots.set(spec.name,component)
      }}})
  }}}})
  const turn={turn:1,end:{time:Date.now()},data:{get:()=>({presented:[{path:'one.docx'},{path:'two.pdf'},{path:'one.docx'}]})}}
  const props={turn,sessionId:'session-test',openFile:path=>opened.push(path),t:k=>k}
  const render=slots.get('conversation.chat.turnTail')
  const result=render(props);render(props)
  assert.deepEqual(opened,[])
  assert.equal(result.children.length,2)
  const second=result.children[1],button=second.component(second.props)
  assert.equal(new URL(button.children[0].props.src).searchParams.get('snapshot'),'two.pdf')
  button.props.onClick()
  assert.deepEqual(opened,['two.pdf'])
})

test('the DSH sidebar can sync the bound Word document from its editor window',async()=>{
  const slots=new Map(),effects=[],messages=[]
  const fileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin='https://office.example'
  const value={origin,selectedFile:null,canEdit:true,tasks:[],href:origin+'/#/file/'+fileId,
    preview:{fileId,name:'demo.docx',format:'docx',text:'内容'}}
  const popup={closed:false,postMessage:(...args)=>messages.push(args)}
  let stateIndex=0
  const react={createElement:(component,props,...children)=>({component,props,children}),useRef:()=>({current:null}),
    useState:initial=>[stateIndex++===0?value:initial,()=>{}],useEffect:effect=>effects.push(effect),
    useSyncExternalStore:(_subscribe,read)=>read()}
  runInNewContext(await readFile(new URL('./client.js',import.meta.url),'utf8'),{
    URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,
    window:{location:{href:'http://localhost:3080/',origin:'http://localhost:3080'},
      addEventListener(){},removeEventListener(){},open:url=>{assert.equal(url,value.href);return popup},
      __ModuleLoader__:{load({factory}){factory(()=>react).apply({
        locale:{bind(){},register(){}},effect:effect=>effect(),on(){},sidebarRightTabs:{register(){}},
        uiConversation:{views:{register(){}},events:{register(){}}},
        slots:{inject:(_,effect)=>effect(),register:(spec,component)=>slots.set(spec.name,component)},
      })}},
    },
  })
  const {component,props}=slots.get('sidebar.right.pane.tab')({useTabInfo:()=>({tab:{visible:true}}),t:key=>key})
  const findButton=node=>node?.component==='button'&&node.children.includes('syncEdit')?node:
    node?.children?.flat().map(findButton).find(Boolean)
  findButton(component(props)).props.onClick()
  stateIndex=0
  effects.length=0
  assert.equal(findButton(component(props)),undefined)
  const stop=effects[2]()
  try {
    assert.equal(messages.length,1)
    assert.equal(messages[0][0].type,'dsh-dyoffice:draft-request')
    assert.equal(messages[0][0].fileId,fileId)
    assert.equal(messages[0][1],origin)
  } finally {stop?.()}
})

for(const text of ['', 'Existing saved document'])test(`restored writing ${text?'preserves saved content':'starts automatically without a window'}`,async()=>{
  const slots=new Map(),effects=[]
  let overlay
  const fileId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const react={createElement:(component,props,...children)=>({component,props,children}),useRef:()=>({current:null}),useState:x=>[x,()=>{}],useEffect:f=>effects.push(f),useSyncExternalStore:(_subscribe,read)=>read()}
  runInNewContext(await readFile(new URL('./client.js',import.meta.url),'utf8'),{URL,AbortController,crypto:globalThis.crypto,
    fetch:async()=>({ok:true,json:async()=>({preview:{fileId,revision:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',text},writing:{topic:'Write a report'}})}),
    window:{location:{href:'http://localhost:3080/',origin:'http://localhost:3080'},open(){assert.fail('must not open a popup')},__ModuleLoader__:{load({factory}){
      factory(()=>react).apply({locale:{bind(){},register(){}},effect:f=>f(),on(){},sidebarRightTabs:{register(){}},
        uiConversation:{views:{register(){}},events:{register(){}}},
        slots:{inject:(_,f)=>f(),register:(spec,component)=>{slots.set(spec.name,component)}}})
    }}}})
  const props={node:{outcome:{kind:'success',text:'已创建 report.docx\nhttp://localhost:3081/#/file/'+fileId}},sessionId:'session',t:k=>k}
  const render=slots.get('conversation.chat.commandview')
  render(props)
  for(const effect of effects.splice(0))effect()
  await new Promise(resolve=>setImmediate(resolve))
  render(props)
  for(const effect of effects.splice(0))effect()
  overlay=slots.get('shell.overlay')({t:k=>k})
  assert.equal(overlay.length,text?0:1)
  if(text)return
  assert.equal(overlay[0].props.remote,true)
  assert.equal(overlay[0].props.createdDocuments.read().fileId,fileId)
})
