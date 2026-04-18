/**
 * Push Dispatcher — Web Push subscription management + dispatch.
 *
 * Safety contract:
 *  - Subscribers are stored per-device and revocable individually.
 *  - Every dispatch checks `UserPreferences` quiet hours before sending.
 *  - The dispatcher is a thin abstraction so the owning application can
 *    plug in a real Web Push library (e.g. `web-push`) in one place.
 *    We intentionally do not hard-code a third-party dependency here.
 */

import type { PrismaClient } from "@/generated/prisma/client";

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

/**
 * Callback that actually posts the encrypted payload to the push service.
 * Keep this injectable so tests can stub it without hitting the network.
 */
export type PushTransport = (
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  },
  payload: PushPayload,
) => Promise<{ statusCode: number }>;

/**
 * Default transport — intentionally a no-op stub. Production deployments
 * should inject a real `web-push`-backed transport at wiring time.
 */
export const noopTransport: PushTransport = async () => ({ statusCode: 204 });

export class PushDispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly transport: PushTransport = noopTransport,
  ) {}

  async subscribe(userId: string, input: PushSubscriptionInput): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      update: {
        userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
        revokedAt: null,
      },
      create: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.updateMany({
      where: { endpoint, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Check whether the current time falls within the user's quiet hours.
   * Quiet-hours windows can wrap over midnight (e.g. 22:00–08:00).
   */
  private static isQuietHour(
    nowHour: number,
    start: number,
    end: number,
  ): boolean {
    if (start === end) return false;
    if (start < end) return nowHour >= start && nowHour < end;
    // Wraps midnight
    return nowHour >= start || nowHour < end;
  }

  /**
   * Hour-of-day for `when` in the user's timezone (if valid) else UTC.
   * Uses Intl.DateTimeFormat so we don't depend on an external tz library.
   */
  static hourInTimezone(when: Date, timezone: string): number {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: timezone,
      });
      const parts = fmt.formatToParts(when);
      const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
      const hour = parseInt(hourPart, 10);
      if (Number.isFinite(hour) && hour >= 0 && hour < 24) return hour;
    } catch {
      // Fall through to UTC
    }
    return when.getUTCHours();
  }

  /**
   * Send a payload to every active subscription for `userId`, unless quiet
   * hours suppress it. Returns the number of subscriptions actually sent to.
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    when: Date = new Date(),
  ): Promise<{ sent: number; suppressedByQuietHours: boolean }> {
    const prefs = await this.prisma.userPreferences.findUnique({
      where: { userId },
    });
    if (prefs) {
      const hour = PushDispatcher.hourInTimezone(when, prefs.timezone);
      if (
        PushDispatcher.isQuietHour(hour, prefs.quietHoursStart, prefs.quietHoursEnd)
      ) {
        return { sent: 0, suppressedByQuietHours: true };
      }
    }

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId, revokedAt: null },
    });

    let sent = 0;
    for (const sub of subs) {
      try {
        const res = await this.transport(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        if (res.statusCode === 410 || res.statusCode === 404) {
          // Gone — the device revoked it on the client.
          await this.prisma.pushSubscription.update({
            where: { id: sub.id },
            data: { revokedAt: new Date() },
          });
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          sent++;
        }
      } catch {
        // Swallow per-subscription errors; never fail the whole batch.
      }
    }
    return { sent, suppressedByQuietHours: false };
  }
}
