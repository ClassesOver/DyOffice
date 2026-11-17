// Private integration child: read an existing receipt, never execute/replay a job.
import pg from 'pg'
import {createPrincipalTransactions} from '../../server/src/db/context.ts'
import {createPdfJobReceiptRecovery} from '../../server/src/pdf/job-receipt-recovery.ts'
if(process.env.NODE_ENV!=='test'||'DYOFFICE_TEST_DATABASE_URL' in process.env)throw Error('Isolated test environment required')
const input=JSON.parse(process.env.PDF_RECEIPT_FIXTURE)
const url=new URL(input.database)
if(!['127.0.0.1','localhost'].includes(url.hostname)||!/^\/dyoffice_test_rls_[a-f0-9]+$/.test(url.pathname))throw Error('Disposable local database required')
const pool=new pg.Pool({connectionString:input.database,max:1,connectionTimeoutMillis:3000})
try{
 const transactions=createPrincipalTransactions({pool,deploymentId:input.deploymentId})
 let result
 try{result=await createPdfJobReceiptRecovery({transactions,token:input.token}).lookup(input.fileId,input.jobId)}
 catch(error){if(![401,403,404].includes(error.statusCode))throw Error('Unexpected recovery failure');result={state:'denied',statusCode:error.statusCode}}
 process.stdout.write(JSON.stringify(result))
}finally{await pool.end()}
