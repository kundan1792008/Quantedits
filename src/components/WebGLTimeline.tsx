"use client";

/**
 * WebGLTimeline — React wrapper for TimelineRenderer
 *
 * Renders the full timeline UI including:
 *   - Canvas-based tracks
 *   - Transport controls (play, pause, rewind, loop)
 *   - Tool switcher (select, razor, hand)
 *   - Zoom slider
 *   - FPS selector
 *   - Keyframe editor toggle
 *   - Track management (add, mute, solo)
 */

import {
  useRef,
  useEffect,
  useCallback,
  useState,
  useId,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Scissors,
  Hand,
  MousePointer2,
  Volume2,
  VolumeX,
  RepeatIcon,
  ZoomIn,
  ZoomOut,
  SlidersHorizontal,
  Plus,
  Video,
  Music,
  Type,
  Sparkles,
} from "lucide-react";
import {
  TimelineRenderer,
  type Track,
  type ToolMode,
  type TimelineEvent,
  createDefaultTracks,
  formatTimecode,
} from "@/engine/TimelineRenderer";

// ── Types ─────────────────────────────────────────────────────────────────

interface WebGLTimelineProps {
  timelineId?: string;
  initialTracks?: Track[];
  durationSec?: number;
  fps?: 24 | 30 | 60;
  onEvent?: (event: TimelineEvent) => void;
  onTracksChange?: (tracks: Track[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const TOOL_BUTTONS: Array<{
  tool: ToolMode;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  shortcut: string;
}> = [
  { tool: "SELECT", Icon: MousePointer2, label: "Select", shortcut: "S" },
  { tool: "RAZOR", Icon: Scissors, label: "Razor", shortcut: "R" },
  { tool: "HAND", Icon: Hand, label: "Hand", shortcut: "H" },
];

const TRACK_TYPE_ICONS: Record<
  Track["type"],
  React.ComponentType<{ size?: number; className?: string }>
> = {
  VIDEO: Video,
  AUDIO: Music,
  TEXT: Type,
  AI_EFFECT: Sparkles,
};

const TRACK_TYPE_COLORS: Record<Track["type"], string> = {
  VIDEO: "#a78bfa",
  AUDIO: "#67e8f9",
  TEXT: "#f9a8d4",
  AI_EFFECT: "#fcd34d",
};

// ── Component ─────────────────────────────────────────────────────────────

export default function WebGLTimeline({
  timelineId = "default",
  initialTracks,
  durationSec = 60,
  fps = 30,
  onEvent,
  onTracksChange,
}: WebGLTimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationId = useId();

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tool, setTool] = useState<ToolMode>("SELECT");
  const [zoom, setZoom] = useState(1);
  const [showKeyframes, setShowKeyframes] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [currentFps, setCurrentFps] = useState<24 | 30 | 60>(fps);
  const [tracks, setTracks] = useState<Track[]>(
    initialTracks ?? createDefaultTracks(timelineId),
  );

  // ── Renderer initialisation ─────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const renderer = new TimelineRenderer(canvas, dpr);
    rendererRef.current = renderer;

    renderer.setTracks(tracks);
    renderer.setDuration(durationSec);
    renderer.setFps(currentFps);
    renderer.startLoop();

    const unsubscribe = renderer.on((event) => {
      if (event.type === "PLAYHEAD_SEEK") {
        setCurrentTime(event.timeSec);
        setIsPlaying((event.timeSec < durationSec));
      }
      if (event.type === "ZOOM_CHANGE") {
        setZoom(event.zoom);
      }
      onEvent?.(event);
    });

    return () => {
      unsubscribe();
      renderer.destroy();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineId]);

  // ── Sync tracks to renderer ─────────────────────────────────────────────

  useEffect(() => {
    rendererRef.current?.setTracks(tracks);
    onTracksChange?.(tracks);
  }, [tracks, onTracksChange]);

  // ── Resize observer ─────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        rendererRef.current?.resize(width, height);
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // ── Transport controls ──────────────────────────────────────────────────

  const handlePlay = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer["playhead"].isPlaying = true;
    renderer.invalidate();
    setIsPlaying(true);
  }, []);

  const handlePause = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer["playhead"].isPlaying = false;
    setIsPlaying(false);
  }, []);

  const handleRewind = useCallback(() => {
    rendererRef.current?.seek(0);
    setCurrentTime(0);
    setIsPlaying(false);
  }, []);

  const handleSkipForward = useCallback(() => {
    rendererRef.current?.seek(durationSec);
    setCurrentTime(durationSec);
    setIsPlaying(false);
  }, [durationSec]);

  const handleToolChange = useCallback((newTool: ToolMode) => {
    rendererRef.current?.setTool(newTool);
    setTool(newTool);
  }, []);

  const handleZoomIn = useCallback(() => {
    const newZoom = Math.min(100, zoom * 1.5);
    rendererRef.current?.setZoom(newZoom);
    setZoom(newZoom);
  }, [zoom]);

  const handleZoomOut = useCallback(() => {
    const newZoom = Math.max(0.1, zoom / 1.5);
    rendererRef.current?.setZoom(newZoom);
    setZoom(newZoom);
  }, [zoom]);

  const handleLoopToggle = useCallback(() => {
    const next = !loopEnabled;
    rendererRef.current?.setLoop(next);
    setLoopEnabled(next);
  }, [loopEnabled]);

  const handleFpsChange = useCallback((newFps: 24 | 30 | 60) => {
    rendererRef.current?.setFps(newFps);
    setCurrentFps(newFps);
  }, []);

  const handleKeyframeEditorToggle = useCallback(() => {
    const next = !showKeyframes;
    rendererRef.current?.setShowKeyframeEditor(next);
    setShowKeyframes(next);
  }, [showKeyframes]);

  // ── Track management ────────────────────────────────────────────────────

  const handleAddTrack = useCallback((type: Track["type"]) => {
    setTracks((prev) => {
      const maxIndex = prev.reduce((m, t) => Math.max(m, t.index), -1);
      const typeNames: Record<Track["type"], string> = {
        VIDEO: "Video",
        AUDIO: "Audio",
        TEXT: "Text",
        AI_EFFECT: "AI FX",
      };
      const newTrack: Track = {
        id: `track-${Date.now()}`,
        timelineId,
        type,
        name: `${typeNames[type]} ${maxIndex + 2}`,
        index: maxIndex + 1,
        muted: false,
        solo: false,
        locked: false,
        volume: 1,
        clips: [],
      };
      return [...prev, newTrack];
    });
  }, [timelineId]);

  const handleToggleMute = useCallback((trackId: string) => {
    setTracks((prev) =>
      prev.map((t) =>
        t.id === trackId ? { ...t, muted: !t.muted } : t,
      ),
    );
    const track = tracks.find((t) => t.id === trackId);
    if (track) {
      rendererRef.current?.setTrackMuted(trackId, !track.muted);
    }
  }, [tracks]);

  const handleToggleSolo = useCallback((trackId: string) => {
    setTracks((prev) =>
      prev.map((t) =>
        t.id === trackId ? { ...t, solo: !t.solo } : t,
      ),
    );
    const track = tracks.find((t) => t.id === trackId);
    if (track) {
      rendererRef.current?.setTrackSolo(trackId, !track.solo);
    }
  }, [tracks]);

  // ── Render ───────────────────────────────────────────────────────────────

  const sortedTracks = [...tracks].sort((a, b) => a.index - b.index);
  const timecode = formatTimecode(currentTime, currentFps);

  return (
    <div
      className="flex flex-col h-full select-none"
      style={{ background: "#0D0D11" }}
    >
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 px-3 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        {/* Transport */}
        <div className="flex items-center gap-1">
          <ToolbarButton onClick={handleRewind} title="Rewind to start">
            <SkipBack size={13} />
          </ToolbarButton>

          <AnimatePresence mode="wait">
            {isPlaying ? (
              <motion.div key="pause" initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }}>
                <ToolbarButton
                  onClick={handlePause}
                  title="Pause"
                  highlight
                >
                  <Pause size={13} />
                </ToolbarButton>
              </motion.div>
            ) : (
              <motion.div key="play" initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }}>
                <ToolbarButton
                  onClick={handlePlay}
                  title="Play"
                  highlight
                >
                  <Play size={13} />
                </ToolbarButton>
              </motion.div>
            )}
          </AnimatePresence>

          <ToolbarButton onClick={handleSkipForward} title="Skip to end">
            <SkipForward size={13} />
          </ToolbarButton>

          <ToolbarButton
            onClick={handleLoopToggle}
            title="Toggle loop"
            active={loopEnabled}
          >
            <RepeatIcon size={13} />
          </ToolbarButton>
        </div>

        {/* Timecode */}
        <div
          className="px-2 py-0.5 rounded font-mono text-xs"
          style={{
            background: "#0a0a14",
            border: "1px solid #1E1E2E",
            color: "#a78bfa",
            minWidth: 92,
            textAlign: "center",
            letterSpacing: "0.05em",
          }}
        >
          {timecode}
        </div>

        {/* Tool switcher */}
        <div
          className="flex items-center gap-0.5 px-1 py-0.5 rounded"
          style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
        >
          {TOOL_BUTTONS.map(({ tool: t, Icon, label, shortcut }) => (
            <button
              key={t}
              onClick={() => handleToolChange(t)}
              title={`${label} (${shortcut})`}
              className="flex items-center justify-center w-6 h-6 rounded transition-colors"
              style={{
                background: tool === t ? "#7C3AED" : "transparent",
                color: tool === t ? "#fff" : "#5a5a7a",
              }}
            >
              <Icon size={12} />
            </button>
          ))}
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-1">
          <ToolbarButton onClick={handleZoomOut} title="Zoom out">
            <ZoomOut size={12} />
          </ToolbarButton>
          <span
            className="text-[10px] font-mono"
            style={{ color: "#5a5a7a", minWidth: 36, textAlign: "center" }}
          >
            {zoom < 1
              ? `${Math.round(zoom * 100)}%`
              : `${zoom.toFixed(zoom < 10 ? 1 : 0)}x`}
          </span>
          <ToolbarButton onClick={handleZoomIn} title="Zoom in">
            <ZoomIn size={12} />
          </ToolbarButton>
        </div>

        {/* FPS selector */}
        <div
          className="flex items-center gap-0.5 px-1 py-0.5 rounded"
          style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
        >
          {([24, 30, 60] as const).map((f) => (
            <button
              key={f}
              onClick={() => handleFpsChange(f)}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors"
              style={{
                background: currentFps === f ? "#1E1E40" : "transparent",
                color: currentFps === f ? "#a78bfa" : "#5a5a7a",
              }}
            >
              {f}fps
            </button>
          ))}
        </div>

        {/* Keyframe editor toggle */}
        <ToolbarButton
          onClick={handleKeyframeEditorToggle}
          title="Keyframe editor"
          active={showKeyframes}
        >
          <SlidersHorizontal size={12} />
        </ToolbarButton>

        {/* Add track menu */}
        <AddTrackMenu onAdd={handleAddTrack} />
      </div>

      {/* ── Main area: track labels + canvas ──────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track labels sidebar */}
        <TrackLabelSidebar
          tracks={sortedTracks}
          onToggleMute={handleToggleMute}
          onToggleSolo={handleToggleSolo}
        />

        {/* Canvas */}
        <div
          ref={containerRef}
          className="flex-1 relative"
          style={{ background: "#0D0D11" }}
        >
          <canvas
            ref={canvasRef}
            id={animationId}
            className="w-full h-full"
            style={{ display: "block" }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function ToolbarButton({
  onClick,
  title,
  children,
  active = false,
  highlight = false,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
  active?: boolean;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center justify-center w-6 h-6 rounded transition-colors"
      style={{
        background: highlight
          ? "#7C3AED"
          : active
            ? "#1E1E40"
            : "transparent",
        color: highlight ? "#fff" : active ? "#a78bfa" : "#5a5a7a",
        border: active && !highlight ? "1px solid #3a3a6a" : "1px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

function AddTrackMenu({
  onAdd,
}: {
  onAdd: (type: Track["type"]) => void;
}) {
  const [open, setOpen] = useState(false);

  const options: Array<{ type: Track["type"]; label: string; color: string }> = [
    { type: "VIDEO", label: "Video Track", color: TRACK_TYPE_COLORS.VIDEO },
    { type: "AUDIO", label: "Audio Track", color: TRACK_TYPE_COLORS.AUDIO },
    { type: "TEXT", label: "Text Track", color: TRACK_TYPE_COLORS.TEXT },
    { type: "AI_EFFECT", label: "AI Effect Track", color: TRACK_TYPE_COLORS.AI_EFFECT },
  ];

  return (
    <div className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Add track"
        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors"
        style={{
          background: open ? "#1E1E40" : "#13131A",
          border: "1px solid #1E1E2E",
          color: "#5a5a7a",
        }}
      >
        <Plus size={10} />
        Add Track
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.95 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 bottom-full mb-1 rounded-lg overflow-hidden z-50"
            style={{
              background: "#13131A",
              border: "1px solid #1E1E2E",
              minWidth: 160,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            {options.map(({ type, label, color }) => {
              const Icon = TRACK_TYPE_ICONS[type];
              return (
                <button
                  key={type}
                  onClick={() => {
                    onAdd(type);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-white/5 transition-colors"
                  style={{ color: "#E8E8F0" }}
                >
                  <span style={{ color }}><Icon size={11} /></span>
                  {label}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Close on outside click */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function TrackLabelSidebar({
  tracks,
  onToggleMute,
  onToggleSolo,
}: {
  tracks: Track[];
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
}) {
  const TRACK_HEIGHT = 52;
  const RULER_HEIGHT = 28;

  return (
    <div
      className="shrink-0 flex flex-col"
      style={{
        width: 90,
        borderRight: "1px solid #1E1E2E",
        paddingTop: RULER_HEIGHT,
      }}
    >
      {tracks.map((track) => {
        const Icon = TRACK_TYPE_ICONS[track.type];
        const color = TRACK_TYPE_COLORS[track.type];

        return (
          <div
            key={track.id}
            className="flex flex-col justify-center gap-1 px-2"
            style={{
              height: TRACK_HEIGHT,
              borderBottom: "1px solid #1E1E2E",
              background: "#0D0D11",
            }}
          >
            <div className="flex items-center gap-1">
              <span style={{ color }}><Icon size={10} /></span>
              <span
                className="text-[10px] font-mono truncate flex-1"
                style={{ color }}
              >
                {track.name.length > 7
                  ? track.name.slice(0, 6) + "…"
                  : track.name}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => onToggleMute(track.id)}
                title={track.muted ? "Unmute" : "Mute"}
                className="text-[9px] font-bold px-1 rounded transition-colors"
                style={{
                  background: track.muted ? "#ef444420" : "transparent",
                  color: track.muted ? "#ef4444" : "#2a2a4a",
                  border: `1px solid ${track.muted ? "#ef4444" : "#1E1E2E"}`,
                }}
              >
                M
              </button>
              <button
                onClick={() => onToggleSolo(track.id)}
                title={track.solo ? "Un-solo" : "Solo"}
                className="text-[9px] font-bold px-1 rounded transition-colors"
                style={{
                  background: track.solo ? "#f59e0b20" : "transparent",
                  color: track.solo ? "#f59e0b" : "#2a2a4a",
                  border: `1px solid ${track.solo ? "#f59e0b" : "#1E1E2E"}`,
                }}
              >
                S
              </button>
              {(track.type === "AUDIO" || track.type === "VIDEO") && (
                <VolumeIcon muted={track.muted} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VolumeIcon({ muted }: { muted: boolean }) {
  return muted ? (
    <VolumeX size={9} className="text-[#3a3a5a]" />
  ) : (
    <Volume2 size={9} className="text-[#3a3a5a]" />
  );
}
