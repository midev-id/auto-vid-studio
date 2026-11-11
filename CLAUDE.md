# CLAUDE.md: Auto Vid Studio workspace

This folder makes short videos (default 9:16, 1080×1920, 60fps) as **HyperFrames** projects (HTML rendered to video).
The user opens Claude Code in this repo and gives a brief (and usually a voice-over in `public/<name>/`).
If `public/<name>/prompt.txt` exists, follow it. Read `hf/README.md` and the `/hyperframes` skill before writing any composition.
Reply in the user's language (usually casual Indonesian), short and clear.

## First run on a machine

Before the first video, check `node`, `python`, `ffmpeg`, Chrome and `python -c "import faster_whisper"`, and that
`public/sfx/` has audio files. If anything is missing, tell the user to run
`powershell -ExecutionPolicy Bypass -File setup.ps1 -SfxZip <zip SFX>` (do not install things yourself without asking).
If the user has no voice-over yet, help write the script first; offer to pick a style from README's table.

## Workflow (what prompt.txt asks)

1. Bahan is in `public/<name>/`: `audio.*` (voice-over), optional `music.*`, `assets/`, optional `logo.*`,
   `concept.md` (brief), `project.json` (`template`, `aspect`, `fps`, `source`, `yt`, `style`).
2. Transcribe locally: `python scripts/transcribe.py <name> --lang id|en` → `data.json` + `transcript.txt`.
3. Scaffold: `node hf/tools/new-video.mjs <name>` → `hf/videos/<name>/` (index.html with `window.DATA`, voice/music
   `<audio>`, starter scene, `assets` → `public/`).
4. Write one `compositions/<scene>.html` per scene (native GSAP, or an `HFK.mount` frame function; see `hf/README.md`).
   Start from the chosen style: `hf/library/compositions/<Lxx>.html` (metadata in `hf/library/catalog.json`) or
   `hf/templates/<T#>/`.
5. `cd hf/videos/<name> && npx hyperframes check` until 0 errors. Then render only when the user asks: `npx hyperframes render -o ../../../out/<name>.mp4`.
6. Preview: `cd hf/videos/<name> && npx hyperframes preview` (Studio in the browser), revise on request.

## Rules

- Sync visuals to the word timestamps. Fix obvious transcription mistakes in on-screen text.
- Font: Noto Sans KR (`assets/hfk/fonts`), weights 700/900 for emphasis, unless the prompt names another font.
- On-screen text UPPERCASE unless the brief says otherwise.
- **Logo / watermark only when the user uploaded `public/<name>/logo.*`**: then a small watermark inside the safe area
  and the full logo on the end card. Never invent a logo.
- Safe area: 70–90px at the sides, nothing important in the top ~180px or bottom ~250px (9:16).
- Clear hierarchy, balanced white space, every visual supports what is said. No unrelated filler.
- Smooth motion: springs / eased bezier, overlapping scenes, motion blur on fast transitions (ghost copies or a short
  blur only while moving).
- SFX from `assets/sfx/` (check the file exists). The maker's main SFX set is `assets/sfx/core/` (73 files, described in
  `assets/sfx/core/catalog.json`); prefer it and use many: every visual action gets one, volume 0.15–0.3. Clicks: `sfx/mouse-click-sound.mp3`,
  typing: `sfx/typing-sound-efffect.mp3`. Icons from `assets/icons/`.
- Performance: no large static `filter: blur()`, no `backdropFilter`, no full-screen `maskImage`.
- Deterministic scenes: no `Date.now()`, `Math.random()` (use `HFK.random(seed)`), timers or fetch.
- No third-party product photos or brand logos unless the user supplied them.
- Never delete or change other projects.

## Gotchas

- `hf/**/assets` folders are junctions to `public/`. Remove a junction first (`cmd /c rmdir hf\videos\<name>\assets`)
  before deleting a project folder, or the delete reaches `public/`.
- Each file that uses Noto Sans KR declares its own `@font-face` (lint checks per file).
- Sound is never drawn by a scene: every voice/music/SFX is an `<audio id class="clip">` in `index.html`.
