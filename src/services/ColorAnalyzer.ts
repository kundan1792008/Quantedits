/**
 * ColorAnalyzer — AI Color DNA Extraction Engine
 *
 * Analyzes video frames to produce a comprehensive "Color DNA" profile:
 *   - RGB / HSL histogram analysis (sampled every 5th frame)
 *   - White balance detection (temperature + tint)
 *   - Exposure, contrast, and saturation metrics
 *   - Dominant color extraction (k-means clustering)
 *   - Scene-type classification (indoor/outdoor, day/night, golden hour, overcast)
 *   - Shadow/midtone/highlight split-point detection
 *
 * The resulting ColorDNA object drives the ColorGradingEngine to
 * recommend the most perceptually appropriate grade preset.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** A single dominant color swatch with its relative weight in the frame. */
export interface DominantColor {
  r: number;
  g: number;
  b: number;
  /** 0–1 fraction of total sampled pixels belonging to this cluster. */
  weight: number;
  /** HSL representation for convenience. */
  h: number;
  s: number;
  l: number;
}

/** Per-channel histogram data (256-bucket). */
export interface ChannelHistogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
}

/** Detected scene classification. */
export type SceneType =
  | "outdoor_day"
  | "outdoor_golden_hour"
  | "outdoor_blue_hour"
  | "outdoor_night"
  | "indoor_warm"
  | "indoor_cool"
  | "indoor_neutral"
  | "overcast"
  | "studio"
  | "unknown";

/** Detected lighting quality descriptor. */
export type LightingQuality =
  | "high_contrast"
  | "low_contrast"
  | "flat"
  | "dramatic"
  | "soft"
  | "mixed";

/**
 * Full Color DNA profile produced by ColorAnalyzer.
 * All numeric values are normalised to 0–1 unless documented otherwise.
 */
export interface ColorDNA {
  /** Version stamp so downstream consumers can detect stale profiles. */
  version: 1;

  /** Number of frames that were actually sampled. */
  framesSampled: number;

  /** Aggregated histogram across all sampled frames. */
  histogram: ChannelHistogram;

  /** Top-N dominant colors sorted by weight (descending). */
  dominantColors: DominantColor[];

  /**
   * Color temperature in Kelvin (2000–12 000 K).
   * < 4000 K  → warm / tungsten
   * 4000–6500 K → neutral / daylight
   * > 6500 K  → cool / overcast / LED
   */
  colorTemperature: number;

  /**
   * Green–magenta tint offset (-1 … +1).
   * Negative = magenta push, positive = green push.
   */
  tint: number;

  /** Average scene exposure in EV relative to 18 % grey (−3 … +3). */
  exposureEV: number;

  /** RMS contrast of the luma channel (0 = flat, 1 = maximum). */
  contrast: number;

  /** Average HSL saturation across all sampled pixels (0–1). */
  saturation: number;

  /** Perceptual brightness of the average pixel (0–1). */
  brightness: number;

  /**
   * Shadow pivot luma value (0–1).
   * Pixels below this are considered "shadows".
   */
  shadowPivot: number;

  /**
   * Highlight pivot luma value (0–1).
   * Pixels above this are considered "highlights".
   */
  highlightPivot: number;

  /** Detected scene type. */
  sceneType: SceneType;

  /** Detected lighting quality. */
  lightingQuality: LightingQuality;

  /**
   * 0-1 score describing how much the footage will benefit from grading.
   * High score → footage is flat / low contrast → lots of room to enhance.
   */
  gradingPotential: number;

  /** Human-readable one-line description of the detected aesthetic. */
  description: string;
}

/** Options passed to ColorAnalyzer.analyze(). */
export interface AnalyzeOptions {
  /**
   * Sample every N-th frame (default 5).
   * Lower = more accurate, higher = faster.
   */
  sampleInterval?: number;

  /**
   * Maximum number of frames to sample regardless of sampleInterval.
   * Prevents very long sources from taking too long (default 200).
   */
  maxFrames?: number;

  /**
   * Number of dominant color clusters to extract (default 6).
   */
  dominantColorCount?: number;

  /**
   * Canvas downscale factor applied before histogram analysis (default 4).
   * Reduces pixel count → significantly faster analysis.
   */
  downscaleFactor?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_SAMPLE_INTERVAL = 5;
const DEFAULT_MAX_FRAMES = 200;
const DEFAULT_DOMINANT_COLORS = 6;
const DEFAULT_DOWNSCALE = 4;
const HISTOGRAM_BINS = 256;

// Standard illuminant D65 chromaticity used for white-balance estimation
const D65_R_WEIGHT = 0.2126;
const D65_G_WEIGHT = 0.7152;
const D65_B_WEIGHT = 0.0722;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert sRGB (0–1) to linear light. */
function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Calculate ITU-R BT.709 luma from linear RGB (0–1). */
function rgbToLuma(r: number, g: number, b: number): number {
  return D65_R_WEIGHT * srgbToLinear(r) + D65_G_WEIGHT * srgbToLinear(g) + D65_B_WEIGHT * srgbToLinear(b);
}

/** Convert RGB (0–255) to HSL (h: 0–360, s: 0–1, l: 0–1). */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

/**
 * Estimate perceptual color temperature from RGB means (simplified).
 * Uses the ratio of R to B channels correlated against standard illuminant
 * tables. Returns Kelvin.
 */
function estimateColorTemperature(meanR: number, meanG: number, meanB: number): number {
  if (meanB === 0) return 2000;
  const rb = meanR / (meanB + 1e-6);
  // Simplified McCamy formula correlation
  // rb > 1.8  → warm (< 3200 K)
  // rb ≈ 1.0  → neutral (≈ 5600 K)
  // rb < 0.6  → cool (> 7500 K)
  const kelvin = Math.round(8000 / (rb * 0.9 + 0.5));
  return Math.max(2000, Math.min(12000, kelvin));
}

/**
 * Estimate tint (green–magenta) from the ratio of G to (R+B)/2.
 * Returns value in −1 … +1.
 */
function estimateTint(meanR: number, meanG: number, meanB: number): number {
  const rb = (meanR + meanB) / 2 + 1e-6;
  const ratio = meanG / rb;
  return Math.max(-1, Math.min(1, (ratio - 1) * 2));
}

/**
 * Simple k-means clustering on RGB pixel samples.
 * Returns `k` centroids sorted by weight descending.
 */
function kMeansColors(
  pixels: Uint8Array,
  k: number,
  maxIterations = 20,
): DominantColor[] {
  const pixelCount = Math.floor(pixels.length / 4);
  if (pixelCount === 0) return [];

  // Initialise centroids with k-means++ style spread
  const centroids: [number, number, number][] = [];
  const firstIdx = Math.floor(Math.random() * pixelCount) * 4;
  centroids.push([pixels[firstIdx], pixels[firstIdx + 1], pixels[firstIdx + 2]]);

  while (centroids.length < k) {
    // Pick the pixel furthest from all existing centroids
    let maxDist = -1;
    let bestIdx = 0;
    const step = Math.max(1, Math.floor(pixelCount / 512));
    for (let i = 0; i < pixelCount; i += step) {
      const base = i * 4;
      let minD = Infinity;
      for (const c of centroids) {
        const dr = pixels[base] - c[0];
        const dg = pixels[base + 1] - c[1];
        const db = pixels[base + 2] - c[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) minD = d;
      }
      if (minD > maxDist) { maxDist = minD; bestIdx = i; }
    }
    const bi = bestIdx * 4;
    centroids.push([pixels[bi], pixels[bi + 1], pixels[bi + 2]]);
  }

  // Iterate k-means assignment / update
  const assignments = new Int32Array(pixelCount);
  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign
    for (let i = 0; i < pixelCount; i++) {
      const base = i * 4;
      let minD = Infinity;
      let best = 0;
      for (let c = 0; c < centroids.length; c++) {
        const dr = pixels[base] - centroids[c][0];
        const dg = pixels[base + 1] - centroids[c][1];
        const db = pixels[base + 2] - centroids[c][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) { minD = d; best = c; }
      }
      assignments[i] = best;
    }
    // Update
    const sums: [number, number, number, number][] = Array.from(
      { length: k }, () => [0, 0, 0, 0],
    );
    for (let i = 0; i < pixelCount; i++) {
      const c = assignments[i];
      const base = i * 4;
      sums[c][0] += pixels[base];
      sums[c][1] += pixels[base + 1];
      sums[c][2] += pixels[base + 2];
      sums[c][3]++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c][3] > 0) {
        centroids[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }
  }

  // Compute weights
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < pixelCount; i++) counts[assignments[i]]++;

  return centroids
    .map((c, i) => {
      const weight = counts[i] / pixelCount;
      const hsl = rgbToHsl(c[0], c[1], c[2]);
      return { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]), weight, ...hsl };
    })
    .sort((a, b) => b.weight - a.weight);
}

/** Compute the percentile value from a 256-bucket histogram. */
function histogramPercentile(hist: Uint32Array, pct: number): number {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  const target = total * pct;
  let cumulative = 0;
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i];
    if (cumulative >= target) return i / 255;
  }
  return 1;
}

/** Compute RMS standard deviation of luma from histogram. */
function histogramRMS(hist: Uint32Array, mean: number): number {
  let total = 0;
  let sumSq = 0;
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    sumSq += hist[i] * (v - mean) * (v - mean);
    total += hist[i];
  }
  return total > 0 ? Math.sqrt(sumSq / total) : 0;
}

/** Classify scene type from color DNA metrics. */
function classifyScene(
  colorTemperature: number,
  exposureEV: number,
  saturation: number,
  contrast: number,
  dominantColors: DominantColor[],
): SceneType {
  const topColor = dominantColors[0];
  const avgHue = topColor?.h ?? 0;
  const avgSat = topColor?.s ?? 0;

  // Night detection: very dark + possibly high saturation (neon/artificial light)
  if (exposureEV < -1.5) return "outdoor_night";

  // Golden hour: warm temperature, orange/amber hues
  if (colorTemperature < 3800 && avgHue >= 15 && avgHue <= 45 && saturation > 0.25) {
    return "outdoor_golden_hour";
  }

  // Blue hour / twilight: cool temp, blue-purple hues
  if (colorTemperature > 7000 && avgHue >= 200 && avgHue <= 260) {
    return "outdoor_blue_hour";
  }

  // Overcast: cool, low saturation, medium exposure
  if (colorTemperature > 6500 && saturation < 0.18 && contrast < 0.15) {
    return "overcast";
  }

  // Studio: very controlled light, neutral temperature, controlled contrast
  if (
    colorTemperature >= 4800 && colorTemperature <= 5600 &&
    contrast > 0.2 && saturation < 0.3 &&
    avgSat < 0.2
  ) {
    return "studio";
  }

  // Indoor warm (tungsten / warm LED)
  if (colorTemperature < 4000) return "indoor_warm";

  // Indoor cool (fluorescent / cool LED)
  if (colorTemperature >= 4000 && colorTemperature < 5500 && exposureEV < 0.3) {
    return colorTemperature < 4800 ? "indoor_neutral" : "indoor_cool";
  }

  // Default: outdoor day
  return "outdoor_day";
}

/** Generate a human-readable description of the footage aesthetic. */
function describeAesthetic(dna: Omit<ColorDNA, "description">): string {
  const temp = dna.colorTemperature;
  const tempDesc =
    temp < 3500 ? "warm, tungsten-lit"
    : temp < 4800 ? "warm-neutral"
    : temp < 6000 ? "neutral daylight"
    : temp < 7500 ? "cool, overcast"
    : "very cool, blue-tinted";

  const contrastDesc =
    dna.contrast > 0.3 ? "high-contrast"
    : dna.contrast > 0.18 ? "moderate-contrast"
    : "flat, low-contrast";

  const satDesc =
    dna.saturation > 0.5 ? "highly saturated"
    : dna.saturation > 0.3 ? "naturally saturated"
    : dna.saturation > 0.15 ? "muted"
    : "desaturated / monochromatic";

  return `${tempDesc}, ${contrastDesc}, ${satDesc} — scene: ${dna.sceneType.replace(/_/g, " ")}`;
}

// ── Main Class ─────────────────────────────────────────────────────────────

/**
 * ColorAnalyzer extracts a ColorDNA profile from a video element or
 * an array of ImageData / HTMLCanvasElement frames.
 *
 * Usage — from a <video> element:
 * ```ts
 * const analyzer = new ColorAnalyzer();
 * const dna = await analyzer.analyzeVideo(videoElement);
 * ```
 *
 * Usage — from pre-decoded frames:
 * ```ts
 * const dna = await analyzer.analyzeFrames(imageDataArray);
 * ```
 */
export class ColorAnalyzer {
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  constructor() {
    if (typeof document !== "undefined") {
      this.offscreenCanvas = document.createElement("canvas");
      this.offscreenCtx = this.offscreenCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Analyze a <video> element by seeking to sampled timestamps and
   * capturing frames via an offscreen canvas.
   */
  async analyzeVideo(
    video: HTMLVideoElement,
    options: AnalyzeOptions = {},
  ): Promise<ColorDNA> {
    const {
      sampleInterval = DEFAULT_SAMPLE_INTERVAL,
      maxFrames = DEFAULT_MAX_FRAMES,
      dominantColorCount = DEFAULT_DOMINANT_COLORS,
      downscaleFactor = DEFAULT_DOWNSCALE,
    } = options;

    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) {
      throw new Error("[ColorAnalyzer] Video has no duration — ensure metadata is loaded.");
    }

    const fps = 30; // assumed; for exact analysis use video.getVideoPlaybackQuality()
    const totalFrames = Math.floor(duration * fps);
    const frameIndices: number[] = [];
    for (let f = 0; f < totalFrames; f += sampleInterval) {
      frameIndices.push(f);
      if (frameIndices.length >= maxFrames) break;
    }

    const frames: ImageData[] = [];
    for (const frameIdx of frameIndices) {
      const t = frameIdx / fps;
      const imageData = await this.captureFrameAt(video, t, downscaleFactor);
      if (imageData) frames.push(imageData);
    }

    return this.computeColorDNA(frames, dominantColorCount);
  }

  /**
   * Analyze an array of ImageData objects (e.g. from a decoded video or
   * pre-rendered thumbnails).
   */
  async analyzeFrames(
    frames: ImageData[],
    options: AnalyzeOptions = {},
  ): Promise<ColorDNA> {
    const { sampleInterval = DEFAULT_SAMPLE_INTERVAL, dominantColorCount = DEFAULT_DOMINANT_COLORS } = options;
    const sampled = frames.filter((_, i) => i % sampleInterval === 0);
    return this.computeColorDNA(sampled, dominantColorCount);
  }

  /**
   * Lightweight single-frame analysis — useful for real-time preview.
   * Returns partial metrics without scene classification.
   */
  analyzeFrame(imageData: ImageData): Pick<
    ColorDNA,
    "colorTemperature" | "tint" | "exposureEV" | "contrast" | "saturation" | "brightness"
  > {
    const hist = this.buildHistogram([imageData]);
    const metrics = this.deriveMetrics(hist);
    return {
      colorTemperature: metrics.colorTemperature,
      tint: metrics.tint,
      exposureEV: metrics.exposureEV,
      contrast: metrics.contrast,
      saturation: metrics.saturation,
      brightness: metrics.brightness,
    };
  }

  // ── Private implementation ─────────────────────────────────────────────

  private async captureFrameAt(
    video: HTMLVideoElement,
    timeSec: number,
    downscaleFactor: number,
  ): Promise<ImageData | null> {
    return new Promise((resolve) => {
      const canvas = this.offscreenCanvas;
      const ctx = this.offscreenCtx;
      if (!canvas || !ctx) { resolve(null); return; }

      const targetW = Math.max(1, Math.floor(video.videoWidth / downscaleFactor));
      const targetH = Math.max(1, Math.floor(video.videoHeight / downscaleFactor));
      canvas.width = targetW;
      canvas.height = targetH;

      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        try {
          ctx.drawImage(video, 0, 0, targetW, targetH);
          resolve(ctx.getImageData(0, 0, targetW, targetH));
        } catch {
          resolve(null);
        }
      };

      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = timeSec;
    });
  }

  private buildHistogram(frames: ImageData[]): ChannelHistogram {
    const r = new Uint32Array(HISTOGRAM_BINS);
    const g = new Uint32Array(HISTOGRAM_BINS);
    const b = new Uint32Array(HISTOGRAM_BINS);
    const luma = new Uint32Array(HISTOGRAM_BINS);

    for (const frame of frames) {
      const data = frame.data;
      for (let i = 0; i < data.length; i += 4) {
        const rv = data[i];
        const gv = data[i + 1];
        const bv = data[i + 2];
        r[rv]++;
        g[gv]++;
        b[bv]++;
        const l = Math.round(rgbToLuma(rv / 255, gv / 255, bv / 255) * 255);
        luma[Math.min(255, l)]++;
      }
    }

    return { r, g, b, luma };
  }

  private deriveMetrics(hist: ChannelHistogram): {
    colorTemperature: number;
    tint: number;
    exposureEV: number;
    contrast: number;
    saturation: number;
    brightness: number;
    shadowPivot: number;
    highlightPivot: number;
  } {
    // Compute channel means
    let rTotal = 0, gTotal = 0, bTotal = 0, lumaTotal = 0, pixCount = 0;
    for (let i = 0; i < 256; i++) {
      rTotal += i * hist.r[i];
      gTotal += i * hist.g[i];
      bTotal += i * hist.b[i];
      lumaTotal += i * hist.luma[i];
      pixCount += hist.luma[i];
    }
    if (pixCount === 0) pixCount = 1;
    const meanR = rTotal / pixCount;
    const meanG = gTotal / pixCount;
    const meanB = bTotal / pixCount;
    const meanLuma = lumaTotal / pixCount / 255;

    const colorTemperature = estimateColorTemperature(meanR, meanG, meanB);
    const tint = estimateTint(meanR, meanG, meanB);

    // Exposure EV: compare mean luma against 18% grey (0.18)
    const exposureEV = Math.log2(Math.max(1e-4, meanLuma) / 0.18);

    const contrast = histogramRMS(hist.luma, meanLuma);

    // Approximate saturation from R/G/B spread
    const channelVariance =
      ((meanR - meanG) ** 2 + (meanG - meanB) ** 2 + (meanR - meanB) ** 2) / (3 * 255 * 255);
    const saturation = Math.sqrt(channelVariance) * 3;

    const brightness = meanLuma;
    const shadowPivot = histogramPercentile(hist.luma, 0.1);
    const highlightPivot = histogramPercentile(hist.luma, 0.9);

    return {
      colorTemperature,
      tint,
      exposureEV: Math.max(-3, Math.min(3, exposureEV)),
      contrast: Math.min(1, contrast),
      saturation: Math.min(1, saturation),
      brightness,
      shadowPivot,
      highlightPivot,
    };
  }

  private computeColorDNA(frames: ImageData[], dominantColorCount: number): ColorDNA {
    if (frames.length === 0) {
      return this.emptyDNA();
    }

    const histogram = this.buildHistogram(frames);
    const metrics = this.deriveMetrics(histogram);

    // Flatten all sampled pixels into a single buffer for k-means
    const totalPixels = frames.reduce((s, f) => s + Math.floor(f.data.length / 4), 0);
    const pixelBuffer = new Uint8Array(totalPixels * 4);
    let offset = 0;
    for (const frame of frames) {
      pixelBuffer.set(frame.data, offset);
      offset += frame.data.length;
    }

    const dominantColors = kMeansColors(pixelBuffer, dominantColorCount);

    const sceneType = classifyScene(
      metrics.colorTemperature,
      metrics.exposureEV,
      metrics.saturation,
      metrics.contrast,
      dominantColors,
    );

    const lightingQuality: LightingQuality =
      metrics.contrast > 0.3 ? "dramatic"
      : metrics.contrast > 0.22 ? "high_contrast"
      : metrics.contrast > 0.14 ? "soft"
      : metrics.contrast > 0.07 ? "low_contrast"
      : "flat";

    // Grading potential: footage with flat contrast, low saturation benefits most
    const gradingPotential = Math.min(
      1,
      (1 - metrics.contrast) * 0.5 + (1 - metrics.saturation) * 0.3 + 0.2,
    );

    const partial: Omit<ColorDNA, "description"> = {
      version: 1,
      framesSampled: frames.length,
      histogram,
      dominantColors,
      ...metrics,
      sceneType,
      lightingQuality,
      gradingPotential,
    };

    return {
      ...partial,
      description: describeAesthetic(partial),
    };
  }

  private emptyDNA(): ColorDNA {
    const emptyHist: ChannelHistogram = {
      r: new Uint32Array(256),
      g: new Uint32Array(256),
      b: new Uint32Array(256),
      luma: new Uint32Array(256),
    };
    return {
      version: 1,
      framesSampled: 0,
      histogram: emptyHist,
      dominantColors: [],
      colorTemperature: 5600,
      tint: 0,
      exposureEV: 0,
      contrast: 0,
      saturation: 0,
      brightness: 0.5,
      shadowPivot: 0.1,
      highlightPivot: 0.9,
      sceneType: "unknown",
      lightingQuality: "flat",
      gradingPotential: 0,
      description: "No frames analyzed",
    };
  }
}

/** Singleton instance shared across the app. */
export const colorAnalyzer = new ColorAnalyzer();
