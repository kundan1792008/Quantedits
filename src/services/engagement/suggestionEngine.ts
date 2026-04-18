/**
 * Suggestion Engine — produces honest, contextual editing suggestions from
 * a ProjectProbe.
 *
 * Design notes:
 *  - Suggestions are *helpful*, not engagement traps. Each rule produces at
 *    most one suggestion and only when the underlying probe data says it is
 *    genuinely applicable.
 *  - The engine is deterministic given the same probe — no randomness, no
 *    "keep the user clicking" micro-decisions.
 *  - Severity: INFO (nice-to-have), RECOMMENDED (likely improves the edit),
 *    WARNING (a concrete problem such as clipping or missing captions).
 *  - Results are plain data; persistence is the caller's responsibility.
 */

import type { ProjectProbe, SuggestionCandidate } from "./types";

type Rule = (probe: ProjectProbe) => SuggestionCandidate | null;

const rules: Rule[] = [
  // ── WARNINGs first ───────────────────────────────────────────────────────
  (p) => {
    if (p.audioPeakDb === undefined) return null;
    if (p.audioPeakDb <= -1) return null;
    return {
      ruleId: "audio_clipping",
      title: "Audio is clipping",
      body: `The loudest peak is ${p.audioPeakDb.toFixed(1)} dBFS. Reduce the master gain to -1 dBFS or below so the platform encoder doesn't distort.`,
      severity: "WARNING",
      context: { peakDb: p.audioPeakDb },
    };
  },
  (p) => {
    if (p.audioLufs === undefined) return null;
    if (p.audioLufs >= -20) return null;
    return {
      ruleId: "audio_too_quiet",
      title: "Audio is below the recommended loudness",
      body: `Integrated loudness is ${p.audioLufs.toFixed(1)} LUFS. Normalise toward -14 LUFS so viewers don't have to raise their volume.`,
      severity: "WARNING",
      context: { lufs: p.audioLufs },
    };
  },
  (p) => {
    if (p.hasCaptions === undefined || p.hasCaptions) return null;
    return {
      ruleId: "missing_captions",
      title: "Captions improve mobile reach",
      body: "Most mobile feeds autoplay muted. A caption track improves watch time and accessibility.",
      severity: "RECOMMENDED",
    };
  },

  // ── RECOMMENDEDs ────────────────────────────────────────────────────────
  (p) => {
    if (p.hasIntroHook === undefined || p.hasIntroHook) return null;
    return {
      ruleId: "intro_hook",
      title: "Strengthen the opening 3 seconds",
      body: "Add a visual hook, text overlay, or question in the first three seconds to improve retention.",
      severity: "RECOMMENDED",
    };
  },
  (p) => {
    if (p.cutCount === undefined || p.durationSec === undefined) return null;
    if (p.durationSec <= 0) return null;
    const spc = p.durationSec / Math.max(1, p.cutCount);
    if (spc <= 10) return null;
    return {
      ruleId: "pacing_slow",
      title: "Consider tightening the pace",
      body: `On average there is one cut every ${spc.toFixed(1)} seconds. For short-form content, aiming below 10 seconds per cut usually improves watch time.`,
      severity: "RECOMMENDED",
      context: { secondsPerCut: spc },
    };
  },
  (p) => {
    if (p.hasCustomThumbnail === undefined || p.hasCustomThumbnail) return null;
    return {
      ruleId: "thumbnail_missing",
      title: "Pick a thumbnail before publishing",
      body: "A deliberate thumbnail typically improves click-through versus an auto-generated frame.",
      severity: "RECOMMENDED",
    };
  },
  (p) => {
    if (p.widthPx === undefined || p.heightPx === undefined) return null;
    const longEdge = Math.max(p.widthPx, p.heightPx);
    if (longEdge >= 1920) return null;
    return {
      ruleId: "resolution_low",
      title: "Export at 1080p or higher if the source allows",
      body: `Current output is ${p.widthPx}×${p.heightPx}. Rendering at 1920×1080 (or higher) looks noticeably sharper on modern screens.`,
      severity: "RECOMMENDED",
      context: { widthPx: p.widthPx, heightPx: p.heightPx },
    };
  },

  // ── INFOs ───────────────────────────────────────────────────────────────
  (p) => {
    if (p.hasColorGrade === undefined || p.hasColorGrade) return null;
    return {
      ruleId: "color_grade_info",
      title: "A colour grade can polish the look",
      body: "A light grade or LUT unifies shots filmed under different lighting and gives the video an intentional mood.",
      severity: "INFO",
    };
  },
  (p) => {
    if (p.hasMusic === undefined || p.hasMusic) return null;
    if (p.hasAudio === false) return null; // already flagged as WARNING elsewhere
    return {
      ruleId: "music_info",
      title: "Background music is optional but often helps",
      body: "A subtle music bed under spoken audio tends to increase perceived production value, especially on short-form platforms.",
      severity: "INFO",
    };
  },
  (p) => {
    if (p.hasTransitions === undefined || p.hasTransitions) return null;
    if (p.cutCount === undefined || p.cutCount < 2) return null;
    return {
      ruleId: "transitions_info",
      title: "Try a transition between scenes",
      body: "A single, purposeful transition between major scenes can improve narrative flow — avoid overusing them.",
      severity: "INFO",
    };
  },
  (p) => {
    if (p.tagCount === undefined) return null;
    if (p.tagCount >= 3) return null;
    return {
      ruleId: "tags_info",
      title: "Add a few more tags",
      body: "Three to five accurate tags give Quanttube's recommender better signal when matching your video to viewers.",
      severity: "INFO",
      context: { tagCount: p.tagCount },
    };
  },
  (p) => {
    if (p.fps === undefined) return null;
    const standard = [24, 25, 30, 50, 60];
    if (standard.some((s) => Math.abs(p.fps! - s) < 0.5)) return null;
    return {
      ruleId: "framerate_info",
      title: "Consider rendering at a standard frame rate",
      body: `Current frame rate is ${p.fps.toFixed(2)} fps. Standard rates (24/25/30/50/60) avoid judder on typical playback devices.`,
      severity: "INFO",
      context: { fps: p.fps },
    };
  },
];

/**
 * Run every rule against `probe` and return the applicable suggestions.
 *
 * Ordering: WARNINGs first, then RECOMMENDED, then INFO — stable within each
 * bucket to keep the UI from jittering between renders.
 */
export function generateSuggestions(probe: ProjectProbe): SuggestionCandidate[] {
  const raw = rules
    .map((rule) => rule(probe))
    .filter((x): x is SuggestionCandidate => x !== null);

  const order: Record<SuggestionCandidate["severity"], number> = {
    WARNING: 0,
    RECOMMENDED: 1,
    INFO: 2,
  };

  return raw.slice().sort((a, b) => order[a.severity] - order[b.severity]);
}
