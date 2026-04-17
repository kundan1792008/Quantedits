/**
 * MemoryManager – Render Budget Enforcer
 *
 * Enforces the 1.5 GB RAM ceiling required to prevent OS termination during
 * generative video rendering on mobile devices.
 *
 * Responsibilities
 * ────────────────
 * 1. Poll device memory via the NPUEngine plugin every `pollIntervalMs`.
 * 2. Forward OS-level `memoryPressureChanged` events from the plugin.
 * 3. Emit typed pressure-change notifications to subscribers.
 * 4. Expose `assertBudget()` / `checkBudget()` guards that pipeline stages
 *    call before allocating large buffers.
 * 5. Track named allocations so callers can release them on pressure events.
 */

import { NPUEngine } from "@/plugins/npu-engine";
import type { MemoryStats, MemoryPressureLevel } from "@/plugins/npu-engine/definitions";

// ── Budget constant ────────────────────────────────────────────────────────

/** Hard render-budget ceiling: 1.5 GB in bytes. */
export const RENDER_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024; // 1,610,612,736

// ── Types ──────────────────────────────────────────────────────────────────

export type PressureHandler = (stats: MemoryStats) => void;

export interface AllocationRecord {
  name: string;
  sizeBytes: number;
  allocatedAt: number;
}

// ── Manager ────────────────────────────────────────────────────────────────

class MemoryManager {
  private _lastStats: MemoryStats | null = null;
  private listeners: PressureHandler[] = [];
  private allocations = new Map<string, AllocationRecord>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pluginListener: { remove: () => void } | null = null;
  private readonly pollIntervalMs = 5_000;

  // ── Public accessors ─────────────────────────────────────────────────────

  /** The most-recently polled MemoryStats (null until first poll). */
  get lastStats(): MemoryStats | null {
    return this._lastStats;
  }

  /** Total bytes currently tracked via `trackAllocation`. */
  get trackedBytes(): number {
    let sum = 0;
    for (const rec of this.allocations.values()) sum += rec.sizeBytes;
    return sum;
  }

  /** Bytes remaining before the 1.5 GB budget is exhausted. */
  get budgetRemainingBytes(): number {
    const used = this._lastStats?.usedBytes ?? this.trackedBytes;
    return Math.max(0, RENDER_BUDGET_BYTES - used);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start periodic polling and subscribe to native pressure events.
   * Safe to call multiple times — idempotent.
   */
  async start(): Promise<void> {
    if (this.pollTimer !== null) return;

    // Immediate first poll
    await this.poll();

    // Periodic polling
    this.pollTimer = setInterval(() => {
      this.poll().catch(console.error);
    }, this.pollIntervalMs);

    // Subscribe to native memory-pressure events from the NPUEngine plugin
    try {
      this.pluginListener = await NPUEngine.addListener(
        "memoryPressureChanged",
        (stats: MemoryStats) => {
          const prev = this._lastStats?.pressureLevel;
          this._lastStats = stats;
          if (stats.pressureLevel !== prev) {
            this.notifyListeners(stats);
          }
        },
      );
    } catch {
      // Plugin may not be available on web – polling is sufficient
    }
  }

  /** Stop polling and remove native listeners. */
  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pluginListener?.remove();
    this.pluginListener = null;
  }

  // ── Budget Guards ─────────────────────────────────────────────────────────

  /**
   * Returns true if `requiredBytes` can be allocated without exceeding the
   * 1.5 GB budget.
   */
  checkBudget(requiredBytes: number): boolean {
    return requiredBytes <= this.budgetRemainingBytes;
  }

  /**
   * Throws if `requiredBytes` would push usage over the render budget.
   *
   * @throws {Error} with a descriptive message if the budget would be exceeded.
   */
  assertBudget(requiredBytes: number, label = "allocation"): void {
    if (!this.checkBudget(requiredBytes)) {
      const needed = (requiredBytes / 1e6).toFixed(1);
      const avail  = (this.budgetRemainingBytes / 1e6).toFixed(1);
      throw new Error(
        `[MemoryManager] Render budget exceeded: ${label} requires ${needed} MB ` +
          `but only ${avail} MB remains within the 1.5 GB budget.`,
      );
    }
  }

  // ── Allocation Tracking ──────────────────────────────────────────────────

  /**
   * Register a named allocation so the budget accounting stays accurate.
   * Overrides an existing record with the same name.
   */
  trackAllocation(name: string, sizeBytes: number): void {
    this.allocations.set(name, {
      name,
      sizeBytes,
      allocatedAt: Date.now(),
    });
  }

  /** Release a named allocation from the tracking map. */
  releaseAllocation(name: string): void {
    this.allocations.delete(name);
  }

  /** List all currently tracked allocations. */
  listAllocations(): AllocationRecord[] {
    return Array.from(this.allocations.values());
  }

  // ── Subscription ─────────────────────────────────────────────────────────

  /**
   * Subscribe to memory-pressure change events.
   * The callback is called whenever the pressure level changes OR when
   * usage crosses the 1.5 GB budget boundary.
   *
   * @returns Unsubscribe function.
   */
  onPressureChange(handler: PressureHandler): () => void {
    this.listeners.push(handler);
    // Immediately emit current stats if available
    if (this._lastStats) handler(this._lastStats);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== handler);
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const stats = await NPUEngine.getMemoryStats();
      const prevLevel = this._lastStats?.pressureLevel;
      this._lastStats = stats;

      // Emit whenever the pressure level changes
      if (stats.pressureLevel !== prevLevel) {
        this.notifyListeners(stats);
      }

      // Also emit if usage just crossed the 1.5 GB boundary
      if (stats.usedBytes > RENDER_BUDGET_BYTES) {
        this.notifyListeners({ ...stats, pressureLevel: "critical" as MemoryPressureLevel });
      }
    } catch {
      // NPU plugin unavailable on web — use performance.memory if present
      const mem = (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      if (!mem) return;
      const stats: MemoryStats = {
        totalBytes:     mem.jsHeapSizeLimit,
        usedBytes:      mem.usedJSHeapSize,
        availableBytes: mem.jsHeapSizeLimit - mem.usedJSHeapSize,
        npuModelBytes:  0,
        pressureLevel:  mem.usedJSHeapSize / mem.jsHeapSizeLimit > 0.9 ? "critical" : "nominal",
      };
      this._lastStats = stats;
    }
  }

  private notifyListeners(stats: MemoryStats): void {
    for (const handler of this.listeners) {
      try {
        handler(stats);
      } catch (err) {
        console.error("[MemoryManager] Pressure handler threw:", err);
      }
    }
  }
}

/** Singleton MemoryManager instance used across the app. */
export const memoryManager = new MemoryManager();
