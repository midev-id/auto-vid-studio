# Auto Vid Studio

Bikin video motion graphic (9:16 / 16:9) cukup pakai **Claude Code**: kasih voice-over + brief, Claude yang nyusun scene, nulis animasi (HyperFrames), dan nambahin SFX.

## Setup (sekali)

1. Install: [Claude Code](https://claude.com/claude-code), Node.js 20+, Python 3, Google Chrome, ffmpeg (ada di PATH).
2. `pip install faster-whisper numpy` (untuk transkrip voice-over).
3. Pasang skill HyperFrames di Claude Code:
   ```
   /plugin marketplace add heygen-com/hyperframes
   /plugin install hyperframes@hyperframes
   ```
4. Clone repo ini, lalu salin folder SFX dari Drive tim ke `public/sfx/` (file audio tidak ikut di repo).

## Bikin video

1. Buat folder `public/<nama-video>/`, isi `audio.mp3` (voice-over), opsional `logo.png`, `assets/`, `music.mp3`.
2. Buka Claude Code di folder repo ini, lalu tulis brief, contoh:
   > Bikin video `promo-riset` 9:16 dari voice-over di public/promo-riset, style L02, nuansa gelap aksen coral.
3. Preview: `cd hf/videos/<nama-video> && npx hyperframes preview`. Revisi tinggal chat ke Claude.
4. Render: `npx hyperframes render -o ../../../out/<nama-video>.mp4`.

## Isi repo

| Folder | Isi |
|---|---|
| `CLAUDE.md` | Aturan kerja Claude (dibaca otomatis) |
| `hf/library/` | 50 style (L01–L50), lihat `catalog.json` |
| `hf/templates/` | Template dasar T1–T5 |
| `extensions/` | Template tambahan (Day Series, dll) |
| `public/hfk/` | Runtime animasi + font |
| `public/sfx/` | Katalog SFX (audionya dari Drive) |
| `scripts/` | Transkrip, deteksi beat |
