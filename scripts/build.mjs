import { build } from 'esbuild';
import { mkdir, copyFile, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import './icons.mjs';
const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'dist'), { recursive: true });
// Retire the former settings entry from incremental builds as well as fresh ones.
await rm(resolve(root, 'dist/options.html'), { force: true });
await build({
  entryPoints: ['background', 'content', 'bridge', 'options'].map((x) =>
    resolve(root, 'src', x + '.ts'),
  ),
  outdir: resolve(root, 'dist'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: false,
  legalComments: 'inline',
});
await copyFile(resolve(root, 'manifest.json'), resolve(root, 'dist/manifest.json'));
for (const f of await readdir(resolve(root, 'public')))
  await copyFile(resolve(root, 'public', f), resolve(root, 'dist', f));
for (const f of [
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
])
  await copyFile(resolve(root, f), resolve(root, 'dist', f));
console.log(
  'Built NodeSeek Flow ' +
    JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')).version +
    ' → dist/',
);
await build({
  entryPoints: [resolve(root, 'src/core.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(root, '.tests/preview-core.mjs'),
});
