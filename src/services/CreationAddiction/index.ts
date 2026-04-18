/**
 * Creation Addiction — Service Orchestrator
 * ─────────────────────────────────────────
 *
 * One-stop barrel export for the six services that together implement the
 * Creation Addiction loop described in issue #14:
 *
 *   1. {@link SuggestionEngine}   — AI auto-suggestions
 *   2. {@link QualityMeter}       — "Almost Perfect" meter
 *   3. {@link DraftAnxietyService}— 24h+ inactivity push loop
 *   4. {@link SocialValidationPredictor} — predicted view counts
 *   5. {@link CreationStreaksService}    — daily streak + 3× boost
 *   6. {@link TemplateFOMOService}       — template rotation + FOMO
 *
 * The {@link CreationAddictionEngine} class wires all of the above
 * together behind a single ergonomic API that React components consume
 * via the `useCreationAddiction` hook.
 */

import {
  SuggestionEngine,
  suggestionEngine,
  type EditorContext,
  type Suggestion,
  type SuggestionEvent,
} from "./SuggestionEngine";
import {
  QualityMeter,
  qualityMeter,
  type QualityBreakdown,
  type QualityInputs,
} from "./QualityMeter";
import {
  DraftAnxietyService,
  draftAnxietyService,
  type DraftRecord,
} from "./DraftAnxiety";
import {
  SocialValidationPredictor,
  socialValidationPredictor,
  type PredictionInputs,
  type PredictionResult,
  type VideoCategory,
} from "./SocialValidation";
import {
  CreationStreaksService,
  creationStreaksService,
  streakBoost,
  type StreakState,
  type StreakUpdate,
} from "./CreationStreaks";
import {
  TemplateFOMOService,
  templateFOMOService,
  type TrendingInfo,
  type CreationTemplate,
} from "./TemplateFOMO";
import {
  pushNotificationService,
  type PushNotificationService,
  type CreationNotification,
  type NotificationListener,
} from "./PushNotifications";

export type {
  EditorContext,
  Suggestion,
  SuggestionEvent,
  QualityBreakdown,
  QualityInputs,
  DraftRecord,
  PredictionInputs,
  PredictionResult,
  VideoCategory,
  StreakState,
  StreakUpdate,
  TrendingInfo,
  CreationTemplate,
  CreationNotification,
  NotificationListener,
};

export {
  SuggestionEngine,
  QualityMeter,
  DraftAnxietyService,
  SocialValidationPredictor,
  CreationStreaksService,
  TemplateFOMOService,
  streakBoost,
  suggestionEngine,
  qualityMeter,
  draftAnxietyService,
  socialValidationPredictor,
  creationStreaksService,
  templateFOMOService,
  pushNotificationService,
};

// ── Orchestrator ────────────────────────────────────────────────────────

export interface CreationAddictionEngineOptions {
  suggestion?: SuggestionEngine;
  quality?: QualityMeter;
  draftAnxiety?: DraftAnxietyService;
  social?: SocialValidationPredictor;
  streaks?: CreationStreaksService;
  templateFomo?: TemplateFOMOService;
  push?: PushNotificationService;
}

/** Combined snapshot returned by the orchestrator per tick. */
export interface CreationAddictionSnapshot {
  suggestions: Suggestion[];
  quality: QualityBreakdown;
  streak: StreakState;
  streakBoost: number;
  trending: TrendingInfo;
  upcoming: TrendingInfo;
  drafts: DraftRecord[];
}

/**
 * Top-level façade that React layers consume through a single hook.  The
 * class itself is framework-agnostic so it can be reused by the native
 * shell, the Storybook harness, or server-side unit tests.
 */
export class CreationAddictionEngine {
  readonly suggestion: SuggestionEngine;
  readonly quality: QualityMeter;
  readonly draftAnxiety: DraftAnxietyService;
  readonly social: SocialValidationPredictor;
  readonly streaks: CreationStreaksService;
  readonly templateFomo: TemplateFOMOService;
  readonly push: PushNotificationService;

  private started = false;
  private stopAnxiety: (() => void) | null = null;
  private stopTemplate: (() => void) | null = null;
  private suggestionUnsub: (() => void) | null = null;

  constructor(options: CreationAddictionEngineOptions = {}) {
    this.suggestion = options.suggestion ?? suggestionEngine;
    this.quality = options.quality ?? qualityMeter;
    this.draftAnxiety = options.draftAnxiety ?? draftAnxietyService;
    this.social = options.social ?? socialValidationPredictor;
    this.streaks = options.streaks ?? creationStreaksService;
    this.templateFomo = options.templateFomo ?? templateFOMOService;
    this.push = options.push ?? pushNotificationService;
  }

  /** Start every background service (scheduler timers, subscriptions). */
  start(): () => void {
    if (this.started) return () => this.stop();
    this.started = true;

    this.stopAnxiety = this.draftAnxiety.start();
    this.stopTemplate = this.templateFomo.start();

    // Forward accepted suggestions into the quality meter.
    this.suggestionUnsub = this.suggestion.subscribe((event) => {
      if (event.status === "accepted") {
        this.quality.recordAcceptance(event.suggestion);
      }
    });

    return () => this.stop();
  }

  /** Stop every background service. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopAnxiety?.();
    this.stopAnxiety = null;
    this.stopTemplate?.();
    this.stopTemplate = null;
    this.suggestionUnsub?.();
    this.suggestionUnsub = null;
  }

  /**
   * Take a combined snapshot of every surface in the engine.  The React
   * hook calls this on every render and whenever inputs change.
   */
  snapshot(
    editor: EditorContext,
    qualityInputs: QualityInputs,
  ): CreationAddictionSnapshot {
    return {
      suggestions: this.suggestion.pending(),
      quality: this.quality.compute(qualityInputs),
      streak: this.streaks.getState(),
      streakBoost: this.streaks.currentBoost(),
      trending: this.templateFomo.current(),
      upcoming: this.templateFomo.next(),
      drafts: this.draftAnxiety.list(),
    };
  }

  /** Convenience: ticks the suggestion engine with the given context. */
  tickSuggestion(editor: EditorContext): Suggestion | null {
    return this.suggestion.tick(editor);
  }

  /** Convenience: generates a predicted-views result. */
  predict(inputs: Omit<PredictionInputs, "streakMultiplier">): PredictionResult {
    const boostNormalised = Math.max(0, this.streaks.currentBoost() - 1);
    return this.social.predict({ ...inputs, streakMultiplier: boostNormalised });
  }
}

export const creationAddictionEngine = new CreationAddictionEngine();
