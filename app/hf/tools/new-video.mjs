// Scaffold a new HyperFrames video project from the bahan in public/<name>/.
//   node hf/tools/new-video.mjs <name> [--fps 60] [--aspect 9:16|16:9] [--force]
// Creates hf/videos/<name>/:
//   index.html            root: data-fps, voice/music <audio>, one host per scene, window.DATA (inlined data.json)
//   compositions/main.html a starter scene (HFK.mount, function of the frame) to replace or split into scenes
//   hyperframes.json, package.json, assets -> ../../../public (junction: assets/<name>/audio.wav, assets/sfx/...)
// Re-run with --force after transcribing again to refresh window.DATA (index.html is otherwise left alone).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const name = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--force'));
if (!name || !/^[a-z0-9][a-z0-9-_]{0,40}$/.test(name)) {
  console.error('usage: node hf/tools/new-video.mjs <name> [--fps 60] [--aspect 9:16|16:9] [--force]');
  process.exit(1);
}
const PUB = path.join(ROOT, 'public', name);
const meta = fs.existsSync(path.join(PUB, 'project.json')) ? JSON.parse(fs.readFileSync(path.join(PUB, 'project.json'), 'utf8')) : {};
const fps = Number(opt('fps', meta.fps || 60));
const vertical = opt('aspect', meta.aspect || '9:16') !== '16:9';
const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
const OUT = path.join(ROOT, 'hf', 'videos', name);
const force = argv.includes('--force');

const data = fs.existsSync(path.join(PUB, 'data.json')) ? JSON.parse(fs.readFileSync(path.join(PUB, 'data.json'), 'utf8')) : null;
const files = fs.existsSync(PUB) ? fs.readdirSync(PUB) : [];
const audio = files.find((f) => f.startsWith('audio.'));
const music = files.find((f) => f.startsWith('music.'));
const dur = +((data ? data.duration : 10) + 0.8).toFixed(2);
const FONT_FACE = [400, 500, 700, 900].map((w) => `@font-face { font-family: 'Noto Sans KR'; src: url('assets/hfk/fonts/NotoSansKR-${w}.woff2') format('woff2'); font-weight: ${w}; }`);

fs.mkdirSync(path.join(OUT, 'compositions'), {recursive: true});
const indexPath = path.join(OUT, 'index.html');
if (!fs.existsSync(indexPath) || force) {
  const dataTag = data ? `<script id="data">window.DATA = ${JSON.stringify(data)};</script>` : '<script id="data">window.DATA = {words: [], chunks: [], duration: 10};</script>';
  if (fs.existsSync(indexPath) && force) {
    // refresh only the inlined transcript
    const cur = fs.readFileSync(indexPath, 'utf8').replace(/<script id="data">[\s\S]*?<\/script>/, dataTag);
    fs.writeFileSync(indexPath, cur);
  } else {
    fs.writeFileSync(indexPath, `<!doctype html>
<!-- ${name}: HyperFrames video (${W}x${H}, ${fps}fps). Bahan: public/${name}/ (served as assets/${name}/).
     Each scene is a host below mounting compositions/<scene>.html; sound is the <audio> clips. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <script src="assets/hfk/kit.js"></script>
    ${dataTag}
    <style>
      ${FONT_FACE.join('\n      ')}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; font-family: 'Noto Sans KR', sans-serif; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${dur}" data-fps="${fps}" data-width="${W}" data-height="${H}">
      <div id="scene-main" data-composition-id="scene-main" data-composition-src="compositions/main.html" data-start="0" data-duration="${dur}"
        data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>
${audio ? `      <audio id="voice" class="clip" src="assets/${name}/${audio}" data-start="0"${data ? ` data-duration="${data.duration}"` : ''} data-volume="1" data-track-index="2"></audio>\n` : ''}${music ? `      <audio id="music" class="clip" src="assets/${name}/${music}" data-start="0" data-duration="${dur}" data-volume="${meta.musicVol ?? 0.15}" data-fade-in="0.5" data-fade-out="0.5" data-track-index="3"></audio>\n` : ''}    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`);
  }
}
const scenePath = path.join(OUT, 'compositions', 'main.html');
if (!fs.existsSync(scenePath)) {
  fs.writeFileSync(scenePath, `<!-- Starter scene: a pure function of the frame, drawn by HFK.mount (see hf/README.md).
     Replace it, or split the video into one file per scene and mount each from index.html. -->
<template>
  <style>
    ${FONT_FACE.join('\n    ')}
    #root { position: absolute; inset: 0; overflow: hidden; background: #111; font-family: 'Noto Sans KR', sans-serif; }
  </style>
  <div id="root" data-composition-id="scene-main" data-width="${W}" data-height="${H}" data-layout-allow-overflow></div>
  <script>
    (function () {
      const {h, spS, rampS} = HFK;
      const FPS = ${fps};
      const Scene = ({f}) => {
        const t = f / FPS;
        const k = spS(t, 0.2);
        return h('div', {style: {position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 96, fontWeight: 900,
          opacity: rampS(t, 0, 0.3), transform: \`scale(\${0.8 + 0.2 * k})\`}}, '${name.toUpperCase()}');
      };
      HFK.mount('scene-main', Scene, {fps: FPS, width: ${W}, height: ${H}});
    })();
  </script>
</template>
`);
}
const hfJson = path.join(OUT, 'hyperframes.json');
if (!fs.existsSync(hfJson)) fs.writeFileSync(hfJson, JSON.stringify({$schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry', paths: {blocks: 'compositions', components: 'compositions/components', assets: 'assets'}, media: {autoProxy: true}}, null, 2) + '\n');
if (!fs.existsSync(path.join(OUT, 'assets'))) {
  if (process.platform === 'win32') execSync(`mklink /J "${path.join(OUT, 'assets')}" "${path.join(ROOT, 'public')}"`, {shell: 'cmd.exe', stdio: 'ignore'});
  else fs.symlinkSync(path.relative(OUT, path.join(ROOT, 'public')), path.join(OUT, 'assets'));
}
console.log(`hf/videos/${name}: ${W}x${H} @${fps}fps, ${dur}s${data ? `, ${data.words.length} words inlined` : ', no data.json yet'}`);
