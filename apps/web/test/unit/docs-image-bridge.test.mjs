import assert from 'node:assert/strict'
import {test} from 'node:test'
import {JSDOM} from 'jsdom'
import {createDocsBridge} from '../../src/editors/docs-bridge.ts'

const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNgqP//HwAEfwJ+bbED2gAAAABJRU5ErkJggg=='
const webp='UklGRj4AAABXRUJQVlA4IDIAAADQAQCdASoFAAUAAUAmJaACdLoB+AADsAD+8JCj/4cp8OU+HKf8OU/9QZ8tD5aH63AAAA=='
const bridge=()=>createDocsBridge({getState:()=>({name:'test.docx'})},'file',{language:'en'},()=>{})

test('Word Web downloads an embedded WebP in its original format',async t=>{
 const dom=new JSDOM('',{url:'https://office.example/'})
 const previous={window:globalThis.window,document:globalThis.document}
 globalThis.window=dom.window
 globalThis.document=dom.window.document
 t.after(()=>{Object.assign(globalThis,previous);dom.window.close()})
 let filename
 t.mock.method(dom.window.HTMLAnchorElement.prototype,'click',function(){filename=this.download})
 const {api}=bridge()
 assert.deepEqual(await api.saveImageAs('data:image/webp;base64,'+webp),{ok:true})
 assert.equal(filename,'image.webp')
})

test('Word Web reads same-origin clipboard images without following redirects',async t=>{
 const previous=globalThis.window
 globalThis.window={location:{href:'https://office.example/native-docx/',origin:'https://office.example'}}
 t.after(()=>{globalThis.window=previous})
 const response=new Response(Buffer.from(base64,'base64'),{headers:{'content-type':'image/png'}})
 const fetch=t.mock.method(globalThis,'fetch',async()=>response)
 const {api}=bridge()
 assert.deepEqual(await api.fetchClipboardImage('https://office.example/pixel.png'),{mime:'image/png',base64})
 assert.equal(fetch.mock.calls[0].arguments[1].redirect,'error')
 await assert.rejects(()=>api.fetchClipboardImage('file:///tmp/pixel.png'))
 assert.equal(fetch.mock.callCount(),1)
})
