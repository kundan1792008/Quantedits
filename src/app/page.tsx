"use client";

import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Video, X } from "lucide-react";
import Topbar from "@/components/Topbar";
import VideoDropZone, { type DroppedFile } from "@/components/VideoDropZone";
import DeepDub from "@/components/DeepDub";
import HookGenerator, { type Highlight } from "@/components/HookGenerator";
import PublishRouter from "@/components/PublishRouter";
import ReelCapture from "@/components/ReelCapture";
import Timeline from "@/components/Timeline";
import WebGLTimeline from "@/components/WebGLTimeline";
import GenerativePipelinePanel from "@/components/GenerativePipelinePanel";

export default function Home() {
  const [droppedFile, setDroppedFile] = useState<DroppedFile | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [playheadFraction, setPlayheadFraction] = useState(0);

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

  return (
    <div
      className="flex flex-col h-screen overflow-hidden"
      style={{ background: "#0D0D11" }}
    >
      {/* Top bar */}
      <Topbar />

      {/* Main workspace — 3-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── LEFT PANEL: Canvas / Video Drop Zone ─────────────────────── */}
        <div
          className="flex flex-col"
          style={{
            width: "38%",
            borderRight: "1px solid #1E1E2E",
            background: "#0D0D11",
          }}
        >
          {/* Panel header */}
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

          {/* Video canvas / drop zone */}
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
                  {/* Video preview */}
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
                    {/* Duration badge */}
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

                  {/* Quick action row */}
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

        {/* ── CENTER PANEL: AI Tools ─────────────────────────────────────── */}
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
            {/* Deep-Dub */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <DeepDub fileName={droppedFile?.file.name} />
            </motion.div>

            {/* Hook Generator */}
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

            {/* Reel Capture — Quantneon + Quantmail integration */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <ReelCapture />
            </motion.div>

            {/* Generative Pipeline — NPU-accelerated on-device video generation */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
            >
              <GenerativePipelinePanel />
            </motion.div>
          </div>
        </div>

        {/* ── RIGHT PANEL: Publish Router ───────────────────────────────── */}
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

      {/* ── BOTTOM: Timeline (WebGL hardware-accelerated) ────────────────────── */}
      <div
        style={{
          height: "180px",
          borderTop: "1px solid #1E1E2E",
          background: "#0D0D11",
        }}
      >
        <WebGLTimeline
          highlights={highlights}
          fileName={droppedFile?.file.name}
          playheadFraction={playheadFraction}
          onScrub={setPlayheadFraction}
        />
      </div>
    </div>
  );
}

