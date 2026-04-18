"use client";

import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Video, X, LayoutTemplate, Layers } from "lucide-react";
import Topbar from "@/components/Topbar";
import VideoDropZone, { type DroppedFile } from "@/components/VideoDropZone";
import DeepDub from "@/components/DeepDub";
import HookGenerator, { type Highlight } from "@/components/HookGenerator";
import MusicStudio from "@/components/MusicStudio";
import PublishRouter from "@/components/PublishRouter";
import ReelCapture from "@/components/ReelCapture";
import WebGLTimeline from "@/components/WebGLTimeline";
import GenerativePipelinePanel from "@/components/GenerativePipelinePanel";
import type { Track } from "@/engine/TimelineRenderer";

export default function Home() {
  const [droppedFile, setDroppedFile] = useState<DroppedFile | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [timelineTracks, setTimelineTracks] = useState<Track[]>([]);
  const [layout, setLayout] = useState<"classic" | "editor">("editor");

  const handleFileDrop = useCallback((file: DroppedFile) => {
    setDroppedFile(file);
    setHighlights([]);
  }, []);

  // Revoke object URL when droppedFile changes or component unmounts
  useEffect(() => {
    const url = droppedFile?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [droppedFile]);

  const handleClearFile = () => {
    setDroppedFile(null);
    setHighlights([]);
  };

  const handleAutoSave = useCallback(() => {
    // In production: POST /api/v1/projects/:id with current state
  }, []);

  const handlePromptGenerate = useCallback((prompt: string) => {
    // In production: the response would populate new timeline tracks
    void prompt;
  }, []);

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: "#0D0D11" }}
    >
      {/* Top bar */}
      <Topbar />

      {/* Layout toggle */}
      <div
        className="flex items-center gap-1 px-4 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        <button
          onClick={() => setLayout("editor")}
          title="Editor layout"
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] transition-colors"
          style={{
            background: layout === "editor" ? "#1E1E40" : "transparent",
            color: layout === "editor" ? "#a78bfa" : "#3a3a5a",
            border: `1px solid ${layout === "editor" ? "#3a3a6a" : "transparent"}`,
          }}
        >
          <Layers size={10} />
          Editor
        </button>
        <button
          onClick={() => setLayout("classic")}
          title="Classic layout"
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] transition-colors"
          style={{
            background: layout === "classic" ? "#1E1E40" : "transparent",
            color: layout === "classic" ? "#a78bfa" : "#3a3a5a",
            border: `1px solid ${layout === "classic" ? "#3a3a6a" : "transparent"}`,
          }}
        >
          <LayoutTemplate size={10} />
          Classic
        </button>
      </div>

      {layout === "editor" ? (
        /* ── EDITOR LAYOUT ──────────────────────────────────────────── */
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Upper workspace — 3-column */}
          <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>
            {/* ── LEFT PANEL: Canvas ────────────────────────────────── */}
            <div
              className="flex flex-col"
              style={{
                width: "38%",
                borderRight: "1px solid #1E1E2E",
                background: "#0D0D11",
              }}
            >
              <div
                className="flex items-center gap-2 px-4 py-2 shrink-0"
                style={{ borderBottom: "1px solid #1E1E2E" }}
              >
                <Video size={13} className="text-[#5a5a7a]" />
                <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest">
                  Canvas
                </span>
                {droppedFile && (
                  <motion.div
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="ml-auto flex items-center gap-2"
                  >
                    <span className="text-[10px] text-[#8888aa] font-mono truncate max-w-[150px]">
                      {droppedFile.file.name}
                    </span>
                    <button
                      onClick={handleClearFile}
                      className="text-[#3a3a5a] hover:text-[#8888aa] transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </motion.div>
                )}
              </div>

              <div className="flex-1 p-4 overflow-hidden">
                <AnimatePresence mode="wait">
                  {droppedFile ? (
                    <motion.div
                      key="preview"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="w-full h-full flex flex-col gap-3"
                    >
                      <div
                        className="relative rounded-2xl overflow-hidden flex-1"
                        style={{
                          background: "#0a0a12",
                          border: "1px solid #1E1E2E",
                        }}
                      >
                        <video
                          src={droppedFile.previewUrl}
                          className="w-full h-full object-contain"
                          controls
                          style={{ maxHeight: "100%" }}
                        />
                        <div
                          className="absolute bottom-3 left-3 text-[10px] font-mono px-2 py-1 rounded"
                          style={{
                            background: "rgba(13,13,17,0.85)",
                            border: "1px solid #2a2a3e",
                            color: "#8888aa",
                          }}
                        >
                          {droppedFile.durationEstimate}
                        </div>
                      </div>
                      <div
                        className="rounded-xl px-4 py-3 flex items-center gap-4"
                        style={{
                          background: "#13131A",
                          border: "1px solid #1E1E2E",
                        }}
                      >
                        <div>
                          <p className="text-xs font-semibold text-[#E8E8F0]">
                            {droppedFile.file.name.length > 30
                              ? droppedFile.file.name.slice(0, 30) + "…"
                              : droppedFile.file.name}
                          </p>
                          <p className="text-[11px] text-[#5a5a7a]">
                            {(droppedFile.file.size / (1024 * 1024)).toFixed(1)} MB
                            · {droppedFile.durationEstimate}
                          </p>
                        </div>
                        <div className="ml-auto flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-[10px] text-emerald-400">
                            Ready
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="dropzone"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-full"
                    >
                      <VideoDropZone onFileDrop={handleFileDrop} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* ── CENTER PANEL: AI Tools ────────────────────────────── */}
            <div
              className="flex flex-col overflow-y-auto"
              style={{
                width: "34%",
                borderRight: "1px solid #1E1E2E",
                background: "#0D0D11",
              }}
            >
              <div
                className="px-4 py-2 shrink-0"
                style={{ borderBottom: "1px solid #1E1E2E" }}
              >
                <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest">
                  AI Tools
                </span>
              </div>

              <div className="flex flex-col gap-3 p-4">
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                >
                  <DeepDub fileName={droppedFile?.file.name} />
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <HookGenerator
                    fileName={droppedFile?.file.name}
                    durationEstimate={droppedFile?.durationEstimate}
                    onHighlightsReady={setHighlights}
                  />
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                >
                  <ReelCapture />
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4 }}
                >
                  <MusicStudio
                    durationSec={droppedFile?.durationEstimate ? parseFloat(droppedFile.durationEstimate) : 30}
                    fileName={droppedFile?.file.name}
                  />
                </motion.div>
              </div>
            </div>

            {/* ── RIGHT PANEL: Publish Router ───────────────────────── */}
            <div
              className="flex flex-col overflow-y-auto"
              style={{
                width: "28%",
                background: "#0D0D11",
              }}
            >
              <div
                className="px-4 py-2 shrink-0"
                style={{ borderBottom: "1px solid #1E1E2E" }}
              >
                <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest">
                  Publish
                </span>
              </div>

              <div className="p-4">
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                >
                  <PublishRouter
                    fileName={droppedFile?.file.name}
                    highlights={highlights}
                  />
                </motion.div>
              </div>
            </div>
          </div>

          {/* ── BOTTOM: WebGL Timeline + AI Pipeline ─────────────────── */}
          <div
            className="flex flex-col shrink-0"
            style={{
              height: "260px",
              borderTop: "1px solid #1E1E2E",
              background: "#0D0D11",
            }}
          >
            {/* WebGL Timeline takes most of the height */}
            <div className="flex-1 overflow-hidden">
              <WebGLTimeline
                timelineId="main"
                durationSec={60}
                onTracksChange={setTimelineTracks}
              />
            </div>

            {/* AI Pipeline panel docked at very bottom */}
            <GenerativePipelinePanel
              tracks={timelineTracks}
              durationSec={60}
              onPromptGenerate={handlePromptGenerate}
              onAutoSave={handleAutoSave}
            />
          </div>
        </div>
      ) : (
        /* ── CLASSIC LAYOUT (original 3-col + simple timeline) ─────── */
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex flex-1 overflow-hidden">
            {/* LEFT: Canvas */}
            <div
              className="flex flex-col"
              style={{
                width: "38%",
                borderRight: "1px solid #1E1E2E",
                background: "#0D0D11",
              }}
            >
              <div
                className="flex items-center gap-2 px-4 py-2 shrink-0"
                style={{ borderBottom: "1px solid #1E1E2E" }}
              >
                <Video size={13} className="text-[#5a5a7a]" />
                <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest">
                  Canvas
                </span>
                {droppedFile && (
                  <motion.div
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="ml-auto flex items-center gap-2"
                  >
                    <span className="text-[10px] text-[#8888aa] font-mono truncate max-w-[150px]">
                      {droppedFile.file.name}
                    </span>
                    <button
                      onClick={handleClearFile}
                      className="text-[#3a3a5a] hover:text-[#8888aa] transition-colors"
                    >
                      <X size={12} />
                    </button>
                  </motion.div>
                )}
              </div>
              <div className="flex-1 p-4 overflow-hidden">
                <AnimatePresence mode="wait">
                  {droppedFile ? (
                    <motion.div
                      key="preview"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="w-full h-full"
                    >
                      <div
                        className="relative rounded-2xl overflow-hidden h-full"
                        style={{
                          background: "#0a0a12",
                          border: "1px solid #1E1E2E",
                        }}
                      >
                        <video
                          src={droppedFile.previewUrl}
                          className="w-full h-full object-contain"
                          controls
                        />
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="dropzone"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-full"
                    >
                      <VideoDropZone onFileDrop={handleFileDrop} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* CENTER: AI Tools */}
            <div
              className="flex flex-col overflow-y-auto"
              style={{
                width: "34%",
                borderRight: "1px solid #1E1E2E",
                background: "#0D0D11",
              }}
            >
              <div
                className="px-4 py-2 shrink-0"
                style={{ borderBottom: "1px solid #1E1E2E" }}
              >
                <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest">
                  AI Tools
                </span>
              </div>
              <div className="flex flex-col gap-3 p-4">
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                  <DeepDub fileName={droppedFile?.file.name} />
                </motion.div>
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                  <HookGenerator
                    fileName={droppedFile?.file.name}
                    durationEstimate={droppedFile?.durationEstimate}
                    onHighlightsReady={setHighlights}
                  />
                </motion.div>
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                  <ReelCapture />
                </motion.div>
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
                  <MusicStudio
                    durationSec={droppedFile?.durationEstimate ? parseFloat(droppedFile.durationEstimate) : 30}
                    fileName={droppedFile?.file.name}
                  />
                </motion.div>
              </div>
            </div>

            {/* RIGHT: Publish */}
            <div
              className="flex flex-col overflow-y-auto"
              style={{ width: "28%", background: "#0D0D11" }}
            >
              <div
                className="px-4 py-2 shrink-0"
                style={{ borderBottom: "1px solid #1E1E2E" }}
              >
                <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest">
                  Publish
                </span>
              </div>
              <div className="p-4">
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                  <PublishRouter
                    fileName={droppedFile?.file.name}
                    highlights={highlights}
                  />
                </motion.div>
              </div>
            </div>
          </div>

          {/* BOTTOM: WebGL Timeline */}
          <div
            style={{
              height: "200px",
              borderTop: "1px solid #1E1E2E",
              background: "#0D0D11",
            }}
          >
            <WebGLTimeline
              timelineId="classic"
              durationSec={60}
              onTracksChange={setTimelineTracks}
            />
          </div>
        </div>
      )}
    </div>
  );
}

