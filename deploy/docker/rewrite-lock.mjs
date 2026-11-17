// Rewrite only the build-copy lockfile. Preserve versions and integrity hashes.
import {readFileSync, writeFileSync} from 'node:fs';
const registry = new URL(process.env.NPM_REGISTRY || 'https://repo.huaweicloud.com/repository/npm/');
if (registry.protocol !== 'https:') throw new Error('HTTPS npm registry required');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
let changed = 0;
for (const entry of Object.values(lock.packages)) {
  if (!entry.resolved || entry.link) continue;
  if (!entry.resolved.startsWith('https://')) throw new Error(`Unexpected locked source: ${entry.resolved}`);
  const old = new URL(entry.resolved);
  if (!['registry.npmjs.org', 'registry.npmmirror.com'].includes(old.hostname)) throw new Error(`Unreviewed dependency host: ${old.hostname}`);
  entry.resolved = registry.href.replace(/\/$/, '') + old.pathname;
  changed++;
}
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
console.log(`Rewrote ${changed} locked package URLs; versions and integrity unchanged.`);
