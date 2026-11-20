import test from 'node:test'
import assert from 'node:assert/strict'
import {createStyleTemplateService} from '../../server/src/modules/style-templates/service.ts'

function fixture(){
 const rows=new Map()
 const transactions={sessionIdleMs:1000,async withPrincipalTransaction(_credential,operation){
  const principal={deploymentId:'dep-a',userId:'user-a',scopes:['preferences:read','preferences:write']}
  const client={async query(sql,params=[]){
   if(sql.includes('INSERT INTO user_style_templates')){
    const [deploymentId,ownerId,name,topic,styleSkill,createdAt,layout]=params
    const row={name,topic,styleSkill,createdAt,layout:layout==null?undefined:JSON.parse(layout),ownerId}
    rows.set(ownerId+':'+name,row);return {rows:[{name}],rowCount:1}
   }
   if(sql.includes('count(*)'))return {rows:[{count:0}],rowCount:1}
   if(sql.includes('FROM user_style_templates')&&sql.includes('ORDER BY'))return {rows:[...rows.values()].filter(row=>row.ownerId===principal.userId).map(({name,topic,createdAt})=>({name,topic,created_at:createdAt})),rowCount:rows.size}
   if(sql.includes('FROM user_style_templates')){
    const row=rows.get(principal.userId+':'+params[2]);return {rows:row?[{...row,style_skill:row.styleSkill}]:[],rowCount:row?1:0}
   }
   return {rows:[],rowCount:0}
  }}
  return operation(client,principal)
 }}
 return {service:createStyleTemplateService(transactions),rows}
}

test('style templates save, list and load the GenOffice payload including layout',async()=>{
 const {service}=fixture(),layout={canvas:{w:1280,h:720},cover:{title:{x:40,y:30,w:600,h:90,sizePt:32}}}
 assert.deepEqual(await service.save('a'.repeat(43),'Annual / Report',{topic:'Annual report',styleSkill:'Use teal titles and restrained charts.',createdAt:'2026-11-19T00:00:00.000Z',layout}),{ok:true})
 assert.deepEqual(await service.list('a'.repeat(43)),[{name:'Annual _ Report',topic:'Annual report',createdAt:'2026-11-19T00:00:00.000Z'}])
 assert.deepEqual(await service.load('a'.repeat(43),'Annual / Report'),{ok:true,topic:'Annual report',styleSkill:'Use teal titles and restrained charts.',layout})
})

test('style template service rejects malformed or oversized content before storage',async()=>{
 const {service,rows}=fixture()
 await assert.rejects(service.save('a'.repeat(43),'   ',{topic:'x',styleSkill:'style',createdAt:'2026-11-19T00:00:00.000Z'}),{statusCode:400})
 await assert.rejects(service.save('a'.repeat(43),'valid',{topic:'x',styleSkill:'',createdAt:'2026-11-19T00:00:00.000Z'}),{statusCode:400})
 await assert.rejects(service.save('a'.repeat(43),'valid',{topic:'x',styleSkill:'x'.repeat(262145),createdAt:'2026-11-19T00:00:00.000Z'}),{statusCode:400})
 await assert.rejects(service.save('a'.repeat(43),'valid',{topic:'x',styleSkill:'style',createdAt:'invalid-date',layout:{canvas:{w:NaN,h:1}}}),{statusCode:400})
 await assert.rejects(service.save('a'.repeat(43),'invalid-layout',{topic:'x',styleSkill:'style',createdAt:'2026-11-19T00:00:00.000Z',layout:{canvas:{w:0,h:1}}}),{statusCode:400})
 assert.equal(rows.size,0)
})
