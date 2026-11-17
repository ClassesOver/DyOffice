// Rewrite only a build-copy lockfile. Never fetch or weaken package integrity.
import {readFileSync, writeFileSync} from 'node:fs';
function fail() { throw new Error('Invalid dependency source or integrity; review lockfile and NPM_REGISTRY'); }
function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail();
  return url;
}
const registry = safeUrl(process.env.NPM_REGISTRY || 'https://repo.huaweicloud.com/repository/npm/');
const prefix = registry.href.replace(/\/$/, '') + '/';
let lock;
try { lock = JSON.parse(readFileSync('package-lock.json', 'utf8')); } catch { fail(); }
if (lock.lockfileVersion !== 3 || !lock.packages || Array.isArray(lock.packages)) fail();
let changed = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  // Root and workspace manifests have no resolved URL; npm validates local links.
  if (entry.link) continue;
  if (!entry.resolved) {
    if (path.split('/').includes('node_modules')) fail();
    continue;
  }
  const old = safeUrl(entry.resolved);
  if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) fail();
  let suffix;
  if (old.href.startsWith(prefix)) suffix = old.href.slice(prefix.length);
  else if (['registry.npmjs.org', 'registry.npmmirror.com'].includes(old.hostname) && !old.port) suffix = old.pathname.slice(1);
  else fail();
  if (!suffix || !suffix.endsWith('.tgz')) fail();
  const next = prefix + suffix;
  if (entry.resolved !== next) changed++;
  entry.resolved = next;
}
// Validation completes before the only write, leaving failures unchanged.
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
console.log(`Rewrote ${changed} locked package URLs; versions and integrity unchanged.`);
