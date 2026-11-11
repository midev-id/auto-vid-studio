## Day Series (template X10–X14)
- Format serial harian "DAY N": kota/dunia yang dibangun sesuai komentar netizen. Satu episode = satu hari.
- Mulai dari `templates/<style>/` (copy index.html + compositions/video.html ke project). Yang diubah per episode
  cuma `window.DAYCFG` di compositions/video.html: day, followers, population, comment, request, cta, timelapse,
  `scenes` (start/dur, sinkron ke voice-over, start di grid 0.5 dtk) dan `captions` (1–3 kata per momen, bukan kalimat penuh).
- Scene yang ada: intro, stats, crowd, comment, build, request, cta, outro. Boleh diulang/diurutkan ulang/dihapus di `scenes`;
  geser juga SFX di index.html supaya tetap jatuh di aksi visualnya.
- Tetap 2D sesuai style (anime / pixel / avatar / brick / paper). Jangan 3D, jangan pakai logo/aset asli game atau merek.
- SFX dari `assets/sfx/core/` (lihat catalog.json di sana), volume 0.15–0.35, setiap aksi visual dapat SFX.
- Kalau mau ubah gambar/engine untuk semua episode: edit `extensions/day-series/src/engine.js` lalu
  `node extensions/day-series/src/build.mjs`.
