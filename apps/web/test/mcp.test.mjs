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
