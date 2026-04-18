/**
 * AIEditService — AI-powered frame and clip processing pipeline
 *
 * Operations:
 *   - removeBackground  — ML-based alpha-matte extraction
 *   - generativeFill    — inpaint masked region from a text prompt
 *   - styleTransfer     — apply an artistic style to a frame
 *   - upscale           — AI super-resolution (2x, 4x)
 *   - autoColor         — automatic colour grading
 *
 * Features:
 *   - Priority queue with concurrency control
 *   - Per-job progress callbacks
 *   - Batch mode (apply to contiguous frame ranges)
 *   - Cancellation support
 *   - Retry logic with exponential back-off
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type AIOperationType =
  | "REMOVE_BACKGROUND"
  | "GENERATIVE_FILL"
  | "STYLE_TRANSFER"
  | "UPSCALE"
  | "AUTO_COLOR";

export type AIJobStatus =
  | "PENDING"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export interface FrameData {
  /** Raw RGBA pixel data */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface AlphaMatte {
  /** Single-channel alpha values 0..255 */
  alpha: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface RemoveBackgroundResult {
  matte: AlphaMatte;
  /** RGBA frame with background removed */
  composited: FrameData;
}

export interface GenerativeFillResult {
  frame: FrameData;
}

export interface StyleTransferResult {
  frame: FrameData;
  styleId: string;
}

export interface UpscaleResult {
  frame: FrameData;
  factor: number;
}

export interface AutoColorResult {
  frame: FrameData;
  /** Applied LUT data (optional) */
  lut?: Float32Array;
  corrections: {
    brightness: number;
    contrast: number;
    saturation: number;
    temperature: number;
    tint: number;
    highlights: number;
    shadows: number;
  };
}

export type AIOperationResult =
  | { type: "REMOVE_BACKGROUND"; result: RemoveBackgroundResult }
  | { type: "GENERATIVE_FILL"; result: GenerativeFillResult }
  | { type: "STYLE_TRANSFER"; result: StyleTransferResult }
  | { type: "UPSCALE"; result: UpscaleResult }
  | { type: "AUTO_COLOR"; result: AutoColorResult };

export interface AIJob {
  id: string;
  type: AIOperationType;
  status: AIJobStatus;
  priority: number; // lower = higher priority
  progress: number; // 0..100
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  retries: number;
  maxRetries: number;
  errorMessage?: string;
  result?: AIOperationResult;
  abortController: AbortController;
}

export type ProgressCallback = (jobId: string, progress: number) => void;
export type CompletionCallback = (
  jobId: string,
  result: AIOperationResult | null,
  error?: Error,
) => void;

// ── Style library ─────────────────────────────────────────────────────────

export const STYLE_LIBRARY: Record<
  string,
  { name: string; description: string; previewUrl?: string }
> = {
  "style-anime": { name: "Anime", description: "Japanese animation style" },
  "style-oil-painting": {
    name: "Oil Painting",
    description: "Classical oil painting texture",
  },
  "style-watercolor": {
    name: "Watercolour",
    description: "Soft watercolour wash",
  },
  "style-cyberpunk": {
    name: "Cyberpunk",
    description: "Neon-lit futuristic aesthetic",
  },
  "style-vintage-film": {
    name: "Vintage Film",
    description: "1970s film grain and colour",
  },
  "style-comic": { name: "Comic Book", description: "Bold outlines, flat colours" },
  "style-impressionist": {
    name: "Impressionist",
    description: "Monet-style brushwork",
  },
  "style-noir": {
    name: "Film Noir",
    description: "High-contrast black and white",
  },
  "style-neon-glow": {
    name: "Neon Glow",
    description: "Glowing neon outlines",
  },
  "style-sketch": { name: "Pencil Sketch", description: "Detailed pencil drawing" },
};

// ── Colour science helpers ────────────────────────────────────────────────

/** Convert RGB to HSL */
function rgbToHsl(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

/** Convert HSL back to RGB */
function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hueToRgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hueToRgb(h + 1 / 3) * 255),
    Math.round(hueToRgb(h) * 255),
    Math.round(hueToRgb(h - 1 / 3) * 255),
  ];
}

/** Compute image luminance histogram (256 bins) */
function computeLuminanceHistogram(frame: FrameData): Uint32Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < frame.data.length; i += 4) {
    const r = frame.data[i];
    const g = frame.data[i + 1];
    const b = frame.data[i + 2];
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    hist[lum]++;
  }
  return hist;
}

/** Compute mean and standard deviation of luminance */
function luminanceStats(
  hist: Uint32Array,
  totalPixels: number,
): { mean: number; stddev: number } {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  const mean = sum / totalPixels;

  let variance = 0;
  for (let i = 0; i < 256; i++) {
    variance += hist[i] * Math.pow(i - mean, 2);
  }
  const stddev = Math.sqrt(variance / totalPixels);
  return { mean, stddev };
}

/** Apply tone-curve adjustments to RGBA pixel data */
function applyToneCurve(
  data: Uint8ClampedArray,
  brightness: number,
  contrast: number,
  saturation: number,
  temperature: number,
  tint: number,
  highlights: number,
  shadows: number,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(data.length);

  // Pre-compute lookup tables for speed
  const lutR = new Uint8ClampedArray(256);
  const lutG = new Uint8ClampedArray(256);
  const lutB = new Uint8ClampedArray(256);

  for (let i = 0; i < 256; i++) {
    const t = i / 255;

    // Highlights / shadows
    let v = t;
    if (v > 0.5) {
      v += ((v - 0.5) / 0.5) * (highlights * 0.5);
    } else {
      v += (1 - v / 0.5) * (shadows * 0.5);
    }

    // Brightness
    v += brightness;

    // Contrast
    v = (v - 0.5) * contrast + 0.5;

    v = Math.max(0, Math.min(1, v));

    lutR[i] = Math.round(v * 255);
    lutG[i] = Math.round(v * 255);
    lutB[i] = Math.round(v * 255);
  }

  for (let i = 0; i < data.length; i += 4) {
    let r = lutR[data[i]];
    let g = lutG[data[i + 1]];
    let b = lutB[data[i + 2]];

    // Temperature (warm/cool shift)
    r = Math.max(0, Math.min(255, r + temperature * 20));
    b = Math.max(0, Math.min(255, b - temperature * 20));

    // Tint (green/magenta shift)
    g = Math.max(0, Math.min(255, g + tint * 10));

    // Saturation
    if (saturation !== 1) {
      const [h, s, l] = rgbToHsl(r, g, b);
      const newS = Math.max(0, Math.min(1, s * saturation));
      const [nr, ng, nb] = hslToRgb(h, newS, l);
      r = nr;
      g = ng;
      b = nb;
    }

    result[i] = r;
    result[i + 1] = g;
    result[i + 2] = b;
    result[i + 3] = data[i + 3];
  }

  return result;
}

/** Simple nearest-neighbor upscale */
function nearestNeighborUpscale(
  frame: FrameData,
  factor: number,
): FrameData {
  const newW = Math.round(frame.width * factor);
  const newH = Math.round(frame.height * factor);
  const result = new Uint8ClampedArray(newW * newH * 4);

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcX = Math.floor(x / factor);
      const srcY = Math.floor(y / factor);
      const srcIdx = (srcY * frame.width + srcX) * 4;
      const dstIdx = (y * newW + x) * 4;
      result[dstIdx] = frame.data[srcIdx];
      result[dstIdx + 1] = frame.data[srcIdx + 1];
      result[dstIdx + 2] = frame.data[srcIdx + 2];
      result[dstIdx + 3] = frame.data[srcIdx + 3];
    }
  }

  return { data: result, width: newW, height: newH };
}

/** Bilinear upscale for higher quality */
function bilinearUpscale(frame: FrameData, factor: number): FrameData {
  const newW = Math.round(frame.width * factor);
  const newH = Math.round(frame.height * factor);
  const result = new Uint8ClampedArray(newW * newH * 4);
  const src = frame.data;
  const srcW = frame.width;
  const srcH = frame.height;

  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcXf = (x / factor);
      const srcYf = (y / factor);
      const x0 = Math.floor(srcXf);
      const y0 = Math.floor(srcYf);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = srcXf - x0;
      const fy = srcYf - y0;

      const idx00 = (y0 * srcW + x0) * 4;
      const idx10 = (y0 * srcW + x1) * 4;
      const idx01 = (y1 * srcW + x0) * 4;
      const idx11 = (y1 * srcW + x1) * 4;

      const dstIdx = (y * newW + x) * 4;
      for (let c = 0; c < 4; c++) {
        result[dstIdx + c] = Math.round(
          src[idx00 + c] * (1 - fx) * (1 - fy) +
            src[idx10 + c] * fx * (1 - fy) +
            src[idx01 + c] * (1 - fx) * fy +
            src[idx11 + c] * fx * fy,
        );
      }
    }
  }

  return { data: result, width: newW, height: newH };
}

/** Apply a mask to cut out a region, replacing it with a blurred background sample */
function applyGenerativeFillMask(
  frame: FrameData,
  mask: Uint8ClampedArray,
): FrameData {
  const result = new Uint8ClampedArray(frame.data);
  const w = frame.width;
  const h = frame.height;

  // Simple fill: average colour of surrounding non-masked pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] < 128) continue; // not masked

      // Sample from a small neighbourhood
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const radius = 8;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (mask[ni] >= 128) continue; // skip masked pixels
          const pi = ni * 4;
          rSum += frame.data[pi];
          gSum += frame.data[pi + 1];
          bSum += frame.data[pi + 2];
          count++;
        }
      }

      const pi = i * 4;
      if (count > 0) {
        result[pi] = Math.round(rSum / count);
        result[pi + 1] = Math.round(gSum / count);
        result[pi + 2] = Math.round(bSum / count);
      } else {
        // Fallback: neutral fill
        result[pi] = 128;
        result[pi + 1] = 128;
        result[pi + 2] = 128;
      }
    }
  }

  return { data: result, width: w, height: h };
}

/** Simple edge-detection for background separation (Sobel) */
function computeEdgeMap(frame: FrameData): Float32Array {
  const w = frame.width;
  const h = frame.height;
  const edges = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const getLum = (px: number, py: number) => {
        const idx = (py * w + px) * 4;
        return (frame.data[idx] * 299 + frame.data[idx + 1] * 587 + frame.data[idx + 2] * 114) / 1000;
      };

      const gx =
        -getLum(x - 1, y - 1) + getLum(x + 1, y - 1) +
        -2 * getLum(x - 1, y) + 2 * getLum(x + 1, y) +
        -getLum(x - 1, y + 1) + getLum(x + 1, y + 1);

      const gy =
        -getLum(x - 1, y - 1) - 2 * getLum(x, y - 1) - getLum(x + 1, y - 1) +
        getLum(x - 1, y + 1) + 2 * getLum(x, y + 1) + getLum(x + 1, y + 1);

      edges[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 255;
    }
  }

  return edges;
}

/** Generate a simple alpha matte by thresholding background edges */
function generateAlphaMatte(frame: FrameData): AlphaMatte {
  const w = frame.width;
  const h = frame.height;
  const edges = computeEdgeMap(frame);
  const alpha = new Uint8ClampedArray(w * h);

  // Heuristic: background tends to be uniform (low-variance regions)
  // This is a simplified stub — production would use a real ML segmentation model
  const hist = computeLuminanceHistogram(frame);
  const totalPixels = w * h;
  const { mean, stddev } = luminanceStats(hist, totalPixels);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const idx = i * 4;
      const lum = (frame.data[idx] * 299 + frame.data[idx + 1] * 587 + frame.data[idx + 2] * 114) / 1000;

      // If pixel is within 1 stddev of mean AND has low edge response → background
      const isBackground =
        Math.abs(lum - mean) < stddev * 0.8 && edges[i] < 0.15;

      alpha[i] = isBackground ? 0 : 255;
    }
  }

  // Simple dilation to clean up edges
  const dilated = new Uint8ClampedArray(alpha);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (alpha[y * w + x] === 0) {
        const hasNeighborFg =
          alpha[(y - 1) * w + x] > 0 ||
          alpha[(y + 1) * w + x] > 0 ||
          alpha[y * w + x - 1] > 0 ||
          alpha[y * w + x + 1] > 0;
        if (hasNeighborFg) dilated[y * w + x] = 128;
      }
    }
  }

  return { alpha: dilated, width: w, height: h };
}

/** Composite a frame with an alpha matte (removes background) */
function compositeWithMatte(frame: FrameData, matte: AlphaMatte): FrameData {
  const result = new Uint8ClampedArray(frame.data.length);
  const w = frame.width;
  const h = frame.height;

  for (let i = 0; i < w * h; i++) {
    const a = matte.alpha[i];
    result[i * 4] = frame.data[i * 4];
    result[i * 4 + 1] = frame.data[i * 4 + 1];
    result[i * 4 + 2] = frame.data[i * 4 + 2];
    result[i * 4 + 3] = a;
  }

  return { data: result, width: w, height: h };
}

/** Apply a style colour shift based on styleId (stub — production uses ML) */
function applyStyleTransferEffect(frame: FrameData, styleId: string): FrameData {
  const result = new Uint8ClampedArray(frame.data);
  const w = frame.width;
  const h = frame.height;

  switch (styleId) {
    case "style-noir": {
      for (let i = 0; i < result.length; i += 4) {
        const lum = Math.round(
          result[i] * 0.299 + result[i + 1] * 0.587 + result[i + 2] * 0.114,
        );
        // High contrast B&W
        const v = lum < 128 ? Math.max(0, lum - 20) : Math.min(255, lum + 20);
        result[i] = v;
        result[i + 1] = v;
        result[i + 2] = v;
      }
      break;
    }
    case "style-cyberpunk": {
      for (let i = 0; i < result.length; i += 4) {
        const r = result[i];
        const g = result[i + 1];
        const b = result[i + 2];
        result[i] = Math.min(255, r * 0.7 + b * 0.3 + 30);
        result[i + 1] = Math.min(255, g * 0.6);
        result[i + 2] = Math.min(255, b * 1.4 + r * 0.2);
      }
      break;
    }
    case "style-vintage-film": {
      for (let i = 0; i < result.length; i += 4) {
        result[i] = Math.min(255, result[i] * 1.1 + 10);
        result[i + 1] = Math.min(255, result[i + 1] * 0.95 + 5);
        result[i + 2] = Math.min(255, result[i + 2] * 0.8 - 10);
        // Grain
        const noise = (Math.random() - 0.5) * 25;
        result[i] = Math.max(0, Math.min(255, result[i] + noise));
        result[i + 1] = Math.max(0, Math.min(255, result[i + 1] + noise));
        result[i + 2] = Math.max(0, Math.min(255, result[i + 2] + noise));
      }
      break;
    }
    case "style-anime": {
      for (let i = 0; i < result.length; i += 4) {
        // Posterize to 6 levels and boost saturation
        const [h, s, l] = rgbToHsl(result[i], result[i + 1], result[i + 2]);
        const posterL = Math.round(l * 6) / 6;
        const [nr, ng, nb] = hslToRgb(h, Math.min(1, s * 1.4), posterL);
        result[i] = nr;
        result[i + 1] = ng;
        result[i + 2] = nb;
      }
      break;
    }
    case "style-neon-glow": {
      for (let i = 0; i < result.length; i += 4) {
        result[i] = Math.min(255, result[i] * 1.2 + 40);
        result[i + 1] = Math.min(255, result[i + 1] * 0.8);
        result[i + 2] = Math.min(255, result[i + 2] * 1.4 + 60);
      }
      break;
    }
    case "style-watercolor": {
      for (let i = 0; i < result.length; i += 4) {
        // Soften colours and reduce contrast
        result[i] = Math.min(255, Math.round(result[i] * 0.85 + 38));
        result[i + 1] = Math.min(255, Math.round(result[i + 1] * 0.85 + 38));
        result[i + 2] = Math.min(255, Math.round(result[i + 2] * 0.9 + 25));
      }
      break;
    }
    default:
      // No-op for unknown styles
      break;
  }

  return { data: result, width: w, height: h };
}

// ── Queue implementation ──────────────────────────────────────────────────

const MAX_CONCURRENCY = 2;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

export class AIEditService {
  private queue: AIJob[] = [];
  private running: Map<string, AIJob> = new Map();
  private progressCallbacks: Map<string, ProgressCallback[]> = new Map();
  private completionCallbacks: Map<string, CompletionCallback[]> = new Map();
  private globalProgressCallbacks: ProgressCallback[] = [];
  private globalCompletionCallbacks: CompletionCallback[] = [];
  private idCounter = 0;

  // ── Job management ─────────────────────────────────────────────────────

  /** Subscribe to progress events for a specific job. */
  onProgress(jobId: string, cb: ProgressCallback): () => void {
    if (!this.progressCallbacks.has(jobId)) {
      this.progressCallbacks.set(jobId, []);
    }
    this.progressCallbacks.get(jobId)!.push(cb);
    return () => {
      const cbs = this.progressCallbacks.get(jobId);
      if (cbs) {
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
      }
    };
  }

  /** Subscribe to completion events for a specific job. */
  onComplete(jobId: string, cb: CompletionCallback): () => void {
    if (!this.completionCallbacks.has(jobId)) {
      this.completionCallbacks.set(jobId, []);
    }
    this.completionCallbacks.get(jobId)!.push(cb);
    return () => {
      const cbs = this.completionCallbacks.get(jobId);
      if (cbs) {
        const idx = cbs.indexOf(cb);
        if (idx >= 0) cbs.splice(idx, 1);
      }
    };
  }

  /** Subscribe to progress events for all jobs. */
  onAnyProgress(cb: ProgressCallback): () => void {
    this.globalProgressCallbacks.push(cb);
    return () => {
      const idx = this.globalProgressCallbacks.indexOf(cb);
      if (idx >= 0) this.globalProgressCallbacks.splice(idx, 1);
    };
  }

  /** Subscribe to completion events for all jobs. */
  onAnyComplete(cb: CompletionCallback): () => void {
    this.globalCompletionCallbacks.push(cb);
    return () => {
      const idx = this.globalCompletionCallbacks.indexOf(cb);
      if (idx >= 0) this.globalCompletionCallbacks.splice(idx, 1);
    };
  }

  /** Cancel a job by ID. */
  cancel(jobId: string): boolean {
    const queued = this.queue.findIndex((j) => j.id === jobId);
    if (queued >= 0) {
      const [job] = this.queue.splice(queued, 1);
      job.status = "CANCELLED";
      job.abortController.abort();
      this.notifyCompletion(jobId, null);
      return true;
    }
    const running = this.running.get(jobId);
    if (running) {
      running.abortController.abort();
      return true;
    }
    return false;
  }

  /** Cancel all pending jobs. */
  cancelAll(): void {
    for (const job of this.queue) {
      job.status = "CANCELLED";
      job.abortController.abort();
      this.notifyCompletion(job.id, null);
    }
    this.queue = [];
    for (const job of this.running.values()) {
      job.abortController.abort();
    }
  }

  /** Get the current queue snapshot. */
  getQueue(): ReadonlyArray<Readonly<AIJob>> {
    return [...this.queue, ...this.running.values()];
  }

  /** Get a single job by ID. */
  getJob(jobId: string): Readonly<AIJob> | null {
    const queued = this.queue.find((j) => j.id === jobId);
    if (queued) return queued;
    return this.running.get(jobId) ?? null;
  }

  // ── Public operations ──────────────────────────────────────────────────

  /**
   * Remove background from a single frame.
   * Returns a job ID; subscribe with onComplete() or onProgress() for results.
   */
  removeBackground(
    frameData: FrameData,
    priority = 5,
  ): string {
    return this.enqueue({
      type: "REMOVE_BACKGROUND",
      priority,
      runner: async (job) => {
        this.updateProgress(job.id, 10);
        const matte = generateAlphaMatte(frameData);
        this.updateProgress(job.id, 70);
        const composited = compositeWithMatte(frameData, matte);
        this.updateProgress(job.id, 100);
        return {
          type: "REMOVE_BACKGROUND" as const,
          result: { matte, composited },
        };
      },
    });
  }

  /**
   * Inpaint a masked region of a frame based on a text prompt.
   */
  generativeFill(
    frameData: FrameData,
    mask: Uint8ClampedArray,
    prompt: string,
    priority = 5,
  ): string {
    return this.enqueue({
      type: "GENERATIVE_FILL",
      priority,
      runner: async (job) => {
        this.updateProgress(job.id, 20);
        // Production: send to diffusion model inference endpoint
        // Stub: neighbourhood fill
        void prompt; // used by production ML model
        const filled = applyGenerativeFillMask(frameData, mask);
        this.updateProgress(job.id, 100);
        return {
          type: "GENERATIVE_FILL" as const,
          result: { frame: filled },
        };
      },
    });
  }

  /**
   * Apply an artistic style to a frame.
   */
  styleTransfer(
    frameData: FrameData,
    styleId: string,
    priority = 5,
  ): string {
    if (!STYLE_LIBRARY[styleId]) {
      throw new Error(`Unknown style: ${styleId}`);
    }
    return this.enqueue({
      type: "STYLE_TRANSFER",
      priority,
      runner: async (job) => {
        this.updateProgress(job.id, 30);
        const styled = applyStyleTransferEffect(frameData, styleId);
        this.updateProgress(job.id, 100);
        return {
          type: "STYLE_TRANSFER" as const,
          result: { frame: styled, styleId },
        };
      },
    });
  }

  /**
   * AI super-resolution upscale (2x or 4x).
   * Stub uses bilinear interpolation; production uses ESRGAN/Real-ESRGAN.
   */
  upscale(
    frameData: FrameData,
    factor: 2 | 4,
    priority = 5,
  ): string {
    if (factor !== 2 && factor !== 4) {
      throw new Error("Upscale factor must be 2 or 4");
    }
    return this.enqueue({
      type: "UPSCALE",
      priority,
      runner: async (job) => {
        this.updateProgress(job.id, 20);
        // 4x = two passes of 2x for better quality with bilinear
        let upscaled: FrameData;
        if (factor === 4) {
          this.updateProgress(job.id, 30);
          const pass1 = bilinearUpscale(frameData, 2);
          this.updateProgress(job.id, 60);
          upscaled = bilinearUpscale(pass1, 2);
        } else {
          upscaled = bilinearUpscale(frameData, 2);
        }
        this.updateProgress(job.id, 100);
        return {
          type: "UPSCALE" as const,
          result: { frame: upscaled, factor },
        };
      },
    });
  }

  /**
   * Automatic colour grading and correction.
   */
  autoColor(
    frameData: FrameData,
    priority = 5,
  ): string {
    return this.enqueue({
      type: "AUTO_COLOR",
      priority,
      runner: async (job) => {
        this.updateProgress(job.id, 10);

        const hist = computeLuminanceHistogram(frameData);
        const totalPixels = frameData.width * frameData.height;
        const { mean, stddev } = luminanceStats(hist, totalPixels);

        // Auto-correct parameters
        const targetMean = 128;
        const brightness = (targetMean - mean) / 255;
        const contrastFactor = stddev > 60 ? 1.0 : stddev < 30 ? 1.3 : 1.1;
        const saturation = 1.1;
        const temperature = mean > 140 ? -0.2 : mean < 100 ? 0.2 : 0;
        const tint = 0;
        const highlights = mean > 150 ? -0.15 : 0;
        const shadows = mean < 80 ? 0.1 : 0;

        this.updateProgress(job.id, 50);

        const corrected = applyToneCurve(
          frameData.data,
          brightness,
          contrastFactor,
          saturation,
          temperature,
          tint,
          highlights,
          shadows,
        );

        this.updateProgress(job.id, 100);

        return {
          type: "AUTO_COLOR" as const,
          result: {
            frame: { data: corrected, width: frameData.width, height: frameData.height },
            corrections: {
              brightness,
              contrast: contrastFactor,
              saturation,
              temperature,
              tint,
              highlights,
              shadows,
            },
          },
        };
      },
    });
  }

  // ── Batch processing ──────────────────────────────────────────────────

  /**
   * Apply removeBackground to a contiguous range of frames.
   * @param frames    Array of decoded frame data
   * @param onBatchProgress  Called with (completedCount, totalCount)
   */
  batchRemoveBackground(
    frames: FrameData[],
    onBatchProgress?: (done: number, total: number) => void,
  ): string[] {
    return this.batchProcess(
      frames,
      (frame, idx) =>
        this.removeBackground(frame, 5 + idx),
      onBatchProgress,
    );
  }

  /**
   * Apply styleTransfer to a contiguous range of frames.
   */
  batchStyleTransfer(
    frames: FrameData[],
    styleId: string,
    onBatchProgress?: (done: number, total: number) => void,
  ): string[] {
    return this.batchProcess(
      frames,
      (frame, idx) =>
        this.styleTransfer(frame, styleId, 5 + idx),
      onBatchProgress,
    );
  }

  /**
   * Apply upscale to a contiguous range of frames.
   */
  batchUpscale(
    frames: FrameData[],
    factor: 2 | 4,
    onBatchProgress?: (done: number, total: number) => void,
  ): string[] {
    return this.batchProcess(
      frames,
      (frame, idx) =>
        this.upscale(frame, factor, 5 + idx),
      onBatchProgress,
    );
  }

  /**
   * Apply autoColor to a contiguous range of frames.
   */
  batchAutoColor(
    frames: FrameData[],
    onBatchProgress?: (done: number, total: number) => void,
  ): string[] {
    return this.batchProcess(
      frames,
      (frame, idx) =>
        this.autoColor(frame, 5 + idx),
      onBatchProgress,
    );
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private batchProcess(
    frames: FrameData[],
    enqueueOne: (frame: FrameData, idx: number) => string,
    onBatchProgress?: (done: number, total: number) => void,
  ): string[] {
    const ids: string[] = [];
    let done = 0;
    const total = frames.length;

    for (let i = 0; i < frames.length; i++) {
      const jobId = enqueueOne(frames[i], i);
      ids.push(jobId);
      if (onBatchProgress) {
        this.onComplete(jobId, () => {
          done++;
          onBatchProgress(done, total);
        });
      }
    }

    return ids;
  }

  private generateId(): string {
    return `ai-job-${Date.now()}-${++this.idCounter}`;
  }

  private enqueue(opts: {
    type: AIOperationType;
    priority: number;
    runner: (job: AIJob) => Promise<AIOperationResult>;
  }): string {
    const id = this.generateId();
    const job: AIJob = {
      id,
      type: opts.type,
      status: "PENDING",
      priority: opts.priority,
      progress: 0,
      createdAt: Date.now(),
      retries: 0,
      maxRetries: MAX_RETRIES,
      abortController: new AbortController(),
    };

    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority);

    // Attach runner to job (non-enumerable so it's not serialised)
    Object.defineProperty(job, "__runner", {
      value: opts.runner,
      enumerable: false,
      writable: true,
    });

    void this.drain();
    return id;
  }

  private async drain(): Promise<void> {
    while (this.running.size < MAX_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running.set(job.id, job);
      void this.runJob(job);
    }
  }

  private async runJob(job: AIJob): Promise<void> {
    job.status = "RUNNING";
    job.startedAt = Date.now();

    const runner = (
      job as AIJob & { __runner?: (j: AIJob) => Promise<AIOperationResult> }
    ).__runner;

    if (!runner) {
      this.handleJobError(job, new Error("No runner attached to job"));
      return;
    }

    try {
      const result = await runner(job);

      if (job.abortController.signal.aborted) {
        job.status = "CANCELLED";
        this.running.delete(job.id);
        this.notifyCompletion(job.id, null);
        await this.drain();
        return;
      }

      job.status = "DONE";
      job.result = result;
      job.finishedAt = Date.now();
      this.running.delete(job.id);
      this.notifyCompletion(job.id, result);
    } catch (err) {
      if (job.abortController.signal.aborted) {
        job.status = "CANCELLED";
        this.running.delete(job.id);
        this.notifyCompletion(job.id, null);
        await this.drain();
        return;
      }
      this.handleJobError(job, err instanceof Error ? err : new Error(String(err)));
    }

    await this.drain();
  }

  private handleJobError(job: AIJob, error: Error): void {
    if (job.retries < job.maxRetries) {
      job.retries++;
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, job.retries - 1);
      job.status = "PENDING";
      job.progress = 0;
      this.running.delete(job.id);

      setTimeout(() => {
        if (!job.abortController.signal.aborted) {
          this.queue.unshift(job); // re-insert at front
          void this.drain();
        }
      }, delay);
    } else {
      job.status = "FAILED";
      job.errorMessage = error.message;
      job.finishedAt = Date.now();
      this.running.delete(job.id);
      this.notifyCompletion(job.id, null, error);
    }
  }

  private updateProgress(jobId: string, progress: number): void {
    const job = this.running.get(jobId);
    if (job) job.progress = progress;
    this.notifyProgress(jobId, progress);
  }

  private notifyProgress(jobId: string, progress: number): void {
    const cbs = this.progressCallbacks.get(jobId);
    if (cbs) {
      for (const cb of cbs) cb(jobId, progress);
    }
    for (const cb of this.globalProgressCallbacks) cb(jobId, progress);
  }

  private notifyCompletion(
    jobId: string,
    result: AIOperationResult | null,
    error?: Error,
  ): void {
    const cbs = this.completionCallbacks.get(jobId);
    if (cbs) {
      for (const cb of cbs) cb(jobId, result, error);
    }
    for (const cb of this.globalCompletionCallbacks) cb(jobId, result, error);
    this.progressCallbacks.delete(jobId);
    this.completionCallbacks.delete(jobId);
  }
}

/** Singleton instance for app-wide use */
export const aiEditService = new AIEditService();
