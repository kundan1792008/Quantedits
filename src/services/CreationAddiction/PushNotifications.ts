/**
 * Push Notification Service
 * ─────────────────────────
 *
 * A thin, runtime-adaptive wrapper around the available push notification
 * delivery channels.  The service prefers, in order:
 *
 *   1. The Capacitor LocalNotifications plugin (when running inside the
 *      Quantedits iOS / Android native shell).
 *   2. The Web Notifications API (when running in a desktop browser or PWA).
 *   3. An in-memory fallback queue that allows the React UI to render
 *      toast-style notifications when neither native nor web permission is
 *      granted.
 *
 * The service is deliberately UI-agnostic: it simply dispatches notification
 * payloads to any registered listener.  React components subscribe through
 * {@link useCreationAddiction} to render in-app banners, toasts, and
 * modal popovers.
 *
 * All scheduling is handled client-side with `setTimeout` so that anxiety
 * pings (see {@link ./DraftAnxiety}) and template FOMO pings
 * (see {@link ./TemplateFOMO}) fire at the right moments without requiring
 * any server push infrastructure.
 */

import { Capacitor } from "@capacitor/core";

// ── Types ────────────────────────────────────────────────────────────────

/** Severity / visual treatment applied to a notification in the UI layer. */
export type NotificationTone =
  | "info"
  | "success"
  | "warning"
  | "anxiety"
  | "fomo"
  | "streak";

/**
 * Fully-resolved notification payload.  The `id` is used for dedupe, the
 * `groupKey` allows the UI to collapse a stream of related pings (e.g.
 * successive suggestion toasts) into a single stack.
 */
export interface CreationNotification {
  id: string;
  title: string;
  body: string;
  tone: NotificationTone;
  groupKey?: string;
  /** UNIX ms — when the notification was produced. */
  createdAt: number;
  /** Optional click-through action identifier. */
  actionId?: string;
  /** Optional payload forwarded back to the click handler. */
  payload?: Record<string, unknown>;
  /** How long the UI should display an in-app toast, in ms. */
  durationMs?: number;
}

/** Listener signature for in-app notification events. */
export type NotificationListener = (notification: CreationNotification) => void;

/** Options accepted by {@link PushNotificationService.schedule}. */
export interface ScheduleOptions {
  /** Absolute delay before the notification is fired, in ms. */
  delayMs: number;
  /** Allow the notification to be cancelled by id before firing. */
  cancellable?: boolean;
}

// ── Permission handling ──────────────────────────────────────────────────

/**
 * Thin wrapper around the permission state so we can unit-test without
 * touching the real Notification API.
 */
interface PermissionAdapter {
  query(): "granted" | "denied" | "default" | "unsupported";
  request(): Promise<"granted" | "denied">;
}

function buildBrowserAdapter(): PermissionAdapter {
  return {
    query() {
      if (typeof window === "undefined") return "unsupported";
      if (typeof Notification === "undefined") return "unsupported";
      return Notification.permission;
    },
    async request() {
      if (typeof Notification === "undefined") return "denied";
      const result = await Notification.requestPermission();
      return result === "granted" ? "granted" : "denied";
    },
  };
}

// ── Service implementation ───────────────────────────────────────────────

/**
 * Global push notification service.  The class is exported for typing
 * purposes but consumers should import the `pushNotificationService`
 * singleton instance at the bottom of this file.
 */
export class PushNotificationService {
  private listeners = new Set<NotificationListener>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private history: CreationNotification[] = [];
  private permission: PermissionAdapter;
  private maxHistory = 250;

  constructor(permission: PermissionAdapter = buildBrowserAdapter()) {
    this.permission = permission;
  }

  /**
   * Request permission from the underlying platform.  Returns `true` if
   * permission was granted (or implicitly granted, as on native).
   */
  async requestPermission(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
      // Native LocalNotifications are implicitly permitted for this app.
      return true;
    }
    const current = this.permission.query();
    if (current === "granted") return true;
    if (current === "unsupported") return false;
    const result = await this.permission.request();
    return result === "granted";
  }

  /**
   * Subscribe to every fired notification.  Returns an unsubscribe function.
   */
  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fire a notification immediately.  The payload is dispatched to every
   * subscribed listener and, where possible, mirrored to the platform's
   * native notification channel.
   */
  fire(notification: CreationNotification): void {
    this.history.push(notification);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (err) {
        // Never let one broken listener break the rest.
        console.error("[push] listener threw", err);
      }
    }
    this.mirrorToPlatform(notification);
  }

  /**
   * Schedule a notification to be fired after `delayMs`.  If another
   * notification with the same `id` is already pending, it is replaced.
   */
  schedule(
    notification: CreationNotification,
    options: ScheduleOptions,
  ): void {
    this.cancel(notification.id);
    const timer = setTimeout(() => {
      this.pending.delete(notification.id);
      this.fire(notification);
    }, Math.max(0, options.delayMs));
    this.pending.set(notification.id, timer);
  }

  /** Cancel a previously scheduled notification by id. */
  cancel(id: string): void {
    const existing = this.pending.get(id);
    if (existing) {
      clearTimeout(existing);
      this.pending.delete(id);
    }
  }

  /** Cancel everything pending (used on sign-out / teardown). */
  cancelAll(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  /** Return a shallow copy of the most-recent N notifications. */
  recent(limit = 25): CreationNotification[] {
    return this.history.slice(-limit).reverse();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private mirrorToPlatform(notification: CreationNotification): void {
    if (Capacitor.isNativePlatform()) {
      // Native path — handled via a Capacitor plugin in the mobile shell.
      // We detect the plugin at runtime to keep this file framework-agnostic.
      const plugin = (
        globalThis as unknown as {
          CapacitorLocalNotifications?: {
            schedule: (opts: unknown) => void;
          };
        }
      ).CapacitorLocalNotifications;
      if (plugin && typeof plugin.schedule === "function") {
        plugin.schedule({
          notifications: [
            {
              id: hashId(notification.id),
              title: notification.title,
              body: notification.body,
              extra: notification.payload ?? {},
            },
          ],
        });
      }
      return;
    }

    if (typeof window === "undefined") return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      const n = new Notification(notification.title, {
        body: notification.body,
        tag: notification.groupKey ?? notification.id,
      });
      if (notification.durationMs) {
        setTimeout(() => n.close(), notification.durationMs);
      }
    } catch (err) {
      // Some browsers throw if Notification is created outside of a user
      // gesture — we silently fall back to the in-app listener path.
      console.warn("[push] native notification failed", err);
    }
  }
}

/** Stable 32-bit hash used to derive numeric ids for native platforms. */
function hashId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

// ── Singleton ────────────────────────────────────────────────────────────

export const pushNotificationService = new PushNotificationService();
