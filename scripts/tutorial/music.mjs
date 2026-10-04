// Tutorial videos — soft background music, made here in code (no samples, no third-party material): an original work of the
// HangKH pipeline, dedicated to the public domain (CC0), free for commercial use. A warm pad on C–G–Am–F (4 s per chord) with a
// quiet bell arpeggio and a short echo. The encoder plays it at ~13 % volume.
//   node music.mjs <seconds> <out.wav>
import { writeFileSync } from "node:fs";

const SECONDS = Number(process.argv[2] ?? 75), OUT = process.argv[3] ?? "music.wav";
const SR = 44100, N = Math.ceil((SECONDS + 1) * SR), L = new Float32Array(N), R = new Float32Array(N);
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const CHORDS = [[48, 55, 60, 64, 67], [43, 55, 59, 62, 67], [45, 57, 60, 64, 69], [41, 53, 57, 60, 65]]; // C · G · Am · F
const BAR = 4; // seconds per chord

// pad: soft additive voices (fundamental + gentle 2nd/3rd harmonics), slow swell, slight detune for width
for (let c = 0; c * BAR < SECONDS + 1; c++) {
  const notes = CHORDS[c % CHORDS.length], t0 = c * BAR, len = BAR + 1.6; // overlap = cross-fade into the next chord
  for (const [i, m] of notes.entries()) {
    const f = hz(m), amp = i === 0 ? 0.16 : 0.07, det = 1 + (i % 2 ? 0.0025 : -0.0025);
    for (let s = Math.floor(t0 * SR); s < Math.min(N, (t0 + len) * SR); s++) {
      const t = s / SR - t0, env = Math.min(1, t / 1.4) * Math.min(1, (len - t) / 1.6);
      const ph = 2 * Math.PI * f * det * t;
      const v = amp * env * (Math.sin(ph) + 0.18 * Math.sin(2 * ph) + 0.06 * Math.sin(3 * ph));
      L[s] += v * (i % 2 ? 0.8 : 1); R[s] += v * (i % 2 ? 1 : 0.8);
    }
  }
}
// bells: chord tones going up, one every half second, quick attack and a long soft decay, panned left / right
for (let k = 0; k * 0.5 < SECONDS; k++) {
  const notes = CHORDS[Math.floor((k * 0.5) / BAR) % CHORDS.length], m = notes[[2, 3, 4, 3][k % 4]] + 12, f = hz(m);
  const t0 = k * 0.5 + 0.02, pan = k % 2 ? 0.35 : 0.65;
  for (let s = Math.floor(t0 * SR); s < Math.min(N, (t0 + 2.2) * SR); s++) {
    const t = s / SR - t0, env = Math.min(1, t / 0.008) * Math.exp(-t / 0.55);
    const v = 0.045 * env * (Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t) * Math.exp(-t / 0.2));
    L[s] += v * (1 - pan); R[s] += v * pan;
  }
}
// gentle low-pass (one pole, ~2.5 kHz) + echo (0.31 s, 30 %), then normalise to −3 dBFS
const a = Math.exp(-2 * Math.PI * 2500 / SR), D = Math.floor(0.31 * SR);
for (const ch of [L, R]) {
  let y = 0;
  for (let s = 0; s < N; s++) { y = (1 - a) * ch[s] + a * y; ch[s] = y; }
  for (let s = D; s < N; s++) ch[s] += 0.3 * ch[s - D];
}
let peak = 0;
for (let s = 0; s < N; s++) peak = Math.max(peak, Math.abs(L[s]), Math.abs(R[s]));
const gain = 0.708 / (peak || 1);
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(N * 4, 40);
for (let s = 0; s < N; s++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[s] * gain)) * 32767), 44 + s * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[s] * gain)) * 32767), 46 + s * 4);
}
writeFileSync(OUT, buf);
console.log(`music: ${SECONDS}s → ${OUT}`);
