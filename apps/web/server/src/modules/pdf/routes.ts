import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { SessionService } from '../auth/sessions.ts'
import { cookies, type createCsrfService } from '../auth/csrf.ts'
import { uuidSchema, fileParamsSchema, emptyQuerySchema } from '../files/http-schema.ts'
import {MAX_OCR_BASE64} from '../../pdf/ocr.ts'
import {MAX_PDF_OCR_INSERTS,MAX_PDF_TEXT_INSERTS} from '../../../../../../packages/web-contracts/src/pdf-ocr-bake.ts'
import type { createPdfService, PdfUploadInput, PdfTextUploadInput, PdfAnnotationUploadInput, PdfAnnotationDeleteUploadInput, PdfNoteUpdateUploadInput, PdfPageOpsUploadInput, PdfExtractPagesInput, PdfSplitInput, PdfPageLayoutInput, PdfFormValuesUploadInput, PdfFormFieldsUploadInput, PdfTextInsertsUploadInput, PdfBlockEditsUploadInput, PdfBlockMovesUploadInput, PdfImageEditsUploadInput, PdfImageContentUploadInput, PdfImageBakesUploadInput, PdfStampsUploadInput, PdfReplacePagesInput, PdfRedactedCopyInput, PdfDraftInsertsUploadInput, PdfApplyOpsUploadInput } from './service.ts'

type PdfService = ReturnType<typeof createPdfService>

const operationsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['page', 'degrees'],
    properties: {
      page: { type: 'integer', minimum: 1, maximum: 100 },
      degrees: { type: 'integer', multipleOf: 90 },
    },
  },
}

const mutationProperties = {
  baseRevision: uuidSchema,
  editorId: uuidSchema,
  leaseEpoch: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
  operations: operationsSchema,
}

const applyOpsSnapshotSchema={type:'object',additionalProperties:false,required:['fileId','baseRevision','generation','markups','notes','textInserts','imageEdits','formEdits','formFields','rotations','deleted','order','metadata'],properties:{
            fileId:uuidSchema,baseRevision:uuidSchema,generation:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-1},
            ...Object.fromEntries(['markups','notes','imageEdits','formFields','annotDeletes','noteEdits'].map(key=>[key,{type:'array',maxItems:100,items:{type:'object'}}])),
            textInserts:{type:'array',maxItems:MAX_PDF_OCR_INSERTS+MAX_PDF_TEXT_INSERTS,items:{type:'object'}},
            stampOperations:{type:'array',maxItems:2,items:{type:'object'}},
            savedImageEdits:{type:'array',maxItems:20,items:{type:'object'}},
            textEdits:{type:'array',maxItems:50,items:{type:'object'}},
            annotationAuthor:{type:'string',minLength:1,maxLength:200},
            blankPages:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['pageIndex','width','height'],properties:{pageIndex:{type:'integer',minimum:0,maximum:99},width:{type:'number',minimum:1,maximum:14400},height:{type:'number',minimum:1,maximum:14400}}}},
            formEdits:{type:'object',maxProperties:100},rotations:{type:'object',maxProperties:100},
            deleted:{type:'array',maxItems:99,uniqueItems:true,items:{type:'integer',minimum:0,maximum:99}},
            order:{anyOf:[{type:'null'},{type:'array',maxItems:100,uniqueItems:true,items:{type:'integer',minimum:0,maximum:99}}]},
            metadata:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,properties:Object.fromEntries(['title','author','subject','keywords'].map(key=>[key,{type:'string',maxLength:4000}]))}]},
          }}

async function withDisconnect<T>(request:FastifyRequest,reply:FastifyReply,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
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

export function registerPdfRoutes(
  app: FastifyInstance,
  pdf: PdfService,
  sessions: SessionService,
  csrf: ReturnType<typeof createCsrfService>,
) {
  app.register(async api => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      const token = cookies(request).session ?? ''
      csrf.originCheck(request, true)
      csrf.requireSession(request, token)
      await sessions.authenticate(token)
    })

    api.post('/api/v1/files/:id/pdf/ocr',{
      bodyLimit:MAX_OCR_BASE64+160,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['revision','png'],
        properties:{revision:uuidSchema,png:{type:'string',minLength:44,maxLength:MAX_OCR_BASE64}},
      }},
    },async(request,reply)=>{
      const {revision,png}=request.body as {revision:string;png:string}
      return withDisconnect(request,reply,signal=>pdf.ocr(cookies(request).session??'',(request.params as {id:string}).id,revision,png,signal))
    })

    api.post(
      '/api/v1/files/:id/pdf/inspect',
      {
        bodyLimit: 4096,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['revision'],
            properties: { revision: uuidSchema },
          },
        },
      },
      async (request,reply) => {
        const token = cookies(request).session ?? ''
        const fileId = (request.params as { id: string }).id
        const { revision } = request.body as { revision: string }
        return withDisconnect(request,reply,signal=>pdf.inspect(token, fileId, revision,signal))
      },
    )

    api.post(
      '/api/v1/files/:id/pdf/uploads',
      {
        bodyLimit: 65536,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['baseRevision', 'editorId', 'leaseEpoch', 'operations'],
            properties: mutationProperties,
          },
        },
      },
      async (request,reply) => {
        const token = cookies(request).session ?? ''
        const fileId = (request.params as { id: string }).id
        return withDisconnect(request,reply,signal=>pdf.stageRotate(token, fileId, request.body as PdfUploadInput,signal))
      },
    )

    api.post('/api/v1/files/:id/pdf/page-layout/uploads',{
      bodyLimit:4096,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operation'],properties:{
          baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
          operation:{oneOf:[
            {type:'object',additionalProperties:false,required:['kind','perPage'],properties:{kind:{const:'split'},perPage:{enum:[2,4,9]}}},
            {type:'object',additionalProperties:false,required:['kind','perSheet','direction','separator'],properties:{kind:{const:'merge'},perSheet:{type:'integer',minimum:2,maximum:16},direction:{enum:['horizontal','vertical']},separator:{type:'boolean'}}},
          ]},
        },
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stagePageLayout(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfPageLayoutInput,signal)))

    api.post('/api/v1/files/:id/pdf/split/uploads',{
      bodyLimit:4096,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','pagesPerFile'],properties:{
          baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
          pagesPerFile:{type:'integer',minimum:1,maximum:100},
        },
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageSplit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfSplitInput,signal)))

    api.post('/api/v1/files/:id/pdf/extract-pages/uploads',{
      bodyLimit:4096,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','pages'],properties:{
          baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},
          pages:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'integer',minimum:1,maximum:100}},
          name:{type:'string',minLength:1,maxLength:255,pattern:'\\.[pP][dD][fF]$'},
        },
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageExtractPages(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfExtractPagesInput,signal)))

    for(const staged of [false,true])api.post(
      '/api/v1/files/:id/pdf/page-ops'+(staged?'/uploads':''),
      {
        bodyLimit:65536,
        schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
          type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
          properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:100,items:{oneOf:[
            {type:'object',additionalProperties:false,required:['op','pages','dir'],properties:{op:{const:'rotatePages'},pages:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'integer',minimum:1,maximum:100}},dir:{enum:[-90,90,180]}}},
            {type:'object',additionalProperties:false,required:['op','page'],properties:{op:{const:'deletePage'},page:{type:'integer',minimum:1,maximum:100}}},
            {type:'object',additionalProperties:false,required:['op','order'],properties:{op:{const:'setPageOrder'},order:{anyOf:[{type:'null'},{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'integer',minimum:1,maximum:100}}]}}},
            {type:'object',additionalProperties:false,required:['op','afterPage'],properties:{op:{const:'insertBlankPage'},afterPage:{type:'integer',minimum:0,maximum:100}}},
            {type:'object',additionalProperties:false,required:['op','width','height'],properties:{op:{const:'setPageSize'},width:{type:'number',minimum:72,maximum:14400},height:{type:'number',minimum:72,maximum:14400}}},
            {type:'object',additionalProperties:false,required:['op','pages','left','top','right','bottom'],properties:{op:{const:'cropPages'},pages:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'integer',minimum:1,maximum:100}},left:{type:'number',minimum:0,maximum:1},top:{type:'number',minimum:0,maximum:1},right:{type:'number',minimum:0,maximum:1},bottom:{type:'number',minimum:0,maximum:1}}},
          ]}}},
        }},
      },
      async (request,reply)=>withDisconnect(request,reply,async signal=>staged
        ?pdf.stagePageOps(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfPageOpsUploadInput,signal)
        :pdf.pageOpsAndCommit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfPageOpsUploadInput,signal)),
    )

    api.addSchema({$id:'pdf-image-content',type:'object',additionalProperties:false,required:['base64','mime'],properties:{base64:{type:'string',minLength:4,maxLength:Math.ceil(5*1024*1024/3)*4},mime:{enum:['image/png','image/jpeg']}}})

    api.post('/api/v1/files/:id/pdf/image-previews/query',{
      bodyLimit:32768,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision','operation'],
        properties:{revision:uuidSchema,operation:{type:'object'}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryImagePreview(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryImagePreview']>[2],signal)))

    api.post('/api/v1/files/:id/pdf/images/query',{
      bodyLimit:4096,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision'],properties:{revision:uuidSchema}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryImages(cookies(request).session??'',(request.params as {id:string}).id,request.body as {revision:string},signal)))

    const redactPatternsSchema={type:'array',minItems:1,maxItems:6,items:{enum:['phone','email','credit-card','ssn','date','iban']}}
    api.post('/api/v1/files/:id/pdf/redactions/query',{
      bodyLimit:4096,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision'],properties:{revision:uuidSchema,patterns:redactPatternsSchema}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryRedactions(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryRedactions']>[2],signal)))
    api.post('/api/v1/files/:id/pdf/redacted-copy/uploads',{
      bodyLimit:65536,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch'],oneOf:[{required:['ids']},{required:['regions'],not:{required:['patterns']}}],properties:{baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:mutationProperties.leaseEpoch,patterns:redactPatternsSchema,ids:{type:'array',minItems:1,maxItems:500,uniqueItems:true,items:{type:'string',pattern:'^[a-f0-9]{64}$'}},regions:{type:'array',minItems:1,maxItems:500,items:{type:'object',additionalProperties:false,required:['pageIndex','rect'],properties:{pageIndex:{type:'integer',minimum:0},rect:{type:'array',minItems:4,maxItems:4,items:{type:'number'}}}}},name:{type:'string',minLength:1,maxLength:255,pattern:'\\.[Pp][Dd][Ff]$'}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageRedactedCopy(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfRedactedCopyInput,signal)))

    api.addContentTypeParser('application/octet-stream',{parseAs:'buffer'},(_request,body,done)=>done(null,body))
    api.post('/api/v1/files/:id/pdf/replace-pages/uploads',{
      bodyLimit:64*1024*1024,
      schema:{params:fileParamsSchema,querystring:{type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','pages'],properties:{baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:{type:'string',pattern:'^[1-9][0-9]{0,15}$'},idempotencyKey:mutationProperties.idempotencyKey,pages:{type:'string',minLength:3,maxLength:1000}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>{
      const query=request.query as {baseRevision:string;editorId:string;leaseEpoch:string;idempotencyKey?:string;pages:string}
      let pages:number[];try{pages=JSON.parse(query.pages)}catch{throw Object.assign(Error('Bad Request'),{statusCode:400})}
      const leaseEpoch=Number(query.leaseEpoch)
      if(!Buffer.isBuffer(request.body)||!Number.isSafeInteger(leaseEpoch))throw Object.assign(Error('Bad Request'),{statusCode:400})
      return pdf.stageReplacePages(cookies(request).session??'',(request.params as {id:string}).id,{...query,leaseEpoch,pages} as PdfReplacePagesInput,request.body,signal)
    }))

    api.post('/api/v1/files/:id/pdf/insert-pages/uploads',{
      bodyLimit:64*1024*1024,
      schema:{params:fileParamsSchema,querystring:{type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','afterPageIndex'],properties:{baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:{type:'string',pattern:'^[1-9][0-9]{0,15}$'},idempotencyKey:mutationProperties.idempotencyKey,afterPageIndex:{type:'string',pattern:'^(?:-1|0|[1-9][0-9]?)$'}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>{
      const query=request.query as {baseRevision:string;editorId:string;leaseEpoch:string;idempotencyKey?:string;afterPageIndex:string}
      const leaseEpoch=Number(query.leaseEpoch)
      const afterPageIndex=Number(query.afterPageIndex)
      if(!Buffer.isBuffer(request.body)||!Number.isSafeInteger(leaseEpoch)||!Number.isSafeInteger(afterPageIndex))throw Object.assign(Error('Bad Request'),{statusCode:400})
      return pdf.stageReplacePages(cookies(request).session??'',(request.params as {id:string}).id,{baseRevision:query.baseRevision,editorId:query.editorId,leaseEpoch,idempotencyKey:query.idempotencyKey,afterPageIndex},request.body,signal)
    }))

    api.post('/api/v1/files/:id/pdf/stamps/uploads',{
      bodyLimit:65536,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operation'],properties:{baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:mutationProperties.leaseEpoch,idempotencyKey:mutationProperties.idempotencyKey,operation:{oneOf:[
        {type:'object',additionalProperties:false,required:['op','text'],properties:{op:{const:'set_watermark'},text:{type:'string',maxLength:2000},angle:{type:'number',minimum:-180,maximum:180},opacity:{type:'number',minimum:0,maximum:1},size:{type:'number',minimum:.02,maximum:.5},color:{type:'string',pattern:'^#?[a-fA-F0-9]{6}$'}}},
        {type:'object',additionalProperties:false,required:['op'],properties:{op:{const:'set_header_footer'},header_left:{type:'string',maxLength:2000},header_center:{type:'string',maxLength:2000},header_right:{type:'string',maxLength:2000},footer_left:{type:'string',maxLength:2000},footer_center:{type:'string',maxLength:2000},footer_right:{type:'string',maxLength:2000},page_number:{type:'boolean'},start_at:{type:'integer',minimum:0,maximum:100000},font_size:{type:'number',minimum:4,maximum:72},color:{type:'string',pattern:'^#?[a-fA-F0-9]{6}$'}}},
      ]}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageStamps(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfStampsUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/image-bakes/uploads',{
      bodyLimit:65536,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operation'],properties:{baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:mutationProperties.leaseEpoch,idempotencyKey:mutationProperties.idempotencyKey,operation:{oneOf:[
        {type:'object',additionalProperties:false,required:['op','page','image_number','axis'],properties:{op:{const:'flip_image'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},axis:{enum:['horizontal','vertical']}}},
        {type:'object',additionalProperties:false,required:['op','page','image_number','opacity'],properties:{op:{const:'set_image_opacity'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},opacity:{type:'number',minimum:0,maximum:1}}},
        {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{op:{const:'crop_image'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},left:{type:'number',minimum:0,exclusiveMaximum:1},top:{type:'number',minimum:0,exclusiveMaximum:1},right:{type:'number',minimum:0,exclusiveMaximum:1},bottom:{type:'number',minimum:0,exclusiveMaximum:1}}},
        {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{op:{const:'remove_image_background'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},tolerance:{type:'number',minimum:0,maximum:100}}},
      ]}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageImageBakes(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfImageBakesUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/image-content/uploads',{
      bodyLimit:7*1024*1024,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operation'],
        properties:{baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:mutationProperties.leaseEpoch,idempotencyKey:mutationProperties.idempotencyKey,operation:{oneOf:[
          {type:'object',additionalProperties:false,required:['op','page','image'],properties:{op:{const:'insert_image'},page:{type:'integer',minimum:1,maximum:100},image:{$ref:'pdf-image-content#'},anchor_text:{type:'string',maxLength:2000},placement:{enum:['above','below','left','right']},x:{type:'number',minimum:-100000,maximum:100000},y:{type:'number',minimum:-100000,maximum:100000},width:{type:'number',exclusiveMinimum:0,maximum:100000},layer:{enum:['above_text','below_text']}}},
          {type:'object',additionalProperties:false,required:['op','page','image_number','image'],properties:{op:{const:'replace_image'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},image:{$ref:'pdf-image-content#'}}},
        ]}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageImageContent(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfImageContentUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/image-edits/uploads',{
      bodyLimit:65536,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
        properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:20,items:{oneOf:[
          {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{op:{const:'transform_image'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},x:{type:'number',minimum:-100000,maximum:100000},y:{type:'number',minimum:-100000,maximum:100000},width:{type:'number',exclusiveMinimum:0,maximum:100000},height:{type:'number',exclusiveMinimum:0,maximum:100000},layer:{enum:['above_text','below_text']}}},
          {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{op:{const:'rotate_image'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000},direction:{enum:['cw','ccw','180']}}},
          {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{op:{const:'delete_image'},page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000}}},
        ]}}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageImageEdits(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfImageEditsUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/block-moves/uploads',{
      bodyLimit:131072,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
        properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:20,items:{
          type:'object',additionalProperties:false,required:['page','paragraph_text','dx','dy'],properties:{page:{type:'integer',minimum:1,maximum:100},paragraph_text:{type:'string',minLength:1,maxLength:2000},dx:{type:'number',minimum:-100000,maximum:100000},dy:{type:'number',minimum:-100000,maximum:100000}},
        }}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageBlockMoves(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfBlockMovesUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/block-edits/uploads',{
      bodyLimit:1048576,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
        properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:20,items:{
          type:'object',additionalProperties:false,required:['page','paragraph_text','new_text'],properties:{
            page:{type:'integer',minimum:1,maximum:100},paragraph_text:{type:'string',minLength:1,maxLength:2000},new_text:{type:'string',maxLength:10000},
            font_size:{type:'number',exclusiveMinimum:0,maximum:1000},color:{type:'string',pattern:'^#?[0-9a-fA-F]{6}$'},align:{enum:['left','center','right']},font:{enum:['arial','times','courier']},bold:{type:'boolean'},italic:{type:'boolean'},
          },
        }}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageBlockEdits(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfBlockEditsUploadInput,signal)))

    const pendingImageTarget={page:{type:'integer',minimum:1,maximum:100},image_number:{type:'integer',minimum:1,maximum:1000}}
    const pendingImageEditSchema={oneOf:[
      {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{...pendingImageTarget,op:{const:'transform_image'},x:{type:'number',minimum:-100000,maximum:100000},y:{type:'number',minimum:-100000,maximum:100000},width:{type:'number',exclusiveMinimum:0,maximum:100000},height:{type:'number',exclusiveMinimum:0,maximum:100000},layer:{enum:['above_text','below_text']}}},
      {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{...pendingImageTarget,op:{const:'rotate_image'},direction:{enum:['cw','ccw','180']}}},
      {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{...pendingImageTarget,op:{const:'delete_image'}}},
      {type:'object',additionalProperties:false,required:['op','page','image_number','image'],properties:{...pendingImageTarget,op:{const:'replace_image'},image:{$ref:'pdf-image-content#'}}},
      {type:'object',additionalProperties:false,required:['op','page','image_number','axis'],properties:{...pendingImageTarget,op:{const:'flip_image'},axis:{enum:['horizontal','vertical']}}},
      {type:'object',additionalProperties:false,required:['op','page','image_number','opacity'],properties:{...pendingImageTarget,op:{const:'set_image_opacity'},opacity:{type:'number',minimum:0,maximum:1}}},
      {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{...pendingImageTarget,op:{const:'crop_image'},...Object.fromEntries(['left','top','right','bottom'].map(side=>[side,{type:'number',minimum:0,exclusiveMaximum:1}]))}},
      {type:'object',additionalProperties:false,required:['op','page','image_number'],properties:{...pendingImageTarget,op:{const:'remove_image_background'},tolerance:{type:'number',minimum:0,maximum:100}}},
    ]}
    const textInsertItemSchema={type:'object',additionalProperties:false,required:['page','text'],properties:{
      page:{type:'integer',minimum:1,maximum:100},text:{type:'string',minLength:1,maxLength:10000},anchor_text:{type:'string',maxLength:2000},placement:{enum:['right','below','above']},
      x:{type:'number',minimum:-100000,maximum:100000},y:{type:'number',minimum:-100000,maximum:100000},font_size:{type:'number',exclusiveMinimum:0,maximum:1000},max_width:{type:'number',exclusiveMinimum:0,maximum:100000},
      color:{type:'string',pattern:'^#?[0-9a-fA-F]{6}$'},align:{enum:['left','center','right']},font:{enum:['arial','times','courier']},bold:{type:'boolean'},italic:{type:'boolean'},
    }}
    const pendingImageSchema={type:'object',additionalProperties:false,required:['page','image'],properties:{page:{type:'integer',minimum:1,maximum:100},image:{$ref:'pdf-image-content#'},anchor_text:{type:'string',maxLength:2000},placement:{enum:['above','below','left','right']},x:{type:'number',minimum:-100000,maximum:100000},y:{type:'number',minimum:-100000,maximum:100000},width:{type:'number',exclusiveMinimum:0,maximum:100000},height:{type:'number',exclusiveMinimum:0,maximum:100000},layer:{enum:['above_text','below_text']}}}
    api.post('/api/v1/files/:id/pdf/image-inserts/query',{
      bodyLimit:8*1024*1024,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision','operation'],properties:{revision:uuidSchema,operation:pendingImageSchema,rotationDelta:{type:'integer',enum:[0,90,180,270]}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryImageInserts(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryImageInserts']>[2],signal)))
    api.post('/api/v1/files/:id/pdf/draft-inserts/uploads',{
      bodyLimit:32*1024*1024,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operation'],properties:{...mutationProperties,operation:{type:'object',additionalProperties:false,required:['texts','images'],properties:{texts:{type:'array',minItems:0,maxItems:20,items:textInsertItemSchema},images:{type:'array',maxItems:20,items:pendingImageSchema},imageEdits:{type:'array',maxItems:20,items:pendingImageEditSchema}}}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageDraftInserts(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfDraftInsertsUploadInput,signal)))
    api.post('/api/v1/files/:id/pdf/draft-inserts/query',{
      bodyLimit:32*1024*1024,schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision','operation'],properties:{revision:uuidSchema,operation:{type:'object',additionalProperties:false,required:['texts','images'],properties:{texts:{type:'array',minItems:0,maxItems:20,items:textInsertItemSchema},images:{type:'array',maxItems:20,items:pendingImageSchema},imageEdits:{type:'array',maxItems:20,items:pendingImageEditSchema}}}}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryDraftInserts(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryDraftInserts']>[2],signal)))

    api.post('/api/v1/files/:id/pdf/text-inserts/query',{
      bodyLimit:1048576,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['revision','operations'],
        properties:{revision:uuidSchema,rotationDeltas:{type:'array',minItems:1,maxItems:20,items:{type:'integer',enum:[0,90,180,270]}},operations:{type:'array',minItems:1,maxItems:20,items:textInsertItemSchema}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryTextInserts(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryTextInserts']>[2],signal)))

    api.post('/api/v1/files/:id/pdf/text-inserts/uploads',{
      bodyLimit:1048576,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
        properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:20,items:textInsertItemSchema}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageTextInserts(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfTextInsertsUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/apply-ops/uploads',{
      bodyLimit:64*1024*1024,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','snapshot'],properties:{
          baseRevision:uuidSchema,editorId:uuidSchema,leaseEpoch:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER},idempotencyKey:mutationProperties.idempotencyKey,
          snapshot:applyOpsSnapshotSchema,
        },
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageApplyOps(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfApplyOpsUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/text-edits/query',{
      bodyLimit:256*1024,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision','edits'],properties:{
        revision:uuidSchema,edits:{...applyOpsSnapshotSchema.properties.textEdits,minItems:1},
      }}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryTextEdits(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryTextEdits']>[2],signal)))

    api.post('/api/v1/files/:id/pdf/apply-ops/query',{
      bodyLimit:64*1024*1024,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['revision','snapshot'],properties:{revision:uuidSchema,snapshot:applyOpsSnapshotSchema}}},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryApplyOps(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryApplyOps']>[2],signal)))

    api.post('/api/v1/files/:id/pdf/form-fields/uploads',{
      bodyLimit:1048576,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
        properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:50,items:{
          type:'object',additionalProperties:false,required:['op','field'],properties:{op:{const:'addFormField'},field:{
            type:'object',additionalProperties:false,required:['name','kind','page','x','y','width','height'],properties:{
              name:{type:'string',minLength:1,maxLength:1024},kind:{enum:['text','checkbox','radio','choice','signature']},page:{type:'integer',minimum:1,maximum:100},
              x:{type:'number'},y:{type:'number'},width:{type:'number',exclusiveMinimum:0},height:{type:'number',exclusiveMinimum:0},
              required:{type:'boolean'},multiLine:{type:'boolean'},maxLen:{type:'integer',minimum:0},fontSize:{type:'number',exclusiveMinimum:0},textAlignment:{enum:['left','center','right']},
              value:{type:'string',maxLength:10000},checked:{type:'boolean'},exportValue:{type:'string',minLength:1,maxLength:1024},options:{type:'array',maxItems:100,uniqueItems:true,items:{type:'string',minLength:1,maxLength:1024}},dateFormat:{type:'string',minLength:1,maxLength:100},
            },
          }},
        }}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageFormFields(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfFormFieldsUploadInput,signal)))

    api.post('/api/v1/files/:id/pdf/form-values/uploads',{
      bodyLimit:1048576,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
        properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:100,items:{
          type:'object',additionalProperties:false,required:['op','value'],properties:{op:{const:'setFormValue'},value:{
            type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string',minLength:1,maxLength:1024},value:{type:'string',maxLength:10000},checked:{type:'boolean'}},
            oneOf:[{required:['value'],not:{required:['checked']}},{required:['checked'],not:{required:['value']}}],
          }},
        }}},
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.stageFormValues(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfFormValuesUploadInput,signal)))

    for(const staged of [false,true])api.post(
      '/api/v1/files/:id/pdf/update-notes'+(staged?'/uploads':''),
      {
        bodyLimit:524288,
        schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
          type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
          properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:100,items:{
            type:'object',additionalProperties:false,required:['page','annotationId','action','text'],properties:{
              page:{type:'integer',minimum:1,maximum:100},annotationId:{type:'string',pattern:'^[1-9][0-9]{0,8}R([1-9][0-9]{0,4})?$'},
              action:{type:'string',enum:['reply','edit']},text:{type:'string',minLength:1,maxLength:4000},
            },
          }}},
        }},
      },
      async (request,reply)=>withDisconnect(request,reply,async signal=>staged
        ?pdf.stageUpdateNotes(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfNoteUpdateUploadInput,signal)
        :pdf.updateNotesAndCommit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfNoteUpdateUploadInput,signal)),
    )

    for(const staged of [false,true])api.post(
      '/api/v1/files/:id/pdf/delete-annotations'+(staged?'/uploads':''),
      {
        bodyLimit:65536,
        schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
          type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
          properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:100,items:{
            type:'object',additionalProperties:false,required:['page','annotationId'],properties:{
              page:{type:'integer',minimum:1,maximum:100},annotationId:{type:'string',pattern:'^[1-9][0-9]{0,8}R([1-9][0-9]{0,4})?$'},
            },
          }}},
        }},
      },
      async (request,reply)=>withDisconnect(request,reply,async signal=>staged
        ?pdf.stageDeleteAnnotations(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfAnnotationDeleteUploadInput,signal)
        :pdf.deleteAnnotationsAndCommit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfAnnotationDeleteUploadInput,signal)),
    )

    api.post('/api/v1/files/:id/pdf/annotations/query',{
      bodyLimit:65536,
      schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
        type:'object',additionalProperties:false,required:['revision','operations'],properties:{
          revision:uuidSchema,operations:{type:'array',minItems:1,maxItems:20,items:{
            type:'object',additionalProperties:false,required:['page','text','type'],properties:{
              page:{type:'integer',minimum:1,maximum:100},text:{type:'string',minLength:1,maxLength:2000},
              type:{type:'string',enum:['highlight','underline','strikeout','note']},contents:{type:'string',minLength:1,maxLength:4000},occurrence:{type:'integer',minimum:1,maximum:1000},
            },
          }},
        },
      }},
    },async(request,reply)=>withDisconnect(request,reply,signal=>pdf.queryAnnotations(cookies(request).session??'',(request.params as {id:string}).id,request.body as Parameters<PdfService['queryAnnotations']>[2],signal)))

    for(const staged of [false,true])api.post(
      '/api/v1/files/:id/pdf/annotate'+(staged?'/uploads':''),
      {
        bodyLimit:65536,
        schema:{params:fileParamsSchema,querystring:emptyQuerySchema,body:{
          type:'object',additionalProperties:false,required:['baseRevision','editorId','leaseEpoch','operations'],
          properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:20,items:{
            type:'object',additionalProperties:false,required:['page','text','type'],properties:{
              page:{type:'integer',minimum:1,maximum:100},text:{type:'string',minLength:1,maxLength:2000},
              type:{type:'string',enum:['highlight','underline','strikeout','note']},contents:{type:'string',minLength:1,maxLength:4000},occurrence:{type:'integer',minimum:1,maximum:1000},
            },
          }}},
        }},
      },
      async (request,reply)=>withDisconnect(request,reply,async signal=>staged
        ?pdf.stageAnnotate(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfAnnotationUploadInput,signal)
        :pdf.annotateAndCommit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfAnnotationUploadInput,signal)),
    )

    for(const staged of [false,true])api.post(
      '/api/v1/files/:id/pdf/edit-text'+(staged?'/uploads':''),
      {
        bodyLimit: 65536,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type:'object',additionalProperties:false,
            required:['baseRevision','editorId','leaseEpoch','operations'],
            properties:{...mutationProperties,operations:{type:'array',minItems:1,maxItems:20,items:{
              type:'object',additionalProperties:false,required:['page','oldText','newText'],properties:{
                page:{type:'integer',minimum:1,maximum:100},
                oldText:{type:'string',minLength:1,maxLength:2000},
                newText:{type:'string',maxLength:4000},
                occurrence:{type:'integer',minimum:1,maximum:1000},
              },
            }}},
          },
        },
      },
      async (request,reply)=>withDisconnect(request,reply,async signal=>staged
        ?pdf.stageTextEdit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfTextUploadInput,signal)
        :pdf.editTextAndCommit(cookies(request).session??'',(request.params as {id:string}).id,request.body as PdfTextUploadInput,signal)),
    )

    api.post(
      '/api/v1/files/:id/pdf/rotate',
      {
        bodyLimit: 65536,
        schema: {
          params: fileParamsSchema,
          querystring: emptyQuerySchema,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['baseRevision', 'editorId', 'leaseEpoch', 'operations'],
            properties: mutationProperties,
          },
        },
      },
      async (request,reply) => {
        const token = cookies(request).session ?? ''
        const fileId = (request.params as { id: string }).id
        return withDisconnect(request,reply,signal=>pdf.rotateAndCommit(token, fileId, request.body as PdfUploadInput,signal))
      },
    )
  })
}
