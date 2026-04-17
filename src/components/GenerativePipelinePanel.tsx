"use client";

/**
 * GenerativePipelinePanel — AI prompt bar + pipeline management UI
 *
 * Features:
 *   - Text prompt input with send button
 *   - Live AI operation queue with progress indicators
 *   - Style picker (style transfer)
 *   - Quick-action buttons (Remove BG, Auto Color, Upscale)
 *   - Export dialog with format/quality/resolution selectors
 *   - Auto-save status indicator
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type FormEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Send,
  X,
  Download,
  CheckCircle,
  AlertCircle,
  Loader2,
  Image as ImageIcon,
  Palette,
  ZoomIn,
  Wand2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Film,
  Clock,
  HardDrive,
} from "lucide-react";
import {
  type AIJob,
  type AIOperationType,
  STYLE_LIBRARY,
  aiEditService,
} from "@/services/AIEditService";
import {
  type ExportFormat,
  type ExportResolution,
  type ExportProgress,
  RESOLUTION_PRESETS,
  FORMAT_PRESETS,
  estimateFileSizeMB,
  estimateExportTimeSec,
  getFileExtension,
  exportService,
} from "@/services/ExportService";
import type { Track } from "@/engine/TimelineRenderer";

// ── Types ─────────────────────────────────────────────────────────────────

interface GenerativePipelinePanelProps {
  tracks?: Track[];
  durationSec?: number;
  projectId?: string;
  onPromptGenerate?: (prompt: string) => void;
  onAutoSave?: () => void;
}

interface JobDisplay {
  id: string;
  type: AIOperationType;
  status: AIJob["status"];
  progress: number;
  label: string;
}

// ── Helper labels ─────────────────────────────────────────────────────────

// AI_OP_LABELS is available for consumers to import
export const AI_OP_LABELS: Record<AIOperationType, string> = {
  REMOVE_BACKGROUND: "Remove Background",
  GENERATIVE_FILL: "Generative Fill",
  STYLE_TRANSFER: "Style Transfer",
  UPSCALE: "Upscale",
  AUTO_COLOR: "Auto Colour",
};

const AI_OP_ICONS: Record<
  AIOperationType,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  REMOVE_BACKGROUND: ImageIcon,
  GENERATIVE_FILL: Wand2,
  STYLE_TRANSFER: Palette,
  UPSCALE: ZoomIn,
  AUTO_COLOR: RefreshCw,
};

// ── Component ─────────────────────────────────────────────────────────────

export default function GenerativePipelinePanel({
  tracks = [],
  durationSec = 60,
  projectId,
  onPromptGenerate,
  onAutoSave,
}: GenerativePipelinePanelProps) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [jobs, setJobs] = useState<JobDisplay[]>([]);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [selectedStyle, setSelectedStyle] = useState<string | null>(null);
  const [showStylePicker, setShowStylePicker] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [collapsed, setCollapsed] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  void autoSaveTimerRef; // ref used by auto-save cleanup effect

  // ── Auto-save ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!onAutoSave) return;
    const INTERVAL = 30_000;
    const id = setInterval(() => {
      setAutoSaveStatus("saving");
      setTimeout(() => {
        onAutoSave();
        setAutoSaveStatus("saved");
        setTimeout(() => setAutoSaveStatus("idle"), 3000);
      }, 600);
    }, INTERVAL);
    return () => clearInterval(id);
  }, [onAutoSave]);

  // ── AI job subscriptions ──────────────────────────────────────────────

  useEffect(() => {
    const unsubProgress = aiEditService.onAnyProgress((jobId, progress) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId ? { ...j, progress } : j,
        ),
      );
    });

    const unsubComplete = aiEditService.onAnyComplete((jobId, result, error) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? {
                ...j,
                status: error
                  ? "FAILED"
                  : result === null
                    ? "CANCELLED"
                    : "DONE",
                progress: result ? 100 : j.progress,
              }
            : j,
        ),
      );

      // Auto-remove completed/failed jobs after 4 seconds
      setTimeout(() => {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
      }, 4000);
    });

    return () => {
      unsubProgress();
      unsubComplete();
    };
  }, []);

  // ── Prompt submission ─────────────────────────────────────────────────

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const text = prompt.trim();
      if (!text || isSubmitting) return;

      setIsSubmitting(true);
      try {
        onPromptGenerate?.(text);

        if (projectId) {
          await fetch("/api/v1/edits/generate-timeline", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: text, projectId, durationSec }),
          });
        }

        setPrompt("");
      } finally {
        setIsSubmitting(false);
        promptRef.current?.focus();
      }
    },
    [prompt, isSubmitting, onPromptGenerate, projectId, durationSec],
  );

  // ── Quick actions ─────────────────────────────────────────────────────

  const addDemoJob = useCallback(
    (type: AIOperationType, label: string) => {
      // In production, pass actual frameData. Here we enqueue a placeholder.
      const placeholder = {
        data: new Uint8ClampedArray(4),
        width: 1,
        height: 1,
      };

      let jobId: string;
      switch (type) {
        case "REMOVE_BACKGROUND":
          jobId = aiEditService.removeBackground(placeholder);
          break;
        case "AUTO_COLOR":
          jobId = aiEditService.autoColor(placeholder);
          break;
        case "UPSCALE":
          jobId = aiEditService.upscale(placeholder, 2);
          break;
        case "STYLE_TRANSFER":
          jobId = aiEditService.styleTransfer(
            placeholder,
            selectedStyle ?? "style-cyberpunk",
          );
          break;
        case "GENERATIVE_FILL":
          jobId = aiEditService.generativeFill(
            placeholder,
            new Uint8ClampedArray(1),
            prompt || "seamless background fill",
          );
          break;
        default:
          jobId = aiEditService.removeBackground(placeholder);
      }

      setJobs((prev) => [
        ...prev,
        {
          id: jobId,
          type,
          status: "PENDING",
          progress: 0,
          label,
        },
      ]);
    },
    [selectedStyle, prompt],
  );

  const handleCancelJob = useCallback((jobId: string) => {
    aiEditService.cancel(jobId);
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  // ── Prompt key handler ────────────────────────────────────────────────

  const handlePromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit(e as unknown as FormEvent);
      }
    },
    [handleSubmit],
  );

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col"
      style={{
        background: "#0D0D11",
        borderTop: "1px solid #1E1E2E",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-2 cursor-pointer select-none"
        style={{ borderBottom: collapsed ? undefined : "1px solid #1E1E2E" }}
        onClick={() => setCollapsed((c) => !c)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <Sparkles size={12} className="text-purple-400" />
        <span className="text-xs font-medium text-[#5a5a7a] uppercase tracking-widest flex-1">
          AI Pipeline
        </span>

        {/* Auto-save status */}
        <AnimatePresence mode="wait">
          {autoSaveStatus !== "idle" && (
            <motion.div
              key={autoSaveStatus}
              initial={{ opacity: 0, x: 4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              className="flex items-center gap-1"
            >
              {autoSaveStatus === "saving" ? (
                <>
                  <Loader2 size={10} className="text-[#5a5a7a] animate-spin" />
                  <span className="text-[10px] text-[#5a5a7a]">Saving…</span>
                </>
              ) : (
                <>
                  <CheckCircle size={10} className="text-emerald-500" />
                  <span className="text-[10px] text-emerald-500">Saved</span>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Job count badge */}
        {jobs.filter((j) => j.status === "RUNNING" || j.status === "PENDING").length > 0 && (
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded-full"
            style={{ background: "#7C3AED30", color: "#a78bfa" }}
          >
            {jobs.filter((j) => j.status === "RUNNING" || j.status === "PENDING").length} running
          </span>
        )}

        {collapsed ? <ChevronUp size={12} className="text-[#3a3a5a]" /> : <ChevronDown size={12} className="text-[#3a3a5a]" />}
      </div>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: "hidden" }}
          >
            <div className="flex flex-col gap-3 p-3">
              {/* Quick actions */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <QuickActionButton
                  label="Remove BG"
                  icon={<ImageIcon size={10} />}
                  onClick={() => addDemoJob("REMOVE_BACKGROUND", "Remove Background")}
                />
                <QuickActionButton
                  label="Auto Colour"
                  icon={<RefreshCw size={10} />}
                  onClick={() => addDemoJob("AUTO_COLOR", "Auto Colour")}
                />
                <QuickActionButton
                  label="Upscale 2×"
                  icon={<ZoomIn size={10} />}
                  onClick={() => addDemoJob("UPSCALE", "Upscale 2×")}
                />
                <QuickActionButton
                  label={selectedStyle ? STYLE_LIBRARY[selectedStyle]?.name ?? "Style" : "Style…"}
                  icon={<Palette size={10} />}
                  onClick={() => setShowStylePicker((o) => !o)}
                  active={showStylePicker}
                />
                <QuickActionButton
                  label="Gen Fill"
                  icon={<Wand2 size={10} />}
                  onClick={() => addDemoJob("GENERATIVE_FILL", "Generative Fill")}
                />

                {/* Export button */}
                <button
                  onClick={() => setShowExportDialog(true)}
                  className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors"
                  style={{
                    background: "#7C3AED",
                    color: "#fff",
                  }}
                >
                  <Download size={10} />
                  Export
                </button>
              </div>

              {/* Style picker */}
              <AnimatePresence>
                {showStylePicker && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-wrap gap-1.5 pb-1">
                      {Object.entries(STYLE_LIBRARY).map(([id, style]) => (
                        <button
                          key={id}
                          onClick={() => {
                            setSelectedStyle(id);
                            setShowStylePicker(false);
                            addDemoJob("STYLE_TRANSFER", `Style: ${style.name}`);
                          }}
                          title={style.description}
                          className="text-[10px] px-2 py-1 rounded transition-colors"
                          style={{
                            background:
                              selectedStyle === id ? "#7C3AED20" : "#13131A",
                            border: `1px solid ${
                              selectedStyle === id ? "#7C3AED" : "#1E1E2E"
                            }`,
                            color:
                              selectedStyle === id ? "#a78bfa" : "#5a5a7a",
                          }}
                        >
                          {style.name}
                        </button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Job queue */}
              <AnimatePresence>
                {jobs.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex flex-col gap-1.5"
                  >
                    {jobs.map((job) => (
                      <JobRow key={job.id} job={job} onCancel={handleCancelJob} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Prompt bar */}
              <form onSubmit={handleSubmit} className="relative">
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={handlePromptKeyDown}
                  placeholder="Describe an edit, effect, or style… (Enter to send)"
                  rows={2}
                  className="w-full resize-none text-xs px-3 py-2 pr-10 rounded-lg outline-none transition-colors"
                  style={{
                    background: "#13131A",
                    border: "1px solid #1E1E2E",
                    color: "#E8E8F0",
                    lineHeight: 1.5,
                  }}
                  disabled={isSubmitting}
                />
                <button
                  type="submit"
                  disabled={!prompt.trim() || isSubmitting}
                  className="absolute right-2 bottom-2 w-6 h-6 flex items-center justify-center rounded transition-all"
                  style={{
                    background:
                      prompt.trim() && !isSubmitting ? "#7C3AED" : "transparent",
                    color:
                      prompt.trim() && !isSubmitting ? "#fff" : "#3a3a5a",
                  }}
                >
                  {isSubmitting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Send size={11} />
                  )}
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Export dialog */}
      <AnimatePresence>
        {showExportDialog && (
          <ExportDialog
            tracks={tracks}
            durationSec={durationSec}
            projectId={projectId}
            onClose={() => setShowExportDialog(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ── QuickActionButton ─────────────────────────────────────────────────────

function QuickActionButton({
  label,
  icon,
  onClick,
  active = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors"
      style={{
        background: active ? "#1E1E40" : "#13131A",
        border: `1px solid ${active ? "#3a3a6a" : "#1E1E2E"}`,
        color: active ? "#a78bfa" : "#5a5a7a",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ── JobRow ────────────────────────────────────────────────────────────────

function JobRow({
  job,
  onCancel,
}: {
  job: JobDisplay;
  onCancel: (id: string) => void;
}) {
  const Icon = AI_OP_ICONS[job.type];

  const statusColor: Record<AIJob["status"], string> = {
    PENDING: "#5a5a7a",
    RUNNING: "#a78bfa",
    DONE: "#10b981",
    FAILED: "#ef4444",
    CANCELLED: "#3a3a5a",
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 8 }}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5"
      style={{
        background: "#13131A",
        border: "1px solid #1E1E2E",
      }}
    >
      {/* Icon */}
      <span style={{ color: statusColor[job.status], flexShrink: 0 }}>
        <Icon size={11} />
      </span>

      {/* Label + progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-[10px] font-mono truncate"
            style={{ color: "#E8E8F0" }}
          >
            {job.label}
          </span>
          <span
            className="text-[9px] font-mono shrink-0"
            style={{ color: statusColor[job.status] }}
          >
            {job.status === "DONE"
              ? "Done"
              : job.status === "FAILED"
                ? "Failed"
                : job.status === "CANCELLED"
                  ? "—"
                  : `${job.progress}%`}
          </span>
        </div>

        {(job.status === "RUNNING" || job.status === "PENDING") && (
          <div
            className="mt-1 h-0.5 rounded-full overflow-hidden"
            style={{ background: "#1E1E2E" }}
          >
            <motion.div
              className="h-full rounded-full"
              style={{ background: "#7C3AED" }}
              initial={{ width: 0 }}
              animate={{ width: `${job.progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        )}
      </div>

      {/* Status icon / cancel */}
      <div className="shrink-0">
        {job.status === "DONE" && (
          <CheckCircle size={11} className="text-emerald-500" />
        )}
        {job.status === "FAILED" && (
          <AlertCircle size={11} className="text-red-500" />
        )}
        {job.status === "RUNNING" && (
          <Loader2 size={11} className="text-purple-400 animate-spin" />
        )}
        {(job.status === "PENDING" || job.status === "RUNNING") && (
          <button
            onClick={() => onCancel(job.id)}
            className="ml-1 text-[#2a2a4a] hover:text-[#5a5a7a] transition-colors"
          >
            <X size={10} />
          </button>
        )}
      </div>
    </motion.div>
  );
}

// ── ExportDialog ──────────────────────────────────────────────────────────

function ExportDialog({
  tracks,
  durationSec,
  projectId: _projectId,
  onClose,
}: {
  tracks: Track[];
  durationSec: number;
  projectId?: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("mp4");
  const [resolution, setResolution] = useState<ExportResolution>("1080p");
  const [quality, setQuality] = useState(80);
  const [fps, setFps] = useState<24 | 30 | 60>(30);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const currentJobId = useRef<string | null>(null);

  const estimatedSizeMB = estimateFileSizeMB(durationSec, format, resolution, quality);
  const estimatedTimeSec = estimateExportTimeSec(durationSec, resolution, fps);

  const handleExport = async () => {
    setIsExporting(true);
    setProgress(null);
    setOutputUrl(null);

    const jobId = await exportService.export(
      {
        projectId: _projectId ?? "local",
        tracks,
        durationSec,
        format,
        resolution,
        fps,
        quality,
        watermark: !_projectId ? "Quantedits — quantedits.io" : undefined,
        includeAudio: true,
      },
      (p) => {
        setProgress(p);
        if (p.status === "DONE" && p.outputUrl) {
          setOutputUrl(p.outputUrl);
          setIsExporting(false);
        }
        if (p.status === "FAILED" || p.status === "CANCELLED") {
          setIsExporting(false);
        }
      },
    );

    currentJobId.current = jobId;
  };

  const handleCancel = () => {
    if (currentJobId.current) {
      exportService.cancel(currentJobId.current);
    }
    setIsExporting(false);
  };

  const handleDownload = () => {
    if (!outputUrl) return;
    const a = document.createElement("a");
    a.href = outputUrl;
    a.download = `quantedits-export.${getFileExtension(format)}`;
    a.click();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ scale: 0.92, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 12 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="rounded-2xl overflow-hidden"
        style={{
          background: "#13131A",
          border: "1px solid #1E1E2E",
          width: "min(480px, 94vw)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-2 px-5 py-3"
          style={{ borderBottom: "1px solid #1E1E2E" }}
        >
          <Film size={14} className="text-purple-400" />
          <span className="text-sm font-semibold text-[#E8E8F0]">
            Export Video
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-[#3a3a5a] hover:text-[#8888aa] transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex flex-col gap-5">
          {/* Format */}
          <SettingSection label="Format">
            <div className="grid grid-cols-3 gap-2">
              {FORMAT_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => !preset.pro && setFormat(preset.value)}
                  disabled={isExporting || preset.pro}
                  title={preset.description}
                  className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg text-center transition-colors relative"
                  style={{
                    background:
                      format === preset.value ? "#7C3AED20" : "#0D0D11",
                    border: `1px solid ${
                      format === preset.value ? "#7C3AED" : "#1E1E2E"
                    }`,
                    color:
                      format === preset.value
                        ? "#a78bfa"
                        : preset.pro
                          ? "#2a2a4a"
                          : "#5a5a7a",
                    opacity: preset.pro ? 0.6 : 1,
                  }}
                >
                  <span className="text-xs font-medium">{preset.label}</span>
                  {preset.pro && (
                    <span
                      className="text-[8px] px-1 py-0.5 rounded absolute -top-1 -right-1"
                      style={{ background: "#F59E0B", color: "#000" }}
                    >
                      PRO
                    </span>
                  )}
                </button>
              ))}
            </div>
          </SettingSection>

          {/* Resolution */}
          <SettingSection label="Resolution">
            <div className="grid grid-cols-3 gap-2">
              {RESOLUTION_PRESETS.map((preset) => (
                <button
                  key={String(preset.value)}
                  onClick={() => setResolution(preset.value)}
                  disabled={isExporting}
                  title={preset.description}
                  className="px-2 py-2 rounded-lg text-xs text-center transition-colors"
                  style={{
                    background:
                      resolution === preset.value ? "#7C3AED20" : "#0D0D11",
                    border: `1px solid ${
                      resolution === preset.value ? "#7C3AED" : "#1E1E2E"
                    }`,
                    color:
                      resolution === preset.value ? "#a78bfa" : "#5a5a7a",
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SettingSection>

          {/* FPS + Quality */}
          <div className="grid grid-cols-2 gap-4">
            <SettingSection label="Frame Rate">
              <div className="flex gap-2">
                {([24, 30, 60] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFps(f)}
                    disabled={isExporting}
                    className="flex-1 py-1.5 rounded-lg text-xs transition-colors"
                    style={{
                      background: fps === f ? "#7C3AED20" : "#0D0D11",
                      border: `1px solid ${fps === f ? "#7C3AED" : "#1E1E2E"}`,
                      color: fps === f ? "#a78bfa" : "#5a5a7a",
                    }}
                  >
                    {f}fps
                  </button>
                ))}
              </div>
            </SettingSection>

            <SettingSection label={`Quality: ${quality}%`}>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                disabled={isExporting}
                className="w-full accent-violet-500 h-1"
              />
            </SettingSection>
          </div>

          {/* Estimates */}
          <div
            className="rounded-lg px-3 py-2 flex items-center gap-4"
            style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
          >
            <div className="flex items-center gap-1.5">
              <HardDrive size={11} className="text-[#5a5a7a]" />
              <span className="text-[11px] text-[#5a5a7a]">
                ~{estimatedSizeMB < 1
                  ? `${Math.round(estimatedSizeMB * 1000)}KB`
                  : `${estimatedSizeMB.toFixed(0)}MB`}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock size={11} className="text-[#5a5a7a]" />
              <span className="text-[11px] text-[#5a5a7a]">
                ~{estimatedTimeSec < 60
                  ? `${Math.round(estimatedTimeSec)}s`
                  : `${Math.round(estimatedTimeSec / 60)}m`}
              </span>
            </div>
          </div>

          {/* Progress bar */}
          <AnimatePresence>
            {progress && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span style={{ color: "#E8E8F0" }}>
                      {progress.status === "PREPARING"
                        ? "Preparing…"
                        : progress.status === "ENCODING"
                          ? `Encoding frame ${progress.framesEncoded}/${progress.totalFrames}`
                          : progress.status === "FINALISING"
                            ? "Finalising…"
                            : progress.status === "DONE"
                              ? "Complete!"
                              : progress.status === "FAILED"
                                ? `Failed: ${progress.errorMessage ?? "Unknown error"}`
                                : "Cancelled"}
                    </span>
                    <span style={{ color: "#5a5a7a" }}>
                      {progress.progress}%
                    </span>
                  </div>
                  <div
                    className="h-1.5 rounded-full overflow-hidden"
                    style={{ background: "#1E1E2E" }}
                  >
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        background:
                          progress.status === "DONE"
                            ? "#10b981"
                            : progress.status === "FAILED"
                              ? "#ef4444"
                              : "#7C3AED",
                      }}
                      animate={{ width: `${progress.progress}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  {progress.etaSec !== null && progress.status === "ENCODING" && (
                    <span className="text-[10px] text-[#3a3a5a]">
                      ETA:{" "}
                      {progress.etaSec < 60
                        ? `${Math.round(progress.etaSec)}s`
                        : `${Math.round(progress.etaSec / 60)}m ${Math.round(progress.etaSec % 60)}s`}
                    </span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div
          className="flex items-center gap-2 px-5 py-3"
          style={{ borderTop: "1px solid #1E1E2E" }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs transition-colors"
            style={{
              background: "#0D0D11",
              border: "1px solid #1E1E2E",
              color: "#5a5a7a",
            }}
          >
            {isExporting ? "Hide" : "Cancel"}
          </button>

          <div className="flex-1" />

          {outputUrl ? (
            <button
              onClick={handleDownload}
              className="px-4 py-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
              style={{ background: "#10b981", color: "#fff" }}
            >
              <Download size={12} />
              Download
            </button>
          ) : isExporting ? (
            <button
              onClick={handleCancel}
              className="px-4 py-2 rounded-lg text-xs transition-colors"
              style={{
                background: "#ef444420",
                border: "1px solid #ef4444",
                color: "#ef4444",
              }}
            >
              Stop Export
            </button>
          ) : (
            <button
              onClick={handleExport}
              className="px-4 py-2 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
              style={{ background: "#7C3AED", color: "#fff" }}
            >
              <Film size={12} />
              Export Now
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function SettingSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-medium text-[#5a5a7a] uppercase tracking-widest">
        {label}
      </span>
      {children}
    </div>
  );
}
