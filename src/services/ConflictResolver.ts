/**
 * ConflictResolver — Detect and resolve CRDT operation conflicts
 *
 * When two editors concurrently modify the same clip, operations that were
 * causally independent (same or overlapping Lamport clock window) may produce
 * inconsistent timeline states. This service:
 *
 *   1. Detects conflicts between a batch of operations
 *   2. Builds human-readable diffs showing "your change" vs "their change"
 *   3. Resolves conflicts via configurable strategies:
 *        LAST_WRITE_WINS  — higher lamportClock wins
 *        FIRST_WRITE_WINS — lower lamportClock wins
 *        MERGE            — field-level merge where possible
 *        USER_CHOICE      — caller supplies the winning operationId
 *   4. Auto-resolves all conflicts with LAST_WRITE_WINS
 */

import type {
  CRDTOperation,
  AddClipPayload,
  MoveClipPayload,
  TrimClipPayload,
  AddEffectPayload,
  SplitClipPayload,
  RemoveClipPayload,
} from "./CRDTTimeline";
import { generateId } from "./CRDTTimeline";

// ── Conflict Types ─────────────────────────────────────────────────────────

export type ConflictType =
  | "CLIP_OVERLAP"
  | "SIMULTANEOUS_TRIM"
  | "SIMULTANEOUS_MOVE"
  | "EFFECT_COLLISION"
  | "DELETE_EDIT";

export type ResolutionStrategy =
  | "LAST_WRITE_WINS"
  | "FIRST_WRITE_WINS"
  | "MERGE"
  | "USER_CHOICE";

// ── Conflict Model ─────────────────────────────────────────────────────────

export interface ConflictResolution {
  strategy: ResolutionStrategy;
  winningOperationId: string;
  resolvedAt: number;
}

export interface Conflict {
  conflictId: string;
  type: ConflictType;
  /** The clip affected by both operations */
  clipId: string;
  operationA: CRDTOperation;
  operationB: CRDTOperation;
  detectedAt: number;
  resolution?: ConflictResolution;
}

// ── Diff Model ─────────────────────────────────────────────────────────────

export interface FieldDiff {
  field: string;
  /** Value produced by operationA (the local / "your" change) */
  valueA: unknown;
  /** Value produced by operationB (the remote / "their" change) */
  valueB: unknown;
  merged?: unknown;
}

export interface ConflictDiff {
  conflictId: string;
  clipId: string;
  conflictType: ConflictType;
  authorA: string;
  authorB: string;
  fields: FieldDiff[];
  /** A short sentence describing the conflict for display in a UI toast */
  summary: string;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

function extractClipId(op: CRDTOperation): string | null {
  const p = op.payload as unknown as Record<string, unknown>;
  if (typeof p.clipId === "string") return p.clipId;
  if (typeof p.leftClipId === "string") return p.leftClipId;
  return null;
}

function getTimeRange(op: CRDTOperation): { start: number; end: number } | null {
  switch (op.type) {
    case "ADD_CLIP": {
      const p = op.payload as AddClipPayload;
      return { start: p.startSec, end: p.startSec + p.durationSec };
    }
    case "MOVE_CLIP": {
      // We don't have duration here, so use a sentinel end
      const p = op.payload as MoveClipPayload;
      return { start: p.newStartSec, end: p.newStartSec };
    }
    case "TRIM_CLIP": {
      const p = op.payload as TrimClipPayload;
      return { start: p.inPointSec, end: p.outPointSec };
    }
    default:
      return null;
  }
}

// ── ConflictResolver Class ─────────────────────────────────────────────────

export class ConflictResolver {
  // ── Core Detection ───────────────────────────────────────────────────────

  /**
   * Scan a list of operations and return all detected conflicts.
   * O(n²) — suitable for typical batch sizes (<1000 ops).
   */
  detectConflicts(ops: CRDTOperation[]): Conflict[] {
    const conflicts: Conflict[] = [];

    for (let i = 0; i < ops.length; i++) {
      for (let j = i + 1; j < ops.length; j++) {
        const a = ops[i];
        const b = ops[j];

        if (!this.isConcurrent(a, b)) continue;

        const conflict = this.checkPair(a, b);
        if (conflict) conflicts.push(conflict);
      }
    }

    return conflicts;
  }

  private checkPair(a: CRDTOperation, b: CRDTOperation): Conflict | null {
    // DELETE + EDIT: one editor removes a clip the other is editing
    if (this.isDeleteEditConflict(a, b)) {
      return this.makeConflict("DELETE_EDIT", a, b);
    }

    if (!this.isSameClip(a, b)) return null;

    // SIMULTANEOUS TRIM
    if (a.type === "TRIM_CLIP" && b.type === "TRIM_CLIP") {
      return this.makeConflict("SIMULTANEOUS_TRIM", a, b);
    }

    // SIMULTANEOUS MOVE
    if (a.type === "MOVE_CLIP" && b.type === "MOVE_CLIP") {
      return this.makeConflict("SIMULTANEOUS_MOVE", a, b);
    }

    // EFFECT COLLISION — same effect type applied to same clip
    if (a.type === "ADD_EFFECT" && b.type === "ADD_EFFECT") {
      const pa = a.payload as AddEffectPayload;
      const pb = b.payload as AddEffectPayload;
      if (pa.effectType === pb.effectType) {
        return this.makeConflict("EFFECT_COLLISION", a, b);
      }
    }

    // CLIP OVERLAP — two ADD_CLIPs on the same track whose time ranges overlap
    if (a.type === "ADD_CLIP" && b.type === "ADD_CLIP") {
      const pa = a.payload as AddClipPayload;
      const pb = b.payload as AddClipPayload;
      if (pa.trackId === pb.trackId && this.isTimeOverlap(a, b)) {
        return this.makeConflict("CLIP_OVERLAP", a, b);
      }
    }

    // MOVE + TRIM are semantically conflicting on the same clip
    if (
      (a.type === "MOVE_CLIP" && b.type === "TRIM_CLIP") ||
      (a.type === "TRIM_CLIP" && b.type === "MOVE_CLIP")
    ) {
      return this.makeConflict("SIMULTANEOUS_MOVE", a, b);
    }

    return null;
  }

  private isDeleteEditConflict(a: CRDTOperation, b: CRDTOperation): boolean {
    const editTypes = new Set<string>(["MOVE_CLIP", "TRIM_CLIP", "ADD_EFFECT", "SPLIT_CLIP"]);
    if (a.type === "REMOVE_CLIP" && editTypes.has(b.type)) {
      const pa = a.payload as RemoveClipPayload;
      const clipIdB = extractClipId(b);
      return pa.clipId === clipIdB;
    }
    if (b.type === "REMOVE_CLIP" && editTypes.has(a.type)) {
      const pb = b.payload as RemoveClipPayload;
      const clipIdA = extractClipId(a);
      return pb.clipId === clipIdA;
    }
    return false;
  }

  private makeConflict(
    type: ConflictType,
    a: CRDTOperation,
    b: CRDTOperation
  ): Conflict {
    const clipId = extractClipId(a) ?? extractClipId(b) ?? "unknown";
    return {
      conflictId: generateId(),
      type,
      clipId,
      operationA: a,
      operationB: b,
      detectedAt: Date.now(),
    };
  }

  // ── Resolution ───────────────────────────────────────────────────────────

  /**
   * Resolve a conflict with the given strategy.
   * For USER_CHOICE, supply `chosenOpId` (must be operationA.operationId or operationB.operationId).
   * Returns the winning CRDTOperation.
   */
  resolveConflict(
    conflict: Conflict,
    strategy: ResolutionStrategy,
    chosenOpId?: string
  ): CRDTOperation {
    let winner: CRDTOperation;

    switch (strategy) {
      case "LAST_WRITE_WINS":
        winner = this.lastWriteWins(conflict);
        break;

      case "FIRST_WRITE_WINS":
        winner = this.firstWriteWins(conflict);
        break;

      case "MERGE":
        winner = this.mergeOps(conflict);
        break;

      case "USER_CHOICE":
        if (!chosenOpId) {
          throw new Error("USER_CHOICE strategy requires chosenOpId.");
        }
        if (chosenOpId === conflict.operationA.operationId) {
          winner = conflict.operationA;
        } else if (chosenOpId === conflict.operationB.operationId) {
          winner = conflict.operationB;
        } else {
          throw new Error(`chosenOpId ${chosenOpId} is not part of this conflict.`);
        }
        break;

      default:
        winner = this.lastWriteWins(conflict);
    }

    // Stamp the resolution on the conflict object in-place for audit
    conflict.resolution = {
      strategy,
      winningOperationId: winner.operationId,
      resolvedAt: Date.now(),
    };

    return winner;
  }

  private lastWriteWins(conflict: Conflict): CRDTOperation {
    const { operationA: a, operationB: b } = conflict;
    if (a.lamportClock !== b.lamportClock) {
      return a.lamportClock > b.lamportClock ? a : b;
    }
    // Tie-break by timestamp, then operationId (deterministic)
    if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? a : b;
    return a.operationId > b.operationId ? a : b;
  }

  private firstWriteWins(conflict: Conflict): CRDTOperation {
    const { operationA: a, operationB: b } = conflict;
    if (a.lamportClock !== b.lamportClock) {
      return a.lamportClock < b.lamportClock ? a : b;
    }
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? a : b;
    return a.operationId < b.operationId ? a : b;
  }

  /**
   * Attempt a field-level merge.
   * Falls back to LAST_WRITE_WINS for types that don't support merge.
   */
  private mergeOps(conflict: Conflict): CRDTOperation {
    const { operationA: a, operationB: b } = conflict;

    if (a.type === "TRIM_CLIP" && b.type === "TRIM_CLIP") {
      const pa = a.payload as TrimClipPayload;
      const pb = b.payload as TrimClipPayload;
      // Merge: take the tightest trim (min in-point, max out-point average approach)
      const base = this.lastWriteWins(conflict);
      const mergedPayload: TrimClipPayload = {
        clipId: pa.clipId,
        inPointSec: Math.max(pa.inPointSec, pb.inPointSec),
        outPointSec: Math.min(pa.outPointSec, pb.outPointSec),
      };
      // Validate merged range makes sense
      if (mergedPayload.outPointSec <= mergedPayload.inPointSec) {
        return base; // Can't merge, fall back
      }
      return {
        ...base,
        operationId: generateId(),
        payload: mergedPayload,
      };
    }

    if (a.type === "ADD_EFFECT" && b.type === "ADD_EFFECT") {
      const pa = a.payload as AddEffectPayload;
      const pb = b.payload as AddEffectPayload;
      // Merge parameters: combine keys, LWW per key
      const lwwBase = this.lastWriteWins(conflict);
      const mergedParams = { ...pb.parameters, ...pa.parameters };
      const mergedPayload: AddEffectPayload = {
        clipId: pa.clipId,
        effectId: lwwBase === a ? pa.effectId : pb.effectId,
        effectType: pa.effectType,
        parameters: mergedParams,
      };
      return { ...lwwBase, operationId: generateId(), payload: mergedPayload };
    }

    // Default: last-write-wins
    return this.lastWriteWins(conflict);
  }

  // ── Diff Builder ──────────────────────────────────────────────────────────

  /**
   * Build a human-readable diff for display in the conflict resolution UI.
   */
  buildDiff(conflict: Conflict): ConflictDiff {
    const { operationA: a, operationB: b } = conflict;
    const fields = this.computeFieldDiffs(a, b);
    const summary = this.buildSummary(conflict);

    return {
      conflictId: conflict.conflictId,
      clipId: conflict.clipId,
      conflictType: conflict.type,
      authorA: a.userId,
      authorB: b.userId,
      fields,
      summary,
    };
  }

  private computeFieldDiffs(a: CRDTOperation, b: CRDTOperation): FieldDiff[] {
    const diffs: FieldDiff[] = [];

    // Shared metadata
    diffs.push({
      field: "lamportClock",
      valueA: a.lamportClock,
      valueB: b.lamportClock,
    });
    diffs.push({
      field: "timestamp",
      valueA: new Date(a.timestamp).toISOString(),
      valueB: new Date(b.timestamp).toISOString(),
    });

    // Operation-specific fields
    if (a.type === "TRIM_CLIP" && b.type === "TRIM_CLIP") {
      const pa = a.payload as TrimClipPayload;
      const pb = b.payload as TrimClipPayload;
      diffs.push({ field: "inPointSec", valueA: pa.inPointSec, valueB: pb.inPointSec });
      diffs.push({ field: "outPointSec", valueA: pa.outPointSec, valueB: pb.outPointSec });
      diffs.push({
        field: "durationSec",
        valueA: +(pa.outPointSec - pa.inPointSec).toFixed(3),
        valueB: +(pb.outPointSec - pb.inPointSec).toFixed(3),
      });
    }

    if (a.type === "MOVE_CLIP" && b.type === "MOVE_CLIP") {
      const pa = a.payload as MoveClipPayload;
      const pb = b.payload as MoveClipPayload;
      diffs.push({ field: "targetTrackId", valueA: pa.targetTrackId, valueB: pb.targetTrackId });
      diffs.push({ field: "newStartSec", valueA: pa.newStartSec, valueB: pb.newStartSec });
    }

    if (a.type === "ADD_EFFECT" && b.type === "ADD_EFFECT") {
      const pa = a.payload as AddEffectPayload;
      const pb = b.payload as AddEffectPayload;
      diffs.push({ field: "effectType", valueA: pa.effectType, valueB: pb.effectType });
      const allKeys = new Set([
        ...Object.keys(pa.parameters),
        ...Object.keys(pb.parameters),
      ]);
      for (const key of allKeys) {
        diffs.push({
          field: `parameters.${key}`,
          valueA: pa.parameters[key],
          valueB: pb.parameters[key],
        });
      }
    }

    if (a.type === "ADD_CLIP" && b.type === "ADD_CLIP") {
      const pa = a.payload as AddClipPayload;
      const pb = b.payload as AddClipPayload;
      diffs.push({ field: "trackId", valueA: pa.trackId, valueB: pb.trackId });
      diffs.push({ field: "startSec", valueA: pa.startSec, valueB: pb.startSec });
      diffs.push({ field: "durationSec", valueA: pa.durationSec, valueB: pb.durationSec });
    }

    if (a.type === "REMOVE_CLIP" || b.type === "REMOVE_CLIP") {
      const deleter = a.type === "REMOVE_CLIP" ? a : b;
      const editor = a.type === "REMOVE_CLIP" ? b : a;
      diffs.push({
        field: "action",
        valueA: deleter === a ? "DELETE" : `EDIT (${editor.type})`,
        valueB: deleter === b ? "DELETE" : `EDIT (${editor.type})`,
      });
    }

    if (a.type === "SPLIT_CLIP") {
      const pa = a.payload as SplitClipPayload;
      diffs.push({ field: "splitAtSec", valueA: pa.splitAtSec, valueB: "(no split)" });
    }

    return diffs;
  }

  private buildSummary(conflict: Conflict): string {
    const { type, operationA: a, operationB: b, clipId } = conflict;
    const shortId = clipId.slice(0, 8);
    switch (type) {
      case "SIMULTANEOUS_TRIM":
        return `${a.userId} and ${b.userId} both trimmed clip ${shortId} at the same time.`;
      case "SIMULTANEOUS_MOVE":
        return `${a.userId} and ${b.userId} both moved clip ${shortId} simultaneously.`;
      case "EFFECT_COLLISION": {
        const p = a.payload as AddEffectPayload;
        return `${a.userId} and ${b.userId} applied conflicting "${p.effectType}" effects to clip ${shortId}.`;
      }
      case "CLIP_OVERLAP":
        return `${a.userId} and ${b.userId} placed clips on the same track with overlapping time ranges.`;
      case "DELETE_EDIT": {
        const isADelete = a.type === "REMOVE_CLIP";
        const deleter = isADelete ? a.userId : b.userId;
        const editor = isADelete ? b.userId : a.userId;
        return `${deleter} deleted clip ${shortId} while ${editor} was editing it.`;
      }
      default:
        return `Concurrent conflict on clip ${shortId} between ${a.userId} and ${b.userId}.`;
    }
  }

  // ── Auto-Resolve ──────────────────────────────────────────────────────────

  /**
   * Auto-resolve all conflicts in `ops` using LAST_WRITE_WINS.
   * Returns a deduplicated, resolved operation list ready to replay.
   */
  autoResolve(ops: CRDTOperation[]): CRDTOperation[] {
    const conflicts = this.detectConflicts(ops);
    const losers = new Set<string>();

    for (const conflict of conflicts) {
      const winner = this.resolveConflict(conflict, "LAST_WRITE_WINS");
      const loser =
        winner.operationId === conflict.operationA.operationId
          ? conflict.operationB
          : conflict.operationA;
      losers.add(loser.operationId);
    }

    // Filter out losing operations and return the survivors
    return ops.filter((op) => !losers.has(op.operationId));
  }

  // ── Predicate Helpers ─────────────────────────────────────────────────────

  /**
   * Two operations are "concurrent" if they have the same Lamport clock value
   * OR if neither causally precedes the other (clock values within a 1-step window).
   */
  isConcurrent(a: CRDTOperation, b: CRDTOperation): boolean {
    return Math.abs(a.lamportClock - b.lamportClock) <= 1 && a.userId !== b.userId;
  }

  /** Returns true if both operations reference the same clipId. */
  isSameClip(a: CRDTOperation, b: CRDTOperation): boolean {
    const idA = extractClipId(a);
    const idB = extractClipId(b);
    return idA !== null && idB !== null && idA === idB;
  }

  /**
   * Returns true if the time ranges implied by two operations overlap.
   * Only applicable for ADD_CLIP and TRIM_CLIP operations.
   */
  isTimeOverlap(a: CRDTOperation, b: CRDTOperation): boolean {
    const rangeA = getTimeRange(a);
    const rangeB = getTimeRange(b);
    if (!rangeA || !rangeB) return false;
    return rangeA.start < rangeB.end && rangeB.start < rangeA.end;
  }

  // ── Batch Analysis ────────────────────────────────────────────────────────

  /**
   * Returns conflict statistics for a set of operations.
   * Useful for analytics dashboards.
   */
  analyzeConflicts(ops: CRDTOperation[]): {
    total: number;
    byType: Record<ConflictType, number>;
    conflictRate: number;
    mostConflictedClips: Array<{ clipId: string; count: number }>;
  } {
    const conflicts = this.detectConflicts(ops);
    const byType: Record<ConflictType, number> = {
      CLIP_OVERLAP: 0,
      SIMULTANEOUS_TRIM: 0,
      SIMULTANEOUS_MOVE: 0,
      EFFECT_COLLISION: 0,
      DELETE_EDIT: 0,
    };
    const clipCounts = new Map<string, number>();

    for (const c of conflicts) {
      byType[c.type]++;
      clipCounts.set(c.clipId, (clipCounts.get(c.clipId) ?? 0) + 1);
    }

    const mostConflictedClips = Array.from(clipCounts.entries())
      .map(([clipId, count]) => ({ clipId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      total: conflicts.length,
      byType,
      conflictRate: ops.length > 0 ? conflicts.length / ops.length : 0,
      mostConflictedClips,
    };
  }
}
