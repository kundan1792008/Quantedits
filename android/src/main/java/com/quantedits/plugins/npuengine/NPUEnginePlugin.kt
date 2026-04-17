package com.quantedits.plugins.npuengine

import android.app.ActivityManager
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import android.util.Base64

// TensorFlow Lite imports.
// Add to build.gradle.kts:
//   implementation("org.tensorflow:tensorflow-lite:2.14.0")
//   implementation("org.tensorflow:tensorflow-lite-support:0.4.4")
//   implementation("org.tensorflow:tensorflow-lite-gpu:2.14.0")   // GPU delegate
// NNAPI is bundled with the TFLite AAR since Android 8.1 (API 27).
//
// The imports below are commented to allow compilation without the TFLite AAR.
// Uncomment once the dependency is added to build.gradle.kts.
//
// import org.tensorflow.lite.Interpreter
// import org.tensorflow.lite.gpu.GpuDelegate
// import org.tensorflow.lite.nnapi.NnApiDelegate

/**
 * Loaded model descriptor.
 */
private data class LoadedModel(
    val modelId: String,
    val name: String,
    val backend: String,
    val modelSizeBytes: Long,
    /** MappedByteBuffer kept alive for the TFLite Interpreter lifetime. */
    val modelBuffer: ByteBuffer,
    // When TFLite is available:
    // val interpreter: Interpreter,
    // val gpuDelegate: GpuDelegate? = null,
    // val nnapiDelegate: NnApiDelegate? = null,
)

/**
 * NPUEngine Capacitor Plugin (Android – Kotlin)
 *
 * Interfaces with Android NNAPI via the TensorFlow Lite NNAPI delegate to
 * execute on-device AI inference on the device's Neural Processing Unit (DSP,
 * GPU, or dedicated NPU/APU), falling back to the Vulkan GPU delegate, and
 * finally to the XNNPACK CPU delegate.
 *
 * Model lifecycle
 * ───────────────
 * 1. loadModel    – memory-map a .tflite file and build a TFLite Interpreter
 *                   configured with the appropriate hardware delegate.
 * 2. runInference – feed Float32 tensor inputs, capture Float32 outputs.
 * 3. unloadModel  – close the Interpreter and release native resources.
 *
 * Memory pressure
 * ───────────────
 * The plugin registers a ComponentCallbacks2 listener that translates OS
 * trim-memory levels into the typed MemoryPressureLevel enum and emits a
 * `memoryPressureChanged` event so the GenerativePipeline service can shed
 * models before the app is OOM-killed.
 *
 * The 1.5 GB render budget is enforced by the MemoryManager TypeScript
 * service; the plugin reports live RSS and available RAM via getMemoryStats().
 */
@CapacitorPlugin(name = "NPUEngine")
class NPUEnginePlugin : Plugin() {

    private val loadedModels = ConcurrentHashMap<String, LoadedModel>()
    private val executor = Executors.newSingleThreadExecutor()

    // MARK: - ComponentCallbacks2 for memory pressure

    private val memoryCallbacks = object : ComponentCallbacks2 {
        override fun onTrimMemory(level: Int) {
            val pressureLevel = trimLevelToPressure(level)
            val stats = buildMemoryStatsObject(pressureLevel)
            notifyListeners("memoryPressureChanged", stats)
        }

        override fun onConfigurationChanged(newConfig: Configuration) {}

        override fun onLowMemory() {
            val stats = buildMemoryStatsObject("critical")
            notifyListeners("memoryPressureChanged", stats)
        }
    }

    override fun load() {
        super.load()
        context.registerComponentCallbacks(memoryCallbacks)
    }

    override fun handleOnDestroy() {
        context.unregisterComponentCallbacks(memoryCallbacks)
        executor.shutdown()
        loadedModels.values.forEach { it.modelBuffer.clear() }
        loadedModels.clear()
        super.handleOnDestroy()
    }

    // MARK: - Plugin Methods

    /**
     * Load a TFLite model and compile it for the target NPU backend.
     *
     * preferredBackend choices:
     *   "nnapi"  → NNAPI delegate (DSP / dedicated NPU / GPU via NNAPI HAL)
     *   "gpu"    → GPU delegate (Vulkan or OpenGL ES)
     *   "cpu"    → XNNPACK CPU delegate
     *   "ane"    → same as "nnapi" on Android (no ANE on Android)
     */
    @PluginMethod
    fun loadModel(call: PluginCall) {
        val modelPath = call.getString("modelPath")
        val modelId   = call.getString("modelId")

        if (modelPath == null || modelId == null) {
            call.reject("modelPath and modelId are required")
            return
        }

        val preferredBackend = call.getString("preferredBackend") ?: "nnapi"

        // Return cached model if already loaded
        loadedModels[modelId]?.let {
            call.resolve(modelToJSObject(it))
            return
        }

        executor.execute {
            try {
                val (buffer, sizeBytes) = loadModelBuffer(modelPath)
                val resolvedBackend = resolveBackend(preferredBackend)

                // --- TFLite Interpreter construction (requires AAR) ---
                // val options = Interpreter.Options()
                // when (preferredBackend) {
                //     "nnapi" -> {
                //         val nnapiDelegate = NnApiDelegate()
                //         options.addDelegate(nnapiDelegate)
                //     }
                //     "gpu" -> {
                //         val gpuDelegate = GpuDelegate()
                //         options.addDelegate(gpuDelegate)
                //     }
                //     else -> options.setUseXNNPACK(true)
                // }
                // val interpreter = Interpreter(buffer, options)
                // --------------------------------------------------------

                val loaded = LoadedModel(
                    modelId = modelId,
                    name = File(modelPath).name,
                    backend = resolvedBackend,
                    modelSizeBytes = sizeBytes,
                    modelBuffer = buffer,
                )
                loadedModels[modelId] = loaded

                activity.runOnUiThread { call.resolve(modelToJSObject(loaded)) }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    call.reject("Failed to load model '$modelId': ${e.message}")
                }
            }
        }
    }

    /**
     * Run a single forward pass through a loaded TFLite model.
     */
    @PluginMethod
    fun runInference(call: PluginCall) {
        val modelId     = call.getString("modelId")
        val inputsArray = call.getArray("inputs")

        if (modelId == null || inputsArray == null) {
            call.reject("modelId and inputs are required")
            return
        }

        val loaded = loadedModels[modelId]
            ?: return call.reject("Model '$modelId' is not loaded. Call loadModel first.")

        executor.execute {
            val t0 = System.nanoTime()

            try {
                // Parse input tensors from the JS layer
                val inputs = parseInputTensors(inputsArray)

                // --- TFLite inference (requires AAR) ---
                // val outputMap = mutableMapOf<Int, Any>()
                // loaded.interpreter.runForMultipleInputsOutputs(
                //     inputs.values.toTypedArray(), outputMap
                // )
                // val outputs = serializeOutputTensors(loaded.interpreter, outputMap)
                // ----------------------------------------

                // Stub: echo inputs as outputs (identity model).
                // NOTE: With real TFLite the modelBuffer ByteBuffer is passed directly
                // to the Interpreter constructor (no copy needed), and tensor I/O uses
                // ByteBuffer objects as well — avoiding the heap copy below entirely.
                val outputs = JSArray()
                inputs.forEach { (name, buf) ->
                    // Use buf.get(byteArray) instead of buf.array() because
                    // memory-mapped (direct) ByteBuffers do not support array().
                    buf.rewind()
                    val byteArray = ByteArray(buf.remaining())
                    buf.get(byteArray)
                    val outObj = JSObject().apply {
                        put("name", "${name}_out")
                        put("dataBase64", Base64.encodeToString(byteArray, Base64.NO_WRAP))
                        put("shape", JSArray().apply { put(byteArray.size / 4) })
                    }
                    outputs.put(outObj)
                }

                val latencyMs = (System.nanoTime() - t0) / 1_000_000.0
                val memUsed   = processResidentSetBytes()

                val result = JSObject().apply {
                    put("modelId", modelId)
                    put("outputs", outputs)
                    put("latencyMs", latencyMs)
                    put("backend", loaded.backend)
                    put("memoryUsedBytes", memUsed)
                }

                activity.runOnUiThread {
                    notifyListeners("inferenceComplete", result)
                    call.resolve(result)
                }
            } catch (e: Exception) {
                activity.runOnUiThread {
                    call.reject("Inference failed for model '$modelId': ${e.message}")
                }
            }
        }
    }

    /**
     * Unload a model and release its native resources.
     */
    @PluginMethod
    fun unloadModel(call: PluginCall) {
        val modelId = call.getString("modelId")
            ?: return call.reject("modelId is required")

        loadedModels.remove(modelId)?.let {
            it.modelBuffer.clear()
            // it.interpreter.close()
            // it.gpuDelegate?.close()
            // it.nnapiDelegate?.close()
        }
        call.resolve()
    }

    /**
     * Return current device memory statistics.
     */
    @PluginMethod
    fun getMemoryStats(call: PluginCall) {
        val result = buildMemoryStatsObject(currentPressureLevel())
        call.resolve(result)
    }

    /**
     * List all currently loaded models.
     */
    @PluginMethod
    fun listLoadedModels(call: PluginCall) {
        val models = JSArray()
        loadedModels.values.forEach { models.put(modelToJSObject(it)) }
        val result = JSObject().apply { put("models", models) }
        call.resolve(result)
    }

    // MARK: - Model loading helpers

    /**
     * Memory-map a TFLite model from the assets folder or the app's files dir.
     *
     * Assets are tried first (bundled models), then the external files
     * directory (side-loaded / downloaded models).
     */
    private fun loadModelBuffer(path: String): Pair<ByteBuffer, Long> {
        // Try assets first
        try {
            context.assets.openFd(path).use { fd ->
                val buffer = FileInputStream(fd.fileDescriptor).channel.map(
                    FileChannel.MapMode.READ_ONLY,
                    fd.startOffset,
                    fd.declaredLength
                )
                buffer.order(ByteOrder.nativeOrder())
                return Pair(buffer, fd.declaredLength)
            }
        } catch (_: Exception) {}

        // Try files directory (downloaded models)
        val file = File(context.filesDir, path).takeIf { it.exists() }
            ?: File(path).takeIf { it.exists() }
            ?: throw IllegalArgumentException("Model file not found: $path")

        val buffer = FileInputStream(file).channel.map(
            FileChannel.MapMode.READ_ONLY, 0, file.length()
        )
        buffer.order(ByteOrder.nativeOrder())
        return Pair(buffer, file.length())
    }

    /**
     * Parse input tensor descriptors from the Capacitor JSArray.
     * Returns a map of feature name → ByteBuffer (Float32, native order).
     */
    private fun parseInputTensors(inputsArray: JSArray): Map<String, ByteBuffer> {
        val result = mutableMapOf<String, ByteBuffer>()
        for (i in 0 until inputsArray.length()) {
            val obj = inputsArray.getJSONObject(i)
            val name    = obj.getString("name")
            val b64     = obj.getString("dataBase64")
            val decoded = Base64.decode(b64, Base64.NO_WRAP)
            val buf = ByteBuffer.wrap(decoded).order(ByteOrder.LITTLE_ENDIAN)
            result[name] = buf
        }
        return result
    }

    // MARK: - Backend resolution

    private fun resolveBackend(preferred: String): String {
        return when (preferred) {
            "ane"   -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) "nnapi" else "cpu"
            "nnapi" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) "nnapi" else "cpu"
            "gpu"   -> "gpu"
            else    -> "cpu"
        }
    }

    // MARK: - Memory helpers

    private fun buildMemoryStatsObject(pressureLevel: String): JSObject {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)

        val npuModelBytes = loadedModels.values.sumOf { it.modelSizeBytes }

        return JSObject().apply {
            put("totalBytes",     memInfo.totalMem)
            put("usedBytes",      memInfo.totalMem - memInfo.availMem)
            put("availableBytes", memInfo.availMem)
            put("pressureLevel",  pressureLevel)
            put("npuModelBytes",  npuModelBytes)
        }
    }

    private fun currentPressureLevel(): String {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)
        if (memInfo.lowMemory) return "critical"
        val ratio = 1.0 - (memInfo.availMem.toDouble() / memInfo.totalMem.toDouble())
        return when {
            ratio > 0.90 -> "critical"
            ratio > 0.75 -> "serious"
            ratio > 0.50 -> "fair"
            else         -> "nominal"
        }
    }

    /**
     * Read the Resident Set Size (RSS) of the current process from /proc/self/status.
     */
    private fun processResidentSetBytes(): Long {
        return try {
            File("/proc/self/status").readLines()
                .firstOrNull { it.startsWith("VmRSS:") }
                ?.replace(Regex("\\D+"), "")
                ?.trim()
                ?.toLongOrNull()
                ?.times(1024) ?: 0L
        } catch (_: Exception) { 0L }
    }

    private fun trimLevelToPressure(level: Int): String = when {
        level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE        -> "critical"
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "critical"
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW     -> "serious"
        level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE        -> "fair"
        else                                                      -> "nominal"
    }

    private fun modelToJSObject(m: LoadedModel): JSObject = JSObject().apply {
        put("modelId",        m.modelId)
        put("name",           m.name)
        put("backend",        m.backend)
        put("loaded",         true)
        put("modelSizeBytes", m.modelSizeBytes)
    }
}
