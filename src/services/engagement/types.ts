/**
 * Shared types for the creator-engagement engine.
 *
 * Design principles (read before extending):
 *
 *  1. **Honest, never deceptive.** Scores, estimates, and usage counts are
 *     computed from real, observable data. We do not fabricate numbers, cap
 *     quality scores below 100, or invent "algorithm boosts".
 *  2. **Opt-in, always revocable.** Every feature that touches notifications,
 *     streaks, or push respects `UserPreferences` and can be disabled.
 *  3. **Transparent.** Every score comes with the full list of rules that
 *     produced it, and every estimate comes with its confidence band so the
 *     user can judge the number themselves.
 *  4. **Rate-limited.** Reminders and pushes are capped per user per week.
 */

/**
 * Probe data for a single project that quality checks and suggestions are
 * evaluated against. Populated by the editor from the current timeline state.
 *
 * All fields are optional — the services gracefully degrade and return
 * "unknown" / "skipped" rules instead of fabricating values.
 */
export interface ProjectProbe {
  projectId: string;
  /** Duration of the finished timeline in seconds. */
  durationSec?: number;
  /** Frames-per-second of the source clip(s). */
  fps?: number;
  /** Output video width in pixels. */
  widthPx?: number;
  /** Output video height in pixels. */
  heightPx?: number;
  /** True when every scene with dialogue has a caption track. */
  hasCaptions?: boolean;
  /** True when the user has added a custom thumbnail or poster frame. */
  hasCustomThumbnail?: boolean;
  /** True when the user has set a title. */
  hasTitle?: boolean;
  /** True when the user has set a description. */
  hasDescription?: boolean;
  /** Number of tags/keywords attached to the project. */
  tagCount?: number;
  /** Audio loudness in integrated LUFS (broadcast standard is -14 LUFS). */
  audioLufs?: number;
  /** True audio peak in dBFS (platforms typically cap at -1 dBFS). */
  audioPeakDb?: number;
  /** True when at least one audio track is non-silent. */
  hasAudio?: boolean;
  /** Total number of cuts/clips in the timeline. */
  cutCount?: number;
  /** True when color correction or a LUT has been applied. */
  hasColorGrade?: boolean;
  /** True when at least one transition exists between cuts. */
  hasTransitions?: boolean;
  /** True when the intro (first 3 seconds) includes a visual or text hook. */
  hasIntroHook?: boolean;
  /** True when background music is present. */
  hasMusic?: boolean;
}

export interface QualityRuleResult {
  /** Stable identifier — safe to key React lists by this. */
  ruleId: string;
  /** Human-readable label shown in the checklist UI. */
  label: string;
  /** Short, actionable hint explaining how to satisfy the rule. */
  hint: string;
  /** Maximum points the rule can contribute. Sum across all rules = 100. */
  weight: number;
  /** Points actually awarded (0..weight). */
  awarded: number;
  /** The rule has been fully satisfied. */
  passed: boolean;
  /** The probe lacked the data required to evaluate; excluded from the score. */
  skipped: boolean;
  /** Optional measured value shown to the user (e.g. "-18 LUFS"). */
  measured?: string;
}

export interface QualityScore {
  /** 0..100, computed only over evaluated (non-skipped) rules. */
  score: number;
  /** Total weight of evaluated rules; helps users see what was measurable. */
  evaluatedWeight: number;
  /** Per-rule breakdown — the UI renders this as a transparent checklist. */
  rules: QualityRuleResult[];
  /** When `score` is below 100, ordered list of fixes that raise it fastest. */
  nextBestActions: Array<{ ruleId: string; gain: number; hint: string }>;
  /** ISO timestamp the score was computed. */
  computedAt: string;
}

export interface SuggestionCandidate {
  ruleId: string;
  title: string;
  body: string;
  severity: "INFO" | "RECOMMENDED" | "WARNING";
  context?: Record<string, unknown>;
}

export interface ViewEstimate {
  /** Null when we don't have enough historical data to produce an estimate. */
  median: number | null;
  /** p10..p90 confidence band. Null fields signal insufficient data. */
  low: number | null;
  high: number | null;
  /** Qualitative confidence: "low" when < 3 prior videos, else "medium/high". */
  confidence: "insufficient_data" | "low" | "medium" | "high";
  /** Count of prior published videos the estimate was derived from. */
  sampleSize: number;
  /**
   * Plain-English explanation of how the estimate was computed. Shown in the
   * UI so users can judge the number themselves.
   */
  methodology: string;
}

export interface StreakStatus {
  enabled: boolean;
  current: number;
  longest: number;
  /** UTC date string (YYYY-MM-DD) of the most recent qualifying activity. */
  lastActiveDate: string | null;
  /** True when today has already been counted toward the streak. */
  countedToday: boolean;
}

export interface TemplateListing {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  previewImageUrl: string | null;
  /** Real, observed usage count (all-time). */
  totalUses: number;
  /** Real, observed usage count in the last 24 hours. */
  usesLast24h: number;
  publishedAt: string;
}
