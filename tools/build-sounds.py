#!/usr/bin/env python3
"""Builds sounds/*.mp3.

Recorded sounds come from Kenney's public-domain (CC0) packs: Interface Sounds and
UI Audio, plus the 3D Platformer, FPS, Racing and City Builder starter kits.
Sounds Kenney doesn't have (whistle, siren, sonar, jingles, breathing, smoke, flare,
shield shimmer) are synthesised here. Everything is levelled, given a short fade, and
exported as small mono MP3s, which every iPhone and Android phone can play.

Usage: python3 tools/build-sounds.py <kenney source dir> <output dir>
"""
import os
import subprocess
import sys
import tempfile

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 44100
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/src/sfx')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'sounds')
os.makedirs(OUT, exist_ok=True)
TMP = tempfile.mkdtemp()
rng = np.random.default_rng(7)

UI = os.path.join(SRC, 'kenney-interface-sounds/addons/kenney_interface_sounds')
KITS = {
    'coin': 'Starter-Kit-3D-Platformer/sounds/coin.ogg',
    'break': 'Starter-Kit-3D-Platformer/sounds/break.ogg',
    'steps': 'Starter-Kit-3D-Platformer/sounds/walking.ogg',
    'impact': 'Starter-Kit-Racing/audio/impact.ogg',
    'destroy': 'Starter-Kit-FPS/sounds/enemy_destroy.ogg',
    'blaster': 'Starter-Kit-FPS/sounds/blaster.ogg',
    'place': 'Starter-Kit-City-Builder/sounds/placement-a.ogg',
    'match': 'Starter-Kit-Match-3/sounds/tile-match.ogg',
}


# ---------------------------------------------------------------- helpers

def load(path):
    """Decode any audio file to mono float32 at SR via ffmpeg."""
    tmp = os.path.join(TMP, 'in.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-ac', '1', '-ar', str(SR), tmp], check=True)
    sr, x = wavfile.read(tmp)
    x = x.astype(np.float32)
    if x.dtype != np.float32 or np.abs(x).max() > 2:
        x = x / 32768.0
    return x


def ui(name):
    return load(os.path.join(UI, name))


def kit(key):
    return load(os.path.join(SRC, KITS[key]))


def t(d):
    return np.arange(int(SR * d)) / SR


def env(n, a=0.005, r=0.1, curve=4.0):
    """Attack/exponential-release envelope over n samples."""
    e = np.ones(n, dtype=np.float32)
    na = max(1, int(a * SR))
    e[:na] = np.linspace(0, 1, na)
    tt = np.arange(n - na) / SR
    e[na:] = np.exp(-curve * tt / max(r, 1e-3))
    return e


def tone(f, d, shape='sine', a=0.005, r=None, harm=(1.0,), vib=0.0, vibf=6.0):
    tt = t(d)
    ph = 2 * np.pi * np.cumsum(np.full_like(tt, f) * (1 + vib * np.sin(2 * np.pi * vibf * tt))) / SR
    x = np.zeros_like(tt)
    for i, h in enumerate(harm):
        if shape == 'sine':
            x += h * np.sin((i + 1) * ph)
        elif shape == 'tri':
            x += h * signal.sawtooth((i + 1) * ph, 0.5)
    return (x * env(len(tt), a, r if r is not None else d)).astype(np.float32)


def sweep(f0, f1, d, a=0.005, r=None, harm=(1.0,)):
    tt = t(d)
    f = f0 * (f1 / f0) ** (tt / d)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = sum(h * np.sin((i + 1) * ph) for i, h in enumerate(harm))
    return (x * env(len(tt), a, r if r is not None else d)).astype(np.float32)


def noise(d, lo=None, hi=None, order=4):
    x = rng.standard_normal(int(SR * d)).astype(np.float32)
    if lo and hi:
        b, a_ = signal.butter(order, [lo, hi], btype='band', fs=SR)
    elif hi:
        b, a_ = signal.butter(order, hi, btype='low', fs=SR)
    elif lo:
        b, a_ = signal.butter(order, lo, btype='high', fs=SR)
    else:
        return x
    return signal.lfilter(b, a_, x).astype(np.float32)


def reverb(x, size=0.9, decay=1.2, mix=0.25):
    ir_len = int(SR * decay)
    ir = rng.standard_normal(ir_len).astype(np.float32) * np.exp(-6.0 * np.arange(ir_len) / ir_len)
    b, a_ = signal.butter(2, 6000 * size, btype='low', fs=SR)
    ir = signal.lfilter(b, a_, ir)
    wet = signal.fftconvolve(x, ir)
    wet /= max(1e-6, np.abs(wet).max())
    out = np.zeros(len(wet), dtype=np.float32)
    out[: len(x)] += x
    out += mix * wet * np.abs(x).max()
    return out


def at(*parts):
    """Mix (offset_seconds, clip, gain) parts into one buffer."""
    end = max(int(o * SR) + len(c) for o, c, *_ in parts)
    out = np.zeros(end, dtype=np.float32)
    for p in parts:
        o, c = p[0], p[1]
        g = p[2] if len(p) > 2 else 1.0
        i = int(o * SR)
        out[i:i + len(c)] += g * c
    return out


def cat(*clips, gap=0.0):
    g = np.zeros(int(gap * SR), dtype=np.float32)
    out = []
    for c in clips:
        out += [c, g]
    return np.concatenate(out[:-1]) if out else np.zeros(1, np.float32)


def trim(x, thresh=0.004):
    idx = np.where(np.abs(x) > thresh)[0]
    if len(idx) == 0:
        return x
    return x[max(0, idx[0] - 50): idx[-1] + 400]


LEVEL = {'tap': 0.5, 'tick': 0.7, 'toast': 0.8, 'joined': 0.8, 'doom': 0.85}


def finish(x, name='', peak=0.95, target_rms=0.2):
    """Trim, fade, and level by loudness (RMS of the loud part) with a soft peak limit."""
    x = trim(np.asarray(x, dtype=np.float32))
    x = x - np.mean(x)
    n = len(x)
    fi, fo = min(n // 4, int(0.003 * SR)), min(n // 4, int(0.02 * SR))
    x[:fi] *= np.linspace(0, 1, fi)
    x[n - fo:] *= np.linspace(1, 0, fo)
    # loudness of the active part (ignore the tail)
    w = int(0.05 * SR)
    frames = [np.sqrt(np.mean(x[i:i + w] ** 2)) for i in range(0, max(1, n - w), w)] or [np.sqrt(np.mean(x ** 2))]
    rms = np.percentile(frames, 90) if len(frames) > 1 else frames[0]
    if rms > 0:
        x = x * (target_rms * LEVEL.get(name, 1.0) / rms)
    # soft-limit peaks
    x = np.tanh(x / peak) * peak
    return x.astype(np.float32)


SOUNDS = {}


def sound(name, desc):
    def deco(fn):
        SOUNDS[name] = (fn, desc)
        return fn
    return deco


# ---------------------------------------------------------------- the sounds

@sound('tap', 'Button tap')
def _():
    return ui('select_001.wav') * 0.6


@sound('toast', 'General notice')
def _():
    return ui('drop_002.wav')


@sound('warn', 'Something needs your attention')
def _():
    return cat(ui('question_002.wav'), ui('question_002.wav'), gap=0.05)


@sound('error', 'Not allowed / not close enough')
def _():
    return ui('error_003.wav')


@sound('confirm', 'Done')
def _():
    return ui('confirmation_002.wav')


@sound('tick', 'Countdown tick')
def _():
    return tone(1320, 0.09, a=0.002, r=0.05, harm=(1, 0.3, 0.1))


@sound('tock', 'Countdown final tick')
def _():
    return tone(1760, 0.16, a=0.002, r=0.1, harm=(1, 0.4, 0.2))


def whistle(d, pitch=2900):
    tt = t(d)
    trill = 1 + 0.035 * np.sign(np.sin(2 * np.pi * 28 * tt))   # pea rattle
    ph = 2 * np.pi * np.cumsum(pitch * trill) / SR
    x = np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.35 * noise(d, 2000, 6000)
    e = np.minimum(1, tt / 0.02) * np.minimum(1, (d - tt) / 0.06)
    return reverb((x * e).astype(np.float32), decay=0.6, mix=0.18)


@sound('go', 'Referee whistle: the hunt starts')
def _():
    return cat(whistle(0.18), whistle(0.6), gap=0.08)


@sound('whistle_end', 'Long whistle: game over')
def _():
    return cat(whistle(0.25, 2800), whistle(0.25, 2800), whistle(0.9, 2800), gap=0.09)


def chord_note(f, d, g=1.0):
    return g * tone(f, d, a=0.004, r=d * 0.9, harm=(1, 0.5, 0.25, 0.12))


@sound('win', 'Your team won')
def _():
    notes = [523.25, 659.25, 783.99, 1046.5]
    parts = [(i * 0.12, chord_note(f, 0.5)) for i, f in enumerate(notes)]
    parts.append((0.48, chord_note(783.99, 1.2, 0.6)))
    parts.append((0.48, chord_note(1046.5, 1.2, 0.8)))
    parts.append((0.48, chord_note(1318.5, 1.2, 0.5)))
    return reverb(at(*parts), decay=1.4, mix=0.3)


@sound('lose', 'Your team lost')
def _():
    notes = [392.0, 369.99, 349.23, 293.66]
    parts = [(i * 0.28, chord_note(f, 0.5 if i < 3 else 1.3)) for i, f in enumerate(notes)]
    return reverb(at(*parts), decay=1.4, mix=0.3)


@sound('caught_me', 'You were caught')
def _():
    return at((0, kit('impact')), (0.05, sweep(300, 70, 0.7, harm=(1, 0.4)), 0.7))


@sound('caught_other', 'A hider was caught')
def _():
    return at((0, ui('confirmation_004.wav')), (0.02, kit('impact'), 0.35))


@sound('turned', 'You joined the hunters')
def _():
    return cat(ui('maximize_004.wav'), ui('confirmation_003.wav'), gap=0.02)


def ping(f, d=1.4):
    x = tone(f, d, a=0.002, r=0.35, harm=(1, 0.08)) + 0.4 * tone(f * 2.01, d, a=0.002, r=0.15)
    return reverb(x, decay=1.6, mix=0.5)


@sound('reveal', 'Seekers sent a reveal (sonar sweep)')
def _():
    sw = sweep(400, 1600, 0.35, a=0.01, r=0.5) * 0.5
    return at((0, sw), (0.32, ping(1046)), (0.62, ping(1046) * 0.45))


@sound('revealed', 'You were revealed')
def _():
    return at((0, ping(880, 1.0)), (0.18, ping(660, 1.0)), (0.36, ping(440, 1.2)))


@sound('reveal_ready', 'Reveal is ready again')
def _():
    return cat(tone(988, 0.12, r=0.1, harm=(1, 0.3)), tone(1319, 0.25, r=0.2, harm=(1, 0.3)), gap=0.0)


def siren(d, lo=650, hi=1250, rate=2.6):
    tt = t(d)
    f = lo + (hi - lo) * (0.5 + 0.5 * signal.sawtooth(2 * np.pi * rate * tt, 0.5))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = signal.square(ph) * 0.35 + np.sin(ph) * 0.6
    b, a_ = signal.butter(3, 3500, btype='low', fs=SR)
    x = signal.lfilter(b, a_, x)
    e = np.minimum(1, tt / 0.03) * np.minimum(1, (d - tt) / 0.08)
    return (x * e).astype(np.float32)


@sound('freeze_warn', 'Freeze incoming: find cover')
def _():
    return siren(1.6)


@sound('frozen', 'You are frozen: hold still')
def _():
    crack = ui('glass_004.wav')
    shimmer = sum(tone(f, 1.6, a=0.01, r=0.9) * 0.18 for f in (2093, 2637, 3136, 3951))
    whoomp = sweep(180, 60, 0.5, harm=(1, 0.5)) * 0.8
    return reverb(at((0, whoomp), (0.02, crack), (0.05, shimmer)), decay=1.5, mix=0.35)


@sound('released', 'Free again: ice shatters')
def _():
    return at((0, kit('break')), (0.03, ui('glass_001.wav'), 0.6), (0.15, ui('confirmation_001.wav'), 0.7))


@sound('freeze_cast', 'Seekers used freeze')
def _():
    swoosh = noise(0.6, 800, 7000) * env(int(0.6 * SR), a=0.25, r=0.35)
    return reverb(at((0, swoosh, 0.5), (0.25, ui('glass_004.wav'))), decay=1.2, mix=0.3)


@sound('freeze_ready', 'Freeze is ready again')
def _():
    return cat(ui('glass_002.wav'), ui('glass_005.wav'), gap=0.04)


@sound('hold_broken', 'You moved while frozen')
def _():
    return cat(ui('error_003.wav'), ui('error_003.wav'), gap=0.05)


@sound('footprints', 'You are leaving footprints')
def _():
    return kit('steps') * 1.0


def huff(d=0.45, f0=900):
    x = noise(d, 300, 2400) * env(int(d * SR), a=0.06, r=d * 0.6)
    return x.astype(np.float32)


@sound('breath', 'Out of breath: stop running')
def _():
    return at((0, huff()), (0.55, huff() * 0.8), (1.1, huff() * 0.9), (1.65, huff(0.6) * 0.7))


@sound('stamina_back', 'Stamina recovered')
def _():
    return ui('pluck_002.wav')


@sound('doom', 'Elimination countdown beep')
def _():
    return tone(1100, 0.12, shape='tri', a=0.002, r=0.08, harm=(1, 0.2))


@sound('eliminated', 'You were eliminated')
def _():
    return at((0, kit('destroy')), (0.1, sweep(500, 90, 0.8, harm=(1, 0.3)), 0.6))


@sound('burn', 'This spot is burning: move')
def _():
    d = 1.4
    crackle = np.zeros(int(d * SR), dtype=np.float32)
    for _ in range(90):
        i = rng.integers(0, len(crackle) - 400)
        crackle[i:i + 300] += rng.standard_normal(300).astype(np.float32) * np.exp(-np.arange(300) / 40) * rng.uniform(0.3, 1)
    roar = noise(d, 80, 900) * 0.5
    e = np.minimum(1, t(d) / 0.2) * np.minimum(1, (d - t(d)) / 0.3)
    return (crackle * 0.8 + roar) * e


@sound('out_of_area', 'You left the play area')
def _():
    return cat(tone(740, 0.14, shape='tri', harm=(1, 0.3)), tone(554, 0.28, shape='tri', harm=(1, 0.3)), gap=0.04)


@sound('mission_new', 'New missions on the map')
def _():
    return at((0, ui('open_002.wav')), (0.12, ui('confirmation_001.wav'), 0.8))


@sound('mission_held', 'A mission is being held')
def _():
    return cat(ui('question_003.wav'), ui('question_003.wav'), gap=0.12)


@sound('mission_done', 'Mission complete: power-ups earned')
def _():
    return at((0, ui('confirmation_004.wav')), (0.18, kit('coin')), (0.32, kit('coin'), 0.8))


@sound('mission_fail', 'Mission failed')
def _():
    return at((0, sweep(440, 220, 0.9, harm=(1, 0.5, 0.25)), 0.7), (0, ui('error_003.wav')))


@sound('pickup', 'Picked up a power-up')
def _():
    return at((0, kit('coin')), (0.08, tone(2093, 0.25, r=0.2), 0.3))


@sound('use', 'Used a power-up')
def _():
    return ui('maximize_004.wav')


@sound('ghost', 'Ghost: no footprints')
def _():
    x = sweep(900, 300, 1.0, a=0.15, r=0.8, harm=(1, 0.3)) * (1 + 0.3 * np.sin(2 * np.pi * 7 * t(1.0)))
    return reverb(x.astype(np.float32), decay=1.6, mix=0.5)


@sound('ward', 'Ward up: shield shimmer')
def _():
    shimmer = sum(tone(f, 1.0, a=0.05, r=0.7, vib=0.004, vibf=9) * g for f, g in ((523, 0.5), (784, 0.4), (1047, 0.35), (1568, 0.25), (2093, 0.15)))
    return reverb(at((0, ui('maximize_002.wav'), 0.7), (0.05, shimmer)), decay=1.2, mix=0.35)


@sound('ward_block', 'A ward blocked a freeze')
def _():
    return at((0, ui('glass_001.wav')), (0.05, tone(1568, 0.6, r=0.4, harm=(1, 0.4)), 0.5))


@sound('lookout', 'Lookout: hunters on your map')
def _():
    return cat(ui('open_002.wav'), ui('maximize_003.wav'), gap=0.0)


@sound('decoy', 'Decoy trail laid')
def _():
    return cat(kit('place'), kit('place') * 0.8, kit('place') * 0.6, gap=0.12)


@sound('smoke', 'Smoke bomb')
def _():
    d = 1.6
    pop = noise(0.08, 100, 4000) * env(int(0.08 * SR), a=0.001, r=0.05) * 2
    hiss = noise(d, 300, 6000) * env(int(d * SR), a=0.05, r=1.1)
    return reverb(at((0, pop), (0.02, hiss, 0.8)), decay=1.0, mix=0.3)


@sound('silence', 'Silence: stay completely still')
def _():
    d = 1.2
    shh = noise(d, 2500, 9000) * env(int(d * SR), a=0.3, r=0.6)
    return reverb(shh, decay=1.0, mix=0.3)


@sound('silence_end', 'Silence ended')
def _():
    return ui('close_002.wav')


@sound('jamming', 'Jamming armed')
def _():
    g = [ui(f'glitch_00{i}.wav') for i in (1, 2, 3, 4)]
    static = noise(0.5, 500, 5000) * env(int(0.5 * SR), a=0.01, r=0.4) * 0.35
    seq = cat(*(g[i % 4] for i in range(9)), gap=0.035)
    return at((0, seq), (0, static))


@sound('jam_block', 'Jamming blocked a reveal')
def _():
    return at((0, ui('glitch_002.wav')), (0.06, ui('glitch_004.wav')), (0.12, ping(660, 0.6), 0.4))


@sound('misdirection', 'Misdirection armed')
def _():
    return cat(ui('switch_002.wav'), sweep(500, 1400, 0.3, r=0.3) * 0.5, gap=0.0)


@sound('flare', 'Flare fired')
def _():
    rise = noise(0.9, 1000, 8000) * env(int(0.9 * SR), a=0.7, r=0.2) * 0.6 + sweep(500, 2500, 0.9, a=0.6, r=0.3) * 0.4
    boom = noise(0.9, 40, 600) * env(int(0.9 * SR), a=0.003, r=0.6) * 1.6
    return reverb(at((0, rise), (0.85, boom), (0.85, kit('blaster'), 0.4)), decay=1.8, mix=0.35)


@sound('flare_reveal', 'Flare: everyone is visible')
def _():
    return at((0, ping(1318, 1.2)), (0.1, ping(1661, 1.2), 0.7), (0.2, ping(1976, 1.2), 0.5))


@sound('scan', 'Scan sweep')
def _():
    return at((0, sweep(300, 900, 0.5, r=0.5, harm=(1, 0.3)), 0.6), (0.45, ping(1568, 1.2)))


@sound('boost', 'Reveal or freeze boost')
def _():
    return cat(ui('maximize_001.wav'), ui('maximize_004.wav'), gap=0.0)


@sound('joined', 'Someone joined the game')
def _():
    return ui('drop_004.wav')


@sound('ready', 'Countdown: get ready')
def _():
    return ui('switch_003.wav')


# ---------------------------------------------------------------- build

def main():
    rows = []
    for name, (fn, desc) in SOUNDS.items():
        x = finish(fn(), name)
        wav = os.path.join(TMP, name + '.wav')
        wavfile.write(wav, SR, (x * 32767).astype(np.int16))
        mp3 = os.path.join(OUT, name + '.mp3')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-ac', '1', '-ar', '44100', '-codec:a', 'libmp3lame', '-b:a', '80k', mp3], check=True)
        rows.append((name, len(x) / SR, os.path.getsize(mp3), desc))
    total = sum(r[2] for r in rows)
    for r in rows:
        print(f'{r[0]:14s} {r[1]:5.2f}s {r[2] / 1024:5.1f} KB  {r[3]}')
    print(f'{len(rows)} sounds, {total / 1024:.0f} KB total')


if __name__ == '__main__':
    main()
