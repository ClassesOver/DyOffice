import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function workspaceAliases(){
 const packages=fileURLToPath(new URL('../../packages/',import.meta.url));
 return readdirSync(packages,{withFileTypes:true}).filter(x=>x.isDirectory()).flatMap(x=>{
 const dir=resolve(packages,x.name);let m;try{m=JSON.parse(readFileSync(resolve(dir,'package.json'),'utf8'))}catch{return []}
 return Object.entries(typeof m.exports==='string'?{'.':m.exports}:m.exports||{}).filter(([,v])=>typeof v==='string').map(([key,v])=>{
 const name=key==='.'?m.name:m.name+key.slice(1);
 const pattern=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace('\\*','(.*)');
 return {find:new RegExp('^'+pattern+'$'),replacement:resolve(dir,v).replace('*','$1')};
 });
 });
}
