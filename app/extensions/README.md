# Extensions — Auto Vid Studio

Tambah fitur tanpa ngoding app-nya: taruh satu folder di sini, klik **Setting → Muat ulang**.
Folder yang namanya diawali `_` atau `.` diabaikan (contoh: `_contoh/`). Copy `_contoh` → rename (mis. `autovid-pack`) untuk mulai.

```
extensions/
  autovid-pack/
    extension.json        ← wajib
    rules.md              ← opsional: aturan tambahan buat Claude (ditempel ke system prompt setiap run)
    templates/<nama>/     ← folder template (index.html + compositions/*.html), titik awal buat Claude
    previews/             ← opsional: preview .mp4/.jpg buat Library
```

## extension.json

| Field | Wajib | Isi |
|---|---|---|
| `name` | ya | Nama yang muncul di app |
| `version` | | Versi bebas |
| `enabled` | | `false` = dimatikan |
| `rules` | | File markdown aturan Claude |
| `templates[]` | | Daftar template |

Tiap template:

| Field | Wajib | Isi |
|---|---|---|
| `id` | ya | Unik (huruf/angka/-/_), mis. `X01` |
| `name`, `desc`, `category` | | Tampil di Library & pemilih style |
| `palette` | | Array warna hex |
| `dir` | ya | Folder template, relatif ke folder extension |
| `entry` | | File utama di dalam `dir` |
| `preview` / `poster` | | `{"16:9": "previews/a.mp4", "9:16": "previews/a-v.mp4"}` |

Template extension otomatis muncul di tab **Library** dan pemilih style di **Baru**. Waktu Generate, Claude disuruh
mulai dari folder `dir` template itu.

Tip: minta Claude yang bikin. Contoh di chat Claude di app: *"Bikinin extension baru di extensions/autovid-pack
berisi template dari video promo-studio, lengkap dengan extension.json dan preview."*
