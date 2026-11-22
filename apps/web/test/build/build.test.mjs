import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../', import.meta.url));
test('Web-only production build emits both pages with loadable assets', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dyoffice-build-'));
  const data = await mkdtemp(join(tmpdir(), 'dyoffice-build-api-'));
  let server;
  try {
    execFileSync('npm', ['run', 'build', '--workspaces=false', '--', '--outDir', output], { cwd: web, stdio: 'pipe' });
    const { createApplication } = await import('../../server/application.mjs');
    server = await createApplication({ directory:data, userToken:'user', adminToken:'admin', encryptionKey:'test', assetMode:'built', assetDirectory:output });
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    for (const page of ['', 'admin', 'admin.html', 'index.html', 'legacy.html']) {
      const response = await fetch(`${origin}/${page}`);
      assert.equal(response.status, 200);
      assert.equal(new URL(response.url).pathname, `/${page}`);
      const html = await response.text();
      assert.match(html, /id="app"/);
      const assets = [...html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)].map(match => match[1]);
      assert.ok(assets.some(asset => asset.endsWith('.js')));
      assert.ok(assets.some(asset => asset.endsWith('.css')));
      for (const asset of assets) {
        const response = await fetch(new URL(asset, origin));
        assert.equal(response.status, 200, asset);
        assert.ok((await response.text()).length > 0);
      }
    }
    assert.equal((await fetch(`${origin}/pdf.html`)).status, 404);
    assert.equal((await fetch(`${origin}/api/preferences`)).status, 401);
    assert.equal((await fetch(`${origin}/api/preferences`, {headers:{Authorization:'Bearer user'}})).status, 200);
    assert.equal((await fetch(`${origin}/api/preferences`, {headers:{Authorization:'Bearer admin'}})).status, 403);
    assert.ok(!(await readdir(output)).includes('server'));
    const manifest = JSON.parse(await readFile(join(output, '.vite/manifest.json'), 'utf8'));
    assert.ok(Object.values(manifest).some(entry => entry.file.endsWith('.js')));
    assert.ok(Object.values(manifest).some(entry => entry.file.endsWith('.css')));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(output, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

// This checks the legacy bootstrap routing, not browser layout or document editing.
test('both canonical and emitted Admin URLs select the Admin login and token namespace', async () => {
  const { runInNewContext } = await import('node:vm');
  const script = await readFile(join(web, 'public/app.js'), 'utf8');
  for (const [pathname, title, key] of [
    ['/admin', 'dyoffice Admin', 'dyoffice-admin-token'],
    ['/admin.html', 'dyoffice Admin', 'dyoffice-admin-token'],
    ['/', 'dyoffice', 'dyoffice-user-token'],
    ['/index.html', 'dyoffice', 'dyoffice-user-token'],
  ]) {
    const nodes = [];
    const storageReads = [];
    const createElement = tag => {
      const node = { tag, append() {}, replaceChildren() {} };
      nodes.push(node);
      return node;
    };
    runInNewContext(script, {
      document: { querySelector: () => createElement('root'), createElement },
      location: { pathname },
      sessionStorage: { getItem(value) { storageReads.push(value); return null; } },
    });
    assert.equal(nodes.find(node => node.tag === 'h1')?.textContent, title, pathname);
    assert.deepEqual(storageReads, [key], pathname);
  }
});
