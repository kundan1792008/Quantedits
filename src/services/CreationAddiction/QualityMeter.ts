/**
 * "Almost Perfect" Quality Meter
 * ──────────────────────────────
 *
 * Implements the per-project quality meter described in issue #14 — a
 * metric that always hovers at 92–95% but **never** reaches 100%, so the
 * user keeps tweaking "just one more thing" to reach the elusive next
 * milestone.
 *
 * The score is made of several weighted components:
 *
 *   • Structure    — does the project have enough clips and a hook?
 *   • Audio        — is a music track + captions attached?
 *   • Color        — has a grade been applied?
 *   • Pace         — are clip durations varied rather than uniform?
 *   • Polish       — small effects: grain, transitions, titles, etc.
 *
 * Each component yields a raw score in [0, 1].  The meter combines those
 * into a raw total, then applies the **ceiling curve** that caps the
 * displayed value at a ceiling that always dangles slightly out of reach.
 * This encodes the "Almost Perfect" dopamine loop — if a user somehow
 * nails every component, the ceiling creeps up to 95% but never higher.
 *
 * The meter also surfaces a "next tweak" recommendation (the lowest
 * weighted component) that the UI renders directly beside the score.
 */

import type { Suggestion } from "./SuggestionEngine";

// ── Public types ─────────────────────────────────────────────────────────

export type MeterComponentId =
  | "structure"
  | "audio"
  | "color"
  | "pace"
  | "polish";

export interface MeterComponent {
  id: MeterComponentId;
  /** Human-readable label for the UI. */
  label: string;
  /** Current raw score in [0, 1]. */
  value: number;
  /** Weight in the overall meter calculation. */
  weight: number;
  /** Suggested tweak surfaced when this is the weakest component. */
  tweak: string;
}

export interface QualityBreakdown {
  /** The score displayed to the user, 0-100. */
  displayedScore: number;
  /** The raw score the meter would display if there was no ceiling, 0-100. */
  rawScore: number;
  /** The ceiling applied (somewhere between 92 and 95). */
  ceiling: number;
  /** Every component's current value, weight and tweak. */
  components: MeterComponent[];
  /** The weakest component — the UI uses this as "next tweak to hit X%". */
  nextTweak: MeterComponent;
  /** Synthetic "required to hit next milestone" line. */
  hint: string;
}

export interface QualityInputs {
  clipCount: number;
  durationSec: number;
  hasMusic: boolean;
  hasCaptions: boolean;
  hasColorGrade: boolean;
  hasTransitions: boolean;
  hasTitles: boolean;
  hasGrain: boolean;
  hasHookMoment: boolean;
  hasGenerativeEffects: boolean;
  /** Average clip duration variance (0 = very uniform, 1 = very varied). */
  paceVariance: number;
  /** How many suggestions the user has accepted in this session. */
  acceptedSuggestions: number;
}

// ── Component calculators ────────────────────────────────────────────────

function structureScore(i: QualityInputs): number {
  let s = 0;
  s += Math.min(1, i.clipCount / 4) * 0.5;
  s += i.hasHookMoment ? 0.35 : 0;
  s += i.durationSec >= 12 && i.durationSec <= 90 ? 0.15 : 0.05;
  return clamp01(s);
}

function audioScore(i: QualityInputs): number {
  let s = 0;
  if (i.hasMusic) s += 0.55;
  if (i.hasCaptions) s += 0.4;
  if (i.hasMusic && i.hasCaptions) s += 0.05;
  return clamp01(s);
}

function colorScore(i: QualityInputs): number {
  let s = i.hasColorGrade ? 0.7 : 0.15;
  if (i.hasGenerativeEffects) s += 0.2;
  if (i.hasGrain) s += 0.05;
  return clamp01(s);
}

function paceScore(i: QualityInputs): number {
  // Better when clips aren't all the same length but also not chaotic.
  // Sweet spot: variance around 0.55.
  const target = 0.55;
  const delta = Math.abs(i.paceVariance - target);
  let s = 1 - delta;
  if (i.clipCount <= 1) s *= 0.6;
  return clamp01(s);
}

function polishScore(i: QualityInputs): number {
  let s = 0;
  if (i.hasTransitions) s += 0.35;
  if (i.hasTitles) s += 0.25;
  if (i.hasGrain) s += 0.15;
  // Accepting AI suggestions contributes to polish — but asymptotically.
  s += Math.min(0.25, i.acceptedSuggestions * 0.04);
  return clamp01(s);
}

// ── Core meter ───────────────────────────────────────────────────────────

export interface MeterOptions {
  /** Minimum ceiling (hard floor on the displayed max). */
  minCeiling?: number;
  /** Maximum ceiling (hard ceiling — issue #14 requires never reaching this value). */
  maxCeiling?: number;
  /** Base ceiling used when no tweaks have been accepted yet. */
  baseCeiling?: number;
}

export class QualityMeter {
  private minCeiling: number;
  private maxCeiling: number;
  private baseCeiling: number;
  /** Running tally of quality deltas contributed by accepted suggestions. */
  private acceptedDelta = 0;

  constructor(options: MeterOptions = {}) {
    this.minCeiling = options.minCeiling ?? 92;
    // The hard ceiling is < 100% — by design, per issue #14.
    this.maxCeiling = options.maxCeiling ?? 95;
    this.baseCeiling = options.baseCeiling ?? 93;
  }

  /**
   * Record that the user accepted a suggestion — contributes to the
   * displayed score but is subject to the ceiling curve.
   */
  recordAcceptance(suggestion: Suggestion): void {
    this.acceptedDelta += suggestion.qualityDelta;
  }

  /** Reset the internal acceptance tally (called on project change). */
  reset(): void {
    this.acceptedDelta = 0;
  }

  /** Compute the full breakdown for a given editor snapshot. */
  compute(inputs: QualityInputs): QualityBreakdown {
    const components: MeterComponent[] = [
      {
        id: "structure",
        label: "Structure",
        value: structureScore(inputs),
        weight: 0.25,
        tweak: inputs.hasHookMoment
          ? "Tighten the cold-open to 3 seconds"
          : "Add a hook moment in the first 3 seconds",
      },
      {
        id: "audio",
        label: "Audio",
        value: audioScore(inputs),
        weight: 0.22,
        tweak: !inputs.hasMusic
          ? "Pick a trending music track"
          : !inputs.hasCaptions
            ? "Turn on auto-captions"
            : "Duck music under voiceover",
      },
      {
        id: "color",
        label: "Color",
        value: colorScore(inputs),
        weight: 0.2,
        tweak: !inputs.hasColorGrade
          ? "Apply a Kodak-Teal LUT"
          : inputs.hasGenerativeEffects
            ? "Add 6% film grain"
            : "Try the Generative Outpaint effect",
      },
      {
        id: "pace",
        label: "Pace",
        value: paceScore(inputs),
        weight: 0.15,
        tweak: "Vary clip lengths (aim for a 2:1:3 rhythm)",
      },
      {
        id: "polish",
        label: "Polish",
        value: polishScore(inputs),
        weight: 0.18,
        tweak: inputs.hasTitles
          ? "Add a subtle whip-pan transition"
          : "Drop in a title card at the intro",
      },
    ];

    const rawFraction = components.reduce(
      (s, c) => s + c.value * c.weight,
      0,
    );
    const boosted = clamp01(
      rawFraction + Math.min(0.08, this.acceptedDelta),
    );
    const rawScore = Math.round(boosted * 10_000) / 100; // 2 decimals

    const ceiling = this.deriveCeiling(boosted);

    const displayedScore = Math.min(rawScore, ceiling);

    // Find weakest component by weighted contribution (room to grow).
    const ranked = [...components].sort(
      (a, b) => a.value * a.weight - b.value * b.weight,
    );
    const nextTweak = ranked[0];
    const targetMilestone = Math.min(
      ceiling - 0.1,
      Math.ceil(displayedScore + 1),
    );

    const hint = `${nextTweak.tweak} to reach ${targetMilestone.toFixed(0)}%`;

    return {
      displayedScore: Math.round(displayedScore * 10) / 10,
      rawScore,
      ceiling: Math.round(ceiling * 10) / 10,
      components,
      nextTweak,
      hint,
    };
  }

  /**
   * The ceiling curve — rises with accepted suggestions but asymptotes
   * at {@link this.maxCeiling}, which is strictly less than 100.
   */
  private deriveCeiling(boosted: number): number {
    // Smooth logistic so the ceiling grows slower the closer it gets.
    const growth =
      1 - Math.exp(-(this.acceptedDelta * 4 + boosted * 0.8));
    const span = this.maxCeiling - this.baseCeiling;
    const ceiling = this.baseCeiling + span * growth;
    return clamp(ceiling, this.minCeiling, this.maxCeiling);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export const qualityMeter = new QualityMeter();
