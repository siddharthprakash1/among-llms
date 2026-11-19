import { afterEach, describe, expect, it, vi } from "vitest";

type Sound = typeof import("./sound");
// sound.ts keeps its AudioContext and preference in module state, so each test loads a fresh copy.
const fresh = async (): Promise<Sound> => {
  vi.resetModules();
  return await import("./sound");
};

type Listener = () => void;

function fakeBrowser(stored: string | null, activated = true) {
  const listeners = new Map<string, Listener>();
  const contexts: { state: string; resume: ReturnType<typeof vi.fn> }[] = [];
  class FakeAudioContext {
    state = "suspended";
    currentTime = 0;
    sampleRate = 8000;
    destination = {};
    resume = vi.fn(async () => {
      this.state = "running";
    });
    constructor() {
      contexts.push(this);
    }
    createGain() {
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      return { type: "", frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} };
    }
    createBuffer(_c: number, frames: number) {
      return { getChannelData: () => new Float32Array(frames) };
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() {}, stop() {} };
    }
    createBiquadFilter() {
      return { type: "", frequency: { value: 0 }, connect() {} };
    }
  }
  const win = {
    navigator: { userActivation: { hasBeenActive: activated } },
    localStorage: { getItem: () => stored, setItem: vi.fn() },
    AudioContext: FakeAudioContext,
    addEventListener: vi.fn((type: string, fn: Listener) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    }),
  };
  vi.stubGlobal("window", win);
  return { win, listeners, contexts };
}

afterEach(() => vi.unstubAllGlobals());

describe("sound", () => {
  it("is inert during SSR", async () => {
    const s = await fresh();
    expect(s.loadSoundPref()).toBe(false);
    expect(s.soundEnabled()).toBe(false);
    expect(() => s.setSoundEnabled(true)).not.toThrow();
    expect(() => s.playCue("night")).not.toThrow();
  });

  it("waits for a gesture before creating audio when 'on' comes from storage", async () => {
    const { listeners, contexts } = fakeBrowser("on");
    const s = await fresh();
    expect(s.loadSoundPref()).toBe(true);
    s.playCue("night");
    expect(contexts).toHaveLength(0);
    expect([...listeners.keys()].sort()).toEqual(["keydown", "pointerdown", "pointerup", "touchend", "touchstart"]);

    listeners.get("pointerdown")!();
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);

    s.playCue("night");
    expect(contexts).toHaveLength(1);
  });

  it("arms the gesture listeners once however often the preference is read", async () => {
    const { win } = fakeBrowser("on");
    const s = await fresh();
    s.loadSoundPref();
    s.loadSoundPref();
    expect(win.addEventListener).toHaveBeenCalledTimes(5);
  });

  it("keeps waiting through input that is not yet a user gesture", async () => {
    const { win, listeners, contexts } = fakeBrowser("on", false);
    const s = await fresh();
    s.loadSoundPref();
    listeners.get("touchstart")!();
    expect(contexts).toHaveLength(0);
    expect(listeners.size).toBe(5);
    win.navigator.userActivation.hasBeenActive = true;
    listeners.get("touchend")!();
    expect(contexts).toHaveLength(1);
  });

  it("arms nothing when sound is off, and a gesture after turning it off creates nothing", async () => {
    const off = fakeBrowser("off");
    let s = await fresh();
    expect(s.loadSoundPref()).toBe(false);
    expect(off.listeners.size).toBe(0);

    const on = fakeBrowser("on");
    s = await fresh();
    s.loadSoundPref();
    s.setSoundEnabled(false);
    on.listeners.get("keydown")!();
    expect(on.contexts).toHaveLength(0);
    expect(on.listeners.size).toBe(0);
  });

  it("creates the context straight away when the toggle turns sound on", async () => {
    const { contexts } = fakeBrowser("off");
    const s = await fresh();
    s.loadSoundPref();
    s.setSoundEnabled(true);
    expect(contexts).toHaveLength(1);
    s.playCue("seer");
    expect(contexts).toHaveLength(1);
  });
});
