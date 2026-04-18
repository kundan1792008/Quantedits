/**
 * MusicAnalyzer — Video-content-driven music blueprint generator
 *
 * Analyses a loaded HTMLVideoElement (or a supplied sequence of ImageData
 * frames) to extract:
 *   • Overall mood   — happy / dramatic / chill / epic / melancholic / tense
 *   • Pacing         — fast / medium / slow
 *   • Key moments    — scene changes, speech pauses, action peaks
 *
 * The output is a "MusicBlueprint": a timeline of MoodMarkers with intensity
 * curves that MelodyGenerator can consume directly.
 *
 * All heavy processing is performed off the main thread via microtask
 * scheduling so the UI stays responsive.  In production the frame-diff
 * algorithm would be replaced by a real CV model; the heuristics below
 * are intentionally self-contained so the module works without any external
 * dependency or network call.
 */

// ── Public types ────────────────────────────────────────────────────────────

export type VideoMood =
  | "happy"
  | "dramatic"
  | "chill"
  | "epic"
  | "melancholic"
  | "tense";

export type VideoPacing = "fast" | "medium" | "slow";

export interface SceneChange {
  /** Timestamp in seconds where the scene cut occurs. */
  timestampSec: number;
  /** Normalised difference score that triggered the cut (0–1). */
  diffScore: number;
}

export interface SpeechPause {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface ActionPeak {
  timestampSec: number;
  /** Motion energy at the peak (0–1). */
  energy: number;
}

export interface MoodMarker {
  timestampSec: number;
  mood: VideoMood;
  /** Normalised intensity of the mood at this point (0–1). */
  intensity: number;
}

export interface IntensityCurvePoint {
  timestampSec: number;
  /** Combined energy/intensity value used to drive orchestration (0–1). */
  value: number;
}

export interface MusicBlueprint {
  durationSec: number;
  overallMood: VideoMood;
  pacing: VideoPacing;
  /** Suggested BPM derived from pacing and scene cut frequency. */
  suggestedBpm: number;
  /** Suggested musical key (e.g. "C", "Am", "F#"). */
  suggestedKey: string;
  sceneChanges: SceneChange[];
  speechPauses: SpeechPause[];
  actionPeaks: ActionPeak[];
  moodTimeline: MoodMarker[];
  intensityCurve: IntensityCurvePoint[];
}

export interface AnalyzerOptions {
  /**
   * How many frames per second to sample for diff analysis.
   * Higher = more accurate but slower.  Default: 4.
   */
  sampleFps?: number;
  /**
   * Pixel-difference threshold (0–255) above which two consecutive frames
   * are considered a scene cut.  Default: 35.
   */
  sceneCutThreshold?: number;
  /**
   * How many samples to skip at the very start / end (seconds) to avoid
   * title cards or black frames.  Default: 0.5.
   */
  edgeGuardSec?: number;
  /**
   * Canvas resolution used for frame sampling.  Smaller = faster.
   * Default: 128 × 72 (16:9 thumbnail).
   */
  sampleWidth?: number;
  sampleHeight?: number;
}

// ── Internal constants ───────────────────────────────────────────────────────

const DEFAULT_SAMPLE_FPS = 4;
const DEFAULT_SCENE_CUT_THRESHOLD = 35;
const DEFAULT_EDGE_GUARD_SEC = 0.5;
const DEFAULT_SAMPLE_WIDTH = 128;
const DEFAULT_SAMPLE_HEIGHT = 72;

/** Maps BPM range to pacing category. */
const PACING_BPM_RANGES: Record<VideoPacing, [number, number]> = {
  slow:   [50,  85],
  medium: [86, 120],
  fast:  [121, 175],
};

/** Musical keys indexed by "brightness" score 0–11. */
const KEY_PALETTE: string[] = [
  "Am", "Dm", "Em", "Gm", "Cm", "F",
  "C",  "G",  "D",  "A",  "E", "Bm",
];

/** Mood-to-brightness mapping used for key selection. */
const MOOD_BRIGHTNESS: Record<VideoMood, number> = {
  melancholic: 0,
  tense:       1,
  dramatic:    3,
  chill:       5,
  happy:       8,
  epic:        10,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Offscreen canvas singleton (created once, reused across frames).
 * In a browser environment this uses OffscreenCanvas when available.
 */
function createOffscreenCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  return { canvas, ctx };
}

/**
 * Compute the mean absolute pixel difference between two RGBA frames.
 * Returns a value in [0, 255].
 */
function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 4) {
    sum +=
      Math.abs(a[i]     - b[i])     +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / ((len / 4) * 3);
}

/**
 * Compute the average luminance of an RGBA frame.
 * Returns a value in [0, 255].
 */
function averageLuminance(data: Uint8ClampedArray): number {
  let sum = 0;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    // ITU-R BT.601 luma
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return sum / (len / 4);
}

/**
 * Compute a motion-energy proxy: mean absolute difference of *luminance*
 * between successive frames.  Returns normalised value in [0, 1].
 */
function motionEnergy(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  const len = a.length;
  for (let i = 0; i < len; i += 4) {
    const la = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const lb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    sum += Math.abs(la - lb);
  }
  return Math.min(1, sum / ((len / 4) * 255));
}

/**
 * Compute colour saturation proxy: average chroma of an RGBA frame.
 * High saturation → happy/epic.  Low saturation → melancholic/tense.
 * Returns value in [0, 1].
 */
function averageSaturation(data: Uint8ClampedArray): number {
  let sum = 0;
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sum += max === 0 ? 0 : (max - min) / max;
  }
  return sum / (len / 4);
}

/**
 * Simple Gaussian smooth on a 1-D array to produce the final intensity
 * curve with soft transitions between energy peaks.
 */
function gaussianSmooth(values: number[], sigma: number): number[] {
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    ksum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  return values.map((_, idx) => {
    let acc = 0;
    for (let k = 0; k < kernel.length; k++) {
      const src = idx + k - radius;
      const v = src < 0 ? values[0] : src >= values.length ? values[values.length - 1] : values[src];
      acc += v * kernel[k];
    }
    return acc;
  });
}

/**
 * Seek the video to a given time and return the pixel data.
 * Returns a Promise that resolves once the seek completes.
 */
function seekAndCapture(
  video: HTMLVideoElement,
  timeSec: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      try {
        ctx.drawImage(video, 0, 0, width, height);
        resolve(ctx.getImageData(0, 0, width, height));
      } catch (err) {
        reject(err);
      }
    };
    const onError = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      reject(new Error(`Failed to seek to ${timeSec}s`));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = timeSec;
  });
}

// ── Main class ───────────────────────────────────────────────────────────────

export class MusicAnalyzer {
  private readonly opts: Required<AnalyzerOptions>;

  constructor(opts: AnalyzerOptions = {}) {
    this.opts = {
      sampleFps:          opts.sampleFps          ?? DEFAULT_SAMPLE_FPS,
      sceneCutThreshold:  opts.sceneCutThreshold  ?? DEFAULT_SCENE_CUT_THRESHOLD,
      edgeGuardSec:       opts.edgeGuardSec       ?? DEFAULT_EDGE_GUARD_SEC,
      sampleWidth:        opts.sampleWidth        ?? DEFAULT_SAMPLE_WIDTH,
      sampleHeight:       opts.sampleHeight       ?? DEFAULT_SAMPLE_HEIGHT,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Full analysis pipeline.  Seeks through the video at `sampleFps`,
   * extracts frame features, and returns a complete MusicBlueprint.
   *
   * @param video  A loaded HTMLVideoElement (readyState >= 2).
   */
  async analyze(video: HTMLVideoElement): Promise<MusicBlueprint> {
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("MusicAnalyzer: video has no valid duration");
    }

    const { sampleFps, edgeGuardSec, sampleWidth, sampleHeight } = this.opts;
    const interval = 1 / sampleFps;
    const start = edgeGuardSec;
    const end = duration - edgeGuardSec;

    const { ctx } = createOffscreenCanvas(sampleWidth, sampleHeight);

    // Collect frame data
    const timestamps: number[] = [];
    const frames: ImageData[] = [];

    for (let t = start; t <= end; t += interval) {
      const frame = await seekAndCapture(video, t, ctx, sampleWidth, sampleHeight);
      timestamps.push(t);
      frames.push(frame);
      // Yield to microtask queue every 10 frames to keep UI responsive
      if (timestamps.length % 10 === 0) {
        await new Promise<void>(r => setTimeout(r, 0));
      }
    }

    const sceneChanges  = this.detectSceneChanges(timestamps, frames);
    const actionPeaks   = this.detectActionPeaks(timestamps, frames);
    const speechPauses  = this.detectSpeechPauses(duration, sceneChanges, actionPeaks);
    const overallMood   = this.inferOverallMood(timestamps, frames, sceneChanges, actionPeaks);
    const pacing        = this.inferPacing(duration, sceneChanges, actionPeaks);
    const suggestedBpm  = this.deriveBpm(pacing, sceneChanges.length, duration);
    const suggestedKey  = this.deriveKey(overallMood);
    const moodTimeline  = this.buildMoodTimeline(timestamps, frames, sceneChanges, overallMood, duration);
    const intensityCurve = this.buildIntensityCurve(timestamps, frames, sceneChanges, actionPeaks, duration);

    return {
      durationSec: duration,
      overallMood,
      pacing,
      suggestedBpm,
      suggestedKey,
      sceneChanges,
      speechPauses,
      actionPeaks,
      moodTimeline,
      intensityCurve,
    };
  }

  /**
   * Lightweight synchronous version that derives a blueprint from metadata
   * alone (duration + filename).  Useful when no video element is available
   * (e.g. server-side or unit tests).
   */
  analyzeMetadata(durationSec: number, filename: string = ""): MusicBlueprint {
    // Derive a pseudo-random but deterministic seed from filename
    let seed = 0;
    for (let i = 0; i < filename.length; i++) seed = (seed * 31 + filename.charCodeAt(i)) >>> 0;
    const rng = this.seededRng(seed);

    const overallMood = this.pickRandom<VideoMood>(
      ["happy", "dramatic", "chill", "epic", "melancholic", "tense"], rng,
    );
    const pacing = this.pickRandom<VideoPacing>(["fast", "medium", "slow"], rng);
    const cutCount = Math.floor(rng() * (durationSec / 3) + 2);
    const suggestedBpm = this.deriveBpm(pacing, cutCount, durationSec);
    const suggestedKey = this.deriveKey(overallMood);

    const sceneChanges = this.syntheticSceneChanges(durationSec, cutCount, rng);
    const actionPeaks  = this.syntheticActionPeaks(durationSec, rng);
    const speechPauses = this.detectSpeechPauses(durationSec, sceneChanges, actionPeaks);
    const moodTimeline = this.syntheticMoodTimeline(durationSec, overallMood, sceneChanges, rng);
    const intensityCurve = this.syntheticIntensityCurve(durationSec, actionPeaks, rng);

    return {
      durationSec,
      overallMood,
      pacing,
      suggestedBpm,
      suggestedKey,
      sceneChanges,
      speechPauses,
      actionPeaks,
      moodTimeline,
      intensityCurve,
    };
  }

  // ── Frame-based extraction ─────────────────────────────────────────────────

  private detectSceneChanges(
    timestamps: number[],
    frames: ImageData[],
  ): SceneChange[] {
    const cuts: SceneChange[] = [];
    const { sceneCutThreshold } = this.opts;
    for (let i = 1; i < frames.length; i++) {
      const diff = meanAbsDiff(frames[i - 1].data, frames[i].data);
      if (diff > sceneCutThreshold) {
        cuts.push({
          timestampSec: timestamps[i],
          diffScore: Math.min(1, diff / 255),
        });
      }
    }
    return cuts;
  }

  private detectActionPeaks(
    timestamps: number[],
    frames: ImageData[],
  ): ActionPeak[] {
    const energies: number[] = [0];
    for (let i = 1; i < frames.length; i++) {
      energies.push(motionEnergy(frames[i - 1].data, frames[i].data));
    }

    const smoothed = gaussianSmooth(energies, 2);
    const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
    const std = Math.sqrt(
      smoothed.reduce((a, v) => a + (v - mean) ** 2, 0) / smoothed.length,
    );
    const threshold = mean + std * 1.5;

    const peaks: ActionPeak[] = [];
    for (let i = 1; i < smoothed.length - 1; i++) {
      if (
        smoothed[i] > threshold &&
        smoothed[i] >= smoothed[i - 1] &&
        smoothed[i] >= smoothed[i + 1]
      ) {
        peaks.push({ timestampSec: timestamps[i], energy: smoothed[i] });
      }
    }
    return peaks;
  }

  private detectSpeechPauses(
    durationSec: number,
    sceneChanges: SceneChange[],
    actionPeaks: ActionPeak[],
  ): SpeechPause[] {
    // Heuristic: regions between cuts / peaks with low activity are likely
    // speech pauses.  In production this would analyse an audio track.
    const busyTimes = new Set<number>([
      ...sceneChanges.map(s => Math.floor(s.timestampSec)),
      ...actionPeaks.map(p => Math.floor(p.timestampSec)),
    ]);

    const pauses: SpeechPause[] = [];
    let pauseStart: number | null = null;

    for (let sec = 1; sec < Math.floor(durationSec); sec++) {
      const isBusy = busyTimes.has(sec) || busyTimes.has(sec - 1);
      if (!isBusy && pauseStart === null) {
        pauseStart = sec;
      } else if (isBusy && pauseStart !== null) {
        const dur = sec - pauseStart;
        if (dur >= 1.5 && dur <= 10) {
          pauses.push({ startSec: pauseStart, endSec: sec, durationSec: dur });
        }
        pauseStart = null;
      }
    }
    return pauses;
  }

  // ── Mood / pacing inference ────────────────────────────────────────────────

  private inferOverallMood(
    timestamps: number[],
    frames: ImageData[],
    sceneChanges: SceneChange[],
    actionPeaks: ActionPeak[],
  ): VideoMood {
    // Feature vector:
    //   saturation (0-1): high → happy/epic, low → melancholic/tense
    //   luminance   (0-1): high → happy/chill, low → dramatic/tense
    //   motion      (0-1): high → epic/dramatic, low → chill/melancholic
    //   cut density (0-1): high → fast/dramatic/epic, low → slow/chill

    let totalSat = 0, totalLum = 0;
    for (const f of frames) {
      totalSat += averageSaturation(f.data);
      totalLum += averageLuminance(f.data) / 255;
    }
    const avgSat = totalSat / frames.length;
    const avgLum = totalLum / frames.length;

    const totalMotion = actionPeaks.reduce((s, p) => s + p.energy, 0);
    const avgMotion = actionPeaks.length > 0 ? totalMotion / actionPeaks.length : 0;

    const duration = timestamps[timestamps.length - 1] - timestamps[0];
    const cutDensity = Math.min(1, sceneChanges.length / (duration / 5));

    if (avgSat > 0.55 && avgLum > 0.55 && avgMotion > 0.4) return "epic";
    if (avgSat > 0.5  && avgLum > 0.5  && avgMotion < 0.3) return "happy";
    if (avgSat < 0.3  && avgLum < 0.4  && cutDensity > 0.6) return "tense";
    if (avgSat < 0.35 && avgLum < 0.45) return "melancholic";
    if (cutDensity > 0.5 && avgMotion > 0.35) return "dramatic";
    return "chill";
  }

  private inferPacing(
    durationSec: number,
    sceneChanges: SceneChange[],
    actionPeaks: ActionPeak[],
  ): VideoPacing {
    const cutsPerMinute = (sceneChanges.length / durationSec) * 60;
    const peaksPerMinute = (actionPeaks.length / durationSec) * 60;
    const activity = (cutsPerMinute + peaksPerMinute) / 2;

    if (activity > 12) return "fast";
    if (activity > 5)  return "medium";
    return "slow";
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  private deriveBpm(
    pacing: VideoPacing,
    cutCount: number,
    durationSec: number,
  ): number {
    const [lo, hi] = PACING_BPM_RANGES[pacing];
    // Bias within the range based on cut density
    const density = Math.min(1, (cutCount / durationSec) * 10);
    return Math.round(lo + density * (hi - lo));
  }

  private deriveKey(mood: VideoMood): string {
    const brightness = MOOD_BRIGHTNESS[mood];
    return KEY_PALETTE[brightness % KEY_PALETTE.length];
  }

  // ── Timeline builders ──────────────────────────────────────────────────────

  private buildMoodTimeline(
    timestamps: number[],
    frames: ImageData[],
    sceneChanges: SceneChange[],
    overallMood: VideoMood,
    durationSec: number,
  ): MoodMarker[] {
    const markers: MoodMarker[] = [];
    const cutSet = new Set(sceneChanges.map(c => c.timestampSec));

    // One marker per 5-second segment
    const segSize = 5;
    for (let t = 0; t < durationSec; t += segSize) {
      // Collect frames within this segment
      const segFrames = frames.filter((_, i) => {
        const ts = timestamps[i];
        return ts >= t && ts < t + segSize;
      });
      if (segFrames.length === 0) {
        markers.push({ timestampSec: t, mood: overallMood, intensity: 0.5 });
        continue;
      }

      const sat = segFrames.reduce((s, f) => s + averageSaturation(f.data), 0) / segFrames.length;
      const lum = segFrames.reduce((s, f) => s + averageLuminance(f.data) / 255, 0) / segFrames.length;
      const hasCut = [...cutSet].some(ct => ct >= t && ct < t + segSize);
      const intensity = Math.min(1, sat * 0.4 + lum * 0.3 + (hasCut ? 0.3 : 0));

      // Local mood can shift from overall
      let localMood = overallMood;
      if (hasCut && intensity > 0.65) {
        localMood = overallMood === "chill" ? "dramatic" : overallMood;
      } else if (intensity < 0.25) {
        localMood = overallMood === "happy" ? "melancholic" : overallMood;
      }

      markers.push({ timestampSec: t, mood: localMood, intensity });
    }

    return markers;
  }

  private buildIntensityCurve(
    timestamps: number[],
    frames: ImageData[],
    sceneChanges: SceneChange[],
    actionPeaks: ActionPeak[],
    durationSec: number,
  ): IntensityCurvePoint[] {
    const resolution = 1; // one point per second
    const raw: number[] = [];

    for (let sec = 0; sec < Math.ceil(durationSec); sec++) {
      // Motion energy from frame diffs around this second
      let motion = 0;
      let count = 0;
      for (let i = 1; i < frames.length; i++) {
        if (Math.abs(timestamps[i] - sec) < 0.5) {
          motion += motionEnergy(frames[i - 1].data, frames[i].data);
          count++;
        }
      }
      const frameMotion = count > 0 ? motion / count : 0;

      // Boost from scene cuts
      const cutBoost = sceneChanges
        .filter(c => Math.abs(c.timestampSec - sec) < 1)
        .reduce((s, c) => s + c.diffScore * 0.4, 0);

      // Boost from action peaks
      const peakBoost = actionPeaks
        .filter(p => Math.abs(p.timestampSec - sec) < 1)
        .reduce((s, p) => s + p.energy * 0.5, 0);

      raw.push(Math.min(1, frameMotion + cutBoost + peakBoost));
    }

    const smoothed = gaussianSmooth(raw, 2);

    return smoothed.map((value, i) => ({
      timestampSec: i * resolution,
      value: Math.max(0, Math.min(1, value)),
    }));
  }

  // ── Synthetic (metadata-only) helpers ────────────────────────────────────

  private syntheticSceneChanges(
    durationSec: number,
    count: number,
    rng: () => number,
  ): SceneChange[] {
    const times: number[] = [];
    for (let i = 0; i < count; i++) times.push(rng() * durationSec);
    return times
      .sort((a, b) => a - b)
      .map(t => ({ timestampSec: Math.round(t * 10) / 10, diffScore: 0.5 + rng() * 0.5 }));
  }

  private syntheticActionPeaks(durationSec: number, rng: () => number): ActionPeak[] {
    const peakCount = Math.floor(rng() * 6 + 2);
    const peaks: ActionPeak[] = [];
    for (let i = 0; i < peakCount; i++) {
      peaks.push({
        timestampSec: Math.round(rng() * durationSec * 10) / 10,
        energy: 0.4 + rng() * 0.6,
      });
    }
    return peaks.sort((a, b) => a.timestampSec - b.timestampSec);
  }

  private syntheticMoodTimeline(
    durationSec: number,
    overallMood: VideoMood,
    sceneChanges: SceneChange[],
    rng: () => number,
  ): MoodMarker[] {
    const markers: MoodMarker[] = [];
    const cutSet = new Set(sceneChanges.map(c => Math.floor(c.timestampSec)));
    for (let t = 0; t < durationSec; t += 5) {
      const hasCut = [...cutSet].some(ct => ct >= t && ct < t + 5);
      const intensity = Math.min(1, 0.3 + rng() * 0.5 + (hasCut ? 0.2 : 0));
      markers.push({ timestampSec: t, mood: overallMood, intensity });
    }
    return markers;
  }

  private syntheticIntensityCurve(
    durationSec: number,
    actionPeaks: ActionPeak[],
    rng: () => number,
  ): IntensityCurvePoint[] {
    const raw: number[] = [];
    for (let sec = 0; sec < Math.ceil(durationSec); sec++) {
      const peakBoost = actionPeaks
        .filter(p => Math.abs(p.timestampSec - sec) < 2)
        .reduce((s, p) => s + p.energy * 0.4, 0);
      raw.push(Math.min(1, 0.2 + rng() * 0.3 + peakBoost));
    }
    const smoothed = gaussianSmooth(raw, 3);
    return smoothed.map((value, i) => ({ timestampSec: i, value }));
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /** Mulberry32 seeded PRNG returning float in [0, 1). */
  private seededRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private pickRandom<T>(items: T[], rng: () => number): T {
    return items[Math.floor(rng() * items.length)];
  }
}

// ── Convenience singleton export ─────────────────────────────────────────────

export const musicAnalyzer = new MusicAnalyzer();
