import { resolve } from 'node:path';
import { createApplication } from './application.mjs';
const server=await createApplication({directory:resolve(process.env.DYOFFICE_DATA_DIR||'.dyoffice'),userToken:process.env.DYOFFICE_USER_TOKEN,adminToken:process.env.DYOFFICE_ADMIN_TOKEN,encryptionKey:process.env.DYOFFICE_ENCRYPTION_KEY,assetMode:process.env.DYOFFICE_ASSET_MODE||'source'});
const port=Number(process.env.PORT||3080);
server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`dyoffice: http://${process.env.HOST||'127.0.0.1'}:${port}`));
