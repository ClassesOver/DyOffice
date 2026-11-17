import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
async function connect(overrides={}){const dir=await mkdtemp(join(tmpdir(),'rust-tls-call-'));try{const input=join(dir,'input.json'),output=join(dir,'output.json');await writeFile(input,JSON.stringify({host:'localhost',port:Number(process.env.TLS_TEST_PORT),database:'postgres',user:'testadmin',schema:'public',mode:'connect',output,ca:process.env.TLS_TEST_CA,...overrides}),{mode:0o600});await exec(process.env.RUST_PG_TEST_BINARY,['--exact','dispatch_ledger::integration::child','--ignored','--nocapture'],{env:{PATH:process.env.PATH,DOCUMENT_PG_FIXTURE_FILE:input},timeout:10000,maxBuffer:8192});return JSON.parse(await readFile(output,'utf8'))}finally{await rm(dir,{recursive:true,force:true})}}
test('actual TLS trusted CA and hostname succeeds',async()=>assert.deepEqual(await connect(),{connected:true}))
test('actual TLS wrong CA fails without plaintext fallback',async()=>assert.deepEqual(await connect({ca:process.env.TLS_TEST_WRONG_CA}),{error:'Unavailable'}))
test('actual TLS wrong hostname fails without plaintext fallback',async()=>assert.deepEqual(await connect({host:'127.0.0.1'}),{error:'Unavailable'}))
test('TLS required refuses real PostgreSQL plaintext-only endpoint',async()=>assert.deepEqual(await connect({port:Number(process.env.TLS_PLAIN_PORT)}),{error:'Unavailable'}))
