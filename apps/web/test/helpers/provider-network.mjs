import {EventEmitter} from 'node:events'
import {Readable} from 'node:stream'
import dns from 'node:dns/promises'
import https from 'node:https'

function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
export function mockProviderNetwork(t,chunks,{secureGate,finishGate,upstreamError}={}){
 let writes=0,wire,header;const connected=deferred(),sent=deferred()
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}])
 t.mock.method(https,'request',(_url,options,callback)=>{
  const req=new EventEmitter();req.on('error',()=>{})
  req.setHeader=(name,value)=>{options.headers[name]=value;return req}
  req.destroy=e=>{queueMicrotask(()=>req.emit('error',e??Error('closed')));return req}
  req.end=body=>{writes++;wire=Buffer.from(body);header=options.headers.authorization;sent.resolve();const res=typeof chunks==='function'?chunks():Readable.from(chunks);res.statusCode=200;res.headers={'content-type':'text/event-stream'};queueMicrotask(()=>{if(!finishGate)req.emit('finish');if(upstreamError)req.emit('error',Error(upstreamError));else callback(res)});if(finishGate)finishGate.then(()=>req.emit('finish'));return req}
  queueMicrotask(()=>{const socket=new EventEmitter();Object.assign(socket,{authorized:true,remoteAddress:'8.8.8.8',remotePort:443,destroyed:false,writable:true});req.socket=socket;req.emit('socket',socket);connected.resolve();if(secureGate)secureGate.then(()=>socket.emit('secureConnect'));else socket.emit('secureConnect')})
  return req
 })
 return {connected:connected.promise,sent:sent.promise,get writes(){return writes},get wire(){return wire},get header(){return header}}
}
