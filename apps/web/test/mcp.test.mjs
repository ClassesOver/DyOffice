import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {withMcp} from '../server/mcp.mjs';

test('uses real HTTP MCP handshake, bearer authentication and tool discovery',async t=>{
  let calls=0;
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer secret');calls++;
    const mcp=new McpServer({name:'test',version:'1.0.0'});
    mcp.registerTool('ping',{description:'Connectivity test'},async()=>({content:[{type:'text',text:'pong'}]}));
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{transport.close();mcp.close();});
    await mcp.connect(transport);
    await transport.handleRequest(req,res);
  });
  server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await withMcp({url:`http://127.0.0.1:${server.address().port}/mcp`},'secret',client=>client.listTools());
  assert.deepEqual(result.tools.map(t=>t.name),['ping']);assert.ok(calls>=2);
});

async function delayedDiscoveryServer(t) {
  let started, closed;
  const toolsStarted=new Promise(resolve=>{started=resolve;});
  const toolsClosed=new Promise(resolve=>{closed=resolve;});
  const timers=new Set();let calls=0;
  const server=createServer(async(req,res)=>{
    calls++;
    if(req.method==='GET'){res.writeHead(405);return res.end();}
    let raw='';for await(const part of req)raw+=part;
    const message=JSON.parse(raw);
    if(message.id===undefined){res.writeHead(202);return res.end();}
    const reply=result=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));};
    if(message.method==='initialize')return reply({protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'deadline-test',version:'1'}});
    if(message.method==='tools/list'){
      res.on('close',()=>closed({cancelled:!res.writableFinished}));
      started();
      const timer=setTimeout(()=>{timers.delete(timer);reply({tools:[]});},1500);timers.add(timer);
      res.on('close',()=>{clearTimeout(timer);timers.delete(timer);});
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return {url:`http://127.0.0.1:${server.address().port}/mcp`,toolsStarted,toolsClosed,calls:()=>calls};
}

test('deadline aborts discovery after initialization and releases the pending HTTP response', {timeout:5000}, async t=>{
  const fixture=await delayedDiscoveryServer(t);
  await assert.rejects(withMcp({url:fixture.url},undefined,client=>client.listTools(),{timeoutMs:500}),error=>error.name==='TimeoutError');
  assert.equal((await fixture.toolsClosed).cancelled,true);
});

test('caller cancellation aborts MCP discovery and releases its connection', {timeout:5000}, async t=>{
  const fixture=await delayedDiscoveryServer(t);const controller=new AbortController();
  const outcome=withMcp({url:fixture.url},undefined,client=>client.listTools(),{timeoutMs:5000,signal:controller.signal});
  const rejected=assert.rejects(outcome,error=>error.name==='AbortError');
  await fixture.toolsStarted;controller.abort();
  await rejected;assert.equal((await fixture.toolsClosed).cancelled,true);
});

test('an already cancelled MCP request performs no network I/O', {timeout:5000}, async t=>{
  const fixture=await delayedDiscoveryServer(t);const controller=new AbortController();controller.abort();
  await assert.rejects(withMcp({url:fixture.url},undefined,client=>client.listTools(),{signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(fixture.calls(),0);
});
