// Render panel previews for the HyperFrames library (hf/library/catalog.json), both aspects.
//   node hf/tools/library-previews.mjs                 every style, skips existing files
//   node hf/tools/library-previews.mjs L51 L52         only these ids
//   node hf/tools/library-previews.mjs --force         re-render everything
//   node hf/tools/library-previews.mjs --stills        posters only
//   node hf/tools/library-previews.mjs --aspect=9:16   one aspect only
// Output: public/library/previews/<id>.jpg|mp4 (16:9) and <id>-v.jpg|mp4 (9:16). Clips are muted, 1/3 scale.
// Each one renders hf/library/previews/<id>[-v].html with `hyperframes render`, then ffmpeg makes the poster and clip.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = path.join(ROOT, 'hf', 'library');
const OUT = path.join(ROOT, 'public', 'library', 'previews');
const TMP = path.join(LIB, 'renders');
const FFMPEG = (() => {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) for (const f of ['ffmpeg.exe', 'ffmpeg']) if (d && fs.existsSync(path.join(d, f))) return path.join(d, f);
  const home = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'bin', 'ffmpeg.exe');
  return fs.existsSync(home) ? home : path.join(ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe');
})();

const catalog = JSON.parse(fs.readFileSync(path.join(LIB, 'catalog.json'), 'utf8'));
const args = process.argv.slice(2);
const force = args.includes('--force');
const stillsOnly = args.includes('--stills');
const aspectArg = (args.find((a) => a.startsWith('--aspect=')) ?? '').split('=')[1];
const aspects = aspectArg ? [aspectArg] : ['16:9', '9:16'];
const only = args.filter((a) => !a.startsWith('--'));
const list = only.length ? catalog.filter((e) => only.includes(e.id)) : catalog;
fs.mkdirSync(OUT, {recursive: true});
fs.mkdirSync(TMP, {recursive: true});

for (const e of list) {
  for (const a of aspects) {
    const suf = a === '9:16' ? '-v' : '';
    const base = path.join(OUT, `${e.id}${suf}`);
    const needStill = force || !fs.existsSync(`${base}.jpg`);
    const needClip = !stillsOnly && (force || !fs.existsSync(`${base}.mp4`));
    if (!needStill && !needClip) continue;
    const full = path.join(TMP, `${e.id}${suf}.mp4`);
    execFileSync('npx', ['hyperframes', 'render', '-c', `previews/${e.id}${suf}.html`, '-o', full, '-q', 'draft', '--quiet'], {cwd: LIB, stdio: 'inherit', shell: true});
    const [w, h] = a === '9:16' ? [1080, 1920] : [1920, 1080];
    if (needStill) execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(100 / 60), '-i', full, '-frames:v', '1', '-vf', `scale=${w / 2}:${h / 2}`, '-q:v', '4', `${base}.jpg`]);
    if (needClip) execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', full, '-an', '-vf', `scale=${w / 3}:${h / 3}`, '-c:v', 'libx264', '-crf', '30', '-pix_fmt', 'yuv420p', `${base}.mp4`]);
    fs.rmSync(full, {force: true});
    console.log('preview', path.basename(base));
  }
}
console.log(`done: ${list.length} style(s) -> public/library/previews/`);
