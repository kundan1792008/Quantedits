/**
 * Draft Reminder — polite, opt-in, rate-limited reminders about projects
 * the user started but hasn't opened recently.
 *
 * Explicitly NOT "draft anxiety":
 *  - Copy is neutral and respectful ("Your project X is ready when you
 *    are."). We never write guilt-inducing or urgency-inducing language,
 *    and we never claim the user's "audience is waiting".
 *  - Disabled by default. Requires `preferences.draftReminderPushEnabled`
 *    or `draftReminderEmailEnabled` to be explicitly set to true.
 *  - Rate-limited: at most `maxPerWeek` reminders per project (default 1).
 *  - Only triggered when the project has been idle for at least
 *    `minIdleHours` (default 72 = three full days).
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { PushDispatcher } from "./pushDispatcher";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface DraftReminderResult {
  projectId: string;
  projectTitle: string;
  sent: boolean;
  reason?: "disabled" | "not_idle_enough" | "rate_limited" | "quiet_hours";
}

export class DraftReminder {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly push: PushDispatcher,
  ) {}

  /**
   * Scan every DRAFT / IN_PROGRESS project for `userId` and send at most
   * one respectful reminder per eligible project.
   */
  async runForUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<DraftReminderResult[]> {
    const prefs = await this.prisma.userPreferences.findUnique({
      where: { userId },
    });
    const pushEnabled = prefs?.draftReminderPushEnabled === true;
    const emailEnabled = prefs?.draftReminderEmailEnabled === true;

    const projects = await this.prisma.project.findMany({
      where: {
        userId,
        status: { in: ["DRAFT", "IN_PROGRESS"] },
      },
      orderBy: { lastOpenedAt: "asc" },
    });

    const minIdleHours = prefs?.draftReminderMinIdleHours ?? 72;
    const maxPerWeek = prefs?.draftReminderMaxPerWeek ?? 1;
    const oneWeekAgo = new Date(now.getTime() - 7 * MS_PER_DAY);

    const results: DraftReminderResult[] = [];

    for (const project of projects) {
      if (!pushEnabled && !emailEnabled) {
        results.push({
          projectId: project.id,
          projectTitle: project.title,
          sent: false,
          reason: "disabled",
        });
        continue;
      }

      const idleMs = now.getTime() - project.lastOpenedAt.getTime();
      if (idleMs < minIdleHours * MS_PER_HOUR) {
        results.push({
          projectId: project.id,
          projectTitle: project.title,
          sent: false,
          reason: "not_idle_enough",
        });
        continue;
      }

      const recentCount = await this.prisma.draftReminder.count({
        where: { projectId: project.id, sentAt: { gte: oneWeekAgo } },
      });
      if (recentCount >= maxPerWeek) {
        results.push({
          projectId: project.id,
          projectTitle: project.title,
          sent: false,
          reason: "rate_limited",
        });
        continue;
      }

      // Respectful copy — no guilt, no urgency, no fake social pressure.
      const payload = {
        title: "Your draft is saved",
        body: `"${project.title}" is saved and ready whenever you'd like to keep going. No rush — there's no deadline here.`,
        url: `/projects/${project.id}`,
        tag: `draft-reminder-${project.id}`,
      };

      let sentSomewhere = false;
      if (pushEnabled) {
        const push = await this.push.sendToUser(userId, payload, now);
        if (push.suppressedByQuietHours) {
          results.push({
            projectId: project.id,
            projectTitle: project.title,
            sent: false,
            reason: "quiet_hours",
          });
          continue;
        }
        if (push.sent > 0) {
          sentSomewhere = true;
          await this.prisma.draftReminder.create({
            data: { projectId: project.id, channel: "PUSH" },
          });
        }
      }
      // Email is wired by the outer application; we only record that we
      // would have delivered and defer to the email transport.
      if (emailEnabled) {
        await this.prisma.draftReminder.create({
          data: { projectId: project.id, channel: "EMAIL" },
        });
        sentSomewhere = true;
      }

      results.push({
        projectId: project.id,
        projectTitle: project.title,
        sent: sentSomewhere,
      });
    }

    return results;
  }
}
