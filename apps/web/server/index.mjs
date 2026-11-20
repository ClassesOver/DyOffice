import {codingHarnessConfig} from './coding-config.mjs';
import {assertDocumentBackendPolicy} from '../worker/src/sandbox/document-backend-policy.ts';
import { openIsolatedPptxSession } from '../worker/src/native/pptx-session-host.ts';
import { configuredSheetsRuntime } from './src/modules/sheets/runtime.ts';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { localShellDirectory } from './local-shell-config.mjs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { configuredObjectStore } from './src/storage/config.ts';
import { buildApp, buildLocalApp } from './src/app.ts';
import { connectIdentityStore } from './src/db/identity.ts';
import { parseConfigKeyring } from './src/modules/admin/keyring-config.ts';

async function configuredApplication() {
  assertDocumentBackendPolicy(process.env);
  const mode=process.env.DYOFFICE_AUTH_MODE||(process.env.DYOFFICE_AUTH_DATABASE_URL?'local':'development');
  const shellDirectory=localShellDirectory({...process.env,DYOFFICE_AUTH_MODE:mode});
  const profilesFile=process.env.DYOFFICE_PROVIDER_GATEWAY_PROFILES;
  if(profilesFile && mode!=='local') throw new Error('Provider Gateway requires local mode');
  const assistantSourceFlag=process.env.DYOFFICE_ASSISTANT_SOURCE_CATALOG;
  const assistantSourceMode=assistantSourceFlag||'off';
  if (!['off','metadata-only','read-only-analysis'].includes(assistantSourceMode) ||
      assistantSourceMode!=='off' && (mode!=='local'||(!profilesFile&&!process.env.DYOFFICE_CONFIG_KEYRING))) throw new Error('Assistant source catalog requires an explicit source mode, local accounts and provider gateway');
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
  if(process.env.NODE_ENV==='production') throw Object.assign(new Error('Production local document runtime is unavailable'),{code:'PRODUCTION_DOCUMENT_RUNTIME_UNAVAILABLE'});
  if(process.env.DYOFFICE_USER_TOKEN||process.env.DYOFFICE_ADMIN_TOKEN) throw new Error('Local mode rejects development tokens');
  if(process.env.DYOFFICE_DATABASE_URL) throw new Error('Migration credentials are not accepted by the runtime');
  const connectionString=process.env.DYOFFICE_AUTH_DATABASE_URL;
  const businessConnectionString=process.env.DYOFFICE_BUSINESS_DATABASE_URL;
  const deploymentId=process.env.DYOFFICE_DEPLOYMENT_ID;
  const origin=process.env.DYOFFICE_ORIGIN;
  const csrfKey=process.env.DYOFFICE_CSRF_KEY;
  const globalConfigKeyring=parseConfigKeyring(process.env.DYOFFICE_CONFIG_KEYRING);
  const providerGateway=profilesFile ? {profiles:JSON.parse(await readFile(resolve(profilesFile),'utf8'))} : globalConfigKeyring ? {mode:'shared'} : undefined;
  const sourcesCredentialKeys=process.env.DYOFFICE_SOURCES_CREDENTIAL_KEYS||'';
  if(!connectionString||!businessConnectionString||!deploymentId||!origin||!csrfKey) throw new Error('Local account configuration missing');
  const {db,close}=connectIdentityStore(connectionString);
  let businessPool,backgroundPool,storage,sheets;
  try {
    if(process.env.DYOFFICE_ASSISTANT_BACKGROUND==='on'){
      if(!process.env.DYOFFICE_WORKER_DATABASE_URL)throw Error('Background execution requires DYOFFICE_WORKER_DATABASE_URL')
      backgroundPool=new Pool({connectionString:process.env.DYOFFICE_WORKER_DATABASE_URL,max:2,connectionTimeoutMillis:5000})
    }
    businessPool=new Pool({connectionString:businessConnectionString,max:4,connectionTimeoutMillis:5000});
    const defaultShellDir=fileURLToPath(new URL('../dist-local-shell/',import.meta.url));
    const hasBuiltShell=existsSync(join(defaultShellDir,'.vite/manifest.json'));
    const storageEnv=process.env.DYOFFICE_FILE_API===undefined && process.env.DYOFFICE_OBJECT_STORE===undefined && (process.env.DYOFFICE_OBJECT_DIRECTORY || (process.env.NODE_ENV!=='test' && hasBuiltShell))
      ? {...process.env,DYOFFICE_OBJECT_STORE:'local-dev',DYOFFICE_OBJECT_DIRECTORY:resolve(process.env.DYOFFICE_OBJECT_DIRECTORY||'.dyoffice/objects')}
      : process.env;
    storage=await configuredObjectStore(storageEnv);
    const defaultDocsDir=resolve(process.env.DYOFFICE_NATIVE_DOCX_DIRECTORY||fileURLToPath(new URL('../dist-docs/',import.meta.url)));
    const nativeDocsDirectory=storage.objectStore && existsSync(join(defaultDocsDir,'.vite/manifest.json')) ? defaultDocsDir : undefined;
    const defaultSlidesDir=resolve(process.env.DYOFFICE_NATIVE_PPTX_DIRECTORY||fileURLToPath(new URL('../dist-slides/',import.meta.url)));
    const nativeSlidesDirectory=storage.objectStore && existsSync(join(defaultSlidesDir,'.vite/manifest.json')) ? defaultSlidesDir : undefined;
    const slidesHost=nativeSlidesDirectory ? {openSession:(input)=>openIsolatedPptxSession({fileId:input.fileId,revision:input.revision,bytes:input.bytes},{timeoutMs:60000,experimental:true})} : undefined;
    const legacyDistDir=resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
    const effectiveShellDirectory=(shellDirectory && shellDirectory!==legacyDistDir) ? shellDirectory : (storage.objectStore && hasBuiltShell ? defaultShellDir : shellDirectory);
    const defaultSheetsDir=resolve(process.env.DYOFFICE_NATIVE_XLSX_DIRECTORY||fileURLToPath(new URL('../dist-sheets/',import.meta.url)));
    const defaultGatewayPath=resolve(process.env.DYOFFICE_XLSX_GATEWAY_RUNNER||fileURLToPath(new URL('../dist-sheets-server/gateway-process.mjs',import.meta.url)));
    const defaultNodeEnginePath=resolve(fileURLToPath(new URL('../dist-sheets-server/xlsx-node-engine.mjs',import.meta.url)));
    if(storage.objectStore && existsSync(join(defaultSheetsDir,'.vite/manifest.json')) && existsSync(defaultGatewayPath) && (process.env.DYOFFICE_NATIVE_BINARY || existsSync(defaultNodeEnginePath))){
      sheets=await configuredSheetsRuntime({...process.env,DYOFFICE_AUTH_MODE:mode,...(process.env.DYOFFICE_NATIVE_BINARY ? {} : {DYOFFICE_XLSX_NODE_ENGINE:process.env.DYOFFICE_XLSX_NODE_ENGINE||defaultNodeEnginePath})},{enabled:true});
    }
    const {close:closeSheets,...sheetsConfig}=sheets ?? {};
    const defaultPdfDir=resolve(process.env.DYOFFICE_NATIVE_PDF_DIRECTORY||fileURLToPath(new URL('../dist-pdf/',import.meta.url)));
    const nativePdfDirectory=storage.objectStore && existsSync(join(defaultPdfDir,'.vite/manifest.json')) ? defaultPdfDir : undefined;
    const nativePdf=Boolean(nativePdfDirectory || nativeDocsDirectory || nativeSlidesDirectory || sheets);
    return await buildLocalApp({db,businessPool,...storage,...sheetsConfig,nativeDocsDirectory,nativeSlidesDirectory,slidesHost,nativePdf,nativePdfDirectory,localShellDirectory:effectiveShellDirectory,dshEditorOrigin:process.env.DYOFFICE_DSH_EMBED_ORIGIN,nativeJobs:jobFlag==='experimental',deploymentId,origin,csrfKey,globalConfigKeyring,providerGateway,assistantSourceMode,assistantChannels:process.env.DYOFFICE_ASSISTANT_CHANNELS==='on',assistantBackground:backgroundPool?{pool:backgroundPool}:undefined,codingHarnesses:codingHarnessConfig(process.env),sourcesCredentialKeys,passwordBlocklistFile:process.env.DYOFFICE_PASSWORD_BLOCKLIST_FILE,closeDb:async()=>{await closeSheets?.();storage.close();await Promise.all([close(),businessPool.end(),backgroundPool?.end()]);}});
  } catch(error) { await sheets?.close();storage?.close();await Promise.allSettled([close(),businessPool?.end(),backgroundPool?.end()]); throw error; }
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
} catch (error) {
  const diagnostics=new Map([
    ['DOCUMENT_BROKER_UNAVAILABLE','document broker unavailable'],
    ['DOCUMENT_BACKEND_INVALID','document backend invalid'],
    ['PRODUCTION_DOCUMENT_RUNTIME_UNAVAILABLE','production local document runtime is unavailable'],
  ]);
  console.error('dyoffice: '+(diagnostics.get(error?.code)??'startup failed'));
  await close();
  process.exitCode=1;
}
