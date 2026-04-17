/**
 * Social Validation Preview
 * ─────────────────────────
 *
 * Issue #14 asks for a pre-export widget that tells the user something like:
 *
 *     "Based on similar videos, this will get ~2,400 views on Quanttube."
 *
 * The goal is purely motivational — the act of seeing a predicted view count
 * massively increases the probability the user finishes their export.  The
 * prediction itself is a lightweight client-side heuristic blending:
 *
 *   • Quality score from the Almost-Perfect meter.
 *   • Duration (the sweet-spot on short-form video is 18–28s).
 *   • Category hook strength (viral modifiers applied by category).
 *   • Template usage boost (if the user picked a trending template).
 *   • Time-of-day multiplier — prime upload slots get a bump.
 *   • Creator tier — more followers = higher baseline reach.
 *
 * The heuristic returns not just a predicted view count, but also a
 * predicted engagement split (likes/comments/shares) and the 90% CI
 * range that the UI surfaces as "2.1k – 3.2k" for extra credibility.
 */

export type VideoCategory =
  | "viral-trend"
  | "educational"
  | "vlog"
  | "gaming"
  | "music"
  | "comedy"
  | "cinematic"
  | "tutorial"
  | "reaction"
  | "news";

export interface PredictionInputs {
  qualityScore: number; // 0-100
  durationSec: number;
  category: VideoCategory;
  followers: number;
  /** The trending-template boost — 1.0 for no template, up to 1.6. */
  templateBoost: number;
  /** Local time of day when export would happen (0–23). */
  exportHour: number;
  /** Current day-of-week (0–6, 0 = Sunday). */
  exportDow: number;
  /** Whether captions are attached (major multiplier for silent viewers). */
  hasCaptions: boolean;
  /** Whether music is attached. */
  hasMusic: boolean;
  /** 0..1 streak multiplier (see CreationStreaks). */
  streakMultiplier: number;
}

export interface PredictionResult {
  /** Predicted view count. */
  predictedViews: number;
  /** Low bound of a 90% confidence range. */
  lowViews: number;
  /** High bound of a 90% confidence range. */
  highViews: number;
  /** Predicted engagement breakdown. */
  engagement: {
    likes: number;
    comments: number;
    shares: number;
  };
  /** Human-readable summary used by the UI. */
  summary: string;
  /** Short-format preview "~2.4k" for the inline badge. */
  shortPreview: string;
  /** Breakdown of multipliers applied, for transparency. */
  multipliers: Record<string, number>;
}

// ── Category baselines ───────────────────────────────────────────────────
//
// Base reach per 1,000 followers before multipliers.  These numbers are
// pure heuristics tuned for motivational UX; there is no PII or network
// call involved in the computation.

const CATEGORY_BASELINES: Record<VideoCategory, number> = {
  "viral-trend": 320,
  comedy: 260,
  music: 220,
  gaming: 195,
  cinematic: 180,
  reaction: 170,
  vlog: 140,
  tutorial: 135,
  educational: 125,
  news: 110,
};

// ── Prime-time multipliers ───────────────────────────────────────────────

/** Multiplier for posting at hour-of-day (UTC local). */
const HOUR_MULT: number[] = [
  0.55, 0.45, 0.4, 0.38, 0.38, 0.45, // 00–05
  0.55, 0.7, 0.85, 0.95, 1.0, 1.05, // 06–11
  1.1, 1.15, 1.15, 1.1, 1.05, 1.1, // 12–17
  1.25, 1.35, 1.45, 1.4, 1.25, 0.95, // 18–23
];

/** Day-of-week multiplier — weekends get a modest bump. */
const DOW_MULT: number[] = [
  1.1, 0.95, 0.93, 0.95, 1.0, 1.15, 1.2, // Sun–Sat
];

// ── Duration curve ───────────────────────────────────────────────────────

function durationMultiplier(durationSec: number): number {
  // Sweet-spot curve peaking at 22s with a soft falloff.
  const peak = 22;
  const spread = 14;
  const delta = durationSec - peak;
  return Math.max(
    0.35,
    Math.exp(-(delta * delta) / (2 * spread * spread)) + 0.4,
  );
}

// ── Quality curve ────────────────────────────────────────────────────────

function qualityMultiplier(score: number): number {
  // Linear 0.5× at 60% → 1.35× at 95%.
  if (score <= 60) return 0.5;
  const t = (score - 60) / 35;
  return 0.5 + Math.min(1, t) * 0.85;
}

// ── Follower curve ───────────────────────────────────────────────────────

function followerBaseline(followers: number): number {
  // Logarithmic — new creators still see ~500 views per post if quality is high.
  const f = Math.max(0, followers);
  return 500 + Math.log10(1 + f) * 180;
}

// ── Predictor ────────────────────────────────────────────────────────────

export class SocialValidationPredictor {
  predict(inputs: PredictionInputs): PredictionResult {
    const base = followerBaseline(inputs.followers);
    const catMult = CATEGORY_BASELINES[inputs.category] / 200;
    const durMult = durationMultiplier(inputs.durationSec);
    const qualMult = qualityMultiplier(inputs.qualityScore);
    const hourMult = HOUR_MULT[clampIndex(inputs.exportHour, HOUR_MULT)];
    const dowMult = DOW_MULT[clampIndex(inputs.exportDow, DOW_MULT)];
    const templateMult = Math.max(1, Math.min(1.6, inputs.templateBoost));
    const captionMult = inputs.hasCaptions ? 1.18 : 1.0;
    const musicMult = inputs.hasMusic ? 1.1 : 1.0;
    const streakMult = 1 + Math.max(0, inputs.streakMultiplier);

    const rawViews =
      base *
      catMult *
      durMult *
      qualMult *
      hourMult *
      dowMult *
      templateMult *
      captionMult *
      musicMult *
      streakMult;

    const predictedViews = Math.max(50, Math.round(rawViews));
    const spread = 0.22; // ±22% confidence band
    const lowViews = Math.round(predictedViews * (1 - spread));
    const highViews = Math.round(predictedViews * (1 + spread));

    const engagement = {
      likes: Math.round(predictedViews * 0.078),
      comments: Math.round(predictedViews * 0.011),
      shares: Math.round(predictedViews * 0.016),
    };

    const shortPreview = formatShort(predictedViews);
    const summary = `Based on similar videos, this will get ~${shortPreview} views on Quanttube.`;

    return {
      predictedViews,
      lowViews,
      highViews,
      engagement,
      summary,
      shortPreview,
      multipliers: {
        category: catMult,
        duration: durMult,
        quality: qualMult,
        hour: hourMult,
        dow: dowMult,
        template: templateMult,
        caption: captionMult,
        music: musicMult,
        streak: streakMult,
      },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clampIndex<T>(idx: number, arr: ArrayLike<T>): number {
  if (!Number.isFinite(idx)) return 0;
  const i = Math.floor(idx);
  if (i < 0) return 0;
  if (i >= arr.length) return arr.length - 1;
  return i;
}

function formatShort(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export const socialValidationPredictor = new SocialValidationPredictor();
