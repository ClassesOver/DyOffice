import { resolve } from 'node:path';
import { localShellDirectory } from './local-shell-config.mjs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { configuredObjectStore } from './src/storage/config.ts';
import { buildApp, buildLocalApp } from './src/app.ts';
import { connectIdentityStore } from './src/db/identity.ts';

async function configuredApplication() {
  const mode=process.env.DYOFFICE_AUTH_MODE||'development';
  const shellDirectory=localShellDirectory(process.env);
  const jobFlag=process.env.DYOFFICE_NATIVE_JOBS;
  if(jobFlag && (jobFlag!=='experimental'||mode!=='local')) throw new Error('Native jobs require explicit experimental local mode');
  if(mode==='development') return buildApp({
    directory:resolve(process.env.DYOFFICE_DATA_DIR||'.dyoffice'),
    userToken:process.env.DYOFFICE_USER_TOKEN,
    adminToken:process.env.DYOFFICE_ADMIN_TOKEN,
    encryptionKey:process.env.DYOFFICE_ENCRYPTION_KEY,
    assetMode:process.env.DYOFFICE_ASSET_MODE||'built',
  });
  if(mode!=='local') throw new Error('Unknown authentication mode');
  if(process.env.NODE_ENV==='production') throw new Error('Production local runtime is not ready');
  if(process.env.DYOFFICE_USER_TOKEN||process.env.DYOFFICE_ADMIN_TOKEN) throw new Error('Local mode rejects development tokens');
  if(process.env.DYOFFICE_DATABASE_URL) throw new Error('Migration credentials are not accepted by the runtime');
  const connectionString=process.env.DYOFFICE_AUTH_DATABASE_URL;
  const businessConnectionString=process.env.DYOFFICE_BUSINESS_DATABASE_URL;
  const deploymentId=process.env.DYOFFICE_DEPLOYMENT_ID;
  const origin=process.env.DYOFFICE_ORIGIN;
  const csrfKey=process.env.DYOFFICE_CSRF_KEY;
  if(!connectionString||!businessConnectionString||!deploymentId||!origin||!csrfKey) throw new Error('Local account configuration missing');
  const {db,close}=connectIdentityStore(connectionString);
  let businessPool,storage;
  try {
    businessPool=new Pool({connectionString:businessConnectionString,max:4,connectionTimeoutMillis:5000});
    storage=await configuredObjectStore(process.env);
    const nativeFlag=process.env.DYOFFICE_NATIVE_DOCX;
    if(nativeFlag && nativeFlag!=='experimental') throw new Error('Unknown native DOCX mode');
    const nativeDocsDirectory=nativeFlag ? resolve(process.env.DYOFFICE_NATIVE_DOCX_DIRECTORY||fileURLToPath(new URL('../dist-docs/',import.meta.url))) : undefined;
    return await buildLocalApp({db,businessPool,...storage,nativeDocsDirectory,localShellDirectory:shellDirectory,nativeJobs:jobFlag==='experimental',deploymentId,origin,csrfKey,passwordBlocklistFile:process.env.DYOFFICE_PASSWORD_BLOCKLIST_FILE,closeDb:async()=>{storage.close();await Promise.all([close(),businessPool.end()]);}});
  } catch(error) { storage?.close();await Promise.allSettled([close(),businessPool?.end()]); throw error; }
}

let app,closing;
const close=()=>{
  closing??=Promise.resolve(app?.close()).catch(()=>{
    console.error('dyoffice: shutdown failed');
    process.exitCode=1;
  });
  return closing;
};
try {
  app=await configuredApplication();
  process.on('SIGTERM',close);
  process.on('SIGINT',close);
  const address=await app.listen({port:Number(process.env.PORT||3080),host:process.env.HOST||'127.0.0.1'});
  console.log(`dyoffice: ${address}`);
} catch {
  console.error('dyoffice: startup failed');
  await close();
  process.exitCode=1;
}
