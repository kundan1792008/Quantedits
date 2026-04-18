/**
 * Quality Checker — computes a transparent, completable quality score for a
 * project from a ProjectProbe.
 *
 * Why this is not an "Almost Perfect" meter:
 *  - The score CAN reach 100 when every applicable rule is satisfied.
 *  - Rules that can't be evaluated (missing probe data) are SKIPPED and do
 *    not count against the user — the score is renormalised over evaluated
 *    weight only. Users never chase points for criteria we can't measure.
 *  - Each rule is deterministic, transparent, and hint-labeled so the user
 *    knows exactly what will lift the score.
 *  - Results are persisted (QualityCheckRun) for auditability.
 */

import type {
  ProjectProbe,
  QualityRuleResult,
  QualityScore,
} from "./types";

/** Internal rule definition. */
interface QualityRule {
  ruleId: string;
  label: string;
  hint: string;
  weight: number;
  /**
   * Evaluate the rule. Returns:
   *  - `{ awarded, measured? }` if the rule could be evaluated,
   *  - `null` if the probe lacked the data (rule is skipped).
   */
  evaluate: (
    probe: ProjectProbe,
  ) => { awarded: number; measured?: string } | null;
}

/** Ordered list of all quality rules. Order is used as UI sort order. */
const RULES: QualityRule[] = [
  {
    ruleId: "resolution_1080p",
    label: "Delivered at 1080p or higher",
    hint: "Export at 1920×1080 or higher so the video looks crisp on modern screens.",
    weight: 10,
    evaluate: (p) => {
      if (p.widthPx === undefined || p.heightPx === undefined) return null;
      const shortEdge = Math.min(p.widthPx, p.heightPx);
      const longEdge = Math.max(p.widthPx, p.heightPx);
      if (longEdge >= 1920 && shortEdge >= 1080) {
        return { awarded: 10, measured: `${p.widthPx}×${p.heightPx}` };
      }
      if (longEdge >= 1280 && shortEdge >= 720) {
        return { awarded: 6, measured: `${p.widthPx}×${p.heightPx}` };
      }
      return { awarded: 0, measured: `${p.widthPx}×${p.heightPx}` };
    },
  },
  {
    ruleId: "audio_present",
    label: "Audio track is present",
    hint: "Silent videos rarely retain viewers — add narration, dialogue, or music.",
    weight: 8,
    evaluate: (p) => {
      if (p.hasAudio === undefined) return null;
      return { awarded: p.hasAudio ? 8 : 0 };
    },
  },
  {
    ruleId: "audio_loudness",
    label: "Loudness within broadcast range (-18 to -12 LUFS)",
    hint: "Aim for about -14 LUFS integrated so your video is neither too quiet nor clipped on Quanttube.",
    weight: 8,
    evaluate: (p) => {
      if (p.audioLufs === undefined) return null;
      const lufs = p.audioLufs;
      const measured = `${lufs.toFixed(1)} LUFS`;
      // Perfect band: -16..-12. Acceptable: -20..-10. Outside: 0 points.
      if (lufs >= -16 && lufs <= -12) return { awarded: 8, measured };
      if (lufs >= -20 && lufs <= -10) return { awarded: 5, measured };
      return { awarded: 0, measured };
    },
  },
  {
    ruleId: "audio_no_clipping",
    label: "No audio clipping (peak ≤ -1 dBFS)",
    hint: "Reduce the master audio gain — platform encoders distort peaks above -1 dBFS.",
    weight: 6,
    evaluate: (p) => {
      if (p.audioPeakDb === undefined) return null;
      const measured = `${p.audioPeakDb.toFixed(1)} dBFS`;
      if (p.audioPeakDb <= -1) return { awarded: 6, measured };
      if (p.audioPeakDb <= 0) return { awarded: 3, measured };
      return { awarded: 0, measured };
    },
  },
  {
    ruleId: "captions",
    label: "Captions or subtitles available",
    hint: "Most mobile viewers watch muted — add a caption track to keep them engaged and to help accessibility.",
    weight: 10,
    evaluate: (p) => {
      if (p.hasCaptions === undefined) return null;
      return { awarded: p.hasCaptions ? 10 : 0 };
    },
  },
  {
    ruleId: "custom_thumbnail",
    label: "Custom thumbnail selected",
    hint: "A deliberate thumbnail improves click-through versus an auto-generated frame.",
    weight: 8,
    evaluate: (p) => {
      if (p.hasCustomThumbnail === undefined) return null;
      return { awarded: p.hasCustomThumbnail ? 8 : 0 };
    },
  },
  {
    ruleId: "title",
    label: "Title is set",
    hint: "Add a descriptive title before publishing.",
    weight: 6,
    evaluate: (p) => {
      if (p.hasTitle === undefined) return null;
      return { awarded: p.hasTitle ? 6 : 0 };
    },
  },
  {
    ruleId: "description",
    label: "Description is set",
    hint: "A short description improves search discoverability on Quanttube.",
    weight: 4,
    evaluate: (p) => {
      if (p.hasDescription === undefined) return null;
      return { awarded: p.hasDescription ? 4 : 0 };
    },
  },
  {
    ruleId: "tags",
    label: "At least 3 tags or keywords",
    hint: "Tags help Quanttube recommend your video to the right audience.",
    weight: 4,
    evaluate: (p) => {
      if (p.tagCount === undefined) return null;
      const measured = `${p.tagCount} tag${p.tagCount === 1 ? "" : "s"}`;
      if (p.tagCount >= 3) return { awarded: 4, measured };
      if (p.tagCount >= 1) return { awarded: 2, measured };
      return { awarded: 0, measured };
    },
  },
  {
    ruleId: "intro_hook",
    label: "Intro includes a visual or text hook",
    hint: "Open with a strong hook in the first 3 seconds — this dramatically improves retention.",
    weight: 8,
    evaluate: (p) => {
      if (p.hasIntroHook === undefined) return null;
      return { awarded: p.hasIntroHook ? 8 : 0 };
    },
  },
  {
    ruleId: "pacing",
    label: "Pacing feels active (at least 1 cut every 10 seconds)",
    hint: "Add a cut or B-roll insert so long passages don't feel static.",
    weight: 8,
    evaluate: (p) => {
      if (p.cutCount === undefined || p.durationSec === undefined) return null;
      if (p.durationSec <= 0) return null;
      const secondsPerCut = p.durationSec / Math.max(1, p.cutCount);
      const measured = `1 cut / ${secondsPerCut.toFixed(1)}s`;
      if (secondsPerCut <= 10) return { awarded: 8, measured };
      if (secondsPerCut <= 20) return { awarded: 5, measured };
      return { awarded: 0, measured };
    },
  },
  {
    ruleId: "color_grade",
    label: "Colour grading applied",
    hint: "A consistent grade or LUT gives the video a polished, intentional look.",
    weight: 6,
    evaluate: (p) => {
      if (p.hasColorGrade === undefined) return null;
      return { awarded: p.hasColorGrade ? 6 : 0 };
    },
  },
  {
    ruleId: "transitions",
    label: "At least one intentional transition",
    hint: "A single well-placed transition between scenes can sharpen the edit.",
    weight: 4,
    evaluate: (p) => {
      if (p.hasTransitions === undefined) return null;
      return { awarded: p.hasTransitions ? 4 : 0 };
    },
  },
  {
    ruleId: "music",
    label: "Background music added",
    hint: "Optional but often lifts engagement on short-form content.",
    weight: 4,
    evaluate: (p) => {
      if (p.hasMusic === undefined) return null;
      return { awarded: p.hasMusic ? 4 : 0 };
    },
  },
  {
    ruleId: "framerate",
    label: "Stable frame rate (24, 25, 30, 50, or 60 fps)",
    hint: "Stick to a standard frame rate to avoid judder on playback.",
    weight: 3,
    evaluate: (p) => {
      if (p.fps === undefined) return null;
      const measured = `${p.fps.toFixed(0)} fps`;
      const standard = [24, 25, 30, 50, 60];
      const isStandard = standard.some((s) => Math.abs(p.fps! - s) < 0.5);
      return { awarded: isStandard ? 3 : 0, measured };
    },
  },
  {
    ruleId: "duration_sensible",
    label: "Duration is between 10 seconds and 60 minutes",
    hint: "Very short or very long clips often underperform — consider trimming or splitting.",
    weight: 3,
    evaluate: (p) => {
      if (p.durationSec === undefined) return null;
      const measured = `${p.durationSec.toFixed(1)}s`;
      if (p.durationSec >= 10 && p.durationSec <= 3600) {
        return { awarded: 3, measured };
      }
      return { awarded: 0, measured };
    },
  },
];

// Sanity check — the sum of weights is the theoretical max when all rules apply.
const TOTAL_WEIGHT = RULES.reduce((acc, r) => acc + r.weight, 0);
// Exported for tests and for the UI if it wants to display the total.
export const QUALITY_RULE_MAX_WEIGHT = TOTAL_WEIGHT;

/**
 * Evaluate a probe and produce a transparent QualityScore.
 *
 * The score is normalised over *evaluated* weight so skipping unmeasurable
 * rules cannot drag the score down. A project that satisfies every
 * evaluable rule legitimately reaches 100.
 */
export function evaluateQuality(probe: ProjectProbe): QualityScore {
  const rules: QualityRuleResult[] = RULES.map((rule) => {
    const result = rule.evaluate(probe);
    if (result === null) {
      return {
        ruleId: rule.ruleId,
        label: rule.label,
        hint: rule.hint,
        weight: rule.weight,
        awarded: 0,
        passed: false,
        skipped: true,
      } satisfies QualityRuleResult;
    }
    return {
      ruleId: rule.ruleId,
      label: rule.label,
      hint: rule.hint,
      weight: rule.weight,
      awarded: result.awarded,
      passed: result.awarded >= rule.weight,
      skipped: false,
      measured: result.measured,
    } satisfies QualityRuleResult;
  });

  const evaluatedWeight = rules
    .filter((r) => !r.skipped)
    .reduce((acc, r) => acc + r.weight, 0);
  const awardedSum = rules
    .filter((r) => !r.skipped)
    .reduce((acc, r) => acc + r.awarded, 0);

  // When no rules evaluated, score is 0 with a clear signal via evaluatedWeight.
  const score =
    evaluatedWeight === 0
      ? 0
      : Math.round((awardedSum / evaluatedWeight) * 100);

  // Build a rank-ordered list of "next best actions": the unmet rules, ordered
  // by potential point gain on the normalised 0..100 scale.
  const nextBestActions = rules
    .filter((r) => !r.skipped && !r.passed)
    .map((r) => ({
      ruleId: r.ruleId,
      gain:
        evaluatedWeight === 0
          ? 0
          : Math.round(((r.weight - r.awarded) / evaluatedWeight) * 100),
      hint: r.hint,
    }))
    .filter((a) => a.gain > 0)
    .sort((a, b) => b.gain - a.gain);

  return {
    score,
    evaluatedWeight,
    rules,
    nextBestActions,
    computedAt: new Date().toISOString(),
  };
}
