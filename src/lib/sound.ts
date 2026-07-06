// Synthesized, event-driven sound design. No audio files — every cue is
// generated with the Web Audio API (oscillators + noise + envelopes), so the
// repo stays lean and it works offline. Off by default; the choice persists in
// localStorage. The AudioContext is created lazily on first enable (which comes
// from a user gesture, satisfying autoplay policies).

export type SoundCue =
  | "night"
  | "day"
  | "kill"
  | "save"
  | "seer"
  | "accuse"
  | "vote"
  | "gavel"
  | "win_village"
  | "win_wolves"
  | "win_jester";

const STORAGE_KEY = "among-llms:sound";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = false;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function soundEnabled(): boolean {
  if (!isBrowser()) return false;
  return enabled;
}

export function loadSoundPref(): boolean {
  if (!isBrowser()) return false;
  enabled = window.localStorage.getItem(STORAGE_KEY) === "on";
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  if (!isBrowser()) return;
  enabled = on;
  window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  if (on) ensureContext();
}

function ensureContext(): AudioContext | null {
  if (!isBrowser()) return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType,
  peak = 0.5,
  glideTo?: number
): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function noise(start: number, dur: number, peak = 0.4, hp = 400): void {
  if (!ctx || !master) return;
  const frames = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let seed = 1337;
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = ((seed / 0x7fffffff) * 2 - 1) * (1 - i / frames);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = hp;
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(start);
  src.stop(start + dur + 0.02);
}

export function playCue(cue: SoundCue): void {
  if (!enabled) return;
  const c = ensureContext();
  if (!c) return;
  const t = c.currentTime;
  switch (cue) {
    case "night":
      tone(220, t, 1.4, "sine", 0.25, 165);
      tone(110, t, 1.6, "sine", 0.18);
      break;
    case "day":
      tone(330, t, 1.0, "sine", 0.22, 494);
      break;
    case "kill":
      noise(t, 0.5, 0.5, 250);
      tone(90, t, 0.6, "sawtooth", 0.4, 40);
      break;
    case "save":
      tone(440, t, 0.9, "sine", 0.3, 880);
      break;
    case "seer":
      tone(880, t, 0.5, "triangle", 0.3);
      tone(1320, t + 0.06, 0.5, "triangle", 0.22);
      break;
    case "accuse":
      tone(300, t, 0.18, "square", 0.22);
      tone(260, t + 0.16, 0.24, "square", 0.22);
      break;
    case "vote":
      tone(520, t, 0.09, "square", 0.16);
      break;
    case "gavel":
      noise(t, 0.14, 0.5, 180);
      tone(140, t, 0.2, "square", 0.35);
      break;
    case "win_village":
      [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.16, 1.1, "triangle", 0.32));
      break;
    case "win_wolves":
      tone(300, t, 1.6, "sawtooth", 0.4, 70);
      noise(t + 0.1, 0.9, 0.3, 200);
      break;
    case "win_jester":
      [660, 560, 720, 500, 780].forEach((f, i) => tone(f, t + i * 0.11, 0.28, "triangle", 0.3));
      break;
  }
}
