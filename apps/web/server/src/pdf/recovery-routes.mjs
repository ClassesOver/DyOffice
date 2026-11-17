import {cookies} from '../modules/auth/csrf.ts'
import {authError} from '../modules/auth/sessions.ts'
import {uuidSchema,emptyQuerySchema} from '../modules/files/http-schema.ts'

const uuidPattern=new RegExp(uuidSchema.pattern)
/** Optional trusted HTTP composition only; deliberately NOT mounted by app.ts.
 * The lookup adapter must be the existing authenticated T06 receipt reader.
 * POST keeps the private recovery key out of URLs. This route has no execute,
 * upload, commit, abandon or automatic retry endpoint. unresolved is not failure.
 */
export function registerPdfRecoveryRoutes(app,{sessions,csrf,createRequestRecovery}){
  app.register(async api=>{
    api.addHook('onRequest',async(request,reply)=>{
      reply.header('Cache-Control','private, no-store').header('Referrer-Policy','no-referrer')
      const token=cookies(request).session
      if(!token)throw authError(401)
      csrf.requireSession(request,token)
      await sessions.authenticate(token)
    })
    // Never echo a key, token, SQL/native exception or validation body to callers.
    api.setErrorHandler((error,_request,reply)=>{
      const status=Number.isInteger(error.statusCode)&&error.statusCode>=400&&error.statusCode<=599?error.statusCode:500
      return reply.code(status).send({error:'PDF_RECEIPT_LOOKUP_FAILED'})
    })
    api.post('/api/v1/pdf-recovery/lookup',{
      bodyLimit:1024,
      schema:{querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['fileId','idempotencyKey'],properties:{fileId:uuidSchema,idempotencyKey:{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$'}}}},
    },async request=>{
      const {fileId,idempotencyKey}=request.body
      const result=await createRequestRecovery(cookies(request).session).lookup(fileId,idempotencyKey)
      if(result?.state==='unresolved')return {state:'unresolved'}
      const ref=result?.revision
      if(result?.state!=='committed'||!ref||ref.fileId!==fileId.toLowerCase()
        ||typeof ref.revision!=='string'||!uuidPattern.test(ref.revision)
        ||typeof ref.sha256!=='string'||!/^[a-f0-9]{64}$/.test(ref.sha256)
        ||!Number.isSafeInteger(ref.size)||ref.size<1)throw new Error('INVALID_PDF_RECEIPT')
      // Project only the approved receipt fields even if an adapter is miswired.
      return {state:'committed',revision:{fileId:ref.fileId,revision:ref.revision,sha256:ref.sha256,size:ref.size}}
    })
  })
}
