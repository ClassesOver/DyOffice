import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export async function createStore(directory, encryptionKey) {
  if (!encryptionKey) throw new Error('DYOFFICE_ENCRYPTION_KEY is required');
  await mkdir(directory, {recursive:true,mode:0o700});
  const path = join(directory,'state.json');
  const key = createHash('sha256').update(encryptionKey).digest();
  let state = {preferences:{theme:'system',language:'zh'},admin:{models:[],mcp:[]},sources:[],files:[]};
  try { state = JSON.parse(await readFile(path,'utf8')); } catch (error) { if(error.code !== 'ENOENT') throw error; }
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    // Mutators may be synchronous or async. Await them before serialization;
    // a thrown/rejected mutator aborts the isolated snapshot and keeps the queue usable.
    update(change) {
      const result = queue.then(async () => {
        const next = structuredClone(state); await change(next);
        await writeFile(path+'.tmp',JSON.stringify(next),{mode:0o600});
        await rename(path+'.tmp',path); state=next;
      });
      queue=result.catch(()=>{}); return result;
    },
    seal(value) {
      const iv=randomBytes(12); const cipher=createCipheriv('aes-256-gcm',key,iv);
      const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
      return [iv,cipher.getAuthTag(),data].map(b=>b.toString('base64')).join('.');
    },
    unseal(value) {
      const [iv,tag,data]=value.split('.').map(s=>Buffer.from(s,'base64'));
      const cipher=createDecipheriv('aes-256-gcm',key,iv); cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');
    }
  };
}
