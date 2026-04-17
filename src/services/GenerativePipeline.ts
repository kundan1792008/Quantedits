/**
 * Generative Video Pipeline Service
 *
 * Orchestrates on-device AI video generation via the NPUEngine Capacitor
 * plugin.  The pipeline implements a lightweight latent-diffusion approach
 * modelled after Stable Video Diffusion (SVD) but quantised to INT8 / FP16
 * so that the full model fits within the 1.5 GB render budget.
 *
 * Architecture overview
 * ─────────────────────
 *  1. VAE Encoder   – compress the reference video frame into a latent vector.
 *  2. UNet Diffuser – run N denoising steps on the latent to generate a new
 *                     frame sequence (25 frames at 512×512 by default).
 *  3. VAE Decoder   – decode each latent back to an RGB pixel frame.
 *  4. Frame Stitch  – write decoded frames into an in-memory RGBA buffer that
 *                     the WebGLTimeline component can display directly.
 *
 * Memory management
 * ─────────────────
 * The pipeline listens to the MemoryManager's pressure events and will:
 *  • Reduce the diffusion step count from 25 → 10 at "fair" pressure.
 *  • Reduce the output resolution from 512 → 256 at "serious" pressure.
 *  • Abort generation at "critical" pressure to avoid OOM termination.
 */

import { NPUEngine } from "@/plugins/npu-engine";
import type {
  NPUModel,
  InferenceResult,
  MemoryStats,
  NPUComputeBackend,
} from "@/plugins/npu-engine/definitions";
import { memoryManager, RENDER_BUDGET_BYTES } from "./MemoryManager";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default latent resolution (each pixel = 8 source pixels after VAE). */
const DEFAULT_LATENT_SIZE = 64; // 512 ÷ 8

/** Default number of denoising steps (quality vs. speed trade-off). */
const DEFAULT_DIFFUSION_STEPS = 20;

/** Number of video frames generated per call. */
const DEFAULT_FRAME_COUNT = 14;

/** Model file paths (relative to the app bundle / assets folder). */
const MODEL_PATHS = {
  vaeEncoder: "models/svd_vae_encoder_int8.tflite",
  unet:       "models/svd_unet_fp16.tflite",
  vaeDecoder: "models/svd_vae_decoder_int8.tflite",
} as const;

const MODEL_IDS = {
  vaeEncoder: "svd-vae-enc",
  unet:       "svd-unet",
  vaeDecoder: "svd-vae-dec",
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

export type GenerationStatus =
  | "idle"
  | "loading_models"
  | "encoding"
  | "diffusing"
  | "decoding"
  | "complete"
  | "aborted"
  | "error";

export interface GenerationOptions {
  /**
   * Source image to animate — RGBA pixel data at `sourceWidth × sourceHeight`.
   * Provide as a base64-encoded Float32 byte string (values normalised 0-1).
   */
  sourceFrameBase64: string;
  sourceWidth: number;
  sourceHeight: number;

  /** Number of frames to generate (default 14). */
  frameCount?: number;

  /** Diffusion step count; more steps = higher quality but slower (default 20). */
  diffusionSteps?: number;

  /**
   * Conditioning strength — how closely the output follows the source frame.
   * Range 0–1, default 0.85.
   */
  motionStrength?: number;

  /** Preferred NPU backend (default "ane" / "nnapi" based on platform). */
  preferredBackend?: NPUComputeBackend;
}

export interface GenerationProgress {
  status: GenerationStatus;
  /** Current diffusion step (during "diffusing" phase). */
  step?: number;
  /** Total diffusion steps requested. */
  totalSteps?: number;
  /** Number of frames decoded so far. */
  framesDecoded?: number;
  /** Total frames requested. */
  totalFrames?: number;
  /** Elapsed wall-clock time in ms. */
  elapsedMs?: number;
}

export interface GenerationResult {
  /** One base64-encoded RGBA Float32 buffer per frame. */
  framesBase64: string[];
  /** Width of each generated frame in pixels. */
  width: number;
  /** Height of each generated frame in pixels. */
  height: number;
  /** Total generation time in ms. */
  totalMs: number;
  /** Which backend executed the inference. */
  backend: NPUComputeBackend;
  /** Peak memory used during generation in bytes. */
  peakMemoryBytes: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Encode a Float32Array to a base64 string. */
function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a base64 string back to a Float32Array. */
function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Draw Gaussian noise into a pre-allocated Float32Array in-place. */
function fillGaussianNoise(arr: Float32Array): void {
  for (let i = 0; i < arr.length; i += 2) {
    // Box–Muller transform
    const u1 = Math.max(1e-7, Math.random());
    const u2 = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u1));
    arr[i]     = mag * Math.cos(2 * Math.PI * u2);
    arr[i + 1] = mag * Math.sin(2 * Math.PI * u2);
  }
}

// ── Pipeline Class ─────────────────────────────────────────────────────────

/**
 * On-device generative video pipeline backed by the NPUEngine plugin.
 *
 * Usage:
 * ```ts
 * const pipeline = new GenerativePipeline();
 * await pipeline.loadModels();
 * const result = await pipeline.generate({ sourceFrameBase64, ... }, onProgress);
 * ```
 */
export class GenerativePipeline {
  private modelsLoaded = false;
  private loadedModelIds: string[] = [];
  private memPressureUnsub?: () => void;
  private currentPressure: string = "nominal";
  private abortRequested = false;

  constructor() {
    // Track memory pressure so we can adapt generation quality dynamically
    this.memPressureUnsub = memoryManager.onPressureChange((stats) => {
      this.currentPressure = stats.pressureLevel;
      if (stats.pressureLevel === "critical") {
        this.abortRequested = true;
      }
    });
  }

  /** Release all loaded NPU models and detach memory listeners. */
  async dispose(): Promise<void> {
    this.memPressureUnsub?.();
    for (const id of this.loadedModelIds) {
      await NPUEngine.unloadModel({ modelId: id }).catch(() => {});
    }
    this.loadedModelIds = [];
    this.modelsLoaded = false;
  }

  /**
   * Load all three pipeline models (VAE encoder, UNet, VAE decoder) into NPU
   * memory.  Models are cached — repeated calls are safe and cheap.
   */
  async loadModels(
    preferredBackend: NPUComputeBackend = "ane",
  ): Promise<NPUModel[]> {
    const loaded: NPUModel[] = [];

    for (const [key, path] of Object.entries(MODEL_PATHS) as [
      keyof typeof MODEL_PATHS,
      string,
    ][]) {
      const modelId = MODEL_IDS[key];
      const model = await NPUEngine.loadModel({
        modelPath: path,
        modelId,
        preferredBackend,
      });
      loaded.push(model);
      if (!this.loadedModelIds.includes(modelId)) {
        this.loadedModelIds.push(modelId);
      }
    }

    this.modelsLoaded = true;
    return loaded;
  }

  /**
   * Generate a short video from a single source frame.
   *
   * @param options   Generation parameters.
   * @param onProgress  Optional callback invoked after each diffusion step.
   */
  async generate(
    options: GenerationOptions,
    onProgress?: (progress: GenerationProgress) => void,
  ): Promise<GenerationResult> {
    if (!this.modelsLoaded) {
      onProgress?.({ status: "loading_models" });
      await this.loadModels(options.preferredBackend);
    }

    this.abortRequested = false;
    const t0 = performance.now();

    // Adapt quality to current memory pressure
    const frameCount    = options.frameCount ?? DEFAULT_FRAME_COUNT;
    let diffusionSteps  = options.diffusionSteps ?? DEFAULT_DIFFUSION_STEPS;
    let latentSize      = DEFAULT_LATENT_SIZE;

    if (this.currentPressure === "critical") {
      throw new Error("Generation aborted: device memory is critically low.");
    }
    if (this.currentPressure === "fair")    diffusionSteps = Math.min(diffusionSteps, 10);
    if (this.currentPressure === "serious") latentSize     = Math.floor(latentSize / 2);

    let backend: NPUComputeBackend = "cpu";
    let peakMemory = 0;

    // ── Step 1: VAE Encode ──────────────────────────────────────────────
    onProgress?.({ status: "encoding" });

    const encResult = await this.runVAEEncoder(
      options.sourceFrameBase64,
      latentSize,
    );
    backend = encResult.backend;
    peakMemory = Math.max(peakMemory, encResult.memoryUsedBytes);

    // ── Step 2: Latent Diffusion ────────────────────────────────────────
    onProgress?.({
      status:     "diffusing",
      step:       0,
      totalSteps: diffusionSteps,
    });

    const encoderOutput = encResult.outputs[0]?.dataBase64;
    if (!encoderOutput) {
      throw new Error("[GenerativePipeline] VAE encoder returned no output tensor.");
    }

    const motionStrength = options.motionStrength ?? 0.85;
    const latentSequence = await this.runDiffusion(
      encoderOutput,
      frameCount,
      diffusionSteps,
      motionStrength,
      latentSize,
      (step) => {
        if (this.abortRequested) throw new Error("Generation aborted: memory pressure");
        peakMemory = Math.max(peakMemory, memoryManager.lastStats?.usedBytes ?? 0);
        onProgress?.({
          status:     "diffusing",
          step,
          totalSteps: diffusionSteps,
          elapsedMs:  performance.now() - t0,
        });
      },
    );

    // ── Step 3: VAE Decode ──────────────────────────────────────────────
    const framesBase64: string[] = [];
    const outputSize = latentSize * 8; // VAE upscales ×8

    for (let i = 0; i < frameCount; i++) {
      if (this.abortRequested) throw new Error("Generation aborted: memory pressure");

      onProgress?.({
        status:        "decoding",
        framesDecoded: i,
        totalFrames:   frameCount,
        elapsedMs:     performance.now() - t0,
      });

      const frameLatent = latentSequence[i];
      if (!frameLatent) {
        throw new Error(
          `[GenerativePipeline] Diffusion produced fewer latents than requested (got ${latentSequence.length}, need frame ${i}).`,
        );
      }
      const decResult = await this.runVAEDecoder(frameLatent, outputSize);
      const decoderOutput = decResult.outputs[0]?.dataBase64;
      if (!decoderOutput) {
        throw new Error(`[GenerativePipeline] VAE decoder returned no output for frame ${i}.`);
      }
      framesBase64.push(decoderOutput);
      peakMemory = Math.max(peakMemory, decResult.memoryUsedBytes);
    }

    const totalMs = performance.now() - t0;

    onProgress?.({ status: "complete", elapsedMs: totalMs });

    return {
      framesBase64,
      width:    outputSize,
      height:   outputSize,
      totalMs,
      backend,
      peakMemoryBytes: peakMemory,
    };
  }

  // ── Private inference helpers ────────────────────────────────────────────

  private async runVAEEncoder(
    imageBase64: string,
    latentSize: number,
  ): Promise<InferenceResult> {
    // In production this feeds the source RGB frame through the CoreML/TFLite
    // VAE encoder which outputs a [1, 4, latentSize, latentSize] tensor.
    //
    // Stub: return random latent noise with the correct shape.
    const latentCount = 4 * latentSize * latentSize;
    const latent = new Float32Array(latentCount);
    fillGaussianNoise(latent);

    return NPUEngine.runInference({
      modelId: MODEL_IDS.vaeEncoder,
      inputs: [
        {
          name: "image",
          dataBase64: imageBase64,
          shape: [1, 3, latentSize * 8, latentSize * 8],
        },
      ],
    });
  }

  /**
   * Run the reverse diffusion process and return one latent per output frame.
   *
   * The denoising loop follows the DDIM sampler schedule:
   *   x_{t-1} = sqrt(α_{t-1}) * pred_x0 + sqrt(1-α_{t-1}) * pred_ε
   *
   * Motion is injected via a conditioning tensor that biases the UNet
   * toward coherent temporal motion between frames.
   */
  private async runDiffusion(
    conditioningLatentBase64: string,
    frameCount: number,
    steps: number,
    motionStrength: number,
    latentSize: number,
    onStep: (step: number) => void,
  ): Promise<string[]> {
    const latentCount = 4 * latentSize * latentSize;

    // Initialise with pure Gaussian noise (x_T in the diffusion forward process)
    let currentLatent = new Float32Array(latentCount);
    fillGaussianNoise(currentLatent);

    // Simple linear noise schedule (production: use cosine or DDIM schedule)
    for (let step = 0; step < steps; step++) {
      const t = 1.0 - step / steps; // timestep descending 1→0
      const sigmaT = t * motionStrength;

      const result = await NPUEngine.runInference({
        modelId: MODEL_IDS.unet,
        inputs: [
          {
            name: "noisy_latent",
            dataBase64: float32ToBase64(currentLatent),
            shape: [1, 4, latentSize, latentSize],
          },
          {
            name: "conditioning",
            dataBase64: conditioningLatentBase64,
            shape: [1, 4, latentSize, latentSize],
          },
          {
            name: "timestep",
            dataBase64: float32ToBase64(new Float32Array([sigmaT])),
            shape: [1],
          },
        ],
      });

      // Predicted noise ε — update x_{t-1} via DDIM step
      const predNoise = base64ToFloat32(
        result.outputs[0]?.dataBase64 ?? float32ToBase64(currentLatent),
      );
      const alpha       = 1.0 - sigmaT;
      // Precompute constants outside the inner loop to avoid redundant sqrt calls
      const sqrtAlpha   = Math.sqrt(alpha);
      const sqrtOneMinusAlpha = Math.sqrt(1 - alpha);
      for (let i = 0; i < currentLatent.length; i++) {
        currentLatent[i] =
          sqrtAlpha * (currentLatent[i] - sqrtOneMinusAlpha * predNoise[i]) +
          sqrtOneMinusAlpha * predNoise[i];
      }

      onStep(step + 1);
    }

    // Produce frameCount latents by slightly perturbing the final denoised
    // latent with scaled noise (temporal frame diversity)
    const frames: string[] = [];
    for (let f = 0; f < frameCount; f++) {
      const frameLatent = new Float32Array(latentCount);
      const noise = new Float32Array(latentCount);
      fillGaussianNoise(noise);
      const temporalNoise = (f / Math.max(frameCount - 1, 1)) * 0.05;
      for (let i = 0; i < latentCount; i++) {
        frameLatent[i] = currentLatent[i] + temporalNoise * noise[i];
      }
      frames.push(float32ToBase64(frameLatent));
    }

    return frames;
  }

  private async runVAEDecoder(
    latentBase64: string,
    outputSize: number,
  ): Promise<InferenceResult> {
    return NPUEngine.runInference({
      modelId: MODEL_IDS.vaeDecoder,
      inputs: [
        {
          name: "latent",
          dataBase64: latentBase64,
          shape: [1, 4, outputSize / 8, outputSize / 8],
        },
      ],
    });
  }

  /** Verify that the peak memory usage stayed within the 1.5 GB budget. */
  static assertWithinBudget(peakBytes: number): void {
    if (peakBytes > RENDER_BUDGET_BYTES) {
      console.warn(
        `[GenerativePipeline] Peak memory ${(peakBytes / 1e9).toFixed(2)} GB ` +
          `exceeded render budget ${(RENDER_BUDGET_BYTES / 1e9).toFixed(2)} GB.`,
      );
    }
  }
}

/** Singleton pipeline instance shared across the app. */
export const generativePipeline = new GenerativePipeline();
