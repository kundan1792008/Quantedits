/**
 * Type definitions for the NPUEngine Capacitor plugin.
 *
 * Interfaces directly with Apple Neural Engine (CoreML) on iOS and Android
 * NNAPI (via TensorFlow Lite NNAPI delegate) on Android to run on-device
 * AI inference for generative video without cloud round-trips.
 */

/** The compute backend that will execute inference. */
export type NPUComputeBackend =
  | "ane"      // Apple Neural Engine (iOS only)
  | "nnapi"    // Android Neural Networks API
  | "gpu"      // GPU Metal / OpenGL ES
  | "cpu";     // Fallback CPU

/** Current memory pressure state reported by the OS. */
export type MemoryPressureLevel = "nominal" | "fair" | "serious" | "critical";

/** A named CoreML / TFLite model registered in the plugin. */
export interface NPUModel {
  /** Stable identifier used in all subsequent calls. */
  modelId: string;
  /** Human-readable display name. */
  name: string;
  /** Which compute backend will execute this model. */
  backend: NPUComputeBackend;
  /** Whether the model is currently loaded in memory. */
  loaded: boolean;
  /** Compiled model size in bytes (0 if not yet loaded). */
  modelSizeBytes: number;
}

/** Options for loading an NPU model. */
export interface LoadModelOptions {
  /**
   * Path to the CoreML `.mlpackage` / `.mlmodelc` (iOS) or TFLite `.tflite`
   * (Android) file, relative to the app bundle.
   */
  modelPath: string;
  /** Stable identifier; reuse this to run inference without reloading. */
  modelId: string;
  /**
   * Preferred compute backend.
   * Falls back to CPU if the requested backend is unavailable.
   */
  preferredBackend?: NPUComputeBackend;
}

/** A single named tensor input for inference. */
export interface NPUTensorInput {
  /** Feature name matching the model's input feature description. */
  name: string;
  /**
   * Flat Float32 array of pixel values (NCHW or NHWC, model-dependent).
   * Serialised as a base64-encoded Float32 little-endian byte string.
   */
  dataBase64: string;
  /** Shape of the tensor, e.g. [1, 3, 512, 512] for a single RGB image. */
  shape: number[];
}

/** Options for a single inference pass. */
export interface RunInferenceOptions {
  /** Model to use – must have been loaded with `loadModel` first. */
  modelId: string;
  /** Input tensors keyed by feature name. */
  inputs: NPUTensorInput[];
}

/** A single named tensor output from inference. */
export interface NPUTensorOutput {
  /** Feature name matching the model's output feature description. */
  name: string;
  /**
   * Flat Float32 array encoded as base64 little-endian bytes.
   * Decode with Float32Array + atob on the JavaScript side.
   */
  dataBase64: string;
  /** Shape of the output tensor. */
  shape: number[];
}

/** Result from a single inference pass. */
export interface InferenceResult {
  /** Mirror of the requested modelId. */
  modelId: string;
  /** All output tensors produced by the model. */
  outputs: NPUTensorOutput[];
  /** Wall-clock inference latency in milliseconds. */
  latencyMs: number;
  /** Which backend actually executed the inference. */
  backend: NPUComputeBackend;
  /** Heap used by the model during this pass, in bytes. */
  memoryUsedBytes: number;
}

/** Current device memory stats. */
export interface MemoryStats {
  /** Total physical RAM in bytes. */
  totalBytes: number;
  /** RAM currently in use by this process in bytes. */
  usedBytes: number;
  /** RAM available to this process in bytes. */
  availableBytes: number;
  /** OS-level memory pressure signal. */
  pressureLevel: MemoryPressureLevel;
  /** Sum of all loaded NPU model sizes in bytes. */
  npuModelBytes: number;
}

/** Plugin interface exposed to the web layer. */
export interface NPUEnginePlugin {
  /**
   * Load a CoreML / TFLite model and compile it for the target backend.
   * Models are cached; calling loadModel again with the same modelId is
   * a no-op unless the previous load failed.
   */
  loadModel(options: LoadModelOptions): Promise<NPUModel>;

  /**
   * Run a single forward pass through the specified model.
   * Throws if the model is not loaded or inputs are malformed.
   */
  runInference(options: RunInferenceOptions): Promise<InferenceResult>;

  /**
   * Unload a model from NPU memory to free resources.
   * Silently succeeds if the modelId is unknown.
   */
  unloadModel(options: { modelId: string }): Promise<void>;

  /**
   * Return current device memory stats including NPU model usage.
   * Use this to stay within the 1.5 GB rendering budget.
   */
  getMemoryStats(): Promise<MemoryStats>;

  /**
   * List all currently loaded models and their memory usage.
   */
  listLoadedModels(): Promise<{ models: NPUModel[] }>;

  /**
   * Register a listener that fires whenever the OS memory-pressure level
   * changes (nominal → fair → serious → critical).
   */
  addListener(
    eventName: "memoryPressureChanged",
    callback: (stats: MemoryStats) => void,
  ): Promise<{ remove: () => void }>;

  /**
   * Register a listener for per-inference telemetry events.
   * Useful for profiling latency and memory in development.
   */
  addListener(
    eventName: "inferenceComplete",
    callback: (result: InferenceResult) => void,
  ): Promise<{ remove: () => void }>;
}
