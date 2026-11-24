import { createHash } from 'node:crypto';
import { brotliCompress } from 'node:zlib';
import { promisify } from 'node:util';
import { acceptsBrotli, fastBrotli, minCompressionBytes } from './response-encoding.mjs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const compress = promisify(brotliCompress);
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp',
  '.docx':'application/octet-stream', '.xlsx':'application/octet-stream', '.pptx':'application/octet-stream',
  '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2',
  '.ttf':'font/ttf', '.wasm':'application/wasm',
  '.bcmap':'application/octet-stream', '.pfb':'application/octet-stream',
};

export async function createRefreshableStaticAssets(options) {
  const manifest = join(options.assetDirectory, '.vite/manifest.json');
  const stamp = async () => {
    const info = await stat(manifest, { bigint:true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  };
  let currentStamp = await stamp();
  let assets = await createStaticAssets(options);
  let refreshing;
  return async (request, response, pathname) => {
    if (refreshing) await refreshing;
    if (await stamp() !== currentStamp) {
      if (!refreshing) refreshing = (async () => {
        const nextStamp = await stamp();
        const nextAssets = await createStaticAssets(options);
        assets = nextAssets;
        currentStamp = nextStamp;
      })();
      try { await refreshing; } finally { refreshing = undefined; }
    }
    return assets(request, response, pathname);
  };
}

/** Source is the legacy default. Built mode is a local integration seam, not production auth.
 * @param {{assetMode?: string, assetDirectory?: string, pages?: string[], assetInventory?: string, cacheControl?: string}} options
 */
export async function createStaticAssets({ assetMode = 'source', assetDirectory, pages = ['index.html', 'admin.html'], assetInventory, cacheControl = 'no-cache' } = {}) {
  if (!['source', 'built'].includes(assetMode)) throw new Error('Unknown Web asset mode');
  const directory = await realpath(assetDirectory ?? join(webRoot, assetMode === 'built' ? 'dist' : 'public'));
  const allowed = new Set(pages);
  const resolvedFile = async name => {
    const path = await realpath(join(directory, name));
    const inside = relative(directory, path);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Web asset escaped output directory');
    if (!(await stat(path)).isFile()) throw new Error('Web asset is not a file');
    return path;
  };
  if (assetMode === 'source') {
    allowed.add('app.js'); allowed.add('style.css'); allowed.add('editor-controller.js');
  } else {
    const manifest = JSON.parse(await readFile(await resolvedFile('.vite/manifest.json'), 'utf8'));
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object' || !Object.keys(manifest).length) throw new Error('Invalid Web build manifest');
    // Identical MPA inputs share a chunk, so Vite may omit the HTML entry from its manifest.
    // Allow only this explicit built page, still checked for existence and realpath confinement.
    try { await resolvedFile('legacy.html'); allowed.add('legacy.html'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const add = name => {
      if (typeof name !== 'string' || !/^assets\/[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || !contentTypes[extname(name)]) throw new Error('Unsafe Web build asset');
      allowed.add(name);
    };
    if (assetInventory) {
      const inventory = JSON.parse(await readFile(await resolvedFile(assetInventory), 'utf8'));
      if (!Array.isArray(inventory)) throw new Error('Invalid build inventory');
      for (const name of inventory) add(name);
    }
    for (const entry of Object.values(manifest)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid Web build entry');
      add(entry.file);
      for (const field of ['css', 'assets']) {
        if (entry[field] !== undefined && !Array.isArray(entry[field])) throw new Error('Invalid Web build asset list');
        for (const name of entry[field] ?? []) add(name);
      }
    }
  }
  // Fail startup before creating app state when a selected build is missing/incomplete.
  for (const name of allowed) await resolvedFile(name);
  // Only allowlisted build assets are retained, one representation per filename.
  const compressed = new Map();
  return async function serveStatic(request, response, pathname) {
    const name = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
    if (!allowed.has(name)) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow:'GET, HEAD' }); response.end(); return true;
    }
    // Recheck realpath on each request: replacing an asset with an escaping symlink is not allowed.
    const data = await readFile(await resolvedFile(name));
    let body = data;
    const headers = { 'Content-Type':contentTypes[extname(name)], 'Cache-Control':cacheControl };
    if (assetInventory && /\.(?:js|css)$/.test(name) && data.length >= minCompressionBytes) {
      headers.Vary = 'Accept-Encoding';
      if (acceptsBrotli(request.headers)) {
        const hash = createHash('sha256').update(data).digest('hex');
        let entry = compressed.get(name);
        if (entry?.hash !== hash) {
          entry = {hash, bytes:compress(data, fastBrotli)};
          compressed.set(name, entry);
        }
        try { body = await entry.bytes; }
        catch (error) { if (compressed.get(name) === entry) compressed.delete(name); throw error; }
        headers['Content-Encoding'] = 'br';
      }
    }
    headers['Content-Length'] = body.length;
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  };
}
