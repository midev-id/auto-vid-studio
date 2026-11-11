"""Detect beats in public/<name>/music.* locally (ffmpeg + numpy, no API) -> public/<name>/beats.json
  {duration, bpm, beats:[s], downbeats:[s], kicks:[s], snares:[s], energy:[0..1 per 0.1s]}

Usage: python scripts/beats.py <name>
"""
import glob, json, os, shutil, subprocess, sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 22050
HOP = 256

name = sys.argv[1]
src = glob.glob(os.path.join(ROOT, 'public', name, 'music.*'))
if not src:
    sys.exit(f'No music at public/{name}/music.*')
FFMPEG = next((p for p in [shutil.which('ffmpeg'), os.path.expanduser('~/bin/ffmpeg.exe'),
                           os.path.join(ROOT, 'node_modules', '@remotion', 'compositor-win32-x64-msvc', 'ffmpeg.exe')]
               if p and os.path.exists(p)), None)
raw = subprocess.run([FFMPEG, '-loglevel', 'error', '-i', src[0], '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                     capture_output=True, check=True).stdout
y = np.frombuffer(raw, dtype=np.float32).copy()
duration = round(len(y) / SR, 3)

# STFT magnitude
N = 1024
win = np.hanning(N).astype(np.float32)
frames = 1 + (len(y) - N) // HOP
idx = np.arange(N)[None, :] + HOP * np.arange(frames)[:, None]
S = np.abs(np.fft.rfft(y[idx] * win, axis=1))
freqs = np.fft.rfftfreq(N, 1 / SR)
L = np.log1p(S * 10)
fps = SR / HOP


def flux(lo, hi):
    band = L[:, (freqs >= lo) & (freqs < hi)]
    d = np.maximum(0, np.diff(band, axis=0)).sum(axis=1)
    d = np.concatenate([[0], d])
    return d / (d.max() + 1e-9)


def peaks(env, thresh_k=1.4, min_gap=0.12):
    w = int(fps * 0.5)
    med = np.convolve(env, np.ones(w) / w, mode='same')
    out, last = [], -1e9
    for i in range(1, len(env) - 1):
        if env[i] > env[i - 1] and env[i] >= env[i + 1] and env[i] > med[i] * thresh_k and env[i] > 0.08:
            t = i / fps
            if t - last >= min_gap:
                out.append(round(t, 3))
                last = t
    return out


onset = flux(0, SR / 2)
kick_env = flux(30, 150)
snare_env = flux(1500, 6000)

# tempo by autocorrelation of onset envelope (70-180 bpm)
o = onset - onset.mean()
ac = np.correlate(o, o, mode='full')[len(o) - 1:]
lags = np.arange(len(ac))
bpm_l = 60 * fps / np.maximum(lags, 1)
ok = (bpm_l >= 70) & (bpm_l <= 180)
lag = lags[ok][np.argmax(ac[ok])]
bpm = 60 * fps / lag
period = lag

# best phase for the beat grid
scores = [onset[p::period][: int(len(onset) / period)].sum() for p in range(period)]
phase = int(np.argmax(scores))
# snap each grid beat to the nearest onset peak within +-40ms
beats = []
for i in range(phase, len(onset), period):
    lo, hi = max(0, i - int(0.04 * fps)), min(len(onset), i + int(0.04 * fps) + 1)
    j = lo + int(np.argmax(onset[lo:hi]))
    beats.append(round(j / fps, 3))

# downbeat phase: which of 4 positions has strongest kick
kstr = [sum(kick_env[int(b * fps)] for b in beats[p::4]) for p in range(4)]
dp = int(np.argmax(kstr))
downbeats = beats[dp::4]

# energy per 0.1s, normalized
step = int(0.1 * SR)
rms = np.array([np.sqrt(np.mean(y[i:i + step] ** 2)) for i in range(0, len(y), step)])
rms = np.convolve(rms, np.ones(5) / 5, mode='same')
energy = [round(float(v), 3) for v in rms / (rms.max() + 1e-9)]

out = {'duration': duration, 'bpm': round(float(bpm), 2), 'beats': beats, 'downbeats': downbeats,
       'kicks': peaks(kick_env, 1.5, 0.2), 'snares': peaks(snare_env, 1.6, 0.2), 'energy': energy}
with open(os.path.join(ROOT, 'public', name, 'beats.json'), 'w') as fh:
    json.dump(out, fh)
print(f'{duration}s  bpm={out["bpm"]}  beats={len(beats)} downbeats={len(downbeats)} kicks={len(out["kicks"])} snares={len(out["snares"])}')
# coarse energy profile per 2s for planning
print(' '.join(f'{i*2}:{np.mean(energy[i*20:(i+1)*20]):.2f}' for i in range(int(duration // 2) + 1)))
print('downbeats:', downbeats)
