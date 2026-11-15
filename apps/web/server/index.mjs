import { resolve } from 'node:path';
import { buildApp } from './src/app.ts';

const app=await buildApp({
  directory:resolve(process.env.DYOFFICE_DATA_DIR||'.dyoffice'),
  userToken:process.env.DYOFFICE_USER_TOKEN,
  adminToken:process.env.DYOFFICE_ADMIN_TOKEN,
  encryptionKey:process.env.DYOFFICE_ENCRYPTION_KEY,
  assetMode:process.env.DYOFFICE_ASSET_MODE||'source',
});
let closing;
const close=()=>{
  closing??=app.close().catch(()=>{
    console.error('dyoffice: shutdown failed');
    process.exitCode=1;
  });
  return closing;
};
process.on('SIGTERM',close);
process.on('SIGINT',close);
try {
  const address=await app.listen({port:Number(process.env.PORT||3080),host:process.env.HOST||'127.0.0.1'});
  console.log(`dyoffice: ${address}`);
} catch {
  console.error('dyoffice: startup failed');
  await close();
  process.exitCode=1;
}
