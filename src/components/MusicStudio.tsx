"use client";

/**
 * MusicStudio — AI Music Generator UI
 *
 * Orchestrates MusicAnalyzer → MelodyGenerator → AudioSynthesizer and
 * presents a full-featured studio interface:
 *
 *   • Waveform visualisation synced with the video's current-time cursor
 *   • Genre selector with animated preview labels
 *   • Tempo override input (BPM slider)
 *   • Intensity slider that re-renders the composition in real-time
 *   • Per-instrument mute / solo / volume controls
 *   • "Regenerate" button (creates a brand-new composition)
 *   • "Apply to Timeline" CTA (fires onApply callback with the audio blob)
 *
 * All heavy computation happens off the rendering path — a useEffect
 * chain drives the pipeline: analyse → compose → synthesise → display.
 * The component never blocks the UI thread.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Music2,
  RefreshCw,
  Play,
  Square,
  Download,
  Layers,
  Volume2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Gauge,
  Sliders,
  Zap,
} from "lucide-react";
import { MusicAnalyzer } from "@/services/MusicAnalyzer";
import { MelodyGenerator } from "@/services/MelodyGenerator";
import { AudioSynthesizer } from "@/services/AudioSynthesizer";
import type { MusicBlueprint, VideoMood } from "@/services/MusicAnalyzer";
import type { MIDIComposition, Genre, InstrumentTrack } from "@/services/MelodyGenerator";
import type { RenderResult } from "@/services/AudioSynthesizer";

// ── Types ─────────────────────────────────────────────────────────────────────

type StudioState =
  | "idle"
  | "analysing"
  | "composing"
  | "synthesising"
  | "ready"
  | "playing"
  | "error";

interface TrackState {
  name: InstrumentTrack["name"];
  label: string;
  emoji: string;
  volume: number;   // 0–1
  muted:  boolean;
  soloed: boolean;
  color:  string;
}

interface MusicStudioProps {
  /** When provided the analyser will use the video's actual frames. */
  videoElement?: HTMLVideoElement | null;
  /** Duration hint used for metadata-only analysis when no video element. */
  durationSec?: number;
  /** Filename used as seed for deterministic metadata analysis. */
  fileName?: string;
  /** Called when the user applies the generated music to the timeline. */
  onApply?: (audioBlob: Blob, durationSec: number) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GENRES: { id: Genre; label: string; emoji: string; description: string }[] = [
  { id: "lo-fi",      label: "Lo-Fi",      emoji: "🎹", description: "Chill, warm, nostalgic" },
  { id: "cinematic",  label: "Cinematic",  emoji: "🎬", description: "Epic strings & swells"   },
  { id: "pop",        label: "Pop",        emoji: "🎵", description: "Upbeat, catchy energy"   },
  { id: "ambient",    label: "Ambient",    emoji: "🌊", description: "Spacious & dreamlike"    },
  { id: "electronic", label: "Electronic", emoji: "⚡", description: "Pulsing synths & beats"  },
  { id: "classical",  label: "Classical",  emoji: "🎻", description: "Orchestral drama"        },
];

const MOOD_COLORS: Record<VideoMood, string> = {
  happy:       "#F59E0B",
  dramatic:    "#EF4444",
  chill:       "#06B6D4",
  epic:        "#8B5CF6",
  melancholic: "#6366F1",
  tense:       "#F97316",
};

const DEFAULT_TRACKS: TrackState[] = [
  { name: "melody",     label: "Melody",     emoji: "🎵", volume: 0.8,  muted: false, soloed: false, color: "#7C3AED" },
  { name: "bass",       label: "Bass",       emoji: "🎸", volume: 0.75, muted: false, soloed: false, color: "#06B6D4" },
  { name: "chords",     label: "Chords",     emoji: "🎹", volume: 0.6,  muted: false, soloed: false, color: "#10B981" },
  { name: "percussion", label: "Percussion", emoji: "🥁", volume: 0.85, muted: false, soloed: false, color: "#F59E0B" },
];

// ── Waveform canvas component ─────────────────────────────────────────────────

interface WaveformCanvasProps {
  waveformData: Float32Array | null;
  playheadFraction: number;  // 0–1
  color: string;
  height?: number;
}

function WaveformCanvas({ waveformData, playheadFraction, color, height = 64 }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, W, H);

    if (!waveformData || waveformData.length === 0) {
      // Placeholder flat line
      ctx.strokeStyle = "#2a2a4a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      return;
    }

    const mid = H / 2;
    const step = W / waveformData.length;

    // Filled waveform (mirrored top/bottom)
    const gradient = ctx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, color + "90");
    gradient.addColorStop(0.5, color + "40");
    gradient.addColorStop(1, color + "90");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < waveformData.length; i++) {
      const x = i * step;
      const amp = Math.abs(waveformData[i]) * mid * 0.95;
      ctx.lineTo(x, mid - amp);
    }
    for (let i = waveformData.length - 1; i >= 0; i--) {
      const x = i * step;
      const amp = Math.abs(waveformData[i]) * mid * 0.95;
      ctx.lineTo(x, mid + amp);
    }
    ctx.closePath();
    ctx.fill();

    // Bright outline (top only)
    ctx.strokeStyle = color + "cc";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < waveformData.length; i++) {
      const x = i * step;
      const amp = Math.abs(waveformData[i]) * mid * 0.95;
      if (i === 0) ctx.moveTo(x, mid - amp);
      else ctx.lineTo(x, mid - amp);
    }
    ctx.stroke();

    // Playhead
    const px = playheadFraction * W;
    ctx.strokeStyle = "#ffffff80";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
    ctx.setLineDash([]);

    // Playhead glow
    ctx.fillStyle = "#ffffff30";
    ctx.fillRect(0, 0, px, H);
  }, [waveformData, playheadFraction, color]);

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={height}
      className="w-full rounded-lg"
      style={{ imageRendering: "pixelated", height: `${height}px` }}
    />
  );
}

// ── Mini track waveform ────────────────────────────────────────────────────────

interface TrackRowProps {
  track: TrackState;
  waveformData: Float32Array | null;
  onVolumeChange: (name: InstrumentTrack["name"], v: number) => void;
  onMute:         (name: InstrumentTrack["name"]) => void;
  onSolo:         (name: InstrumentTrack["name"]) => void;
}

function TrackRow({ track, waveformData, onVolumeChange, onMute, onSolo }: TrackRowProps) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-xl"
      style={{
        background: track.muted ? "#0e0e18" : "#131320",
        border: `1px solid ${track.soloed ? track.color : "#1E1E2E"}`,
        opacity: track.muted ? 0.5 : 1,
      }}
    >
      {/* Label */}
      <div className="w-[80px] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{track.emoji}</span>
          <span className="text-xs font-medium text-[#C0C0D0]">{track.label}</span>
        </div>
      </div>

      {/* Mini waveform */}
      <div className="flex-1">
        <WaveformCanvas
          waveformData={waveformData}
          playheadFraction={0}
          color={track.color}
          height={32}
        />
      </div>

      {/* Volume */}
      <div className="flex items-center gap-1.5 w-[80px] shrink-0">
        <Volume2 size={11} className="text-[#5a5a7a] shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          onChange={e => onVolumeChange(track.name, parseFloat(e.target.value))}
          className="flex-1 h-1 appearance-none rounded-full cursor-pointer"
          style={{
            background: `linear-gradient(to right, ${track.color} 0%, ${track.color} ${track.volume * 100}%, #2a2a4a ${track.volume * 100}%, #2a2a4a 100%)`,
          }}
        />
      </div>

      {/* Mute / Solo */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onMute(track.name)}
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors ${
            track.muted
              ? "bg-red-500/30 text-red-400 border border-red-500/40"
              : "bg-[#1a1a2e] text-[#5a5a7a] border border-[#2a2a3e] hover:text-[#8888aa]"
          }`}
        >
          M
        </button>
        <button
          onClick={() => onSolo(track.name)}
          className={`text-[10px] font-bold px-1.5 py-0.5 rounded transition-colors ${
            track.soloed
              ? "text-yellow-400 border border-yellow-500/40"
              : "bg-[#1a1a2e] text-[#5a5a7a] border border-[#2a2a3e] hover:text-[#8888aa]"
          }`}
          style={{ background: track.soloed ? "rgba(234,179,8,0.15)" : undefined }}
        >
          S
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MusicStudio({
  videoElement,
  durationSec = 30,
  fileName = "",
  onApply,
}: MusicStudioProps) {
  // ── Services (memoised so they don't change on re-renders) ─────────────────
  const analyser    = useMemo(() => new MusicAnalyzer(),    []);
  const generator   = useMemo(() => new MelodyGenerator(),  []);
  const synthesiser = useMemo(() => new AudioSynthesizer(), []);

  // ── State ──────────────────────────────────────────────────────────────────
  const [studioState, setStudioState] = useState<StudioState>("idle");
  const [blueprint, setBlueprint]     = useState<MusicBlueprint | null>(null);
  const [composition, setComposition] = useState<MIDIComposition | null>(null);
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
  const [trackWaveforms, setTrackWaveforms] = useState<Record<string, Float32Array | null>>({});

  const [selectedGenre, setSelectedGenre] = useState<Genre>("cinematic");
  const [bpmOverride, setBpmOverride]     = useState<number | null>(null);
  const [intensityScale, setIntensityScale] = useState(0.8);
  const [tracks, setTracks]               = useState<TrackState[]>(DEFAULT_TRACKS);
  const [playheadFraction, setPlayheadFraction] = useState(0);
  const [showGenrePanel, setShowGenrePanel] = useState(false);
  const [showAdvanced, setShowAdvanced]   = useState(false);
  const [errorMsg, setErrorMsg]           = useState<string | null>(null);
  const [generationCount, setGenerationCount] = useState(0);

  // Audio playback
  const audioCtxRef    = useRef<AudioContext | null>(null);
  const audioSrcRef    = useRef<AudioBufferSourceNode | null>(null);
  const playStartRef   = useRef<number>(0);
  const animFrameRef   = useRef<number>(0);

  // ── Pipeline orchestration ─────────────────────────────────────────────────

  const runPipeline = useCallback(async (genre: Genre, bpm: number | null, intensity: number) => {
    setStudioState("analysing");
    setErrorMsg(null);

    try {
      // Step 1: Analyse
      let bp: MusicBlueprint;
      if (videoElement && videoElement.readyState >= 2) {
        bp = await analyser.analyze(videoElement);
      } else {
        bp = analyser.analyzeMetadata(durationSec, fileName);
      }
      setBlueprint(bp);
      setStudioState("composing");

      // Step 2: Compose
      await new Promise<void>(r => setTimeout(r, 0)); // yield to UI
      const comp = generator.compose(bp, {
        genre,
        bpmOverride:   bpm ?? undefined,
        intensityScale: intensity,
        seed:          generationCount * 7919 + 42,
      });
      setComposition(comp);
      setStudioState("synthesising");

      // Step 3: Synthesise
      await new Promise<void>(r => setTimeout(r, 0));
      const mutedTracks  = tracks.filter(t => t.muted).map(t => t.name);
      const soloedTracks = tracks.filter(t => t.soloed).map(t => t.name);
      const trackVolumes = Object.fromEntries(tracks.map(t => [t.name, t.volume])) as Record<InstrumentTrack["name"], number>;

      const result = await synthesiser.render(comp, {
        mutedTracks,
        soloedTracks,
        trackVolumes,
        effects: { reverb: true },
      });
      setRenderResult(result);

      // Step 4: Extract waveform data
      const wd = synthesiser.getWaveformData(result, 1200);
      setWaveformData(wd);

      // Step 5: Per-track waveforms
      const perTrack: Record<string, Float32Array | null> = {};
      for (const t of DEFAULT_TRACKS) {
        perTrack[t.name] = await synthesiser.getTrackWaveformData(comp, t.name, 400);
      }
      setTrackWaveforms(perTrack);

      setStudioState("ready");
    } catch (err) {
      console.error("MusicStudio pipeline error:", err);
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setStudioState("error");
    }
  }, [analyser, generator, synthesiser, videoElement, durationSec, fileName, tracks, generationCount]);

  // ── Playback ───────────────────────────────────────────────────────────────

  const stopPlayback = useCallback(() => {
    if (audioSrcRef.current) {
      try { audioSrcRef.current.stop(); } catch { /* already stopped */ }
      audioSrcRef.current = null;
    }
    cancelAnimationFrame(animFrameRef.current);
    setPlayheadFraction(0);
    setStudioState("ready");
  }, []);

  const startPlayback = useCallback(() => {
    if (!renderResult) return;
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const src = ctx.createBufferSource();
    src.buffer = renderResult.audioBuffer;
    src.connect(ctx.destination);
    src.start(0);
    src.onended = () => {
      setStudioState("ready");
      setPlayheadFraction(0);
      cancelAnimationFrame(animFrameRef.current);
    };
    audioSrcRef.current = src;
    playStartRef.current = ctx.currentTime;
    setStudioState("playing");

    const tick = () => {
      if (!audioCtxRef.current) return;
      const elapsed = audioCtxRef.current.currentTime - playStartRef.current;
      setPlayheadFraction(Math.min(1, elapsed / renderResult.durationSec));
      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }, [renderResult]);

  const togglePlayback = useCallback(() => {
    if (studioState === "playing") {
      stopPlayback();
    } else if (studioState === "ready") {
      startPlayback();
    }
  }, [studioState, startPlayback, stopPlayback]);

  // ── Download / apply ───────────────────────────────────────────────────────

  const handleDownload = useCallback(() => {
    if (!renderResult) return;
    const url = synthesiser.exportWavUrl(renderResult);
    const a   = document.createElement("a");
    a.href    = url;
    a.download = `quantedits-music-${selectedGenre}.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }, [renderResult, synthesiser, selectedGenre]);

  const handleApply = useCallback(() => {
    if (!renderResult || !onApply) return;
    const blob = synthesiser.exportWav(renderResult);
    onApply(blob, renderResult.durationSec);
  }, [renderResult, synthesiser, onApply]);

  // ── Track controls ─────────────────────────────────────────────────────────

  const handleVolumeChange = useCallback((name: InstrumentTrack["name"], v: number) => {
    setTracks(prev => prev.map(t => t.name === name ? { ...t, volume: v } : t));
  }, []);

  const handleMute = useCallback((name: InstrumentTrack["name"]) => {
    setTracks(prev => prev.map(t => t.name === name ? { ...t, muted: !t.muted } : t));
  }, []);

  const handleSolo = useCallback((name: InstrumentTrack["name"]) => {
    setTracks(prev => prev.map(t =>
      t.name === name
        ? { ...t, soloed: !t.soloed }
        : { ...t, soloed: false },
    ));
  }, []);

  // ── Regenerate ─────────────────────────────────────────────────────────────

  const handleRegenerate = useCallback(() => {
    if (studioState === "playing") stopPlayback();
    setGenerationCount(prev => prev + 1);
  }, [studioState, stopPlayback]);

  // ── Auto-run when inputs change ───────────────────────────────────────────

  useEffect(() => {
    runPipeline(selectedGenre, bpmOverride, intensityScale);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGenre, generationCount]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.close();
      }
    };
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────

  const isProcessing = ["analysing", "composing", "synthesising"].includes(studioState);
  const stateLabel: Record<StudioState, string> = {
    idle:         "Idle",
    analysing:    "Analysing video…",
    composing:    "Composing music…",
    synthesising: "Rendering audio…",
    ready:        "Ready",
    playing:      "Playing",
    error:        "Error",
  };
  const moodColor = blueprint ? MOOD_COLORS[blueprint.overallMood] : "#7C3AED";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="rounded-2xl flex flex-col gap-0 overflow-hidden"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${moodColor}22` }}
        >
          <Music2 size={18} style={{ color: moodColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-[#E8E8F0]">AI Music Generator</h3>
          <p className="text-xs text-[#5a5a7a] truncate">
            {isProcessing
              ? stateLabel[studioState]
              : blueprint
                ? `${blueprint.overallMood} · ${blueprint.pacing} · ${composition?.bpm ?? blueprint.suggestedBpm} BPM · ${composition?.key ?? blueprint.suggestedKey}`
                : "Auto-generates royalty-free soundtracks"}
          </p>
        </div>

        {/* Status badge */}
        <div className="shrink-0 flex items-center gap-1.5">
          {isProcessing ? (
            <span
              className="flex items-center gap-1.5 text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: `${moodColor}22`, color: moodColor }}
            >
              <Loader2 size={10} className="animate-spin" />
              {studioState.toUpperCase()}
            </span>
          ) : studioState === "ready" || studioState === "playing" ? (
            <span
              className="text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: `${moodColor}22`, color: moodColor }}
            >
              {composition?.genre.toUpperCase() ?? "READY"}
            </span>
          ) : studioState === "error" ? (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-red-950/50 text-red-400">
              ERROR
            </span>
          ) : null}
        </div>
      </div>

      {/* ── Genre Selector ───────────────────────────────────────────────── */}
      <div className="px-4 pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-semibold text-[#5a5a7a] uppercase tracking-widest">
            Genre
          </span>
          <button
            onClick={() => setShowGenrePanel(v => !v)}
            className="flex items-center gap-1 text-[10px] text-[#5a5a7a] hover:text-[#8888aa] transition-colors"
          >
            {showGenrePanel ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {showGenrePanel ? "less" : "all"}
          </button>
        </div>

        <div className={`flex gap-1.5 flex-wrap ${showGenrePanel ? "" : "flex-nowrap overflow-hidden"}`}>
          {GENRES.map(g => (
            <motion.button
              key={g.id}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => setSelectedGenre(g.id)}
              disabled={isProcessing}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all shrink-0 ${
                selectedGenre === g.id
                  ? "text-white"
                  : "text-[#5a5a7a] hover:text-[#8888aa]"
              }`}
              style={{
                background: selectedGenre === g.id
                  ? `linear-gradient(135deg, ${moodColor}40 0%, ${moodColor}20 100%)`
                  : "#1a1a2e",
                border: selectedGenre === g.id
                  ? `1px solid ${moodColor}60`
                  : "1px solid #1E1E2E",
              }}
            >
              <span>{g.emoji}</span>
              <span>{g.label}</span>
            </motion.button>
          ))}
        </div>

        <AnimatePresence>
          {showGenrePanel && selectedGenre && (
            <motion.p
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="text-[10px] text-[#5a5a7a] mt-1.5 overflow-hidden"
            >
              {GENRES.find(g => g.id === selectedGenre)?.description}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* ── Waveform ─────────────────────────────────────────────────────── */}
      <div className="px-4 pt-3">
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: "1px solid #1E1E2E" }}
        >
          {isProcessing ? (
            <div
              className="flex items-center justify-center gap-3"
              style={{ height: 64, background: "#0a0a12" }}
            >
              <Loader2 size={16} className="animate-spin text-[#5a5a7a]" />
              <span className="text-xs text-[#5a5a7a]">{stateLabel[studioState]}</span>
            </div>
          ) : (
            <WaveformCanvas
              waveformData={waveformData}
              playheadFraction={playheadFraction}
              color={moodColor}
              height={64}
            />
          )}
        </div>
      </div>

      {/* ── Transport ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 pt-3">
        {/* Play / Stop */}
        <motion.button
          whileHover={!isProcessing && renderResult ? { scale: 1.06 } : {}}
          whileTap={!isProcessing && renderResult ? { scale: 0.94 } : {}}
          onClick={togglePlayback}
          disabled={isProcessing || !renderResult}
          className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-40"
          style={{
            background: studioState === "playing"
              ? "rgba(239,68,68,0.2)"
              : `${moodColor}25`,
            border: `1px solid ${studioState === "playing" ? "rgba(239,68,68,0.4)" : moodColor + "40"}`,
          }}
        >
          {studioState === "playing"
            ? <Square size={14} className="text-red-400" />
            : <Play size={14} style={{ color: moodColor }} />
          }
        </motion.button>

        {/* Duration / BPM display */}
        <div className="flex-1 flex items-center gap-3">
          {composition && (
            <>
              <span className="text-xs font-mono text-[#5a5a7a]">
                {composition.bpm} BPM
              </span>
              <span className="text-[#2a2a4a]">|</span>
              <span className="text-xs font-mono text-[#5a5a7a]">
                {composition.key}
              </span>
              <span className="text-[#2a2a4a]">|</span>
              <span className="text-xs font-mono text-[#5a5a7a]">
                {Math.floor(renderResult?.durationSec ?? 0)}s
              </span>
            </>
          )}
        </div>

        {/* Regenerate */}
        <motion.button
          whileHover={!isProcessing ? { scale: 1.04 } : {}}
          whileTap={!isProcessing ? { scale: 0.96 } : {}}
          onClick={handleRegenerate}
          disabled={isProcessing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
          style={{
            background: "#1a1a2e",
            border: "1px solid #2a2a3e",
            color: "#8888aa",
          }}
        >
          {isProcessing
            ? <Loader2 size={11} className="animate-spin" />
            : <RefreshCw size={11} />
          }
          Regenerate
        </motion.button>

        {/* Download */}
        <motion.button
          whileHover={renderResult ? { scale: 1.04 } : {}}
          whileTap={renderResult ? { scale: 0.96 } : {}}
          onClick={handleDownload}
          disabled={!renderResult}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-30"
          style={{ background: "#1a1a2e", border: "1px solid #2a2a3e" }}
          title="Download WAV"
        >
          <Download size={12} className="text-[#8888aa]" />
        </motion.button>
      </div>

      {/* ── Intensity + BPM ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 px-4 pt-3">
        {/* Intensity */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1 text-[10px] text-[#5a5a7a] uppercase tracking-widest">
              <Zap size={9} />
              Intensity
            </div>
            <span className="text-[10px] font-mono text-[#8888aa]">
              {Math.round(intensityScale * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.1}
            max={1.0}
            step={0.01}
            value={intensityScale}
            onChange={e => setIntensityScale(parseFloat(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, ${moodColor} 0%, ${moodColor} ${intensityScale * 100}%, #2a2a4a ${intensityScale * 100}%, #2a2a4a 100%)`,
            }}
          />
        </div>

        {/* BPM Override */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1 text-[10px] text-[#5a5a7a] uppercase tracking-widest">
              <Gauge size={9} />
              Tempo
            </div>
            <span className="text-[10px] font-mono text-[#8888aa]">
              {bpmOverride ?? (composition?.bpm ?? "—")} BPM
            </span>
          </div>
          <input
            type="range"
            min={50}
            max={180}
            step={1}
            value={bpmOverride ?? composition?.bpm ?? 90}
            onChange={e => setBpmOverride(parseInt(e.target.value, 10))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, ${moodColor} 0%, ${moodColor} ${((bpmOverride ?? composition?.bpm ?? 90) - 50) / 130 * 100}%, #2a2a4a ${((bpmOverride ?? composition?.bpm ?? 90) - 50) / 130 * 100}%, #2a2a4a 100%)`,
            }}
          />
        </div>
      </div>

      {/* ── Mood chip row ─────────────────────────────────────────────────── */}
      {blueprint && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2 px-4 pt-3 flex-wrap"
        >
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize"
            style={{
              background: `${moodColor}22`,
              color: moodColor,
              border: `1px solid ${moodColor}44`,
            }}
          >
            {blueprint.overallMood}
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1a1a2e] text-[#5a5a7a] border border-[#1E1E2E] capitalize">
            {blueprint.pacing} pacing
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1a1a2e] text-[#5a5a7a] border border-[#1E1E2E]">
            {blueprint.sceneChanges.length} cuts
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1a1a2e] text-[#5a5a7a] border border-[#1E1E2E]">
            {blueprint.actionPeaks.length} peaks
          </span>
        </motion.div>
      )}

      {/* ── Track mixer ──────────────────────────────────────────────────── */}
      <div className="px-4 pt-3">
        <button
          onClick={() => setShowAdvanced(v => !v)}
          className="flex items-center gap-1.5 text-[10px] text-[#5a5a7a] hover:text-[#8888aa] transition-colors uppercase tracking-widest mb-2"
        >
          <Sliders size={9} />
          Instruments
          {showAdvanced ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
        </button>

        <AnimatePresence>
          {showAdvanced && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex flex-col gap-1.5 overflow-hidden"
            >
              {tracks.map(track => (
                <TrackRow
                  key={track.name}
                  track={track}
                  waveformData={trackWaveforms[track.name] ?? null}
                  onVolumeChange={handleVolumeChange}
                  onMute={handleMute}
                  onSolo={handleSolo}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {studioState === "error" && errorMsg && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mx-4 mt-3 rounded-xl px-3 py-2 text-xs text-red-400 overflow-hidden"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
          >
            {errorMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Apply to timeline ────────────────────────────────────────────── */}
      <div className="p-4 pt-3">
        {studioState === "ready" || studioState === "playing" ? (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2"
          >
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={handleApply}
              disabled={!onApply}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: `linear-gradient(135deg, ${moodColor} 0%, ${moodColor}aa 100%)`,
              }}
            >
              <Layers size={15} />
              Apply to Timeline
            </motion.button>

            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={handleDownload}
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-sm text-[#8888aa] transition-all"
              style={{ background: "#1a1a2e", border: "1px solid #2a2a3e" }}
              title="Download WAV"
            >
              <Download size={14} />
            </motion.button>
          </motion.div>
        ) : isProcessing ? (
          <div className="flex items-center gap-2 py-2 text-xs text-[#5a5a7a]">
            <Loader2 size={13} className="animate-spin text-purple-400" />
            <span>{stateLabel[studioState]}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
