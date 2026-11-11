# Auto Vid Studio

Bikin video motion graphic (9:16 / 16:9) cukup ngobrol dengan **Claude Code**: kasih voice-over + brief, Claude menyusun scene, menulis animasi (HyperFrames), menambah SFX, lalu render ke MP4.

## 1. Setup komputer baru (sekali)

Syarat: Windows 10/11 64-bit, RAM 8 GB+, langganan Claude Pro/Max (atau API key).

```powershell
git clone https://github.com/midev-id/auto-vid-studio.git
cd auto-vid-studio
powershell -ExecutionPolicy Bypass -File setup.ps1 -SfxZip "<link atau path zip SFX dari Drive tim>"
```

`setup.ps1` otomatis memasang yang belum ada: **Node.js, Python 3, ffmpeg, Git, Google Chrome, Claude Code**, paket Python untuk transkrip (`faster-whisper`), plugin **HyperFrames** untuk Claude, dan mengekstrak SFX. Aman dijalankan ulang kapan saja (yang sudah ada dilewati).

Setelah selesai: buka terminal baru, `cd auto-vid-studio`, ketik `claude`, login sekali.

> SFX tidak ada di repo (lisensi). Minta zip SFX ke mahdi / Drive tim.

## 2. Folder yang kamu pakai

```
auto-vid-studio/
├─ #bahan/       ← SATU FOLDER = SATU VIDEO (voice-over, logo, screenshot, brief.txt)
├─ #referensi/   ← contoh-contoh, otomatis dibaca Claude
│  ├─ sfx/         efek suara (+ _bawaan: 73 SFX bawaan)
│  ├─ video/       video yang gayanya mau ditiru
│  ├─ template/    desain/brand kit (+ _style-L01-L50, _template-T1-T5, _day-series)
│  └─ gambar/      logo, screenshot (+ _ikon-bawaan)
├─ #hasil/       ← video jadi (MP4) muncul di sini
└─ app/          ← mesin (style, template, SFX, tools), jangan diutak-atik
```

Folder berawalan `_` di `#referensi` adalah jalan pintas ke isi bawaan (dibuat otomatis oleh `setup.ps1`), jadi semua bisa dilihat di satu tempat.
Isi `#referensi/` dan `#bahan/` hanya ada di komputer kamu (tidak ikut GitHub). Mau berbagi ke tim? Lewat Drive.

## 3. Cara bikin video

1. Bikin folder di `#bahan/`, mis. `#bahan/promo-riset/`. Masukkan `audio.mp3` (voice-over) + gambar/logo kalau ada.
   Opsional `brief.txt` (contoh isi di `##bahan/contoh-video/brief.txt`).
2. Buka Claude di folder repo (ketik `claude` di terminal), lalu ketik:
   ```
   /video-baru promo-riset
   ```
   Belum punya voice-over? Bilang saja, Claude bantu tulis naskahnya.
3. Tunggu 5–20 menit. Video jadi di `#hasil/promo-riset.mp4`.
4. Mau ubah? Ketik misalnya:
   ```
   /revisi promo-riset judul scene 2 lebih besar, scene 3 kelamaan
   ```
5. Bingung pilih gaya? Ketik `/lihat-style`.

Tips: brief makin spesifik makin bagus (durasi, target, poin wajib, teks yang harus muncul, nuansa).
Mau meniru gaya video orang? Taruh videonya di `#referensi/video/` lalu bilang "tiru gaya video <nama file>".

## 4. Pilihan style & template

**Template dasar** (struktur video sudah jadi, Claude tinggal isi): `app/hf/templates/`

| ID | Gaya |
|---|---|
| T1 | Motion Graphic (umum) |
| T2 | Sketchbook (gambar tangan) |
| T3 | Kinetic (teks dinamis) |
| T4 | Neon |
| T5 | Glass (kaca transparan) |

**Day Series** (`app/extensions/day-series`, kota/dunia dibangun Day 1, 2, 3... mengikuti komentar netizen): X10 Anime, X11 Pixel, X12 Avatar, X13 Brick, X14 Paper.

**Library style L01–L50** (acuan tampilan, detail di `app/hf/library/catalog.json`, preview: buka `app/hf/library/index.html` lewat `npx hyperframes preview` di folder `app/hf/library`):

| ID | Nama | Tampilan | Cocok untuk |
|---|---|---|---|
| L01 | Minimalist | Lingkaran digambar, morph ke kotak, titik koral memantul. Banyak ruang kosong. | brand, quote, intro |
| L02 | Kinetic Typography | Kata per kata dihantam, geser, putar di latar hitam/kuning. | hook, voice-over, quote |
| L03 | Isometric | Kubus isometrik tumbuh bertahap, pin peta memantul. | tech, proses, data |
| L04 | Doodle / Hand-drawn | Buku bergaris, garis pensil tergambar sendiri, stabilo kuning. | tutorial, edukasi, tips |
| L05 | Comic / Pop Art | Sinar cepat, halftone, ledakan POW!, guncangan impact. | promo, hook, fun |
| L06 | 3D / CGI | Kubus 3D jatuh, lantai grid perspektif, bola mengorbit. | tech, produk, launch |
| L07 | Swiss / Editorial | Grid 12 kolom, judul raksasa naik, lingkaran merah, kolom caption. | editorial, brand, berita |
| L08 | Glitch | RGB split, irisan offset, scanline, teks SIGNAL LOST diketik. | hook, tech, gaming |
| L09 | Memphis / Geometric | Bentuk outline bayangan keras, squiggle, confetti, judul bertumpuk. | fun, promo, event |
| L10 | Infographic / Data | Bar naik dengan angka berjalan, donut %, grafik garis, +248%. | data, laporan, hasil iklan |
| L11 | Paper Cutout | 12fps, lapisan bukit kertas, matahari & awan kertas, label sobek. | cerita, anak, edukasi |
| L12 | 2D Character | Karakter jalan, berhenti, melambai, berkedip, balon kata. | cerita, explainer, maskot |
| L13 | Liquid | Blob cair bergoyang, tetesan bergabung, gelombang sinus naik. | brand, musik, transisi |
| L14 | Flat Design | Gunung, matahari, pohon flat; judul long shadow 40 lapis. | explainer, travel, edukasi |
| L15 | Corporate | Sapuan diagonal biru, logo bar, kartu KPI dengan area chart. | agency, laporan, B2B |
| L16 | Retro / Vintage | Sunburst berputar, badge EST. 1970, grain film, goresan, flicker. | kuliner, brand lokal, nostalgia |
| L17 | Cyberpunk | Skyline kota neon, hujan, judul neon berkedip, HUD. | gaming, tech, AI |
| L18 | Abstract / Experimental | Cincin titik berputar berlawanan, warna bergeser, lingkaran difference. | musik, art, intro |
| L19 | Type Collage | 9 stiker kata dihantam masuk, selotip, blok COLLAGE besar. | hook, fashion, list |
| L20 | UI/UX | Mockup HP, skeleton jadi konten, klik kursor, toggle, toast. | aplikasi, tutorial, SaaS |
| L21 | Claymation | 12fps, huruf tanah liat jatuh squash, bola memantul. | fun, anak, produk |
| L22 | Stop Motion | 10fps, sticky note di meja kayu, pensil & koin, cahaya berkedip. | tips, list, craft |
| L23 | Parallax / 2.5D | Lapisan bukit beda kecepatan, judul di antara lapisan, kabut & bulan. | cerita, travel, intro |
| L24 | Cinematic | Letterbox, glow teal/oranye, sapuan cahaya, anamorphic flare. | trailer, launch, brand |
| L25 | Mixed Media | Kartu kertas halftone sobek, selotip, kubus 3D, coretan tangan. | fashion, art, promo |
| L26 | Soft Kinetic | Kertas grid abu, kata tipis-tebal masuk blur per kata, kartu melayang ber-shadow, spark coral. | promo, explainer, ai |
| L27 | Modern UI | Kartu putih shadow berlapis, stat tile pop, toast, klik kursor. | clean |
| L28 | Neumorphism | Kontrol timbul satu warna, tombol ditekan, slider & toggle. | clean |
| L29 | Glassmorphism | Orb warna di balik kartu kaca transparan 3D. | digital |
| L30 | Bento Grid | Tile bento ala Apple muncul satu per satu. | clean |
| L31 | Brutalist | Border tebal, shadow keras, teks raksasa, marquee. | bold |
| L32 | Neon Sign | Tembok bata, tulisan neon berkedip nyala. | digital |
| L33 | Vaporwave | Matahari bergaris, grid perspektif, teks chrome. | retro |
| L34 | Pixel Art / 8-bit | Hati pixel tersusun, koin memantul, LEVEL UP. | retro |
| L35 | Blueprint | Grid biru teknis, garis tergambar, dimensi & label. | data |
| L36 | Terminal / Hacker | Teks hijau diketik, progress bar ASCII. | digital |
| L37 | Newspaper | Masthead koran, headline dihantam, stempel BREAKING. | type |
| L38 | Risograph | Dua tinta overprint, grain, misregistrasi. | handmade |
| L39 | Line Art | Satu garis menggambar bohlam yang menyala. | clean |
| L40 | Aurora Gradient | Pita aurora bergerak di balik judul. | abstract |
| L41 | Constellation | Titik bintang tersambung jadi jaringan. | abstract |
| L42 | Sticker Bomb | Stiker die-cut ditempel bertumpuk. | bold |
| L43 | Map Route | Rute peta tergambar, pesawat, pin bendera. | data |
| L44 | Chalkboard | Papan hijau, tulisan kapur, coretan. | handmade |
| L45 | Y2K Chrome | Teks chrome, bubble glossy, bintang kelip. | retro |
| L46 | Bauhaus | Bentuk primer menyusun komposisi. | clean |
| L47 | Typewriter | Huruf diketik satu-satu di kertas. | type |
| L48 | Duotone Split | Layar terbelah dua foto duotone, badge VS. | bold |
| L49 | Social Feed | Mockup HP, notifikasi, hati meledak. | digital |
| L50 | Luxury Gold | Bingkai emas, teks emas lebar, kilau. | film |

## Isi repo

| Folder | Isi |
|---|---|
| `CLAUDE.md` | Aturan kerja Claude (dibaca otomatis) |
| `hf/library/`, `app/hf/templates/`, `extensions/` | Style, template, Day Series |
| `app/public/hfk/` | Runtime animasi + font |
| `app/public/sfx/core/` | 73 SFX buatan sendiri (bebas kredit) |
| `app/scripts/` | Transkrip (`transcribe.py`), deteksi beat (`beats.py`) |
| `setup.ps1` | Installer semua kebutuhan |
