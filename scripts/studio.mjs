// One port for everything: HyperFrames Studio + the project prep panel.
//   npm run dev  ->  http://localhost:3000        HyperFrames Studio for one hf/ project (with a "Prep Panel" button injected)
//                    http://localhost:3000/panel  prepare a project (bahan, style, brief), generate the prompt for Claude,
//                                                 and pick which hf/ project the Studio shows
// Studio runs on an internal port and is reverse-proxied (HTTP, SSE and WebSocket). The old Remotion version
// of this server is scripts/studio-remotion.mjs (npm run dev:remotion).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, exec, execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as claude from './claude-runner.mjs';
import {loadExtensions, extensionTemplates, extensionRules, EXT_DIR} from './extensions.mjs';

const ROOT = process.env.GAS_ROOT ? path.resolve(process.env.GAS_ROOT) : path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);
const STUDIO_PORT = PORT + 1;
const SKIP = new Set(['shared', 'library', 'sfx', 'icons', 'hfk', 'brand']);
const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,40}$/;
const PLAYER_JS = (() => {
  const f = path.join(process.env.GAS_MODULES || path.join(ROOT, 'app', 'node_modules'), '@hyperframes', 'player', 'dist', 'hyperframes-player.global.js');
  return fs.existsSync(f) ? f : null;
})();
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'webm', 'mov']);
const MIME = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4'};

// basic style templates, ported to hf/templates/T1..T5 (shown in the panel dropdown)
const TEMPLATES = [
  {id: 'T1-MotionGraphic', name: 'Motion Graphic', desc: 'Bentuk geometris flat, blok warna tegas, wipe kapsul, counter & bar.'},
  {id: 'T2-Sketchbook', name: 'Sketchbook', desc: 'Kertas bergaris, coretan pensil hidup, stabilo, panah tangan, balik halaman.'},
  {id: 'T3-Kinetic', name: 'Kinetic Typography', desc: 'Kata per kata, hantam/geser/putar, kontras ukuran, invert hitam-putih.'},
  {id: 'T4-Neon', name: 'Neon', desc: 'Malam synthwave, teks tabung neon berkedip, grid perspektif.'},
  {id: 'T5-Glass', name: 'Glass', desc: 'Gradien gelap, bola warna melayang, kartu kaca 3D, angka & chart.'},
].map((t) => {
  const id = t.id.split('-')[0];
  const f = (ext) => (fs.existsSync(path.join(PUB, 'library', 'previews', `${id}-v.${ext}`)) ? `/panel-files/library/previews/${id}-v.${ext}` : null);
  return {...t, group: 'basic', category: 'Basic', palette: [], previews: {'9:16': {poster: f('jpg'), video: f('mp4')}, '16:9': {poster: null, video: null}}};
});
// template library (hf/library/catalog.json): styles with preview clips in public/library/previews/
const loadTemplates = () => {
  let lib = [];
  try {
    lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'hf', 'library', 'catalog.json'), 'utf8'));
  } catch {}
  const prev = path.join(PUB, 'library', 'previews');
  const has = (f) => fs.existsSync(path.join(prev, f));
  return [
    ...lib.map((e) => ({
      ...e,
      group: 'library',
      // per aspect: '16:9' -> <id>.jpg|mp4, '9:16' -> <id>-v.jpg|mp4
      previews: Object.fromEntries(
        [['16:9', ''], ['9:16', '-v']].map(([a, suf]) => [
          a,
          {
            poster: has(`${e.id}${suf}.jpg`) ? `/panel-files/library/previews/${e.id}${suf}.jpg` : null,
            video: has(`${e.id}${suf}.mp4`) ? `/panel-files/library/previews/${e.id}${suf}.mp4` : null,
          },
        ]),
      ),
    })),
    ...extensionTemplates(ROOT),
    ...TEMPLATES,
  ];
};

// ffmpeg for yt-dlp merges/cuts and audio concat: PATH, ~/bin, then Remotion's bundled copy
const FFMPEG = (() => {
  const home = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'bin', 'ffmpeg.exe');
  const bundled = path.join(ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe');
  for (const dirp of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const f of ['ffmpeg.exe', 'ffmpeg']) if (dirp && fs.existsSync(path.join(dirp, f))) return path.join(dirp, f);
  }
  // portable build: bin/ffmpeg/ next to the repo files
  const portable = path.join(ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(portable)) return portable;
  return fs.existsSync(home) ? home : bundled;
})();
// child processes (hyperframes render/preview, Claude's PowerShell window) need ffmpeg + ffprobe on PATH;
// the app may be started without them, so put the found ffmpeg's folder first
if (fs.existsSync(FFMPEG)) process.env.PATH = path.dirname(FFMPEG) + path.delimiter + (process.env.PATH ?? '');
// HyperFrames CLI: the copy bundled with the app (run with this same node / Electron-as-node), else npx
const MODULES = process.env.GAS_MODULES || path.join(ROOT, 'app', 'node_modules');
const HF_BIN = path.join(MODULES, 'hyperframes', 'bin', 'hyperframes.mjs');
const HF = fs.existsSync(HF_BIN) ? [`"${process.execPath}"`, `"${HF_BIN}"`] : ['npx', 'hyperframes'];
const VID_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v']);
const listClips = (d) => {
  const cd = path.join(d, 'clips');
  return fs.existsSync(cd)
    ? fs.readdirSync(cd).filter((f) => VID_EXT.has(f.split('.').pop().toLowerCase())).sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))
    : [];
};
const YT_RE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;
const PY_ENV = {...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8'};
const ytInfo = (url) =>
  new Promise((resolve, reject) => {
    const proc = spawn('python', ['-m', 'yt_dlp', '-J', '--no-playlist', '--no-warnings', url], {env: PY_ENV});
    const out = [];
    let err = '';
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => (err += c.toString('utf8')));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(/No module named yt_dlp/.test(err) ? 'yt-dlp belum terpasang: pip install yt-dlp' : err.trim().split('\n').pop() || `exit ${code}`));
      const j = JSON.parse(Buffer.concat(out).toString('utf8'));
      resolve({id: j.id, title: j.title, uploader: j.uploader ?? j.channel ?? '', duration: j.duration ?? 0, thumbnail: j.thumbnail ?? '', width: j.width ?? 0, height: j.height ?? 0});
    });
  });

// ---------- helpers ----------
const dir = (name) => path.join(PUB, name);
const readBody = (req) =>
  new Promise((res, rej) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => res(Buffer.concat(parts)));
    req.on('error', rej);
  });
const json = (res, code, obj) => {
  res.writeHead(code, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
};
const readMeta = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(name), 'project.json'), 'utf8'));
  } catch {
    return {};
  }
};
const listAssets = (name) => {
  const d = path.join(dir(name), 'assets');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => IMG_EXT.has(f.split('.').pop().toLowerCase())) : [];
};
const safeFile = (f) => {
  const ext = (f.split('.').pop() || '').toLowerCase();
  const base = f.slice(0, f.length - ext.length - 1).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'asset';
  return IMG_EXT.has(ext) ? `${base}.${ext}` : null;
};
const listProjects = () =>
  fs
    .readdirSync(PUB, {withFileTypes: true})
    .filter((d) => d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith('_'))
    .map((d) => {
      const files = fs.readdirSync(dir(d.name));
      return {
        name: d.name,
        audio: files.find((f) => f.startsWith('audio.')) ?? null,
        music: files.find((f) => f.startsWith('music.')) ?? null,
        logo: files.find((f) => /^logo\.(png|jpe?g|webp|svg)$/i.test(f)) ?? null,
        source: readMeta(d.name).source ?? 'own',
        data: files.includes('data.json'),
        concept: files.includes('concept.md'),
        assets: listAssets(d.name).length,
        template: readMeta(d.name).template ?? '',
        mtime: fs.statSync(dir(d.name)).mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

// ---------- Auto Vid Studio helpers ----------
const runs = new Map(); // name -> time Claude was started from the app
// open a visible PowerShell window running Claude Code in the repo with this task
const launchClaude = (name, msg) => {
  const m = msg.replace(/'/g, "''");
  if (process.platform === 'win32') {
    const ps = `$Host.UI.RawUI.WindowTitle = 'Auto Vid Studio - ${name}'; Set-Location '${ROOT.replace(/'/g, "''")}'; claude '${m}'`;
    spawn('cmd.exe', ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', ps], {detached: true, stdio: 'ignore'}).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', `cd '${ROOT}' && claude '${m}'`], {detached: true, stdio: 'ignore'}).unref();
  }
};
let renderJob = null;
const killTree = (proc) => {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {stdio: 'ignore'});
  else proc.kill();
};
const runCapture = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {cwd, shell: true});
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`))));
  });
const listRenders = () => {
  const od = path.join(ROOT, 'out');
  if (!fs.existsSync(od)) return [];
  return fs.readdirSync(od).filter((f) => /\.(mp4|webm|mov)$/i.test(f)).map((f) => {
    const st = fs.statSync(path.join(od, f));
    return {file: f, size: st.size, mtime: st.mtimeMs};
  }).sort((a, b) => b.mtime - a.mtime);
};

// ---------- prompt for Claude ----------
const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
const buildPrompt = (name) => {
  const d = dir(name);
  const meta = readMeta(name);
  const files = fs.readdirSync(d);
  const P = `public/${name}`;
  const HP = `hf/videos/${name}`;
  const audio = files.find((f) => f.startsWith('audio.'));
  const music = files.find((f) => f.startsWith('music.'));
  const logo = files.find((f) => /^logo\.(png|jpe?g|webp|svg)$/i.test(f));
  const assets = listAssets(name);
  const clips = listClips(d);
  const refs = fs.existsSync(path.join(d, 'reference')) ? fs.readdirSync(path.join(d, 'reference')) : [];
  const concept = fs.existsSync(path.join(d, 'concept.md')) ? fs.readFileSync(path.join(d, 'concept.md'), 'utf8').trim() : '';
  const src = meta.source ?? 'own';
  const v = meta.aspect === '16:9';
  const lang = meta.lang === 'en' ? 'en' : meta.lang === '' ? '' : 'id';
  const langName = lang === 'en' ? 'English' : lang === 'id' ? 'Indonesia' : 'deteksi otomatis';
  const st = meta.style ?? (meta.template ? {mode: 'template'} : null);
  const lib = loadTemplates().find((t) => t.id === meta.template);
  const tr = `python scripts/transcribe.py ${name}${lang ? ` --lang ${lang}` : ''} --model small`;
  const yt = meta.yt;
  const font = (meta.font ?? '').trim();
  const fps = Math.max(1, Math.min(60, Math.round(Number(meta.fps) || 60)));

  const L = [];
  const line = '─'.repeat(60);
  const head = (t) => L.push('', `▌ ${t}`);
  const kv = (k, val) => L.push(`  • ${k.padEnd(16)}: ${val}`);
  const li = (t, mark = '•') => L.push(`  ${mark} ${t}`);
  let n = 0;
  const step = (t, ...sub) => { L.push(`  ${String(++n).padStart(2)}. ${t}`); sub.forEach((x) => L.push(`      ${x}`)); };

  L.push(line, `PROMPT  ·  HYPERFRAMES VIDEO  ·  ${name}`, line);
  head('TUGAS');
  L.push(`  Buat video HyperFrames baru "${name}" dari bahan yang sudah disiapkan di ${P}/.`);
  L.push('  Semua proses (download, transkrip, coding) dikerjakan oleh kamu (Claude). Panel hanya menyiapkan bahan.');
  L.push('  Baca dulu hf/README.md (kit HFK, struktur project, aturan) dan skill /hyperframes.');

  head('SPESIFIKASI');
  kv('Project', `${HP}/  (index.html + compositions/*.html)`);
  kv('Format', `${v ? '16:9 · 1920×1080' : '9:16 · 1080×1920'} · ${fps} fps (data-fps di root)`);
  kv('Folder bahan', `${P}/  → di HTML: assets/${name}/...`);
  kv('Bahasa', langName);
  kv('Font', font ? `${font} (custom, cari sendiri)` : 'Noto Sans KR (assets/hfk/fonts)');

  head('BAHAN');
  if (src === 'youtube') {
    kv('Sumber utama', 'Clip YouTube (belum di-download)');
    kv('Video', `${yt?.title || '-'}  ·  ${yt?.url || '-'}`);
    (yt?.segments ?? []).forEach((x, i) => kv(`Rentang ${i + 1}`, `${mmss(x.s)} – ${mmss(x.e)}  (${x.e - x.s} detik)  →  ${P}/clips/clip${i + 1}.mp4`));
  } else if (src === 'clip') {
    kv('Sumber utama', `Video milik user, ${clips.length} clip, diputar berurutan`);
    clips.forEach((c, i) => kv(`Clip ${i + 1}`, `${P}/clips/${c}`));
    kv('Voice-over', 'audio dari clip itu sendiri');
  } else {
    kv('Sumber utama', 'Voice-over');
    kv('Voice-over', audio ? `${P}/${audio}` : 'BELUM ADA (minta user upload dulu)');
  }
  kv('Backsound', music ? `${P}/${music}  ·  volume ${(meta.musicVol ?? 0.15).toFixed(2)}` : 'tidak ada');
  kv('Aset pendukung', assets.length ? `${assets.length} file di ${P}/assets/` : 'tidak ada');
  assets.forEach((a) => L.push(`      - ${a}`));
  kv('Logo / watermark', logo ? `${P}/${logo}` : 'tidak ada (video tanpa watermark)');
  kv('Brief', concept ? `${P}/concept.md` : 'kosong');

  head('LANGKAH');
  step(`Baca ${P}/concept.md dan ${P}/project.json. Lihat setiap file di ${P}/assets/ supaya tahu isinya.`);
  if (src === 'youtube') {
    (yt?.segments ?? []).forEach((x, i) =>
      step(`Download rentang ${i + 1} (${mmss(x.s)}–${mmss(x.e)}) dengan potongan presisi:`,
        `python -m yt_dlp --no-playlist -f "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" --merge-output-format mp4 --download-sections "*${x.s}-${x.e}" --force-keyframes-at-cuts --downloader-args "ffmpeg_o:-c:v libx264 -preset veryfast -crf 20 -c:a aac" --ffmpeg-location "${FFMPEG}" -o ${P}/clips/clip${i + 1}.mp4 "${yt.url}"`));
  }
  if (src === 'youtube' || src === 'clip') {
    step(`Gabung audio semua clip sesuai urutan jadi ${P}/audio.wav (mono 16 kHz, ffmpeg concat).`,
      `Catat di project.json: clips[] = {file, s, e, at} (at = detik mulai clip di timeline gabungan).`);
  }
  if (src !== 'own' || audio) step(`Transkrip lokal (tanpa token AI): ${tr}`, `Hasil: ${P}/data.json (word timestamps) + transcript.txt.`);
  step(`Buat project: node hf/tools/new-video.mjs ${name}`,
    `Hasil: ${HP}/ dengan index.html (data.json di-inline sebagai window.DATA, <audio> voice${music ? ' + music' : ''}), compositions/main.html (starter), assets → public.`);
  if (st?.mode === 'reference') step(`Pelajari video referensi di ${P}/reference/ (${refs.length} file): ambil 6–10 sample frame per video dengan ffmpeg, catat palet, layout, tipografi, transisi, ritme cut, gaya subtitle dan SFX.`);
  if (lib?.ext) step(`Buka template extension ${lib.id}: ${lib.extPath}/ sebagai titik awal${lib.entry ? ` (mulai dari ${lib.extPath}/${lib.entry})` : ''}. Baca README/notes di folder itu kalau ada.`);
  else if (lib && lib.group === 'library') step(`Buka hf/library/catalog.json → ${lib.id} dan scene-nya hf/library/compositions/${lib.id}.html sebagai titik awal (fungsi frame HFK, stage 1920×1080 + "v" untuk 9:16).`);
  else if (lib) step(`Buka template ${lib.id}: hf/templates/${lib.id.split('-')[0]}/ (index.html + compositions/video.html) sebagai titik awal.`);
  if (font) step(`Cari font "${font}": Google Fonts atau sumber resmi yang gratis; simpan .woff2 ke ${P}/fonts/ dan pasang @font-face (src: url('assets/${name}/fonts/...')) di setiap file yang memakainya. Kalau tidak ketemu, pakai yang paling mirip dan sebutkan penggantinya di ringkasan.`);
  step(`Tulis scene di ${HP}/compositions/ (satu file per scene, host-nya di index.html dengan data-start/data-duration).`,
    'Dua cara, boleh dicampur: (a) HTML + GSAP timeline native (paling enak diedit di Studio), atau (b) HFK.mount: scene = fungsi frame (pola library, lihat hf/README.md).',
    'Data transkrip: window.DATA.words [{t,s,e}] (dari index.html). Jangan fetch file saat runtime.');
  if (src !== 'own') step('Putar clip berurutan sebagai <video class="clip" data-has-audio="true"> di index.html (data-start = at, data-media-start = s); jangan taruh <video> di dalam fungsi HFK.');
  if (music) step(`Backsound ${music} sudah ada di index.html (volume ${(meta.musicVol ?? 0.15).toFixed(2)}, fade 0.5 s). Duck saat ada kata diucapkan dengan data-automation (skill /media-use bagian mix).`);
  step('SFX: setiap efek = <audio id class="clip" src="assets/sfx/..." data-start data-duration data-volume> di index.html; beri track index berbeda kalau tumpang tindih.');
  step(`cd ${HP} && npx hyperframes check  → sampai 0 error.`);
  if (st?.mode === 'reference' && st.save) {
    step(`Simpan style referensi sebagai template library "${st.saveName || `Custom ${name}`}": hf/library/compositions/<id>.html (id L berikutnya, contoh struktur dari L01.html), entry baru di hf/library/catalog.json (category "Custom", isi "v" dan "sound"), lalu node hf/tools/library-previews.mjs <id>.`);
  }

  head('STYLE');
  if (lib?.ext) {
    kv('Template', `${lib.id} · ${lib.name} (extension ${lib.ext})`);
    if (lib.palette?.length) kv('Palet', lib.palette.join('  '));
    kv('Karakter', lib.desc ?? '');
  } else if (lib && lib.group === 'library') {
    kv('Template', `${lib.id} · ${lib.name} (${lib.category})`);
    kv('Palet', lib.palette.join('  '));
    kv('Karakter', lib.desc);
    li('Pertahankan palet, gerakan dan SFX template; ganti isi dan layout sesuai brief dan format.');
  } else if (lib) {
    kv('Template', `${lib.id} · ${lib.name} (hf/templates/)`);
    kv('Karakter', lib.desc);
  } else if (st?.mode === 'reference') {
    kv('Referensi', `${refs.length} video di ${P}/reference/`);
    if (st.notes) kv('Fokus tiru', st.notes);
    li('Referensi hanya acuan gaya. JANGAN tampilkan video referensi di hasil.');
  } else {
    li(fs.existsSync(path.join(ROOT, 'styles', 'STYLES.md')) ? 'Bebas. Pilih gaya yang paling cocok dengan brief; boleh mengambil dari styles/STYLES.md atau hf/library.' : 'Bebas. Pilih gaya yang paling cocok dengan brief; boleh mengambil dari hf/library.');
  }

  head('BRIEF DARI USER');
  (concept || '(kosong, tentukan sendiri dari transkrip)').split('\n').forEach((t) => L.push(`  │ ${t}`));

  head('DO');
  [
    font ? `Font ${font} untuk semua teks; pakai weight tebal untuk penekanan.` : 'Font Noto Sans KR untuk semua teks (@font-face ke assets/hfk/fonts, 700/900 untuk penekanan).',
    'Teks di layar UPPERCASE.',
    'Timing dalam detik (data-start, posisi GSAP, HFK.spS/rampS); jangan hardcode frame.',
    'Sinkronkan visual dengan word timestamps; perbaiki salah dengar Whisper di teks layar (contoh: cloud → Claude).',
    `Safe area: 70–90 px kiri-kanan, kosongkan ${v ? '±100 px atas-bawah' : '180 px atas dan 250 px bawah'}.`,
    'Hierarki jelas: teks utama paling besar, pendukung lebih kecil; tetap terbaca di HP.',
    'Transisi pakai spring / bezier, scene saling overlap, dan motion blur sesuai kecepatan gerak (ghost copies atau blur singkat saat bergerak).',
    'SFX dari assets/sfx/ dengan volume 0.15–0.3; cek file ada sebelum dipakai. Klik = mouse-click-sound.mp3, ketik = typing-sound-efffect.mp3.',
    'Ikon dari assets/icons/ kalau butuh ikon.',
    logo ? `Logo user assets/${name}/${logo}: watermark kecil di dalam safe area + logo penuh di end card.` : 'Tanpa watermark dan tanpa logo di end card (user tidak upload logo), kecuali brief memintanya.',
    'Sebelum bikin efek bernama (glitch, chart, confetti, transisi), cari dulu di registry: npx hyperframes catalog --query "..."',
  ].forEach((t) => li(t, '✓'));

  head("DON'T");
  [
    'Jangan render MP4 final dan jangan jalankan npm run dev (Studio sudah terbuka).',
    'Jangan hapus atau ubah project lain (termasuk project Remotion lama di src/).',
    'Jangan pakai filter blur besar yang diam, backdropFilter, atau maskImage layar penuh (laptop lambat).',
    'Jangan pakai Date.now(), Math.random() tanpa seed, timer, atau fetch; semua harus fungsi waktu timeline.',
    font ? `Jangan pakai font lain selain ${font} (atau penggantinya yang paling mirip).` : 'Jangan ganti font, walaupun meniru referensi.',
    'Jangan pakai foto produk atau logo merek pihak ketiga kecuali disediakan user.',
    'Jangan pakai logo dari assets/brand/ (itu logo pembuat app, bukan logo user).',
    ...(st?.mode === 'reference' ? ['Jangan pakai video referensi sebagai aset.'] : []),
    'Jangan isi layar dengan elemen yang tidak mendukung pesan.',
  ].forEach((t) => li(t, '✗'));

  head('SELESAI KALAU');
  [
    `${HP}/index.html ada dan semua scene ter-mount`,
    `${P}/data.json dan transcript.txt ada`,
    `npx hyperframes check bersih (0 error) di ${HP}`,
    ...(st?.mode === 'reference' && st.save ? ['template baru muncul di hf/library/catalog.json dan punya preview'] : []),
    `kirim ringkasan singkat + perintah render: cd ${HP} && npx hyperframes render -o ../../../out/${name}.mp4`,
    `TERAKHIR: tulis file ${HP}/.done (isi bebas). Itu tanda buat Auto Vid Studio untuk membuka editor.`,
  ].forEach((t) => li(t, '☐'));
  L.push('', line);
  return L.join('\n') + '\n';
};

// ---------- panel API ----------
const handlePanel = async (req, res, url) => {
  const p = url.pathname;
  if (p === '/panel' || p === '/panel/') {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(PAGE);
    return true;
  }
  // Auto Vid Studio UI (app/ui) and the embeddable HyperFrames player
  if (p === '/app' || p.startsWith('/app/')) {
    const rel = p === '/app' || p === '/app/' ? 'index.html' : decodeURIComponent(p.slice('/app/'.length));
    const base = process.env.GAS_UI || path.join(ROOT, 'app', 'ui');
    const file = rel === 'player.js' ? PLAYER_JS : path.join(base, rel);
    if (!file || (file !== PLAYER_JS && !file.startsWith(base)) || !fs.existsSync(file)) return json(res, 404, {error: 'not found'}), true;
    const ext = file.split('.').pop().toLowerCase();
    res.writeHead(200, {'Content-Type': {html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png'}[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(res);
    return true;
  }
  if (p.startsWith('/out-files/')) {
    const f = path.basename(decodeURIComponent(p.slice('/out-files/'.length)));
    const file = path.join(ROOT, 'out', f);
    if (!fs.existsSync(file)) return json(res, 404, {error: 'not found'}), true;
    res.writeHead(200, {'Content-Type': MIME[f.split('.').pop().toLowerCase()] ?? 'application/octet-stream'});
    fs.createReadStream(file).pipe(res);
    return true;
  }
  // project files for previews (thumbnails, audio player)
  if (p.startsWith('/panel-files/')) {
    const rel = decodeURIComponent(p.slice('/panel-files/'.length));
    const file = path.join(PUB, rel);
    if (!file.startsWith(PUB) || !fs.existsSync(file)) return json(res, 404, {error: 'not found'}), true;
    res.writeHead(200, {'Content-Type': MIME[file.split('.').pop().toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(res);
    return true;
  }
  if (p.startsWith('/ext-files/')) {
    const file = path.join(EXT_DIR(ROOT), decodeURIComponent(p.slice('/ext-files/'.length)));
    if (!file.startsWith(EXT_DIR(ROOT)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, {error: 'not found'}), true;
    res.writeHead(200, {'Content-Type': MIME[file.split('.').pop().toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-cache'});
    fs.createReadStream(file).pipe(res);
    return true;
  }
  if (!p.startsWith('/api/panel/')) return false;
  const action = p.slice('/api/panel/'.length);
  try {
    if (action === 'templates') return json(res, 200, loadTemplates()), true;
    if (action === 'extensions') return json(res, 200, loadExtensions(ROOT).map(({rules, ...e}) => ({...e, hasRules: !!rules}))), true;
    if (action === 'settings' && req.method === 'POST') {
      claude.writeSettings(ROOT, JSON.parse((await readBody(req)).toString('utf8') || '{}'));
      return json(res, 200, claude.publicSettings(ROOT)), true;
    }
    if (action === 'settings') return json(res, 200, claude.publicSettings(ROOT)), true;
    if (action === 'auth-status') return json(res, 200, await claude.authStatus(ROOT)), true;
    if (action === 'auth-login' && req.method === 'POST') return claude.openLogin(ROOT), json(res, 200, {ok: true}), true;
    if (action === 'renders') return json(res, 200, listRenders()), true;
    if (action === 'render-status') return json(res, 200, renderJob ? {...renderJob, proc: undefined} : {state: 'idle'}), true;
    if (action === 'render-cancel' && req.method === 'POST') {
      if (renderJob?.proc) killTree(renderJob.proc);
      if (renderJob) renderJob.state = 'cancelled';
      return json(res, 200, {ok: true}), true;
    }
    if (action === 'projects') return json(res, 200, listProjects()), true;
    // HyperFrames projects under hf/ and the one Studio is showing
    if (action === 'hf-projects') return json(res, 200, {current: studioProject, projects: listHfProjects()}), true;
    // is the preview server up and serving the current project?
    if (action === 'studio-state') {
      let serving = null;
      try {
        serving = await new Promise((resolve) => {
          const r = http.get({host: '127.0.0.1', port: STUDIO_PORT, path: '/api/projects', timeout: 1500}, (pr) => {
            let b = '';
            pr.on('data', (c) => (b += c));
            pr.on('end', () => {
              try {
                resolve(JSON.parse(b).projects.map((x) => x.id));
              } catch {
                resolve(null);
              }
            });
          });
          r.on('error', () => resolve(null));
          r.on('timeout', () => {
            r.destroy();
            resolve(null);
          });
        });
      } catch {}
      const want = studioProject ? path.basename(studioProject) : null;
      studioReady = !!(serving && want && serving.includes(want));
      return json(res, 200, {project: studioProject, ready: studioReady, serving, error: studioError}), true;
    }
    if (action === 'studio' && req.method === 'POST') {
      const id = url.searchParams.get('project') ?? '';
      if (!listHfProjects().some((x) => x.id === id)) return json(res, 400, {error: 'Project HyperFrames tidak ditemukan'}), true;
      startStudio(id);
      return json(res, 200, {ok: true, current: id}), true;
    }
    if (action === 'yt-info') {
      const u = url.searchParams.get('url') ?? '';
      if (!YT_RE.test(u)) return json(res, 400, {error: 'Link YouTube tidak valid'}), true;
      try {
        return json(res, 200, await ytInfo(u)), true;
      } catch (e) {
        return json(res, 502, {error: String(e.message ?? e)}), true;
      }
    }

    const name = url.searchParams.get('name') ?? '';
    if (!NAME_RE.test(name)) return json(res, 400, {error: 'Nama project: huruf kecil, angka, - atau _ saja'}), true;
    const d = dir(name);

    // Auto Vid Studio: run Claude inside the app (Agent SDK), streamed to the UI
    if (action === 'run' && req.method === 'POST') {
      if (!fs.existsSync(path.join(d, 'prompt.txt'))) fs.writeFileSync(path.join(d, 'prompt.txt'), buildPrompt(name));
      const hp = path.join(ROOT, 'hf', 'videos', name);
      fs.rmSync(path.join(hp, '.done'), {force: true});
      runs.set(name, Date.now());
      await claude.startRun({root: ROOT, name, prompt: `Jalankan public/${name}/prompt.txt dari awal sampai selesai.`, appendSystem: extensionRules(ROOT)});
      return json(res, 200, {ok: true}), true;
    }
    // revision: continues the project's previous Claude session when there is one
    if (action === 'revise' && req.method === 'POST') {
      const text = (await readBody(req)).toString('utf8').trim().slice(0, 4000);
      if (!text) return json(res, 400, {error: 'Revisi kosong'}), true;
      const hp = path.join(ROOT, 'hf', 'videos', name);
      if (!fs.existsSync(path.join(hp, 'index.html'))) return json(res, 404, {error: 'Project belum ada'}), true;
      fs.writeFileSync(path.join(d, 'revisi.txt'), text);
      fs.rmSync(path.join(hp, '.done'), {force: true});
      runs.set(name, Date.now());
      await claude.startRun({root: ROOT, name, resume: true, appendSystem: extensionRules(ROOT), prompt: `Revisi video hf/videos/${name}:

${text}

Ikuti CLAUDE.md dan hf/README.md, jalankan npx hyperframes check sampai 0 error, jangan render. Terakhir tulis file hf/videos/${name}/.done.`});
      return json(res, 200, {ok: true}), true;
    }
    // follow-up chat message to the same session (no .done expected)
    if (action === 'claude-say' && req.method === 'POST') {
      const text = (await readBody(req)).toString('utf8').trim().slice(0, 4000);
      if (!text) return json(res, 400, {error: 'Pesan kosong'}), true;
      await claude.startRun({root: ROOT, name, resume: true, prompt: text, appendSystem: extensionRules(ROOT)});
      return json(res, 200, {ok: true}), true;
    }
    if (action === 'claude-events') {
      res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
      const from = Number(url.searchParams.get('from') ?? 0) || 0;
      const off = claude.subscribe(name, from, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => { clearInterval(ka); off(); });
      return true;
    }
    if (action === 'claude-answer' && req.method === 'POST') {
      const {reqId, allow, always} = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 200, {ok: claude.answerPermission(name, String(reqId), !!allow, !!always)}), true;
    }
    if (action === 'claude-stop' && req.method === 'POST') return json(res, 200, {ok: claude.stopRun(name)}), true;
    if (action === 'status') {
      const hp = path.join(ROOT, 'hf', 'videos', name);
      const done = fs.existsSync(path.join(hp, '.done'));
      const c = claude.runState(name);
      return json(res, 200, {running: c ? c.state === 'running' : runs.has(name) && !done, claude: c, done, project: fs.existsSync(path.join(hp, 'index.html')), started: runs.get(name) ?? null, data: fs.existsSync(path.join(d, 'data.json'))}), true;
    }
    if (action === 'timeline') {
      const hp = path.join(ROOT, 'hf', 'videos', name);
      if (!fs.existsSync(path.join(hp, 'index.html'))) return json(res, 404, {error: 'Project belum ada'}), true;
      try {
        const out = await runCapture(HF[0], [...HF.slice(1), 'timeline', '--json'], hp);
        return json(res, 200, JSON.parse(out.slice(out.indexOf('{')))), true;
      } catch (e) {
        return json(res, 500, {error: String(e.message ?? e)}), true;
      }
    }
    if (action === 'render' && req.method === 'POST') {
      const hp = path.join(ROOT, 'hf', 'videos', name);
      if (!fs.existsSync(path.join(hp, 'index.html'))) return json(res, 404, {error: 'Project belum ada'}), true;
      if (renderJob?.state === 'running') return json(res, 409, {error: `Masih render ${renderJob.name}`}), true;
      const quality = ['draft', 'standard', 'high'].includes(url.searchParams.get('quality')) ? url.searchParams.get('quality') : 'standard';
      fs.mkdirSync(path.join(ROOT, 'out'), {recursive: true});
      const file = path.join(ROOT, 'out', `${name}.mp4`);
      const proc = spawn(HF[0], [...HF.slice(1), 'render', '-o', `"${file}"`, '-q', quality], {cwd: hp, shell: true});
      renderJob = {name, file: `${name}.mp4`, state: 'running', pct: 0, log: [], started: Date.now(), proc};
      const onData = (c) => {
        const t = c.toString('utf8').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
        for (const raw of t.split(/[\r\n]+/)) {
          const line = raw.trim();
          if (!line) continue;
          // machine-readable progress: @hf-progress {"pct": 42, ...}
          if (line.startsWith('@hf-progress')) {
            try {
              renderJob.pct = Math.min(100, Number(JSON.parse(line.slice(12)).pct) || renderJob.pct);
            } catch {}
            continue;
          }
          if (line.startsWith('[INFO]') || line.startsWith('[DEBUG]')) continue;
          // drop progress bars and the spinner glyph in front of status lines, so repeats collapse
          const clean = line.replace(/^[█░▓▒\s]+/, '').replace(/^\S\s{2,}/, '');
          if (clean === '|') continue;
          if (renderJob.log[renderJob.log.length - 1] !== clean) renderJob.log.push(clean);
        }
        renderJob.log = renderJob.log.slice(-40);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close', (code) => {
        if (renderJob.state === 'running') renderJob.state = code === 0 ? 'done' : 'error';
        if (code === 0) renderJob.pct = 100;
        renderJob.ended = Date.now();
        renderJob.proc = null;
      });
      return json(res, 200, {ok: true}), true;
    }
    if (action === 'project' && req.method === 'GET') {
      const read = (f) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), 'utf8') : '');
      const files = fs.existsSync(d) ? fs.readdirSync(d) : [];
      return json(res, 200, {concept: read('concept.md'), transcript: read('transcript.txt'), meta: readMeta(name), assets: listAssets(name), audio: files.find((f) => f.startsWith('audio.')) ?? null, music: files.find((f) => f.startsWith('music.')) ?? null, logo: files.find((f) => /^logo\.(png|jpe?g|webp|svg)$/i.test(f)) ?? null, clips: listClips(d), refs: fs.existsSync(path.join(d, 'reference')) ? fs.readdirSync(path.join(d, 'reference')).filter((f) => VID_EXT.has(f.split('.').pop().toLowerCase())) : []}), true;
    }
    // voice-over (audio.*) and optional backsound (music.*)
    if ((action === 'audio' || action === 'music') && req.method === 'POST') {
      const ext = (url.searchParams.get('ext') ?? 'wav').toLowerCase().replace(/[^a-z0-9]/g, '');
      fs.mkdirSync(d, {recursive: true});
      for (const f of fs.readdirSync(d)) if (f.startsWith(`${action}.`)) fs.rmSync(path.join(d, f));
      fs.writeFileSync(path.join(d, `${action}.${ext}`), await readBody(req));
      return json(res, 200, {ok: true}), true;
    }
    // optional watermark / end-card logo: public/<name>/logo.<ext>
    if (action === 'logo' && req.method === 'POST') {
      const ext = (url.searchParams.get('ext') ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['png', 'jpg', 'jpeg', 'webp', 'svg'].includes(ext)) return json(res, 400, {error: 'Logo harus png, jpg, webp atau svg'}), true;
      fs.mkdirSync(d, {recursive: true});
      for (const f of fs.readdirSync(d)) if (/^logo\./i.test(f)) fs.rmSync(path.join(d, f));
      fs.writeFileSync(path.join(d, `logo.${ext}`), await readBody(req));
      return json(res, 200, {ok: true, file: `logo.${ext}`}), true;
    }
    if (action === 'logo' && req.method === 'DELETE') {
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (/^logo\./i.test(f)) fs.rmSync(path.join(d, f));
      return json(res, 200, {ok: true}), true;
    }
    if (action === 'music' && req.method === 'DELETE') {
      if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.startsWith('music.')) fs.rmSync(path.join(d, f));
      return json(res, 200, {ok: true}), true;
    }
    if (action === 'asset') {
      const f = safeFile(url.searchParams.get('file') ?? '');
      if (!f) return json(res, 400, {error: 'Format gambar tidak didukung'}), true;
      const ad = path.join(d, 'assets');
      if (req.method === 'POST') {
        fs.mkdirSync(ad, {recursive: true});
        // keep existing files: add -2, -3 ... on name clash
        let out = f;
        for (let k = 2; fs.existsSync(path.join(ad, out)); k++) out = f.replace(/(\.[a-z0-9]+)$/, `-${k}$1`);
        fs.writeFileSync(path.join(ad, out), await readBody(req));
        return json(res, 200, {ok: true, file: out}), true;
      }
      if (req.method === 'DELETE') {
        const target = path.join(ad, f);
        if (fs.existsSync(target)) fs.rmSync(target);
        return json(res, 200, {ok: true}), true;
      }
    }
    if (action === 'meta' && req.method === 'POST') {
      const {concept = '', template = '', aspect = '9:16', source = 'own', musicVol = 0.15, style = null, lang = 'id', yt = null, font = '', fps = 60} = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      fs.mkdirSync(d, {recursive: true});
      fs.writeFileSync(path.join(d, 'concept.md'), concept);
      fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({...readMeta(name), template, aspect: aspect === '16:9' ? '16:9' : '9:16', source: ['youtube', 'clip'].includes(source) ? source : 'own', musicVol: Math.max(0, Math.min(1, Number(musicVol) || 0)), style: style && ['template', 'reference'].includes(style.mode) ? {mode: style.mode, save: !!style.save, saveName: String(style.saveName ?? '').slice(0, 60), notes: String(style.notes ?? '').slice(0, 2000)} : null, lang: ['id', 'en', ''].includes(lang) ? lang : 'id', font: String(font ?? '').trim().slice(0, 80), fps: Math.max(1, Math.min(60, Math.round(Number(fps) || 60))), yt: source === 'youtube' && yt && YT_RE.test(yt.url ?? '') ? {url: yt.url, id: String(yt.id ?? ''), title: String(yt.title ?? ''), duration: Number(yt.duration) || 0, segments: (yt.segments ?? []).map((x) => ({s: Math.max(0, Math.round(+x.s || 0)), e: Math.max(0, Math.round(+x.e || 0))})).filter((x) => x.e > x.s)} : null, assets: listAssets(name)}, null, 2));
      return json(res, 200, {ok: true}), true;
    }
    // own clips: the main footage the user already has (its audio is the voice-over)
    if (action === 'clip' && req.method === 'POST') {
      const raw = url.searchParams.get('file') ?? '';
      const ext = (raw.split('.').pop() || '').toLowerCase();
      if (!VID_EXT.has(ext)) return json(res, 400, {error: 'Format video tidak didukung'}), true;
      const cd = path.join(d, 'clips');
      fs.mkdirSync(cd, {recursive: true});
      let n = listClips(d).length + 1;
      while (listClips(d).some((f) => f.startsWith(`clip${n}.`))) n++;
      const file = `clip${n}.${ext}`;
      fs.writeFileSync(path.join(cd, file), await readBody(req));
      return json(res, 200, {ok: true, file}), true;
    }
    // style reference videos: public/<name>/reference/, never used as footage
    if (action === 'ref' && req.method === 'POST') {
      const raw = url.searchParams.get('file') ?? '';
      const ext = (raw.split('.').pop() || '').toLowerCase();
      if (!VID_EXT.has(ext)) return json(res, 400, {error: 'Format video tidak didukung'}), true;
      const rd = path.join(d, 'reference');
      fs.mkdirSync(rd, {recursive: true});
      let n = 1;
      while (fs.readdirSync(rd).some((f) => f.startsWith(`ref${n}.`))) n++;
      const file = `ref${n}.${ext}`;
      fs.writeFileSync(path.join(rd, file), await readBody(req));
      return json(res, 200, {ok: true, file}), true;
    }
    if (action === 'ref' && req.method === 'DELETE') {
      const f = path.basename(url.searchParams.get('file') ?? '');
      const target = path.join(d, 'reference', f);
      if (f && fs.existsSync(target)) fs.rmSync(target);
      return json(res, 200, {ok: true}), true;
    }
    if (action === 'clip' && req.method === 'DELETE') {
      const f = path.basename(url.searchParams.get('file') ?? '');
      const target = path.join(d, 'clips', f);
      if (f && fs.existsSync(target)) fs.rmSync(target);
      return json(res, 200, {ok: true}), true;
    }
    // submit: write prompt.txt from everything the user prepared; Claude does all the processing
    if (action === 'submit' && req.method === 'POST') {
      if (!fs.existsSync(d)) return json(res, 400, {error: 'Project belum disimpan'}), true;
      const prompt = buildPrompt(name);
      fs.writeFileSync(path.join(d, 'prompt.txt'), prompt);
      return json(res, 200, {ok: true, prompt, file: `public/${name}/prompt.txt`}), true;
    }
    return json(res, 404, {error: 'not found'}), true;
  } catch (e) {
    return json(res, 500, {error: String(e)}), true;
  }
};

// ---------- HyperFrames Studio (one project at a time) ----------
// `hyperframes preview` serves a single project, so the panel starts it for the chosen project on the
// internal port and restarts it when the user opens another one. Everything that isn't the panel is proxied.
const HF_DIRS = [['videos', 'Video'], ['templates', 'Template'], ['library', 'Library']];
const listHfProjects = () => {
  const out = [];
  for (const [sub, kind] of HF_DIRS) {
    const base = path.join(ROOT, 'hf', sub);
    if (!fs.existsSync(base)) continue;
    const cands = fs.existsSync(path.join(base, 'index.html')) ? [base] : fs.readdirSync(base, {withFileTypes: true}).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name));
    for (const p of cands) {
      if (!fs.existsSync(path.join(p, 'index.html'))) continue;
      out.push({id: path.relative(path.join(ROOT, 'hf'), p).replace(/\\/g, '/'), name: path.basename(p), kind, mtime: fs.statSync(path.join(p, 'index.html')).mtimeMs});
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
};
let studio = null;
let studioProject = null;
// kill whatever still listens on a port: a preview left over from an earlier run would answer
// for the wrong project and the editor would wait forever
const freePort = (port) => {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', {encoding: 'utf8', windowsHide: true});
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().split(/\s+/);
        if (m.length >= 5 && /LISTENING/i.test(m[3]) && m[1].endsWith(`:${port}`) && m[4] !== String(process.pid)) pids.add(m[4]);
      }
      for (const pid of pids) execSync(`taskkill /pid ${pid} /t /f`, {stdio: 'ignore', windowsHide: true});
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, {stdio: 'ignore', shell: '/bin/sh'});
    }
  } catch {}
};
const startStudio = (id) => {
  const p = path.join(ROOT, 'hf', id);
  if (!fs.existsSync(path.join(p, 'index.html'))) throw new Error(`hf/${id} has no index.html`);
  if (studio && studioProject === id) return;
  if (studio) {
    studio.removeAllListeners('exit');
    try {
      if (process.platform === 'win32') execSync(`taskkill /pid ${studio.pid} /t /f`, {stdio: 'ignore', windowsHide: true});
      else studio.kill();
    } catch {}
  }
  freePort(STUDIO_PORT);
  studioProject = id;
  studioReady = false;
  studio = spawn(HF[0], [...HF.slice(1), 'preview', `"${p}"`, '--port', String(STUDIO_PORT), '--no-open', '--foreground', '--force-new'], {cwd: ROOT, shell: true, stdio: 'inherit'});
  studio.on('exit', (code) => {
    console.log(`HyperFrames Studio exited (${code})`);
    studio = null;
    studioError = `Preview server berhenti (kode ${code})`;
  });
  studioError = null;
};
let studioReady = false;
let studioError = null;

// floating button injected into every Studio page
const INJECT = `<script>(function(){if(document.getElementById('prep-panel-btn'))return;var a=document.createElement('a');a.id='prep-panel-btn';a.href='/panel';a.textContent='\\u2726 AutoVid Prep Panel';a.style.cssText='position:fixed;left:18px;bottom:18px;z-index:99999;padding:10px 18px;border-radius:999px;background:#FABA37;color:#0B1B2F;font:700 13px/1 system-ui,sans-serif;letter-spacing:.04em;text-decoration:none;box-shadow:0 8px 24px rgba(0,0,0,.35)';(document.body||document.documentElement).appendChild(a);})();</script>`;

const STARTING = () => `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><body style="background:#0B1B2F;color:#F6F6F6;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">${studioProject ? `HyperFrames Studio (${studioProject}) sedang start...` : 'Belum ada project HyperFrames.'} <a style="color:#FABA37;margin-left:8px" href="/panel">buka Prep Panel</a></body>`;

// ---------- reverse proxy to the Studio ----------
const proxy = (req, res) => {
  const headers = {...req.headers, host: `localhost:${STUDIO_PORT}`};
  // Studio's API rejects requests whose Origin doesn't match its Host, so rewrite both consistently
  if (headers.origin) headers.origin = `http://localhost:${STUDIO_PORT}`;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, `http://localhost:${STUDIO_PORT}`);
  // inject the panel button into Studio pages only, never into the composition the player embeds
  const wantsHtml = (req.headers.accept ?? '').includes('text/html') && !req.url.startsWith('/api/');
  if (wantsHtml) delete headers['accept-encoding']; // keep HTML uncompressed so we can inject
  const up = http.request({host: '127.0.0.1', port: STUDIO_PORT, path: req.url, method: req.method, headers}, (pr) => {
    const ct = pr.headers['content-type'] ?? '';
    if (wantsHtml && ct.includes('text/html')) {
      const chunks = [];
      pr.on('data', (c) => chunks.push(c));
      pr.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf8');
        html = html.includes('</body>') ? html.replace('</body>', `${INJECT}</body>`) : html + INJECT;
        const h = {...pr.headers};
        delete h['content-length'];
        delete h['content-encoding'];
        res.writeHead(pr.statusCode ?? 200, h);
        res.end(html);
      });
      return;
    }
    res.writeHead(pr.statusCode ?? 200, pr.headers);
    pr.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(503, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(STARTING());
    }
  });
  req.pipe(up);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (await handlePanel(req, res, url)) return;
  proxy(req, res);
});

// WebSocket / upgrade passthrough (Studio live reload)
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(STUDIO_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

// ---------- start ----------
// every hf project reads shared files through assets -> public; zips can't hold junctions, so recreate missing ones
for (const sub of ['library', ...['templates', 'videos'].flatMap((d) => (fs.existsSync(path.join(ROOT, 'hf', d)) ? fs.readdirSync(path.join(ROOT, 'hf', d)).map((n) => `${d}/${n}`) : []))]) {
  const dir = path.join(ROOT, 'hf', sub);
  const link = path.join(dir, 'assets');
  if (!fs.existsSync(path.join(dir, 'index.html')) || fs.existsSync(link)) continue;
  try {
    fs.symlinkSync(PUB, link, 'junction');
  } catch (e) {
    console.warn(`could not link ${link}: ${e.message}`);
  }
}

// open the most recently edited HyperFrames project (or HF_PROJECT=videos/<name>)
{
  const first = process.env.HF_PROJECT || listHfProjects()[0]?.id;
  if (first) startStudio(first);
}
const stop = () => {
  try {
    if (studio && process.platform === 'win32') execSync(`taskkill /pid ${studio.pid} /t /f`, {stdio: 'ignore', windowsHide: true});
    else if (studio) studio.kill();
  } catch {}
  freePort(STUDIO_PORT);
  process.exit(0);
};
process.on('exit', () => freePort(STUDIO_PORT));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

server.listen(PORT, () => {
  const link = `http://localhost:${PORT}`;
  console.log(`\n  Studio + Prep Panel: ${link}   (panel: ${link}/panel)\n`);
  if (!process.env.NO_OPEN) setTimeout(() => exec(process.platform === 'win32' ? `start "" ${link}` : `open ${link}`), 2500);
});

// ---------- panel page ----------
const PAGE = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AutoVid Prep Panel</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #0A0A0B; --panel: #111113; --raise: #17171A; --line: #232327; --line2: #2E2E33;
    --text: #EDEDEF; --sub: #8B8B93; --faint: #5A5A62;
    --accent: #FABA37; --ok: #4ADE80; --bad: #F87171;
    --r: 10px; --mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; height: 100%; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  button { font: inherit; color: inherit; }
  ::selection { background: #FABA3740; }

  /* shell */
  .app { display: grid; grid-template-columns: 248px 1fr; height: 100vh; }
  .nav { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; background: var(--bg); }
  .logo { height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 18px; border-bottom: 1px solid var(--line); font-weight: 600; letter-spacing: -0.01em; }
  .logo i { width: 18px; height: 18px; border-radius: 5px; background: var(--accent); display: block; }
  .logo span { color: var(--faint); font-weight: 500; }
  .navhead { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 8px; font-size: 12px; color: var(--sub); }
  .iconbtn { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--sub); cursor: pointer; display: grid; place-items: center; font-size: 15px; line-height: 1; }
  .iconbtn:hover { color: var(--text); border-color: var(--line2); }
  .search { margin: 0 12px 8px; }
  .list { overflow: auto; padding: 0 8px 16px; flex: 1; }
  .proj { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px; cursor: pointer; color: var(--sub); }
  .proj:hover { background: var(--raise); color: var(--text); }
  .proj.on { background: var(--raise); color: var(--text); }
  .proj .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj .p { font: 11px var(--mono); color: var(--faint); }
  .proj .p.full { color: var(--ok); }
  .navfoot { border-top: 1px solid var(--line); padding: 12px; }

  .body { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .top { height: 56px; flex: none; display: flex; align-items: center; gap: 12px; padding: 0 28px; border-bottom: 1px solid var(--line); }
  .crumb { color: var(--sub); }
  .crumb b { color: var(--text); font-weight: 500; }
  .spacer { flex: 1; }
  .scroll { overflow: auto; flex: 1; }
  .content { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 40px; max-width: 1280px; padding: 32px 28px 80px; }
  @media (max-width: 1100px) { .content { grid-template-columns: 1fr; } .rail { position: static !important; } }
  @media (max-width: 760px) { .app { grid-template-columns: 1fr; } .nav { display: none; } }

  /* buttons + fields */
  .btn { height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line2); background: var(--raise); cursor: pointer; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; color: var(--text); white-space: nowrap; transition: background .12s, border-color .12s; }
  .btn:hover { border-color: #3A3A40; background: #1D1D21; }
  .btn.primary { background: var(--text); color: #0A0A0B; border-color: var(--text); }
  .btn.primary:hover { background: #fff; }
  .btn.block { width: 100%; }
  .btn:disabled { opacity: .45; cursor: progress; }
  .kbd { font: 11px var(--mono); color: var(--faint); }
  input, select, textarea { width: 100%; font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; outline: none; transition: border-color .12s, box-shadow .12s; }
  input::placeholder, textarea::placeholder { color: var(--faint); }
  input:focus, select:focus, textarea:focus { border-color: #4A4A52; box-shadow: 0 0 0 3px #FFFFFF0D; }
  select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--sub) 50%), linear-gradient(135deg, var(--sub) 50%, transparent 50%); background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 32px; }
  select option { background: var(--panel); }
  textarea { min-height: 150px; resize: vertical; line-height: 1.6; }
  label.f { display: block; font-size: 12px; color: var(--sub); margin: 0 0 6px; }
  .hint { font-size: 12px; color: var(--faint); margin-top: 6px; }
  .mono { font-family: var(--mono); }

  /* sections */
  .sec { padding: 28px 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; }
  .sec:first-child { border-top: 0; padding-top: 4px; }
  @media (max-width: 900px) { .sec { grid-template-columns: 1fr; gap: 14px; } }
  .sec.wide { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .sec.wide > div:first-child { display: flex; align-items: baseline; gap: 12px; }
  .sec.wide p.d { margin: 0; }
  .sec h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.005em; display: flex; align-items: center; gap: 8px; }
  .sec h2 .ck { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--line2); flex: none; }
  .sec.done h2 .ck { border-color: var(--ok); background: var(--ok); box-shadow: inset 0 0 0 2.5px var(--bg); }
  .sec p.d { margin: 6px 0 0; color: var(--sub); font-size: 13px; }
  .row3x { display: grid; grid-template-columns: 1.4fr auto auto; gap: 16px; }
  @media (max-width: 900px) { .row3x { grid-template-columns: 1fr; } }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }

  .seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; }
  .seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; color: var(--sub); cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; }
  .seg button .ar { display: inline-block; border: 1.5px solid currentColor; border-radius: 2px; }
  .seg button[data-a="9:16"] .ar { width: 8px; height: 13px; }
  .seg button[data-a="16:9"] .ar { width: 14px; height: 8px; }
  .seg button.on { background: var(--raise); color: var(--text); box-shadow: 0 0 0 1px var(--line2); }

  .drop { border: 1px dashed var(--line2); border-radius: var(--r); padding: 22px; display: flex; align-items: center; gap: 14px; cursor: pointer; color: var(--sub); transition: border-color .12s, background .12s; }
  .drop:hover, .drop.hover { border-color: #55555D; background: var(--panel); color: var(--text); }
  .drop .ic { width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--line); display: grid; place-items: center; flex: none; color: var(--sub); }
  .drop strong { color: var(--text); font-weight: 500; display: block; }
  .drop small { color: var(--faint); font-size: 12px; }
  audio { width: 100%; height: 36px; margin-top: 12px; filter: invert(1) hue-rotate(180deg) brightness(.9); opacity: .85; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin-top: 12px; }
  .grid:empty { display: none; }
  .thumb { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--panel); border: 1px solid var(--line); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .x { position: absolute; top: 5px; right: 5px; width: 22px; height: 22px; border-radius: 6px; border: 0; background: #000000B0; color: #fff; cursor: pointer; font-size: 12px; opacity: 0; transition: opacity .12s; }
  .thumb:hover .x { opacity: 1; }
  .thumb .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 6px 5px; font: 10px var(--mono); color: #ddd; background: linear-gradient(transparent, #000000C0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thumb.up { opacity: .45; }

  /* template gallery */
  .fontrow { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 12px 16px; align-items: end; margin-bottom: 14px; }
  #fontCustom { grid-column: 1 / -1; }
  @media (max-width: 1100px) { .fontrow { grid-template-columns: 1fr; } }
  .smodes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 900px) { .smodes { grid-template-columns: 1fr; } }
  .smode { text-align: left; padding: 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; display: flex; gap: 12px; align-items: flex-start; }
  .smode:hover { border-color: var(--line2); }
  .smode.on { border-color: var(--text); background: var(--raise); }
  .smode .ic { width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line2); display: grid; place-items: center; flex: none; font-size: 13px; }
  .smode b { font-weight: 500; display: block; font-size: 13px; }
  .smode small { color: var(--faint); font-size: 12px; line-height: 1.4; display: block; margin-top: 2px; }
  .spane { margin-top: 18px; }
  .refgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
  .refgrid:empty { display: none; }
  .ref { position: relative; border-radius: 8px; overflow: hidden; border: 1px solid var(--line); background: #000; aspect-ratio: 9/16; }
  .ref video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ref .x { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 6px; border: 0; background: #000000B0; color: #fff; cursor: pointer; font-size: 12px; }
  .ref .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 8px 6px; font: 10px var(--mono); color: #ddd; background: linear-gradient(transparent, #000000C0); }
  .ref.up { opacity: .5; }
  .chk2 { display: flex; gap: 10px; align-items: flex-start; margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
  .chk2 input { width: auto; margin: 3px 0 0; accent-color: #EDEDEF; }
  .chk2 b { font-weight: 500; font-size: 13px; display: block; }
  .chk2 small { color: var(--faint); font-size: 12px; }
  .gbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; mask-image: linear-gradient(90deg, #000 90%, transparent); }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: none; }
  .tab { height: 28px; padding: 0 10px; border-radius: 6px; font-size: 13px; color: var(--sub); cursor: pointer; display: inline-flex; align-items: center; border: 0; background: transparent; }
  .tab:hover { color: var(--text); }
  .tab.on { color: var(--text); background: var(--raise); }
  .tab .c { font: 11px var(--mono); color: var(--faint); margin-left: 6px; }
  .tpls { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; }
  .tpls.v { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  .tpl { cursor: pointer; border-radius: var(--r); outline: 1px solid transparent; outline-offset: 3px; transition: outline-color .12s; }
  .tpl .pv { position: relative; aspect-ratio: 16/9; border-radius: var(--r); overflow: hidden; background: var(--panel); border: 1px solid var(--line); }
  .tpls.v .tpl .pv { aspect-ratio: 9/16; }
  .tpl .pv img, .tpl .pv video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .tpl .pv video { opacity: 0; transition: opacity .15s; }
  .tpl .pv .ph { position: absolute; inset: 0; display: flex; }
  .tpl .pv .ph i { flex: 1; }
  .tpl .pv .sel { position: absolute; right: 8px; top: 8px; width: 20px; height: 20px; border-radius: 50%; background: var(--text); color: #0A0A0B; display: none; place-items: center; font-size: 12px; font-weight: 600; }
  .tpl:hover .pv { border-color: var(--line2); }
  .tpl.on { outline-color: var(--text); }
  .tpl.on .pv .sel { display: grid; }
  .tpl .meta { display: flex; align-items: baseline; gap: 8px; padding: 9px 2px 0; }
  .tpl .meta b { font-weight: 500; font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tpl .meta .id { font: 11px var(--mono); color: var(--faint); }
  .tpl .sub { padding: 2px 2px 0; font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--faint); font-size: 13px; padding: 24px 0; }

  /* right rail */
  .rail { position: sticky; top: 32px; align-self: start; display: flex; flex-direction: column; gap: 16px; }
  .box { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
  .box .hd { padding: 14px 16px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--sub); display: flex; justify-content: space-between; }
  .box .bd { padding: 14px 16px; }
  .chk { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .chk li { display: flex; align-items: center; gap: 10px; color: var(--sub); font-size: 13px; }
  .chk li i { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--line2); flex: none; }
  .chk li.y { color: var(--text); }
  .chk li.y i { border-color: var(--ok); background: var(--ok); box-shadow: inset 0 0 0 2.5px var(--panel); }
  .chk li span.v { margin-left: auto; font: 11px var(--mono); color: var(--faint); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick { display: flex; gap: 12px; align-items: center; }
  .pick .im { width: 54px; aspect-ratio: 9/16; border-radius: 6px; overflow: hidden; background: var(--raise); border: 1px solid var(--line); flex: none; }
  .pick .im.h { width: 84px; aspect-ratio: 16/9; }
  .pick .im img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pick b { display: block; font-weight: 500; }
  .pick small { color: var(--faint); font-size: 12px; }
  .acts { display: flex; flex-direction: column; gap: 8px; }
  .status { font-size: 12px; color: var(--sub); min-height: 18px; word-break: break-word; }
  .status.ok { color: var(--ok); } .status.bad { color: var(--bad); }
  details.adv summary { cursor: pointer; color: var(--sub); font-size: 13px; list-style: none; display: flex; align-items: center; gap: 6px; }
  details.adv summary::before { content: '+'; font-family: var(--mono); color: var(--faint); }
  details.adv[open] summary::before { content: '–'; }
  details.adv .in { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
  /* process box in the rail */
  #procBox:not(:has(#busy:not([hidden]))) { display: none; }
  .busy { padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .busy .row { display: flex; align-items: center; gap: 10px; }
  .busy .sp { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--line2); border-top-color: var(--text); animation: spin .8s linear infinite; flex: none; }
  .busy.ok .sp { animation: none; border-color: var(--ok); background: var(--ok); box-shadow: inset 0 0 0 3px var(--panel); }
  .busy.bad .sp { animation: none; border-color: var(--bad); background: var(--bad); box-shadow: inset 0 0 0 3px var(--panel); }
  @keyframes spin { to { transform: rotate(360deg); } }
  .busy b { font-weight: 500; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .busy .el { font: 11px var(--mono); color: var(--faint); }
  .busy .ph { font-size: 12px; color: var(--sub); margin: 8px 0 0 24px; min-height: 18px; }
  .bar { position: relative; height: 4px; border-radius: 4px; background: var(--raise); overflow: hidden; margin: 10px 0 0 24px; }
  .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--text); border-radius: 4px; transition: width .3s ease; }
  .bar.ind i { width: 30% !important; animation: slide 1.1s ease-in-out infinite; }
  .busy.ok .bar i { background: var(--ok); width: 100% !important; animation: none; }
  .busy.bad .bar i { background: var(--bad); width: 100% !important; animation: none; }
  @keyframes slide { from { left: -30%; } to { left: 100%; } }
  #procBox pre { margin: 0; border: 0; border-radius: 0 0 12px 12px; background: transparent; font-size: 10.5px; line-height: 1.55; max-height: 220px; padding: 12px 16px; }
  .btn .sp { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
  .skel { background: linear-gradient(90deg, var(--raise) 0%, #222226 50%, var(--raise) 100%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; border-radius: 6px; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  pre { margin: 16px 0 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); padding: 14px; font: 12px/1.6 var(--mono); color: var(--sub); max-height: 320px; overflow: auto; white-space: pre-wrap; }

  /* prompt modal */
  .modal { position: fixed; inset: 0; z-index: 30; background: #000000B8; display: grid; place-items: center; padding: 24px; animation: fade .15s ease; }
  .mbox { width: min(880px, 100%); max-height: calc(100vh - 48px); display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line2); border-radius: 14px; box-shadow: 0 30px 80px #000000A0; }
  .mhd { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .mhd b { display: block; font-weight: 600; }
  .mhd small { font: 11px var(--mono); color: var(--faint); }
  .mbox pre { margin: 0; border: 0; border-radius: 0; background: var(--bg); color: var(--text); max-height: none; flex: 1; overflow: auto; font-size: 12px; line-height: 1.65; padding: 18px 20px; }
  .mft { padding: 12px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--sub); }
  .mft .mono { color: var(--text); }
  /* splash */
  .splash { position: fixed; inset: 0; z-index: 20; background: #0A0A0BF2; display: grid; place-items: center; padding: 24px; animation: fade .2s ease; }
  @keyframes fade { from { opacity: 0; } }
  .splash .in { width: min(940px, 100%); }
  .splash h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .splash .lead { color: var(--sub); margin: 6px 0 24px; }
  .opts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 820px) { .opts { grid-template-columns: 1fr; } }
  .opt { text-align: left; padding: 22px; border-radius: 14px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; display: flex; flex-direction: column; gap: 14px; transition: border-color .12s, transform .12s; }
  .opt:hover { border-color: #4A4A52; transform: translateY(-2px); }
  .opt .ic { width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--line2); display: grid; place-items: center; }
  .opt b { font-size: 15px; font-weight: 600; display: block; }
  .opt span { color: var(--sub); font-size: 13px; }
  .opt ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--faint); }
  .opt ul li::before { content: '— '; }
  .splash .foot { margin-top: 18px; display: flex; justify-content: space-between; align-items: center; color: var(--faint); font-size: 12px; }
  .linkbtn { background: none; border: 0; color: var(--sub); cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 3px; font-size: 12px; }
  .linkbtn:hover { color: var(--text); }
  .srcpill { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 13px; }

  /* youtube */
  .urlrow { display: flex; gap: 8px; }
  .ytcard { margin-top: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); overflow: hidden; }
  .ythead { display: flex; gap: 14px; padding: 12px; align-items: center; border-bottom: 1px solid var(--line); }
  .ythead img { width: 120px; aspect-ratio: 16/9; object-fit: cover; border-radius: 6px; background: var(--raise); flex: none; }
  .ythead b { display: block; font-weight: 500; line-height: 1.35; }
  .ythead small { color: var(--faint); font-size: 12px; }
  .ytbody { padding: 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
  .ytframe { max-width: 560px; }
  .ytframe { aspect-ratio: 16/9; border-radius: 8px; overflow: hidden; background: #000; border: 1px solid var(--line); }
  .ytframe iframe { width: 100%; height: 100%; border: 0; display: block; }
  .tl { position: relative; height: 26px; margin-top: 12px; border-radius: 6px; background: var(--raise); border: 1px solid var(--line); overflow: hidden; }
  .tl i { position: absolute; top: 0; bottom: 0; background: #FABA3755; border-left: 2px solid var(--accent); border-right: 2px solid var(--accent); }
  .tl i.on { background: #FABA3799; }
  .tlx { display: flex; justify-content: space-between; font: 11px var(--mono); color: var(--faint); margin-top: 4px; }
  .segs { display: flex; flex-direction: column; gap: 8px; }
  .seg-row { display: grid; grid-template-columns: 22px auto 12px auto 56px auto auto; gap: 6px; align-items: center; }
  .seg-row .k { font: 11px var(--mono); color: var(--faint); }
  .tin { display: inline-flex; align-items: center; height: 34px; padding: 0 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); transition: border-color .12s, box-shadow .12s; }
  .tin:focus-within { border-color: #4A4A52; box-shadow: 0 0 0 3px #FFFFFF0D; }
  .tin.bad { border-color: var(--bad); }
  .tin input { width: 3.2ch; padding: 0; border: 0; background: transparent; box-shadow: none !important; font: 13px var(--mono); text-align: center; }
  .tin input.m { width: 3.6ch; text-align: right; }
  .tin input.s { text-align: left; }
  .tin span { font: 13px var(--mono); color: var(--faint); padding: 0 1px; user-select: none; }
  .tin small { font: 10px var(--mono); color: var(--faint); margin-left: 6px; user-select: none; }
  .seg-row .len { font: 11px var(--mono); color: var(--sub); min-width: 44px; text-align: right; }
  .seg-row .dash { color: var(--faint); text-align: center; }
  .seg-row .iconbtn { width: 28px; height: 28px; }
  .modes { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
  .radio { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
  .radio input { width: auto; margin: 3px 0 0; accent-color: #EDEDEF; }
  .radio b { font-weight: 500; display: block; font-size: 13px; }
  .radio small { color: var(--faint); font-size: 12px; }
  .radio:has(input:checked) { border-color: #4A4A52; background: var(--raise); }
  .note { margin-top: 12px; font-size: 12px; color: var(--faint); border-left: 2px solid var(--line2); padding-left: 10px; }
  .vol { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
  .vol input[type=range] { flex: 1; padding: 0; border: 0; background: none; accent-color: #EDEDEF; box-shadow: none; }
  .vol .mono { font-size: 12px; color: var(--sub); width: 36px; text-align: right; }
  .clist { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .clist:empty { display: none; }
  .crow { display: flex; align-items: center; gap: 12px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .crow video { width: 96px; aspect-ratio: 16/9; object-fit: cover; border-radius: 6px; background: #000; flex: none; }
  .crow .k { font: 11px var(--mono); color: var(--faint); width: 20px; }
  .crow .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crow .d { font: 12px var(--mono); color: var(--sub); }
  .crow.up { opacity: .5; }
  .dlbar { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  .dls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .dls a { font: 12px var(--mono); }
  .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb .tag { position: absolute; left: 5px; top: 5px; font: 10px var(--mono); padding: 1px 5px; border-radius: 4px; background: #000000B0; color: #fff; }
  .toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 80px); padding: 10px 16px; border-radius: 8px; background: var(--text); color: #0A0A0B; font-weight: 500; font-size: 13px; transition: transform .25s cubic-bezier(.2,.8,.2,1); box-shadow: 0 10px 30px #00000080; }
  .toast.show { transform: translate(-50%, 0); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #2A2A2F; border-radius: 10px; border: 3px solid var(--bg); }

  /* ===== light theme: white primary, navy secondary ===== */
  :root {
    --bg: #FFFFFF; --panel: #FFFFFF; --raise: #F3F5F9; --line: #E6EAF0; --line2: #D3DAE4;
    --text: #0B1B2F; --sub: #52627A; --faint: #94A1B4;
    --accent: #0B1B2F; --ok: #16A34A; --bad: #DC2626;
    --navy: #0B1B2F; --navy2: #17325A;
    --shadow: 0 1px 2px rgba(11,27,47,.04), 0 6px 20px rgba(11,27,47,.06);
  }
  body { background: #FFFFFF; }
  ::selection { background: #0B1B2F22; }
  .nav { background: #FFFFFF; border-right: 1px solid var(--line); }
  .logo i { background: var(--navy); }
  .top { background: #FFFFFFE6; }
  .content { max-width: 1320px; gap: 28px; padding-top: 28px; margin: 0 auto; }
  .btn { background: #FFFFFF; border-color: var(--line2); box-shadow: 0 1px 2px rgba(11,27,47,.05); }
  .btn:hover { background: var(--raise); border-color: var(--line2); }
  .btn.ghost { box-shadow: none; }
  .btn.primary { background: var(--navy); color: #FFFFFF; border-color: var(--navy); box-shadow: 0 6px 16px rgba(11,27,47,.18); }
  .btn.primary:hover { background: var(--navy2); }
  input, select, textarea { background: #FFFFFF; }
  input:focus, select:focus, textarea:focus, .tin:focus-within { border-color: #0B1B2F66; box-shadow: 0 0 0 3px #0B1B2F12; }
  .iconbtn { background: #FFFFFF; }

  /* every section is its own card */
  .sec, .sec:first-child { background: #FFFFFF; border: 1px solid var(--line); border-radius: 16px; padding: 24px 26px; margin-bottom: 18px; box-shadow: var(--shadow); }
  .sec h2 { font-size: 15px; }
  .sec.done h2 .ck { box-shadow: inset 0 0 0 2.5px #FFFFFF; }
  .box { background: #FFFFFF; box-shadow: var(--shadow); border-radius: 14px; }

  /* sidebar steps */
  .steps { list-style: none; margin: 4px 10px 0; padding: 0; gap: 2px !important; }
  .steps li { padding: 9px 10px; border-radius: 8px; cursor: pointer; }
  .steps li:hover { background: var(--raise); }
  .steps li .v { max-width: 90px; }
  .brand { margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
  .brand .wm { display: flex; align-items: center; gap: 8px; font-weight: 700; letter-spacing: -0.01em; color: var(--navy); }
  .brand .wm i { width: 14px; height: 14px; border-radius: 4px; background: var(--navy); display: block; }
  .brand .soc { display: flex; flex-direction: column; gap: 4px; }
  .brand .soc a { display: inline-flex; align-items: center; gap: 8px; color: var(--sub); text-decoration: none; font-size: 12px; }
  .brand .soc a:hover { color: var(--navy); }
  .brand .cp { font-size: 11px; color: var(--faint); }
  .navnote { margin: 18px 18px 0; padding: 12px; border-radius: 10px; background: var(--raise); color: var(--sub); font-size: 12px; line-height: 1.55; }
  .navnote b { color: var(--text); font-weight: 600; }
  .navfoot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
  .chk li.y i { box-shadow: inset 0 0 0 2.5px #FFFFFF; }

  .drop { background: #FAFBFD; }
  .drop:hover, .drop.hover { border-color: #0B1B2F55; background: #F4F6FA; }
  .seg { background: var(--raise); }
  .seg button.on { background: #FFFFFF; box-shadow: 0 1px 3px rgba(11,27,47,.12); }
  .tab.on { background: var(--navy); color: #FFFFFF; }
  .tab.on .c { color: #FFFFFFAA; }
  .tpl.on { outline-color: var(--navy); }
  .tpl .pv { box-shadow: 0 1px 2px rgba(11,27,47,.06); }
  .tpl .pv .sel { background: var(--navy); color: #FFFFFF; }
  .smode, .opt, .radio, .chk2, .crow { background: #FFFFFF; }
  .smode.on { border-color: var(--navy); background: #F5F7FB; box-shadow: 0 0 0 1px var(--navy) inset; }
  .opt { box-shadow: var(--shadow); }
  .opt:hover { border-color: var(--navy); }
  .chk2 input, .radio input, .vol input[type=range] { accent-color: var(--navy); }
  .ytcard { background: #FFFFFF; box-shadow: 0 1px 2px rgba(11,27,47,.05); }
  .tl i { background: #0B1B2F26; border-color: var(--navy); }
  .tl i.on { background: #0B1B2F55; }
  .skel { background: linear-gradient(90deg, #EEF1F5 0%, #E2E7EE 50%, #EEF1F5 100%); background-size: 200% 100%; }
  audio { filter: none; opacity: 1; }
  .splash { background: #FFFFFF; }
  .modal { background: #0B1B2F59; }
  .mbox { box-shadow: 0 30px 80px rgba(11,27,47,.25); }
  .mbox pre { background: #F7F9FC; color: var(--text); }
  .toast { background: var(--navy); color: #FFFFFF; box-shadow: 0 10px 30px rgba(11,27,47,.25); }
  .busy .sp { border-top-color: var(--navy); }
  .bar i { background: var(--navy); }
  .btn .sp { border-color: currentColor; border-right-color: transparent; }
  ::-webkit-scrollbar-thumb { background: #D3DAE4; border: 3px solid #FFFFFF; }

  /* fps */
  .fpsrow { display: flex; align-items: center; gap: 20px; }
  .fpsrow input[type=range] { flex: 1; padding: 0; border: 0; box-shadow: none !important; -webkit-appearance: none; appearance: none; height: 6px; border-radius: 6px; background: linear-gradient(90deg, var(--navy) var(--p, 100%), var(--raise) var(--p, 100%)); }
  .fpsrow input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #FFFFFF; border: 2px solid var(--navy); box-shadow: 0 2px 6px rgba(11,27,47,.25); cursor: pointer; }
  .fpsv { min-width: 84px; text-align: right; }
  .fpsv b { font: 600 28px/1 Inter, sans-serif; letter-spacing: -0.02em; }
  .fpsv span { color: var(--faint); font-size: 12px; margin-left: 4px; }
  .presets { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }
  @media (max-width: 900px) { .presets { grid-template-columns: repeat(3, 1fr); } }
  .presets button { padding: 10px 6px; border: 1px solid var(--line); border-radius: 10px; background: #FFFFFF; cursor: pointer; font: 600 15px Inter, sans-serif; color: var(--text); }
  .presets button small { display: block; font-weight: 400; font-size: 11px; color: var(--faint); margin-top: 2px; }
  .presets button:hover { border-color: var(--line2); background: var(--raise); }
  .presets button.on { border-color: var(--navy); background: var(--navy); color: #FFFFFF; }
  .presets button.on small { color: #FFFFFFB0; }
</style>
</head>
<body>
<div class="app">
  <aside class="nav">
    <div class="logo"><i></i>AutoVid <span>Prep Panel</span></div>
    <div class="navhead"><span>Langkah</span><span class="mono" id="prog">0/6</span></div>
    <ul class="steps chk">
      <li id="c1" data-to="s1"><i></i>Project<span class="v" id="v1"></span></li>
      <li id="cF" data-to="sF"><i></i>Frame rate<span class="v" id="vF">60 fps</span></li>
      <li id="c2" data-to="s2"><i></i><span id="l2">Voice-over</span><span class="v" id="v2"></span></li>
      <li id="cM" data-to="sM"><i></i>Backsound<span class="v" id="vM">opsional</span></li>
      <li id="c3" data-to="s3"><i></i>Aset<span class="v" id="v3"></span></li>
      <li id="c4" data-to="s4"><i></i>Style<span class="v" id="v4"></span></li>
      <li id="c5" data-to="s5"><i></i>Brief<span class="v" id="v5"></span></li>
    </ul>
    <div class="navnote">Isi tiap langkah, lalu klik <b>Submit</b>. Panel menyiapkan bahan dan menulis prompt; Claude yang mengerjakan videonya.</div>
    <div class="navfoot">
      <button class="btn block" onclick="pick(null)">+ Project baru</button>
      <select id="hfSel" class="btn block ghost" title="Project HyperFrames yang dibuka di Studio"></select>
      <button class="btn block ghost" onclick="openStudio()">Buka di Studio <span class="kbd">↗</span></button>
      <div class="brand">
        <div class="wm"><i></i>AutoVid</div>
        <div class="soc">
          <a href="https://instagram.com/autovid.id" target="_blank" rel="noopener" title="Instagram"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>@autovid.id</a>
          <a href="https://www.tiktok.com/@autovid.id" target="_blank" rel="noopener" title="TikTok"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16.6 5.8A4.3 4.3 0 0 1 15.5 3h-3.1v12.4a2.6 2.6 0 1 1-1.8-2.5V9.7a5.7 5.7 0 1 0 4.9 5.7V9.1a7.3 7.3 0 0 0 4.3 1.4V7.4a4.3 4.3 0 0 1-3.2-1.6z"/></svg>@autovid.id</a>
        </div>
        <div class="cp">© AutoVid HyperFrames Kit</div>
      </div>
    </div>
  </aside>

  <div class="body">
    <header class="top">
      <div class="crumb">Project / <b id="crumb">Project baru</b></div>
      <div class="spacer"></div>
      <span class="kbd">public/<span id="pathName">&lt;nama&gt;</span>/</span>
    </header>

    <div class="scroll">
      <div class="content">
        <main>
          <section class="sec" id="s1">
            <div><h2><span class="ck"></span>Project</h2><p class="d">Nama folder dan format video.</p></div>
            <div class="row3x">
              <div>
                <label class="f" for="name">Nama</label>
                <input id="name" placeholder="nama-project" autocomplete="off" spellcheck="false" />
                <div class="hint">Huruf kecil, angka, - atau _</div>
              </div>
              <div>
                <label class="f">Sumber</label>
                <div class="srcpill"><span id="srcLabel">Aset sendiri</span><button class="linkbtn" onclick="showSplash()">ganti</button></div>
              </div>
              <div>
                <label class="f">Format</label>
                <div class="seg" id="aspect"><button data-a="9:16" class="on"><span class="ar"></span>9:16</button><button data-a="16:9"><span class="ar"></span>16:9</button></div>
                <div class="hint" id="aspectHint">1080 × 1920 · Reels, TikTok, Shorts</div>
              </div>
            </div>
          </section>

          <section class="sec" id="sF">
            <div><h2><span class="ck"></span>Frame rate</h2><p class="d">Makin tinggi makin halus, render makin lama.</p></div>
            <div>
              <div class="fpsrow">
                <input type="range" id="fps" min="1" max="60" step="1" value="60" />
                <div class="fpsv"><b id="fpsv">60</b><span>fps</span></div>
              </div>
              <div class="presets" id="fpsPre">
                <button data-v="12">12<small>stop motion</small></button>
                <button data-v="24">24<small>sinematik</small></button>
                <button data-v="25">25<small>PAL</small></button>
                <button data-v="30">30<small>standar sosmed</small></button>
                <button data-v="50">50<small>halus</small></button>
                <button data-v="60">60<small>paling halus</small></button>
              </div>
            </div>
          </section>

          <section class="sec" id="sY" hidden>
            <div><h2><span class="ck"></span>Clip YouTube</h2><p class="d">Tempel link, pilih bagian yang mau dipotong.</p></div>
            <div>
              <div class="urlrow">
                <input id="ytUrl" placeholder="https://www.youtube.com/watch?v=…" spellcheck="false" />
                <button class="btn" id="ytGet" onclick="ytFetch()">Ambil data</button>
              </div>
              <div class="hint">Gunakan hanya video milik sendiri atau yang sudah ada izin pemiliknya.</div>
              <div class="ytcard" id="ytSkel" hidden>
                <div class="ythead"><div class="skel" style="width:120px;aspect-ratio:16/9"></div><div style="flex:1"><div class="skel" style="height:14px;width:70%"></div><div class="skel" style="height:10px;width:40%;margin-top:8px"></div></div></div>
                <div class="ytbody"><div class="skel" style="aspect-ratio:16/9;max-width:560px"></div></div>
              </div>
              <div class="ytcard" id="ytCard" hidden>
                <div class="ythead"><img id="ytThumb" alt="" /><div><b id="ytTitle"></b><small id="ytMeta"></small></div></div>
                <div class="ytbody">
                  <div>
                    <div class="ytframe" id="ytFrame"></div>
                    <div class="tl" id="ytTl"></div>
                    <div class="tlx"><span>0:00</span><span id="ytDur"></span></div>
                  </div>
                  <div>
                    <label class="f">Rentang clip <span class="kbd">menit : detik</span></label>
                    <div class="segs" id="segs"></div>
                    <button class="btn" style="margin-top:10px" onclick="addSeg()">+ Tambah rentang</button>
                    <div class="hint" id="segTotal"></div>
                    <div class="note">Clip di-download oleh Claude saat prompt dijalankan.</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="sec" id="sC" hidden>
            <div><h2><span class="ck"></span>Clip utama</h2><p class="d">Video milikmu. Suaranya dipakai sebagai voice-over.</p></div>
            <div>
              <div class="drop" id="dropClips">
                <div class="ic">▣</div>
                <div><strong>Upload clip</strong><small>Drop beberapa video sekaligus · mp4, mov, webm, mkv · diputar sesuai urutan</small></div>
              </div>
              <input type="file" id="fileClips" accept="video/*" multiple hidden />
              <div class="clist" id="clist"></div>
            </div>
          </section>

          <section class="sec" id="s2">
            <div><h2><span class="ck"></span>Voice-over</h2><p class="d">Claude mentranskripnya untuk timing kata.</p></div>
            <div>
              <div class="drop" id="dropAudio"></div>
              <input type="file" id="fileAudio" accept="audio/*" hidden />
              <audio id="player" controls hidden></audio>
            </div>
          </section>

          <section class="sec" id="sM">
            <div><h2><span class="ck"></span>Backsound <span class="kbd">opsional</span></h2><p class="d">Musik latar, diputar bareng voice-over.</p></div>
            <div>
              <div class="drop" id="dropMusic"></div>
              <input type="file" id="fileMusic" accept="audio/*" hidden />
              <audio id="mplayer" controls hidden></audio>
              <div class="vol" id="volRow" hidden>
                <label class="f" style="margin:0">Volume</label>
                <input type="range" id="mvol" min="0" max="0.6" step="0.01" value="0.15" />
                <span class="mono" id="mvolv">15%</span>
                <button class="btn" onclick="removeMusic()">Hapus</button>
              </div>
            </div>
          </section>

          <section class="sec" id="s3">
            <div><h2><span class="ck"></span>Aset <span class="kbd" id="assetCount"></span></h2><p class="d">Gambar dan video pendukung.</p></div>
            <div>
              <div class="drop" id="dropAssets">
                <div class="ic">＋</div>
                <div><strong>Tambah aset</strong><small>Drop banyak file sekaligus · png, jpg, webp, svg, gif, mp4, webm</small></div>
              </div>
              <input type="file" id="fileAssets" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden />
              <div class="grid" id="assets"></div>
            </div>
          </section>

          <section class="sec wide" id="s4">
            <div><h2><span class="ck"></span>Style</h2><p class="d">Tentukan gaya visual videonya.</p></div>
            <div>
              <div class="smodes" id="smodes">
                <button class="smode" data-m="template"><span class="ic">▦</span><span><b>Pakai template</b><small>Pilih dari koleksi style yang sudah ada.</small></span></button>
                <button class="smode" data-m="reference"><span class="ic">◎</span><span><b>Pakai video referensi</b><small>Upload video orang lain yang style-nya kamu suka.</small></span></button>
                <button class="smode" data-m=""><span class="ic">∅</span><span><b>Bebas</b><small>Tanpa arahan style, Claude yang menentukan.</small></span></button>
              </div>

              <div class="spane" id="paneTpl" hidden>
                <div class="gbar">
                  <div class="tabs" id="cats"></div>
                  <input id="tq" placeholder="Cari style" style="width:160px;flex:none" />
                </div>
                <select id="template" hidden></select>
                <div class="tpls" id="tpls"></div>
              </div>

              <div class="spane" id="paneRef" hidden>
                <div class="drop" id="dropRef">
                  <div class="ic">◎</div>
                  <div><strong>Upload video referensi</strong><small>Hanya jadi acuan gaya (warna, tipografi, transisi, ritme). Tidak dipakai sebagai aset.</small></div>
                </div>
                <input type="file" id="fileRef" accept="video/*" multiple hidden />
                <div class="refgrid" id="refs"></div>
                <div style="margin-top:14px"><label class="f" for="refNotes">Yang mau ditiru <span class="kbd">opsional</span></label>
                  <input id="refNotes" placeholder="Contoh: transisi whip, subtitle kuning per kata, warna gelap + neon" /></div>
                <label class="chk2"><input type="checkbox" id="refSave" /><div><b>Simpan sebagai template</b><small>Claude membuat style ini jadi template baru di koleksi, lengkap dengan preview.</small></div></label>
                <div id="refNameRow" hidden style="margin-top:10px"><label class="f" for="refName">Nama template</label><input id="refName" placeholder="Contoh: Podcast Neon" /></div>
              </div>
            </div>
          </section>

          <section class="sec" id="s5">
            <div><h2><span class="ck"></span>Brief</h2><p class="d">Konsep, mood, audiens, CTA, aset per bagian.</p></div>
            <div>
              <div class="fontrow">
                <div><label class="f" for="lang">Bahasa video</label>
                  <select id="lang"><option value="id">Indonesia</option><option value="en">English</option><option value="">Deteksi otomatis</option></select></div>
                <div><label class="f">Font</label>
                  <div class="seg" id="fontSeg"><button data-f="default" class="on">Default · Noto Sans KR</button><button data-f="custom">Custom</button></div></div>
                <div id="fontCustom" hidden><label class="f" for="font">Nama font</label>
                  <input id="font" placeholder="Contoh: Montserrat, Bebas Neue, Poppins" spellcheck="false" /></div>
              </div>
              <textarea id="concept" placeholder="Contoh: video promo 30 detik untuk jasa desain. Mood energik, target UMKM. Pakai logo di awal, screenshot dashboard di tengah. CTA: DM untuk konsultasi."></textarea>
            </div>
          </section>

        </main>

        <aside class="rail">
          <div class="box" id="pickBox" hidden>
            <div class="hd"><span>Style dipilih</span><button class="iconbtn" style="width:20px;height:20px;font-size:12px" title="Hapus" onclick="clearTpl()">✕</button></div>
            <div class="bd pick" id="pick"></div>
          </div>
          <div class="acts">
            <button class="btn primary block" id="go" onclick="submitProject()">Submit</button>
            <div class="hint" style="margin:0">Menyimpan semua bahan lalu membuat prompt lengkap untuk Claude.</div>
            <div class="status" id="status"></div>
          </div>
          <div class="box" id="procBox">
            <div class="busy" id="busy" hidden>
              <div class="row"><span class="sp"></span><b id="busyT">Memproses</b><span class="el" id="busyE">0:00</span></div>
              <div class="bar ind" id="busyBar"><i></i></div>
              <div class="ph" id="busyP"></div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  </div>
</div>
<div class="splash" id="splash" hidden>
  <div class="in">
    <div class="kbd" style="margin-bottom:10px">PROJECT BARU</div>
    <h1>Sudah punya asetnya?</h1>
    <p class="lead">Pilih bahan utama video. Gambar dan video pendukung bisa ditambah di semua pilihan.</p>
    <div class="opts">
      <button class="opt" onclick="chooseSource('youtube')">
        <div class="ic">▶</div>
        <div><b>Belum, ambil dari YouTube</b><span>Potong bagian video dari link.</span></div>
        <ul><li>Pilih detik mulai dan selesai</li><li>Beberapa rentang sekaligus</li></ul>
      </button>
      <button class="opt" onclick="chooseSource('own')">
        <div class="ic">♪</div>
        <div><b>Punya voice-over</b><span>Rekaman suara, visual dibuat dari gambar.</span></div>
        <ul><li>Upload rekaman VO</li><li>Tambah gambar dan video pendukung</li></ul>
      </button>
      <button class="opt" onclick="chooseSource('clip')">
        <div class="ic">▣</div>
        <div><b>Punya video sendiri</b><span>Clip jadi aset utama, suaranya jadi VO.</span></div>
        <ul><li>Tanpa upload voice-over</li><li>Beberapa clip, diputar berurutan</li></ul>
      </button>
    </div>
    <div class="foot">
      <span>Semua file disimpan di public/&lt;nama&gt;/</span>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="openSel" style="width:220px"><option value="">Lanjutkan project…</option></select>
        <button class="linkbtn" id="splashClose" onclick="hideSplash()">Tutup</button>
      </div>
    </div>
  </div>
</div>
<div class="modal" id="pm" hidden>
  <div class="mbox">
    <div class="mhd">
      <div><b>Prompt siap</b><small id="pmFile"></small></div>
      <div style="display:flex;gap:8px"><button class="btn" onclick="$('pm').hidden = true">Tutup</button><button class="btn primary" onclick="copyPrompt()">Copy prompt</button></div>
    </div>
    <pre id="pmText"></pre>
    <div class="mft">Tempel di Claude Code, atau cukup ketik: <span class="mono" id="pmShort"></span></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let audioFile = null, musicFile = null, musicSaved = false, projects = [], templates = [], assets = [];
let source = 'own', yt = {info: null, url: '', segs: [], sel: 0};
const VID = /\.(mp4|webm|mov)$/i;
const MUSIC_EMPTY = '<div class="ic">♫</div><div><strong>Upload backsound</strong><small>Opsional · wav, mp3, m4a</small></div>';
// time helpers: "1:23" / "83" / "1:02:03" <-> seconds
const toSec = (v) => { v = String(v).trim(); if (!v) return NaN; const p = v.split(':').map(Number); if (p.some(isNaN)) return NaN; return p.reduce((a, b) => a * 60 + b, 0); };
const fmt = (x) => { if (!isFinite(x)) return ''; x = Math.max(0, Math.round(x * 10) / 10); const h = Math.floor(x / 3600), m = Math.floor(x % 3600 / 60), sec = x % 60; const ss = (sec < 10 ? '0' : '') + (Number.isInteger(sec) ? sec : sec.toFixed(1)); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss; };
const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,40}$/;
const AUDIO_EMPTY = '<div class="ic">♪</div><div><strong>Upload audio</strong><small>Drop file atau klik · wav, mp3, m4a</small></div>';
const api = (a, q = '') => '/api/panel/' + a + (q ? '?' + q : '');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const toast = (t) => { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2000); };
const nameOk = () => { const n = $('name').value.trim(); if (!NAME_RE.test(n)) { setStatus('Nama project belum valid.', 'bad'); $('name').focus(); return null; } return n; };
const setStatus = (t, cls = '') => { $('status').textContent = t; $('status').className = 'status ' + cls; };

function showSplash() { $('splash').hidden = false; $('splashClose').hidden = !$('name').value; }
function hideSplash() { $('splash').hidden = true; }
function chooseSource(src) { setSource(src); hideSplash(); if (!$('name').value) $('name').focus(); }
const SRC = {
  youtube: {label: 'YouTube', step: 'Clip YouTube', go: 'Proses clip'},
  own: {label: 'Voice-over', step: 'Voice-over', go: 'Simpan & transkrip'},
  clip: {label: 'Video sendiri', step: 'Clip utama', go: 'Proses clip'},
};
function setSource(src) {
  source = SRC[src] ? src : 'own';
  $('sY').hidden = source !== 'youtube';
  $('sC').hidden = source !== 'clip';
  $('s2').hidden = source !== 'own';
  $('srcLabel').textContent = SRC[source].label;
  $('l2').textContent = SRC[source].step;
  syncGo();
  markSteps();
}
function syncGo() { $('go').textContent = 'Submit'; }

// ---------- own clips ----------
let clips = [];
async function uploadClips(files) {
  const n = nameOk(); if (!n) return;
  busyStart('Upload clip', files.length + ' file');
  for (const f of files) {
    if (!f.type.startsWith('video/') && !/\.(mkv|m4v)$/i.test(f.name)) continue;
    const tmp = {name: f.name, local: URL.createObjectURL(f)};
    clips.push(tmp); renderClips();
    const r = await (await fetch(api('clip', 'name=' + n + '&file=' + encodeURIComponent(f.name)), {method: 'POST', body: f})).json();
    clips.splice(clips.indexOf(tmp), 1, r.file); renderClips();
  }
  busyEnd(true, 'Clip terupload'); toast('Clip tersimpan'); markSteps(); loadList();
}
async function removeClip(file) {
  const n = nameOk(); if (!n) return;
  await fetch(api('clip', 'name=' + n + '&file=' + encodeURIComponent(file)), {method: 'DELETE'});
  clips = clips.filter(c => c !== file); renderClips(); markSteps();
}
function renderClips() {
  const n = $('name').value.trim();
  $('clist').innerHTML = clips.map((c, i) => {
    const up = typeof c !== 'string';
    const src = up ? c.local : '/panel-files/' + n + '/clips/' + encodeURIComponent(c);
    return '<div class="crow' + (up ? ' up' : '') + '"><span class="k">' + String(i + 1).padStart(2, '0') + '</span><video src="' + src + '#t=1.5" muted preload="metadata" onloadedmetadata="this.parentNode.querySelector(\'.d\').textContent=fmt(this.duration)"></video><span class="n">' + esc(up ? c.name : c) + '</span><span class="d"></span>' +
      (up ? '<span class="kbd">upload…</span>' : '<button class="iconbtn" title="Hapus" onclick="removeClip(\'' + c + '\')">✕</button>') + '</div>';
  }).join('');
}

// ---------- progress indicator (rail) ----------
const busyS = {t0: 0, timer: 0, len: 0, total: 0, label: ''};
function busyStart(title, phase) {
  $('busy').hidden = false; $('busy').className = 'busy'; $('busyT').textContent = title;
  busyS.t0 = Date.now(); busyS.len = 0; busyS.total = 0;
  busyPhase(phase || 'Menyiapkan…', null);
  clearInterval(busyS.timer);
  const tick = () => { $('busyE').textContent = fmt(Math.floor((Date.now() - busyS.t0) / 1000)); };
  tick(); busyS.timer = setInterval(tick, 500);
}
function busyPhase(label, pct) {
  if (label != null) { busyS.label = label; }
  $('busyP').textContent = busyS.label + (pct != null ? ' · ' + Math.round(pct * 100) + '%' : '');
  $('busyBar').classList.toggle('ind', pct == null);
  if (pct != null) $('busyBar').firstChild.style.width = Math.max(2, Math.min(100, pct * 100)) + '%';
}
function busyEnd(ok, msg) {
  clearInterval(busyS.timer);
  $('busy').className = 'busy ' + (ok ? 'ok' : 'bad');
  busyPhase(msg, null);
  $('busyBar').classList.remove('ind');
}
// ---------- youtube ----------
async function ytFetch() {
  const u = $('ytUrl').value.trim();
  if (!u) { $('ytUrl').focus(); return; }
  $('ytGet').disabled = true; $('ytGet').innerHTML = '<span class="sp"></span>Mengambil'; setStatus('');
  $('ytCard').hidden = true; $('ytSkel').hidden = false;
  busyStart('Mengambil data video', 'Membaca info dari YouTube…');
  try {
    const r = await fetch(api('yt-info', 'url=' + encodeURIComponent(u)));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'gagal');
    yt.info = d; yt.url = u;
    if (!yt.segs.length) yt.segs = [{s: 0, e: Math.min(d.duration || 30, 30)}];
    renderYt();
    busyEnd(true, d.title);
  } catch (e) { setStatus('YouTube: ' + e.message, 'bad'); busyEnd(false, e.message); }
  $('ytSkel').hidden = true;
  $('ytGet').disabled = false; $('ytGet').textContent = 'Ambil data';
}
function renderYt() {
  const d = yt.info; $('ytCard').hidden = !d; if (!d) { markSteps(); return; }
  $('ytThumb').src = d.thumbnail || ('https://i.ytimg.com/vi/' + d.id + '/hqdefault.jpg');
  $('ytTitle').textContent = d.title;
  $('ytMeta').textContent = [d.uploader, fmt(d.duration), d.width && d.height ? d.width + '×' + d.height : ''].filter(Boolean).join(' · ');
  $('ytDur').textContent = fmt(d.duration);
  renderSegs(); previewSeg(yt.sel); syncGo();
}
function renderSegs() {
  const D = (yt.info && yt.info.duration) || 0;
  $('segs').innerHTML = yt.segs.map((x, i) =>
    '<div class="seg-row"><span class="k">' + String(i + 1).padStart(2, '0') + '</span>' +
    tin(x.s, i, 's') + '<span class="dash">–</span>' + tin(x.e, i, 'e') +
    '<span class="len">' + (x.e > x.s ? fmt(x.e - x.s) : '—') + '</span>' +
    '<button class="iconbtn" title="Preview" onclick="previewSeg(' + i + ')">▶</button>' +
    '<button class="iconbtn" title="Hapus" onclick="delSeg(' + i + ')"' + (yt.segs.length < 2 ? ' disabled' : '') + '>✕</button></div>').join('');
  $('segs').querySelectorAll('.tin').forEach(box => {
    const m = box.querySelector('.m'), sc = box.querySelector('.s');
    const check = () => {
      const mm = parseInt(m.value || '0', 10), ss = parseInt(sc.value || '0', 10), v = mm * 60 + ss, x = yt.segs[box.dataset.i];
      const ok = ss < 60 && (!D || v <= Math.ceil(D)); box.classList.toggle('bad', !ok); if (ok) x[box.dataset.k] = v;
      return ok;
    };
    const clean = (el, max) => { const v = el.value.replace(/\D/g, '').slice(0, max); if (v !== el.value) el.value = v; };
    m.oninput = () => { clean(m, 3); check(); };
    sc.oninput = () => { clean(sc, 2); check(); if (sc.value.length === 2) { const nx = box.parentNode.querySelectorAll('.tin input')[[...box.parentNode.querySelectorAll('.tin input')].indexOf(sc) + 1]; if (nx) nx.focus(), nx.select(); } };
    m.onkeydown = (e) => { if (e.key === ':' || e.key === '.' || (e.key === 'ArrowRight' && m.selectionStart === m.value.length)) { e.preventDefault(); sc.focus(); sc.select(); } };
    sc.onkeydown = (e) => { if ((e.key === 'Backspace' && !sc.value) || (e.key === 'ArrowLeft' && sc.selectionStart === 0)) { e.preventDefault(); m.focus(); m.setSelectionRange(m.value.length, m.value.length); } };
    [m, sc].forEach(el => { el.onfocus = () => el.select(); el.onblur = () => { if (check()) setTimeout(() => { if (!box.contains(document.activeElement)) renderSegs(); }, 0); }; });
  });
  const tot = yt.segs.reduce((a, x) => a + Math.max(0, x.e - x.s), 0);
  const bad = yt.segs.some(x => !(x.e > x.s));
  $('segTotal').textContent = bad ? 'Ada rentang yang selesai sebelum mulai.' : yt.segs.length + ' clip · total ' + fmt(tot);
  $('ytTl').innerHTML = D ? yt.segs.map((x, i) => '<i class="' + (i === yt.sel ? 'on' : '') + '" style="left:' + (x.s / D * 100) + '%;width:' + (Math.max(0, x.e - x.s) / D * 100) + '%"></i>').join('') : '';
  markSteps();
}
// minutes : seconds field; the colon is a label, not part of the input
function tin(v, i, k) {
  v = Math.max(0, Math.round(v || 0));
  return '<div class="tin" data-i="' + i + '" data-k="' + k + '"><input class="m" inputmode="numeric" value="' + Math.floor(v / 60) + '" aria-label="menit" /><span>:</span><input class="s" inputmode="numeric" value="' + String(v % 60).padStart(2, '0') + '" aria-label="detik" /></div>';
}
function addSeg() {
  const D = (yt.info && yt.info.duration) || 0, last = yt.segs[yt.segs.length - 1];
  const s = last ? Math.min(last.e + 5, Math.max(0, D - 10)) : 0;
  yt.segs.push({s, e: D ? Math.min(D, s + 15) : s + 15}); yt.sel = yt.segs.length - 1; renderSegs(); previewSeg(yt.sel);
}
function delSeg(i) { yt.segs.splice(i, 1); yt.sel = Math.min(yt.sel, yt.segs.length - 1); renderSegs(); }
function previewSeg(i) {
  const x = yt.segs[i]; if (!x || !yt.info) return; yt.sel = i;
  $('ytFrame').innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + yt.info.id + '?start=' + Math.floor(x.s) + '&end=' + Math.ceil(x.e) + '&rel=0&modestbranding=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>';
  $('ytTl').querySelectorAll('i').forEach((el, k) => el.classList.toggle('on', k === i));
}

// ---------- backsound ----------
function setMusicUi(label, sub, src) {
  $('dropMusic').innerHTML = label ? '<div class="ic">♫</div><div><strong>' + esc(label) + '</strong><small>' + sub + '</small></div>' : MUSIC_EMPTY;
  $('mplayer').hidden = !src; if (src) { $('mplayer').src = src; $('mplayer').volume = +$('mvol').value; }
  $('volRow').hidden = !src; markSteps();
}
async function removeMusic() {
  const n = $('name').value.trim();
  if (musicSaved && NAME_RE.test(n)) await fetch(api('music', 'name=' + n), {method: 'DELETE'});
  musicFile = null; musicSaved = false; setMusicUi(null); loadList();
}

async function init() {
  $('dropAudio').innerHTML = AUDIO_EMPTY;
  $('dropMusic').innerHTML = MUSIC_EMPTY;
  wireDrop('dropMusic', 'fileMusic', (files) => { const f = files[0]; if (!f) return; musicFile = f; setMusicUi(f.name, (f.size / 1e6).toFixed(1) + ' MB · belum disimpan', URL.createObjectURL(f)); });
  $('mvol').oninput = () => { $('mvolv').textContent = Math.round($('mvol').value * 100) + '%'; $('mplayer').volume = +$('mvol').value; };
  $('ytUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') ytFetch(); });
  wireDrop('dropClips', 'fileClips', uploadClips);
  templates = await (await fetch(api('templates'))).json();
  $('template').innerHTML = '<option value=""></option>' + templates.map(t => '<option value="' + t.id + '">' + t.id + '</option>').join('');
  document.querySelectorAll('#aspect button').forEach(b => b.onclick = () => setAspect(b.dataset.a));
  document.querySelectorAll('.smode').forEach(b => b.onclick = () => setStyleMode(b.dataset.m));
  document.querySelectorAll('#fontSeg button').forEach(b => b.onclick = () => setFontMode(b.dataset.f));
  wireDrop('dropRef', 'fileRef', uploadRefs);
  $('refSave').onchange = () => { $('refNameRow').hidden = !$('refSave').checked; if ($('refSave').checked) $('refName').focus(); };
  $('tq').oninput = () => renderTpls(curCat);
  $('openSel').onchange = () => { if ($('openSel').value) pick($('openSel').value); };
  document.querySelectorAll('.steps li').forEach(li => li.onclick = () => { const t = $(li.dataset.to === 's2' && source !== 'own' ? (source === 'youtube' ? 'sY' : 'sC') : li.dataset.to); if (t) t.scrollIntoView({behavior: 'smooth', block: 'start'}); });
  $('fps').oninput = () => setFps($('fps').value);
  document.querySelectorAll('#fpsPre button').forEach(b => b.onclick = () => setFps(b.dataset.v));
  renderTpls('Semua');
  await loadList();
  loadHf();
  setSource('own');
  showSplash();
}
let curCat = 'Semua', aspect = '9:16';
function setAspect(a) {
  aspect = a === '16:9' ? '16:9' : '9:16';
  document.querySelectorAll('#aspect button').forEach(b => b.classList.toggle('on', b.dataset.a === aspect));
  $('aspectHint').textContent = aspect === '16:9' ? '1920 × 1080 · YouTube, presentasi' : '1080 × 1920 · Reels, TikTok, Shorts';
  renderTpls(curCat);
}
const preview = (t) => (t && t.previews && t.previews[aspect]) || {};
function renderTpls(cat) {
  curCat = cat;
  const cats = ['Semua', ...new Set(templates.map(t => t.category))];
  const count = (c) => c === 'Semua' ? templates.length : templates.filter(t => t.category === c).length;
  $('cats').innerHTML = cats.map(c => '<button class="tab' + (c === cat ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '<span class="c">' + count(c) + '</span></button>').join('');
  document.querySelectorAll('.tab').forEach(el => el.onclick = () => renderTpls(el.dataset.c));
  const q = $('tq').value.trim().toLowerCase();
  const list = templates.filter(t => (cat === 'Semua' || t.category === cat) && (!q || (t.name + ' ' + t.id + ' ' + t.desc + ' ' + (t.bestFor || []).join(' ')).toLowerCase().includes(q)));
  $('tpls').classList.toggle('v', aspect === '9:16');
  $('tpls').innerHTML = list.length ? list.map(t => {
    const pr = preview(t);
    const ph = '<div class="ph">' + (t.palette.length ? t.palette : ['#17171A', '#1D1D21']).map(c => '<i style="background:' + c + '"></i>').join('') + '</div>';
    const pv = '<div class="pv">' + ph + (pr.poster ? '<img src="' + pr.poster + '" loading="lazy" alt="">' : '') +
      (pr.video ? '<video muted loop playsinline preload="none" src="' + pr.video + '"></video>' : '') + '<span class="sel">✓</span></div>';
    const sub = (t.bestFor && t.bestFor.length) ? t.bestFor.slice(0, 3).join(' · ') : t.desc;
    return '<div class="tpl" data-id="' + t.id + '" title="' + esc(t.desc) + '">' + pv + '<div class="meta"><b>' + esc(t.name) + '</b><span class="id">' + t.id + '</span></div><div class="sub">' + esc(sub) + '</div></div>';
  }).join('') : '<div class="empty">Tidak ada style yang cocok.</div>';
  document.querySelectorAll('.tpl').forEach(el => {
    el.onclick = () => { $('template').value = $('template').value === el.dataset.id ? '' : el.dataset.id; syncTpl(); };
    const v = el.querySelector('video');
    if (v) {
      el.onmouseenter = () => { v.style.opacity = 1; v.currentTime = 0; v.play().catch(() => {}); };
      el.onmouseleave = () => { v.pause(); v.style.opacity = 0; };
    }
  });
  syncTpl();
}
function setFps(v) {
  v = Math.max(1, Math.min(60, Math.round(+v || 60)));
  $('fps').value = v; $('fpsv').textContent = v;
  $('fps').style.setProperty('--p', ((v - 1) / 59 * 100) + '%');
  document.querySelectorAll('#fpsPre button').forEach(b => b.classList.toggle('on', +b.dataset.v === v));
  $('vF').textContent = v + ' fps';
}
function setFontMode(m) {
  document.querySelectorAll('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.f === m));
  $('fontCustom').hidden = m !== 'custom';
  if (m === 'custom') $('font').focus(); else $('font').value = '';
}
function clearTpl() { $('template').value = ''; syncTpl(); }
// ---------- style mode: template | reference | '' (free) ----------
let styleMode = null, refs = [];
function setStyleMode(m) {
  styleMode = m;
  document.querySelectorAll('.smode').forEach(b => b.classList.toggle('on', styleMode !== null && b.dataset.m === styleMode));
  $('paneTpl').hidden = styleMode !== 'template';
  $('paneRef').hidden = styleMode !== 'reference';
  if (styleMode !== 'template') { $('template').value = ''; }
  if (styleMode === 'template') renderTpls(curCat);
  syncTpl();
}
async function uploadRefs(files) {
  const n = nameOk(); if (!n) return;
  busyStart('Upload referensi', files.length + ' file');
  for (const f of files) {
    if (!f.type.startsWith('video/')) continue;
    const tmp = {name: f.name, local: URL.createObjectURL(f)};
    refs.push(tmp); renderRefs();
    const r = await (await fetch(api('ref', 'name=' + n + '&file=' + encodeURIComponent(f.name)), {method: 'POST', body: f})).json();
    refs.splice(refs.indexOf(tmp), 1, r.file); renderRefs();
  }
  busyEnd(true, 'Referensi tersimpan'); markSteps();
}
async function removeRef(file) {
  const n = nameOk(); if (!n) return;
  await fetch(api('ref', 'name=' + n + '&file=' + encodeURIComponent(file)), {method: 'DELETE'});
  refs = refs.filter(r => r !== file); renderRefs(); markSteps();
}
function renderRefs() {
  const n = $('name').value.trim();
  $('refs').innerHTML = refs.map(r => {
    const up = typeof r !== 'string';
    const src = up ? r.local : '/panel-files/' + n + '/reference/' + encodeURIComponent(r);
    return '<div class="ref' + (up ? ' up' : '') + '"><video src="' + src + '#t=1.5" muted loop playsinline preload="metadata" onmouseenter="this.play()" onmouseleave="this.pause()"></video>' +
      (up ? '' : '<button class="x" title="Hapus" onclick="removeRef(\'' + r + '\')">✕</button>') + '<div class="cap">' + esc(up ? r.name : r) + '</div></div>';
  }).join('');
}
function syncTpl() {
  const id = styleMode === 'template' ? $('template').value : '', t = templates.find(x => x.id === id);
  document.querySelectorAll('.tpl').forEach(el => el.classList.toggle('on', el.dataset.id === id));
  $('pickBox').hidden = !t;
  if (t) {
    const pr = preview(t);
    $('pick').innerHTML = '<div class="im' + (aspect === '16:9' ? ' h' : '') + '">' + (pr.poster ? '<img src="' + pr.poster + '" alt="">' : '') + '</div><div><b>' + esc(t.name) + '</b><small class="mono">' + t.id + ' · ' + esc(t.category) + '</small></div>';
  }
  markSteps();
}

// HyperFrames Studio shows one hf/ project at a time; pick it here
async function loadHf() {
  const r = await (await fetch(api('hf-projects'))).json();
  $('hfSel').innerHTML = r.projects.length
    ? r.projects.map(p => '<option value="' + esc(p.id) + '"' + (p.id === r.current ? ' selected' : '') + '>' + esc(p.kind + ' · ' + p.name) + '</option>').join('')
    : '<option value="">Belum ada project HyperFrames</option>';
}
async function openStudio() {
  const id = $('hfSel').value;
  if (!id) return toast('Belum ada project HyperFrames');
  const r = await fetch(api('studio', 'project=' + encodeURIComponent(id)), {method: 'POST'});
  if (!r.ok) return toast((await r.json()).error || 'Gagal membuka Studio');
  location.href = '/';
}

async function loadList() {
  projects = await (await fetch(api('projects'))).json();
  const cur = $('name').value;
  $('openSel').innerHTML = '<option value="">' + (projects.length ? 'Lanjutkan project…' : 'Belum ada project') + '</option>' +
    projects.map(p => '<option value="' + p.name + '"' + (p.name === cur ? ' selected' : '') + '>' + p.name + '</option>').join('');
}

async function pick(name) {
  let sm = null;
  $('name').value = name || ''; audioFile = null; assets = [];
  $('concept').value = ''; $('template').value = ''; $('lang').value = 'id'; setFontMode('default'); setFps(60); $('busy').hidden = true; clearInterval(busyS.timer); $('player').hidden = true; setStatus('');
  $('dropAudio').innerHTML = AUDIO_EMPTY;
  musicFile = null; musicSaved = false; setMusicUi(null); $('mvol').value = 0.15; $('mvol').oninput();
  yt = {info: null, url: '', segs: [], sel: 0}; $('ytUrl').value = ''; $('ytFrame').innerHTML = ''; renderYt();
  clips = []; refs = []; $('refNotes').value = ''; $('refSave').checked = false; $('refName').value = ''; $('refNameRow').hidden = true;
  if (name) {
    const d = await (await fetch(api('project', 'name=' + name))).json();
    $('concept').value = d.concept; $('template').value = d.meta.template || ''; setAspect(d.meta.aspect || '9:16'); assets = d.assets;
    if (d.audio) { $('dropAudio').innerHTML = '<div class="ic">♪</div><div><strong>' + esc(d.audio) + '</strong><small>Tersimpan · drop file baru untuk mengganti</small></div>'; $('player').src = '/panel-files/' + name + '/' + d.audio + '?t=' + Date.now(); $('player').hidden = false; }
    $('lang').value = d.meta.lang ?? 'id';
    if (d.meta.font) { setFontMode('custom'); $('font').value = d.meta.font; }
    setFps(d.meta.fps ?? 60);
    clips = d.clips || []; refs = d.refs || [];
    const st = d.meta.style || null;
    sm = st ? st.mode : (d.meta.template ? 'template' : null);
    if (st) { $('refNotes').value = st.notes || ''; $('refSave').checked = !!st.save; $('refName').value = st.saveName || ''; $('refNameRow').hidden = !st.save; }
    setSource(d.meta.source || 'own');
    if (d.meta.musicVol != null) { $('mvol').value = d.meta.musicVol; $('mvol').oninput(); }
    if (d.music) { musicSaved = true; setMusicUi(d.music, 'Tersimpan · drop file baru untuk mengganti', '/panel-files/' + name + '/' + d.music + '?t=' + Date.now()); }
    if (d.meta.yt && d.meta.yt.url) {
      $('ytUrl').value = d.meta.yt.url; yt.url = d.meta.yt.url;
      yt.segs = (d.meta.yt.segments || d.meta.yt.clips || []).map(c => ({s: c.s, e: c.e}));
      ytFetch();
    }
    hideSplash();
  } else { setAspect('9:16'); showSplash(); }
  renderAssets(); renderClips(); renderRefs();
  setStyleMode(sm);
  loadList();
}

function markSteps() {
  const n = $('name').value.trim();
  const st = {
    1: NAME_RE.test(n),
    2: source === 'youtube' ? !!yt.info && yt.segs.length > 0 && yt.segs.every(x => x.e > x.s)
      : source === 'clip' ? clips.some(c => typeof c === 'string') : (!!audioFile || !$('player').hidden),
    3: assets.length > 0,
    4: styleMode === 'template' ? !!$('template').value : styleMode === 'reference' ? refs.some(r => typeof r === 'string') : styleMode === '',
    5: $('concept').value.trim().length > 0,
  };
  for (const k in st) { $('s' + k).classList.toggle('done', st[k]); $('c' + k).classList.toggle('y', st[k]); }
  $('v1').textContent = st[1] ? n : '';
  $('sC').classList.toggle('done', st[2]);
  $('v2').textContent = source === 'youtube' ? (yt.info ? yt.segs.length + ' clip' : '') : source === 'clip' ? (clips.length ? clips.length + ' clip' : '') : (audioFile ? audioFile.name : (!$('player').hidden ? 'tersimpan' : ''));
  const hasMusic = !!musicFile || musicSaved;
  $('cM').classList.toggle('y', hasMusic); $('sM').classList.toggle('done', hasMusic);
  $('vM').textContent = hasMusic ? Math.round($('mvol').value * 100) + '%' : 'opsional';
  $('sY').classList.toggle('done', st[2]);
  $('v3').textContent = assets.length ? assets.length + ' file' : '';
  $('v4').textContent = styleMode === 'template' ? ($('template').value || 'pilih…') : styleMode === 'reference' ? (refs.length ? refs.length + ' referensi' : 'referensi') : styleMode === '' ? 'bebas' : '';
  $('v5').textContent = st[5] ? $('concept').value.trim().split(/\s+/).length + ' kata' : '';
  $('cF').classList.toggle('y', true); $('sF').classList.add('done');
  $('prog').textContent = (1 + [1, 2, 3, 4, 5].filter(k => st[k]).length) + '/6';
  $('crumb').textContent = n || 'Project baru';
  $('pathName').textContent = n || '<nama>';
}
$('name').addEventListener('input', () => { $('name').value = $('name').value.toLowerCase().replace(/\s+/g, '-'); markSteps(); });
$('concept').addEventListener('input', markSteps);

// audio
const setAudio = (f) => { audioFile = f; $('dropAudio').innerHTML = '<div class="ic">♪</div><div><strong>' + esc(f.name) + '</strong><small>' + (f.size / 1e6).toFixed(1) + ' MB · belum disimpan</small></div>'; $('player').src = URL.createObjectURL(f); $('player').hidden = false; markSteps(); };
wireDrop('dropAudio', 'fileAudio', (files) => files[0] && setAudio(files[0]));

// assets: upload immediately so they appear as thumbnails
wireDrop('dropAssets', 'fileAssets', uploadAssets);
async function uploadAssets(files) {
  const n = nameOk(); if (!n) return;
  for (const f of files) {
    if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) continue;
    const tmp = {name: f.name, local: URL.createObjectURL(f), uploading: true};
    assets.push(tmp); renderAssets();
    const r = await (await fetch(api('asset', 'name=' + n + '&file=' + encodeURIComponent(f.name)), {method: 'POST', body: f})).json();
    assets.splice(assets.indexOf(tmp), 1, r.file); renderAssets();
  }
  toast(files.length + ' aset tersimpan'); markSteps(); loadList();
}
async function removeAsset(file) {
  const n = nameOk(); if (!n) return;
  await fetch(api('asset', 'name=' + n + '&file=' + encodeURIComponent(file)), {method: 'DELETE'});
  assets = assets.filter(a => a !== file); renderAssets(); markSteps(); loadList();
}
function renderAssets() {
  const n = $('name').value.trim();
  $('assetCount').textContent = assets.length ? assets.length : '';
  $('assets').innerHTML = assets.map(a => typeof a === 'string'
    ? '<div class="thumb">' + (VID.test(a) ? '<video src="/panel-files/' + n + '/assets/' + encodeURIComponent(a) + '" muted loop playsinline onmouseenter="this.play()" onmouseleave="this.pause()"></video><span class="tag">video</span>' : '<img src="/panel-files/' + n + '/assets/' + encodeURIComponent(a) + '" alt="" />') + '<button class="x" title="Hapus" onclick="removeAsset(\'' + a + '\')">✕</button><div class="cap">' + a + '</div></div>'
    : '<div class="thumb up">' + (VID.test(a.name) ? '<video src="' + a.local + '" muted></video>' : '<img src="' + a.local + '" alt="" />') + '<div class="cap">upload…</div></div>').join('');
}

function wireDrop(dropId, inputId, onFiles) {
  const d = $(dropId), i = $(inputId);
  d.onclick = () => i.click();
  i.onchange = (e) => { onFiles([...e.target.files]); i.value = ''; };
  ['dragover', 'dragenter'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.classList.remove('hover'); }));
  d.addEventListener('drop', e => onFiles([...e.dataTransfer.files]));
}

async function saveMeta(n) {
  await fetch(api('meta', 'name=' + n), {method: 'POST', body: JSON.stringify({concept: $('concept').value, template: styleMode === 'template' ? $('template').value : '', aspect, source, musicVol: +$('mvol').value, lang: $('lang').value, font: $('fontCustom').hidden ? '' : $('font').value.trim(), fps: +$('fps').value,
    yt: source === 'youtube' && yt.info ? {url: yt.url, id: yt.info.id, title: yt.info.title, duration: yt.info.duration, segments: yt.segs} : null,
    style: styleMode ? {mode: styleMode, save: styleMode === 'reference' && $('refSave').checked, saveName: $('refName').value.trim(), notes: $('refNotes').value.trim()} : null})});
  if (musicFile) {
    setStatus('Upload backsound…');
    await fetch(api('music', 'name=' + n + '&ext=' + (musicFile.name.split('.').pop() || 'mp3')), {method: 'POST', body: musicFile});
    musicFile = null; musicSaved = true;
  }
  if (audioFile && source === 'own') {
    setStatus('Upload audio…');
    await fetch(api('audio', 'name=' + n + '&ext=' + (audioFile.name.split('.').pop() || 'wav')), {method: 'POST', body: audioFile});
    audioFile = null;
  }
}
// ---------- submit: save everything, then build the prompt for Claude ----------
async function submitProject() {
  const n = nameOk(); if (!n) return;
  const p = projects.find(x => x.name === n);
  if (source === 'own' && !audioFile && !(p && p.audio)) { setStatus('Upload voice-over dulu.', 'bad'); $('dropAudio').scrollIntoView({behavior: 'smooth', block: 'center'}); return; }
  if (source === 'clip' && !clips.some(c => typeof c === 'string')) { setStatus('Upload clip dulu.', 'bad'); $('dropClips').scrollIntoView({behavior: 'smooth', block: 'center'}); return; }
  if (source === 'youtube' && !yt.info) { setStatus('Ambil data video YouTube dulu.', 'bad'); $('ytUrl').focus(); return; }
  if (source === 'youtube' && (!yt.segs.length || yt.segs.some(x => !(x.e > x.s)))) { setStatus('Cek rentang clip.', 'bad'); return; }
  if (!$('fontCustom').hidden && !$('font').value.trim()) { setStatus('Isi nama font, atau pilih Default.', 'bad'); $('font').focus(); return; }
  if (styleMode === 'template' && !$('template').value) { setStatus('Pilih template, atau ganti ke Bebas.', 'bad'); $('s4').scrollIntoView({behavior: 'smooth', block: 'center'}); return; }
  if (styleMode === 'reference' && !refs.some(r => typeof r === 'string')) { setStatus('Upload video referensi dulu.', 'bad'); $('s4').scrollIntoView({behavior: 'smooth', block: 'center'}); return; }
  $('go').disabled = true; $('go').innerHTML = '<span class="sp"></span>Menyimpan';
  busyStart('Submit project', 'Menyimpan bahan…');
  try {
    await saveMeta(n);
    busyPhase('Menyusun prompt…', null);
    const r = await fetch(api('submit', 'name=' + n), {method: 'POST'});
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    busyEnd(true, 'Prompt siap');
    setStatus('Tersimpan di ' + d.file, 'ok');
    $('pmText').textContent = d.prompt; $('pmFile').textContent = d.file;
    $('pmShort').textContent = 'Jalankan ' + d.file;
    $('pm').hidden = false;
  } catch (e) { busyEnd(false, String(e.message || e)); setStatus('Gagal: ' + (e.message || e), 'bad'); }
  $('go').disabled = false; $('go').textContent = 'Submit'; loadList();
}
function copyPrompt() { navigator.clipboard.writeText($('pmText').textContent); toast('Prompt tersalin'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('pm').hidden = true; });
init();
</script>
</body>
</html>`;
