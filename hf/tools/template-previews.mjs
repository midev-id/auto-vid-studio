// Moving previews for templates that are whole HyperFrames projects: the basic templates (hf/templates/T*)
// and every extension template (extensions/<ext>/templates/<dir>).
//   node hf/tools/template-previews.mjs            only the ones without a preview .mp4
//   node hf/tools/template-previews.mjs --force    everything
//   node hf/tools/template-previews.mjs X10 T3     only these ids
// Basic -> public/library/previews/<id>-v.mp4|jpg. Extension -> extensions/<ext>/previews/<dir>.mp4|jpg (+ extension.json).
// The clip is muted, 1/3 scale, sped up so a long template fits in ~12 s.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'ffmpeg');
const FFMPEG = path.join(BIN, 'ffmpeg.exe');
const FFPROBE = path.join(BIN, 'ffprobe.exe');
const HF = path.join(ROOT, 'app', 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs');
const TMP = path.join(ROOT, 'out', '_previews');
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));
fs.mkdirSync(TMP, {recursive: true});
process.env.PATH = BIN + path.delimiter + process.env.PATH;

const jobs = [];
for (const d of fs.readdirSync(path.join(ROOT, 'hf', 'templates'))) {
  jobs.push({id: d, dir: path.join(ROOT, 'hf', 'templates', d), out: path.join(ROOT, 'public', 'library', 'previews', `${d}-v`)});
}
const extRoot = path.join(ROOT, 'extensions');
for (const e of fs.existsSync(extRoot) ? fs.readdirSync(extRoot) : []) {
  const mf = path.join(extRoot, e, 'extension.json');
  if (e.startsWith('_') || !fs.existsSync(mf)) continue;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  for (const t of m.templates ?? []) {
    const key = path.basename(t.dir);
    jobs.push({id: t.id, dir: path.join(extRoot, e, t.dir), out: path.join(extRoot, e, 'previews', key), ext: {mf, m, t, key}});
  }
}

for (const j of jobs) {
  if (only.length && !only.includes(j.id)) continue;
  if (!force && fs.existsSync(`${j.out}.mp4`)) continue;
  fs.mkdirSync(path.dirname(j.out), {recursive: true});
  const raw = path.join(TMP, `${j.id}.mp4`);
  console.log(`render ${j.id} ...`);
  execFileSync(process.execPath, [HF, 'render', '-o', raw, '-q', 'draft'], {cwd: j.dir, stdio: 'inherit'});
  const dur = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw]).toString()) || 10;
  const speed = Math.max(1, dur / 12);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', raw, '-an', '-vf', `setpts=PTS/${speed.toFixed(3)},scale=360:-2,fps=30`, '-c:v', 'libx264', '-crf', '26', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${j.out}.mp4`]);
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', String(Math.min(dur * 0.45, dur - 0.5)), '-i', raw, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', `${j.out}.jpg`]);
  if (j.ext) {
    j.ext.t.preview = {'9:16': `previews/${j.ext.key}.mp4`};
    j.ext.t.poster = {'9:16': `previews/${j.ext.key}.jpg`};
    fs.writeFileSync(j.ext.mf, JSON.stringify(j.ext.m, null, 2));
  }
  fs.rmSync(raw, {force: true});
  console.log(`ok ${j.id} -> ${path.relative(ROOT, j.out)}.mp4`);
}
