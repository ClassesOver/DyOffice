import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import config from '../../vite.docs.config.ts';
const require = createRequire(import.meta.url);

test('native DOCX build shares React across nested workspace dependencies', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'docs-react-'));
  try {
    const app = join(fixture, 'apps/web');
    const shared = join(fixture, 'packages/editor');
    await mkdir(app, { recursive: true }); await mkdir(shared, { recursive: true });
    // Deliberately create two physical copies, even on flattened CI installs.
    for (const location of [fixture, app]) {
      await mkdir(join(location, 'node_modules'), { recursive: true });
      for (const name of ['react', 'react-dom']) {
        await cp(dirname(require.resolve(`${name}/package.json`)), join(location, 'node_modules', name), { recursive: true });
      }
    }
    await writeFile(join(shared, 'provider.js'), `import {useState,createElement} from 'react';export function Provider(){const [text]=useState('ready');return createElement('span',null,text)}`);
    const entry = join(app, 'entry.js');
    await writeFile(entry, `import {createElement} from 'react';import {renderToString} from 'react-dom/server';import {Provider} from '../../packages/editor/provider.js';export const render=()=>renderToString(createElement(Provider));`);
    const out = join(fixture, 'out');
    await build({ configFile: false, root: app, logLevel: 'silent', resolve: config.resolve,
      ssr: { noExternal: true }, build: { ssr: entry, outDir: out, minify: false,
        rollupOptions: { output: { entryFileNames: 'probe.mjs' } } } });
    const { render } = await import(pathToFileURL(join(out, 'probe.mjs')).href);
    assert.equal(render(), '<span>ready</span>');
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
