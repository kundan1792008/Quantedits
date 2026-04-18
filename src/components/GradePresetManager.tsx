"use client";

/**
 * GradePresetManager — Community Grade Preset Gallery
 *
 * Features:
 *   - Browse the 20 built-in grade presets
 *   - Save custom grades with name + description
 *   - Export / import presets as JSON
 *   - "Trending Grades" section (simulated popularity scores)
 *   - Share presets with community (deep-link URL)
 *   - Apply preset to active clip with one click
 */

import {
  useState,
  useCallback,
  useRef,
  useId,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Star,
  Download,
  Upload,
  Share2,
  Plus,
  Search,
  TrendingUp,
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  Trash2,
  Palette,
} from "lucide-react";
import {
  GRADE_PRESETS,
  ALL_PRESET_IDS,
  type GradePresetId,
  type GradeAdjustments,
  type GradePreset,
} from "@/services/ColorGradingEngine";

// ── Types ──────────────────────────────────────────────────────────────────

/** A user-created or community grade preset. */
export interface CustomGradePreset {
  id: string;
  label: string;
  description: string;
  adjustments: GradeAdjustments;
  thumbnailGradient: string;
  tags: string[];
  createdAt: number;
  /** Simulated view / use count for trending. */
  usageCount: number;
  /** Whether this preset was shared to community. */
  shared: boolean;
  /** Share URL (populated after sharing). */
  shareUrl?: string;
}

export interface GradePresetManagerProps {
  /** Called when user selects a built-in preset. */
  onSelectBuiltin?: (id: GradePresetId) => void;
  /** Called when user selects a custom preset. */
  onSelectCustom?: (preset: CustomGradePreset) => void;
  /** Current adjustments to save as a new custom preset. */
  currentAdjustments?: GradeAdjustments;
  /** Currently active preset id (for highlighting). */
  activePresetId?: GradePresetId | string;
  className?: string;
}

// ── Simulated trending data ────────────────────────────────────────────────

const TRENDING_COUNTS: Partial<Record<GradePresetId, number>> = {
  cinematic_teal_orange: 94820,
  neon_cyberpunk:        72310,
  music_video_pop:       61540,
  golden_hour_boost:     55230,
  vintage_warm:          48900,
  moody_noir:            41200,
  filmic_kodak:          38450,
  cold_nordic:           31080,
  pastel_dream:          27650,
  bleach_bypass:         22400,
};

const TRENDING_IDS: GradePresetId[] = ALL_PRESET_IDS
  .filter((id) => TRENDING_COUNTS[id] !== undefined)
  .sort((a, b) => (TRENDING_COUNTS[b] ?? 0) - (TRENDING_COUNTS[a] ?? 0));

// ── Helpers ────────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function generateShareUrl(preset: CustomGradePreset): string {
  const encoded = btoa(JSON.stringify({
    label: preset.label,
    desc: preset.description,
    adj: preset.adjustments,
    tags: preset.tags,
  }));
  return `${typeof window !== "undefined" ? window.location.origin : "https://quantedits.app"}/grades/share?preset=${encoded}`;
}

function generateBuiltinShareUrl(preset: GradePreset): string {
  return `${typeof window !== "undefined" ? window.location.origin : "https://quantedits.app"}/grades/${preset.id}`;
}

function exportPresetsToJSON(presets: CustomGradePreset[]): string {
  return JSON.stringify(
    presets.map((p) => ({
      label: p.label,
      description: p.description,
      adjustments: p.adjustments,
      tags: p.tags,
      thumbnailGradient: p.thumbnailGradient,
    })),
    null,
    2,
  );
}

function importPresetsFromJSON(json: string): CustomGradePreset[] {
  const raw = JSON.parse(json) as Array<{
    label: string;
    description?: string;
    adjustments: GradeAdjustments;
    tags?: string[];
    thumbnailGradient?: string;
  }>;
  return raw.map((r) => ({
    id: `imported-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    label: r.label ?? "Imported Grade",
    description: r.description ?? "",
    adjustments: r.adjustments,
    tags: r.tags ?? [],
    thumbnailGradient: r.thumbnailGradient ?? "linear-gradient(135deg, #333 0%, #888 100%)",
    createdAt: Date.now(),
    usageCount: 0,
    shared: false,
  }));
}

/** Generate a gradient thumbnail from adjustments for display. */
function gradientFromAdjustments(adj: GradeAdjustments): string {
  const warm = adj.temperatureShift;
  const sat = adj.saturation;
  const exp = adj.exposure;

  const baseL = Math.round(Math.max(10, Math.min(90, 40 + exp * 20)));
  const hue = warm > 0 ? 30 : warm < 0 ? 210 : 180;
  const satPct = Math.round(Math.min(100, sat * 40));
  const lightL = Math.min(95, baseL + 30);

  return `linear-gradient(135deg, hsl(${hue},${satPct}%,${baseL}%) 0%, hsl(${hue + 40},${satPct + 10}%,${lightL}%) 100%)`;
}

// ── Preset Card ────────────────────────────────────────────────────────────

interface PresetCardProps {
  label: string;
  description: string;
  gradient: string;
  usageCount?: number;
  isActive?: boolean;
  isSaved?: boolean;
  isCustom?: boolean;
  onApply: () => void;
  onSave?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
}

function PresetCard({
  label,
  gradient,
  usageCount,
  isActive,
  isSaved,
  isCustom,
  onApply,
  onSave,
  onShare,
  onDelete,
}: PresetCardProps) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    onShare?.();
    // Simulate copy to clipboard
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      layout
      className="relative rounded-xl overflow-hidden cursor-pointer select-none"
      style={{
        border: isActive
          ? "1.5px solid rgba(124,58,237,0.6)"
          : "1px solid rgba(255,255,255,0.06)",
        background: "#0D0D11",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onApply}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onApply()}
      aria-pressed={isActive}
      aria-label={`Apply ${label} grade`}
    >
      {/* Thumbnail */}
      <div
        className="h-16 w-full"
        style={{ background: gradient }}
      />

      {/* Active overlay */}
      <AnimatePresence>
        {isActive && (
          <motion.div
            key="active-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
            style={{ background: "rgba(124,58,237,0.9)" }}
          >
            <Check size={10} className="text-white" />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info */}
      <div className="p-2.5">
        <div className="flex items-start justify-between gap-1">
          <span className="text-[11px] font-semibold text-[#E8E8F0] leading-tight truncate">
            {label}
          </span>
          {isCustom && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0"
              style={{ background: "rgba(124,58,237,0.2)", color: "#a78bfa" }}
            >
              custom
            </span>
          )}
        </div>
        {usageCount !== undefined && (
          <div className="flex items-center gap-0.5 mt-0.5">
            <TrendingUp size={9} className="text-[#5a5a7a]" />
            <span className="text-[10px] text-[#5a5a7a]">{formatCount(usageCount)}</span>
          </div>
        )}
      </div>

      {/* Hover actions */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            key="actions"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            className="absolute bottom-0 left-0 right-0 px-2.5 pb-2 flex justify-end gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {onSave && (
              <button
                className="p-1 rounded-md transition-colors"
                style={{
                  background: isSaved ? "rgba(124,58,237,0.25)" : "rgba(0,0,0,0.5)",
                  color: isSaved ? "#a78bfa" : "#7a7a9a",
                }}
                onClick={(e) => { e.stopPropagation(); onSave(); }}
                title={isSaved ? "Saved" : "Save preset"}
                aria-label={isSaved ? "Saved" : "Save preset"}
              >
                {isSaved ? <BookmarkCheck size={11} /> : <Bookmark size={11} />}
              </button>
            )}
            {onShare && (
              <button
                className="p-1 rounded-md transition-colors"
                style={{ background: "rgba(0,0,0,0.5)", color: copied ? "#22c55e" : "#7a7a9a" }}
                onClick={(e) => { e.stopPropagation(); handleShare(); }}
                title={copied ? "Copied!" : "Share grade"}
                aria-label="Share grade"
              >
                {copied ? <Check size={11} /> : <Share2 size={11} />}
              </button>
            )}
            {onDelete && (
              <button
                className="p-1 rounded-md transition-colors"
                style={{ background: "rgba(0,0,0,0.5)", color: "#ef4444" }}
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                title="Delete preset"
                aria-label="Delete preset"
              >
                <Trash2 size={11} />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Save Preset Modal ──────────────────────────────────────────────────────

interface SavePresetModalProps {
  onSave: (label: string, description: string, tags: string) => void;
  onCancel: () => void;
}

function SavePresetModal({ onSave, onCancel }: SavePresetModalProps) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const labelRef = useRef<HTMLInputElement>(null);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onCancel}
    >
      <motion.div
        initial={{ scale: 0.92, y: 16 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 16 }}
        className="rounded-2xl p-6 w-full max-w-sm mx-4"
        style={{ background: "#1a1a28", border: "1px solid #2a2a3e" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-[#E8E8F0] mb-4">Save Grade Preset</h3>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-[#7a7a9a]" htmlFor="preset-label">
              Name
            </label>
            <input
              id="preset-label"
              ref={labelRef}
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. My Cinematic Look"
              className="w-full rounded-lg px-3 py-2 text-sm text-[#E8E8F0] outline-none focus:ring-1 focus:ring-purple-500"
              style={{ background: "#0D0D11", border: "1px solid #2a2a3e" }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-[#7a7a9a]" htmlFor="preset-desc">
              Description
            </label>
            <textarea
              id="preset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the look and when to use it…"
              rows={2}
              className="w-full rounded-lg px-3 py-2 text-sm text-[#E8E8F0] outline-none focus:ring-1 focus:ring-purple-500 resize-none"
              style={{ background: "#0D0D11", border: "1px solid #2a2a3e" }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-[#7a7a9a]" htmlFor="preset-tags">
              Tags (comma-separated)
            </label>
            <input
              id="preset-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="cinematic, warm, outdoor"
              className="w-full rounded-lg px-3 py-2 text-sm text-[#E8E8F0] outline-none focus:ring-1 focus:ring-purple-500"
              style={{ background: "#0D0D11", border: "1px solid #2a2a3e" }}
            />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg text-sm text-[#7a7a9a] transition-colors"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (label.trim()) onSave(label.trim(), description.trim(), tags.trim());
            }}
            disabled={!label.trim()}
            className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
            style={{ background: "rgba(124,58,237,0.8)", color: "#fff" }}
          >
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

type GalleryTab = "all" | "trending" | "saved" | "custom";

export default function GradePresetManager({
  onSelectBuiltin,
  onSelectCustom,
  currentAdjustments,
  activePresetId,
  className = "",
}: GradePresetManagerProps) {
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<GalleryTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [customPresets, setCustomPresets] = useState<CustomGradePreset[]>([]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // ── Search / filter logic ──────────────────────────────────────────────

  const filteredBuiltin = ALL_PRESET_IDS.filter((presetId) => {
    const p = GRADE_PRESETS[presetId];
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.label.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  const filteredCustom = customPresets.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.label.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  // ── Preset actions ─────────────────────────────────────────────────────

  const handleSaveBuiltin = useCallback((presetId: GradePresetId) => {
    setSavedIds((s) => {
      const next = new Set(s);
      if (next.has(presetId)) next.delete(presetId);
      else next.add(presetId);
      return next;
    });
  }, []);

  const handleShareBuiltin = useCallback((presetId: GradePresetId) => {
    const url = generateBuiltinShareUrl(GRADE_PRESETS[presetId]);
    setShareUrl(url);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
  }, []);

  const handleSaveCustom = useCallback((
    label: string,
    description: string,
    tagsStr: string,
  ) => {
    if (!currentAdjustments) return;
    const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
    const preset: CustomGradePreset = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label,
      description,
      adjustments: currentAdjustments,
      thumbnailGradient: gradientFromAdjustments(currentAdjustments),
      tags,
      createdAt: Date.now(),
      usageCount: 0,
      shared: false,
    };
    setCustomPresets((prev) => [preset, ...prev]);
    setShowSaveModal(false);
  }, [currentAdjustments]);

  const handleDeleteCustom = useCallback((presetId: string) => {
    setCustomPresets((prev) => prev.filter((p) => p.id !== presetId));
    setSavedIds((s) => { const next = new Set(s); next.delete(presetId); return next; });
  }, []);

  const handleShareCustom = useCallback((preset: CustomGradePreset) => {
    const url = generateShareUrl(preset);
    setShareUrl(url);
    setCustomPresets((prev) =>
      prev.map((p) => p.id === preset.id ? { ...p, shared: true, shareUrl: url } : p),
    );
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).catch(() => {});
    }
  }, []);

  const handleExport = useCallback(() => {
    const json = exportPresetsToJSON(customPresets);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "quantedits-grades.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [customPresets]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = importPresetsFromJSON(reader.result as string);
        setCustomPresets((prev) => [...imported, ...prev]);
        setImportError(null);
      } catch {
        setImportError("Invalid preset file. Please upload a valid Quantedits grades JSON.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, []);

  const copyShareUrl = useCallback(() => {
    if (!shareUrl) return;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(shareUrl).catch(() => {});
    }
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 2000);
  }, [shareUrl]);

  // ── Render helpers ─────────────────────────────────────────────────────

  const renderBuiltinGrid = (ids: GradePresetId[]) => (
    <div className="grid grid-cols-2 gap-2">
      {ids.map((presetId) => {
        const p = GRADE_PRESETS[presetId];
        return (
          <PresetCard
            key={presetId}
            label={p.label}
            description={p.description}
            gradient={p.thumbnailGradient}
            usageCount={TRENDING_COUNTS[presetId]}
            isActive={activePresetId === presetId}
            isSaved={savedIds.has(presetId)}
            onApply={() => onSelectBuiltin?.(presetId)}
            onSave={() => handleSaveBuiltin(presetId)}
            onShare={() => handleShareBuiltin(presetId)}
          />
        );
      })}
    </div>
  );

  const renderCustomGrid = (presets: CustomGradePreset[]) => (
    <div className="grid grid-cols-2 gap-2">
      {presets.map((preset) => (
        <PresetCard
          key={preset.id}
          label={preset.label}
          description={preset.description}
          gradient={preset.thumbnailGradient}
          usageCount={preset.usageCount > 0 ? preset.usageCount : undefined}
          isActive={activePresetId === preset.id}
          isSaved={savedIds.has(preset.id)}
          isCustom
          onApply={() => onSelectCustom?.(preset)}
          onSave={() => {
            setSavedIds((s) => {
              const next = new Set(s);
              if (next.has(preset.id)) next.delete(preset.id);
              else next.add(preset.id);
              return next;
            });
          }}
          onShare={() => handleShareCustom(preset)}
          onDelete={() => handleDeleteCustom(preset.id)}
        />
      ))}
    </div>
  );

  // ── Gallery tabs ───────────────────────────────────────────────────────

  const TABS: Array<{ id: GalleryTab; label: string; count?: number }> = [
    { id: "all", label: "All", count: ALL_PRESET_IDS.length + customPresets.length },
    { id: "trending", label: "Trending", count: TRENDING_IDS.length },
    { id: "saved", label: "Saved", count: savedIds.size },
    { id: "custom", label: "My Grades", count: customPresets.length },
  ];

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
          <Star size={16} className="text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-[#E8E8F0]">Grade Presets</h3>
          <p className="text-[11px] text-[#5a5a7a]">
            {ALL_PRESET_IDS.length} built-in · {customPresets.length} custom
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Save current grade */}
          {currentAdjustments && (
            <button
              onClick={() => setShowSaveModal(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors"
              style={{ background: "rgba(124,58,237,0.2)", color: "#a78bfa" }}
              title="Save current grade as preset"
            >
              <Plus size={11} />
              Save
            </button>
          )}
          {/* Export */}
          {customPresets.length > 0 && (
            <button
              onClick={handleExport}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: "#5a5a7a" }}
              title="Export custom presets"
              aria-label="Export presets"
            >
              <Download size={14} />
            </button>
          )}
          {/* Import */}
          <button
            onClick={handleImportClick}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: "#5a5a7a" }}
            title="Import presets from JSON"
            aria-label="Import presets"
          >
            <Upload size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
            aria-hidden
          />
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2.5 shrink-0" style={{ borderBottom: "1px solid #1E1E2E" }}>
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
        >
          <Search size={12} className="text-[#5a5a7a] shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search grades…"
            className="flex-1 bg-transparent text-[12px] text-[#c8c8e8] placeholder:text-[#3a3a5a] outline-none"
            aria-label="Search grade presets"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="text-[#3a3a5a] hover:text-[#7a7a9a] transition-colors"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div
        className="flex shrink-0 px-2"
        style={{ borderBottom: "1px solid #1E1E2E" }}
      >
        {TABS.map(({ id: tabId, label, count }) => (
          <button
            key={tabId}
            onClick={() => setActiveTab(tabId)}
            className="flex items-center gap-1.5 px-3 py-2.5 text-[11px] font-medium transition-colors relative"
            style={{ color: activeTab === tabId ? "#a78bfa" : "#5a5a7a" }}
            aria-selected={activeTab === tabId}
            role="tab"
          >
            {label}
            {count !== undefined && count > 0 && (
              <span
                className="px-1.5 py-0.5 rounded-full text-[9px]"
                style={{
                  background: activeTab === tabId ? "rgba(124,58,237,0.3)" : "rgba(255,255,255,0.06)",
                  color: activeTab === tabId ? "#a78bfa" : "#5a5a7a",
                }}
              >
                {count}
              </span>
            )}
            {activeTab === tabId && (
              <motion.div
                layoutId={`${id}-tab-indicator`}
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-500 rounded-full"
              />
            )}
          </button>
        ))}
      </div>

      {/* Gallery */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Import error */}
        <AnimatePresence>
          {importError && (
            <motion.div
              key="import-error"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-3 px-3 py-2 rounded-lg text-[11px]"
              style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5", border: "1px solid rgba(239,68,68,0.25)" }}
            >
              {importError}
              <button
                onClick={() => setImportError(null)}
                className="ml-2 opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Share URL toast */}
        <AnimatePresence>
          {shareUrl && (
            <motion.div
              key="share-url"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-3 px-3 py-2.5 rounded-xl flex items-center gap-2"
              style={{ background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.25)" }}
            >
              <span className="text-[10px] text-[#a78bfa] flex-1 truncate font-mono">
                {shareUrl}
              </span>
              <button
                onClick={copyShareUrl}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-colors"
                style={{
                  background: shareCopied ? "rgba(34,197,94,0.2)" : "rgba(124,58,237,0.2)",
                  color: shareCopied ? "#22c55e" : "#a78bfa",
                }}
              >
                {shareCopied ? <Check size={10} /> : <Copy size={10} />}
                {shareCopied ? "Copied!" : "Copy"}
              </button>
              <button
                onClick={() => setShareUrl(null)}
                className="text-[#5a5a7a] hover:text-[#7a7a9a] text-xs"
              >
                ×
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {/* All tab */}
          {activeTab === "all" && (
            <motion.div key="all" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {filteredCustom.length > 0 && (
                <div className="mb-5">
                  <div className="flex items-center gap-2 mb-3">
                    <Palette size={11} className="text-purple-400" />
                    <span className="text-[11px] font-semibold text-[#7a7a9a] uppercase tracking-wider">
                      My Grades
                    </span>
                  </div>
                  {renderCustomGrid(filteredCustom)}
                </div>
              )}
              {filteredBuiltin.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Star size={11} className="text-purple-400" />
                    <span className="text-[11px] font-semibold text-[#7a7a9a] uppercase tracking-wider">
                      Built-in
                    </span>
                  </div>
                  {renderBuiltinGrid(filteredBuiltin)}
                </div>
              )}
              {filteredBuiltin.length === 0 && filteredCustom.length === 0 && (
                <p className="text-center text-[12px] text-[#3a3a5a] mt-8">No grades match your search.</p>
              )}
            </motion.div>
          )}

          {/* Trending tab */}
          {activeTab === "trending" && (
            <motion.div key="trending" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp size={11} className="text-purple-400" />
                <span className="text-[11px] font-semibold text-[#7a7a9a] uppercase tracking-wider">
                  Community Favorites
                </span>
              </div>
              {renderBuiltinGrid(
                TRENDING_IDS.filter((tid) => {
                  if (!searchQuery) return true;
                  const q = searchQuery.toLowerCase();
                  const p = GRADE_PRESETS[tid];
                  return p.label.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q));
                }),
              )}
            </motion.div>
          )}

          {/* Saved tab */}
          {activeTab === "saved" && (
            <motion.div key="saved" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {savedIds.size === 0 ? (
                <div className="flex flex-col items-center gap-3 mt-8 text-center">
                  <Bookmark size={28} className="text-[#2a2a3e]" />
                  <p className="text-[12px] text-[#3a3a5a]">
                    No saved grades yet.<br />
                    Click the bookmark icon on any preset to save it here.
                  </p>
                </div>
              ) : (
                renderBuiltinGrid(
                  ALL_PRESET_IDS.filter((pid) => savedIds.has(pid)).filter((tid) => {
                    if (!searchQuery) return true;
                    const q = searchQuery.toLowerCase();
                    const p = GRADE_PRESETS[tid];
                    return p.label.toLowerCase().includes(q);
                  }),
                )
              )}
            </motion.div>
          )}

          {/* Custom tab */}
          {activeTab === "custom" && (
            <motion.div key="custom" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {customPresets.length === 0 ? (
                <div className="flex flex-col items-center gap-3 mt-8 text-center">
                  <Palette size={28} className="text-[#2a2a3e]" />
                  <p className="text-[12px] text-[#3a3a5a]">
                    No custom grades yet.<br />
                    Dial in your look in the Color Wheels panel and click{" "}
                    <strong className="text-[#5a5a7a]">Save</strong> to preserve it here.
                  </p>
                  {currentAdjustments && (
                    <button
                      onClick={() => setShowSaveModal(true)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition-colors mt-1"
                      style={{ background: "rgba(124,58,237,0.2)", color: "#a78bfa" }}
                    >
                      <Plus size={13} />
                      Save Current Grade
                    </button>
                  )}
                </div>
              ) : (
                renderCustomGrid(filteredCustom)
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Save preset modal */}
      <AnimatePresence>
        {showSaveModal && (
          <SavePresetModal
            onSave={handleSaveCustom}
            onCancel={() => setShowSaveModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
