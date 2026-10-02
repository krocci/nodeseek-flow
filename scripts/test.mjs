import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
await import('./build.mjs');
await build({
  entryPoints: [
    resolve('tests/responsive-blocking.test.ts'),
    resolve('tests/attendance.test.ts'),
    resolve('tests/dav-attendance-integration.test.ts'),
    resolve('tests/core.test.ts'),
    resolve('tests/desktop-review.test.ts'),
    resolve('tests/ui-review.test.ts'),
    resolve('tests/rule-groups-review.test.ts'),
    resolve('tests/refresh-recovery-review.test.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: '.tests',
  outExtension: { '.js': '.mjs' },
  external: ['happy-dom', 'fake-indexeddb'],
  target: 'node24',
});
const r = spawnSync(
  process.execPath,
  [
    '--test',
    '.tests/responsive-blocking.test.mjs',
    '.tests/attendance.test.mjs',
    '.tests/dav-attendance-integration.test.mjs',
    '.tests/core.test.mjs',
    '.tests/desktop-review.test.mjs',
    '.tests/ui-review.test.mjs',
    '.tests/rule-groups-review.test.mjs',
    '.tests/refresh-recovery-review.test.mjs',
  ],
  { stdio: 'inherit' },
);
process.exitCode = r.status || 0;
