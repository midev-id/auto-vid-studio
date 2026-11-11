"""Transcribe public/<name>/audio.* locally (faster-whisper, no API) and write, all in public/<name>/:
  data.json       -> {fps, duration, words, chunks}; import it in the composition
  transcript.txt  -> readable script with timestamps (for planning scenes)

Usage: npm run transcribe -- <name> [--model medium] [--lang id] [--fix "salah=benar,..."]
"""
import argparse, glob, json, os, shutil, subprocess, sys

import numpy as np
from faster_whisper import WhisperModel

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 16000

ap = argparse.ArgumentParser()
ap.add_argument('name')
ap.add_argument('--model', default='medium')
ap.add_argument('--lang', default=None)
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--fix', default='', help='comma-separated wrong=right word replacements')
a = ap.parse_args()

src = [p for p in glob.glob(os.path.join(ROOT, 'public', a.name, 'audio.*'))]
if not src:
    sys.exit(f'No audio found: put it at public/{a.name}/audio.wav (or .mp3/.m4a)')

# ffmpeg may not be on the Windows PATH; fall back to ~/bin or the copy Remotion ships with
FFMPEG = next((p for p in [shutil.which('ffmpeg'),
                           os.path.expanduser('~/bin/ffmpeg.exe'),
                           os.path.join(ROOT, 'bin', 'ffmpeg', 'ffmpeg.exe'),
                           os.path.join(ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe')]
               if p and os.path.exists(p)), None)
if not FFMPEG:
    sys.exit('ffmpeg not found')

# decode with ffmpeg ourselves (faster-whisper's PyAV path is broken on this machine)
raw = subprocess.run([FFMPEG, '-loglevel', 'error', '-i', src[0], '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                     capture_output=True, check=True).stdout
audio = np.frombuffer(raw, dtype=np.float32).copy()
duration = round(len(audio) / SR, 2)

print(f'Transcribing {src[0]} ({duration}s) with model "{a.model}"...', flush=True)
model = WhisperModel(a.model, device='cpu', compute_type='int8')
segs, info = model.transcribe(audio, language=a.lang, word_timestamps=True, vad_filter=True)

fix = dict(p.split('=', 1) for p in a.fix.split(',') if '=' in p)
words, lines = [], []
for s in segs:
    lines.append(f'[{s.start:6.2f}-{s.end:6.2f}] {s.text.strip()}')
    print(lines[-1], flush=True)
    for w in s.words:
        t = w.word.strip()
        t = fix.get(t, fix.get(t.rstrip(',.?!'), None) and fix[t.rstrip(',.?!')] + t[len(t.rstrip(',.?!')):] or t)
        if t.startswith('-') and words:  # whisper splits "kira-kira" into "kira" + "-kira"
            words[-1]['t'] += t
            words[-1]['e'] = round(w.end, 2)
        else:
            words.append({'t': t, 's': round(w.start, 2), 'e': round(w.end, 2)})

# caption chunks: break on punctuation, pauses > 0.25s, or every 4 words
chunks, cur = [], []
for i, w in enumerate(words):
    if cur and (w['s'] - words[i - 1]['e'] > 0.25 or len(cur) >= 4):
        chunks.append(cur); cur = []
    cur.append(i)
    if w['t'][-1] in ',.?!':
        chunks.append(cur); cur = []
if cur:
    chunks.append(cur)

with open(os.path.join(ROOT, 'public', a.name, 'data.json'), 'w', encoding='utf8') as f:
    json.dump({'fps': a.fps, 'duration': duration, 'words': words,
               'chunks': [{'i0': c[0], 'i1': c[-1]} for c in chunks]}, f, ensure_ascii=False)

with open(os.path.join(ROOT, 'public', a.name, 'transcript.txt'), 'w', encoding='utf8') as f:
    f.write(f'# {a.name} | {duration}s | lang={info.language}\n\n' + '\n'.join(lines) + '\n\n# words\n')
    f.write(' '.join(f"{w['t']}@{w['s']}" for w in words) + '\n')

print(f'\nDone: public/{a.name}/data.json + transcript.txt ({len(words)} words)')
