/**
 * Web fallback implementation of the NPUEngine plugin.
 *
 * On the web there is no CoreML or NNAPI. Instead we provide a graceful
 * degradation using the WebAssembly SIMD path (where supported) so that
 * development / CI workflows can exercise the full pipeline without a device.
 *
 * All inference is executed on the main thread via a synchronous Float32
 * identity pass — replace with an actual ONNX-Runtime Web or WASM TFLite
 * build for true web inference.
 */

import { WebPlugin } from "@capacitor/core";
import type {
  NPUEnginePlugin,
  LoadModelOptions,
  NPUModel,
  RunInferenceOptions,
  InferenceResult,
  MemoryStats,
  NPUTensorOutput,
} from "./definitions";

export class NPUEngineWeb extends WebPlugin implements NPUEnginePlugin {
  private loadedModels = new Map<string, NPUModel>();

  async loadModel(options: LoadModelOptions): Promise<NPUModel> {
    const { modelId, modelPath, preferredBackend = "cpu" } = options;

    // Return cached model if already loaded
    const existing = this.loadedModels.get(modelId);
    if (existing?.loaded) return existing;

    console.info(
      `[NPUEngine Web] Loading model "${modelId}" from "${modelPath}" (backend: ${preferredBackend})`,
    );

    // Simulate load latency (replace with actual WASM fetch)
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    const model: NPUModel = {
      modelId,
      name: modelId,
      backend: "cpu", // Web always falls back to CPU
      loaded: true,
      modelSizeBytes: 0,
    };

    this.loadedModels.set(modelId, model);

    console.warn(
      `[NPUEngine Web] Model "${modelId}" loaded on CPU fallback. ` +
        "Deploy to a device for ANE/NNAPI acceleration.",
    );

    return model;
  }

  async runInference(options: RunInferenceOptions): Promise<InferenceResult> {
    const { modelId, inputs } = options;

    const model = this.loadedModels.get(modelId);
    if (!model?.loaded) {
      throw new Error(
        `[NPUEngine Web] Model "${modelId}" is not loaded. Call loadModel first.`,
      );
    }

    const t0 = performance.now();

    // Web stub: pass each input tensor straight through as the output.
    // Replace with actual ONNX-Runtime Web session.run() call.
    const outputs: NPUTensorOutput[] = inputs.map((inp) => ({
      name: inp.name + "_out",
      dataBase64: inp.dataBase64,
      shape: inp.shape,
    }));

    const latencyMs = performance.now() - t0;

    const result: InferenceResult = {
      modelId,
      outputs,
      latencyMs,
      backend: "cpu",
      memoryUsedBytes: 0,
    };

    // Fire inferenceComplete event for telemetry listeners
    this.notifyListeners("inferenceComplete", result);

    return result;
  }

  async unloadModel(options: { modelId: string }): Promise<void> {
    this.loadedModels.delete(options.modelId);
    console.info(`[NPUEngine Web] Model "${options.modelId}" unloaded.`);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    // Use performance.memory when available (Chrome only)
    const mem = (performance as { memory?: { totalJSHeapSize: number; usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;

    const totalBytes = mem?.jsHeapSizeLimit ?? 0;
    const usedBytes = mem?.usedJSHeapSize ?? 0;
    const availableBytes = totalBytes - usedBytes;

    const npuModelBytes = Array.from(this.loadedModels.values()).reduce(
      (sum, m) => sum + m.modelSizeBytes,
      0,
    );

    const pressureRatio = totalBytes > 0 ? usedBytes / totalBytes : 0;

    return {
      totalBytes,
      usedBytes,
      availableBytes,
      npuModelBytes,
      pressureLevel:
        pressureRatio > 0.9
          ? "critical"
          : pressureRatio > 0.75
            ? "serious"
            : pressureRatio > 0.5
              ? "fair"
              : "nominal",
    };
  }

  async listLoadedModels(): Promise<{ models: NPUModel[] }> {
    return { models: Array.from(this.loadedModels.values()) };
  }
}
