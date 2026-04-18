/**
 * NPUEngine Capacitor Plugin
 *
 * Exposes on-device NPU (Apple Neural Engine / Android NNAPI) acceleration
 * to the React/TypeScript layer via a Capacitor bridge.
 *
 * On iOS  → CoreML with .cpuAndNeuralEngine compute units.
 * On Android → TensorFlow Lite with NNAPI delegate.
 * On Web  → WebAssembly SIMD fallback via the NPUEngineWeb class.
 */

import { registerPlugin } from "@capacitor/core";
import type { NPUEnginePlugin } from "./definitions";

const NPUEngine = registerPlugin<NPUEnginePlugin>("NPUEngine", {
  web: () => import("./web").then((m) => new m.NPUEngineWeb()),
});

export * from "./definitions";
export { NPUEngine };
