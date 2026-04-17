/**
 * Public barrel for the engagement services.
 *
 * Consumers (API routes, React server components) should import from this
 * file rather than reaching into individual module paths.
 */

export * from "./types";
export { evaluateQuality, QUALITY_RULE_MAX_WEIGHT } from "./qualityChecker";
export { generateSuggestions } from "./suggestionEngine";
export { StreakTracker } from "./streakTracker";
export { ViewEstimator } from "./viewEstimator";
export type { ViewEstimateContext } from "./viewEstimator";
export { TemplateLibrary } from "./templateLibrary";
export type { TemplateCreateInput } from "./templateLibrary";
export { PushDispatcher, noopTransport } from "./pushDispatcher";
export type {
  PushPayload,
  PushSubscriptionInput,
  PushTransport,
} from "./pushDispatcher";
export { DraftReminder } from "./draftReminder";
export type { DraftReminderResult } from "./draftReminder";
