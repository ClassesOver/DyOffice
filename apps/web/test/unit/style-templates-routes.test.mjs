import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import {registerStyleTemplateRoutes} from '../../server/src/modules/style-templates/routes.ts'

test('style template routes require a session and strict CSRF-protected writes',async t=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false,useDefaults:false}}}),calls=[],sessions={async authenticate(token){calls.push(['auth',token]);if(!token)throw Object.assign(Error('unauthorized'),{statusCode:401})}},csrf={requireSessionRead(request,token){calls.push(['read',token]);if(!token||request.headers['x-csrf-token']!=='b'.repeat(43))throw Object.assign(Error('csrf'),{statusCode:403})},requireSession(request,token){calls.push(['write',token]);if(!token||request.headers['x-csrf-token']!=='b'.repeat(43))throw Object.assign(Error('csrf'),{statusCode:403})}}
 const service={list:async token=>{calls.push(['list',token]);return []},load:async(token,name)=>({ok:true,topic:'Topic',styleSkill:'Style',...(name==='Demo'?{layout:{canvas:{w:1280,h:720}}}:{})}),save:async(token,name,value)=>{calls.push(['save',token,name,value]);return {ok:true}}}
 registerStyleTemplateRoutes(app,service,sessions,csrf)
 t.after(()=>app.close())
 const headers={cookie:'__Host-dyoffice-session='+'a'.repeat(43),'x-csrf-token':'b'.repeat(43),origin:'https://office.example'}
 assert.equal((await app.inject({url:'/api/v1/ai/style-templates'})).statusCode,401)
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/ai/style-templates',headers:{cookie:headers.cookie},payload:{name:'Demo',topic:'Topic',styleSkill:'Style',createdAt:'2026-11-19T00:00:00.000Z'}})).statusCode,403)
 assert.deepEqual((await app.inject({url:'/api/v1/ai/style-templates',headers})).json(),[])
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/ai/style-templates',headers,payload:{name:'Demo / Q4',topic:'Topic',styleSkill:'Style',createdAt:'2026-11-19T00:00:00.000Z',layout:{canvas:{w:1280,h:720}}}})).statusCode,200)
 assert.deepEqual((await app.inject({url:'/api/v1/ai/style-templates/load?name=Demo',headers})).json(),{ok:true,topic:'Topic',styleSkill:'Style',layout:{canvas:{w:1280,h:720}}})
 assert.equal((await app.inject({method:'PUT',url:'/api/v1/ai/style-templates',headers,payload:{name:'Demo',topic:'Topic',styleSkill:'Style',createdAt:'2026-11-19T00:00:00.000Z',ownerId:'other'}})).statusCode,400)
 assert.ok(calls.some(call=>call[0]==='write'))
})
