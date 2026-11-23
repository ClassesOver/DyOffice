import {test} from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {serveDocumentEditing,EDITING_CAPABILITIES} from '../server/document-editing.mjs'
const exec=promisify(execFile)
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('retired parser requests reject before body, stored bytes, or revision state are touched',async()=>{
  assert.equal(EDITING_CAPABILITIES.docx,'unsupported')
  let touched=false
  const state={get files(){touched=true;throw new Error('state touched')}}
  const ctx={state,store:null,filePath:'/unused',get runtime(){return undefined}}
  for(const [method,action] of [['GET','docx'],['POST','docx'],['POST','uploads']]){
    const req={method,async *[Symbol.asyncIterator](){touched=true;throw new Error('body touched')}}
    await assert.rejects(serveDocumentEditing(req,{}, {...ctx,url:new URL(`http://local/api/v1/files/${id}/${action}`)}),e=>e.status===501&&e.publicCode==='DOCUMENT_ISOLATION_UNAVAILABLE')
  }
  assert.equal(touched,false)
})

test('application import graph cannot load the retired DOCX parser helper',async()=>{
  const app=new URL('../server/src/app.ts',import.meta.url).href
  const parser=new URL('../server/docx-session.mjs',import.meta.url).href
  const loader='export async function resolve(specifier,context,nextResolve){if(specifier.includes("docx-session.mjs"))throw new Error("RETIRED_PARSER_IMPORT");return nextResolve(specifier,context)}'
  const script=`import {register} from 'node:module';register(${JSON.stringify('data:text/javascript,'+encodeURIComponent(loader))});await import(${JSON.stringify(app)});try{await import(${JSON.stringify(parser)});throw new Error('HOOK_NOT_ACTIVE')}catch(e){if(!e.message.includes('RETIRED_PARSER_IMPORT'))throw e}`
  await exec(process.execPath,['--import','tsx','--input-type=module','-e',script],{timeout:15_000,maxBuffer:1024*1024})
})
