/**
 * AudioSynthesizer — Web Audio API renderer for `Composition` data
 *
 * Takes the structured `Composition` produced by `MelodyGenerator` and
 * either renders it offline to a `Float32Array` (for waveform display and
 * WAV export) or schedules it for live playback through an `AudioContext`.
 *
 * Synthesis pipeline (per voice):
 *
 *      [Oscillator(s) / Wavetable / Noise]
 *                │
 *                ▼
 *      [Per-voice gain w/ ADSR envelope]
 *                │
 *                ▼
 *      [Per-track gain (volume / mute / solo)]
 *                │
 *                ▼
 *      [Per-track effect chain: reverb, distortion, chorus]
 *                │
 *                ▼
 *      [Master bus: 3-band EQ → compressor → soft-clip limiter → out]
 *
 * The class is fully usable in Node.js (offline rendering only) provided
 * a polyfilled `OfflineAudioContext` is available; in the browser it uses
 * `AudioContext` for live playback and `OfflineAudioContext` for exports.
 *
 * No external libraries are used.
 */

import type {
  Composition,
  Genre,
  InstrumentTrack,
  NoteEvent,
  Timbre,
} from "./MelodyGenerator";
import { midiToFrequency } from "./MelodyGenerator";

// ── Public types ───────────────────────────────────────────────────────────

/** Per-track mixer settings supplied by the UI. */
export interface TrackMix {
  /** Linear volume 0–1.5 (1 = unity). */
  volume: number;
  /** True to silence this track. */
  muted: boolean;
  /** True to solo this track (any soloed track mutes the others). */
  solo: boolean;
  /** Stereo pan -1 (left) … +1 (right). */
  pan: number;
}

/** Master mix settings. */
export interface MasterMix {
  /** Master volume 0–1.5. */
  volume: number;
  /** Compressor threshold dBFS. */
  compressorThresholdDb: number;
  /** Limiter ceiling 0–1 (peak amplitude). */
  limiterCeiling: number;
  /** Low EQ gain (dB) at ~120 Hz. */
  lowDb: number;
  /** Mid EQ gain (dB) at ~1.2 kHz. */
  midDb: number;
  /** High EQ gain (dB) at ~8 kHz. */
  highDb: number;
}

/** Audio-effect settings per genre / per track override. */
export interface EffectSettings {
  /** Reverb wet 0–1. */
  reverbWet: number;
  /** Reverb tail seconds. */
  reverbTailSec: number;
  /** Distortion drive 0–1. */
  distortionAmount: number;
  /** Chorus depth 0–1. */
  chorusDepth: number;
  /** Chorus rate Hz. */
  chorusRateHz: number;
  /** Low-pass filter cutoff Hz (use 22050 to bypass). */
  lowpassHz: number;
}

/** Options passed to `renderToBuffer` / `renderToWav`. */
export interface RenderOptions {
  /** Output sample rate. Defaults to 44100. */
  sampleRate?: number;
  /** Number of output channels (1 = mono, 2 = stereo). Defaults to 2. */
  channels?: 1 | 2;
  /** Track-level mix overrides. */
  trackMix?: Partial<Record<InstrumentTrack, Partial<TrackMix>>>;
  /** Master mix overrides. */
  masterMix?: Partial<MasterMix>;
  /** Per-track effect overrides. */
  effectOverrides?: Partial<Record<InstrumentTrack, Partial<EffectSettings>>>;
  /** Tail in seconds added after the last note (for reverb decay). */
  tailSec?: number;
  /** Progress callback in [0, 1]. */
  onProgress?: (progress: number) => void;
}

/** A rendered audio buffer. */
export interface RenderedAudio {
  /** Sample rate of the audio. */
  sampleRate: number;
  /** Channel count. */
  channels: 1 | 2;
  /** Per-channel float32 samples in [-1, 1]. */
  data: Float32Array[];
  /** Total duration in seconds. */
  durationSec: number;
  /** Peak amplitude across all channels. */
  peak: number;
  /** RMS amplitude across all channels. */
  rms: number;
}

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_TRACK_MIX: Record<InstrumentTrack, TrackMix> = {
  melody:     { volume: 0.85, muted: false, solo: false, pan:  0.10 },
  bass:       { volume: 0.95, muted: false, solo: false, pan:  0.0  },
  chords:     { volume: 0.65, muted: false, solo: false, pan: -0.20 },
  percussion: { volume: 0.85, muted: false, solo: false, pan:  0.0  },
};

export const DEFAULT_MASTER_MIX: MasterMix = {
  volume: 0.95,
  compressorThresholdDb: -16,
  limiterCeiling: 0.985,
  lowDb: 0,
  midDb: 0,
  highDb: 0,
};

const GENRE_EFFECTS: Record<Genre, Record<InstrumentTrack, EffectSettings>> = {
  lofi: {
    melody:     { reverbWet: 0.30, reverbTailSec: 1.4, distortionAmount: 0.05, chorusDepth: 0.10, chorusRateHz: 0.6, lowpassHz: 4500 },
    bass:       { reverbWet: 0.10, reverbTailSec: 1.0, distortionAmount: 0.10, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 1800 },
    chords:     { reverbWet: 0.45, reverbTailSec: 1.8, distortionAmount: 0.00, chorusDepth: 0.20, chorusRateHz: 0.4, lowpassHz: 5000 },
    percussion: { reverbWet: 0.20, reverbTailSec: 0.8, distortionAmount: 0.00, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 9000 },
  },
  cinematic: {
    melody:     { reverbWet: 0.55, reverbTailSec: 3.0, distortionAmount: 0.02, chorusDepth: 0.25, chorusRateHz: 0.3, lowpassHz: 12000 },
    bass:       { reverbWet: 0.20, reverbTailSec: 1.4, distortionAmount: 0.08, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 4000 },
    chords:     { reverbWet: 0.65, reverbTailSec: 4.0, distortionAmount: 0.00, chorusDepth: 0.30, chorusRateHz: 0.2, lowpassHz: 9000 },
    percussion: { reverbWet: 0.40, reverbTailSec: 1.6, distortionAmount: 0.00, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 14000 },
  },
  pop: {
    melody:     { reverbWet: 0.20, reverbTailSec: 1.2, distortionAmount: 0.10, chorusDepth: 0.40, chorusRateHz: 1.2, lowpassHz: 15000 },
    bass:       { reverbWet: 0.05, reverbTailSec: 0.6, distortionAmount: 0.15, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 4500 },
    chords:     { reverbWet: 0.25, reverbTailSec: 1.4, distortionAmount: 0.00, chorusDepth: 0.45, chorusRateHz: 0.9, lowpassHz: 12000 },
    percussion: { reverbWet: 0.10, reverbTailSec: 0.5, distortionAmount: 0.00, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 18000 },
  },
  ambient: {
    melody:     { reverbWet: 0.75, reverbTailSec: 5.0, distortionAmount: 0.00, chorusDepth: 0.30, chorusRateHz: 0.2, lowpassHz: 8000 },
    bass:       { reverbWet: 0.40, reverbTailSec: 2.5, distortionAmount: 0.00, chorusDepth: 0.10, chorusRateHz: 0.1, lowpassHz: 3000 },
    chords:     { reverbWet: 0.85, reverbTailSec: 6.0, distortionAmount: 0.00, chorusDepth: 0.45, chorusRateHz: 0.15, lowpassHz: 7500 },
    percussion: { reverbWet: 0.55, reverbTailSec: 2.0, distortionAmount: 0.00, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 9000 },
  },
  electronic: {
    melody:     { reverbWet: 0.20, reverbTailSec: 0.9, distortionAmount: 0.18, chorusDepth: 0.20, chorusRateHz: 1.5, lowpassHz: 17000 },
    bass:       { reverbWet: 0.05, reverbTailSec: 0.4, distortionAmount: 0.30, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 5500 },
    chords:     { reverbWet: 0.30, reverbTailSec: 1.2, distortionAmount: 0.10, chorusDepth: 0.30, chorusRateHz: 1.0, lowpassHz: 13000 },
    percussion: { reverbWet: 0.10, reverbTailSec: 0.5, distortionAmount: 0.05, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 19000 },
  },
  classical: {
    melody:     { reverbWet: 0.55, reverbTailSec: 2.4, distortionAmount: 0.00, chorusDepth: 0.10, chorusRateHz: 0.3, lowpassHz: 13000 },
    bass:       { reverbWet: 0.30, reverbTailSec: 1.6, distortionAmount: 0.00, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 4500 },
    chords:     { reverbWet: 0.65, reverbTailSec: 3.0, distortionAmount: 0.00, chorusDepth: 0.10, chorusRateHz: 0.2, lowpassHz: 11000 },
    percussion: { reverbWet: 0.30, reverbTailSec: 1.2, distortionAmount: 0.00, chorusDepth: 0.00, chorusRateHz: 0.0, lowpassHz: 12000 },
  },
};

const ENV_DEFAULTS: Record<InstrumentTrack, { attack: number; decay: number; sustain: number; release: number }> = {
  melody:     { attack: 0.01, decay: 0.05, sustain: 0.75, release: 0.18 },
  bass:       { attack: 0.005, decay: 0.04, sustain: 0.85, release: 0.10 },
  chords:     { attack: 0.04, decay: 0.10, sustain: 0.80, release: 0.40 },
  percussion: { attack: 0.001, decay: 0.06, sustain: 0.0,  release: 0.05 },
};

// ── Wavetable helpers ─────────────────────────────────────────────────────

/**
 * Generates a `PeriodicWave` for the requested timbre. Wavetables are
 * cached per timbre per AudioContext.
 *
 * "wavetable" gives a richer additive blend (organ-like).
 * "pulse" gives a square with adjustable duty (~25%).
 */
function buildPeriodicWave(
  ctx: BaseAudioContext,
  timbre: Timbre,
): PeriodicWave | null {
  if (timbre === "sine" || timbre === "triangle"
      || timbre === "sawtooth" || timbre === "square"
      || timbre === "noise") {
    return null;
  }
  if (timbre === "pulse") {
    // 25 %-duty pulse via additive Fourier series.
    const n = 32;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let h = 1; h < n; h++) {
      // Pulse-wave coefficients — see FOF synthesis literature.
      imag[h] = (2 / (h * Math.PI)) * Math.sin(h * Math.PI * 0.25);
    }
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }
  // wavetable: organ-style stack (1, 1/3, 1/5 …)
  const n = 24;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let h = 1; h < n; h++) {
    const odd = h % 2 === 1;
    imag[h] = odd ? (1 / h) * 0.85 : (1 / (h * 2)) * 0.4;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Build an exponentially-decaying noise impulse-response for convolution reverb. */
function buildReverbImpulse(
  ctx: BaseAudioContext,
  durationSec: number,
  decay = 2.5,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(durationSec * sr));
  const ir = ctx.createBuffer(2, length, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Stereo decorrelated noise.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}

/** Build a soft-saturation curve for a `WaveShaperNode`. */
function buildSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const k = clamp(amount, 0, 1) * 60;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    if (curve[i] > 1) curve[i] = 1;
    if (curve[i] < -1) curve[i] = -1;
  }
  return curve;
}

// ── Drum synthesis tables ──────────────────────────────────────────────────

interface DrumVoice {
  /** Base oscillator frequency (use 0 for pure noise). */
  freqHz: number;
  /** Frequency-sweep target (Hz). 0 = no sweep. */
  sweepToHz: number;
  /** Length in seconds. */
  durationSec: number;
  /** Mix of noise vs. tone (0 = pure tone, 1 = pure noise). */
  noiseMix: number;
  /** Highpass cutoff Hz applied to the noise component. */
  noiseHighpassHz: number;
  /** Optional bandpass for snare-like timbres. */
  bandpassCenterHz: number;
}

/**
 * Map general-MIDI drum slot → synthesis parameters. Unknown slots fall
 * back to closed hat (a high noise burst).
 */
const DRUM_VOICES: Record<number, DrumVoice> = {
  35: { freqHz: 60,  sweepToHz: 35, durationSec: 0.40, noiseMix: 0.05, noiseHighpassHz: 100, bandpassCenterHz: 0 },     // kick
  38: { freqHz: 200, sweepToHz: 100, durationSec: 0.20, noiseMix: 0.7,  noiseHighpassHz: 1200, bandpassCenterHz: 1800 }, // snare
  39: { freqHz: 0,   sweepToHz: 0,   durationSec: 0.18, noiseMix: 1.0,  noiseHighpassHz: 1500, bandpassCenterHz: 1200 }, // clap
  41: { freqHz: 110, sweepToHz: 70,  durationSec: 0.35, noiseMix: 0.2,  noiseHighpassHz: 200,  bandpassCenterHz: 0 },    // low tom
  42: { freqHz: 0,   sweepToHz: 0,   durationSec: 0.10, noiseMix: 1.0,  noiseHighpassHz: 7000, bandpassCenterHz: 0 },    // closed hat
  46: { freqHz: 0,   sweepToHz: 0,   durationSec: 0.30, noiseMix: 1.0,  noiseHighpassHz: 6000, bandpassCenterHz: 0 },    // open hat
  50: { freqHz: 220, sweepToHz: 160, durationSec: 0.30, noiseMix: 0.2,  noiseHighpassHz: 200,  bandpassCenterHz: 0 },    // high tom
  51: { freqHz: 0,   sweepToHz: 0,   durationSec: 0.45, noiseMix: 1.0,  noiseHighpassHz: 4000, bandpassCenterHz: 5500 }, // ride
};

function getDrumVoice(pitch: number): DrumVoice {
  return DRUM_VOICES[pitch] ?? DRUM_VOICES[42];
}

// ── Synthesizer ────────────────────────────────────────────────────────────

interface OfflineCtor {
  new (
    options: { numberOfChannels: number; length: number; sampleRate: number },
  ): OfflineAudioContext;
  new (
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): OfflineAudioContext;
}

/**
 * Main renderer.
 *
 * Typical usage:
 * ```ts
 * const synth = new AudioSynthesizer();
 * const audio = await synth.renderToBuffer(composition, { sampleRate: 44100 });
 * const wav = synth.encodeWav(audio);
 * const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
 * ```
 */
export class AudioSynthesizer {
  private periodicCache = new WeakMap<BaseAudioContext, Map<Timbre, PeriodicWave | null>>();
  private impulseCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

  /** Live audio context for playback (lazily created on first play). */
  private liveContext: AudioContext | null = null;
  /** Active live source group, kept so we can stop playback. */
  private liveStop: (() => void) | null = null;

  /**
   * Render a composition to PCM data using `OfflineAudioContext`.
   * Works in both browser and Node (with `node-web-audio-api` polyfill).
   */
  async renderToBuffer(
    composition: Composition,
    options: RenderOptions = {},
  ): Promise<RenderedAudio> {
    const sampleRate = options.sampleRate ?? 44100;
    const channels = options.channels ?? 2;
    const tail = options.tailSec ?? 2.5;
    const totalSec = Math.max(0.5, composition.durationSec + tail);

    const Offline = this.getOfflineCtor();
    if (!Offline) {
      throw new Error("OfflineAudioContext is not available in this environment");
    }
    const ctx = this.constructOfflineContext(
      Offline,
      channels,
      Math.ceil(totalSec * sampleRate),
      sampleRate,
    );

    this.scheduleComposition(ctx, composition, options);

    options.onProgress?.(0);
    const rendered = await ctx.startRendering();
    options.onProgress?.(1);

    return this.audioBufferToRendered(rendered, channels);
  }

  /** Render a composition to a ready-to-download WAV `Uint8Array`. */
  async renderToWav(
    composition: Composition,
    options: RenderOptions = {},
  ): Promise<Uint8Array> {
    const audio = await this.renderToBuffer(composition, options);
    return this.encodeWav(audio);
  }

  /**
   * Live playback (browser only). Returns a stop function.
   * Calling `play` while another playback is active stops the previous one.
   */
  play(composition: Composition, options: RenderOptions = {}): () => void {
    if (typeof window === "undefined") {
      throw new Error("AudioSynthesizer.play requires a browser environment");
    }
    this.stop();
    if (!this.liveContext) {
      const w = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) {
        throw new Error("No AudioContext implementation in this browser");
      }
      this.liveContext = new Ctor();
    }
    const ctx = this.liveContext;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {
        /* user-gesture autoplay policies may delay this; ignore */
      });
    }
    const startedAt = ctx.currentTime + 0.05;
    const cleanup = this.scheduleComposition(ctx, composition, options, startedAt);
    this.liveStop = () => {
      cleanup();
      this.liveStop = null;
    };
    return this.liveStop;
  }

  /** Stop any active live playback. */
  stop(): void {
    if (this.liveStop) {
      try { this.liveStop(); } catch {
        /* ignore: already stopped */
      }
    }
    this.liveStop = null;
  }

  /** Encode a `RenderedAudio` to a 16-bit PCM WAV byte array. */
  encodeWav(audio: RenderedAudio): Uint8Array {
    const { sampleRate, channels, data } = audio;
    const numSamples = data[0]?.length ?? 0;
    const bytesPerSample = 2;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;
    const headerSize = 44;
    const out = new Uint8Array(headerSize + dataSize);
    const view = new DataView(out.buffer);

    let p = 0;
    function writeStr(s: string): void {
      for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
    }
    function writeU32(v: number): void { view.setUint32(p, v, true); p += 4; }
    function writeU16(v: number): void { view.setUint16(p, v, true); p += 2; }

    writeStr("RIFF");
    writeU32(36 + dataSize);
    writeStr("WAVE");
    writeStr("fmt ");
    writeU32(16);
    writeU16(1); // PCM
    writeU16(channels);
    writeU32(sampleRate);
    writeU32(byteRate);
    writeU16(blockAlign);
    writeU16(bytesPerSample * 8);
    writeStr("data");
    writeU32(dataSize);

    // Interleave channels
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const sample = data[ch][i];
        const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
        const int = Math.round(clamped * 0x7FFF);
        view.setInt16(p, int, true);
        p += 2;
      }
    }

    return out;
  }

  /**
   * Compute waveform peak data suitable for visualisation. Returns one
   * peak value per `bucketCount` bucket, in [0, 1].
   */
  computePeaks(audio: RenderedAudio, bucketCount: number): Float32Array {
    const peaks = new Float32Array(bucketCount);
    if (audio.data.length === 0) return peaks;
    const samples = audio.data[0];
    const samples2 = audio.data[1] ?? samples;
    const total = samples.length;
    const bucketSize = Math.max(1, Math.floor(total / bucketCount));
    for (let b = 0; b < bucketCount; b++) {
      const start = b * bucketSize;
      const end = Math.min(total, start + bucketSize);
      let max = 0;
      for (let i = start; i < end; i++) {
        const a = Math.abs((samples[i] + samples2[i]) * 0.5);
        if (a > max) max = a;
      }
      peaks[b] = max;
    }
    return peaks;
  }

  // ── Internal: scheduling ─────────────────────────────────────────────────

  /**
   * Schedule every event in a composition on the supplied audio context.
   * Returns a cleanup function that stops still-playing nodes (used by
   * `play` to support manual stops).
   */
  private scheduleComposition(
    ctx: BaseAudioContext,
    composition: Composition,
    options: RenderOptions,
    startTime?: number,
  ): () => void {
    const t0 = startTime ?? 0;
    const trackMix = this.resolveTrackMix(options.trackMix);
    const masterMix = { ...DEFAULT_MASTER_MIX, ...options.masterMix };
    const effectMap = this.resolveEffects(composition.genre, options.effectOverrides);
    const anySolo = Object.values(trackMix).some((m) => m.solo);

    const master = this.buildMasterChain(ctx, masterMix);
    const trackInputs = this.buildTrackChains(ctx, master.input, trackMix, effectMap, anySolo);

    const nodes: AudioScheduledSourceNode[] = [];
    const totalEvents = composition.events.length || 1;
    let progressIdx = 0;

    for (const event of composition.events) {
      const absStart = t0 + event.startSec;
      const channel = trackInputs[event.track];
      if (!channel) continue;
      if (event.track === "percussion") {
        this.scheduleDrum(ctx, event, absStart, channel, nodes);
      } else {
        this.schedulePitchedNote(ctx, event, absStart, channel, nodes);
      }
      progressIdx++;
      if (progressIdx % 64 === 0) {
        options.onProgress?.((progressIdx / totalEvents) * 0.5);
      }
    }

    return () => {
      for (const n of nodes) {
        try { n.stop(); } catch {
          /* node already finished or never started */
        }
      }
    };
  }

  private schedulePitchedNote(
    ctx: BaseAudioContext,
    event: NoteEvent,
    when: number,
    destination: AudioNode,
    nodes: AudioScheduledSourceNode[],
  ): void {
    const env = ENV_DEFAULTS[event.track];
    const dur = Math.max(0.04, event.durationSec);
    const release = env.release;
    const peak = clamp(event.velocity, 0, 1) * 0.9;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + env.attack);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, peak * env.sustain),
      when + env.attack + env.decay,
    );
    gain.gain.setValueAtTime(
      Math.max(0.0001, peak * env.sustain),
      when + dur,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur + release);

    const freq = midiToFrequency(event.pitch);
    const osc1 = this.makeOscillator(ctx, event.timbre, freq);
    const osc2 = (event.track === "chords" || event.track === "bass")
      ? this.makeOscillator(ctx, event.timbre, freq * (event.track === "bass" ? 1.005 : 1.003))
      : null;

    osc1.connect(gain);
    if (osc2) {
      const detuneGain = ctx.createGain();
      detuneGain.gain.value = 0.6;
      osc2.connect(detuneGain);
      detuneGain.connect(gain);
    }
    gain.connect(destination);

    osc1.start(when);
    osc1.stop(when + dur + release + 0.05);
    nodes.push(osc1);
    if (osc2) {
      osc2.start(when);
      osc2.stop(when + dur + release + 0.05);
      nodes.push(osc2);
    }
  }

  private scheduleDrum(
    ctx: BaseAudioContext,
    event: NoteEvent,
    when: number,
    destination: AudioNode,
    nodes: AudioScheduledSourceNode[],
  ): void {
    const voice = getDrumVoice(event.pitch);
    const dur = Math.max(0.04, voice.durationSec);
    const peak = clamp(event.velocity, 0, 1) * 0.9;

    // Output gain (envelope: super-fast attack, exponential decay).
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    gain.connect(destination);

    // Tonal component (pitch sweep).
    if (voice.freqHz > 0 && voice.noiseMix < 1.0) {
      const tone = ctx.createOscillator();
      tone.type = "sine";
      tone.frequency.setValueAtTime(voice.freqHz, when);
      if (voice.sweepToHz > 0) {
        tone.frequency.exponentialRampToValueAtTime(
          Math.max(20, voice.sweepToHz),
          when + dur,
        );
      }
      const toneGain = ctx.createGain();
      toneGain.gain.value = 1 - voice.noiseMix;
      tone.connect(toneGain);
      toneGain.connect(gain);
      tone.start(when);
      tone.stop(when + dur + 0.02);
      nodes.push(tone);
    }

    // Noise component.
    if (voice.noiseMix > 0) {
      const noise = this.makeNoiseSource(ctx, dur + 0.05);
      let last: AudioNode = noise;
      if (voice.noiseHighpassHz > 0) {
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = voice.noiseHighpassHz;
        last.connect(hp);
        last = hp;
      }
      if (voice.bandpassCenterHz > 0) {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = voice.bandpassCenterHz;
        bp.Q.value = 1.4;
        last.connect(bp);
        last = bp;
      }
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = voice.noiseMix;
      last.connect(noiseGain);
      noiseGain.connect(gain);
      noise.start(when);
      noise.stop(when + dur + 0.05);
      nodes.push(noise);
    }
  }

  // ── Internal: chain construction ─────────────────────────────────────────

  private buildMasterChain(
    ctx: BaseAudioContext,
    mix: MasterMix,
  ): { input: AudioNode } {
    const input = ctx.createGain();
    input.gain.value = 1.0;

    // 3-band shelving EQ
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = "lowshelf";
    lowShelf.frequency.value = 120;
    lowShelf.gain.value = mix.lowDb;

    const midPeak = ctx.createBiquadFilter();
    midPeak.type = "peaking";
    midPeak.frequency.value = 1200;
    midPeak.Q.value = 0.8;
    midPeak.gain.value = mix.midDb;

    const highShelf = ctx.createBiquadFilter();
    highShelf.type = "highshelf";
    highShelf.frequency.value = 8000;
    highShelf.gain.value = mix.highDb;

    // Compressor
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = mix.compressorThresholdDb;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.18;

    // Brick-wall-ish soft limiter (waveshaper + makeup)
    const limiter = ctx.createWaveShaper();
    limiter.curve = buildLimiterCurve(mix.limiterCeiling);
    limiter.oversample = "4x";

    const masterGain = ctx.createGain();
    masterGain.gain.value = mix.volume;

    input.connect(lowShelf);
    lowShelf.connect(midPeak);
    midPeak.connect(highShelf);
    highShelf.connect(comp);
    comp.connect(limiter);
    limiter.connect(masterGain);
    masterGain.connect(ctx.destination);

    return { input };
  }

  private buildTrackChains(
    ctx: BaseAudioContext,
    masterIn: AudioNode,
    mix: Record<InstrumentTrack, TrackMix>,
    effects: Record<InstrumentTrack, EffectSettings>,
    anySolo: boolean,
  ): Record<InstrumentTrack, AudioNode> {
    const inputs = {} as Record<InstrumentTrack, AudioNode>;
    const tracks: InstrumentTrack[] = ["melody", "bass", "chords", "percussion"];
    for (const track of tracks) {
      const m = mix[track];
      const fx = effects[track];
      const audible = anySolo ? m.solo : !m.muted;

      // Per-track input gain
      const input = ctx.createGain();
      input.gain.value = audible ? m.volume : 0;

      // Low-pass tone filter (per-track).
      const tone = ctx.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = fx.lowpassHz;
      tone.Q.value = 0.7;

      // Optional distortion / saturation
      const distortion = ctx.createWaveShaper();
      distortion.curve = buildSaturationCurve(fx.distortionAmount);
      distortion.oversample = fx.distortionAmount > 0.05 ? "2x" : "none";

      // Chorus (single-tap modulated delay) — implemented as 1 LFO + delay.
      const chorus = this.buildChorusNode(ctx, fx.chorusDepth, fx.chorusRateHz);

      // Reverb (convolution if available)
      const reverb = this.buildReverbNode(ctx, fx.reverbTailSec);
      const reverbWet = ctx.createGain();
      reverbWet.gain.value = fx.reverbWet;
      const dryGain = ctx.createGain();
      dryGain.gain.value = 1 - fx.reverbWet * 0.5;

      // Stereo panner (fallback: simple gain split).
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(m.pan, -1, 1);

      // Connect: input → tone → distortion → chorus → split (dry / wet)
      input.connect(tone);
      tone.connect(distortion);
      distortion.connect(chorus.input);
      chorus.output.connect(dryGain);
      chorus.output.connect(reverb);
      reverb.connect(reverbWet);
      const trackBus = ctx.createGain();
      dryGain.connect(trackBus);
      reverbWet.connect(trackBus);
      trackBus.connect(panner);
      panner.connect(masterIn);

      inputs[track] = input;
    }
    return inputs;
  }

  private buildChorusNode(
    ctx: BaseAudioContext,
    depth: number,
    rateHz: number,
  ): { input: AudioNode; output: AudioNode } {
    const input = ctx.createGain();
    const output = ctx.createGain();
    input.connect(output); // dry pass-through

    if (depth <= 0 || rateHz <= 0) {
      return { input, output };
    }

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = 0.018;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = rateHz;

    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.006 * clamp(depth, 0, 1);

    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    const wet = ctx.createGain();
    wet.gain.value = 0.45 * clamp(depth, 0, 1);

    input.connect(delay);
    delay.connect(wet);
    wet.connect(output);

    return { input, output };
  }

  private buildReverbNode(
    ctx: BaseAudioContext,
    tailSec: number,
  ): AudioNode {
    const conv = ctx.createConvolver();
    conv.normalize = true;
    const cacheKey = `tail-${tailSec.toFixed(2)}`;
    let map = this.impulseCache.get(ctx);
    if (!map) {
      map = new Map<string, AudioBuffer>();
      this.impulseCache.set(ctx, map);
    }
    let ir = map.get(cacheKey);
    if (!ir) {
      ir = buildReverbImpulse(ctx, Math.max(0.1, tailSec));
      map.set(cacheKey, ir);
    }
    conv.buffer = ir;
    return conv;
  }

  // ── Internal: oscillator / noise factories ───────────────────────────────

  private makeOscillator(
    ctx: BaseAudioContext,
    timbre: Timbre,
    freq: number,
  ): OscillatorNode {
    const osc = ctx.createOscillator();
    if (timbre === "sine" || timbre === "triangle"
        || timbre === "sawtooth" || timbre === "square") {
      osc.type = timbre;
    } else if (timbre === "noise") {
      osc.type = "sawtooth";
    } else {
      osc.type = "sine";
      let map = this.periodicCache.get(ctx);
      if (!map) {
        map = new Map();
        this.periodicCache.set(ctx, map);
      }
      let wave = map.get(timbre) ?? null;
      if (!wave) {
        wave = buildPeriodicWave(ctx, timbre);
        map.set(timbre, wave);
      }
      if (wave) {
        osc.setPeriodicWave(wave);
      }
    }
    osc.frequency.value = clamp(freq, 20, 20000);
    return osc;
  }

  private makeNoiseSource(
    ctx: BaseAudioContext,
    durationSec: number,
  ): AudioBufferSourceNode {
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    return source;
  }

  // ── Internal: helpers ────────────────────────────────────────────────────

  private resolveTrackMix(
    overrides?: Partial<Record<InstrumentTrack, Partial<TrackMix>>>,
  ): Record<InstrumentTrack, TrackMix> {
    const out = {} as Record<InstrumentTrack, TrackMix>;
    for (const t of Object.keys(DEFAULT_TRACK_MIX) as InstrumentTrack[]) {
      out[t] = { ...DEFAULT_TRACK_MIX[t], ...(overrides?.[t] ?? {}) };
    }
    return out;
  }

  private resolveEffects(
    genre: Genre,
    overrides?: Partial<Record<InstrumentTrack, Partial<EffectSettings>>>,
  ): Record<InstrumentTrack, EffectSettings> {
    const base = GENRE_EFFECTS[genre];
    const out = {} as Record<InstrumentTrack, EffectSettings>;
    for (const t of Object.keys(base) as InstrumentTrack[]) {
      out[t] = { ...base[t], ...(overrides?.[t] ?? {}) };
    }
    return out;
  }

  private getOfflineCtor(): OfflineCtor | null {
    if (typeof OfflineAudioContext !== "undefined") {
      return OfflineAudioContext as unknown as OfflineCtor;
    }
    if (typeof globalThis !== "undefined") {
      const g = globalThis as unknown as { OfflineAudioContext?: OfflineCtor };
      if (g.OfflineAudioContext) return g.OfflineAudioContext;
    }
    return null;
  }

  private constructOfflineContext(
    Ctor: OfflineCtor,
    channels: number,
    length: number,
    sampleRate: number,
  ): OfflineAudioContext {
    // Try options-object form first (modern), fall back to positional args.
    try {
      return new Ctor({ numberOfChannels: channels, length, sampleRate });
    } catch {
      return new Ctor(channels, length, sampleRate);
    }
  }

  private audioBufferToRendered(
    buffer: AudioBuffer,
    requestedChannels: 1 | 2,
  ): RenderedAudio {
    const ch = Math.min(buffer.numberOfChannels, requestedChannels) as 1 | 2;
    const data: Float32Array[] = [];
    let peak = 0;
    let sumSq = 0;
    let totalSamples = 0;
    for (let i = 0; i < ch; i++) {
      const arr = new Float32Array(buffer.length);
      buffer.copyFromChannel(arr, i);
      data.push(arr);
      for (let s = 0; s < arr.length; s++) {
        const a = Math.abs(arr[s]);
        if (a > peak) peak = a;
        sumSq += arr[s] * arr[s];
        totalSamples++;
      }
    }
    if (ch === 2 && data.length === 1) {
      // Mono → duplicate to stereo (shouldn't happen but defensive).
      data.push(new Float32Array(data[0]));
    }
    const rms = totalSamples > 0 ? Math.sqrt(sumSq / totalSamples) : 0;
    return {
      sampleRate: buffer.sampleRate,
      channels: ch,
      data,
      durationSec: buffer.duration,
      peak,
      rms,
    };
  }
}

// ── Helpers (file-private) ─────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function buildLimiterCurve(ceiling: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const out = new Float32Array(new ArrayBuffer(n * 4));
  const c = clamp(ceiling, 0.1, 1.0);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    // Smooth tanh saturator with adjustable ceiling.
    const y = Math.tanh(x * 1.5) * c;
    out[i] = clamp(y, -c, c);
  }
  return out;
}

// ── Public utility exports ─────────────────────────────────────────────────

/**
 * Convert a `RenderedAudio` to a Blob URL suitable for an `<audio>` tag.
 * The caller is responsible for revoking the URL.
 */
export function renderedAudioToObjectUrl(audio: RenderedAudio): string {
  if (typeof URL === "undefined" || typeof Blob === "undefined") {
    throw new Error("Object URLs are not available in this environment");
  }
  const synth = new AudioSynthesizer();
  const wav = synth.encodeWav(audio);
  // Copy into a fresh buffer so the Blob owns its data.
  const view = new Uint8Array(wav);
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

/** Returns the genre-specific default effect settings for `track`. */
export function defaultEffectsForGenreAndTrack(
  genre: Genre,
  track: InstrumentTrack,
): EffectSettings {
  return { ...GENRE_EFFECTS[genre][track] };
}

/** Singleton instance. */
export const audioSynthesizer = new AudioSynthesizer();
