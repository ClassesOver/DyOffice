import { sendJson } from './http-response.mjs';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createStore } from './store.mjs';
import { withMcp } from './mcp.mjs';
import { createStaticAssets } from './static-assets.mjs';
import { serveReadOnlyFiles } from './readonly-files.mjs';
const formats=new Set(['docx','xlsx','pptx','pdf']);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const object=v=>v && typeof v==='object' && !Array.isArray(v);
function fields(value,allowed) { if(!object(value) || Object.keys(value).some(k=>!allowed.includes(k))) fail('配置包含不支持的字段'); }
function httpUrl(value) {
  let url; try {url=new URL(value);} catch {fail('请输入有效的 HTTP 地址');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password) fail('仅支持无内嵌凭据的 HTTP/HTTPS 地址');
  return url.toString();
}
async function bytes(request,limit=1024*1024) {let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>limit) fail('请求内容过大',413);chunks.push(chunk);}return Buffer.concat(chunks);}
const body=async req=>{try{return JSON.parse((await bytes(req)).toString());}catch(e){if(e.status)throw e;fail('JSON 格式无效');}};
function sameToken(a,b){const x=Buffer.from(a||'');const y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
const publicModel=({id,model,enabled})=>({id,model,enabled});

export async function createApplication({directory,userToken,adminToken,encryptionKey,assetMode,assetDirectory}) {
  if(process.env.NODE_ENV==='production') throw new Error('Development token server is not allowed in production');
  if(!userToken||!adminToken||userToken===adminToken) throw new Error('Personal and admin tokens must be distinct and nonempty');
  const serveStatic=await createStaticAssets({assetMode,assetDirectory});
  const store=await createStore(directory,encryptionKey); const filePath=join(directory,'files');await mkdir(filePath,{recursive:true,mode:0o700});
  return createServer(async(req,res)=>{
    // Generate locally: client-supplied IDs can contain secrets or collide across requests.
    const requestId=randomUUID();res.setHeader('X-Request-ID',requestId);
    const send=(value,status=200)=>sendJson(res,status,value);
    try {
      const url=new URL(req.url,'http://localhost');const path=url.pathname;
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      if(!path.startsWith('/api/')) {
        if(await serveStatic(req,res,path)) return;
        return send({error:'页面不存在'},404);
      }
      const token=req.headers.authorization?.replace(/^Bearer /,'');const admin=sameToken(token,adminToken);
      if(!admin&&!sameToken(token,userToken)) return send({error:'请登录'},401);
      if(path.startsWith('/api/admin/')&&!admin) return send({error:'需要管理员权限'},403);
      const personalResource=path==='/api/preferences'||path==='/api/sources'||path==='/api/files'||path.startsWith('/api/files/')||path==='/api/v1/capabilities'||path.startsWith('/api/v1/files/');
      if(admin&&personalResource) return send({error:'需要个人工作区权限'},403);
      const state=store.read();
      if(await serveReadOnlyFiles(req,res,{url,state,filePath})) return;
      if(path==='/api/preferences') {
        if(req.method==='GET') return send(state.preferences);
        if(req.method==='PUT') {
          const value=await body(req);fields(value,['theme','language','authorName','autoSave','showAssistant']);
          if(value.theme!==undefined&&!['light','dark','system'].includes(value.theme))fail('主题无效');
          if(value.language!==undefined&&!['zh','en'].includes(value.language))fail('语言无效');
          for(const key of ['autoSave','showAssistant'])if(value[key]!==undefined&&typeof value[key]!=='boolean')fail('偏好值无效');
          if(value.authorName!==undefined&&(typeof value.authorName!=='string'||value.authorName.length>100))fail('作者名称无效');
          await store.update(s=>Object.assign(s.preferences,value));return send(store.read().preferences);
        }
      }
      if(path==='/api/models'&&req.method==='GET') return send(state.admin.models.filter(m=>m.enabled).map(publicModel));
      if(path==='/api/admin/config') {
        const redact=s=>({...s,apiKey:undefined,secret:undefined,hasKey:Boolean(s.secret)});
        if(req.method==='GET') return send({models:state.admin.models.map(redact),mcp:state.admin.mcp.map(redact)});
        if(req.method==='PUT') {
          const value=await body(req);fields(value,['models','mcp']);
          let next;
          await store.update(s=>{
            next={...s.admin};
            for(const kind of ['models','mcp']) if(value[kind]!==undefined) {
              if(!Array.isArray(value[kind])||value[kind].length>50)fail('配置列表无效');
              const ids=new Set();
              next[kind]=value[kind].map(item=>{
                fields(item,kind==='models'?['id','model','baseUrl','apiKey','enabled']:['id','transport','url','apiKey','enabled']);
                if(typeof item.id!=='string'||!item.id.trim()||item.id.length>100||ids.has(item.id))fail('配置 ID 无效或重复');ids.add(item.id);
                if(item.enabled!==undefined&&typeof item.enabled!=='boolean')fail('启用状态无效');
                if(item.apiKey!==undefined&&(typeof item.apiKey!=='string'||item.apiKey.length>8192))fail('密钥格式无效');
                const previous=s.admin[kind].find(x=>x.id===item.id);
                const result={id:item.id,enabled:item.enabled??true,secret:item.apiKey===undefined?previous?.secret:item.apiKey?store.seal(item.apiKey):undefined};
                if(kind==='mcp'){if(item.transport!=='http')fail('MCP 仅支持 HTTP');return {...result,transport:'http',url:httpUrl(item.url)};}
                if(typeof item.model!=='string'||!item.model.trim())fail('模型名称不能为空');
                return {...result,model:item.model,baseUrl:httpUrl(item.baseUrl)};
              });
            }
            s.admin=next;
          });return send({models:next.models.map(redact),mcp:next.mcp.map(redact)});
        }
      }
      const mcpMatch=path.match(/^\/api\/admin\/mcp\/([^/]+)\/test$/);
      if(mcpMatch&&req.method==='POST') {
        const entry=state.admin.mcp.find(x=>x.id===decodeURIComponent(mcpMatch[1]));
        if(!entry)fail('MCP 服务不存在',404);
        try { return send(await withMcp(entry,entry.secret?store.unseal(entry.secret):undefined,async client=>({ok:true,tools:(await client.listTools()).tools.map(({name,description})=>({name,description}))}))); }
        catch {fail('MCP HTTP 连接失败，请检查地址和鉴权',502);}
      }
      if(path==='/api/sources') {
        if(req.method==='GET')return send(state.sources.map(({secret,...s})=>({...s,hasKey:!!secret})));
        if(req.method==='PUT') {
          const value=await body(req);fields(value,['id','name','url','apiKey']);
          if(typeof value.name!=='string'||!value.name.trim()||value.name.length>200)fail('数据源名称无效');
          if(value.apiKey!==undefined&&typeof value.apiKey!=='string')fail('密钥格式无效');
          const id=value.id??randomUUID();if(typeof id!=='string')fail('数据源 ID 无效');
          const previous=state.sources.find(s=>s.id===id);
          const source={id,name:value.name,url:httpUrl(value.url),secret:value.apiKey===undefined?previous?.secret:value.apiKey?store.seal(value.apiKey):undefined};
          await store.update(s=>{s.sources=s.sources.filter(x=>x.id!==id);s.sources.push(source);});return send({id});
        }
      }
      if(path==='/api/files') {
        if(req.method==='GET')return send(state.files);
        if(req.method==='POST') {
          let name;try{name=decodeURIComponent(req.headers['x-file-name']||'');}catch{fail('文件名无效');}
          const format=extname(name).slice(1).toLowerCase();if(!formats.has(format)||name.length>255||/[\\/\x00-\x1f]/.test(name))fail('仅支持 DOCX、XLSX、PPTX、PDF');
          const content=await bytes(req,50*1024*1024);if(!content.length)fail('文件为空');
          if(format==='pdf'?!content.subarray(0,5).equals(Buffer.from('%PDF-')):!content.subarray(0,2).equals(Buffer.from('PK')))fail('文件内容与格式不匹配');
          const file={id:randomUUID(),name,format,size:content.length,updatedAt:new Date().toISOString()};
          await writeFile(join(filePath,file.id),content,{mode:0o600});
          try{await store.update(s=>s.files.push(file));}catch(e){await unlink(join(filePath,file.id));throw e;}return send(file,201);
        }
      }
      const fileMatch=path.match(/^\/api\/files\/([a-zA-Z0-9-]+)$/);
      if(fileMatch&&req.method==='GET') {
        const file=state.files.find(f=>f.id===fileMatch[1]);if(!file)fail('文件不存在',404);
        res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
        return res.end(await readFile(join(filePath,file.id)));
      }
      return send({error:'接口不存在'},404);
    } catch(error) {send({error:error.status?error.message:'服务暂时不可用'},error.status||500);}
  });
}
