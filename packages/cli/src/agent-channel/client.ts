import {CliError, EXIT} from '../result'

const MAX_BYTES=256*1024
export class ChannelClient {
  readonly origin: string
  constructor(origin: string) {
    const url=new URL(origin)
    if(url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
      !(url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
      throw new CliError(EXIT.usage,'Channel origin requires HTTPS (HTTP is allowed only on loopback)')
    this.origin=url.origin
  }
  async request<T=Record<string,unknown>>(method: 'GET'|'POST',path: string,token?: string,body?: unknown): Promise<T> {
    if(!/^\/(applications|members)(\/[^/?#]+)*$/.test(path))throw new CliError(EXIT.usage,'Invalid channel API path')
    const payload=body===undefined ? undefined : JSON.stringify(body)
    if(payload && Buffer.byteLength(payload)>MAX_BYTES)throw new CliError(EXIT.usage,'Channel request exceeds byte limit')
    let response: Response
    try {
      response=await fetch(`${this.origin}/api/v1/assistant-channels${path}`,{method,redirect:'error',credentials:'omit',
        signal:AbortSignal.timeout(30_000),headers:{accept:'application/json',...(payload?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{})},body:payload})
    } catch {throw new CliError(EXIT.app,'Channel request failed (network, redirect, or timeout)')}
    if(!response.ok){await response.body?.cancel();throw new CliError(EXIT.app,`Channel request rejected (${response.status})`)}
    const reader=response.body?.getReader(); const chunks: Uint8Array[]=[]; let length=0
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw new CliError(EXIT.app,'Channel response exceeds byte limit')}chunks.push(value)}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T}catch{throw new CliError(EXIT.app,'Channel returned invalid JSON')}
  }
}
