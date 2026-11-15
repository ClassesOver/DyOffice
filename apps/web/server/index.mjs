import { resolve } from 'node:path';
import { buildApp, buildLocalApp } from './src/app.ts';
import { connectIdentityStore } from './src/db/identity.ts';

async function configuredApplication() {
  const mode=process.env.DYOFFICE_AUTH_MODE||'development';
  if(mode==='development') return buildApp({
    directory:resolve(process.env.DYOFFICE_DATA_DIR||'.dyoffice'),
    userToken:process.env.DYOFFICE_USER_TOKEN,
    adminToken:process.env.DYOFFICE_ADMIN_TOKEN,
    encryptionKey:process.env.DYOFFICE_ENCRYPTION_KEY,
    assetMode:process.env.DYOFFICE_ASSET_MODE||'source',
  });
  if(mode!=='local') throw new Error('Unknown authentication mode');
  if(process.env.NODE_ENV==='production') throw new Error('Production local runtime is not ready');
  if(process.env.DYOFFICE_USER_TOKEN||process.env.DYOFFICE_ADMIN_TOKEN) throw new Error('Local mode rejects development tokens');
  const connectionString=process.env.DYOFFICE_DATABASE_URL;
  const deploymentId=process.env.DYOFFICE_DEPLOYMENT_ID;
  const origin=process.env.DYOFFICE_ORIGIN;
  const csrfKey=process.env.DYOFFICE_CSRF_KEY;
  if(!connectionString||!deploymentId||!origin||!csrfKey) throw new Error('Local account configuration missing');
  const {db,close}=connectIdentityStore(connectionString);
  try { return await buildLocalApp({db,deploymentId,origin,csrfKey,passwordBlocklistFile:process.env.DYOFFICE_PASSWORD_BLOCKLIST_FILE,closeDb:close}); }
  catch(error) { await close(); throw error; }
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
