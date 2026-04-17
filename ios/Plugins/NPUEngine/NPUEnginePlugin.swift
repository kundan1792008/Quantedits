import Foundation
import Capacitor
import CoreML

// MARK: - NPUEngine Capacitor Plugin (iOS – Swift)
//
// Interfaces directly with Apple Neural Engine (ANE) via CoreML.
// On A12 Bionic and later the runtime automatically routes eligible
// operations to the dedicated ANE hardware when computeUnits includes
// .neuralEngine (i.e. .cpuAndNeuralEngine or .all).
//
// Model lifecycle:
//   1. loadModel  – compile the .mlpackage / .mlmodelc and cache the MLModel.
//   2. runInference – build MLFeatureProvider, run prediction, serialise output.
//   3. unloadModel  – remove from cache to free ANE/RAM resources.
//
// Memory pressure events are forwarded to the JavaScript layer via
// Capacitor's notifyListeners() so the GenerativePipeline service can
// shed models before the OS terminates the app.

/// Wraps a loaded CoreML model and its metadata.
private struct LoadedModel {
    let model: MLModel
    let modelId: String
    let name: String
    let backend: String
    let modelSizeBytes: Int
}

@objc(NPUEnginePlugin)
public class NPUEnginePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "NPUEnginePlugin"
    public let jsName = "NPUEngine"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loadModel",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runInference",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unloadModel",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMemoryStats",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listLoadedModels", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - Properties

    private var loadedModels: [String: LoadedModel] = [:]
    private var memoryPressureSource: DispatchSourceMemoryPressure?
    private let queue = DispatchQueue(label: "com.quantedits.npuengine", qos: .userInitiated)

    // MARK: - Lifecycle

    public override func load() {
        super.load()
        registerMemoryPressureHandler()
    }

    // MARK: - Plugin Methods

    /// Load a CoreML model from the app bundle and compile it for the ANE.
    @objc func loadModel(_ call: CAPPluginCall) {
        guard let modelPath = call.getString("modelPath"),
              let modelId   = call.getString("modelId") else {
            call.reject("modelPath and modelId are required")
            return
        }

        let preferredBackend = call.getString("preferredBackend") ?? "ane"

        // Return the cached model if already loaded
        if let existing = loadedModels[modelId] {
            call.resolve(modelToJSObject(existing))
            return
        }

        queue.async { [weak self] in
            guard let self = self else { return }

            do {
                let model = try self.loadCoreMLModel(
                    path: modelPath,
                    backend: preferredBackend
                )

                let sizeBytes = self.approximateModelSize(path: modelPath)
                let loaded = LoadedModel(
                    model: model,
                    modelId: modelId,
                    name: (modelPath as NSString).lastPathComponent,
                    backend: self.activeBackendName(model: model),
                    modelSizeBytes: sizeBytes
                )
                self.loadedModels[modelId] = loaded

                DispatchQueue.main.async {
                    call.resolve(self.modelToJSObject(loaded))
                }
            } catch {
                DispatchQueue.main.async {
                    call.reject("Failed to load model '\(modelId)': \(error.localizedDescription)")
                }
            }
        }
    }

    /// Run a single forward pass through a loaded CoreML model.
    @objc func runInference(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId"),
              let inputsArray = call.getArray("inputs") else {
            call.reject("modelId and inputs are required")
            return
        }

        guard let loaded = loadedModels[modelId] else {
            call.reject("Model '\(modelId)' is not loaded. Call loadModel first.")
            return
        }

        queue.async { [weak self] in
            guard let self = self else { return }

            let t0 = Date()

            do {
                let featureProvider = try self.buildFeatureProvider(from: inputsArray)
                let prediction = try loaded.model.prediction(from: featureProvider)
                let outputs = self.serializeOutputs(prediction: prediction)
                let latencyMs = Date().timeIntervalSince(t0) * 1000
                let memUsed = self.currentProcessMemoryBytes()

                let result = JSObject([
                    "modelId": modelId,
                    "outputs": outputs,
                    "latencyMs": latencyMs,
                    "backend": loaded.backend,
                    "memoryUsedBytes": memUsed,
                ] as [String: Any])

                DispatchQueue.main.async {
                    self.notifyListeners("inferenceComplete", data: result as? [String: Any] ?? [:])
                    call.resolve(result as? [String: Any] ?? [:])
                }
            } catch {
                DispatchQueue.main.async {
                    call.reject("Inference failed for model '\(modelId)': \(error.localizedDescription)")
                }
            }
        }
    }

    /// Unload a model from memory.
    @objc func unloadModel(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId is required")
            return
        }
        loadedModels.removeValue(forKey: modelId)
        call.resolve()
    }

    /// Return current device memory statistics.
    @objc func getMemoryStats(_ call: CAPPluginCall) {
        let stats = buildMemoryStats()
        call.resolve(stats)
    }

    /// List all currently loaded models.
    @objc func listLoadedModels(_ call: CAPPluginCall) {
        let models = loadedModels.values.map { modelToJSObject($0) }
        call.resolve(["models": models])
    }

    // MARK: - CoreML Helpers

    /// Load and compile a CoreML model targeting the specified compute backend.
    private func loadCoreMLModel(path: String, backend: String) throws -> MLModel {
        let config = MLModelConfiguration()

        // Route to Apple Neural Engine when available (A12+)
        switch backend {
        case "ane":
            config.computeUnits = .cpuAndNeuralEngine
        case "gpu":
            config.computeUnits = .cpuAndGPU
        case "cpu":
            config.computeUnits = .cpuOnly
        default:
            // "all" lets CoreML pick the best available hardware
            config.computeUnits = .all
        }

        // Resolve the path: check the app bundle first, then the documents dir
        let fileURL: URL
        if let bundleURL = Bundle.main.url(forResource: path, withExtension: nil) {
            fileURL = bundleURL
        } else if let bundleURL = Bundle.main.url(
            forResource: (path as NSString).deletingPathExtension,
            withExtension: (path as NSString).pathExtension
        ) {
            fileURL = bundleURL
        } else {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            fileURL = docs.appendingPathComponent(path)
        }

        // Compile if we were given a .mlpackage (source form)
        if fileURL.pathExtension == "mlpackage" {
            let compiledURL = try MLModel.compileModel(at: fileURL)
            return try MLModel(contentsOf: compiledURL, configuration: config)
        }

        return try MLModel(contentsOf: fileURL, configuration: config)
    }

    /// Build an MLFeatureProvider from the JS inputs array.
    private func buildFeatureProvider(from inputsArray: JSArray) throws -> MLFeatureProvider {
        var features: [String: MLFeatureValue] = [:]

        for i in 0 ..< inputsArray.count() {
            guard let inputDict = inputsArray[i] as? [String: Any],
                  let name       = inputDict["name"] as? String,
                  let dataB64    = inputDict["dataBase64"] as? String,
                  let shapeArray = inputDict["shape"] as? [Int],
                  let data       = Data(base64Encoded: dataB64)
            else { continue }

            // Rebuild NSArray<NSNumber> for the shape
            let nsShape = shapeArray.map { NSNumber(value: $0) }

            // Build MLMultiArray from raw Float32 bytes using dataPointer
            // to avoid per-element NSNumber boxing overhead.
            let count = shapeArray.reduce(1, *)
            let multiArray = try MLMultiArray(shape: nsShape as [NSNumber], dataType: .float32)

            var copyError: Error? = nil
            data.withUnsafeBytes { (ptr: UnsafeRawBufferPointer) in
                guard let src = ptr.baseAddress else {
                    copyError = NSError(
                        domain: "NPUEngine",
                        code: 3,
                        userInfo: [NSLocalizedDescriptionKey: "Tensor data base address is nil for input '\(name)'"]
                    )
                    return
                }
                let dst = multiArray.dataPointer
                let byteCount = min(count * MemoryLayout<Float32>.size, data.count)
                memcpy(dst, src, byteCount)
            }
            if let err = copyError { throw err }

            features[name] = MLFeatureValue(multiArray: multiArray)
        }

        return try MLDictionaryFeatureProvider(dictionary: features)
    }

    /// Serialise all output features to base64-encoded Float32 arrays.
    private func serializeOutputs(prediction: MLFeatureProvider) -> [[String: Any]] {
        var outputs: [[String: Any]] = []

        for name in prediction.featureNames {
            guard let fv = prediction.featureValue(for: name) else { continue }

            switch fv.type {
            case .multiArray:
                guard let arr = fv.multiArrayValue else { continue }
                let byteCount = arr.count * MemoryLayout<Float32>.size
                var float32Data = Data(count: byteCount)
                float32Data.withUnsafeMutableBytes { (ptr: UnsafeMutableRawBufferPointer) in
                    guard let dst = ptr.baseAddress else { return }
                    memcpy(dst, arr.dataPointer, byteCount)
                }
                let shape = (0 ..< arr.shape.count).map { arr.shape[$0].intValue }
                outputs.append([
                    "name": name,
                    "dataBase64": float32Data.base64EncodedString(),
                    "shape": shape,
                ])

            default:
                // Skip non-tensor outputs (strings, images, etc.) for now
                break
            }
        }

        return outputs
    }

    // MARK: - Memory Helpers

    /// Return a JS-compatible memory stats dictionary.
    private func buildMemoryStats() -> [String: Any] {
        let total = ProcessInfo.processInfo.physicalMemory
        let used  = UInt64(currentProcessMemoryBytes())
        let available = total > used ? total - used : 0
        let npuModelBytes = loadedModels.values.reduce(0) { $0 + $1.modelSizeBytes }

        let pressureRatio = total > 0 ? Double(used) / Double(total) : 0
        let pressureLevel: String
        if pressureRatio > 0.9 {
            pressureLevel = "critical"
        } else if pressureRatio > 0.75 {
            pressureLevel = "serious"
        } else if pressureRatio > 0.5 {
            pressureLevel = "fair"
        } else {
            pressureLevel = "nominal"
        }

        return [
            "totalBytes":     total,
            "usedBytes":      used,
            "availableBytes": available,
            "pressureLevel":  pressureLevel,
            "npuModelBytes":  npuModelBytes,
        ]
    }

    /// Resident set size of the current process in bytes.
    private func currentProcessMemoryBytes() -> Int {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: 1) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? Int(info.resident_size) : 0
    }

    /// Approximate disk size of the model file / bundle.
    private func approximateModelSize(path: String) -> Int {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let candidates: [URL] = [
            Bundle.main.url(forResource: path, withExtension: nil),
            Bundle.main.url(
                forResource: (path as NSString).deletingPathExtension,
                withExtension: (path as NSString).pathExtension
            ),
            docs.appendingPathComponent(path),
        ].compactMap { $0 }

        for url in candidates {
            if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
               let size = attrs[.size] as? Int {
                return size
            }
        }
        return 0
    }

    /// Determine the backend name actually used by the compiled model.
    private func activeBackendName(model: MLModel) -> String {
        switch model.configuration.computeUnits {
        case .cpuAndNeuralEngine: return "ane"
        case .cpuAndGPU:          return "gpu"
        case .cpuOnly:            return "cpu"
        default:                  return "ane"
        }
    }

    private func modelToJSObject(_ m: LoadedModel) -> [String: Any] {
        return [
            "modelId":        m.modelId,
            "name":           m.name,
            "backend":        m.backend,
            "loaded":         true,
            "modelSizeBytes": m.modelSizeBytes,
        ]
    }

    // MARK: - Memory Pressure Monitoring

    /// Subscribe to OS memory-pressure notifications and forward them to JS.
    private func registerMemoryPressureHandler() {
        let source = DispatchSource.makeMemoryPressureSource(
            eventMask: [.warning, .critical],
            queue: .main
        )

        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            let stats = self.buildMemoryStats()
            self.notifyListeners("memoryPressureChanged", data: stats)
        }

        source.resume()
        memoryPressureSource = source
    }
}
