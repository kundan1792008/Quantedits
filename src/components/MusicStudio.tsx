"use client";

/**
 * MusicStudio — UI for the AI Music Generator
 *
 * Composes the `MelodyGenerator` and `AudioSynthesizer` services into an
 * interactive panel:
 *
 *   • Genre selector (lo-fi, cinematic, pop, ambient, electronic, classical)
 *   • Mood selector and intensity slider
 *   • Tempo override (BPM)
 *   • Duration field synced with the host video / timeline
 *   • Per-instrument mute / solo / volume controls
 *   • Live waveform visualisation rendered to canvas
 *   • Playback controls (play / pause / stop) with a moving playhead
 *   • One-click "Apply to Timeline" hook that sends a WAV blob URL upstream
 *   • Regenerate button that picks a fresh seed and re-renders
 *
 * The component is designed to drop straight into the existing AI Tools
 * column in `src/app/page.tsx`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Music,
  Wand2,
  Play,
  Pause,
  Square,
  Download,
  RotateCcw,
  Volume2,
  VolumeX,
  Headphones,
  Loader2,
  CheckCircle2,
  Sliders,
  Waves,
  Sparkles,
} from "lucide-react";
import {
  MelodyGenerator,
  defaultBpmForGenre,
  genreDisplayName,
  listGenres,
  listMoods,
  moodDisplayName,
  type Composition,
  type Genre,
  type InstrumentTrack,
  type Mood,
  type MusicBlueprint,
  type Pacing,
} from "@/services/MelodyGenerator";
import {
  AudioSynthesizer,
  DEFAULT_TRACK_MIX,
  type RenderedAudio,
  type TrackMix,
} from "@/services/AudioSynthesizer";

// ── Public props ───────────────────────────────────────────────────────────

export interface MusicStudioProps {
  /** Default duration in seconds (e.g. video length). */
  defaultDurationSec?: number;
  /** Blueprint coming from a video analyser. If omitted, a uniform
   *  blueprint is created from `defaultMood` / `defaultPacing`. */
  blueprint?: MusicBlueprint;
  /** Default mood (used when no blueprint is provided). */
  defaultMood?: Mood;
  /** Default pacing (used when no blueprint is provided). */
  defaultPacing?: Pacing;
  /** Default genre selection. */
  defaultGenre?: Genre;
  /** Called when the user clicks "Apply to Timeline". */
  onApply?: (payload: {
    composition: Composition;
    audioUrl: string;
    wav: Uint8Array;
    durationSec: number;
  }) => void;
}

// ── Local state ────────────────────────────────────────────────────────────

type Status = "idle" | "generating" | "ready" | "playing" | "error";

interface TrackUiState extends TrackMix {
  /** Friendly label for the UI. */
  label: string;
}

const TRACK_LABELS: Record<InstrumentTrack, string> = {
  melody:     "Melody",
  bass:       "Bass",
  chords:     "Pads / Chords",
  percussion: "Drums",
};

const WAVEFORM_BUCKETS = 256;
const PEAK_DEFAULT_HEIGHT = 96;

// ── Component ──────────────────────────────────────────────────────────────

export default function MusicStudio(props: MusicStudioProps) {
  const {
    defaultDurationSec = 30,
    blueprint,
    defaultMood = "chill",
    defaultPacing = "medium",
    defaultGenre = "lofi",
    onApply,
  } = props;

  // ── Settings state ───────────────────────────────────────────────────────
  const [genre, setGenre] = useState<Genre>(defaultGenre);
  const [mood, setMood] = useState<Mood>(defaultMood);
  const [pacing, setPacing] = useState<Pacing>(defaultPacing);
  const [intensity, setIntensity] = useState<number>(0.7);
  const [bpm, setBpm] = useState<number>(defaultBpmForGenre(defaultGenre));
  const [duration, setDuration] = useState<number>(defaultDurationSec);
  const [seed, setSeed] = useState<number>(() => randomSeed());

  // ── Track mix ────────────────────────────────────────────────────────────
  const [trackMix, setTrackMix] = useState<Record<InstrumentTrack, TrackUiState>>(
    () => ({
      melody:     { ...DEFAULT_TRACK_MIX.melody,     label: TRACK_LABELS.melody },
      bass:       { ...DEFAULT_TRACK_MIX.bass,       label: TRACK_LABELS.bass },
      chords:     { ...DEFAULT_TRACK_MIX.chords,     label: TRACK_LABELS.chords },
      percussion: { ...DEFAULT_TRACK_MIX.percussion, label: TRACK_LABELS.percussion },
    }),
  );

  // ── Render output ────────────────────────────────────────────────────────
  const [composition, setComposition] = useState<Composition | null>(null);
  const [audio, setAudio] = useState<RenderedAudio | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [wavBytes, setWavBytes] = useState<Uint8Array | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [appliedFlash, setAppliedFlash] = useState<boolean>(false);

  // ── Playback state ───────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // ── Rendering services ───────────────────────────────────────────────────
  const generator = useMemo(() => new MelodyGenerator(), []);
  const synth = useMemo(() => new AudioSynthesizer(), []);

  // Keep BPM aligned with genre defaults (only if user hasn't overridden).
  const userOverrodeBpmRef = useRef<boolean>(false);
  const handleGenreChange = useCallback((next: Genre) => {
    setGenre(next);
    if (!userOverrodeBpmRef.current) {
      setBpm(defaultBpmForGenre(next));
    }
  }, []);

  // Cleanup blob URL on unmount / when replaced
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  // ── Generate handler ─────────────────────────────────────────────────────

  const generate = useCallback(async (seedOverride?: number) => {
    setStatus("generating");
    setErrorMessage(null);
    setProgress(0);
    setIsPlaying(false);
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    try {
      const bp: MusicBlueprint = blueprint
        ? cloneBlueprint(blueprint, duration)
        : generator.buildBlueprint(duration, mood, pacing, intensity);

      const useSeed = seedOverride ?? seed;
      const newComposition = generator.generate({
        genre,
        bpmOverride: userOverrodeBpmRef.current ? bpm : undefined,
        intensity,
        seed: useSeed,
        blueprint: bp,
      });

      setProgress(0.25);

      const rendered = await synth.renderToBuffer(newComposition, {
        sampleRate: 44100,
        channels: 2,
        trackMix: extractMixForRender(trackMix),
        onProgress: (p) => setProgress(0.25 + p * 0.65),
      });

      setProgress(0.92);
      const wav = synth.encodeWav(rendered);
      const url = URL.createObjectURL(new Blob([new Uint8Array(wav)], { type: "audio/wav" }));
      const newPeaks = synth.computePeaks(rendered, WAVEFORM_BUCKETS);

      // Replace state and revoke previous URL.
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setComposition(newComposition);
      setAudio(rendered);
      setAudioUrl(url);
      setWavBytes(wav);
      setPeaks(newPeaks);
      setProgress(1);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Music generation failed";
      setStatus("error");
      setErrorMessage(message);
      setProgress(0);
    }
  }, [
    audioUrl,
    blueprint,
    bpm,
    duration,
    generator,
    genre,
    intensity,
    mood,
    pacing,
    seed,
    synth,
    trackMix,
  ]);

  const regenerate = useCallback(() => {
    const newSeed = randomSeed();
    setSeed(newSeed);
    void generate(newSeed);
  }, [generate]);

  // (Generation runs only on explicit user action — Generate or Regenerate.)

  // ── Playback handlers ────────────────────────────────────────────────────

  const handlePlay = useCallback(() => {
    if (!audioUrl || !audioElRef.current) return;
    const el = audioElRef.current;
    el.play().then(() => {
      setIsPlaying(true);
    }).catch(() => {
      setIsPlaying(false);
    });
  }, [audioUrl]);

  const handlePause = useCallback(() => {
    audioElRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const handleStop = useCallback(() => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    setIsPlaying(false);
    setPlayheadSec(0);
  }, []);

  // Track audio element time for playhead.
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    const onTime = () => setPlayheadSec(el.currentTime);
    const onEnded = () => {
      setIsPlaying(false);
      setPlayheadSec(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
    };
  }, [audioUrl]);

  // ── Track mix handlers ───────────────────────────────────────────────────

  const updateTrack = useCallback(
    (track: InstrumentTrack, patch: Partial<TrackMix>) => {
      setTrackMix((prev) => ({
        ...prev,
        [track]: { ...prev[track], ...patch },
      }));
    },
    [],
  );

  const onSoloClick = useCallback((track: InstrumentTrack) => {
    setTrackMix((prev) => {
      const next = { ...prev };
      const wasSolo = prev[track].solo;
      // Toggle solo: if turning on, all others become non-solo.
      for (const t of Object.keys(next) as InstrumentTrack[]) {
        next[t] = { ...next[t], solo: t === track ? !wasSolo : false };
      }
      return next;
    });
  }, []);

  // ── Apply / download ─────────────────────────────────────────────────────

  const handleApply = useCallback(() => {
    if (!composition || !audioUrl || !wavBytes) return;
    onApply?.({
      composition,
      audioUrl,
      wav: wavBytes,
      durationSec: composition.durationSec,
    });
    setAppliedFlash(true);
    setTimeout(() => setAppliedFlash(false), 1800);
  }, [composition, audioUrl, wavBytes, onApply]);

  const handleDownload = useCallback(() => {
    if (!audioUrl) return;
    const a = document.createElement("a");
    a.href = audioUrl;
    a.download = `quantedits-${genre}-${seed.toString(16)}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [audioUrl, genre, seed]);

  // ── Derived values for render ────────────────────────────────────────────

  const ready = status === "ready" || status === "playing";
  const busy = status === "generating";
  const totalNotes = composition?.events.length ?? 0;
  const stats = composition?.trackStats;

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{
        background: "linear-gradient(180deg, #13131A 0%, #0F0F18 100%)",
        border: "1px solid #1E1E2E",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{
            background: "linear-gradient(135deg, #6E40FF 0%, #00C2FF 100%)",
          }}
        >
          <Music size={14} className="text-white" />
        </div>
        <div className="flex-1">
          <div className="text-[12px] font-semibold text-[#E8E8F0] flex items-center gap-2">
            AI Music Studio
            <span
              className="text-[9px] px-1.5 py-[1px] rounded-full font-mono uppercase tracking-wider"
              style={{
                background: "#1E1E40",
                color: "#a78bfa",
                border: "1px solid #3a3a6a",
              }}
            >
              World-First
            </span>
          </div>
          <div className="text-[10px] text-[#5a5a7a]">
            Royalty-free soundtracks generated on the fly
          </div>
        </div>
        <button
          onClick={regenerate}
          disabled={busy}
          title="Regenerate with a fresh seed"
          className="text-[#8888aa] hover:text-[#E8E8F0] transition-colors disabled:opacity-40"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Generator settings */}
      <div className="p-4 grid grid-cols-2 gap-3">
        <Field label="Genre">
          <Select
            value={genre}
            onChange={(v) => handleGenreChange(v as Genre)}
            options={listGenres().map((g) => ({ value: g, label: genreDisplayName(g) }))}
            disabled={busy}
          />
        </Field>
        <Field label="Mood">
          <Select
            value={mood}
            onChange={(v) => setMood(v as Mood)}
            options={listMoods().map((m) => ({ value: m, label: moodDisplayName(m) }))}
            disabled={busy}
          />
        </Field>
        <Field label="Pacing">
          <Select
            value={pacing}
            onChange={(v) => setPacing(v as Pacing)}
            options={[
              { value: "slow",   label: "Slow" },
              { value: "medium", label: "Medium" },
              { value: "fast",   label: "Fast" },
            ]}
            disabled={busy}
          />
        </Field>
        <Field label={`Tempo · ${bpm} BPM`}>
          <input
            type="range"
            min={40}
            max={180}
            step={1}
            value={bpm}
            onChange={(e) => {
              userOverrodeBpmRef.current = true;
              setBpm(parseInt(e.target.value, 10));
            }}
            disabled={busy}
            className="w-full accent-[#a78bfa]"
          />
        </Field>
        <Field label={`Intensity · ${(intensity * 100).toFixed(0)}%`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={intensity}
            onChange={(e) => setIntensity(parseFloat(e.target.value))}
            disabled={busy}
            className="w-full accent-[#a78bfa]"
          />
        </Field>
        <Field label={`Duration · ${duration.toFixed(0)}s`}>
          <input
            type="range"
            min={5}
            max={180}
            step={1}
            value={duration}
            onChange={(e) => setDuration(parseInt(e.target.value, 10))}
            disabled={busy}
            className="w-full accent-[#00C2FF]"
          />
        </Field>
      </div>

      {/* Generate / status row */}
      <div
        className="flex items-center gap-2 px-4 py-2"
        style={{ borderTop: "1px solid #1E1E2E" }}
      >
        <button
          onClick={() => void generate()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-50"
          style={{
            background: busy
              ? "#1E1E40"
              : "linear-gradient(135deg, #6E40FF 0%, #00C2FF 100%)",
            color: "#fff",
          }}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          {busy ? "Generating…" : ready ? "Re-generate" : "Generate"}
        </button>
        <button
          onClick={regenerate}
          disabled={busy}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-all disabled:opacity-50"
          style={{ background: "#1E1E2E", color: "#a78bfa", border: "1px solid #2a2a3e" }}
          title="New random seed"
        >
          <Sparkles size={11} />
          New Seed
        </button>
        <div className="flex-1" />
        {composition && (
          <div className="text-[10px] font-mono text-[#5a5a7a] flex items-center gap-2">
            <span>{composition.bpm} BPM</span>
            <span>·</span>
            <span>{totalNotes} notes</span>
            <span>·</span>
            <span>seed {composition.seed.toString(16).slice(0, 6)}</span>
          </div>
        )}
      </div>

      {/* Progress bar (during generation) */}
      <AnimatePresence>
        {busy && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-4 pb-2"
          >
            <div
              className="h-1.5 rounded-full overflow-hidden"
              style={{ background: "#1E1E2E" }}
            >
              <motion.div
                className="h-full"
                style={{
                  background: "linear-gradient(90deg, #6E40FF 0%, #00C2FF 100%)",
                }}
                animate={{ width: `${progress * 100}%` }}
                transition={{ duration: 0.2 }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error banner */}
      <AnimatePresence>
        {errorMessage && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="mx-4 mb-2 px-3 py-2 rounded-lg text-[11px]"
            style={{
              background: "#3A1010",
              border: "1px solid #6A2020",
              color: "#FCA5A5",
            }}
          >
            {errorMessage}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Waveform display */}
      <div
        className="px-4 py-3"
        style={{ borderTop: "1px solid #1E1E2E" }}
      >
        <div className="flex items-center gap-2 mb-2">
          <Waves size={11} className="text-[#5a5a7a]" />
          <span className="text-[10px] uppercase tracking-widest text-[#5a5a7a]">
            Waveform
          </span>
          {audio && (
            <span className="ml-auto text-[10px] font-mono text-[#5a5a7a]">
              {formatTime(playheadSec)} / {formatTime(audio.durationSec)}
            </span>
          )}
        </div>
        <Waveform
          peaks={peaks}
          durationSec={audio?.durationSec ?? duration}
          playheadSec={playheadSec}
          isPlaying={isPlaying}
          accentColor="#a78bfa"
          onSeek={(sec) => {
            if (audioElRef.current) {
              audioElRef.current.currentTime = sec;
              setPlayheadSec(sec);
            }
          }}
        />
      </div>

      {/* Per-track mixer */}
      <div
        className="px-4 py-3"
        style={{ borderTop: "1px solid #1E1E2E" }}
      >
        <div className="flex items-center gap-2 mb-2">
          <Sliders size={11} className="text-[#5a5a7a]" />
          <span className="text-[10px] uppercase tracking-widest text-[#5a5a7a]">
            Mixer
          </span>
        </div>
        <div className="grid gap-2">
          {(Object.keys(trackMix) as InstrumentTrack[]).map((track) => {
            const m = trackMix[track];
            const trackStat = stats?.[track];
            return (
              <TrackRow
                key={track}
                label={m.label}
                volume={m.volume}
                muted={m.muted}
                solo={m.solo}
                pan={m.pan}
                noteCount={trackStat?.noteCount ?? 0}
                disabled={busy}
                onVolume={(v) => updateTrack(track, { volume: v })}
                onMute={() => updateTrack(track, { muted: !m.muted })}
                onSolo={() => onSoloClick(track)}
                onPan={(p) => updateTrack(track, { pan: p })}
              />
            );
          })}
        </div>
      </div>

      {/* Playback / actions */}
      <div
        className="flex items-center gap-2 px-4 py-3"
        style={{ borderTop: "1px solid #1E1E2E" }}
      >
        <button
          onClick={isPlaying ? handlePause : handlePlay}
          disabled={!ready || busy}
          className="flex items-center justify-center w-9 h-9 rounded-full transition-all disabled:opacity-30"
          style={{
            background: isPlaying ? "#1E1E40" : "linear-gradient(135deg, #6E40FF 0%, #00C2FF 100%)",
            color: "#fff",
          }}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>
        <button
          onClick={handleStop}
          disabled={!ready || busy}
          className="flex items-center justify-center w-8 h-8 rounded-full transition-all disabled:opacity-30"
          style={{
            background: "#1E1E2E",
            color: "#8888aa",
            border: "1px solid #2a2a3e",
          }}
          title="Stop"
        >
          <Square size={11} />
        </button>
        <div className="flex-1" />
        <button
          onClick={handleDownload}
          disabled={!ready || busy}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] transition-all disabled:opacity-30"
          style={{ background: "#1E1E2E", color: "#8888aa", border: "1px solid #2a2a3e" }}
          title="Download WAV"
        >
          <Download size={11} />
          WAV
        </button>
        <button
          onClick={handleApply}
          disabled={!ready || busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-30"
          style={{
            background: appliedFlash
              ? "linear-gradient(135deg, #10b981 0%, #34d399 100%)"
              : "linear-gradient(135deg, #6E40FF 0%, #00C2FF 100%)",
            color: "#fff",
          }}
        >
          {appliedFlash ? <CheckCircle2 size={12} /> : <Headphones size={12} />}
          {appliedFlash ? "Applied" : "Apply to Timeline"}
        </button>
      </div>

      {/* Hidden audio element for playback. */}
      {audioUrl && (
        <audio
          ref={audioElRef}
          src={audioUrl}
          preload="auto"
          className="hidden"
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-widest text-[#5a5a7a] font-medium">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

interface SelectOption { value: string; label: string }

function Select(props: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  disabled?: boolean;
}) {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      disabled={props.disabled}
      className="text-[11px] py-1.5 px-2 rounded-lg outline-none transition-colors"
      style={{
        background: "#1E1E2E",
        color: "#E8E8F0",
        border: "1px solid #2a2a3e",
      }}
    >
      {props.options.map((opt) => (
        <option key={opt.value} value={opt.value} style={{ background: "#13131A" }}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function TrackRow(props: {
  label: string;
  volume: number;
  muted: boolean;
  solo: boolean;
  pan: number;
  noteCount: number;
  disabled: boolean;
  onVolume: (v: number) => void;
  onMute: () => void;
  onSolo: () => void;
  onPan: (v: number) => void;
}) {
  const dimmed = props.muted && !props.solo;
  return (
    <div
      className="grid items-center gap-2"
      style={{
        gridTemplateColumns: "90px auto 1fr 56px",
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <span className="text-[11px] font-medium text-[#E8E8F0] flex items-center gap-1.5">
        {props.label}
        <span className="text-[9px] text-[#5a5a7a] font-mono">
          {props.noteCount}
        </span>
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={props.onMute}
          disabled={props.disabled}
          title={props.muted ? "Unmute" : "Mute"}
          className="w-6 h-6 rounded flex items-center justify-center transition-colors"
          style={{
            background: props.muted ? "#3A1010" : "#1E1E2E",
            color: props.muted ? "#FCA5A5" : "#8888aa",
            border: `1px solid ${props.muted ? "#6A2020" : "#2a2a3e"}`,
          }}
        >
          {props.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
        </button>
        <button
          onClick={props.onSolo}
          disabled={props.disabled}
          title={props.solo ? "Unsolo" : "Solo"}
          className="w-6 h-6 rounded flex items-center justify-center text-[9px] font-bold transition-colors"
          style={{
            background: props.solo ? "#1E1E40" : "#1E1E2E",
            color: props.solo ? "#a78bfa" : "#5a5a7a",
            border: `1px solid ${props.solo ? "#3a3a6a" : "#2a2a3e"}`,
          }}
        >
          S
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={1.5}
        step={0.01}
        value={props.volume}
        onChange={(e) => props.onVolume(parseFloat(e.target.value))}
        disabled={props.disabled}
        className="accent-[#a78bfa] w-full"
      />
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={props.pan}
        onChange={(e) => props.onPan(parseFloat(e.target.value))}
        disabled={props.disabled}
        className="accent-[#00C2FF] w-full"
        title={`Pan ${(props.pan * 100).toFixed(0)}`}
      />
    </div>
  );
}

// ── Waveform canvas ────────────────────────────────────────────────────────

interface WaveformProps {
  peaks: Float32Array | null;
  durationSec: number;
  playheadSec: number;
  isPlaying: boolean;
  accentColor: string;
  onSeek: (sec: number) => void;
}

function Waveform(props: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(320);

  // Resize observer to keep canvas crisp.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(80, Math.floor(entry.contentRect.width));
        setWidth(w);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw the waveform.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
    const cssWidth = width;
    const cssHeight = PEAK_DEFAULT_HEIGHT;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Background grid
    ctx.fillStyle = "#0F0F18";
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cssHeight / 2);
    ctx.lineTo(cssWidth, cssHeight / 2);
    ctx.stroke();
    // Vertical gridlines every 5s.
    if (props.durationSec > 0) {
      const pxPerSec = cssWidth / props.durationSec;
      for (let s = 5; s < props.durationSec; s += 5) {
        const x = Math.floor(s * pxPerSec) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssHeight);
        ctx.strokeStyle = "rgba(255,255,255,0.03)";
        ctx.stroke();
      }
    }

    // Peaks
    const peaks = props.peaks;
    if (peaks && peaks.length > 0) {
      const cols = peaks.length;
      const colWidth = cssWidth / cols;
      const playheadX = props.durationSec > 0
        ? (props.playheadSec / props.durationSec) * cssWidth
        : 0;
      for (let i = 0; i < cols; i++) {
        const peak = peaks[i];
        const h = Math.max(1, peak * (cssHeight - 6));
        const x = i * colWidth;
        const isPlayed = x < playheadX;
        const grad = ctx.createLinearGradient(0, 0, 0, cssHeight);
        if (isPlayed) {
          grad.addColorStop(0, "#00C2FF");
          grad.addColorStop(1, "#6E40FF");
        } else {
          grad.addColorStop(0, "#3a3a5a");
          grad.addColorStop(1, "#2a2a3e");
        }
        ctx.fillStyle = grad;
        ctx.fillRect(
          Math.floor(x) + 0.5,
          (cssHeight - h) / 2,
          Math.max(1, colWidth - 1),
          h,
        );
      }
      // Playhead
      ctx.strokeStyle = props.accentColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, cssHeight);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#3a3a5a";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("— generate to see waveform —", cssWidth / 2, cssHeight / 2);
    }
  }, [width, props.peaks, props.playheadSec, props.durationSec, props.accentColor]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!props.peaks || props.durationSec <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = clamp01(x / rect.width);
      props.onSeek(ratio * props.durationSec);
    },
    [props],
  );

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg overflow-hidden"
      style={{ background: "#0F0F18", border: "1px solid #1E1E2E" }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{
          display: "block",
          width: "100%",
          height: PEAK_DEFAULT_HEIGHT,
          cursor: props.peaks ? "pointer" : "default",
        }}
      />
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function randomSeed(): number {
  return Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
}

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function extractMixForRender(
  uiMix: Record<InstrumentTrack, TrackUiState>,
): Record<InstrumentTrack, TrackMix> {
  const out = {} as Record<InstrumentTrack, TrackMix>;
  for (const t of Object.keys(uiMix) as InstrumentTrack[]) {
    const m = uiMix[t];
    out[t] = { volume: m.volume, muted: m.muted, solo: m.solo, pan: m.pan };
  }
  return out;
}

function cloneBlueprint(bp: MusicBlueprint, durationSec: number): MusicBlueprint {
  // Clip / extend the supplied blueprint to match the requested duration.
  const target = Math.max(1, durationSec);
  const ratio = target / Math.max(1e-3, bp.durationSec);
  const markers = bp.markers.map((m) => ({
    ...m,
    startSec: m.startSec * ratio,
    endSec: m.endSec * ratio,
  }));
  return { durationSec: target, markers };
}
