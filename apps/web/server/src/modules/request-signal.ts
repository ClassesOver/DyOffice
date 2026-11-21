import type {FastifyReply,FastifyRequest} from 'fastify'

/** Runs `operation` with a signal that aborts when the client disconnects before the reply is written. */
export async function withDisconnect<T>(request:FastifyRequest,reply:FastifyReply,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),abort=()=>controller.abort()
  const onClose=()=>{if(!reply.raw.writableFinished)abort()}
  request.raw.once('aborted',abort);reply.raw.once('close',onClose)
  try{
    if(request.raw.aborted||reply.raw.destroyed)abort()
    return await operation(controller.signal)
  }finally{
    request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',onClose)
  }
}
