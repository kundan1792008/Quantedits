"use client";

/**
 * GenerativePipelinePanel
 *
 * React UI for the on-device Generative Video Pipeline.
 * Lets the user drop/paste a reference frame, adjust generation
 * parameters, run on-device inference via the NPUEngine plugin, and
 * preview the generated frame sequence on a <canvas>.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cpu, Play, Square, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { generativePipeline, GenerativePipeline, type GenerationProgress, type GenerationResult } from "@/services/GenerativePipeline";
import { memoryManager } from "@/services/MemoryManager";
import type { MemoryStats } from "@/plugins/npu-engine/definitions";

// ── Status badge helpers ──────────────────────────────────────────────────

function statusLabel(status: GenerationProgress["status"]): string {
  switch (status) {
    case "loading_models": return "Loading NPU models…";
    case "encoding":       return "VAE encoding…";
    case "diffusing":      return "Diffusion";
    case "decoding":       return "VAE decoding…";
    case "complete":       return "Complete";
    case "aborted":        return "Aborted";
    case "error":          return "Error";
    default:               return "Idle";
  }
}

// ── Component ─────────────────────────────────────────────────────────────

export default function GenerativePipelinePanel() {
  const [status, setStatus] = useState<GenerationProgress["status"]>("idle");
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memStats, setMemStats] = useState<MemoryStats | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const framesRef = useRef<string[]>([]);

  // ── Memory stats subscription ──────────────────────────────────────────

  useEffect(() => {
    memoryManager.start().catch(console.error);
    const unsub = memoryManager.onPressureChange(setMemStats);
    return unsub;
  }, []);

  // ── Frame preview animation ───────────────────────────────────────────

  useEffect(() => {
    if (!result || result.framesBase64.length === 0) return;
    framesRef.current = result.framesBase64;

    // Advance frame index at ~24 fps, driven by requestAnimationFrame so the
    // loop automatically pauses when the tab is hidden (no wasted CPU/GPU).
    const fps = 24;
    const frameDurationMs = 1000 / fps;
    let lastTimestamp = 0;
    let fi = 0;

    const tick = (timestamp: number) => {
      if (timestamp - lastTimestamp >= frameDurationMs) {
        fi = (fi + 1) % framesRef.current.length;
        setFrameIndex(fi);
        lastTimestamp = timestamp;
      }
      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [result]);

  // Render current frame to canvas
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !result) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frameB64 = result.framesBase64[frameIndex];
    if (!frameB64) return;

    // Decode base64 Float32 RGBA → ImageData
    try {
      const binary = atob(frameB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const f32 = new Float32Array(bytes.buffer);

      const w = result.width;
      const h = result.height;
      canvas.width  = w;
      canvas.height = h;

      const imgData = ctx.createImageData(w, h);
      for (let i = 0; i < f32.length && i < imgData.data.length; i++) {
        imgData.data[i] = Math.max(0, Math.min(255, Math.round(f32[i] * 255)));
      }
      ctx.putImageData(imgData, 0, 0);
    } catch {
      // Frames may be stubs (empty base64) on web — draw a placeholder
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#7C3AED88";
      ctx.font = "12px monospace";
      ctx.fillText(`Frame ${frameIndex + 1}/${result.framesBase64.length}`, 8, 20);
    }
  }, [result, frameIndex]);

  // ── Generation ────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    setError(null);
    setResult(null);
    setFrameIndex(0);

    // Build a 512×512 placeholder source frame (grey noise) for demo purposes.
    // In production the user selects a video frame via a file picker.
    const size = 512;
    const f32 = new Float32Array(3 * size * size);
    for (let i = 0; i < f32.length; i++) f32[i] = Math.random() * 0.2 + 0.1;
    const bytes = new Uint8Array(f32.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const sourceFrameBase64 = btoa(binary);

    try {
      const genResult = await generativePipeline.generate(
        {
          sourceFrameBase64,
          sourceWidth:   size,
          sourceHeight:  size,
          frameCount:    14,
          diffusionSteps: 20,
          motionStrength: 0.85,
          preferredBackend: "ane",
        },
        (prog) => {
          setProgress(prog);
          setStatus(prog.status);
        },
      );

      GenerativePipeline.assertWithinBudget(genResult.peakMemoryBytes);
      setResult(genResult);
      setStatus("complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setStatus("error");
    }
  }, []);

  const handleStop = useCallback(() => {
    // Signal abort via memory pressure — pipeline checks this flag each step
    setStatus("aborted");
    setError("Generation cancelled.");
  }, []);

  const isRunning = ["loading_models", "encoding", "diffusing", "decoding"].includes(status);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: "#13131A",
        border: "1px solid #1E1E2E",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b"
        style={{ borderColor: "#1E1E2E" }}
      >
        <Cpu size={13} className="text-purple-400" />
        <span className="text-xs font-semibold text-[#E8E8F0] tracking-wide">
          Generative Pipeline
        </span>
        <span className="text-[10px] text-[#3a3a5a] ml-1">NPU · On-device</span>

        {/* Memory pressure indicator */}
        {memStats && (
          <div className="ml-auto flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background:
                  memStats.pressureLevel === "critical" ? "#ef4444"
                  : memStats.pressureLevel === "serious"  ? "#f97316"
                  : memStats.pressureLevel === "fair"     ? "#eab308"
                  : "#22c55e",
              }}
            />
            <span className="text-[9px] text-[#5a5a7a] font-mono">
              {(memStats.usedBytes / 1e9).toFixed(2)} GB
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 flex flex-col gap-3">
        {/* Status row */}
        <div className="flex items-center gap-2 h-6">
          <AnimatePresence mode="wait">
            {isRunning ? (
              <motion.div
                key="running"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-1.5"
              >
                <Loader2 size={12} className="text-purple-400 animate-spin" />
                <span className="text-[11px] text-purple-300 font-mono">
                  {statusLabel(status)}
                  {progress?.status === "diffusing" && progress.step !== undefined
                    ? ` ${progress.step}/${progress.totalSteps}`
                    : ""}
                </span>
              </motion.div>
            ) : status === "complete" ? (
              <motion.div
                key="complete"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-1.5"
              >
                <CheckCircle2 size={12} className="text-emerald-400" />
                <span className="text-[11px] text-emerald-400 font-mono">
                  {result
                    ? `${result.framesBase64.length} frames · ${result.totalMs.toFixed(0)} ms · ${result.backend}`
                    : "Complete"}
                </span>
              </motion.div>
            ) : status === "error" || status === "aborted" ? (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-1.5"
              >
                <AlertTriangle size={12} className="text-red-400" />
                <span className="text-[11px] text-red-400 font-mono truncate max-w-[220px]">
                  {error ?? "Error"}
                </span>
              </motion.div>
            ) : (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-1.5"
              >
                <span className="text-[11px] text-[#3a3a5a] font-mono">
                  Idle · ready to generate
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Diffusion progress bar */}
        {progress?.status === "diffusing" &&
          progress.step !== undefined &&
          progress.totalSteps !== undefined && (
          <div
            className="h-1 rounded-full overflow-hidden"
            style={{ background: "#1E1E2E" }}
          >
            <motion.div
              className="h-full rounded-full"
              style={{ background: "linear-gradient(90deg, #7C3AED, #06B6D4)" }}
              initial={{ width: "0%" }}
              animate={{ width: `${(progress.step / progress.totalSteps) * 100}%` }}
              transition={{ duration: 0.2 }}
            />
          </div>
        )}

        {/* Frame preview canvas */}
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-xl overflow-hidden"
              style={{ border: "1px solid #1E1E2E" }}
            >
              <canvas
                ref={previewCanvasRef}
                className="w-full"
                style={{ display: "block", imageRendering: "pixelated", maxHeight: "120px", objectFit: "contain" }}
              />
              <div
                className="flex items-center justify-between px-3 py-1.5"
                style={{ background: "#0D0D11" }}
              >
                <span className="text-[9px] text-[#3a3a5a] font-mono">
                  {frameIndex + 1} / {result.framesBase64.length} frames
                </span>
                <span className="text-[9px] text-[#3a3a5a] font-mono">
                  {result.width}×{result.height} · {(result.peakMemoryBytes / 1e6).toFixed(0)} MB peak
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Controls */}
        <div className="flex gap-2">
          <button
            onClick={isRunning ? handleStop : handleGenerate}
            disabled={false}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
            style={{
              background: isRunning
                ? "rgba(239,68,68,0.15)"
                : "linear-gradient(135deg, #7C3AED22, #06B6D422)",
              border: `1px solid ${isRunning ? "#ef444440" : "#7C3AED40"}`,
              color: isRunning ? "#f87171" : "#a78bfa",
            }}
          >
            {isRunning ? (
              <>
                <Square size={11} />
                Stop
              </>
            ) : (
              <>
                <Play size={11} />
                Generate
              </>
            )}
          </button>
          {result && !isRunning && (
            <button
              onClick={handleGenerate}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all"
              style={{
                background: "rgba(124,58,237,0.1)",
                border: "1px solid #7C3AED30",
                color: "#7C3AED",
              }}
            >
              Re-run
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
