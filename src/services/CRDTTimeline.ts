/**
 * CRDTTimeline — Conflict-free Replicated Data Type for timeline editing operations
 *
 * Implements a operation-based CRDT (Op-CRDT) with:
 *   - Lamport logical clocks for causal ordering
 *   - Deterministic merge: sort by lamportClock, break ties by operationId
 *   - Full operation log for undo/redo and incremental sync
 *   - Per-user undo/redo stacks
 *   - Six operation types: addClip, removeClip, moveClip, trimClip, splitClip, addEffect
 *   - getState() computes the live ClipState/TrackState from the merged log
 */

// ── ID Generation ──────────────────────────────────────────────────────────

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generates a 21-character nanoid-like unique string using Math.random(). */
export function generateId(length = 21): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return result;
}

// ── Types ─────────────────────────────────────────────────────────────────

export type OperationType =
  | "ADD_CLIP"
  | "REMOVE_CLIP"
  | "MOVE_CLIP"
  | "TRIM_CLIP"
  | "SPLIT_CLIP"
  | "ADD_EFFECT";

export interface AddClipPayload {
  clipId: string;
  trackId: string;
  startSec: number;
  durationSec: number;
  sourceUrl: string;
  label?: string;
}

export interface RemoveClipPayload {
  clipId: string;
}

export interface MoveClipPayload {
  clipId: string;
  /** Target track (may be the same track) */
  targetTrackId: string;
  newStartSec: number;
}

export interface TrimClipPayload {
  clipId: string;
  /** New in-point offset from the original source start, in seconds */
  inPointSec: number;
  /** New out-point offset from the original source start, in seconds */
  outPointSec: number;
}

export interface SplitClipPayload {
  clipId: string;
  /** Wall-clock position (seconds) where the split happens */
  splitAtSec: number;
  /** IDs for the two resulting clips */
  leftClipId: string;
  rightClipId: string;
}

export interface AddEffectPayload {
  clipId: string;
  effectId: string;
  effectType: string;
  parameters: Record<string, number | string | boolean>;
}

export type OperationPayload =
  | AddClipPayload
  | RemoveClipPayload
  | MoveClipPayload
  | TrimClipPayload
  | SplitClipPayload
  | AddEffectPayload;

export interface CRDTOperation {
  operationId: string;
  userId: string;
  /** Wall-clock milliseconds at the time the operation was created */
  timestamp: number;
  /** Lamport logical clock value */
  lamportClock: number;
  type: OperationType;
  payload: OperationPayload;
}

// ── State Types ────────────────────────────────────────────────────────────

export interface EffectState {
  effectId: string;
  effectType: string;
  parameters: Record<string, number | string | boolean>;
  appliedAt: number; // lamportClock when applied
}

export interface ClipState {
  clipId: string;
  trackId: string;
  startSec: number;
  durationSec: number;
  inPointSec: number;
  outPointSec: number;
  sourceUrl: string;
  label: string;
  effects: EffectState[];
  /** lamportClock of the last operation that touched this clip */
  lastModifiedClock: number;
  /** userId who last modified this clip */
  lastModifiedBy: string;
  isDeleted: boolean;
}

export interface TrackState {
  trackId: string;
  clips: ClipState[];
}

export interface TimelineState {
  tracks: TrackState[];
  /** Flat map for O(1) clip lookup */
  clipMap: Map<string, ClipState>;
  /** lamportClock of the last applied operation */
  headClock: number;
}

// ── Undo/Redo Stack ────────────────────────────────────────────────────────

interface UndoEntry {
  operation: CRDTOperation;
  /** Inverse operation to roll back the change */
  inverse: CRDTOperation;
}

// ── CRDTTimeline Class ─────────────────────────────────────────────────────

export class CRDTTimeline {
  private log: CRDTOperation[] = [];
  /** Sorted merged log — rebuilt after every merge */
  private sortedLog: CRDTOperation[] = [];
  private lamportClock = 0;

  /** Per-user undo stacks (array of UndoEntry, most-recent last) */
  private undoStacks: Map<string, UndoEntry[]> = new Map();
  /** Per-user redo stacks */
  private redoStacks: Map<string, UndoEntry[]> = new Map();

  /** Cached state — invalidated whenever sortedLog changes */
  private stateCache: TimelineState | null = null;

  // ── Private Helpers ──────────────────────────────────────────────────────

  private advanceClock(remoteClock?: number): number {
    if (remoteClock !== undefined) {
      this.lamportClock = Math.max(this.lamportClock, remoteClock) + 1;
    } else {
      this.lamportClock += 1;
    }
    return this.lamportClock;
  }

  private rebuildSortedLog(): void {
    this.sortedLog = [...this.log].sort((a, b) => {
      if (a.lamportClock !== b.lamportClock) return a.lamportClock - b.lamportClock;
      return a.operationId < b.operationId ? -1 : 1;
    });
    this.stateCache = null;
  }

  private ensureUserStacks(userId: string): void {
    if (!this.undoStacks.has(userId)) this.undoStacks.set(userId, []);
    if (!this.redoStacks.has(userId)) this.redoStacks.set(userId, []);
  }

  private operationAlreadyApplied(operationId: string): boolean {
    return this.log.some((op) => op.operationId === operationId);
  }

  /** Build the inverse (undo) operation for a forward operation, given current state. */
  private buildInverse(op: CRDTOperation, state: TimelineState): CRDTOperation | null {
    const clock = this.advanceClock();

    switch (op.type) {
      case "ADD_CLIP": {
        const payload = op.payload as AddClipPayload;
        const inverse: CRDTOperation = {
          operationId: generateId(),
          userId: op.userId,
          timestamp: Date.now(),
          lamportClock: clock,
          type: "REMOVE_CLIP",
          payload: { clipId: payload.clipId } satisfies RemoveClipPayload,
        };
        return inverse;
      }

      case "REMOVE_CLIP": {
        const payload = op.payload as RemoveClipPayload;
        const clip = state.clipMap.get(payload.clipId);
        if (!clip) return null;
        const inverse: CRDTOperation = {
          operationId: generateId(),
          userId: op.userId,
          timestamp: Date.now(),
          lamportClock: clock,
          type: "ADD_CLIP",
          payload: {
            clipId: clip.clipId,
            trackId: clip.trackId,
            startSec: clip.startSec,
            durationSec: clip.durationSec,
            sourceUrl: clip.sourceUrl,
            label: clip.label,
          } satisfies AddClipPayload,
        };
        return inverse;
      }

      case "MOVE_CLIP": {
        const payload = op.payload as MoveClipPayload;
        const clip = state.clipMap.get(payload.clipId);
        if (!clip) return null;
        const inverse: CRDTOperation = {
          operationId: generateId(),
          userId: op.userId,
          timestamp: Date.now(),
          lamportClock: clock,
          type: "MOVE_CLIP",
          payload: {
            clipId: payload.clipId,
            targetTrackId: clip.trackId,
            newStartSec: clip.startSec,
          } satisfies MoveClipPayload,
        };
        return inverse;
      }

      case "TRIM_CLIP": {
        const payload = op.payload as TrimClipPayload;
        const clip = state.clipMap.get(payload.clipId);
        if (!clip) return null;
        const inverse: CRDTOperation = {
          operationId: generateId(),
          userId: op.userId,
          timestamp: Date.now(),
          lamportClock: clock,
          type: "TRIM_CLIP",
          payload: {
            clipId: payload.clipId,
            inPointSec: clip.inPointSec,
            outPointSec: clip.outPointSec,
          } satisfies TrimClipPayload,
        };
        return inverse;
      }

      case "SPLIT_CLIP": {
        const payload = op.payload as SplitClipPayload;
        const leftClip = state.clipMap.get(payload.leftClipId);
        const rightClip = state.clipMap.get(payload.rightClipId);
        if (!leftClip || !rightClip) return null;
        // Undo: remove both halves, restore the original clip
        const inverse: CRDTOperation = {
          operationId: generateId(),
          userId: op.userId,
          timestamp: Date.now(),
          lamportClock: clock,
          type: "ADD_CLIP",
          payload: {
            clipId: payload.clipId,
            trackId: leftClip.trackId,
            startSec: leftClip.startSec,
            durationSec: leftClip.durationSec + rightClip.durationSec,
            sourceUrl: leftClip.sourceUrl,
            label: leftClip.label,
          } satisfies AddClipPayload,
        };
        return inverse;
      }

      case "ADD_EFFECT": {
        const payload = op.payload as AddEffectPayload;
        // Undo effect by marking clip as modified without that effect
        // Represented as a REMOVE of the effect via a special ADD_EFFECT with empty params
        const inverse: CRDTOperation = {
          operationId: generateId(),
          userId: op.userId,
          timestamp: Date.now(),
          lamportClock: clock,
          type: "ADD_EFFECT",
          payload: {
            clipId: payload.clipId,
            effectId: payload.effectId,
            effectType: "__REMOVED__",
            parameters: {},
          } satisfies AddEffectPayload,
        };
        return inverse;
      }

      default:
        return null;
    }
  }

  // ── Core Mutation ────────────────────────────────────────────────────────

  /**
   * Apply a single operation to this timeline.
   * If `recordUndo` is true (default), pushes an undo entry for the operation's user.
   */
  applyOperation(op: CRDTOperation, recordUndo = true): void {
    if (this.operationAlreadyApplied(op.operationId)) return;

    // Advance our Lamport clock to maintain causality
    this.advanceClock(op.lamportClock);

    if (recordUndo) {
      const currentState = this.getState();
      const inverse = this.buildInverse(op, currentState);
      if (inverse) {
        this.ensureUserStacks(op.userId);
        this.undoStacks.get(op.userId)!.push({ operation: op, inverse });
        // Applying a new operation clears the redo stack for this user
        this.redoStacks.get(op.userId)!.length = 0;
      }
    }

    this.log.push(op);
    this.rebuildSortedLog();
  }

  /**
   * Receive a batch of remote operations and merge them into the local log.
   * Duplicate operations are silently ignored.
   */
  mergeWith(ops: CRDTOperation[]): void {
    let changed = false;
    for (const op of ops) {
      if (!this.operationAlreadyApplied(op.operationId)) {
        this.advanceClock(op.lamportClock);
        this.log.push(op);
        changed = true;
      }
    }
    if (changed) this.rebuildSortedLog();
  }

  // ── State Computation ────────────────────────────────────────────────────

  /**
   * Re-compute the full TimelineState by replaying the sorted operation log.
   * Result is cached until the log changes.
   */
  getState(): TimelineState {
    if (this.stateCache) return this.stateCache;

    const clipMap = new Map<string, ClipState>();
    let headClock = 0;

    for (const op of this.sortedLog) {
      headClock = Math.max(headClock, op.lamportClock);

      switch (op.type) {
        case "ADD_CLIP": {
          const p = op.payload as AddClipPayload;
          const existing = clipMap.get(p.clipId);
          // Only add if not already present, or if this op supersedes (higher clock)
          if (!existing || op.lamportClock > existing.lastModifiedClock) {
            clipMap.set(p.clipId, {
              clipId: p.clipId,
              trackId: p.trackId,
              startSec: p.startSec,
              durationSec: p.durationSec,
              inPointSec: 0,
              outPointSec: p.durationSec,
              sourceUrl: p.sourceUrl,
              label: p.label ?? p.clipId,
              effects: existing?.effects ?? [],
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
              isDeleted: false,
            });
          }
          break;
        }

        case "REMOVE_CLIP": {
          const p = op.payload as RemoveClipPayload;
          const clip = clipMap.get(p.clipId);
          if (clip) {
            clipMap.set(p.clipId, {
              ...clip,
              isDeleted: true,
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
            });
          }
          break;
        }

        case "MOVE_CLIP": {
          const p = op.payload as MoveClipPayload;
          const clip = clipMap.get(p.clipId);
          if (clip && !clip.isDeleted) {
            clipMap.set(p.clipId, {
              ...clip,
              trackId: p.targetTrackId,
              startSec: p.newStartSec,
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
            });
          }
          break;
        }

        case "TRIM_CLIP": {
          const p = op.payload as TrimClipPayload;
          const clip = clipMap.get(p.clipId);
          if (clip && !clip.isDeleted) {
            const newDuration = p.outPointSec - p.inPointSec;
            clipMap.set(p.clipId, {
              ...clip,
              inPointSec: p.inPointSec,
              outPointSec: p.outPointSec,
              durationSec: newDuration,
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
            });
          }
          break;
        }

        case "SPLIT_CLIP": {
          const p = op.payload as SplitClipPayload;
          const original = clipMap.get(p.clipId);
          if (original && !original.isDeleted) {
            const leftDuration = p.splitAtSec - original.startSec;
            const rightDuration = original.durationSec - leftDuration;

            // Mark original as deleted
            clipMap.set(p.clipId, {
              ...original,
              isDeleted: true,
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
            });

            // Left half
            clipMap.set(p.leftClipId, {
              clipId: p.leftClipId,
              trackId: original.trackId,
              startSec: original.startSec,
              durationSec: leftDuration,
              inPointSec: original.inPointSec,
              outPointSec: original.inPointSec + leftDuration,
              sourceUrl: original.sourceUrl,
              label: `${original.label} (A)`,
              effects: [...original.effects],
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
              isDeleted: false,
            });

            // Right half
            clipMap.set(p.rightClipId, {
              clipId: p.rightClipId,
              trackId: original.trackId,
              startSec: p.splitAtSec,
              durationSec: rightDuration,
              inPointSec: original.inPointSec + leftDuration,
              outPointSec: original.outPointSec,
              sourceUrl: original.sourceUrl,
              label: `${original.label} (B)`,
              effects: [...original.effects],
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
              isDeleted: false,
            });
          }
          break;
        }

        case "ADD_EFFECT": {
          const p = op.payload as AddEffectPayload;
          const clip = clipMap.get(p.clipId);
          if (clip && !clip.isDeleted) {
            const effects = clip.effects.filter((e) => e.effectId !== p.effectId);
            if (p.effectType !== "__REMOVED__") {
              effects.push({
                effectId: p.effectId,
                effectType: p.effectType,
                parameters: p.parameters,
                appliedAt: op.lamportClock,
              });
            }
            clipMap.set(p.clipId, {
              ...clip,
              effects,
              lastModifiedClock: op.lamportClock,
              lastModifiedBy: op.userId,
            });
          }
          break;
        }
      }
    }

    // Build track groupings from the live (non-deleted) clips
    const trackMap = new Map<string, TrackState>();
    for (const clip of clipMap.values()) {
      if (clip.isDeleted) continue;
      if (!trackMap.has(clip.trackId)) {
        trackMap.set(clip.trackId, { trackId: clip.trackId, clips: [] });
      }
      trackMap.get(clip.trackId)!.clips.push(clip);
    }

    // Sort clips within each track by startSec
    for (const track of trackMap.values()) {
      track.clips.sort((a, b) => a.startSec - b.startSec);
    }

    this.stateCache = {
      tracks: Array.from(trackMap.values()),
      clipMap,
      headClock,
    };

    return this.stateCache;
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────

  /**
   * Undo the most recent operation for `userId`.
   * Returns the inverse operation that was applied, or null if stack is empty.
   */
  undo(userId: string): CRDTOperation | null {
    this.ensureUserStacks(userId);
    const stack = this.undoStacks.get(userId)!;
    const entry = stack.pop();
    if (!entry) return null;

    // Apply the inverse without recording another undo entry
    this.applyOperation(entry.inverse, false);

    // Push to redo stack
    this.redoStacks.get(userId)!.push(entry);

    return entry.inverse;
  }

  /**
   * Redo the most recently undone operation for `userId`.
   * Returns the re-applied operation, or null if redo stack is empty.
   */
  redo(userId: string): CRDTOperation | null {
    this.ensureUserStacks(userId);
    const stack = this.redoStacks.get(userId)!;
    const entry = stack.pop();
    if (!entry) return null;

    // Re-apply the original operation without recording undo
    this.applyOperation(entry.operation, false);

    // Push back to undo stack
    this.undoStacks.get(userId)!.push(entry);

    return entry.operation;
  }

  // ── Sync Helpers ──────────────────────────────────────────────────────────

  /**
   * Returns all operations with lamportClock > `afterClock`.
   * Useful for incremental sync: pass the remote peer's last-known clock.
   */
  getOperationsAfter(afterClock: number): CRDTOperation[] {
    return this.sortedLog.filter((op) => op.lamportClock > afterClock);
  }

  /** Returns a snapshot of the full sorted operation log. */
  getFullLog(): CRDTOperation[] {
    return [...this.sortedLog];
  }

  /** Current Lamport clock value. */
  getCurrentClock(): number {
    return this.lamportClock;
  }

  // ── Operation Factory Helpers ─────────────────────────────────────────────

  /**
   * Build a pre-stamped ADD_CLIP operation for this timeline's current clock.
   */
  createAddClip(
    userId: string,
    payload: Omit<AddClipPayload, "clipId"> & { clipId?: string }
  ): CRDTOperation {
    const clock = this.advanceClock();
    return {
      operationId: generateId(),
      userId,
      timestamp: Date.now(),
      lamportClock: clock,
      type: "ADD_CLIP",
      payload: {
        clipId: payload.clipId ?? generateId(),
        trackId: payload.trackId,
        startSec: payload.startSec,
        durationSec: payload.durationSec,
        sourceUrl: payload.sourceUrl,
        label: payload.label,
      },
    };
  }

  createRemoveClip(userId: string, clipId: string): CRDTOperation {
    const clock = this.advanceClock();
    return {
      operationId: generateId(),
      userId,
      timestamp: Date.now(),
      lamportClock: clock,
      type: "REMOVE_CLIP",
      payload: { clipId },
    };
  }

  createMoveClip(
    userId: string,
    clipId: string,
    targetTrackId: string,
    newStartSec: number
  ): CRDTOperation {
    const clock = this.advanceClock();
    return {
      operationId: generateId(),
      userId,
      timestamp: Date.now(),
      lamportClock: clock,
      type: "MOVE_CLIP",
      payload: { clipId, targetTrackId, newStartSec },
    };
  }

  createTrimClip(
    userId: string,
    clipId: string,
    inPointSec: number,
    outPointSec: number
  ): CRDTOperation {
    const clock = this.advanceClock();
    return {
      operationId: generateId(),
      userId,
      timestamp: Date.now(),
      lamportClock: clock,
      type: "TRIM_CLIP",
      payload: { clipId, inPointSec, outPointSec },
    };
  }

  createSplitClip(
    userId: string,
    clipId: string,
    splitAtSec: number
  ): CRDTOperation {
    const clock = this.advanceClock();
    return {
      operationId: generateId(),
      userId,
      timestamp: Date.now(),
      lamportClock: clock,
      type: "SPLIT_CLIP",
      payload: {
        clipId,
        splitAtSec,
        leftClipId: generateId(),
        rightClipId: generateId(),
      },
    };
  }

  createAddEffect(
    userId: string,
    clipId: string,
    effectType: string,
    parameters: Record<string, number | string | boolean>
  ): CRDTOperation {
    const clock = this.advanceClock();
    return {
      operationId: generateId(),
      userId,
      timestamp: Date.now(),
      lamportClock: clock,
      type: "ADD_EFFECT",
      payload: {
        clipId,
        effectId: generateId(),
        effectType,
        parameters,
      },
    };
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  /** Returns per-user operation counts for debugging/analytics. */
  getOperationStats(): Record<string, { total: number; byType: Record<OperationType, number> }> {
    const stats: Record<string, { total: number; byType: Record<OperationType, number> }> = {};
    for (const op of this.sortedLog) {
      if (!stats[op.userId]) {
        stats[op.userId] = {
          total: 0,
          byType: {
            ADD_CLIP: 0,
            REMOVE_CLIP: 0,
            MOVE_CLIP: 0,
            TRIM_CLIP: 0,
            SPLIT_CLIP: 0,
            ADD_EFFECT: 0,
          },
        };
      }
      stats[op.userId].total++;
      stats[op.userId].byType[op.type]++;
    }
    return stats;
  }

  /** Verify the timeline has no overlapping clips on any track. */
  validateNoOverlaps(): { valid: boolean; conflicts: Array<[string, string]> } {
    const state = this.getState();
    const conflicts: Array<[string, string]> = [];
    for (const track of state.tracks) {
      const clips = [...track.clips].sort((a, b) => a.startSec - b.startSec);
      for (let i = 0; i < clips.length - 1; i++) {
        const a = clips[i];
        const b = clips[i + 1];
        const aEnd = a.startSec + a.durationSec;
        if (aEnd > b.startSec + 0.001) {
          conflicts.push([a.clipId, b.clipId]);
        }
      }
    }
    return { valid: conflicts.length === 0, conflicts };
  }
}
