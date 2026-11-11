// Builds the Day Series templates from src/engine.js: one HyperFrames project per style in templates/<style>/,
// plus extension.json. Run after editing the engine or the defaults:  node extensions/day-series/src/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const EXT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(EXT, '..', '..');
const SFX_DIR = path.join(ROOT, 'public', 'sfx', 'autovid');
const FFPROBE = path.join(ROOT, 'bin', 'ffmpeg', 'ffprobe.exe');
const engine = fs.readFileSync(path.join(EXT, 'src', 'engine.js'), 'utf8');

const STYLES = [
  {id: 'X10', key: 'anime', name: 'Day Series · Anime', desc: 'Cel-shade anime: outline tebal, mata besar, blush, speed-line wipe, sparkle.', palette: ['#9FD8FF', '#FF5C8A', '#FFD23F', '#2B2340']},
  {id: 'X11', key: 'pixel', name: 'Day Series · Pixel Block', desc: 'Dunia blok pixel ala game sandbox: semua kotak 12px, gerak patah-patah 12fps, wipe blok.', palette: ['#7EC0FF', '#6DB33F', '#8B5A2B', '#3FD44A']},
  {id: 'X12', key: 'avatar', name: 'Day Series · Block Avatar', desc: 'Avatar kotak ala game avatar online: kepala kuning, baseplate grid, warna primer, iris wipe.', palette: ['#8FD3FF', '#00A2FF', '#FFC400', '#5ACB6E']},
  {id: 'X13', key: 'brick', name: 'Day Series · Toy Brick', desc: 'Mainan bata plastik: stud di atap & tanah, minifig kuning, transisi bata jatuh.', palette: ['#E3000B', '#FFD500', '#0055BF', '#4CB05A']},
  {id: 'X14', key: 'paper', name: 'Day Series · Paper Cutout', desc: 'Kertas potong flat: bayangan offset, warna pastel hangat, goyang halus, sobekan kertas.', palette: ['#F6E9D2', '#E86A4A', '#5B9BD5', '#3A3128']},
];

const DEFAULT = {
  day: 2,
  title: 'KOTA YANG DIATUR NETIZEN',
  handle: '@netizencity.id',
  mayor: 'Mayor NetizenCity',
  bio: 'Kota yang isinya diatur netizen.',
  followers: [0, 103],
  population: [1, 104],
  comment: {user: '@cha_cha_awk', text: 'bangun rumah dan jalanan!', likes: 87},
  request: {user: 'anonim', text: 'buat dapur MBG!', think: '?'},
  cta: ['JELASIN DI KOMEN', 'FOLLOW & SHARE', 'AJAK TEMANMU PINDAH'],
  timelapse: ['07:00', '13:00'],
  // 120 BPM grid: every start on 0.5 s
  scenes: [
    {id: 'intro', start: 0, dur: 3.5},
    {id: 'stats', start: 3.5, dur: 5.5},
    {id: 'crowd', start: 9, dur: 4},
    {id: 'comment', start: 13, dur: 5},
    {id: 'build', start: 18, dur: 6.5},
    {id: 'request', start: 24.5, dur: 4},
    {id: 'cta', start: 28.5, dur: 2.5},
    {id: 'outro', start: 31, dur: 3},
  ],
  // 1-3 keywords per moment (kinetic captions, no full subtitles)
  captions: [
    {t: 4.5, d: 1.5, text: 'KEMARIN: 0'},
    {t: 6, d: 2.5, text: 'HARI INI 103!', big: true},
    {t: 9.5, d: 3, text: 'SEKARANG RAME'},
    {t: 15.5, d: 2.5, text: 'RUMAH + JALAN'},
    {t: 22.5, d: 2, text: 'SEJUK & ESTETIK'},
    {t: 26.5, d: 2, text: 'DAPUR APA?'},
  ],
};

// sound: per style one transition + one "spawn" sound, the rest shared
const STYLE_SFX = {
  anime: {cut: 'sfx-swoosh-fast.mp3', spawn: 'sfx-pop-bubble.mp3', hit: 'sfx-sparkle.mp3'},
  pixel: {cut: 'sfx-ui-slide-swish.mp3', spawn: 'sfx-coin.mp3', hit: 'sfx-ui-confirm-2note.mp3'},
  avatar: {cut: 'sfx-whoosh-short.mp3', spawn: 'sfx-ui-rise-blip.mp3', hit: 'sfx-ping.mp3'},
  brick: {cut: 'sfx-thud-slam.mp3', spawn: 'sfx-pop.mp3', hit: 'sfx-ui-thump-soft.mp3'},
  paper: {cut: 'sfx-page-turn.mp3', spawn: 'sfx-pop-bubble.mp3', hit: 'sfx-chime.mp3'},
};
const cues = (key) => {
  const x = STYLE_SFX[key];
  const c = [
    [0.3, 'sfx-drum-hit.mp3', 0.25], [0.5, x.spawn, 0.3], [1.0, x.spawn, 0.3], [0.9, 'sfx-whoosh-short.mp3', 0.18],
    [3.7, 'sfx-notification.mp3', 0.22], [4.4, 'sfx-counter-ticks.mp3', 0.2], [5.8, x.hit, 0.25], [5.8, 'sfx-crowd-cheer.mp3', 0.15], [6.1, 'sfx-ui-ticks-8th.mp3', 0.2], [7.1, 'sfx-ui-ding-soft.mp3', 0.22],
    [9.2, 'sfx-footsteps.mp3', 0.15], [9.4, x.spawn, 0.25], [9.9, x.spawn, 0.25], [10.4, x.spawn, 0.25], [10.9, 'sfx-crowd-cheer.mp3', 0.18],
    [13.2, 'sfx-notification.mp3', 0.22], [13.5, 'sfx-typing.mp3', 0.25], [15.2, 'sfx-pop.mp3', 0.3], [15.2, 'sfx-ui-ding-soft.mp3', 0.2],
    [18.1, 'sfx-whoosh-low.mp3', 0.2], [18.3, 'sfx-clock-ticking.mp3', 0.15], [21.4, 'sfx-clock-ticking.mp3', 0.15],
    [24.6, 'sfx-notification.mp3', 0.22], [24.8, 'sfx-typing.mp3', 0.25], [26.1, 'sfx-record-scratch.mp3', 0.2], [26.1, x.spawn, 0.25],
    [28.7, 'sfx-click.mp3', 0.3], [29.2, 'sfx-click.mp3', 0.3], [29.7, 'sfx-click.mp3', 0.3],
    [31.0, 'sfx-whoosh-soft.mp3', 0.2], [32.0, 'sfx-chime-gleam.mp3', 0.25], [32.0, x.hit, 0.2],
  ];
  for (const s of DEFAULT.scenes) if (s.start > 0) c.push([s.start - 0.2, x.cut, 0.25]);
  for (const at of [1.0, 1.5, 1.9, 2.3, 2.8, 3.0, 3.3, 3.7, 4.1]) c.push([18 + at, x.spawn, 0.25]);
  return c.sort((a, b) => a[0] - b[0]);
};
const durCache = {};
const dur = (f) => (durCache[f] ??= Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(SFX_DIR, f)]).toString().trim()) || 1);

const TOTAL = DEFAULT.scenes.reduce((m, s) => Math.max(m, s.start + s.dur), 0);
const FONT = [400, 500, 700, 900].map((w) => `@font-face { font-family: 'Noto Sans KR'; src: url('assets/hfk/fonts/NotoSansKR-${w}.woff2') format('woff2'); font-weight: ${w}; }`).join('\n    ');

for (const st of STYLES) {
  const dir = path.join(EXT, 'templates', st.key);
  fs.mkdirSync(path.join(dir, 'compositions'), {recursive: true});
  // audio clips: greedy track assignment so overlapping clips never share a track
  const ends = [];
  const clips = cues(st.key).filter(([at, f]) => fs.existsSync(path.join(SFX_DIR, f)) && at < TOTAL).map(([at, f, vol], i) => {
    const d = Math.min(dur(f), TOTAL - at);
    let tr = ends.findIndex((e) => e <= at);
    if (tr < 0) tr = ends.push(0) - 1;
    ends[tr] = at + d;
    return `      <audio id="sfx${i}" class="clip" src="assets/sfx/core/${f}" data-start="${at}" data-duration="${d.toFixed(3)}" data-volume="${vol}" data-track-index="${tr + 2}"></audio>`;
  });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<!-- ${st.id} ${st.name}: HyperFrames project from extensions/day-series (built by src/build.mjs).
     Picture: compositions/video.html (edit window.DAYCFG there). Sound: the <audio> clips below (sfx from assets/sfx/core). -->
<html lang="id">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
    ${FONT}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #000; font-family: 'Noto Sans KR', sans-serif; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-fps="30" data-width="1080" data-height="1920">
      <div id="video" data-composition-id="video" data-composition-src="compositions/video.html" data-start="0" data-duration="${TOTAL}"
        data-track-index="1" data-track-kind="graphics" data-width="1080" data-height="1920"></div>
${clips.join('\n')}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`);
  fs.writeFileSync(path.join(dir, 'compositions', 'video.html'), `<!-- ${st.id} ${st.name}. Edit window.DAYCFG for each episode (day, numbers, comments, scene times, captions).
     The drawing engine below is generated from extensions/day-series/src/engine.js. -->
<template>
  <style>
    ${FONT}
    #root { position: absolute; inset: 0; overflow: hidden; background: #000; font-family: 'Noto Sans KR', sans-serif; }
  </style>
  <div id="root" data-composition-id="video" data-width="1080" data-height="1920" data-layout-allow-overflow></div>
  <script>
    window.DAYCFG = ${JSON.stringify({style: st.key, ...DEFAULT}, null, 2).replace(/\n/g, '\n    ')};
  </script>
  <script>
${engine}
  </script>
</template>
`);
  fs.writeFileSync(path.join(dir, 'hyperframes.json'), JSON.stringify({$schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', paths: {blocks: 'compositions', components: 'compositions/components', assets: 'assets'}, media: {autoProxy: true}}, null, 2));
  // assets/ -> public (junction), so preview, check and render find kit.js, fonts and sfx
  const j = path.join(dir, 'assets');
  if (!fs.existsSync(j)) fs.symlinkSync(path.join(ROOT, 'public'), j, 'junction');
  console.log('ok', st.id, st.key, `${clips.length} sfx`);
}

fs.writeFileSync(path.join(EXT, 'extension.json'), JSON.stringify({
  name: 'Day Series (kota netizen)',
  version: '1.0.0',
  rules: 'rules.md',
  templates: STYLES.map((s) => ({
    id: s.id, name: s.name, category: 'Day Series', desc: s.desc, palette: s.palette, bestFor: ['series harian', 'komentar netizen', 'storytelling'],
    dir: `templates/${s.key}`, entry: 'compositions/video.html',
    ...(fs.existsSync(path.join(EXT, 'previews', `${s.key}.mp4`)) ? {preview: {'9:16': `previews/${s.key}.mp4`}} : {}),
    poster: {'9:16': `previews/${s.key}.jpg`},
  })),
}, null, 2));
console.log('extension.json ok');
