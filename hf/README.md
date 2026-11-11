# hf/: the HyperFrames side of this repo

New videos are HyperFrames projects (HTML rendered to video). The Remotion projects in `src/` stay as they are.

```
public/hfk/          shared runtime for every HF project: kit.js (HFK), kit.css, fonts/ (Noto Sans KR latin 400/500/700/900)
hf/
  videos/<name>/     one HF project per video (index.html + compositions/ + assets -> ../../../public)
  templates/T1..T5/  the 5 basic style templates, ported from src/templates (30fps)
  library/           the style library L01..L50: compositions/<id>.html, catalog.json, previews/<id>[-v].html, index.html = reel
  tools/
    new-video.mjs        scaffold hf/videos/<name> from public/<name> (inlines data.json as window.DATA)
    port-video.mjs       port a Remotion component to an HF project (finds every <Audio> and writes <audio> clips)
    port-library.mjs     one-time port of src/library -> hf/library (re-runnable)
    library-previews.mjs render panel previews (public/library/previews) with `hyperframes render`
    test-scene.cjs       render one library scene in Node to catch runtime errors fast
```

Every project's `assets/` is a junction to `public/`, so paths are `assets/<name>/audio.wav`, `assets/sfx/...`,
`assets/icons/...`, `assets/hfk/kit.js`. Delete a project's junction with
`cmd /c rmdir hf\videos\<name>\assets` **before** deleting the folder, or the delete follows it into `public/`.

## Commands

```bash
npm run dev                                   # Studio (one hf project) + Prep Panel on :3000; pick the project in the panel
node hf/tools/new-video.mjs <name>            # new project from public/<name>
cd hf/videos/<name> && npx hyperframes check  # lint + runtime + layout
cd hf/videos/<name> && npx hyperframes render -o ../../../out/<name>.mp4
npm run library:previews -- L51               # previews for a new library style
```

## Writing scenes

A scene is `compositions/<scene>.html` with everything inside `<template>`, mounted from `index.html` by a host
`<div id="x" data-composition-id="x" data-composition-src="compositions/x.html" data-start data-duration>`.
Host id = scene root `data-composition-id` = timeline key. Read the `/hyperframes` skill for the full contract.

Two ways to animate, mix freely:

1. **Native HTML + GSAP.** Elements in the markup with ids, one paused `gsap.timeline()` registered as
   `window.__timelines["<id>"]`, `fromTo` tweens at second positions. Best for Studio editing (click, retime, variables).
2. **HFK frame function** (how the library and the ported videos work). The scene is a pure function of the frame,
   written with `HFK.h(tag, props, ...children)` (JSX without the build step) and drawn by
   `HFK.mount('<id>', Scene, {fps, width, height})`. Same math as Remotion, so library code drops in as is:

```js
const {h, spS, rampS, interpolate, Easing} = HFK;
const FPS = 60;
const Scene = ({f}) => {
  const t = f / FPS;                       // seconds inside this scene
  const k = spS(t, 0.2);                   // spring that starts at 0.2 s (Remotion spring, seconds-based)
  return h('div', {style: {position: 'absolute', inset: 0, opacity: rampS(t, 0, 0.3), transform: `scale(${0.8 + 0.2 * k})`}}, 'HELLO');
};
HFK.mount('scene-intro', Scene, {fps: FPS, width: 1080, height: 1920});
```

HFK API (`public/hfk/kit.js`): `interpolate`, `spring`, `Easing`, `random`, `interpolateColors` (Remotion-identical);
`rampS(t,a,b,ease)`, `spS(t,t0,damping,stiffness,mass)` (seconds); library helpers `ramp/sp/step/mix/rnd` (60fps frames),
`Full`, `MotionBlur`, `Slot`, `useFrameInset`, `icon()`, `staticFile()` (-> `assets/...`), `AbsoluteFill`, `Sequence`, `Img`.

Rules that come from the format:
- No `Date.now()`, unseeded `Math.random()` (use `HFK.random(seed)`), timers or `fetch`. Data goes inline (`window.DATA`).
- Sound is never drawn by a scene: every voice/music/SFX is an `<audio id class="clip" data-start data-duration data-volume>`
  in `index.html`; overlapping clips get different `data-track-index`.
- Footage is a `<video class="clip">` in the HTML (`data-has-audio="true"` or `muted`), never inside an HFK function.
- Each file that uses Noto Sans KR declares its `@font-face` (lint checks per file); copy the block from any existing scene.
- `npx hyperframes check` must end with 0 errors.

## Library styles

`hf/library/catalog.json` lists every style (id, name, palette, desc, `v` 9:16 placement, `sound` entrance + SFX).
A style scene is drawn on a 1920x1080 stage and has variables `aspect` (9:16 | 16:9), `tin` and `tout` (whip
entrance/exit with motion blur). Mount one in a video with
`data-variable-values='{"aspect":"9:16","tin":"left"}'`, or copy its code as the starting point of a new scene.

Adding a style: write `hf/library/compositions/L51.html` (copy L01's structure), add its `catalog.json` entry,
write `previews/L51.html` and `L51-v.html` (copy L01's, change the id and SFX), add a host to `index.html`,
then `npm run library:previews -- L51`.

## What was ported, and how

| Part | Level | Notes |
|---|---|---|
| Library L01–L50 | HFK frame function, compiled from the TSX by `port-library.mjs` | Poster frames match the Remotion previews; math is Remotion-identical |
| Templates T1–T5 | HFK frame function (`port-video.mjs`) | 30fps, SFX found automatically |
| A ported Remotion video | HFK frame function (`port-video.mjs`) | voice + SFX become timed `<audio>` clips |
| TemplateA (talking head) | not ported | Its video moves inside the frame function; needs a rewrite with a `<video class="clip">` |
| Older videos in `src/` | not ported | Stay in Remotion (`npm run dev:remotion`). Port one with `port-video.mjs` when needed |
