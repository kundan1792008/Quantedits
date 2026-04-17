/**
 * Draft Anxiety Service
 * ─────────────────────
 *
 * Implements the "you have 3 unfinished projects, your audience is waiting"
 * push-notification loop from issue #14.  The service tracks every draft
 * the user has touched, watches for 24-hour stretches of inactivity, and
 * fires escalating anxiety notifications through {@link PushNotifications}.
 *
 * The escalation ladder (all copy is tuned to invoke mild social FOMO
 * without tipping into distress):
 *
 *   • 24h  — "You have N unfinished projects. Your audience is waiting."
 *   • 48h  — "Your draft streak is about to break. 1 tap to save it."
 *   • 72h+ — "Creators who publish weekly grow 4× faster. Finish one draft?"
 *
 * Anxiety pings are deliberately throttled to at most one per draft per
 * calendar day so the app does not become spammy.
 */

import {
  pushNotificationService,
  type PushNotificationService,
  type CreationNotification,
} from "./PushNotifications";

const MS_PER_HOUR = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface DraftRecord {
  id: string;
  title: string;
  /** UNIX ms of the last edit. */
  lastEditedAt: number;
  /** UNIX ms when the draft was created. */
  createdAt: number;
  /** Whether the draft has been published at least once. */
  published: boolean;
  /** Current quality score (0-100) pulled from the QualityMeter. */
  qualityScore: number;
}

export interface AnxietyDispatch {
  draft: DraftRecord;
  hoursIdle: number;
  tier: "soft" | "medium" | "hard";
  notification: CreationNotification;
}

export interface DraftAnxietyOptions {
  /** Hours of inactivity before the first ping is fired. */
  softThresholdHours?: number;
  /** Hours of inactivity before the medium ping is fired. */
  mediumThresholdHours?: number;
  /** Hours of inactivity before the hard ping is fired. */
  hardThresholdHours?: number;
  /** "Now" provider — injectable for tests. */
  now?: () => number;
  /** Push service — injectable for tests. */
  push?: PushNotificationService;
}

export class DraftAnxietyService {
  private drafts = new Map<string, DraftRecord>();
  private lastPingAt = new Map<string, number>();
  private softMs: number;
  private mediumMs: number;
  private hardMs: number;
  private now: () => number;
  private push: PushNotificationService;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DraftAnxietyOptions = {}) {
    this.softMs = (options.softThresholdHours ?? 24) * MS_PER_HOUR;
    this.mediumMs = (options.mediumThresholdHours ?? 48) * MS_PER_HOUR;
    this.hardMs = (options.hardThresholdHours ?? 72) * MS_PER_HOUR;
    this.now = options.now ?? (() => Date.now());
    this.push = options.push ?? pushNotificationService;
  }

  /**
   * Register or update a draft.  Typically called whenever the timeline
   * is modified so the lastEditedAt timestamp stays current.
   */
  upsert(draft: DraftRecord): void {
    this.drafts.set(draft.id, { ...draft });
  }

  /** Remove a draft (e.g. after a successful publish). */
  remove(id: string): void {
    this.drafts.delete(id);
    this.lastPingAt.delete(id);
  }

  /** Current drafts, sorted by most-recently-edited first. */
  list(): DraftRecord[] {
    return [...this.drafts.values()].sort(
      (a, b) => b.lastEditedAt - a.lastEditedAt,
    );
  }

  /**
   * Start the periodic sweep that checks for idle drafts.  Returns a
   * stop function.  The interval defaults to once per 15 minutes, which
   * is sufficient for a 24-hour threshold.
   */
  start(intervalMs = 15 * 60 * 1_000): () => void {
    this.stop();
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    // Run once on start so fresh page loads also ping.
    this.sweep();
    return () => this.stop();
  }

  /** Stop the periodic sweep (if running). */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Inspect every tracked draft and fire anxiety pings where appropriate.
   * Returns the list of dispatches performed in this sweep.
   */
  sweep(): AnxietyDispatch[] {
    const now = this.now();
    const dispatches: AnxietyDispatch[] = [];
    const idleDrafts = [...this.drafts.values()].filter(
      (d) => !d.published && now - d.lastEditedAt >= this.softMs,
    );
    if (idleDrafts.length === 0) return dispatches;

    const totalIdle = idleDrafts.length;

    for (const draft of idleDrafts) {
      const idleMs = now - draft.lastEditedAt;
      const hoursIdle = Math.floor(idleMs / MS_PER_HOUR);
      const tier: AnxietyDispatch["tier"] =
        idleMs >= this.hardMs
          ? "hard"
          : idleMs >= this.mediumMs
            ? "medium"
            : "soft";

      // Throttle: at most one ping per draft per 24h, per tier-change.
      const last = this.lastPingAt.get(draft.id) ?? 0;
      if (now - last < MS_PER_DAY) continue;

      const notification = this.composeNotification({
        draft,
        hoursIdle,
        tier,
        totalIdle,
        now,
      });
      this.push.fire(notification);
      this.lastPingAt.set(draft.id, now);
      dispatches.push({ draft, hoursIdle, tier, notification });
    }

    return dispatches;
  }

  // ── Notification composition ─────────────────────────────────────────

  private composeNotification(args: {
    draft: DraftRecord;
    hoursIdle: number;
    tier: AnxietyDispatch["tier"];
    totalIdle: number;
    now: number;
  }): CreationNotification {
    const { draft, hoursIdle, tier, totalIdle, now } = args;

    let title: string;
    let body: string;
    if (tier === "hard") {
      title = `"${draft.title}" has been idle ${Math.floor(hoursIdle / 24)} days`;
      body = `Creators who publish weekly grow 4× faster. Finish this draft in 2 minutes?`;
    } else if (tier === "medium") {
      title = `Your draft streak is about to break`;
      body = `"${draft.title}" sits at ${draft.qualityScore.toFixed(0)}% quality — 1 tap gets it past 94%.`;
    } else {
      const many = totalIdle > 1 ? ` (plus ${totalIdle - 1} more)` : "";
      title = `You have an unfinished project${many}`;
      body = `"${draft.title}" has been idle ${hoursIdle}h. Your audience is waiting.`;
    }

    return {
      id: `draft-anxiety:${draft.id}:${now}`,
      title,
      body,
      tone: "anxiety",
      groupKey: "draft-anxiety",
      createdAt: now,
      actionId: "open-draft",
      payload: { draftId: draft.id, tier },
      durationMs: 12_000,
    };
  }
}

export const draftAnxietyService = new DraftAnxietyService();
