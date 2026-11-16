import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.webp':'image/webp',
  '.docx':'application/octet-stream', '.xlsx':'application/octet-stream', '.pptx':'application/octet-stream',
  '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2',
  '.ttf':'font/ttf', '.wasm':'application/wasm',
};

/** Source is the legacy default. Built mode is a local integration seam, not production auth. */
export async function createStaticAssets({ assetMode = 'source', assetDirectory } = {}) {
  if (!['source', 'built'].includes(assetMode)) throw new Error('Unknown Web asset mode');
  const directory = await realpath(assetDirectory ?? join(webRoot, assetMode === 'built' ? 'dist' : 'public'));
  const allowed = new Set(['index.html', 'admin.html']);
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
  return async function serveStatic(request, response, pathname) {
    const name = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
    if (!allowed.has(name)) return false;
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow:'GET, HEAD' }); response.end(); return true;
    }
    // Recheck realpath on each request: replacing an asset with an escaping symlink is not allowed.
    const data = await readFile(await resolvedFile(name));
    response.writeHead(200, { 'Content-Type':contentTypes[extname(name)], 'Cache-Control':'no-cache', 'Content-Length':data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
    return true;
  };
}
