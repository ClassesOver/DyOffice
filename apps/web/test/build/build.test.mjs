import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../', import.meta.url));
test('Web build serves the local-account shell and its emitted assets', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dyoffice-build-'));
  let server;
  try {
    execFileSync('npm', ['run', 'build', '--workspaces=false', '--', '--outDir', output], { cwd: web, stdio: 'pipe' });
    const { default: Fastify } = await import('fastify');
    const { registerLocalShell } = await import('../../server/src/local-shell.ts');
    server = Fastify();
    await registerLocalShell(server, output);
    const origin = await server.listen({port: 0, host: '127.0.0.1'});
    for (const page of ['', 'index.html']) {
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
    assert.equal((await fetch(`${origin}/legacy.html`)).status, 404);
    assert.ok(!(await readdir(output)).includes('server'));
    const manifest = JSON.parse(await readFile(join(output, '.vite/manifest.json'), 'utf8'));
    assert.ok(Object.values(manifest).some(entry => entry.file.endsWith('.js')));
    assert.ok(manifest['index.html'].css.some(asset => asset.endsWith('.css')));
  } finally {
    if (server) await server.close();
    await rm(output, { recursive: true, force: true });
  }
});
