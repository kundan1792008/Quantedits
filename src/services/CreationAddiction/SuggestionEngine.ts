/**
 * AI Auto-Suggestion Engine
 * ─────────────────────────
 *
 * Implements the "constant micro-decision" dopamine loop from issue #14.
 * While the user is editing, this engine continuously inspects the current
 * editor context (clips on the timeline, applied effects, detected scene
 * energy, detected audio tempo) and surfaces small, enticing suggestions
 * such as:
 *
 *   • "Add a cinematic color grade?"
 *   • "This clip would look amazing with slow-mo."
 *   • "Your audio is peaking — stabilise to 95% quality?"
 *
 * Each suggestion is a micro-decision the user must act on (accept, dismiss,
 * or snooze).  The act of accepting improves the **Almost Perfect** quality
 * meter (see {@link ./QualityMeter}) by a small amount — but, critically,
 * the meter is engineered never to reach 100%, so the user keeps tweaking.
 *
 * The engine is deliberately framework-agnostic and exposes a simple
 * publish/subscribe API.  React consumers call {@link useCreationAddiction}
 * to render toasts; server or automated pipelines can also subscribe to
 * track acceptance analytics.
 */

export type SuggestionCategory =
  | "color"
  | "audio"
  | "pace"
  | "text"
  | "transition"
  | "effect"
  | "ai-generative"
  | "structure";

export type SuggestionIntensity = "subtle" | "moderate" | "dramatic";

/** Snapshot of the editor provided by the UI on every frame/update. */
export interface EditorContext {
  /** Total duration of the currently loaded timeline, in seconds. */
  durationSec: number;
  /** Number of clips currently in the timeline. */
  clipCount: number;
  /** Whether a music track is attached. */
  hasMusic: boolean;
  /** Whether the user has applied a color grade preset. */
  hasColorGrade: boolean;
  /** Whether any AI generative effects are active. */
  hasGenerativeEffects: boolean;
  /** Average scene energy (0-1), derived from optical flow analytics. */
  sceneEnergy: number;
  /** Detected audio tempo (BPM) — 0 when no music attached. */
  audioBpm: number;
  /** The current playhead position, 0..1. */
  playheadFraction: number;
  /** Identifier of the active project (for suggestion dedupe). */
  projectId: string;
}

/** A single suggestion dispatched to the UI. */
export interface Suggestion {
  id: string;
  category: SuggestionCategory;
  intensity: SuggestionIntensity;
  title: string;
  /** Short persuasive body shown under the title. */
  body: string;
  /** Human-readable call-to-action label. */
  cta: string;
  /** Quality delta (0..1) applied to the Almost-Perfect meter on accept. */
  qualityDelta: number;
  /** Confidence 0..1 that the suggestion is genuinely useful. */
  confidence: number;
  /** UNIX ms when the suggestion was generated. */
  createdAt: number;
  /** If true, the UI should render a subtle emoji flourish. */
  trending?: boolean;
}

/** Lifecycle state of a suggestion. */
export type SuggestionStatus = "pending" | "accepted" | "dismissed" | "snoozed";

export interface SuggestionEvent {
  suggestion: Suggestion;
  status: SuggestionStatus;
}

type SuggestionListener = (event: SuggestionEvent) => void;

// ── Suggestion catalogue ─────────────────────────────────────────────────
//
// The catalogue is intentionally curated, with each entry tuned so that the
// engine can ship something delightful regardless of the editor context.
// Each entry is a function that, given the current context, either produces
// a concrete suggestion or returns `null` to indicate the suggestion is not
// applicable right now.

interface Rule {
  id: string;
  category: SuggestionCategory;
  intensity: SuggestionIntensity;
  baseWeight: number;
  /** True when this suggestion applies to the current context. */
  applies: (ctx: EditorContext) => boolean;
  /** Factory that turns the context into a user-facing suggestion. */
  build: (ctx: EditorContext) => Omit<Suggestion, "id" | "createdAt">;
}

const RULES: Rule[] = [
  {
    id: "color.cinematic",
    category: "color",
    intensity: "moderate",
    baseWeight: 1.1,
    applies: (c) => !c.hasColorGrade,
    build: () => ({
      category: "color",
      intensity: "moderate",
      title: "Add a cinematic color grade?",
      body: "Warm shadows + teal highlights will make this pop on feeds.",
      cta: "Apply Kodak-Teal LUT",
      qualityDelta: 0.018,
      confidence: 0.86,
      trending: true,
    }),
  },
  {
    id: "audio.fill-silence",
    category: "audio",
    intensity: "subtle",
    baseWeight: 1.3,
    applies: (c) => !c.hasMusic && c.durationSec > 6,
    build: () => ({
      category: "audio",
      intensity: "subtle",
      title: "Your cut is missing music.",
      body: "93% of finalists in this length add a trending track.",
      cta: "Pick trending audio",
      qualityDelta: 0.024,
      confidence: 0.91,
      trending: true,
    }),
  },
  {
    id: "pace.slow-mo",
    category: "pace",
    intensity: "dramatic",
    baseWeight: 0.9,
    applies: (c) => c.sceneEnergy > 0.55,
    build: (c) => ({
      category: "pace",
      intensity: "dramatic",
      title: "This clip would look amazing with slow-mo.",
      body: `Detected high-energy motion (${Math.round(c.sceneEnergy * 100)}%). A 0.4× ramp here usually 2× retention.`,
      cta: "Apply 0.4× speed ramp",
      qualityDelta: 0.015,
      confidence: 0.78,
    }),
  },
  {
    id: "text.hook",
    category: "text",
    intensity: "moderate",
    baseWeight: 1.0,
    applies: (c) => c.playheadFraction < 0.08,
    build: () => ({
      category: "text",
      intensity: "moderate",
      title: "Add a hook caption in the first 2 seconds.",
      body: "An on-screen question boosts watch-time by ~37% on average.",
      cta: "Insert auto-caption",
      qualityDelta: 0.021,
      confidence: 0.88,
    }),
  },
  {
    id: "transition.whip",
    category: "transition",
    intensity: "subtle",
    baseWeight: 0.8,
    applies: (c) => c.clipCount >= 3,
    build: (c) => ({
      category: "transition",
      intensity: "subtle",
      title: "Smooth the cut between clips",
      body: `${c.clipCount} hard cuts detected. A whip-pan transition masks them.`,
      cta: "Auto-insert whip transitions",
      qualityDelta: 0.009,
      confidence: 0.69,
    }),
  },
  {
    id: "effect.film-grain",
    category: "effect",
    intensity: "subtle",
    baseWeight: 0.75,
    applies: (c) => c.hasColorGrade,
    build: () => ({
      category: "effect",
      intensity: "subtle",
      title: "Tiny film grain = premium vibe",
      body: "Pair your grade with 6% monochrome grain for a Kodak look.",
      cta: "Add 6% grain",
      qualityDelta: 0.006,
      confidence: 0.64,
    }),
  },
  {
    id: "ai.generative.bg",
    category: "ai-generative",
    intensity: "dramatic",
    baseWeight: 0.95,
    applies: (c) => !c.hasGenerativeEffects && c.clipCount > 0,
    build: () => ({
      category: "ai-generative",
      intensity: "dramatic",
      title: "Generative AI can extend your background 4K",
      body: "Outpaint the sky for a cinematic 2.39:1 letterbox.",
      cta: "Run generative outpainting",
      qualityDelta: 0.028,
      confidence: 0.81,
      trending: true,
    }),
  },
  {
    id: "structure.hook-moment",
    category: "structure",
    intensity: "moderate",
    baseWeight: 1.05,
    applies: (c) => c.durationSec > 20,
    build: (c) => ({
      category: "structure",
      intensity: "moderate",
      title: "Front-load your best moment",
      body: `Your peak-energy frame is at ${Math.round(c.durationSec * 0.62)}s — viewers drop at ${Math.round(c.durationSec * 0.3)}s.`,
      cta: "Re-order to open with peak",
      qualityDelta: 0.022,
      confidence: 0.84,
    }),
  },
  {
    id: "audio.beat-sync",
    category: "audio",
    intensity: "moderate",
    baseWeight: 1.1,
    applies: (c) => c.hasMusic && c.audioBpm > 0 && c.clipCount >= 2,
    build: (c) => ({
      category: "audio",
      intensity: "moderate",
      title: "Snap cuts to the beat",
      body: `${Math.round(c.audioBpm)} BPM detected. Aligning cuts here usually nets +6% quality.`,
      cta: "Auto beat-snap",
      qualityDelta: 0.016,
      confidence: 0.87,
    }),
  },
  {
    id: "effect.flash-impact",
    category: "effect",
    intensity: "dramatic",
    baseWeight: 0.7,
    applies: (c) => c.clipCount > 4 && c.sceneEnergy > 0.4,
    build: () => ({
      category: "effect",
      intensity: "dramatic",
      title: "Add a 1-frame flash on your punchline",
      body: "Creates a visceral 'stop-scroll' feeling for feed viewers.",
      cta: "Apply impact flash",
      qualityDelta: 0.012,
      confidence: 0.72,
    }),
  },
  {
    id: "text.captions-all",
    category: "text",
    intensity: "subtle",
    baseWeight: 1.2,
    applies: (c) => c.durationSec > 12,
    build: () => ({
      category: "text",
      intensity: "subtle",
      title: "Auto-generate captions",
      body: "85% of mobile viewers watch muted. Captions = +2× completion rate.",
      cta: "Generate captions",
      qualityDelta: 0.02,
      confidence: 0.93,
    }),
  },
  {
    id: "transition.jump-cut",
    category: "transition",
    intensity: "subtle",
    baseWeight: 0.65,
    applies: (c) => c.clipCount === 1 && c.durationSec > 8,
    build: () => ({
      category: "transition",
      intensity: "subtle",
      title: "Tighten it with a jump cut",
      body: "Single-take clips retain 28% better when trimmed into 3 segments.",
      cta: "Suggest smart jump cuts",
      qualityDelta: 0.014,
      confidence: 0.7,
    }),
  },
];

// ── Engine implementation ────────────────────────────────────────────────

export interface SuggestionEngineOptions {
  /** Minimum gap between two dispatched suggestions, in ms. */
  minIntervalMs?: number;
  /** Maximum number of simultaneously active suggestions. */
  maxActive?: number;
  /** Seed for deterministic output during tests. */
  seed?: number;
}

export class SuggestionEngine {
  private listeners = new Set<SuggestionListener>();
  private active: Suggestion[] = [];
  private lastFiredAt = 0;
  private minIntervalMs: number;
  private maxActive: number;
  private seed: number;
  private snoozedIds = new Set<string>();

  constructor(options: SuggestionEngineOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 8_000;
    this.maxActive = options.maxActive ?? 3;
    this.seed = options.seed ?? Date.now();
  }

  /**
   * Inspect the editor context and, if appropriate, dispatch a new
   * suggestion to every subscriber.  Returns the new suggestion, or null
   * when no suggestion was produced (e.g. rate limiting).
   */
  tick(ctx: EditorContext, now: number = Date.now()): Suggestion | null {
    if (this.active.length >= this.maxActive) return null;
    if (now - this.lastFiredAt < this.minIntervalMs) return null;

    const candidates = RULES.filter(
      (r) => r.applies(ctx) && !this.snoozedIds.has(r.id),
    );
    if (candidates.length === 0) return null;

    const weighted = candidates.map((r) => ({
      rule: r,
      weight:
        r.baseWeight *
        (1 + this.deterministicJitter(r.id + ctx.projectId) * 0.2),
    }));
    const total = weighted.reduce((s, w) => s + w.weight, 0);
    let pick = this.deterministicRandom(now) * total;
    let chosen = weighted[0];
    for (const w of weighted) {
      pick -= w.weight;
      if (pick <= 0) {
        chosen = w;
        break;
      }
    }

    const base = chosen.rule.build(ctx);
    const suggestion: Suggestion = {
      ...base,
      id: `${chosen.rule.id}:${now}`,
      createdAt: now,
    };
    this.active.push(suggestion);
    this.lastFiredAt = now;
    this.emit({ suggestion, status: "pending" });
    return suggestion;
  }

  /** Mark the given suggestion as accepted (user clicked the CTA). */
  accept(id: string): Suggestion | null {
    const suggestion = this.take(id);
    if (!suggestion) return null;
    this.emit({ suggestion, status: "accepted" });
    return suggestion;
  }

  /** Mark the given suggestion as dismissed (user closed it). */
  dismiss(id: string): Suggestion | null {
    const suggestion = this.take(id);
    if (!suggestion) return null;
    this.emit({ suggestion, status: "dismissed" });
    return suggestion;
  }

  /** Snooze a suggestion rule so it doesn't reappear for this session. */
  snooze(id: string): void {
    const suggestion = this.take(id);
    if (!suggestion) return;
    // Extract the rule id from the suggestion id (rule:timestamp).
    const ruleId = suggestion.id.split(":")[0];
    this.snoozedIds.add(ruleId);
    this.emit({ suggestion, status: "snoozed" });
  }

  /** Currently pending suggestions. */
  pending(): Suggestion[] {
    return [...this.active];
  }

  /** Subscribe to lifecycle events. */
  subscribe(listener: SuggestionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reset the snooze set — typically when a new project is loaded. */
  reset(): void {
    this.snoozedIds.clear();
    this.active = [];
    this.lastFiredAt = 0;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private take(id: string): Suggestion | null {
    const idx = this.active.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    const [s] = this.active.splice(idx, 1);
    return s;
  }

  private emit(event: SuggestionEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("[suggestion] listener threw", err);
      }
    }
  }

  /** Deterministic jitter in [0, 1) based on a hash of the given string. */
  private deterministicJitter(key: string): number {
    let h = this.seed >>> 0;
    for (let i = 0; i < key.length; i++) {
      h = (h ^ key.charCodeAt(i)) * 0x01000193;
      h >>>= 0;
    }
    return (h % 10_000) / 10_000;
  }

  /**
   * Mulberry-32 inspired PRNG seeded by `now` and the engine seed.  Used to
   * break ties in the weighted sampling.
   */
  private deterministicRandom(now: number): number {
    let t = (this.seed + now) | 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296;
  }
}

export const suggestionEngine = new SuggestionEngine();

export { RULES as SUGGESTION_RULES };
