/**
 * TimelineRenderer — Canvas-based 60fps WebGL Timeline Rendering Engine
 *
 * Renders a multi-track video/audio/text/effect timeline onto a 2D canvas.
 * Supports:
 *   - Multiple track types: VIDEO, AUDIO, TEXT, AI_EFFECT
 *   - Zoom from 0.1x to 100x with smooth scroll
 *   - Snap-to-frame playhead with 30fps and 60fps modes
 *   - Clip trimming via drag handles
 *   - Clip splitting with razor tool
 *   - Waveform visualization using decoded PCM data
 *   - Keyframe editor: add / remove / interpolate
 *   - Full selection model (tracks, clips, keyframes)
 *   - OffscreenCanvas support for off-main-thread rendering
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type TrackType = "VIDEO" | "AUDIO" | "TEXT" | "AI_EFFECT";

export type KeyframeEasing =
  | "LINEAR"
  | "EASE_IN"
  | "EASE_OUT"
  | "EASE_IN_OUT"
  | "BEZIER"
  | "STEP";

export interface Keyframe {
  id: string;
  property: string;
  timeSec: number; // relative to clip start
  value: number;
  easing: KeyframeEasing;
  /** Only used when easing === "BEZIER" */
  bezierControlPoints?: [number, number, number, number];
}

export interface ClipProperties {
  opacity?: number;       // 0..1
  scale?: number;         // 1 = 100%
  positionX?: number;     // pixels
  positionY?: number;     // pixels
  rotation?: number;      // degrees
  speed?: number;         // 1 = normal
  volume?: number;        // 0..1
  blendMode?: GlobalCompositeOperation;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
  borderRadius?: number;
  [key: string]: unknown;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId?: string;
  startSec: number;       // position on timeline
  endSec: number;
  trimInSec: number;      // source trim from start
  trimOutSec: number;     // source trim from end
  properties: ClipProperties;
  keyframes: Keyframe[];
  label?: string;
  thumbnailUrl?: string;
  /** PCM waveform samples for audio tracks (amplitude 0..1) */
  waveformSamples?: Float32Array;
}

export interface Track {
  id: string;
  timelineId: string;
  type: TrackType;
  name: string;
  index: number;
  muted: boolean;
  solo: boolean;
  locked: boolean;
  volume: number;
  clips: Clip[];
}

export type ToolMode = "SELECT" | "RAZOR" | "HAND" | "ZOOM";

export interface PlayheadState {
  timeSec: number;
  isPlaying: boolean;
  fps: 24 | 30 | 60;
  loop: boolean;
  loopStartSec: number;
  loopEndSec: number;
}

export interface SelectionState {
  trackIds: Set<string>;
  clipIds: Set<string>;
  keyframeIds: Set<string>;
}

export interface ViewState {
  /** Pixels per second at zoom=1 */
  basePPS: number;
  zoom: number;       // 0.1 .. 100
  scrollX: number;    // pixels scrolled horizontally
  scrollY: number;    // pixels scrolled vertically
}

export type TimelineEvent =
  | { type: "PLAYHEAD_SEEK"; timeSec: number }
  | { type: "CLIP_SELECT"; clipId: string; multi: boolean }
  | { type: "CLIP_TRIM_START"; clipId: string; trimInSec: number }
  | { type: "CLIP_TRIM_END"; clipId: string; trimOutSec: number }
  | { type: "CLIP_MOVE"; clipId: string; startSec: number; trackId: string }
  | { type: "CLIP_SPLIT"; clipId: string; atSec: number }
  | { type: "KEYFRAME_ADD"; clipId: string; property: string; timeSec: number; value: number }
  | { type: "KEYFRAME_REMOVE"; keyframeId: string }
  | { type: "KEYFRAME_MOVE"; keyframeId: string; timeSec: number; value: number }
  | { type: "TRACK_SELECT"; trackId: string; multi: boolean }
  | { type: "ZOOM_CHANGE"; zoom: number }
  | { type: "SCROLL_CHANGE"; scrollX: number; scrollY: number };

type EventListener = (event: TimelineEvent) => void;

// ── Layout constants ──────────────────────────────────────────────────────

const RULER_HEIGHT = 28;
const TRACK_LABEL_WIDTH = 90;
const TRACK_HEIGHT = 52;
const KEYFRAME_EDITOR_HEIGHT = 80;
const RESIZE_HANDLE_WIDTH = 6;
const SNAP_THRESHOLD_PX = 8;
const MIN_CLIP_DURATION_SEC = 0.033; // ~1 frame at 30fps

// ── Colour palette ────────────────────────────────────────────────────────

const COLORS = {
  bg: "#0D0D11",
  trackBg: "#13131A",
  trackBgAlt: "#10101A",
  trackBorder: "#1E1E2E",
  trackLabelBg: "#0D0D11",
  trackLabelText: "#5a5a7a",
  rulerBg: "#0D0D11",
  rulerText: "#3a3a5a",
  rulerTick: "#1E1E2E",
  rulerTickMajor: "#2a2a4a",
  playhead: "#7C3AED",
  playheadShadow: "rgba(124,58,237,0.3)",
  loopRegion: "rgba(124,58,237,0.08)",
  selection: "rgba(124,58,237,0.2)",
  selectionBorder: "#7C3AED",
  clipVideo: { fill: "#7C3AED22", border: "#7C3AED60", label: "#a78bfa" },
  clipAudio: { fill: "#06B6D422", border: "#06B6D460", label: "#67e8f9" },
  clipText: { fill: "#EC489922", border: "#EC489960", label: "#f9a8d4" },
  clipEffect: { fill: "#F59E0B22", border: "#F59E0B60", label: "#fcd34d" },
  waveform: "#06B6D4",
  waveformMuted: "#2a4a5a",
  keyframeDiamond: "#F59E0B",
  keyframeSelected: "#FFFFFF",
  handleHover: "rgba(255,255,255,0.15)",
  handleActive: "rgba(255,255,255,0.3)",
  scrollbar: "#1a1a2e",
  scrollbarThumb: "#2a2a4a",
} as const;

// ── Interpolation helpers ─────────────────────────────────────────────────

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInCubic(t: number): number {
  return t * t * t;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Cubic bezier solver for CSS-like easing (p1x, p1y, p2x, p2y). */
function cubicBezier(
  t: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
): number {
  // Newton-Raphson iteration
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;

  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;

  function sampleCurveX(t: number): number {
    return ((ax * t + bx) * t + cx) * t;
  }
  function sampleCurveY(t: number): number {
    return ((ay * t + by) * t + cy) * t;
  }
  function sampleCurveDerivativeX(t: number): number {
    return (3 * ax * t + 2 * bx) * t + cx;
  }

  let s = t;
  for (let i = 0; i < 8; i++) {
    const x = sampleCurveX(s) - t;
    if (Math.abs(x) < 1e-6) break;
    const dx = sampleCurveDerivativeX(s);
    if (Math.abs(dx) < 1e-6) break;
    s -= x / dx;
  }
  return sampleCurveY(s);
}

/**
 * Interpolate a property value between two keyframes.
 */
export function interpolateKeyframes(
  kf1: Keyframe,
  kf2: Keyframe,
  timeSec: number,
): number {
  const duration = kf2.timeSec - kf1.timeSec;
  if (duration <= 0) return kf2.value;
  const t = Math.max(0, Math.min(1, (timeSec - kf1.timeSec) / duration));

  switch (kf1.easing) {
    case "LINEAR":
      return lerp(kf1.value, kf2.value, t);
    case "EASE_IN":
      return lerp(kf1.value, kf2.value, easeInCubic(t));
    case "EASE_OUT":
      return lerp(kf1.value, kf2.value, easeOutCubic(t));
    case "EASE_IN_OUT":
      return lerp(kf1.value, kf2.value, easeInOutCubic(t));
    case "BEZIER": {
      const [p1x, p1y, p2x, p2y] = kf1.bezierControlPoints ?? [
        0.42, 0, 0.58, 1,
      ];
      return lerp(kf1.value, kf2.value, cubicBezier(t, p1x, p1y, p2x, p2y));
    }
    case "STEP":
      return t < 1 ? kf1.value : kf2.value;
    default:
      return lerp(kf1.value, kf2.value, t);
  }
}

/**
 * Resolve a clip property value at a given time, honoring keyframe animation.
 */
export function resolveClipProperty(
  clip: Clip,
  property: string,
  timeSec: number,
): number {
  const kfs = clip.keyframes
    .filter((k) => k.property === property)
    .sort((a, b) => a.timeSec - b.timeSec);

  if (kfs.length === 0) {
    const val = clip.properties[property];
    return typeof val === "number" ? val : 1;
  }
  if (kfs.length === 1) return kfs[0].value;

  const relTime = timeSec - clip.startSec;
  if (relTime <= kfs[0].timeSec) return kfs[0].value;
  if (relTime >= kfs[kfs.length - 1].timeSec)
    return kfs[kfs.length - 1].value;

  for (let i = 0; i < kfs.length - 1; i++) {
    if (relTime >= kfs[i].timeSec && relTime <= kfs[i + 1].timeSec) {
      return interpolateKeyframes(kfs[i], kfs[i + 1], relTime);
    }
  }

  return kfs[kfs.length - 1].value;
}

// ── Snap helpers ──────────────────────────────────────────────────────────

/**
 * Return the nearest frame boundary for the given time, at the given fps.
 */
export function snapToFrame(timeSec: number, fps: number): number {
  return Math.round(timeSec * fps) / fps;
}

// ── Drag state ────────────────────────────────────────────────────────────

type DragTarget =
  | { type: "CLIP"; clipId: string; offsetSec: number }
  | { type: "TRIM_IN"; clipId: string }
  | { type: "TRIM_OUT"; clipId: string }
  | { type: "PLAYHEAD" }
  | { type: "SCROLL" }
  | { type: "KEYFRAME"; keyframeId: string; clipId: string; initialValue: number };

// ── Main renderer ─────────────────────────────────────────────────────────

export class TimelineRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private tracks: Track[] = [];
  private playhead: PlayheadState;
  private view: ViewState;
  private selection: SelectionState;
  private tool: ToolMode = "SELECT";
  private listeners: EventListener[] = [];
  private animFrameId: number | null = null;
  private lastRenderTime = 0;
  private dirty = true;
  private drag: DragTarget | null = null;
  private hoverClipId: string | null = null;
  private hoverHandle: "TRIM_IN" | "TRIM_OUT" | null = null;
  private showKeyframeEditor = false;
  private selectedProperty = "opacity";
  private durationSec = 60;
  private devicePixelRatio: number;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, dpr = 1) {
    this.canvas = canvas;
    const ctx =
      canvas instanceof HTMLCanvasElement
        ? canvas.getContext("2d")
        : (canvas as OffscreenCanvas).getContext("2d");
    if (!ctx) throw new Error("Cannot get 2D context from canvas");
    this.ctx = ctx;
    this.devicePixelRatio = dpr;

    this.playhead = {
      timeSec: 0,
      isPlaying: false,
      fps: 30,
      loop: false,
      loopStartSec: 0,
      loopEndSec: 10,
    };

    this.view = {
      basePPS: 100, // 100 px / second at zoom=1
      zoom: 1,
      scrollX: 0,
      scrollY: 0,
    };

    this.selection = {
      trackIds: new Set(),
      clipIds: new Set(),
      keyframeIds: new Set(),
    };

    if (canvas instanceof HTMLCanvasElement) {
      this.attachEventListeners(canvas);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Replace the full track/clip dataset. */
  setTracks(tracks: Track[]): void {
    this.tracks = tracks;
    this.dirty = true;
  }

  /** Seek the playhead to a specific time. */
  seek(timeSec: number): void {
    const clamped = Math.max(0, Math.min(this.durationSec, timeSec));
    this.playhead.timeSec = snapToFrame(clamped, this.playhead.fps);
    this.dirty = true;
    this.emit({ type: "PLAYHEAD_SEEK", timeSec: this.playhead.timeSec });
  }

  /** Set project total duration. */
  setDuration(durationSec: number): void {
    this.durationSec = durationSec;
    this.dirty = true;
  }

  /** Set the active editing tool. */
  setTool(tool: ToolMode): void {
    this.tool = tool;
    this.dirty = true;
  }

  /** Set the frame-rate mode. */
  setFps(fps: 24 | 30 | 60): void {
    this.playhead.fps = fps;
    this.dirty = true;
  }

  /** Set playback looping. */
  setLoop(enabled: boolean, startSec?: number, endSec?: number): void {
    this.playhead.loop = enabled;
    if (startSec !== undefined) this.playhead.loopStartSec = startSec;
    if (endSec !== undefined) this.playhead.loopEndSec = endSec;
    this.dirty = true;
  }

  /** Adjust zoom level (clamped 0.1..100). */
  setZoom(zoom: number, anchorPx?: number): void {
    const newZoom = Math.max(0.1, Math.min(100, zoom));
    if (anchorPx !== undefined) {
      // Keep the time under anchorPx fixed
      const pps = this.view.basePPS * this.view.zoom;
      const timeatanchor = (anchorPx + this.view.scrollX - TRACK_LABEL_WIDTH) / pps;
      this.view.scrollX = timeatanchor * this.view.basePPS * newZoom - anchorPx + TRACK_LABEL_WIDTH;
    }
    this.view.zoom = newZoom;
    this.dirty = true;
    this.emit({ type: "ZOOM_CHANGE", zoom: newZoom });
  }

  /** Enable or disable keyframe editor panel. */
  setShowKeyframeEditor(show: boolean, property?: string): void {
    this.showKeyframeEditor = show;
    if (property) this.selectedProperty = property;
    this.dirty = true;
  }

  /** Toggle mute on a track. */
  setTrackMuted(trackId: string, muted: boolean): void {
    const track = this.tracks.find((t) => t.id === trackId);
    if (track) {
      track.muted = muted;
      this.dirty = true;
    }
  }

  /** Toggle solo on a track. */
  setTrackSolo(trackId: string, solo: boolean): void {
    const track = this.tracks.find((t) => t.id === trackId);
    if (track) {
      track.solo = solo;
      this.dirty = true;
    }
  }

  /** Register a listener for timeline events. */
  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Start the animation loop. */
  startLoop(): void {
    if (this.animFrameId !== null) return;
    const loop = (timestamp: number) => {
      if (this.dirty || this.playhead.isPlaying) {
        this.render(timestamp);
        this.dirty = false;
      }
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  /** Stop the animation loop. */
  stopLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /** Force an immediate re-render. */
  invalidate(): void {
    this.dirty = true;
  }

  /** Resize the canvas to match its layout dimensions. */
  resize(width: number, height: number): void {
    const dpr = this.devicePixelRatio;
    const c = this.canvas as HTMLCanvasElement;
    c.width = width * dpr;
    c.height = height * dpr;
    this.ctx.scale(dpr, dpr);
    this.dirty = true;
  }

  destroy(): void {
    this.stopLoop();
    if (this.canvas instanceof HTMLCanvasElement) {
      this.detachEventListeners(this.canvas);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private get width(): number {
    return this.canvas instanceof HTMLCanvasElement
      ? this.canvas.clientWidth
      : this.canvas.width / this.devicePixelRatio;
  }

  private get height(): number {
    return this.canvas instanceof HTMLCanvasElement
      ? this.canvas.clientHeight
      : this.canvas.height / this.devicePixelRatio;
  }

  private get pps(): number {
    return this.view.basePPS * this.view.zoom;
  }

  /** Convert timeline seconds to canvas X coordinate. */
  private secToX(sec: number): number {
    return TRACK_LABEL_WIDTH + sec * this.pps - this.view.scrollX;
  }

  /** Convert canvas X coordinate to timeline seconds. */
  private xToSec(x: number): number {
    return (x - TRACK_LABEL_WIDTH + this.view.scrollX) / this.pps;
  }

  /** Get the Y coordinate for a given track index. */
  private trackY(trackIndex: number): number {
    return RULER_HEIGHT + trackIndex * TRACK_HEIGHT - this.view.scrollY;
  }

  private render(timestamp: number): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // Advance playhead
    if (this.playhead.isPlaying && this.lastRenderTime > 0) {
      const delta = (timestamp - this.lastRenderTime) / 1000;
      let newTime = this.playhead.timeSec + delta;
      if (this.playhead.loop) {
        if (newTime >= this.playhead.loopEndSec) {
          newTime = this.playhead.loopStartSec;
        }
      } else if (newTime >= this.durationSec) {
        newTime = this.durationSec;
        this.playhead.isPlaying = false;
      }
      this.playhead.timeSec = newTime;
      this.emit({ type: "PLAYHEAD_SEEK", timeSec: newTime });
    }
    this.lastRenderTime = timestamp;

    // Clear
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);

    const kfHeight = this.showKeyframeEditor ? KEYFRAME_EDITOR_HEIGHT : 0;
    const trackAreaH = h - RULER_HEIGHT - kfHeight;

    // Draw layers
    this.drawRuler(ctx, w);
    this.drawLoopRegion(ctx, trackAreaH);
    this.drawTracks(ctx, w, trackAreaH);
    this.drawPlayhead(ctx, trackAreaH);
    if (this.showKeyframeEditor) {
      this.drawKeyframeEditor(ctx, w, h, kfHeight);
    }
    this.drawScrollbars(ctx, w, h, trackAreaH);
  }

  private drawRuler(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
  ): void {
    ctx.fillStyle = COLORS.rulerBg;
    ctx.fillRect(0, 0, w, RULER_HEIGHT);

    // Label area background
    ctx.fillStyle = COLORS.trackLabelBg;
    ctx.fillRect(0, 0, TRACK_LABEL_WIDTH, RULER_HEIGHT);

    // Border
    ctx.fillStyle = COLORS.trackBorder;
    ctx.fillRect(0, RULER_HEIGHT - 1, w, 1);

    // Determine tick interval based on zoom
    const pps = this.pps;
    const intervals = [
      0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30,
      60, 120, 300,
    ];
    const minTickPx = 6;
    let tickInterval = intervals[intervals.length - 1];
    for (const iv of intervals) {
      if (iv * pps >= minTickPx) {
        tickInterval = iv;
        break;
      }
    }
    const majorInterval = tickInterval * 10;

    const startSec = Math.max(
      0,
      Math.floor((this.view.scrollX / pps) / tickInterval) * tickInterval,
    );
    const endSec = this.xToSec(w) + tickInterval;

    ctx.font = "9px monospace";
    ctx.textBaseline = "top";

    for (let t = startSec; t <= endSec; t += tickInterval) {
      const x = this.secToX(t);
      if (x < TRACK_LABEL_WIDTH || x > w) continue;

      const isMajor = Math.abs(t % majorInterval) < tickInterval * 0.01;
      ctx.fillStyle = isMajor ? COLORS.rulerTickMajor : COLORS.rulerTick;
      ctx.fillRect(x, isMajor ? 8 : 16, 1, isMajor ? 12 : 8);

      if (isMajor) {
        ctx.fillStyle = COLORS.rulerText;
        const label = formatTimecode(t, this.playhead.fps);
        ctx.fillText(label, x + 3, 6);
      }
    }
  }

  private drawLoopRegion(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    trackAreaH: number,
  ): void {
    if (!this.playhead.loop) return;
    const x1 = this.secToX(this.playhead.loopStartSec);
    const x2 = this.secToX(this.playhead.loopEndSec);
    ctx.fillStyle = COLORS.loopRegion;
    ctx.fillRect(x1, RULER_HEIGHT, x2 - x1, trackAreaH);

    // Loop region boundaries
    ctx.fillStyle = COLORS.playhead + "40";
    ctx.fillRect(x1, RULER_HEIGHT, 2, trackAreaH);
    ctx.fillRect(x2 - 2, RULER_HEIGHT, 2, trackAreaH);
  }

  private drawTracks(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
    trackAreaH: number,
  ): void {
    const sorted = [...this.tracks].sort((a, b) => a.index - b.index);

    for (const track of sorted) {
      const y = this.trackY(track.index);
      if (y + TRACK_HEIGHT < RULER_HEIGHT || y > RULER_HEIGHT + trackAreaH)
        continue;

      const isSelected = this.selection.trackIds.has(track.id);

      // Track background
      ctx.fillStyle =
        track.index % 2 === 0 ? COLORS.trackBg : COLORS.trackBgAlt;
      ctx.fillRect(TRACK_LABEL_WIDTH, y, w - TRACK_LABEL_WIDTH, TRACK_HEIGHT);

      // Selection highlight
      if (isSelected) {
        ctx.fillStyle = COLORS.selection;
        ctx.fillRect(TRACK_LABEL_WIDTH, y, w - TRACK_LABEL_WIDTH, TRACK_HEIGHT);
      }

      // Track label area
      ctx.fillStyle = COLORS.trackLabelBg;
      ctx.fillRect(0, y, TRACK_LABEL_WIDTH, TRACK_HEIGHT);
      ctx.fillStyle = COLORS.trackBorder;
      ctx.fillRect(TRACK_LABEL_WIDTH, y, 1, TRACK_HEIGHT);

      this.drawTrackLabel(ctx, track, y);
      this.drawTrackBorder(ctx, w, y);

      for (const clip of track.clips) {
        this.drawClip(ctx, clip, track, y);
      }
    }

    // Scroll-clip the track area
    ctx.clearRect(0, 0, TRACK_LABEL_WIDTH, RULER_HEIGHT);
    ctx.fillStyle = COLORS.trackLabelBg;
    ctx.fillRect(0, 0, TRACK_LABEL_WIDTH, RULER_HEIGHT);
  }

  private drawTrackLabel(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    track: Track,
    y: number,
  ): void {
    const typeEmoji: Record<TrackType, string> = {
      VIDEO: "🎬",
      AUDIO: "🎵",
      TEXT: "T",
      AI_EFFECT: "✨",
    };

    const typeColor: Record<TrackType, string> = {
      VIDEO: COLORS.clipVideo.label,
      AUDIO: COLORS.clipAudio.label,
      TEXT: COLORS.clipText.label,
      AI_EFFECT: COLORS.clipEffect.label,
    };

    ctx.font = "10px monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS.trackLabelText;
    ctx.fillText(typeEmoji[track.type], 8, y + 14);

    ctx.fillStyle = typeColor[track.type];
    const name =
      track.name.length > 8 ? track.name.slice(0, 7) + "…" : track.name;
    ctx.fillText(name, 8, y + 30);

    // Mute / solo indicators
    if (track.muted) {
      ctx.fillStyle = "#ef4444";
      ctx.fillText("M", 70, y + 14);
    }
    if (track.solo) {
      ctx.fillStyle = "#f59e0b";
      ctx.fillText("S", 80, y + 14);
    }
  }

  private drawTrackBorder(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
    y: number,
  ): void {
    ctx.fillStyle = COLORS.trackBorder;
    ctx.fillRect(0, y + TRACK_HEIGHT - 1, w, 1);
  }

  private getClipColors(type: TrackType): {
    fill: string;
    border: string;
    label: string;
  } {
    switch (type) {
      case "VIDEO":
        return COLORS.clipVideo;
      case "AUDIO":
        return COLORS.clipAudio;
      case "TEXT":
        return COLORS.clipText;
      case "AI_EFFECT":
        return COLORS.clipEffect;
    }
  }

  private drawClip(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    clip: Clip,
    track: Track,
    trackY: number,
  ): void {
    const x = this.secToX(clip.startSec);
    const x2 = this.secToX(clip.endSec);
    const clipW = x2 - x;
    const clipH = TRACK_HEIGHT - 2;
    const y = trackY + 1;

    if (x2 < TRACK_LABEL_WIDTH || x > this.width) return;
    if (clipW < 1) return;

    const colors = this.getClipColors(track.type);
    const isSelected = this.selection.clipIds.has(clip.id);
    const isHover = this.hoverClipId === clip.id;

    // Clip body
    ctx.save();
    ctx.beginPath();
    const r = 4;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + clipW - r, y);
    ctx.arcTo(x + clipW, y, x + clipW, y + r, r);
    ctx.lineTo(x + clipW, y + clipH - r);
    ctx.arcTo(x + clipW, y + clipH, x + clipW - r, y + clipH, r);
    ctx.lineTo(x + r, y + clipH);
    ctx.arcTo(x, y + clipH, x, y + clipH - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();

    // Clip to canvas bounds
    ctx.clip();

    ctx.fillStyle = isSelected
      ? colors.fill.replace("22", "44")
      : isHover
        ? colors.fill.replace("22", "33")
        : colors.fill;
    ctx.fill();

    // Waveform for audio
    if (track.type === "AUDIO" && clip.waveformSamples) {
      this.drawWaveform(ctx, clip, track, x, y, clipW, clipH);
    }

    // Video thumbnail strip
    if (track.type === "VIDEO" && clip.thumbnailUrl) {
      this.drawVideoThumbnails(ctx, x, y, clipW, clipH);
    }

    // Text preview
    if (track.type === "TEXT" && clip.properties.text) {
      ctx.fillStyle = colors.label;
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(
        String(clip.properties.text).slice(0, 30),
        x + 6,
        y + clipH / 2,
      );
    }

    // AI effect badge
    if (track.type === "AI_EFFECT") {
      ctx.fillStyle = colors.label;
      ctx.font = "10px monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("AI", x + 6, y + clipH / 2);
    }

    ctx.restore();

    // Clip border
    ctx.strokeStyle = isSelected ? COLORS.selectionBorder : colors.border;
    ctx.lineWidth = isSelected ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + clipW - r, y);
    ctx.arcTo(x + clipW, y, x + clipW, y + r, r);
    ctx.lineTo(x + clipW, y + clipH - r);
    ctx.arcTo(x + clipW, y + clipH, x + clipW - r, y + clipH, r);
    ctx.lineTo(x + r, y + clipH);
    ctx.arcTo(x, y + clipH, x, y + clipH - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.stroke();

    // Clip label
    if (clipW > 20) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 2, y, clipW - 4, clipH);
      ctx.clip();
      ctx.fillStyle = colors.label;
      ctx.font = "10px monospace";
      ctx.textBaseline = "top";
      ctx.fillText(clip.label ?? clip.id.slice(0, 8), x + 6, y + 4);
      ctx.restore();
    }

    // Trim handles
    if (isSelected || isHover) {
      this.drawTrimHandle(ctx, x, y, clipH, "left");
      this.drawTrimHandle(ctx, x + clipW, y, clipH, "right");
    }

    // Keyframe diamonds
    if (isSelected && clip.keyframes.length > 0) {
      this.drawClipKeyframes(ctx, clip, y + clipH - 10);
    }
  }

  private drawWaveform(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    clip: Clip,
    track: Track,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const samples = clip.waveformSamples!;
    if (samples.length === 0) return;

    const midY = y + h / 2;
    const halfH = (h / 2) * 0.8;

    ctx.strokeStyle = track.muted ? COLORS.waveformMuted : COLORS.waveform;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;

    const pixelsPerSample = w / samples.length;
    const step = Math.max(1, Math.floor(1 / pixelsPerSample));

    ctx.beginPath();
    for (let i = 0; i < samples.length; i += step) {
      const px = x + (i / samples.length) * w;
      const amplitude = samples[i] * halfH;
      ctx.moveTo(px, midY - amplitude);
      ctx.lineTo(px, midY + amplitude);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawVideoThumbnails(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    // Placeholder: draw a gradient thumbnail strip
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, "rgba(124,58,237,0.1)");
    grad.addColorStop(0.5, "rgba(124,58,237,0.05)");
    grad.addColorStop(1, "rgba(124,58,237,0.1)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
  }

  private drawTrimHandle(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x: number,
    y: number,
    h: number,
    side: "left" | "right",
  ): void {
    const hw = RESIZE_HANDLE_WIDTH;
    const isActive =
      this.drag?.type === (side === "left" ? "TRIM_IN" : "TRIM_OUT");
    const isHoverHandle = this.hoverHandle === (side === "left" ? "TRIM_IN" : "TRIM_OUT");

    ctx.fillStyle = isActive
      ? COLORS.handleActive
      : isHoverHandle
        ? COLORS.handleHover
        : "rgba(255,255,255,0.08)";
    const hx = side === "left" ? x : x - hw;
    ctx.fillRect(hx, y + 2, hw, h - 4);

    // Grip lines
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    const lineX = side === "left" ? x + hw / 2 - 0.5 : x - hw / 2 - 0.5;
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(lineX + (i - 1) * 3, y + h / 2 - 4, 1, 8);
    }
  }

  private drawClipKeyframes(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    clip: Clip,
    y: number,
  ): void {
    const kfs = clip.keyframes.filter((k) => k.property === this.selectedProperty);
    for (const kf of kfs) {
      const kx = this.secToX(clip.startSec + kf.timeSec);
      if (kx < TRACK_LABEL_WIDTH || kx > this.width) continue;
      const selected = this.selection.keyframeIds.has(kf.id);
      this.drawDiamond(ctx, kx, y, 5, selected ? COLORS.keyframeSelected : COLORS.keyframeDiamond);
    }
  }

  private drawDiamond(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    color: string,
  ): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx + size, cy);
    ctx.lineTo(cx, cy + size);
    ctx.lineTo(cx - size, cy);
    ctx.closePath();
    ctx.fill();
  }

  private drawPlayhead(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    trackAreaH: number,
  ): void {
    const x = this.secToX(this.playhead.timeSec);
    if (x < TRACK_LABEL_WIDTH || x > this.width) return;

    // Shadow
    ctx.fillStyle = COLORS.playheadShadow;
    ctx.fillRect(x - 2, RULER_HEIGHT, 4, trackAreaH);

    // Line
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(x - 0.5, RULER_HEIGHT, 1, trackAreaH);

    // Head triangle
    ctx.beginPath();
    ctx.moveTo(x - 6, RULER_HEIGHT - 1);
    ctx.lineTo(x + 6, RULER_HEIGHT - 1);
    ctx.lineTo(x, RULER_HEIGHT + 10);
    ctx.closePath();
    ctx.fillStyle = COLORS.playhead;
    ctx.fill();

    // Timecode label
    const label = formatTimecode(this.playhead.timeSec, this.playhead.fps);
    ctx.font = "9px monospace";
    ctx.textBaseline = "top";
    const tw = ctx.measureText(label).width;
    const lx = Math.max(TRACK_LABEL_WIDTH + 2, Math.min(x - tw / 2, this.width - tw - 2));
    ctx.fillStyle = COLORS.playhead;
    ctx.fillText(label, lx, 2);
  }

  private drawKeyframeEditor(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
    h: number,
    kfH: number,
  ): void {
    const y = h - kfH;

    // Background
    ctx.fillStyle = "#0a0a14";
    ctx.fillRect(0, y, w, kfH);
    ctx.fillStyle = COLORS.trackBorder;
    ctx.fillRect(0, y, w, 1);

    // Label
    ctx.fillStyle = COLORS.trackLabelText;
    ctx.font = "9px monospace";
    ctx.textBaseline = "top";
    ctx.fillText(`KEYFRAMES: ${this.selectedProperty.toUpperCase()}`, 8, y + 6);

    // Value axis
    const valueLabels = [1.0, 0.75, 0.5, 0.25, 0.0];
    for (const v of valueLabels) {
      const vy = y + 20 + (1 - v) * (kfH - 30);
      ctx.fillStyle = COLORS.rulerTick;
      ctx.fillRect(TRACK_LABEL_WIDTH, vy, w - TRACK_LABEL_WIDTH, 1);
      ctx.fillStyle = COLORS.rulerText;
      ctx.fillText(v.toFixed(2), 2, vy - 5);
    }

    // Draw keyframe curves for selected clips
    for (const clipId of this.selection.clipIds) {
      const { clip, track } = this.findClip(clipId) ?? {};
      if (!clip || !track) continue;

      const kfs = clip.keyframes
        .filter((k) => k.property === this.selectedProperty)
        .sort((a, b) => a.timeSec - b.timeSec);

      if (kfs.length < 2) continue;

      const colors = this.getClipColors(track.type);
      ctx.strokeStyle = colors.label;
      ctx.lineWidth = 1.5;
      ctx.beginPath();

      for (let i = 0; i < kfs.length - 1; i++) {
        const steps = 20;
        for (let s = 0; s <= steps; s++) {
          const t = kfs[i].timeSec + ((kfs[i + 1].timeSec - kfs[i].timeSec) * s) / steps;
          const v = interpolateKeyframes(kfs[i], kfs[i + 1], t);
          const px = this.secToX(clip.startSec + t);
          const py = y + 20 + (1 - v) * (kfH - 30);
          if (s === 0 && i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();

      // Draw diamonds
      for (const kf of kfs) {
        const kx = this.secToX(clip.startSec + kf.timeSec);
        const ky = y + 20 + (1 - kf.value) * (kfH - 30);
        const selected = this.selection.keyframeIds.has(kf.id);
        this.drawDiamond(
          ctx,
          kx,
          ky,
          4,
          selected ? COLORS.keyframeSelected : COLORS.keyframeDiamond,
        );
      }
    }
  }

  private drawScrollbars(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    w: number,
    h: number,
    trackAreaH: number,
  ): void {
    const totalContentW = this.durationSec * this.pps + TRACK_LABEL_WIDTH;
    const contentW = totalContentW;
    if (contentW <= w) return;

    const sbH = 6;
    const sbY = h - sbH - 2;
    const sbX = TRACK_LABEL_WIDTH;
    const sbW = w - TRACK_LABEL_WIDTH;

    const thumbW = Math.max(20, (sbW / contentW) * sbW);
    const thumbX =
      sbX + (this.view.scrollX / (contentW - sbW)) * (sbW - thumbW);

    ctx.fillStyle = COLORS.scrollbar;
    ctx.fillRect(sbX, sbY, sbW, sbH);
    ctx.fillStyle = COLORS.scrollbarThumb;
    ctx.beginPath();
    ctx.roundRect(thumbX, sbY, thumbW, sbH, 3);
    ctx.fill();
  }

  // ── Event handling ────────────────────────────────────────────────────────

  private boundPointerDown: (e: PointerEvent) => void = () => {};
  private boundPointerMove: (e: PointerEvent) => void = () => {};
  private boundPointerUp: (e: PointerEvent) => void = () => {};
  private boundWheel: (e: WheelEvent) => void = () => {};
  private boundKeyDown: (e: KeyboardEvent) => void = () => {};

  private attachEventListeners(canvas: HTMLCanvasElement): void {
    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundWheel = this.onWheel.bind(this);
    this.boundKeyDown = this.onKeyDown.bind(this);

    canvas.addEventListener("pointerdown", this.boundPointerDown);
    canvas.addEventListener("pointermove", this.boundPointerMove);
    canvas.addEventListener("pointerup", this.boundPointerUp);
    canvas.addEventListener("wheel", this.boundWheel, { passive: false });
    window.addEventListener("keydown", this.boundKeyDown);
  }

  private detachEventListeners(canvas: HTMLCanvasElement): void {
    canvas.removeEventListener("pointerdown", this.boundPointerDown);
    canvas.removeEventListener("pointermove", this.boundPointerMove);
    canvas.removeEventListener("pointerup", this.boundPointerUp);
    canvas.removeEventListener("wheel", this.boundWheel);
    window.removeEventListener("keydown", this.boundKeyDown);
  }

  private getCanvasPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const canvas = this.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  private onPointerDown(e: PointerEvent): void {
    const { x, y } = this.getCanvasPos(e);

    // Playhead drag
    const playX = this.secToX(this.playhead.timeSec);
    if (y < RULER_HEIGHT && x > TRACK_LABEL_WIDTH) {
      this.drag = { type: "PLAYHEAD" };
      const timeSec = this.xToSec(x);
      this.seek(timeSec);
      return;
    }

    // Razor tool
    if (this.tool === "RAZOR" && y > RULER_HEIGHT) {
      const atSec = snapToFrame(this.xToSec(x), this.playhead.fps);
      const target = this.findClipAtPos(x, y);
      if (target) {
        this.emit({ type: "CLIP_SPLIT", clipId: target.clip.id, atSec });
      }
      return;
    }

    // Check trim handles on clips
    if (y > RULER_HEIGHT) {
      const trimTarget = this.findTrimHandleAtPos(x, y);
      if (trimTarget) {
        this.drag = trimTarget;
        (this.canvas as HTMLCanvasElement).setPointerCapture(e.pointerId);
        return;
      }

      // Check clip selection / drag
      const target = this.findClipAtPos(x, y);
      if (target) {
        const { clip } = target;
        if (!e.shiftKey) {
          this.selection.clipIds.clear();
          this.selection.trackIds.clear();
        }
        this.selection.clipIds.add(clip.id);
        this.emit({
          type: "CLIP_SELECT",
          clipId: clip.id,
          multi: e.shiftKey,
        });
        this.drag = {
          type: "CLIP",
          clipId: clip.id,
          offsetSec: this.xToSec(x) - clip.startSec,
        };
        (this.canvas as HTMLCanvasElement).setPointerCapture(e.pointerId);
        this.dirty = true;
        return;
      }

      // Click on empty area — deselect
      if (!e.shiftKey) {
        this.selection.clipIds.clear();
        this.selection.trackIds.clear();
        this.dirty = true;
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.getCanvasPos(e);

    if (!this.drag) {
      // Update hover state
      const prev = this.hoverClipId;
      const prevHandle = this.hoverHandle;
      const trimTarget = this.findTrimHandleAtPos(x, y);
      if (trimTarget) {
        this.hoverClipId = trimTarget.type === "TRIM_IN" || trimTarget.type === "TRIM_OUT"
          ? (trimTarget as { clipId: string }).clipId
          : null;
        this.hoverHandle =
          trimTarget.type === "TRIM_IN" ? "TRIM_IN" : "TRIM_OUT";
      } else {
        const target = this.findClipAtPos(x, y);
        this.hoverClipId = target?.clip.id ?? null;
        this.hoverHandle = null;
      }
      if (prev !== this.hoverClipId || prevHandle !== this.hoverHandle) {
        this.dirty = true;
        const c = this.canvas as HTMLCanvasElement;
        if (this.hoverHandle) {
          c.style.cursor = "ew-resize";
        } else if (this.tool === "RAZOR") {
          c.style.cursor = "crosshair";
        } else if (this.hoverClipId) {
          c.style.cursor = "grab";
        } else {
          c.style.cursor = "default";
        }
      }
      return;
    }

    if (this.drag.type === "PLAYHEAD") {
      const timeSec = Math.max(0, Math.min(this.durationSec, this.xToSec(x)));
      this.seek(timeSec);
      return;
    }

    if (this.drag.type === "CLIP") {
      const { clipId, offsetSec } = this.drag;
      const { clip } = this.findClip(clipId) ?? {};
      if (!clip) return;

      let newStart = snapToFrame(
        this.xToSec(x) - offsetSec,
        this.playhead.fps,
      );
      newStart = Math.max(0, newStart);
      const duration = clip.endSec - clip.startSec;

      // Snapping to other clip edges
      const snapped = this.snapToNearbyClips(newStart, clipId);
      const targetTrackId = this.findTrackAtY(y)?.id ?? clip.trackId;

      clip.startSec = snapped;
      clip.endSec = snapped + duration;
      clip.trackId = targetTrackId;
      this.emit({
        type: "CLIP_MOVE",
        clipId,
        startSec: snapped,
        trackId: targetTrackId,
      });
      this.dirty = true;
      return;
    }

    if (this.drag.type === "TRIM_IN") {
      const { clipId } = this.drag;
      const { clip } = this.findClip(clipId) ?? {};
      if (!clip) return;

      const newStart = snapToFrame(
        Math.min(this.xToSec(x), clip.endSec - MIN_CLIP_DURATION_SEC),
        this.playhead.fps,
      );
      const delta = newStart - clip.startSec;
      clip.startSec = Math.max(0, newStart);
      clip.trimInSec = Math.max(0, clip.trimInSec + delta);
      this.emit({
        type: "CLIP_TRIM_START",
        clipId,
        trimInSec: clip.trimInSec,
      });
      this.dirty = true;
      return;
    }

    if (this.drag.type === "TRIM_OUT") {
      const { clipId } = this.drag;
      const { clip } = this.findClip(clipId) ?? {};
      if (!clip) return;

      const newEnd = snapToFrame(
        Math.max(this.xToSec(x), clip.startSec + MIN_CLIP_DURATION_SEC),
        this.playhead.fps,
      );
      const delta = newEnd - clip.endSec;
      clip.endSec = newEnd;
      clip.trimOutSec = Math.max(0, clip.trimOutSec - delta);
      this.emit({
        type: "CLIP_TRIM_END",
        clipId,
        trimOutSec: clip.trimOutSec,
      });
      this.dirty = true;
      return;
    }
  }

  private onPointerUp(_e: PointerEvent): void {
    this.drag = null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const { x } = this.getCanvasPos(e);

    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      this.setZoom(this.view.zoom * factor, x);
    } else if (e.shiftKey) {
      // Horizontal scroll
      this.view.scrollX = Math.max(0, this.view.scrollX + e.deltaY);
      this.emit({
        type: "SCROLL_CHANGE",
        scrollX: this.view.scrollX,
        scrollY: this.view.scrollY,
      });
    } else {
      // Vertical scroll
      this.view.scrollY = Math.max(0, this.view.scrollY + e.deltaY);
      this.emit({
        type: "SCROLL_CHANGE",
        scrollX: this.view.scrollX,
        scrollY: this.view.scrollY,
      });
    }
    this.dirty = true;
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Prevent default for space to avoid page scroll
    if (e.code === "Space") {
      e.preventDefault();
      this.playhead.isPlaying = !this.playhead.isPlaying;
      this.dirty = true;
    }

    if (e.code === "KeyS" && !e.ctrlKey && !e.metaKey) {
      this.setTool("SELECT");
    }
    if (e.code === "KeyR" && !e.ctrlKey) {
      this.setTool("RAZOR");
    }
    if (e.code === "KeyH") {
      this.setTool("HAND");
    }

    // Delete selected clips
    if (e.code === "Delete" || e.code === "Backspace") {
      for (const clipId of this.selection.clipIds) {
        const result = this.findClip(clipId);
        if (result) {
          result.track.clips = result.track.clips.filter(
            (c) => c.id !== clipId,
          );
        }
      }
      this.selection.clipIds.clear();
      this.dirty = true;
    }

    // Arrow keys to nudge playhead by one frame
    if (e.code === "ArrowLeft") {
      this.seek(this.playhead.timeSec - 1 / this.playhead.fps);
    }
    if (e.code === "ArrowRight") {
      this.seek(this.playhead.timeSec + 1 / this.playhead.fps);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private emit(event: TimelineEvent): void {
    for (const l of this.listeners) l(event);
  }

  private findClip(clipId: string): { clip: Clip; track: Track } | null {
    for (const track of this.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  private findClipAtPos(
    x: number,
    y: number,
  ): { clip: Clip; track: Track } | null {
    const sorted = [...this.tracks].sort((a, b) => a.index - b.index);
    for (const track of sorted) {
      const ty = this.trackY(track.index);
      if (y < ty || y > ty + TRACK_HEIGHT) continue;
      for (const clip of track.clips) {
        const cx = this.secToX(clip.startSec);
        const cx2 = this.secToX(clip.endSec);
        if (x >= cx && x <= cx2) return { clip, track };
      }
    }
    return null;
  }

  private findTrimHandleAtPos(
    x: number,
    y: number,
  ): DragTarget | null {
    for (const track of this.tracks) {
      const ty = this.trackY(track.index);
      if (y < ty || y > ty + TRACK_HEIGHT) continue;
      for (const clip of track.clips) {
        const cx = this.secToX(clip.startSec);
        const cx2 = this.secToX(clip.endSec);
        if (
          x >= cx - RESIZE_HANDLE_WIDTH &&
          x <= cx + RESIZE_HANDLE_WIDTH
        ) {
          return { type: "TRIM_IN", clipId: clip.id };
        }
        if (
          x >= cx2 - RESIZE_HANDLE_WIDTH &&
          x <= cx2 + RESIZE_HANDLE_WIDTH
        ) {
          return { type: "TRIM_OUT", clipId: clip.id };
        }
      }
    }
    return null;
  }

  private findTrackAtY(y: number): Track | null {
    for (const track of this.tracks) {
      const ty = this.trackY(track.index);
      if (y >= ty && y <= ty + TRACK_HEIGHT) return track;
    }
    return null;
  }

  private snapToNearbyClips(startSec: number, excludeClipId: string): number {
    const threshold = SNAP_THRESHOLD_PX / this.pps;
    let best = startSec;
    let bestDist = threshold;

    for (const track of this.tracks) {
      for (const clip of track.clips) {
        if (clip.id === excludeClipId) continue;
        for (const edge of [clip.startSec, clip.endSec]) {
          const dist = Math.abs(startSec - edge);
          if (dist < bestDist) {
            bestDist = dist;
            best = edge;
          }
        }
      }
    }
    return best;
  }
}

// ── Utility ───────────────────────────────────────────────────────────────

/**
 * Format a time in seconds as a SMPTE timecode string (HH:MM:SS:FF).
 */
export function formatTimecode(timeSec: number, fps: number): string {
  const totalFrames = Math.round(timeSec * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
    String(frames).padStart(2, "0"),
  ].join(":");
}

/**
 * Parse a SMPTE timecode string to seconds.
 */
export function parseTimecode(tc: string, fps: number): number {
  const parts = tc.split(":").map(Number);
  if (parts.length !== 4) return 0;
  const [hours, minutes, seconds, frames] = parts;
  return hours * 3600 + minutes * 60 + seconds + frames / fps;
}

/**
 * Decode an audio buffer into normalised PCM Float32Array for waveform display.
 * Returns one amplitude sample per pixel-column of the target width.
 */
export async function decodeAudioForWaveform(
  audioContext: AudioContext,
  arrayBuffer: ArrayBuffer,
  targetSamples: number,
): Promise<Float32Array> {
  const buffer = await audioContext.decodeAudioData(arrayBuffer);
  const channelData = buffer.getChannelData(0);
  const samplesPerBin = Math.floor(channelData.length / targetSamples);
  const result = new Float32Array(targetSamples);

  for (let i = 0; i < targetSamples; i++) {
    let max = 0;
    const start = i * samplesPerBin;
    const end = Math.min(start + samplesPerBin, channelData.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > max) max = abs;
    }
    result[i] = max;
  }

  return result;
}

/**
 * Create a blank set of tracks for a new project.
 */
export function createDefaultTracks(timelineId: string): Track[] {
  return [
    {
      id: `${timelineId}-track-video-1`,
      timelineId,
      type: "VIDEO",
      name: "Video 1",
      index: 0,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      clips: [],
    },
    {
      id: `${timelineId}-track-video-2`,
      timelineId,
      type: "VIDEO",
      name: "Video 2",
      index: 1,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      clips: [],
    },
    {
      id: `${timelineId}-track-audio-1`,
      timelineId,
      type: "AUDIO",
      name: "Audio 1",
      index: 2,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      clips: [],
    },
    {
      id: `${timelineId}-track-audio-2`,
      timelineId,
      type: "AUDIO",
      name: "Music",
      index: 3,
      muted: false,
      solo: false,
      locked: false,
      volume: 0.8,
      clips: [],
    },
    {
      id: `${timelineId}-track-text`,
      timelineId,
      type: "TEXT",
      name: "Titles",
      index: 4,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      clips: [],
    },
    {
      id: `${timelineId}-track-effects`,
      timelineId,
      type: "AI_EFFECT",
      name: "AI FX",
      index: 5,
      muted: false,
      solo: false,
      locked: false,
      volume: 1,
      clips: [],
    },
  ];
}
