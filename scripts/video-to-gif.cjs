#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [input, ...description] = process.argv.slice(2);
if (!input || input === '--help') {
  console.log('Usage: node scripts/video-to-gif.cjs <video> [feature description]');
  console.log('Creates a sibling GIF; records it in .media-work/materials.jsonl.');
  console.log('Existing GIFs are never overwritten. README is not changed.');
  process.exit(input ? 0 : 1);
}

let temporaryDirectory;
try {
  const source = path.resolve(input);
  if (!fs.statSync(source).isFile()) throw new Error('Input must be a video file.');
  if (path.extname(source).toLowerCase() === '.gif') {
    throw new Error('Input is already a GIF. Supply the original video.');
  }
  const output = path.join(path.dirname(source), `${path.parse(source).name}.gif`);
  if (fs.existsSync(output)) throw new Error(`GIF already exists: ${output}`);
  const journal = path.resolve(__dirname, '../.media-work/materials.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(source), '.gif-work-'));
  const temporaryOutput = path.join(temporaryDirectory, 'result.gif');
  const filter =
    'fps=20,scale=450:338:flags=lanczos:force_original_aspect_ratio=decrease,' +
    'pad=450:338:(ow-iw)/2:(oh-ih)/2,split[s0][s1];' +
    '[s0]palettegen=max_colors=249[p];' +
    '[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle';
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-i',
      source,
      '-vf',
      filter,
      '-an',
      '-loop',
      '0',
      temporaryOutput,
    ],
    { stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('FFmpeg conversion failed.');
  // Publish only complete output, without replacing a concurrently created GIF.
  fs.linkSync(temporaryOutput, output);
  console.log(`GIF: ${output}`);
  fs.appendFileSync(
    journal,
    JSON.stringify({
      createdAt: new Date().toISOString(),
      source,
      gif: output,
      description: description.join(' '),
      status: 'prepared',
      filter,
      loop: 0,
    }) + '\n'
  );
  console.log(`Recorded: ${journal}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
