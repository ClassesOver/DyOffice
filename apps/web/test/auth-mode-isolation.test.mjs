import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertModularConfig } from '../server/src/config.mjs'
const shell = {env:'test',logger:false,rateLimit:{max:20,windowMs:60000},readyCheck:async()=>true}
const legacy = {serveStatic(){},store:{read(){throw Error('shared store must not be read')}},credentials:{userToken:'personal',adminToken:'admin'}}
const auth = {authenticate(){throw Error('must not authenticate invalid startup')}}
test('session authentication cannot be mounted over the shared development workspace',()=>{
 assert.throws(()=>assertModularConfig({...shell,legacy,auth}),/cannot combine.*auth.*legacy/i)
})
test('standalone development and session shells remain valid',()=>{
 assert.ok(assertModularConfig({...shell,legacy}).legacy)
 assert.ok(assertModularConfig({...shell,auth}).auth)
})

test('real Fastify startup rejects mixed mode before reading shared state or authenticating',async()=>{
 const {buildApp}=await import('../server/src/app.mjs')
 await assert.rejects(buildApp({...shell,legacy,auth}),/cannot combine.*auth.*legacy/i)
})
