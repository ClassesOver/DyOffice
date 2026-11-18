import test from 'node:test'
import assert from 'node:assert/strict'
import {createApiShell} from '../server/src/framework.ts'
import {registerAuthRoutes} from '../server/src/modules/auth/routes.ts'
test('workspace identity is authenticated, deployment-scoped and never returns session credentials',async t=>{
 const app=await createApiShell();t.after(()=>app.close());let denied=false
 registerAuthRoutes(app,{sessions:{async authenticate(){if(denied)throw Object.assign(Error(),{statusCode:401});return {deploymentId:'deployment-a',userId:'user-a',username:'user',displayName:'User',roles:['user'],sessionId:'secret-session'}}},csrf:{},throttle:{},users:{}})
 const result=await app.inject({url:'/api/v1/auth/me'})
 assert.equal(result.statusCode,200);assert.equal(result.json().deploymentId,'deployment-a');assert.equal(JSON.stringify(result.json()).includes('secret-session'),false)
 denied=true;assert.equal((await app.inject({url:'/api/v1/auth/me'})).statusCode,401)
})
