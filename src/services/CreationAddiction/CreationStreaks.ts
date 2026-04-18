/**
 * Creation Streak Tracker
 * ───────────────────────
 *
 * Implements the daily streak system from issue #14:
 *
 *   "You've created content 5 days in a row! Creators with 30-day streaks
 *   get 3× visibility boost."
 *
 * The tracker persists a per-user streak in `localStorage` (on web) or in
 * memory (on SSR / native — the native shell is expected to mirror the
 * value via Capacitor Preferences, out of scope for this module).
 *
 * Rules:
 *   • Two creation events on the same local day count as one.
 *   • Missing a day resets the streak to 1 on the next creation event.
 *   • The visibility boost follows a piecewise curve:
 *       days  0–2   → 1.0×
 *       days  3–6   → 1.2×
 *       days  7–13  → 1.5×
 *       days 14–29  → 2.1×
 *       days 30+    → 3.0×
 *
 * A "celebration" notification is fired on every milestone (3, 7, 14, 30, 60…)
 * through the PushNotifications service so the UI can pop confetti.
 */

import {
  pushNotificationService,
  type PushNotificationService,
  type CreationNotification,
} from "./PushNotifications";

const MILESTONES = [3, 7, 14, 30, 60, 90, 180, 365];

const STORAGE_KEY = "quantedits.creationStreak.v1";

export interface StreakState {
  current: number;
  longest: number;
  /** ISO date string (YYYY-MM-DD) of the most recent creation event. */
  lastActiveDate: string | null;
  /** Milestones the user has already been congratulated on. */
  milestonesReached: number[];
}

export interface StreakUpdate {
  before: StreakState;
  after: StreakState;
  milestoneHit: number | null;
  boostMultiplier: number;
}

export interface CreationStreaksOptions {
  now?: () => Date;
  push?: PushNotificationService;
  storage?: Storage | null;
}

/** Visibility boost multiplier for a given streak length. */
export function streakBoost(days: number): number {
  if (days >= 30) return 3.0;
  if (days >= 14) return 2.1;
  if (days >= 7) return 1.5;
  if (days >= 3) return 1.2;
  return 1.0;
}

function defaultState(): StreakState {
  return {
    current: 0,
    longest: 0,
    lastActiveDate: null,
    milestonesReached: [],
  };
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((db - da) / (24 * 60 * 60 * 1_000));
}

function safeStorage(override: Storage | null | undefined): Storage | null {
  if (override !== undefined) return override;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export class CreationStreaksService {
  private state: StreakState;
  private now: () => Date;
  private push: PushNotificationService;
  private storage: Storage | null;

  constructor(options: CreationStreaksOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.push = options.push ?? pushNotificationService;
    this.storage = safeStorage(options.storage);
    this.state = this.load();
  }

  /** Current streak state (read-only snapshot). */
  getState(): StreakState {
    return { ...this.state, milestonesReached: [...this.state.milestonesReached] };
  }

  /** Visibility boost multiplier for the current streak. */
  currentBoost(): number {
    return streakBoost(this.state.current);
  }

  /**
   * Record a creation event — typically called when the user saves a
   * draft or exports a project.  Returns a delta describing any changes.
   */
  recordCreation(): StreakUpdate {
    const before = this.getState();
    const today = toIsoDate(this.now());
    if (before.lastActiveDate === today) {
      // Already counted today — no-op.
      return {
        before,
        after: before,
        milestoneHit: null,
        boostMultiplier: streakBoost(before.current),
      };
    }

    let current = before.current;
    if (!before.lastActiveDate) {
      current = 1;
    } else {
      const gap = daysBetween(before.lastActiveDate, today);
      if (gap === 1) current += 1;
      else if (gap > 1) current = 1;
      // gap < 1 (e.g. clock changes) → keep existing current.
    }

    const longest = Math.max(before.longest, current);
    const milestonesReached = [...before.milestonesReached];
    const newlyHit = MILESTONES.find(
      (m) => current >= m && !milestonesReached.includes(m),
    );
    if (newlyHit) milestonesReached.push(newlyHit);

    const after: StreakState = {
      current,
      longest,
      lastActiveDate: today,
      milestonesReached,
    };
    this.state = after;
    this.persist();

    if (newlyHit !== undefined) {
      this.fireMilestone(newlyHit, after);
    }

    return {
      before,
      after,
      milestoneHit: newlyHit ?? null,
      boostMultiplier: streakBoost(current),
    };
  }

  /** Force a reset — typically called when the user logs out. */
  reset(): void {
    this.state = defaultState();
    this.persist();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private load(): StreakState {
    if (!this.storage) return defaultState();
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw) as Partial<StreakState>;
      return {
        current: Number.isFinite(parsed.current) ? (parsed.current as number) : 0,
        longest: Number.isFinite(parsed.longest) ? (parsed.longest as number) : 0,
        lastActiveDate:
          typeof parsed.lastActiveDate === "string"
            ? parsed.lastActiveDate
            : null,
        milestonesReached: Array.isArray(parsed.milestonesReached)
          ? (parsed.milestonesReached as number[]).filter((n) =>
              Number.isFinite(n),
            )
          : [],
      };
    } catch {
      return defaultState();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore quota / private-mode failures.
    }
  }

  private fireMilestone(days: number, after: StreakState): void {
    const boost = streakBoost(days);
    const boostText =
      boost >= 3 ? "3× visibility boost" : `${boost.toFixed(1)}× visibility`;
    const notification: CreationNotification = {
      id: `streak-milestone:${days}:${after.lastActiveDate}`,
      title: days >= 30
        ? `🏆 ${days}-day streak — you unlocked 3× visibility!`
        : `🔥 ${days}-day streak!`,
      body:
        days >= 30
          ? "You're in the top 1% of creators. The Quanttube algorithm now favours your posts."
          : `You've created content ${days} days in a row. Keep going to unlock ${boostText}.`,
      tone: "streak",
      groupKey: "streak",
      createdAt: Date.now(),
      durationMs: 10_000,
      payload: { days, boost },
    };
    this.push.fire(notification);
  }
}

export const creationStreaksService = new CreationStreaksService();
