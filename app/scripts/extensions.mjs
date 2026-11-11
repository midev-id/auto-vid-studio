// Extensions: drop a folder into extensions/ to add templates (and rules for Claude) without touching the app code.
//
//   extensions/<folder>/extension.json
//   {
//     "name": "Paket Template AutoVid",       // shown in the app
//     "version": "1.0.0",
//     "enabled": true,                         // optional, false = ignored
//     "rules": "rules.md",                     // optional: extra instructions appended to Claude's system prompt
//     "templates": [
//       {
//         "id": "X01",                         // unique across the app
//         "name": "Clean Minimal",
//         "category": "AutoVid",               // Library tab / style picker group
//         "desc": "Putih, satu aksen, banyak white space.",
//         "palette": ["#F7F7F5", "#111111", "#FF5A1F"],
//         "dir": "templates/clean-minimal",    // folder Claude starts from (relative to the extension)
//         "entry": "compositions/video.html",  // optional: main file inside dir
//         "preview":   {"16:9": "previews/x01.mp4",   "9:16": "previews/x01-v.mp4"},   // optional
//         "poster":    {"16:9": "previews/x01.jpg",   "9:16": "previews/x01-v.jpg"}    // optional
//       }
//     ]
//   }
//
// See extensions/README.md for the full guide.
import fs from 'node:fs';
import path from 'node:path';

export const EXT_DIR = (root) => path.join(root, 'extensions');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-_]{0,40}$/;

export const loadExtensions = (root) => {
  const base = EXT_DIR(root);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const d of fs.readdirSync(base, {withFileTypes: true})) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name.startsWith('.')) continue;
    const f = path.join(base, d.name, 'extension.json');
    if (!fs.existsSync(f)) continue;
    let m;
    try {
      m = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      out.push({folder: d.name, name: d.name, error: `extension.json rusak: ${e.message}`, templates: []});
      continue;
    }
    if (m.enabled === false) continue;
    const rulesFile = m.rules ? path.join(base, d.name, m.rules) : null;
    out.push({
      folder: d.name,
      name: String(m.name ?? d.name),
      version: String(m.version ?? ''),
      rules: rulesFile && fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, 'utf8').trim() : '',
      templates: (Array.isArray(m.templates) ? m.templates : []).filter((t) => t && ID_RE.test(String(t.id ?? ''))),
    });
  }
  return out;
};

const fileUrl = (folder, rel) => (rel ? `/ext-files/${encodeURIComponent(folder)}/${rel.split('/').map(encodeURIComponent).join('/')}` : null);

// templates in the same shape as hf/library entries, so the style picker and Library tab show them as-is
export const extensionTemplates = (root) =>
  loadExtensions(root).flatMap((e) =>
    e.templates.map((t) => ({
      id: String(t.id),
      name: String(t.name ?? t.id),
      category: String(t.category ?? e.name),
      desc: String(t.desc ?? ''),
      palette: Array.isArray(t.palette) ? t.palette.map(String) : [],
      bestFor: Array.isArray(t.bestFor) ? t.bestFor : [],
      group: 'library',
      ext: e.name,
      extPath: `extensions/${e.folder}/${String(t.dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, ''),
      entry: t.entry ? String(t.entry) : '',
      previews: Object.fromEntries(['16:9', '9:16'].map((a) => [a, {poster: fileUrl(e.folder, t.poster?.[a]), video: fileUrl(e.folder, t.preview?.[a])}])),
    })),
  );

export const extensionRules = (root) =>
  loadExtensions(root)
    .filter((e) => e.rules)
    .map((e) => `# Aturan dari extension "${e.name}"\n${e.rules}`)
    .join('\n\n');
