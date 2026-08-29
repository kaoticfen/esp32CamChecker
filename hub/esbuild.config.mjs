import { cp, mkdir, rm } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const outDir = 'public';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp('src/web/index.html', `${outDir}/index.html`);

const options = {
  entryPoints: ['src/web/app.ts', 'src/web/styles.css'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outdir: outDir,
  sourcemap: watch,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching src/web');
} else {
  await esbuild.build(options);
}
