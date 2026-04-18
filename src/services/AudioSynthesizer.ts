/**
 * AudioSynthesizer — Web Audio API MIDI-to-audio renderer
 *
 * Converts a MIDIComposition (produced by MelodyGenerator) into a rendered
 * stereo AudioBuffer using the Web Audio API.  Each MIDI instrument is
 * assigned its own oscillator bank; genre-specific effect chains are applied
 * before the master bus.
 *
 * Architecture
 * ─────────────
 *  ┌─────────────┐    ┌──────────────┐    ┌──────────────────────────────────┐
 *  │ InstrumentBus│──▶│ EffectChain  │──▶│ MasterBus                         │
 *  │  (per track) │    │  Reverb       │    │  DynamicsCompressor              │
 *  └─────────────┘    │  Distortion   │    │  BiquadFilter (EQ)               │
 *                     │  Chorus       │    │  DynamicsCompressor (limiter)    │
 *                     └──────────────┘    └──────────────────────────────────┘
 *
 * Output: 16-bit PCM WAV blob  OR  live AudioBuffer for waveform inspection.
 *
 * Notes on offline rendering
 * ──────────────────────────
 * All synthesis uses OfflineAudioContext so it runs as fast as possible
 * without blocking the UI or requiring real-time playback.  The returned
 * Promise resolves with the fully mixed AudioBuffer which can then be
 * exported as WAV.
 */

import type { MIDIComposition, InstrumentTrack, Genre } from "./MelodyGenerator";

// ── Public types ─────────────────────────────────────────────────────────────

export type WaveformType = "sine" | "square" | "sawtooth" | "triangle";

export interface InstrumentConfig {
  waveform: WaveformType;
  /** Gain applied per-note (0–1). */
  gain: number;
  /** ADSR envelope (seconds/linear). */
  attack: number;
  decay: number;
  sustain: number; // sustain level (0–1)
  release: number;
  /** Detune in cents (for richness). */
  detune: number;
  /** Number of oscillators stacked per note (unison). */
  unisonVoices: number;
  /** Spread in cents between unison voices. */
  unisonSpread: number;
}

export interface EffectChainConfig {
  reverb:     boolean;
  reverbDecay: number;       // seconds
  distortion: boolean;
  distortionAmount: number;  // 0–400
  chorus:     boolean;
  chorusDelay: number;       // seconds
  chorusDepth: number;       // seconds
  chorusRate:  number;       // Hz
  eq: {
    lowGain:  number; // dB
    midGain:  number;
    highGain: number;
  };
}

export interface MasterChainConfig {
  compressorThreshold: number; // dB
  compressorKnee:      number; // dB
  compressorRatio:     number;
  compressorAttack:    number; // seconds
  compressorRelease:   number; // seconds
  limiterThreshold:    number; // dB
  outputGain:          number; // linear
}

export interface SynthesisOptions {
  /** Target sample rate in Hz.  Default: 44100. */
  sampleRate?: number;
  /** Number of output channels.  Default: 2 (stereo). */
  channels?: number;
  /** Per-instrument config overrides (keyed by track name). */
  instruments?: Partial<Record<InstrumentTrack["name"], Partial<InstrumentConfig>>>;
  /** Per-genre effect chain overrides. */
  effects?: Partial<EffectChainConfig>;
  /** Master bus overrides. */
  master?: Partial<MasterChainConfig>;
  /** Volume per track, keyed by track name (0–1). */
  trackVolumes?: Partial<Record<InstrumentTrack["name"], number>>;
  /** Muted tracks. */
  mutedTracks?: InstrumentTrack["name"][];
  /** Soloed tracks.  If any track is soloed, only those play. */
  soloedTracks?: InstrumentTrack["name"][];
}

export interface RenderResult {
  audioBuffer: AudioBuffer;
  durationSec: number;
  sampleRate: number;
  channels: number;
}

// ── Genre-default instrument configs ─────────────────────────────────────────

const GENRE_INSTRUMENT_CONFIGS: Record<
  Genre,
  Record<InstrumentTrack["name"], InstrumentConfig>
> = {
  "lo-fi": {
    melody:     { waveform: "triangle", gain: 0.4, attack: 0.02, decay: 0.15, sustain: 0.5, release: 0.3, detune: 8, unisonVoices: 1, unisonSpread: 0 },
    bass:       { waveform: "sine",     gain: 0.55, attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2, detune: 0, unisonVoices: 1, unisonSpread: 0 },
    chords:     { waveform: "triangle", gain: 0.3, attack: 0.08, decay: 0.2,  sustain: 0.6, release: 0.5, detune: 5, unisonVoices: 2, unisonSpread: 10 },
    percussion: { waveform: "square",   gain: 0.5, attack: 0.001,decay: 0.05, sustain: 0.0, release: 0.1, detune: 0, unisonVoices: 1, unisonSpread: 0 },
  },
  cinematic: {
    melody:     { waveform: "sawtooth", gain: 0.35, attack: 0.1, decay: 0.3, sustain: 0.7, release: 0.8, detune: 10, unisonVoices: 3, unisonSpread: 15 },
    bass:       { waveform: "sawtooth", gain: 0.6,  attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.5, detune: 5,  unisonVoices: 2, unisonSpread: 8 },
    chords:     { waveform: "sawtooth", gain: 0.3,  attack: 0.2,  decay: 0.5, sustain: 0.6, release: 1.0, detune: 8,  unisonVoices: 4, unisonSpread: 20 },
    percussion: { waveform: "square",   gain: 0.6,  attack: 0.001,decay: 0.08,sustain: 0.0, release: 0.15,detune: 0,  unisonVoices: 1, unisonSpread: 0 },
  },
  pop: {
    melody:     { waveform: "square",   gain: 0.38, attack: 0.02, decay: 0.1, sustain: 0.6, release: 0.2, detune: 5,  unisonVoices: 2, unisonSpread: 12 },
    bass:       { waveform: "sawtooth", gain: 0.6,  attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.2, detune: 0,  unisonVoices: 1, unisonSpread: 0 },
    chords:     { waveform: "square",   gain: 0.3,  attack: 0.05, decay: 0.15,sustain: 0.5, release: 0.3, detune: 5,  unisonVoices: 3, unisonSpread: 15 },
    percussion: { waveform: "square",   gain: 0.7,  attack: 0.001,decay: 0.05,sustain: 0.0, release: 0.08,detune: 0,  unisonVoices: 1, unisonSpread: 0 },
  },
  ambient: {
    melody:     { waveform: "sine",     gain: 0.25, attack: 0.5,  decay: 0.8, sustain: 0.8, release: 2.0, detune: 3,  unisonVoices: 3, unisonSpread: 8 },
    bass:       { waveform: "sine",     gain: 0.3,  attack: 0.4,  decay: 0.5, sustain: 0.9, release: 2.0, detune: 2,  unisonVoices: 1, unisonSpread: 0 },
    chords:     { waveform: "sine",     gain: 0.2,  attack: 1.0,  decay: 1.0, sustain: 0.9, release: 3.0, detune: 4,  unisonVoices: 4, unisonSpread: 10 },
    percussion: { waveform: "sine",     gain: 0.2,  attack: 0.05, decay: 0.4, sustain: 0.1, release: 1.0, detune: 0,  unisonVoices: 1, unisonSpread: 0 },
  },
  electronic: {
    melody:     { waveform: "sawtooth", gain: 0.4,  attack: 0.01, decay: 0.08,sustain: 0.5, release: 0.15,detune: 8,  unisonVoices: 4, unisonSpread: 18 },
    bass:       { waveform: "square",   gain: 0.65, attack: 0.005,decay: 0.05,sustain: 0.9, release: 0.1, detune: 0,  unisonVoices: 2, unisonSpread: 5 },
    chords:     { waveform: "sawtooth", gain: 0.3,  attack: 0.02, decay: 0.1, sustain: 0.6, release: 0.3, detune: 6,  unisonVoices: 3, unisonSpread: 12 },
    percussion: { waveform: "square",   gain: 0.8,  attack: 0.001,decay: 0.04,sustain: 0.0, release: 0.06,detune: 0,  unisonVoices: 1, unisonSpread: 0 },
  },
  classical: {
    melody:     { waveform: "sawtooth", gain: 0.32, attack: 0.08, decay: 0.2, sustain: 0.6, release: 0.5, detune: 12, unisonVoices: 3, unisonSpread: 20 },
    bass:       { waveform: "sawtooth", gain: 0.5,  attack: 0.06, decay: 0.15,sustain: 0.7, release: 0.4, detune: 8,  unisonVoices: 2, unisonSpread: 10 },
    chords:     { waveform: "sawtooth", gain: 0.28, attack: 0.12, decay: 0.3, sustain: 0.6, release: 0.8, detune: 10, unisonVoices: 4, unisonSpread: 22 },
    percussion: { waveform: "triangle", gain: 0.45, attack: 0.001,decay: 0.12,sustain: 0.0, release: 0.3, detune: 0,  unisonVoices: 1, unisonSpread: 0 },
  },
};

// ── Genre-default effect chains ───────────────────────────────────────────────

const GENRE_EFFECTS: Record<Genre, EffectChainConfig> = {
  "lo-fi":     { reverb: true,  reverbDecay: 1.5,  distortion: false, distortionAmount: 0,   chorus: false, chorusDelay: 0.025, chorusDepth: 0.003, chorusRate: 1.2, eq: { lowGain: 2,  midGain: -1, highGain: -4 } },
  cinematic:   { reverb: true,  reverbDecay: 3.5,  distortion: false, distortionAmount: 0,   chorus: false, chorusDelay: 0.02,  chorusDepth: 0.002, chorusRate: 0.5, eq: { lowGain: 3,  midGain: 0,  highGain: 1 }  },
  pop:         { reverb: true,  reverbDecay: 1.2,  distortion: false, distortionAmount: 0,   chorus: true,  chorusDelay: 0.015, chorusDepth: 0.002, chorusRate: 1.5, eq: { lowGain: 1,  midGain: 2,  highGain: 2 }  },
  ambient:     { reverb: true,  reverbDecay: 6.0,  distortion: false, distortionAmount: 0,   chorus: true,  chorusDelay: 0.03,  chorusDepth: 0.005, chorusRate: 0.3, eq: { lowGain: 0,  midGain: -2, highGain: 0 }  },
  electronic:  { reverb: false, reverbDecay: 0.8,  distortion: true,  distortionAmount: 60,  chorus: false, chorusDelay: 0.02,  chorusDepth: 0.003, chorusRate: 2.0, eq: { lowGain: 4,  midGain: 0,  highGain: 2 }  },
  classical:   { reverb: true,  reverbDecay: 2.5,  distortion: false, distortionAmount: 0,   chorus: false, chorusDelay: 0.018, chorusDepth: 0.002, chorusRate: 0.8, eq: { lowGain: 2,  midGain: -1, highGain: 0 }  },
};

const DEFAULT_MASTER: MasterChainConfig = {
  compressorThreshold: -24,
  compressorKnee:       30,
  compressorRatio:       4,
  compressorAttack:    0.003,
  compressorRelease:   0.25,
  limiterThreshold:    -1,
  outputGain:          0.85,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert MIDI pitch to frequency in Hz. */
function midiToHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/**
 * Synthesise a single mono note into an AudioBuffer using an oscillator bank
 * with ADSR envelope.
 */
function renderNote(
  ctx: OfflineAudioContext,
  cfg: InstrumentConfig,
  pitch: number,
  velocity: number,
  startSec: number,
  durationSec: number,
): void {
  const freq = midiToHz(pitch);
  const velGain = (velocity / 127) * cfg.gain;
  const voices = Math.max(1, cfg.unisonVoices);

  for (let v = 0; v < voices; v++) {
    const osc = ctx.createOscillator();
    osc.type = cfg.waveform;

    // Spread unison voices symmetrically
    const spread = voices > 1
      ? ((v / (voices - 1)) - 0.5) * cfg.unisonSpread
      : 0;
    osc.frequency.value = freq;
    osc.detune.value = cfg.detune + spread;

    // ADSR gain envelope
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(0, startSec);
    gainNode.gain.linearRampToValueAtTime(
      velGain / voices,
      startSec + cfg.attack,
    );
    gainNode.gain.linearRampToValueAtTime(
      (velGain / voices) * cfg.sustain,
      startSec + cfg.attack + cfg.decay,
    );
    gainNode.gain.setValueAtTime(
      (velGain / voices) * cfg.sustain,
      startSec + durationSec - cfg.release,
    );
    gainNode.gain.linearRampToValueAtTime(
      0,
      startSec + durationSec + cfg.release,
    );

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.start(startSec);
    osc.stop(startSec + durationSec + cfg.release + 0.01);
  }
}

/**
 * Build an impulse-response buffer for a simple exponential-decay reverb.
 * This creates a stereo reverb tail that sounds natural at any decay time.
 */
function buildReverbIR(
  ctx: OfflineAudioContext | AudioContext,
  decaySec: number,
  sampleRate: number,
): AudioBuffer {
  const length = Math.ceil(sampleRate * decaySec);
  const ir = ctx.createBuffer(2, length, sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      data[i] = (Math.random() * 2 - 1) * Math.exp(-6 * t / decaySec);
    }
  }
  return ir;
}

/**
 * Create a WaveShaperNode distortion curve of the requested amount.
 */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 256;
  const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
  const k = amount;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = k === 0
      ? x
      : (3 + k) * x * 20 * (Math.PI / 180) /
        (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// ── WAV encoding ──────────────────────────────────────────────────────────────

/**
 * Encode an AudioBuffer to a WAV Blob (PCM 16-bit little-endian).
 */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate  = buffer.sampleRate;
  const numSamples  = buffer.length;
  const bytesPerSample = 2;
  const blockAlign  = numChannels * bytesPerSample;
  const byteRate    = sampleRate * blockAlign;
  const dataSize    = numSamples * blockAlign;
  const headerSize  = 44;

  const ab = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(ab);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  const writeUint16LE = (offset: number, v: number) => view.setUint16(offset, v, true);
  const writeUint32LE = (offset: number, v: number) => view.setUint32(offset, v, true);

  writeStr(0, "RIFF");
  writeUint32LE(4, 36 + dataSize);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  writeUint32LE(16, 16);             // PCM chunk size
  writeUint16LE(20, 1);              // PCM format
  writeUint16LE(22, numChannels);
  writeUint32LE(24, sampleRate);
  writeUint32LE(28, byteRate);
  writeUint16LE(32, blockAlign);
  writeUint16LE(34, 16);             // bits per sample
  writeStr(36, "data");
  writeUint32LE(40, dataSize);

  let offset = headerSize;
  const interleaved = new Float32Array(numSamples * numChannels);
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      interleaved[i * numChannels + c] = buffer.getChannelData(c)[i];
    }
  }
  for (let i = 0; i < interleaved.length; i++) {
    const sample = Math.max(-1, Math.min(1, interleaved[i]));
    view.setInt16(offset, Math.round(sample * 32767), true);
    offset += 2;
  }

  return new Blob([ab], { type: "audio/wav" });
}

// ── Main class ────────────────────────────────────────────────────────────────

export class AudioSynthesizer {
  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Render the entire MIDIComposition to an AudioBuffer using OfflineAudioContext.
   * This is the main entry point — call this and await the result.
   */
  async render(
    composition: MIDIComposition,
    opts: SynthesisOptions = {},
  ): Promise<RenderResult> {
    const sampleRate = opts.sampleRate ?? 44100;
    const channels   = opts.channels  ?? 2;
    const beatsPerSec = composition.bpm / 60;
    const durationSec = composition.totalBeats / beatsPerSec + 2; // +2 for release tail

    const effectsCfg = { ...GENRE_EFFECTS[composition.genre], ...opts.effects };
    const masterCfg  = { ...DEFAULT_MASTER, ...opts.master };

    // Determine which tracks to actually render
    const activeTracks = this.resolveActiveTracks(composition.tracks, opts);

    // One OfflineAudioContext per instrument track (rendered in parallel)
    const trackBuffers = await Promise.all(
      activeTracks.map(track =>
        this.renderTrack(
          track,
          composition,
          sampleRate,
          channels,
          durationSec,
          beatsPerSec,
          opts,
        ),
      ),
    );

    // Mix all track buffers into a single offline context with effects + master
    const mixCtx = new OfflineAudioContext(channels, Math.ceil(durationSec * sampleRate), sampleRate);
    const masterGain  = mixCtx.createGain();
    masterGain.gain.value = masterCfg.outputGain;

    const compressor = mixCtx.createDynamicsCompressor();
    compressor.threshold.value = masterCfg.compressorThreshold;
    compressor.knee.value      = masterCfg.compressorKnee;
    compressor.ratio.value     = masterCfg.compressorRatio;
    compressor.attack.value    = masterCfg.compressorAttack;
    compressor.release.value   = masterCfg.compressorRelease;

    const limiter = mixCtx.createDynamicsCompressor();
    limiter.threshold.value = masterCfg.limiterThreshold;
    limiter.knee.value      = 0;
    limiter.ratio.value     = 20;
    limiter.attack.value    = 0.001;
    limiter.release.value   = 0.1;

    // 3-band EQ (low shelf, peak mid, high shelf)
    const eqLow  = mixCtx.createBiquadFilter();
    eqLow.type   = "lowshelf";
    eqLow.frequency.value = 250;
    eqLow.gain.value      = effectsCfg.eq.lowGain;

    const eqMid  = mixCtx.createBiquadFilter();
    eqMid.type   = "peaking";
    eqMid.frequency.value = 1000;
    eqMid.Q.value         = 1;
    eqMid.gain.value      = effectsCfg.eq.midGain;

    const eqHigh = mixCtx.createBiquadFilter();
    eqHigh.type  = "highshelf";
    eqHigh.frequency.value = 5000;
    eqHigh.gain.value      = effectsCfg.eq.highGain;

    // Reverb (convolution)
    let reverbNode: ConvolverNode | null = null;
    let reverbSend: GainNode | null = null;
    if (effectsCfg.reverb) {
      reverbNode = mixCtx.createConvolver();
      reverbNode.buffer = buildReverbIR(mixCtx, effectsCfg.reverbDecay, sampleRate);
      reverbSend = mixCtx.createGain();
      reverbSend.gain.value = 0.3;
      reverbNode.connect(eqLow);
    }

    // Distortion (wave shaper)
    let distNode: WaveShaperNode | null = null;
    if (effectsCfg.distortion && effectsCfg.distortionAmount > 0) {
      distNode = mixCtx.createWaveShaper();
      distNode.curve = makeDistortionCurve(effectsCfg.distortionAmount);
      distNode.oversample = "4x";
    }

    // Chorus (3 delay lines with LFO-modulated times simulated by slight detune)
    // Web Audio API doesn't have a native chorus; we use a pair of slightly
    // delayed and pitch-shifted nodes as an approximation.
    let chorusOut: GainNode | null = null;
    if (effectsCfg.chorus) {
      chorusOut = mixCtx.createGain();
      chorusOut.gain.value = 0.25;
      for (let i = 0; i < 3; i++) {
        const delayNode = mixCtx.createDelay(0.1);
        const time = effectsCfg.chorusDelay + i * effectsCfg.chorusDepth;
        delayNode.delayTime.value = time;
        chorusOut.connect(delayNode);
        delayNode.connect(eqLow);
      }
    }

    // Connect: trackSource → fx chain → EQ → compressor → limiter → master
    for (let i = 0; i < trackBuffers.length; i++) {
      const src = mixCtx.createBufferSource();
      src.buffer = trackBuffers[i];

      const trackGain = mixCtx.createGain();
      const trackName = activeTracks[i].name;
      trackGain.gain.value = opts.trackVolumes?.[trackName] ?? activeTracks[i].defaultVolume;

      src.connect(trackGain);

      if (distNode) {
        trackGain.connect(distNode);
        distNode.connect(eqLow);
      } else {
        trackGain.connect(eqLow);
      }

      if (reverbSend) {
        trackGain.connect(reverbSend);
        reverbSend.connect(reverbNode!);
      }

      if (chorusOut) {
        trackGain.connect(chorusOut);
      }

      src.start(0);
    }

    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(masterGain);
    masterGain.connect(mixCtx.destination);

    const mixedBuffer = await mixCtx.startRendering();

    return {
      audioBuffer: mixedBuffer,
      durationSec: mixedBuffer.duration,
      sampleRate:  mixedBuffer.sampleRate,
      channels:    mixedBuffer.numberOfChannels,
    };
  }

  /**
   * Export a RenderResult as a WAV Blob.
   */
  exportWav(result: RenderResult): Blob {
    return audioBufferToWav(result.audioBuffer);
  }

  /**
   * Create an object URL for the WAV so the browser can download / play it.
   */
  exportWavUrl(result: RenderResult): string {
    return URL.createObjectURL(this.exportWav(result));
  }

  /**
   * Extract a mono float32 array from the first channel — useful for
   * waveform drawing.
   */
  getWaveformData(result: RenderResult, downsampleTo = 2048): Float32Array {
    const src = result.audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(src.length / downsampleTo));
    const out = new Float32Array(downsampleTo);
    for (let i = 0; i < downsampleTo; i++) {
      out[i] = src[Math.min(i * step, src.length - 1)];
    }
    return out;
  }

  /**
   * Extract per-track waveform data for individual track displays.
   */
  async getTrackWaveformData(
    composition: MIDIComposition,
    trackName: InstrumentTrack["name"],
    downsampleTo = 1024,
    sampleRate = 44100,
  ): Promise<Float32Array> {
    const track = composition.tracks.find(t => t.name === trackName);
    if (!track) return new Float32Array(downsampleTo);

    const beatsPerSec = composition.bpm / 60;
    const durationSec = composition.totalBeats / beatsPerSec + 1;

    const buf = await this.renderTrack(
      track, composition, sampleRate, 1, durationSec, beatsPerSec, {},
    );
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / downsampleTo));
    const out = new Float32Array(downsampleTo);
    for (let i = 0; i < downsampleTo; i++) {
      out[i] = data[Math.min(i * step, data.length - 1)];
    }
    return out;
  }

  // ── Internal rendering ─────────────────────────────────────────────────────

  private async renderTrack(
    track: InstrumentTrack,
    composition: MIDIComposition,
    sampleRate: number,
    channels: number,
    durationSec: number,
    beatsPerSec: number,
    opts: SynthesisOptions,
  ): Promise<AudioBuffer> {
    const genre = composition.genre;
    const defaultCfg = GENRE_INSTRUMENT_CONFIGS[genre][track.name];
    const overrideCfg = opts.instruments?.[track.name] ?? {};
    const cfg: InstrumentConfig = { ...defaultCfg, ...overrideCfg };

    const length = Math.ceil(durationSec * sampleRate);
    const trackCtx = new OfflineAudioContext(channels, length, sampleRate);

    for (const note of track.notes) {
      const startSec    = note.startBeat / beatsPerSec;
      const durationSec = note.durationBeats / beatsPerSec;

      if (startSec >= trackCtx.length / sampleRate) continue;

      renderNote(trackCtx, cfg, note.pitch, note.velocity, startSec, durationSec);
    }

    return trackCtx.startRendering();
  }

  private resolveActiveTracks(
    tracks: InstrumentTrack[],
    opts: SynthesisOptions,
  ): InstrumentTrack[] {
    const { mutedTracks = [], soloedTracks = [] } = opts;
    if (soloedTracks.length > 0) {
      return tracks.filter(t => soloedTracks.includes(t.name));
    }
    return tracks.filter(t => !mutedTracks.includes(t.name));
  }
}

// ── Convenience singleton export ─────────────────────────────────────────────

export const audioSynthesizer = new AudioSynthesizer();
