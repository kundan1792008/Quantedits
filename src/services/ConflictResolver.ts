/**
 * ConflictResolver — detects and arbitrates conflicts between concurrent
 * edits authored by different collaborators. Works on top of the CRDT
 * timeline: the CRDT already guarantees convergence, but users often want
 * a choice when two peers' intentions differ (e.g. two trims on the same
 * clip). This module surfaces those situations to the UI.
 *
 * Resolution strategies
 * ---------------------
 *   • LAST_WRITE_WINS   — higher lamport wins, automatic.
 *   • AUTO_MERGE        — non-overlapping attribute changes merge safely.
 *   • PROMPT_USER       — both sides preserved; UI picks a winner.
 *   • PREFER_LOCAL      — bias toward the local user's op.
 *   • PREFER_REMOTE     — bias toward the other user's op.
 *
 * The resolver is pure: callers inspect the returned `ConflictDecision`
 * and then apply the chosen op(s) via the CRDT timeline.
 */

import {
  ClipId,
  Clip,
  CRDTTimeline,
  TimelineOperation,
  UserId,
  operationTarget,
  opsConflict,
} from "./CRDTTimeline";

// ── Types ─────────────────────────────────────────────────────────────────

export type ConflictStrategy =
  | "LAST_WRITE_WINS"
  | "AUTO_MERGE"
  | "PROMPT_USER"
  | "PREFER_LOCAL"
  | "PREFER_REMOTE";

export type ConflictKind =
  | "CONCURRENT_TRIM"
  | "CONCURRENT_MOVE"
  | "TRIM_VS_MOVE"
  | "EDIT_VS_DELETE"
  | "CONCURRENT_EFFECT"
  | "CONCURRENT_SPLIT"
  | "LOCK_CONTENTION";

export interface ConflictDescriptor {
  conflictId: string;
  kind: ConflictKind;
  clipId: ClipId;
  /** The ops that clash. Exactly two in most cases. */
  ops: TimelineOperation[];
  /** Human-readable label, e.g. "Your trim vs Sam's trim". */
  label: string;
  /** Time (ms since epoch) the conflict was detected. */
  detectedAt: number;
  /** If we already chose a winner (auto-resolution), it's named here. */
  autoResolvedWinner?: UserId;
}

export interface ConflictDiffRow {
  /** Attribute name (e.g. "start", "duration"). */
  attribute: string;
  before: string;
  after: string;
}

export interface ConflictDiff {
  /** One "side" per participating op. */
  sides: Array<{
    userId: UserId;
    displayLabel: string;
    rows: ConflictDiffRow[];
  }>;
  summary: string;
}

export interface ConflictDecision {
  conflictId: string;
  strategy: ConflictStrategy;
  winnerOp: TimelineOperation | null;
  loserOps: TimelineOperation[];
  merged?: TimelineOperation;
  explanation: string;
}

export interface ConflictResolverOptions {
  /** Global fallback strategy. Default: LAST_WRITE_WINS. */
  defaultStrategy?: ConflictStrategy;
  /** Local user id — used for PREFER_LOCAL / PREFER_REMOTE biases. */
  localUserId: UserId;
  /** Display name lookup. */
  displayName?: (userId: UserId) => string;
}

export type ConflictListener = (e: ConflictEvent) => void;

export type ConflictEventKind =
  | "CONFLICT_DETECTED"
  | "CONFLICT_RESOLVED"
  | "CONFLICT_DISMISSED";

export interface ConflictEvent {
  kind: ConflictEventKind;
  conflict: ConflictDescriptor;
  decision?: ConflictDecision;
}

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Stateful resolver: tracks pending (UI-surface) conflicts so callers can
 * re-render and drive a "which do you want to keep?" dialog. The resolver
 * does not mutate the CRDT itself — it returns `ConflictDecision`s that
 * the caller applies (or ignores).
 */
export class ConflictResolver {
  private readonly opts: ConflictResolverOptions;
  private pending = new Map<string, ConflictDescriptor>();
  /** Recent ops per clip, used to notice concurrent conflicts. */
  private recent = new Map<ClipId, TimelineOperation[]>();
  private listeners = new Set<ConflictListener>();
  /** Window in ms during which two ops on the same clip are "concurrent". */
  private readonly concurrencyWindowMs = 5000;
  /** Max ops retained per clip. */
  private readonly recencyLimit = 32;

  constructor(opts: ConflictResolverOptions) {
    this.opts = {
      defaultStrategy: "LAST_WRITE_WINS",
      ...opts,
    };
  }

  // ── Subscription ───────────────────────────────────────────────────────

  subscribe(l: ConflictListener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  listPending(): ConflictDescriptor[] {
    return Array.from(this.pending.values());
  }

  getPending(conflictId: string): ConflictDescriptor | null {
    return this.pending.get(conflictId) ?? null;
  }

  dismiss(conflictId: string): void {
    const c = this.pending.get(conflictId);
    if (!c) return;
    this.pending.delete(conflictId);
    this.fire({ kind: "CONFLICT_DISMISSED", conflict: c });
  }

  // ── Detection ──────────────────────────────────────────────────────────

  /**
   * Feed every op (local and remote) into the resolver. Returns a
   * `ConflictDescriptor` if this op triggered one, otherwise `null`.
   */
  observe(op: TimelineOperation): ConflictDescriptor | null {
    const clipId = operationTarget(op);
    if (!clipId) return null;

    let list = this.recent.get(clipId);
    if (!list) {
      list = [];
      this.recent.set(clipId, list);
    }
    // Prune window.
    const cutoff = op.timestamp - this.concurrencyWindowMs;
    while (list.length > 0 && list[0].timestamp < cutoff) list.shift();
    while (list.length >= this.recencyLimit) list.shift();

    let descriptor: ConflictDescriptor | null = null;
    for (const prior of list) {
      if (opsConflict(prior, op)) {
        const kind = classify(prior, op);
        if (!kind) continue;
        const conflictId = `${clipId}:${prior.opId}:${op.opId}`;
        descriptor = {
          conflictId,
          kind,
          clipId,
          ops: [prior, op].sort((a, b) => a.lamport - b.lamport),
          label: this.labelFor(kind, [prior, op]),
          detectedAt: Date.now(),
        };
        this.pending.set(conflictId, descriptor);
        this.fire({ kind: "CONFLICT_DETECTED", conflict: descriptor });
        break;
      }
    }
    list.push(op);
    return descriptor;
  }

  /**
   * Sweep a full op log and return every conflict descriptor, without
   * consulting the CRDT's internal state. Useful when rehydrating UI
   * after a reconnect.
   */
  sweep(ops: TimelineOperation[]): ConflictDescriptor[] {
    const sorted = ops.slice().sort((a, b) => a.timestamp - b.timestamp);
    const out: ConflictDescriptor[] = [];
    this.recent.clear();
    this.pending.clear();
    for (const op of sorted) {
      const c = this.observe(op);
      if (c) out.push(c);
    }
    return out;
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  /**
   * Produce a `ConflictDecision` according to `strategy`. The caller is
   * responsible for applying the decision to the CRDT (or rejecting it).
   */
  resolve(
    conflictId: string,
    strategy: ConflictStrategy = this.opts.defaultStrategy!,
    timeline?: CRDTTimeline,
  ): ConflictDecision {
    const c = this.pending.get(conflictId);
    if (!c) {
      throw new Error(`ConflictResolver.resolve: unknown conflict ${conflictId}`);
    }
    const decision = this.decide(c, strategy, timeline);
    this.pending.delete(conflictId);
    this.fire({ kind: "CONFLICT_RESOLVED", conflict: c, decision });
    return decision;
  }

  /** Force resolve every pending conflict using one strategy. */
  resolveAll(
    strategy: ConflictStrategy,
    timeline?: CRDTTimeline,
  ): ConflictDecision[] {
    const out: ConflictDecision[] = [];
    for (const id of Array.from(this.pending.keys())) {
      out.push(this.resolve(id, strategy, timeline));
    }
    return out;
  }

  private decide(
    c: ConflictDescriptor,
    strategy: ConflictStrategy,
    timeline?: CRDTTimeline,
  ): ConflictDecision {
    const [a, b] = c.ops;
    switch (strategy) {
      case "LAST_WRITE_WINS": {
        const winner = a.lamport >= b.lamport ? a : b;
        const loser = winner === a ? b : a;
        return {
          conflictId: c.conflictId,
          strategy,
          winnerOp: winner,
          loserOps: [loser],
          explanation: `Last-write-wins: ${this.name(winner.userId)}'s change (lamport ${winner.lamport}) overrides ${this.name(loser.userId)}'s.`,
        };
      }
      case "PREFER_LOCAL": {
        const winner = a.userId === this.opts.localUserId ? a : b;
        const loser = winner === a ? b : a;
        return {
          conflictId: c.conflictId,
          strategy,
          winnerOp: winner,
          loserOps: [loser],
          explanation: `Kept your (${this.name(this.opts.localUserId)}) change.`,
        };
      }
      case "PREFER_REMOTE": {
        const winner = a.userId !== this.opts.localUserId ? a : b;
        const loser = winner === a ? b : a;
        return {
          conflictId: c.conflictId,
          strategy,
          winnerOp: winner,
          loserOps: [loser],
          explanation: `Kept ${this.name(winner.userId)}'s change.`,
        };
      }
      case "AUTO_MERGE": {
        const merged = this.tryMerge(c, timeline);
        if (merged) {
          return {
            conflictId: c.conflictId,
            strategy,
            winnerOp: null,
            loserOps: [],
            merged,
            explanation: "Auto-merged non-overlapping attributes.",
          };
        }
        // Fall back to last-write-wins if merge impossible.
        return this.decide(c, "LAST_WRITE_WINS", timeline);
      }
      case "PROMPT_USER":
        return {
          conflictId: c.conflictId,
          strategy,
          winnerOp: null,
          loserOps: [],
          explanation:
            "Awaiting user choice. Call `acceptOp` / `rejectOp` explicitly.",
        };
    }
  }

  /**
   * The UI can call this to commit the user's manual choice. Returns a
   * `ConflictDecision` that mirrors `resolve(LAST_WRITE_WINS)` but with
   * the user-chosen winner/loser.
   */
  acceptOp(conflictId: string, winnerOpId: string): ConflictDecision {
    const c = this.pending.get(conflictId);
    if (!c) throw new Error(`unknown conflict ${conflictId}`);
    const winner = c.ops.find((o) => o.opId === winnerOpId);
    if (!winner) throw new Error(`op ${winnerOpId} not part of conflict`);
    const losers = c.ops.filter((o) => o.opId !== winnerOpId);
    const decision: ConflictDecision = {
      conflictId,
      strategy: "PROMPT_USER",
      winnerOp: winner,
      loserOps: losers,
      explanation: `User chose ${this.name(winner.userId)}'s change.`,
    };
    this.pending.delete(conflictId);
    this.fire({ kind: "CONFLICT_RESOLVED", conflict: c, decision });
    return decision;
  }

  // ── Diff presentation ─────────────────────────────────────────────────

  /**
   * Build a human-readable diff describing the two conflicting ops. The
   * UI can render this directly as "Your trim vs Sam's trim" etc.
   */
  diff(conflictId: string, clip?: Clip): ConflictDiff {
    const c = this.pending.get(conflictId);
    if (!c) throw new Error(`unknown conflict ${conflictId}`);
    return this.buildDiff(c, clip);
  }

  private buildDiff(c: ConflictDescriptor, clip?: Clip): ConflictDiff {
    const sides: ConflictDiff["sides"] = c.ops.map((op) => ({
      userId: op.userId,
      displayLabel:
        op.userId === this.opts.localUserId
          ? `You (${this.name(op.userId)})`
          : this.name(op.userId),
      rows: diffRowsFor(op, clip),
    }));
    return {
      sides,
      summary: c.label,
    };
  }

  // ── Auto-merge logic ──────────────────────────────────────────────────

  private tryMerge(
    c: ConflictDescriptor,
    timeline?: CRDTTimeline,
  ): TimelineOperation | null {
    if (c.kind !== "CONCURRENT_TRIM") return null;
    const [a, b] = c.ops;
    if (a.kind !== "TRIM_CLIP" || b.kind !== "TRIM_CLIP") return null;
    // If one trim only changes the head and the other only the tail, merge them.
    const headOnly = (op: typeof a) =>
      op.payload.newSourceStart !== op.payload.prevSourceStart &&
      op.payload.newDuration === op.payload.prevDuration &&
      op.payload.newStart !== op.payload.prevStart;
    const tailOnly = (op: typeof a) =>
      op.payload.newSourceStart === op.payload.prevSourceStart &&
      op.payload.newDuration !== op.payload.prevDuration &&
      op.payload.newStart === op.payload.prevStart;
    if (!timeline) return null;
    const clip = timeline.getClip(c.clipId);
    if (!clip) return null;
    let head = a;
    let tail = b;
    if (headOnly(a) && tailOnly(b)) {
      head = a;
      tail = b;
    } else if (headOnly(b) && tailOnly(a)) {
      head = b;
      tail = a;
    } else {
      return null;
    }
    const winnerUser = a.lamport >= b.lamport ? a.userId : b.userId;
    const newLamport = Math.max(a.lamport, b.lamport) + 1;
    return {
      opId: `merge-${head.opId}-${tail.opId}`,
      userId: winnerUser,
      timestamp: Math.max(a.timestamp, b.timestamp),
      lamport: newLamport,
      kind: "TRIM_CLIP",
      payload: {
        clipId: c.clipId,
        newStart: head.payload.newStart,
        newDuration: tail.payload.newDuration,
        newSourceStart: head.payload.newSourceStart,
        prevStart: clip.start,
        prevDuration: clip.duration,
        prevSourceStart: clip.sourceStart,
      },
    };
  }

  // ── Label / naming ────────────────────────────────────────────────────

  private labelFor(kind: ConflictKind, ops: TimelineOperation[]): string {
    const namesSet = new Set(ops.map((o) => this.name(o.userId)));
    const names = Array.from(namesSet);
    switch (kind) {
      case "CONCURRENT_TRIM":
        return `Conflicting trim — ${names.join(" vs ")}`;
      case "CONCURRENT_MOVE":
        return `Conflicting move — ${names.join(" vs ")}`;
      case "TRIM_VS_MOVE":
        return `${names.join(" and ")} edited the same clip differently`;
      case "EDIT_VS_DELETE":
        return `${names[0]} edited a clip that ${names[names.length - 1]} removed`;
      case "CONCURRENT_EFFECT":
        return `Conflicting effect changes — ${names.join(" vs ")}`;
      case "CONCURRENT_SPLIT":
        return `Two simultaneous splits on the same clip`;
      case "LOCK_CONTENTION":
        return `Lock contention between ${names.join(" and ")}`;
    }
  }

  private name(userId: UserId): string {
    if (this.opts.displayName) return this.opts.displayName(userId);
    return userId;
  }

  private fire(e: ConflictEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

function classify(
  a: TimelineOperation,
  b: TimelineOperation,
): ConflictKind | null {
  if (a.kind === "TRIM_CLIP" && b.kind === "TRIM_CLIP") return "CONCURRENT_TRIM";
  if (a.kind === "MOVE_CLIP" && b.kind === "MOVE_CLIP") return "CONCURRENT_MOVE";
  if (
    (a.kind === "TRIM_CLIP" && b.kind === "MOVE_CLIP") ||
    (a.kind === "MOVE_CLIP" && b.kind === "TRIM_CLIP")
  ) {
    return "TRIM_VS_MOVE";
  }
  if (a.kind === "REMOVE_CLIP" || b.kind === "REMOVE_CLIP") return "EDIT_VS_DELETE";
  if (a.kind === "SPLIT_CLIP" && b.kind === "SPLIT_CLIP") return "CONCURRENT_SPLIT";
  if (
    (a.kind === "ADD_EFFECT" || a.kind === "REMOVE_EFFECT") &&
    (b.kind === "ADD_EFFECT" || b.kind === "REMOVE_EFFECT")
  ) {
    return "CONCURRENT_EFFECT";
  }
  return null;
}

function diffRowsFor(op: TimelineOperation, clip?: Clip): ConflictDiffRow[] {
  const rows: ConflictDiffRow[] = [];
  switch (op.kind) {
    case "TRIM_CLIP":
      rows.push(row("start (s)", op.payload.prevStart, op.payload.newStart));
      rows.push(row("duration (s)", op.payload.prevDuration, op.payload.newDuration));
      rows.push(
        row("source start (s)", op.payload.prevSourceStart, op.payload.newSourceStart),
      );
      break;
    case "MOVE_CLIP":
      rows.push(row("track", op.payload.fromTrackId, op.payload.toTrackId));
      rows.push(row("start (s)", op.payload.fromStart, op.payload.toStart));
      break;
    case "SPLIT_CLIP":
      rows.push(row("split at (s)", "—", op.payload.splitAt));
      rows.push(row("new clip id", "—", op.payload.newRightClipId));
      break;
    case "ADD_EFFECT":
      rows.push(row("effect", "—", op.payload.effect.kind));
      rows.push(
        row(
          "parameters",
          "—",
          JSON.stringify(op.payload.effect.parameters).slice(0, 80),
        ),
      );
      break;
    case "REMOVE_EFFECT":
      rows.push(row("removed effect", "—", op.payload.effectId));
      break;
    case "REMOVE_CLIP":
      rows.push(
        row(
          "action",
          clip ? `${clip.name} [${clip.clipId}]` : op.payload.clipId,
          "deleted",
        ),
      );
      break;
    case "ADD_CLIP":
      rows.push(row("created clip", "—", op.payload.clip.name));
      rows.push(
        row(
          "position",
          "—",
          `${op.payload.clip.trackId} @ ${op.payload.clip.start.toFixed(2)}s`,
        ),
      );
      break;
    case "LOCK_CLIP":
      rows.push(row("lock", "free", op.userId));
      break;
    case "UNLOCK_CLIP":
      rows.push(row("lock", op.userId, "free"));
      break;
    case "ADD_TRACK":
      rows.push(row("created track", "—", op.payload.track.name));
      break;
    case "REMOVE_TRACK":
      rows.push(row("removed track", op.payload.trackId, "deleted"));
      break;
  }
  return rows;
}

function row(attr: string, before: unknown, after: unknown): ConflictDiffRow {
  return {
    attribute: attr,
    before: formatVal(before),
    after: formatVal(after),
  };
}

function formatVal(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (v === null || v === undefined) return "—";
  return String(v);
}

export default ConflictResolver;
