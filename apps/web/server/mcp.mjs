import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function withMcp(server, secret, action) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  const client=new Client({name:'dyoffice',version:'0.1.0'});
  const transport=new StreamableHTTPClientTransport(new URL(server.url),{
    requestInit:{headers:secret?{Authorization:`Bearer ${secret}`}:{},signal:controller.signal},
  });
  try {await client.connect(transport,{timeout:15000});return await action(client);}
  finally {clearTimeout(timer);await client.close().catch(()=>{});}
}
