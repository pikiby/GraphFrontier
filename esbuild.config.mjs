import esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const isProd = process.argv[2] === 'production';
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const STATIC_DIR = path.join(ROOT_DIR, 'src', 'static');
const RELEASE_STATIC_FILES = [
  { from: path.join(STATIC_DIR, 'manifest.json'), to: path.join(DIST_DIR, 'manifest.json') },
  { from: path.join(STATIC_DIR, 'styles.css'), to: path.join(DIST_DIR, 'styles.css') },
  { from: path.join(STATIC_DIR, 'versions.json'), to: path.join(DIST_DIR, 'versions.json') },
  { from: path.join(ROOT_DIR, 'LICENSE'), to: path.join(DIST_DIR, 'LICENSE') },
];

async function cleanDist() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
}

async function copyReleaseFiles() {
  await mkdir(DIST_DIR, { recursive: true });
  for (const file of RELEASE_STATIC_FILES) {
    await copyFile(file.from, file.to);
  }
}

const context = await esbuild.context({
  entryPoints: ['src/main.js'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  sourcemap: isProd ? false : 'inline',
  minify: false,
  logLevel: 'info',
  outdir: 'dist',
});

if (isProd) {
  await cleanDist();
  await context.rebuild();
  await copyReleaseFiles();
  process.exit(0);
} else {
  await cleanDist();
  await copyReleaseFiles();
  await context.watch();
}
