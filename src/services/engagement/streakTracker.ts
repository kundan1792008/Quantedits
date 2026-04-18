/**
 * Streak Tracker — opt-in, neutral creation-day counter.
 *
 * Important ethical constraints (do NOT remove):
 *  - Streaks are *opt-in*. The UI surfaces them only when the user has
 *    toggled `preferences.streakEnabled`.
 *  - Streaks never grant platform benefits. We do NOT tell users their
 *    streak gives them a "visibility boost" or similar. The Quanttube
 *    ranking algorithm is independent and we make no claims about it.
 *  - A streak is simply a count of consecutive UTC days on which the user
 *    created or substantially edited a project.
 *  - Users may reset their streak at any time.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { StreakStatus } from "./types";

/** Format a Date to an ISO UTC date string (YYYY-MM-DD). */
function toUtcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Number of whole UTC days from `from` to `to` (can be negative). */
function daysBetween(from: string, to: string): number {
  const fromDate = new Date(`${from}T00:00:00Z`).getTime();
  const toDate = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((toDate - fromDate) / 86_400_000);
}

export class StreakTracker {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Read (or lazily create) the streak record for a user.
   *
   * The record is created in a DISABLED state — it won't tick forward until
   * the user explicitly opts in via `setEnabled(userId, true)`.
   */
  async getStatus(userId: string, today: Date = new Date()): Promise<StreakStatus> {
    const row = await this.prisma.creationStreak.upsert({
      where: { userId },
      update: {},
      create: { userId, enabled: false },
    });

    const todayStr = toUtcDateString(today);
    return {
      enabled: row.enabled,
      current: row.currentStreak,
      longest: row.longestStreak,
      lastActiveDate: row.lastActiveDate,
      countedToday: row.lastActiveDate === todayStr,
    };
  }

  /**
   * Enable or disable streak tracking. Disabling preserves the historic
   * longest-streak value but zeroes the current streak so a returning user
   * starts fresh.
   */
  async setEnabled(userId: string, enabled: boolean): Promise<StreakStatus> {
    const existing = await this.prisma.creationStreak.upsert({
      where: { userId },
      update: {
        enabled,
        ...(enabled ? {} : { currentStreak: 0, lastActiveDate: null }),
      },
      create: { userId, enabled },
    });
    return {
      enabled: existing.enabled,
      current: existing.currentStreak,
      longest: existing.longestStreak,
      lastActiveDate: existing.lastActiveDate,
      countedToday: false,
    };
  }

  /**
   * Record that the user did "something creative" today. Returns the new
   * status. No-op when streaks are disabled — we never silently enable.
   */
  async recordActivity(userId: string, today: Date = new Date()): Promise<StreakStatus> {
    const row = await this.prisma.creationStreak.upsert({
      where: { userId },
      update: {},
      create: { userId, enabled: false },
    });

    if (!row.enabled) {
      return {
        enabled: false,
        current: row.currentStreak,
        longest: row.longestStreak,
        lastActiveDate: row.lastActiveDate,
        countedToday: false,
      };
    }

    const todayStr = toUtcDateString(today);
    if (row.lastActiveDate === todayStr) {
      // Already counted today — idempotent.
      return {
        enabled: true,
        current: row.currentStreak,
        longest: row.longestStreak,
        lastActiveDate: row.lastActiveDate,
        countedToday: true,
      };
    }

    let current = row.currentStreak;
    if (row.lastActiveDate === null) {
      current = 1;
    } else {
      const gap = daysBetween(row.lastActiveDate, todayStr);
      if (gap === 1) {
        current = row.currentStreak + 1;
      } else if (gap > 1) {
        // Missed at least one day — streak resets.
        current = 1;
      } else {
        // gap <= 0 (clock skew or future date) — treat as same day, keep streak.
        current = Math.max(1, row.currentStreak);
      }
    }

    const longest = Math.max(row.longestStreak, current);

    const updated = await this.prisma.creationStreak.update({
      where: { userId },
      data: {
        currentStreak: current,
        longestStreak: longest,
        lastActiveDate: todayStr,
      },
    });

    return {
      enabled: true,
      current: updated.currentStreak,
      longest: updated.longestStreak,
      lastActiveDate: updated.lastActiveDate,
      countedToday: true,
    };
  }

  /** Manually reset the current streak to 0 (longest is preserved). */
  async reset(userId: string): Promise<StreakStatus> {
    const updated = await this.prisma.creationStreak.upsert({
      where: { userId },
      update: { currentStreak: 0, lastActiveDate: null },
      create: { userId, enabled: false },
    });
    return {
      enabled: updated.enabled,
      current: updated.currentStreak,
      longest: updated.longestStreak,
      lastActiveDate: updated.lastActiveDate,
      countedToday: false,
    };
  }
}
