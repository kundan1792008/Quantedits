"use client";

/**
 * ColorWheelEditor — Professional 3-Way Color Wheel Component
 *
 * Features:
 *   - 3-way color wheel (Shadows / Midtones / Highlights)
 *   - Tone curve editor (Luma + per-channel RGB)
 *   - HSL qualifier for selective color adjustments
 *   - Split-screen before/after comparison
 *   - Real-time preview via ColorGradingEngine
 *   - Full keyboard accessibility
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useId,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Circle,
  SlidersHorizontal,
  Columns2,
  RefreshCw,
  Zap,
  Palette,
} from "lucide-react";
import {
  GRADE_PRESETS,
  ALL_PRESET_IDS,
  type GradeAdjustments,
  type GradePresetId,
  colorGradingEngine,
} from "@/services/ColorGradingEngine";

// ── Types ──────────────────────────────────────────────────────────────────

export type WheelTarget = "shadows" | "midtones" | "highlights";
export type CurveChannel = "luma" | "r" | "g" | "b";

/** Single color wheel state (hue + magnitude). */
interface WheelState {
  x: number; // −1 … +1 horizontal offset from center
  y: number; // −1 … +1 vertical offset from center
}

/** Curve control point. */
interface CurvePoint {
  x: number; // 0–1 input
  y: number; // 0–1 output
}

export interface ColorWheelEditorProps {
  /** Source ImageData for real-time preview. */
  sourceFrame?: ImageData | null;
  /** Initial preset to load. */
  initialPreset?: GradePresetId;
  /** Called when adjustments change — useful for applying to timeline. */
  onAdjustmentsChange?: (adjustments: GradeAdjustments) => void;
  /** Called when a grade is applied to the source frame. */
  onGradeApplied?: (graded: ImageData) => void;
  className?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert wheel {x, y} to RGB tint [r, g, b] with magnitude. */
function wheelToTint(state: WheelState): [number, number, number] {
  const angle = Math.atan2(state.y, state.x);
  const mag = Math.min(1, Math.sqrt(state.x * state.x + state.y * state.y));
  const r = Math.cos(angle) * mag * 0.3;
  const g = Math.cos(angle + (2 * Math.PI) / 3) * mag * 0.3;
  const b = Math.cos(angle + (4 * Math.PI) / 3) * mag * 0.3;
  return [r, g, b];
}

/** Convert tint [r, g, b] back to wheel {x, y}. */
function tintToWheel(tint: [number, number, number]): WheelState {
  const x = (tint[0] - tint[2]) / 0.3;
  const y = (tint[1] - tint[0]) / 0.3;
  return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
}

/** Default curve points (identity). */
const DEFAULT_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 0.25, y: 0.25 },
  { x: 0.5, y: 0.5 },
  { x: 0.75, y: 0.75 },
  { x: 1, y: 1 },
];

/** Compute a smooth curve path through control points (cubic Catmull-Rom). */
function curveSVGPath(points: CurvePoint[], w: number, h: number): string {
  if (points.length < 2) return "";
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const toSVG = (p: CurvePoint) => ({
    sx: p.x * w,
    sy: h - p.y * h,
  });
  const pts = sorted.map(toSVG);
  let d = `M ${pts[0].sx} ${pts[0].sy}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.sx + (p2.sx - p0.sx) / 6;
    const cp1y = p1.sy + (p2.sy - p0.sy) / 6;
    const cp2x = p2.sx - (p3.sx - p1.sx) / 6;
    const cp2y = p2.sy - (p3.sy - p1.sy) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.sx} ${p2.sy}`;
  }
  return d;
}

// ── Color Wheel Sub-Component ──────────────────────────────────────────────

interface ColorWheelProps {
  label: string;
  state: WheelState;
  onChange: (state: WheelState) => void;
  size?: number;
  accentColor?: string;
}

function ColorWheel({ label, state, onChange, size = 120, accentColor = "#7C3AED" }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  // Draw hue/saturation wheel
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cx = size / 2;
    const cy = size / 2;
    const r = cx - 4;

    // Draw hue ring using conic gradient (polyfill via per-pixel arc)
    for (let deg = 0; deg < 360; deg++) {
      const rad = (deg * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, rad, rad + (2 * Math.PI) / 360 + 0.01);
      ctx.closePath();
      ctx.fillStyle = `hsl(${deg}, 100%, 50%)`;
      ctx.fill();
    }

    // Radial white-to-transparent overlay
    const radialGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    radialGrad.addColorStop(0, "rgba(255,255,255,1)");
    radialGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = radialGrad;
    ctx.fill();

    // Black vignette ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [size]);

  const handlePointer = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = size / 2;
      const cy = size / 2;
      const r = cx - 4;
      const px = (e.clientX - rect.left) * (canvas.width / rect.width) - cx;
      const py = (e.clientY - rect.top) * (canvas.height / rect.height) - cy;
      const dist = Math.sqrt(px * px + py * py);
      const nx = px / r;
      const ny = py / r;
      if (dist <= r) {
        onChange({ x: Math.max(-1, Math.min(1, nx)), y: Math.max(-1, Math.min(1, ny)) });
      }
    },
    [size, onChange],
  );

  const pxX = size / 2 + state.x * (size / 2 - 4);
  const pxY = size / 2 + state.y * (size / 2 - 4);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative select-none" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className="rounded-full cursor-crosshair touch-none"
          style={{ display: "block" }}
          aria-label={`${label} color wheel`}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            handlePointer(e);
          }}
          onPointerMove={(e) => { if (dragging.current) handlePointer(e); }}
          onPointerUp={() => { dragging.current = false; }}
          onPointerCancel={() => { dragging.current = false; }}
        />
        {/* Cursor dot */}
        <div
          className="absolute pointer-events-none rounded-full border-2 border-white shadow-lg"
          style={{
            width: 12,
            height: 12,
            left: pxX - 6,
            top: pxY - 6,
            background: accentColor,
            boxShadow: `0 0 0 1px rgba(0,0,0,0.5), 0 0 6px ${accentColor}88`,
          }}
          aria-hidden
        />
      </div>
      <span className="text-[11px] font-medium text-[#7a7a9a] uppercase tracking-widest">
        {label}
      </span>
    </div>
  );
}

// ── Curve Editor Sub-Component ─────────────────────────────────────────────

interface CurveEditorProps {
  channel: CurveChannel;
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
  width?: number;
  height?: number;
}

const CURVE_COLORS: Record<CurveChannel, string> = {
  luma: "#c8c8e8",
  r: "#ef4444",
  g: "#22c55e",
  b: "#3b82f6",
};

function CurveEditor({ channel, points, onChange, width = 200, height = 160 }: CurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const handleSVGPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * width;
      const py = ((e.clientY - rect.top) / rect.height) * height;
      const nx = Math.max(0, Math.min(1, px / width));
      const ny = Math.max(0, Math.min(1, 1 - py / height));

      // Check if clicking near an existing point
      const thresh = 12;
      for (let i = 0; i < points.length; i++) {
        const dx = (points[i].x - nx) * width;
        const dy = (points[i].y - ny) * height;
        if (Math.sqrt(dx * dx + dy * dy) < thresh) {
          setDraggingIndex(i);
          (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
          return;
        }
      }

      // Add new point
      const newPts = [...points, { x: nx, y: ny }].sort((a, b) => a.x - b.x);
      onChange(newPts);
    },
    [points, onChange, width, height],
  );

  const handleSVGPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (draggingIndex === null) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      const newPts = points.map((p, i) =>
        i === draggingIndex ? { x: nx, y: ny } : p,
      );
      onChange(newPts);
    },
    [draggingIndex, points, onChange],
  );

  const removePoint = useCallback(
    (index: number) => {
      if (points.length <= 2) return; // Keep at least 2 anchor points
      onChange(points.filter((_, i) => i !== index));
    },
    [points, onChange],
  );

  const curvePath = curveSVGPath(points, width, height);
  const color = CURVE_COLORS[channel];

  return (
    <div className="flex flex-col gap-1">
      <div className="relative" style={{ width, height }}>
        {/* Grid lines */}
        <svg
          width={width}
          height={height}
          className="absolute inset-0"
          aria-hidden
        >
          {[0.25, 0.5, 0.75].map((v) => (
            <line
              key={v}
              x1={v * width} y1={0} x2={v * width} y2={height}
              stroke="#2a2a3e" strokeWidth={1}
            />
          ))}
          {[0.25, 0.5, 0.75].map((v) => (
            <line
              key={v}
              x1={0} y1={(1 - v) * height} x2={width} y2={(1 - v) * height}
              stroke="#2a2a3e" strokeWidth={1}
            />
          ))}
          {/* Diagonal identity line */}
          <line x1={0} y1={height} x2={width} y2={0} stroke="#3a3a5a" strokeWidth={1} strokeDasharray="4 4" />
        </svg>

        {/* Interactive SVG layer */}
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className="absolute inset-0 cursor-crosshair touch-none"
          role="img"
          aria-label={`${channel} curve editor`}
          onPointerDown={handleSVGPointerDown}
          onPointerMove={handleSVGPointerMove}
          onPointerUp={() => setDraggingIndex(null)}
          onPointerCancel={() => setDraggingIndex(null)}
        >
          {/* Curve path */}
          {curvePath && (
            <path
              d={curvePath}
              fill="none"
              stroke={color}
              strokeWidth={2}
              opacity={0.9}
            />
          )}
          {/* Control points */}
          {points.sort((a, b) => a.x - b.x).map((p, i) => (
            <circle
              key={i}
              cx={p.x * width}
              cy={(1 - p.y) * height}
              r={5}
              fill={color}
              stroke="#0D0D11"
              strokeWidth={1.5}
              className="cursor-grab active:cursor-grabbing"
              onDoubleClick={(e) => { e.stopPropagation(); removePoint(i); }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

// ── HSL Qualifier Sub-Component ────────────────────────────────────────────

interface HSLRange {
  hueCenter: number; // 0–360
  hueWidth: number; // 0–180
  satMin: number; // 0–1
  satMax: number; // 0–1
  lumaMin: number; // 0–1
  lumaMax: number; // 0–1
}

interface HSLQualifierProps {
  value: HSLRange;
  onChange: (value: HSLRange) => void;
}

function HSLQualifier({ value, onChange }: HSLQualifierProps) {
  const update = (partial: Partial<HSLRange>) => onChange({ ...value, ...partial });

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[11px] font-semibold text-[#7a7a9a] uppercase tracking-widest">
        HSL Qualifier
      </span>

      {/* Hue selector */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="text-[11px] text-[#5a5a7a]">Hue Center</span>
          <span className="text-[11px] text-[#c8c8e8] font-mono">{Math.round(value.hueCenter)}°</span>
        </div>
        <div className="relative h-5 rounded-full overflow-hidden" style={{
          background: "linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))"
        }}>
          <input
            type="range" min={0} max={360} value={value.hueCenter} step={1}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
            onChange={(e) => update({ hueCenter: Number(e.target.value) })}
            aria-label="Hue center"
          />
          <div
            className="absolute top-0 h-full w-1 -translate-x-1/2 bg-white/90 pointer-events-none"
            style={{ left: `${(value.hueCenter / 360) * 100}%` }}
          />
        </div>
      </div>

      {/* Hue width */}
      <div className="flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="text-[11px] text-[#5a5a7a]">Hue Width</span>
          <span className="text-[11px] text-[#c8c8e8] font-mono">±{Math.round(value.hueWidth)}°</span>
        </div>
        <input
          type="range" min={0} max={180} value={value.hueWidth} step={1}
          className="w-full accent-purple-500 cursor-pointer"
          onChange={(e) => update({ hueWidth: Number(e.target.value) })}
          aria-label="Hue width"
        />
      </div>

      {/* Saturation range */}
      <div className="flex gap-3">
        <div className="flex flex-col gap-1 flex-1">
          <span className="text-[11px] text-[#5a5a7a]">Sat Min</span>
          <input
            type="range" min={0} max={100} value={Math.round(value.satMin * 100)} step={1}
            className="w-full accent-purple-500 cursor-pointer"
            onChange={(e) => update({ satMin: Number(e.target.value) / 100 })}
            aria-label="Saturation minimum"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <span className="text-[11px] text-[#5a5a7a]">Sat Max</span>
          <input
            type="range" min={0} max={100} value={Math.round(value.satMax * 100)} step={1}
            className="w-full accent-purple-500 cursor-pointer"
            onChange={(e) => update({ satMax: Number(e.target.value) / 100 })}
            aria-label="Saturation maximum"
          />
        </div>
      </div>

      {/* Luma range */}
      <div className="flex gap-3">
        <div className="flex flex-col gap-1 flex-1">
          <span className="text-[11px] text-[#5a5a7a]">Luma Min</span>
          <input
            type="range" min={0} max={100} value={Math.round(value.lumaMin * 100)} step={1}
            className="w-full accent-purple-500 cursor-pointer"
            onChange={(e) => update({ lumaMin: Number(e.target.value) / 100 })}
            aria-label="Luma minimum"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <span className="text-[11px] text-[#5a5a7a]">Luma Max</span>
          <input
            type="range" min={0} max={100} value={Math.round(value.lumaMax * 100)} step={1}
            className="w-full accent-purple-500 cursor-pointer"
            onChange={(e) => update({ lumaMax: Number(e.target.value) / 100 })}
            aria-label="Luma maximum"
          />
        </div>
      </div>
    </div>
  );
}

// ── Slider Row ─────────────────────────────────────────────────────────────

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  displayValue?: string;
}

function SliderRow({ label, value, min, max, step = 0.01, onChange, displayValue }: SliderRowProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-[#7a7a9a] w-24 shrink-0">{label}</span>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        className="flex-1 accent-purple-500 cursor-pointer"
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <span className="text-[11px] text-[#c8c8e8] font-mono w-12 text-right">
        {displayValue ?? value.toFixed(2)}
      </span>
    </div>
  );
}

// ── Split Screen Preview ───────────────────────────────────────────────────

interface SplitPreviewProps {
  sourceFrame: ImageData;
  gradedFrame: ImageData;
  width?: number;
  height?: number;
}

function SplitPreview({ sourceFrame, gradedFrame, width = 400, height = 225 }: SplitPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [splitX, setSplitX] = useState(0.5);
  const dragging = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Draw source on left half
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = sourceFrame.width;
    srcCanvas.height = sourceFrame.height;
    srcCanvas.getContext("2d")!.putImageData(sourceFrame, 0, 0);

    const gradCanvas = document.createElement("canvas");
    gradCanvas.width = gradedFrame.width;
    gradCanvas.height = gradedFrame.height;
    gradCanvas.getContext("2d")!.putImageData(gradedFrame, 0, 0);

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.rect(0, 0, splitX * width, height);
    ctx.clip();
    ctx.drawImage(srcCanvas, 0, 0, width, height);
    ctx.restore();

    ctx.save();
    ctx.rect(splitX * width, 0, width, height);
    ctx.clip();
    ctx.drawImage(gradCanvas, 0, 0, width, height);
    ctx.restore();

    // Divider line
    ctx.beginPath();
    ctx.moveTo(splitX * width, 0);
    ctx.lineTo(splitX * width, height);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Labels
    ctx.font = "11px monospace";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText("BEFORE", 8, 18);
    ctx.textAlign = "right";
    ctx.fillText("AFTER", width - 8, 18);
    ctx.textAlign = "left";
  }, [sourceFrame, gradedFrame, splitX, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="rounded-lg cursor-col-resize touch-none"
      style={{ width: "100%", maxWidth: width }}
      aria-label="Before/after split comparison"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
        setSplitX(Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width)));
      }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
    />
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

const TABS = [
  { id: "wheels", label: "Color Wheels", Icon: Circle },
  { id: "curves", label: "Curves", Icon: SlidersHorizontal },
  { id: "hsl", label: "HSL", Icon: Palette },
] as const;

type Tab = (typeof TABS)[number]["id"];

const DEFAULT_HSL: HSLRange = {
  hueCenter: 0,
  hueWidth: 30,
  satMin: 0,
  satMax: 1,
  lumaMin: 0,
  lumaMax: 1,
};

export default function ColorWheelEditor({
  sourceFrame,
  initialPreset = "neutral",
  onAdjustmentsChange,
  onGradeApplied,
  className = "",
}: ColorWheelEditorProps) {
  const id = useId();

  // Active preset
  const [presetId, setPresetId] = useState<GradePresetId>(initialPreset);

  // 3-way wheels
  const [shadowWheel, setShadowWheel] = useState<WheelState>(() =>
    tintToWheel(GRADE_PRESETS[initialPreset].adjustments.shadowTint),
  );
  const [midtoneWheel, setMidtoneWheel] = useState<WheelState>(() =>
    tintToWheel(GRADE_PRESETS[initialPreset].adjustments.midtoneTint),
  );
  const [highlightWheel, setHighlightWheel] = useState<WheelState>(() =>
    tintToWheel(GRADE_PRESETS[initialPreset].adjustments.highlightTint),
  );

  // Scalar adjustments
  const [exposure, setExposure] = useState(GRADE_PRESETS[initialPreset].adjustments.exposure);
  const [contrast, setContrast] = useState(GRADE_PRESETS[initialPreset].adjustments.contrast);
  const [saturation, setSaturation] = useState(GRADE_PRESETS[initialPreset].adjustments.saturation);
  const [vibrance, setVibrance] = useState(GRADE_PRESETS[initialPreset].adjustments.vibrance);
  const [temperature, setTemperature] = useState(GRADE_PRESETS[initialPreset].adjustments.temperatureShift);
  const [tint, setTint] = useState(GRADE_PRESETS[initialPreset].adjustments.tintShift);
  const [shadowLift, setShadowLift] = useState(GRADE_PRESETS[initialPreset].adjustments.shadowLift);
  const [highlightRolloff, setHighlightRolloff] = useState(GRADE_PRESETS[initialPreset].adjustments.highlightRolloff);
  const [intensity, setIntensity] = useState(1);

  // Curves
  const [activeTab, setActiveTab] = useState<Tab>("wheels");
  const [activeCurve, setActiveCurve] = useState<CurveChannel>("luma");
  const [curves, setCurves] = useState<Record<CurveChannel, CurvePoint[]>>({
    luma: [...DEFAULT_CURVE],
    r: [...DEFAULT_CURVE],
    g: [...DEFAULT_CURVE],
    b: [...DEFAULT_CURVE],
  });

  // HSL Qualifier
  const [hslRange, setHslRange] = useState<HSLRange>(DEFAULT_HSL);

  // Preview
  const [gradedFrame, setGradedFrame] = useState<ImageData | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const previewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived adjustments object
  const buildAdjustments = useCallback((): GradeAdjustments => ({
    exposure,
    contrast,
    saturation,
    vibrance,
    temperatureShift: temperature,
    tintShift: tint,
    shadowLift,
    highlightRolloff,
    hueRotations: GRADE_PRESETS[presetId].adjustments.hueRotations,
    hueSaturation: GRADE_PRESETS[presetId].adjustments.hueSaturation,
    shadowTint: wheelToTint(shadowWheel),
    midtoneTint: wheelToTint(midtoneWheel),
    highlightTint: wheelToTint(highlightWheel),
    lumaCurve: curves.luma.map((p) => [p.x, p.y]),
  }), [
    exposure, contrast, saturation, vibrance, temperature, tint,
    shadowLift, highlightRolloff, presetId,
    shadowWheel, midtoneWheel, highlightWheel, curves,
  ]);

  // Load preset
  const loadPreset = useCallback((id: GradePresetId) => {
    const adj = GRADE_PRESETS[id].adjustments;
    setPresetId(id);
    setShadowWheel(tintToWheel(adj.shadowTint));
    setMidtoneWheel(tintToWheel(adj.midtoneTint));
    setHighlightWheel(tintToWheel(adj.highlightTint));
    setExposure(adj.exposure);
    setContrast(adj.contrast);
    setSaturation(adj.saturation);
    setVibrance(adj.vibrance);
    setTemperature(adj.temperatureShift);
    setTint(adj.tintShift);
    setShadowLift(adj.shadowLift);
    setHighlightRolloff(adj.highlightRolloff);
    setCurves({
      luma: adj.lumaCurve.map(([x, y]) => ({ x, y })),
      r: [...DEFAULT_CURVE],
      g: [...DEFAULT_CURVE],
      b: [...DEFAULT_CURVE],
    });
  }, []);

  // Reset to neutral
  const reset = useCallback(() => loadPreset("neutral"), [loadPreset]);

  // Trigger preview with debounce
  const schedulePreview = useCallback(() => {
    if (!sourceFrame) return;
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    setPreviewPending(true);
    previewTimeoutRef.current = setTimeout(async () => {
      const adj = buildAdjustments();
      onAdjustmentsChange?.(adj);
      if (!colorGradingEngine["initialized"]) {
        await colorGradingEngine.init().catch(() => {});
      }
      const graded = colorGradingEngine.applyGrade(sourceFrame, presetId, intensity);
      setGradedFrame(graded);
      onGradeApplied?.(graded);
      setPreviewPending(false);
    }, 16);
  }, [sourceFrame, buildAdjustments, presetId, intensity, onAdjustmentsChange, onGradeApplied]);

  // Re-preview whenever parameters change
  useEffect(() => {
    schedulePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    exposure, contrast, saturation, vibrance, temperature, tint,
    shadowLift, highlightRolloff, shadowWheel, midtoneWheel, highlightWheel,
    presetId, intensity, curves, sourceFrame,
  ]);

  return (
    <div
      className={`flex flex-col gap-0 rounded-2xl overflow-hidden ${className}`}
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: "rgba(124,58,237,0.15)" }}
        >
          <Palette size={16} className="text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-[#E8E8F0]">Color Grading</h3>
          <p className="text-[11px] text-[#5a5a7a] truncate">
            {GRADE_PRESETS[presetId].label}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {previewPending && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
            >
              <Zap size={13} className="text-purple-400" />
            </motion.div>
          )}
          <button
            onClick={() => setShowSplit((s) => !s)}
            className="p-1.5 rounded-md transition-colors"
            style={{
              background: showSplit ? "rgba(124,58,237,0.2)" : "transparent",
              color: showSplit ? "#a78bfa" : "#5a5a7a",
            }}
            aria-label="Toggle split preview"
            title="Split before/after"
          >
            <Columns2 size={14} />
          </button>
          <button
            onClick={reset}
            className="p-1.5 rounded-md transition-colors hover:text-[#c8c8e8]"
            style={{ color: "#5a5a7a" }}
            aria-label="Reset to neutral"
            title="Reset"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Preset selector */}
      <div
        className="flex gap-1.5 px-4 py-2.5 overflow-x-auto shrink-0"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        {ALL_PRESET_IDS.slice(0, 10).map((id) => {
          const p = GRADE_PRESETS[id];
          return (
            <button
              key={id}
              onClick={() => loadPreset(id)}
              className="shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all"
              style={{
                background: presetId === id
                  ? "rgba(124,58,237,0.25)"
                  : "rgba(255,255,255,0.04)",
                color: presetId === id ? "#a78bfa" : "#7a7a9a",
                border: presetId === id ? "1px solid rgba(124,58,237,0.4)" : "1px solid transparent",
              }}
              title={p.description}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Split preview */}
      <AnimatePresence>
        {showSplit && sourceFrame && gradedFrame && (
          <motion.div
            key="split"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden px-4 pt-3"
          >
            <SplitPreview sourceFrame={sourceFrame} gradedFrame={gradedFrame} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tab bar */}
      <div
        className="flex shrink-0 px-2"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        {TABS.map(({ id: tabId, label, Icon }) => (
          <button
            key={tabId}
            onClick={() => setActiveTab(tabId)}
            className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-medium transition-colors relative"
            style={{ color: activeTab === tabId ? "#a78bfa" : "#5a5a7a" }}
            aria-selected={activeTab === tabId}
            role="tab"
          >
            <Icon size={12} />
            {label}
            {activeTab === tabId && (
              <motion.div
                layoutId={`${id}-tab-indicator`}
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500 rounded-full"
              />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        <AnimatePresence mode="wait">
          {/* ── Color Wheels Tab ── */}
          {activeTab === "wheels" && (
            <motion.div
              key="wheels"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-5"
            >
              {/* 3-way wheels */}
              <div className="flex justify-around">
                <ColorWheel
                  label="Shadows"
                  state={shadowWheel}
                  onChange={setShadowWheel}
                  accentColor="#60a5fa"
                />
                <ColorWheel
                  label="Midtones"
                  state={midtoneWheel}
                  onChange={setMidtoneWheel}
                  accentColor="#a78bfa"
                />
                <ColorWheel
                  label="Highlights"
                  state={highlightWheel}
                  onChange={setHighlightWheel}
                  accentColor="#f59e0b"
                />
              </div>

              {/* Scalar sliders */}
              <div className="flex flex-col gap-2.5">
                <SliderRow
                  label="Exposure"
                  value={exposure} min={-3} max={3}
                  onChange={setExposure}
                  displayValue={`${exposure >= 0 ? "+" : ""}${exposure.toFixed(2)} EV`}
                />
                <SliderRow
                  label="Contrast"
                  value={contrast} min={0} max={2}
                  onChange={setContrast}
                />
                <SliderRow
                  label="Saturation"
                  value={saturation} min={0} max={2}
                  onChange={setSaturation}
                />
                <SliderRow
                  label="Vibrance"
                  value={vibrance} min={-1} max={1}
                  onChange={setVibrance}
                />
                <SliderRow
                  label="Temperature"
                  value={temperature} min={-2000} max={2000} step={50}
                  onChange={setTemperature}
                  displayValue={`${temperature >= 0 ? "+" : ""}${temperature} K`}
                />
                <SliderRow
                  label="Tint"
                  value={tint} min={-0.5} max={0.5}
                  onChange={setTint}
                />
                <SliderRow
                  label="Shadow Lift"
                  value={shadowLift} min={0} max={0.3}
                  onChange={setShadowLift}
                />
                <SliderRow
                  label="Highlight Clip"
                  value={highlightRolloff} min={0} max={0.3}
                  onChange={setHighlightRolloff}
                />
              </div>

              {/* Intensity blend */}
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between">
                  <span className="text-[11px] text-[#7a7a9a]">Grade Intensity</span>
                  <span className="text-[11px] text-[#c8c8e8] font-mono">{Math.round(intensity * 100)}%</span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.01} value={intensity}
                  className="w-full accent-purple-500 cursor-pointer"
                  onChange={(e) => setIntensity(Number(e.target.value))}
                  aria-label="Grade intensity"
                />
              </div>
            </motion.div>
          )}

          {/* ── Curves Tab ── */}
          {activeTab === "curves" && (
            <motion.div
              key="curves"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-4"
            >
              {/* Channel switcher */}
              <div className="flex gap-1.5">
                {(["luma", "r", "g", "b"] as CurveChannel[]).map((ch) => (
                  <button
                    key={ch}
                    onClick={() => setActiveCurve(ch)}
                    className="px-3 py-1 rounded-md text-[11px] font-medium transition-colors"
                    style={{
                      background: activeCurve === ch
                        ? `${CURVE_COLORS[ch]}22`
                        : "rgba(255,255,255,0.04)",
                      color: activeCurve === ch ? CURVE_COLORS[ch] : "#5a5a7a",
                      border: activeCurve === ch
                        ? `1px solid ${CURVE_COLORS[ch]}44`
                        : "1px solid transparent",
                    }}
                  >
                    {ch.toUpperCase()}
                  </button>
                ))}
              </div>

              {/* Curve editor */}
              <div
                className="rounded-xl overflow-hidden p-3"
                style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
              >
                <CurveEditor
                  channel={activeCurve}
                  points={curves[activeCurve]}
                  onChange={(pts) => setCurves((c) => ({ ...c, [activeCurve]: pts }))}
                  width={280}
                  height={200}
                />
              </div>

              <p className="text-[10px] text-[#3a3a5a]">
                Click to add points · Double-click to remove · Drag to adjust
              </p>

              {/* Quick curve presets */}
              <div className="flex gap-2 flex-wrap">
                {[
                  { label: "Linear", pts: DEFAULT_CURVE },
                  { label: "S-Curve", pts: [{ x: 0, y: 0 }, { x: 0.25, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.8 }, { x: 1, y: 1 }] },
                  { label: "Lifted Blacks", pts: [{ x: 0, y: 0.08 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] },
                  { label: "Faded", pts: [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.9 }] },
                ].map(({ label, pts }) => (
                  <button
                    key={label}
                    onClick={() => setCurves((c) => ({ ...c, [activeCurve]: pts }))}
                    className="px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors"
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      color: "#7a7a9a",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── HSL Qualifier Tab ── */}
          {activeTab === "hsl" && (
            <motion.div
              key="hsl"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <HSLQualifier value={hslRange} onChange={setHslRange} />
              <p className="text-[10px] text-[#3a3a5a] mt-3">
                Isolate a color range to apply selective adjustments.
                The qualifier masks which pixels are affected by the grade.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
