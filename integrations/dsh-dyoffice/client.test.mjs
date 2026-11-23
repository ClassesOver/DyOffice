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
