import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function withMcp(server, secret, action, {timeoutMs=15000,signal}={}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647) throw new RangeError('Invalid MCP deadline');
  const controller=new AbortController();
  const deadline=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
  deadline.throwIfAborted();
  const client=new Client({name:'dyoffice',version:'0.1.0'});
  let onAbort;
  const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(deadline.reason);deadline.addEventListener('abort',onAbort,{once:true});});
  const timer=setTimeout(()=>controller.abort(new DOMException('MCP operation timed out','TimeoutError')),timeoutMs);
  try {
    const transport=new StreamableHTTPClientTransport(new URL(server.url),{
      requestInit:{headers:secret?{Authorization:`Bearer ${secret}`}:{}},
      // The SDK replaces requestInit.signal. Compose its lifecycle signal at fetch time instead.
      fetch:(input,init={})=>fetch(input,{...init,signal:init.signal?AbortSignal.any([deadline,init.signal]):deadline}),
    });
    return await Promise.race([
      (async()=>{await client.connect(transport,{timeout:timeoutMs});deadline.throwIfAborted();return await action(client);})(),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);deadline.removeEventListener('abort',onAbort);
    await client.close().catch(()=>{});
  }
}
