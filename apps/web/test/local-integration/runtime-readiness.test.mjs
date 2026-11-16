import test from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { createReadinessProbe } from '../../server/src/readiness.ts'
import { createApiShell } from '../../server/src/framework.ts'
import { registerHealthRoutes } from '../../server/src/modules/health/routes.ts'

test('real database connection failure makes readiness unavailable without changing liveness',async()=>{
 const connectionString=process.env.DYOFFICE_TEST_DATABASE_URL
 assert.ok(connectionString,'Real disposable PostgreSQL required')
 assert.ok(['127.0.0.1','localhost'].includes(new URL(connectionString).hostname),'Only disposable loopback database allowed')
 const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:1000})
 const app=await createApiShell();registerHealthRoutes(app,createReadinessProbe({identityReady:async()=>{},businessPool:pool}));await app.ready()
 let ended=false
 try {
 assert.equal((await app.inject('/api/v1/health/ready')).statusCode,200)
 await pool.end();ended=true
 const response=await app.inject('/api/v1/health/ready');assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{state:'unavailable'})
 assert.equal((await app.inject('/api/v1/health/live')).statusCode,200)
 }finally{await app.close();if(!ended)await pool.end()}
})
test('real PostgreSQL rejects a missing database and readiness safely returns unavailable',async()=>{
 const connectionString=process.env.DYOFFICE_TEST_DATABASE_URL
 assert.ok(connectionString,'Real disposable PostgreSQL required')
 const url=new URL(connectionString);assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'Only disposable loopback database allowed')
 url.pathname='/dyoffice_readiness_missing_'+(await import('node:crypto')).randomUUID().replaceAll('-','')
 const pool=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:1000})
 const app=await createApiShell();registerHealthRoutes(app,createReadinessProbe({identityReady:async()=>{},businessPool:pool}));await app.ready()
 try{const response=await app.inject('/api/v1/health/ready');assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{state:'unavailable'});assert.equal(response.body.includes(url.pathname),false);assert.equal((await app.inject('/api/v1/health/live')).statusCode,200)}finally{await app.close();await pool.end()}
})
