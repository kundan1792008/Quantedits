/**
 * CollaborationServer — WebSocket-based real-time sync for collaborative
 * video editing. Acts as both the authoritative relay running on the
 * server and the reconnecting client used by every peer in the browser.
 *
 * Responsibilities
 * ----------------
 *   • Session management: join / leave / presence list.
 *   • Broadcast CRDT operations to all other members in under 100 ms.
 *   • Track per-user cursor position (timeline seconds + selected clip).
 *   • Arbitrate clip locks: only one user edits a given clip at a time.
 *   • Deliver incremental state snapshots to late-joining peers.
 *   • Heartbeat / dead-peer eviction.
 *   • Support 2–8 simultaneous editors per project (soft cap 8, hard 16).
 *
 * Design
 * ------
 * This file defines three layers:
 *   1. Wire protocol types (`CollabMessage`) — shared between client and
 *      server implementations.
 *   2. `CollaborationServer` — in-process authoritative relay. Runs on
 *      the server (Node) but is transport-agnostic; concrete WebSocket
 *      bindings feed `CollaborationSocket`s into it.
 *   3. `CollaborationClient` — the browser-side client. Maintains a
 *      local `CRDTTimeline`, queues outgoing ops, auto-reconnects with
 *      exponential back-off and dispatches incoming ops to the timeline.
 *
 * The implementation is transport-agnostic: any bidirectional message
 * channel that implements `CollaborationSocket` can be plugged in. The
 * default `BrowserWebSocketAdapter` provides a thin wrapper on top of
 * the browser `WebSocket` API for client use.
 */

import {
  CRDTTimeline,
  TimelineOperation,
  VectorClock,
  ClipId,
  UserId,
  operationTarget,
} from "./CRDTTimeline";

// ── Wire protocol ─────────────────────────────────────────────────────────

export type CollabMessageKind =
  | "HELLO"
  | "WELCOME"
  | "JOIN"
  | "LEAVE"
  | "OP"
  | "OP_BATCH"
  | "STATE_REQUEST"
  | "STATE_SNAPSHOT"
  | "PRESENCE"
  | "CURSOR"
  | "LOCK_REQUEST"
  | "LOCK_GRANTED"
  | "LOCK_DENIED"
  | "LOCK_RELEASE"
  | "PING"
  | "PONG"
  | "ERROR";

export interface CollabMessageBase {
  kind: CollabMessageKind;
  /** Monotonic message sequence number per sender (for ordering/debug). */
  seq: number;
  /** Sender user id (clients) or `"server"` (server). */
  from: string;
  /** Project identifier all participants share. */
  projectId: string;
  /** Server wall-clock ms when the message was relayed. */
  serverTime?: number;
}

export interface HelloMessage extends CollabMessageBase {
  kind: "HELLO";
  userId: UserId;
  displayName: string;
  color: string;
  /** Vector clock so the server can send only the ops we're missing. */
  clock: VectorClock;
  authToken?: string;
}

export interface WelcomeMessage extends CollabMessageBase {
  kind: "WELCOME";
  sessionId: string;
  peers: PeerInfo[];
  /** Full snapshot for cold joins, empty if a delta was sent instead. */
  snapshot?: { ops: TimelineOperation[] };
}

export interface JoinMessage extends CollabMessageBase {
  kind: "JOIN";
  peer: PeerInfo;
}

export interface LeaveMessage extends CollabMessageBase {
  kind: "LEAVE";
  userId: UserId;
  reason?: string;
}

export interface OpMessage extends CollabMessageBase {
  kind: "OP";
  op: TimelineOperation;
}

export interface OpBatchMessage extends CollabMessageBase {
  kind: "OP_BATCH";
  ops: TimelineOperation[];
}

export interface StateRequestMessage extends CollabMessageBase {
  kind: "STATE_REQUEST";
  /** Client's current vector clock — server returns only missing ops. */
  clock: VectorClock;
}

export interface StateSnapshotMessage extends CollabMessageBase {
  kind: "STATE_SNAPSHOT";
  ops: TimelineOperation[];
  /** Server vector clock at the time of the snapshot. */
  clock: VectorClock;
}

export interface PresenceMessage extends CollabMessageBase {
  kind: "PRESENCE";
  peers: PeerInfo[];
}

export interface CursorMessage extends CollabMessageBase {
  kind: "CURSOR";
  userId: UserId;
  /** Timeline time in seconds. */
  time: number;
  /** Currently selected clip if any. */
  selectedClipId: ClipId | null;
  /** "Editing clip X" flag for UI status badge. */
  editing: boolean;
}

export interface LockRequestMessage extends CollabMessageBase {
  kind: "LOCK_REQUEST";
  clipId: ClipId;
}

export interface LockGrantedMessage extends CollabMessageBase {
  kind: "LOCK_GRANTED";
  clipId: ClipId;
  /** Server-authored LOCK_CLIP op that participants apply. */
  op: TimelineOperation;
}

export interface LockDeniedMessage extends CollabMessageBase {
  kind: "LOCK_DENIED";
  clipId: ClipId;
  heldBy: UserId;
  reason: string;
}

export interface LockReleaseMessage extends CollabMessageBase {
  kind: "LOCK_RELEASE";
  clipId: ClipId;
  op: TimelineOperation;
}

export interface PingMessage extends CollabMessageBase {
  kind: "PING";
  pingId: string;
  clientTime: number;
}

export interface PongMessage extends CollabMessageBase {
  kind: "PONG";
  pingId: string;
  clientTime: number;
  serverReceivedAt: number;
}

export interface ErrorMessage extends CollabMessageBase {
  kind: "ERROR";
  code: string;
  message: string;
}

export type CollabMessage =
  | HelloMessage
  | WelcomeMessage
  | JoinMessage
  | LeaveMessage
  | OpMessage
  | OpBatchMessage
  | StateRequestMessage
  | StateSnapshotMessage
  | PresenceMessage
  | CursorMessage
  | LockRequestMessage
  | LockGrantedMessage
  | LockDeniedMessage
  | LockReleaseMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

// ── Peer model ────────────────────────────────────────────────────────────

export interface PeerInfo {
  userId: UserId;
  displayName: string;
  color: string;
  /** Seconds since epoch of the last heartbeat. */
  lastSeen: number;
  cursorTime: number;
  selectedClipId: ClipId | null;
  editing: boolean;
  /** Average round-trip time in ms, exponentially smoothed. */
  rttMs: number;
}

// ── Transport abstraction ─────────────────────────────────────────────────

/** A bidirectional JSON message pipe. Implementations: WebSocket, WS, in-memory. */
export interface CollaborationSocket {
  send(message: CollabMessage): void;
  close(code?: number, reason?: string): void;
  readonly id: string;
  /** `open` readyState for quick capability checks. */
  isOpen(): boolean;
}

export interface CollaborationSocketEvents {
  onMessage(handler: (m: CollabMessage) => void): () => void;
  onClose(handler: (code: number, reason: string) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
}

// ── Server: session state ─────────────────────────────────────────────────

interface Session {
  projectId: string;
  /** Authoritative CRDT timeline replica living on the server. */
  timeline: CRDTTimeline;
  peers: Map<UserId, ServerPeer>;
  /** Every op seen by the server (used to answer STATE_REQUEST). */
  opCache: TimelineOperation[];
  /** Monotonic message seq counter. */
  seq: number;
  createdAt: number;
}

interface ServerPeer {
  info: PeerInfo;
  socket: CollaborationSocket & Partial<CollaborationSocketEvents>;
  joinedAt: number;
  unsubscribers: Array<() => void>;
}

export interface CollaborationServerOptions {
  /** Max simultaneous peers per project. Defaults to 8. Hard ceiling: 16. */
  maxPeersPerProject?: number;
  /** Heartbeat interval in ms. */
  heartbeatMs?: number;
  /** Evict peers whose last activity is older than this (ms). */
  peerTimeoutMs?: number;
  /** Extra validation hook — reject HELLO messages that do not pass. */
  validateHello?(msg: HelloMessage): { ok: boolean; reason?: string };
  logger?: (line: string) => void;
}

export class CollaborationServer {
  private readonly opts: Required<
    Omit<CollaborationServerOptions, "validateHello" | "logger">
  > &
    Pick<CollaborationServerOptions, "validateHello" | "logger">;
  private readonly sessions = new Map<string, Session>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CollaborationServerOptions = {}) {
    this.opts = {
      maxPeersPerProject: Math.min(16, Math.max(2, opts.maxPeersPerProject ?? 8)),
      heartbeatMs: Math.max(1000, opts.heartbeatMs ?? 5000),
      peerTimeoutMs: Math.max(5000, opts.peerTimeoutMs ?? 30_000),
      validateHello: opts.validateHello,
      logger: opts.logger,
    };
    this.startHeartbeat();
  }

  /**
   * Register a new socket connection with the server. Must be called as
   * soon as the underlying WebSocket upgrade completes. Returns a handle
   * that the caller uses to feed inbound messages and signal close.
   */
  accept(
    socket: CollaborationSocket,
    events: CollaborationSocketEvents,
  ): ServerConnectionHandle {
    let joinedSession: Session | null = null;
    let joinedPeer: ServerPeer | null = null;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      events.onMessage((msg) => {
        try {
          this.handleMessage(socket, msg, {
            join(session, peer) {
              joinedSession = session;
              joinedPeer = peer;
            },
            leave() {
              joinedSession = null;
              joinedPeer = null;
            },
          });
        } catch (err) {
          this.log(
            `[CollabServer] message error: ${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            socket.send(this.errorFor(msg.projectId, "INTERNAL", String(err)));
          } catch {
            /* ignore: socket may already be dead */
          }
        }
      }),
    );
    unsubs.push(
      events.onClose(() => {
        if (joinedSession && joinedPeer) {
          this.removePeer(joinedSession, joinedPeer.info.userId, "socket-closed");
        }
      }),
    );
    unsubs.push(
      events.onError((err) => {
        this.log(`[CollabServer] socket error: ${err.message}`);
      }),
    );

    return {
      close: () => {
        for (const u of unsubs) u();
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      },
    };
  }

  /** Stop timers and disconnect every peer. */
  shutdown(reason = "server-shutdown"): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const session of this.sessions.values()) {
      for (const peer of session.peers.values()) {
        try {
          peer.socket.send({
            kind: "LEAVE",
            seq: ++session.seq,
            from: "server",
            projectId: session.projectId,
            userId: peer.info.userId,
            reason,
          });
          peer.socket.close(1001, reason);
        } catch {
          /* ignore */
        }
        for (const u of peer.unsubscribers) u();
      }
      session.peers.clear();
    }
    this.sessions.clear();
  }

  listSessions(): Array<{ projectId: string; peerCount: number; ops: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      projectId: s.projectId,
      peerCount: s.peers.size,
      ops: s.opCache.length,
    }));
  }

  getSessionPeers(projectId: string): PeerInfo[] {
    const s = this.sessions.get(projectId);
    if (!s) return [];
    return Array.from(s.peers.values()).map((p) => ({ ...p.info }));
  }

  // ── Message dispatch ────────────────────────────────────────────────────

  private handleMessage(
    socket: CollaborationSocket,
    msg: CollabMessage,
    hooks: {
      join: (s: Session, p: ServerPeer) => void;
      leave: () => void;
    },
  ): void {
    switch (msg.kind) {
      case "HELLO":
        this.handleHello(socket, msg, hooks.join);
        return;
      case "OP":
        this.handleOp(msg);
        return;
      case "OP_BATCH":
        this.handleOpBatch(msg);
        return;
      case "STATE_REQUEST":
        this.handleStateRequest(socket, msg);
        return;
      case "CURSOR":
        this.handleCursor(msg);
        return;
      case "LOCK_REQUEST":
        this.handleLockRequest(msg);
        return;
      case "LOCK_RELEASE":
        this.handleLockRelease(msg);
        return;
      case "PING":
        this.handlePing(socket, msg);
        return;
      case "LEAVE":
        {
          const session = this.sessions.get(msg.projectId);
          if (session) this.removePeer(session, msg.userId, msg.reason ?? "leave");
          hooks.leave();
        }
        return;
      // Server-authored messages never flow inbound; ignore.
      case "WELCOME":
      case "JOIN":
      case "PRESENCE":
      case "STATE_SNAPSHOT":
      case "LOCK_GRANTED":
      case "LOCK_DENIED":
      case "ERROR":
      case "PONG":
        return;
    }
  }

  private handleHello(
    socket: CollaborationSocket,
    msg: HelloMessage,
    onJoin: (s: Session, p: ServerPeer) => void,
  ): void {
    if (this.opts.validateHello) {
      const result = this.opts.validateHello(msg);
      if (!result.ok) {
        socket.send(this.errorFor(msg.projectId, "AUTH", result.reason ?? "rejected"));
        socket.close(4001, "rejected");
        return;
      }
    }
    let session = this.sessions.get(msg.projectId);
    if (!session) {
      session = this.createSession(msg.projectId);
      this.sessions.set(msg.projectId, session);
    }
    if (session.peers.size >= this.opts.maxPeersPerProject) {
      socket.send(
        this.errorFor(
          msg.projectId,
          "FULL",
          `session full (max ${this.opts.maxPeersPerProject})`,
        ),
      );
      socket.close(4008, "session-full");
      return;
    }
    if (session.peers.has(msg.userId)) {
      // Replace stale connection. The previous socket is likely dead.
      this.removePeer(session, msg.userId, "replaced-by-new-connection");
    }

    const peer: ServerPeer = {
      info: {
        userId: msg.userId,
        displayName: msg.displayName,
        color: msg.color,
        lastSeen: Date.now(),
        cursorTime: 0,
        selectedClipId: null,
        editing: false,
        rttMs: 0,
      },
      socket,
      joinedAt: Date.now(),
      unsubscribers: [],
    };
    session.peers.set(msg.userId, peer);
    onJoin(session, peer);

    // Send WELCOME with the missing ops (delta) so we stay under 100ms even
    // for large projects.
    const missing = this.opsMissingFor(session, msg.clock);
    const welcome: WelcomeMessage = {
      kind: "WELCOME",
      seq: ++session.seq,
      from: "server",
      projectId: session.projectId,
      serverTime: Date.now(),
      sessionId: `${session.projectId}:${session.createdAt}`,
      peers: Array.from(session.peers.values()).map((p) => ({ ...p.info })),
      snapshot: { ops: missing },
    };
    socket.send(welcome);

    // Notify everyone else about the new peer.
    const join: JoinMessage = {
      kind: "JOIN",
      seq: ++session.seq,
      from: "server",
      projectId: session.projectId,
      serverTime: Date.now(),
      peer: { ...peer.info },
    };
    this.broadcastExcept(session, msg.userId, join);
  }

  private handleOp(msg: OpMessage): void {
    const session = this.sessions.get(msg.projectId);
    if (!session) return;
    // Validate authorship.
    if (msg.op.userId !== msg.from) {
      return; // drop spoofed ops
    }
    const applied = session.timeline.apply(msg.op);
    if (applied) {
      session.opCache.push(msg.op);
      this.trimOpCache(session);
    }
    this.touchPeer(session, msg.from);
    this.broadcastExcept(session, msg.from, msg);
  }

  private handleOpBatch(msg: OpBatchMessage): void {
    const session = this.sessions.get(msg.projectId);
    if (!session) return;
    const safeOps = msg.ops.filter((o) => o.userId === msg.from);
    const applied = session.timeline.applyBatch(safeOps);
    if (applied > 0) {
      for (const op of safeOps) session.opCache.push(op);
      this.trimOpCache(session);
    }
    this.touchPeer(session, msg.from);
    this.broadcastExcept(session, msg.from, { ...msg, ops: safeOps });
  }

  private handleStateRequest(
    socket: CollaborationSocket,
    msg: StateRequestMessage,
  ): void {
    const session = this.sessions.get(msg.projectId);
    if (!session) return;
    const ops = this.opsMissingFor(session, msg.clock);
    const reply: StateSnapshotMessage = {
      kind: "STATE_SNAPSHOT",
      seq: ++session.seq,
      from: "server",
      projectId: session.projectId,
      serverTime: Date.now(),
      ops,
      clock: session.timeline.getVectorClock(),
    };
    socket.send(reply);
  }

  private handleCursor(msg: CursorMessage): void {
    const session = this.sessions.get(msg.projectId);
    if (!session) return;
    const peer = session.peers.get(msg.userId);
    if (!peer) return;
    peer.info.cursorTime = msg.time;
    peer.info.selectedClipId = msg.selectedClipId;
    peer.info.editing = msg.editing;
    peer.info.lastSeen = Date.now();
    this.broadcastExcept(session, msg.from, msg);
  }

  private handleLockRequest(msg: LockRequestMessage): void {
    const session = this.sessions.get(msg.projectId);
    if (!session) return;
    const peer = session.peers.get(msg.from);
    if (!peer) return;

    const currentHolder = session.timeline.getClipLock(msg.clipId);
    if (currentHolder && currentHolder !== msg.from) {
      const reply: LockDeniedMessage = {
        kind: "LOCK_DENIED",
        seq: ++session.seq,
        from: "server",
        projectId: session.projectId,
        serverTime: Date.now(),
        clipId: msg.clipId,
        heldBy: currentHolder,
        reason: "already-held",
      };
      peer.socket.send(reply);
      return;
    }
    // Server authors the LOCK_CLIP op on behalf of the requesting peer
    // — this guarantees a single, authoritative order for lock events.
    const lockOp: TimelineOperation = this.serverLockOp(session, msg.from, msg.clipId);
    session.timeline.apply(lockOp);
    session.opCache.push(lockOp);

    const granted: LockGrantedMessage = {
      kind: "LOCK_GRANTED",
      seq: ++session.seq,
      from: "server",
      projectId: session.projectId,
      serverTime: Date.now(),
      clipId: msg.clipId,
      op: lockOp,
    };
    for (const p of session.peers.values()) p.socket.send(granted);
  }

  private handleLockRelease(msg: LockReleaseMessage): void {
    const session = this.sessions.get(msg.projectId);
    if (!session) return;
    if (msg.op.userId !== msg.from) return;
    if (msg.op.kind !== "UNLOCK_CLIP") return;
    const applied = session.timeline.apply(msg.op);
    if (applied) session.opCache.push(msg.op);
    for (const p of session.peers.values()) p.socket.send(msg);
  }

  private handlePing(socket: CollaborationSocket, msg: PingMessage): void {
    const session = this.sessions.get(msg.projectId);
    const seq = session ? ++session.seq : 0;
    const reply: PongMessage = {
      kind: "PONG",
      seq,
      from: "server",
      projectId: msg.projectId,
      serverTime: Date.now(),
      pingId: msg.pingId,
      clientTime: msg.clientTime,
      serverReceivedAt: Date.now(),
    };
    socket.send(reply);
    if (session) this.touchPeer(session, msg.from);
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private createSession(projectId: string): Session {
    return {
      projectId,
      timeline: new CRDTTimeline({
        projectId,
        localUserId: "server",
      }),
      peers: new Map(),
      opCache: [],
      seq: 0,
      createdAt: Date.now(),
    };
  }

  private trimOpCache(session: Session): void {
    const MAX = 50_000;
    if (session.opCache.length > MAX) {
      session.opCache.splice(0, session.opCache.length - MAX);
    }
  }

  private opsMissingFor(session: Session, clientClock: VectorClock): TimelineOperation[] {
    // Send every op whose lamport > clientClock[userId].
    const result: TimelineOperation[] = [];
    for (const op of session.opCache) {
      const seen = clientClock[op.userId] ?? 0;
      if (op.lamport > seen) result.push(op);
    }
    return result;
  }

  private broadcastExcept(
    session: Session,
    exceptUserId: UserId,
    message: CollabMessage,
  ): void {
    const stamped: CollabMessage = { ...message, serverTime: Date.now() };
    for (const peer of session.peers.values()) {
      if (peer.info.userId === exceptUserId) continue;
      try {
        peer.socket.send(stamped);
      } catch (err) {
        this.log(
          `[CollabServer] drop ${peer.info.userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private touchPeer(session: Session, userId: UserId): void {
    const p = session.peers.get(userId);
    if (p) p.info.lastSeen = Date.now();
  }

  private removePeer(session: Session, userId: UserId, reason: string): void {
    const peer = session.peers.get(userId);
    if (!peer) return;
    session.peers.delete(userId);
    for (const u of peer.unsubscribers) u();
    // Release any locks held by this peer so the rest of the room can make
    // progress immediately.
    for (const clip of session.timeline.getClips()) {
      if (clip.lockedBy === userId) {
        const op = this.serverUnlockOp(session, userId, clip.clipId);
        session.timeline.apply(op);
        session.opCache.push(op);
        for (const p of session.peers.values()) {
          p.socket.send({
            kind: "LOCK_RELEASE",
            seq: ++session.seq,
            from: "server",
            projectId: session.projectId,
            serverTime: Date.now(),
            clipId: clip.clipId,
            op,
          });
        }
      }
    }
    const leave: LeaveMessage = {
      kind: "LEAVE",
      seq: ++session.seq,
      from: "server",
      projectId: session.projectId,
      serverTime: Date.now(),
      userId,
      reason,
    };
    for (const p of session.peers.values()) p.socket.send(leave);
    if (session.peers.size === 0) {
      // Keep the session alive for 10 min in case of reconnects.
      setTimeout(() => {
        const s = this.sessions.get(session.projectId);
        if (s && s.peers.size === 0) this.sessions.delete(session.projectId);
      }, 10 * 60 * 1000);
    }
  }

  private errorFor(projectId: string, code: string, message: string): ErrorMessage {
    return {
      kind: "ERROR",
      seq: 0,
      from: "server",
      projectId,
      serverTime: Date.now(),
      code,
      message,
    };
  }

  private serverLockOp(
    session: Session,
    userId: UserId,
    clipId: ClipId,
  ): TimelineOperation {
    const clock = session.timeline.getLamport() + 1;
    return {
      opId: `server-lock-${clipId}-${clock}`,
      userId,
      timestamp: Date.now(),
      lamport: clock,
      kind: "LOCK_CLIP",
      payload: { clipId },
    };
  }

  private serverUnlockOp(
    session: Session,
    userId: UserId,
    clipId: ClipId,
  ): TimelineOperation {
    const clock = session.timeline.getLamport() + 1;
    return {
      opId: `server-unlock-${clipId}-${clock}`,
      userId,
      timestamp: Date.now(),
      lamport: clock,
      kind: "UNLOCK_CLIP",
      payload: { clipId },
    };
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        for (const peer of Array.from(session.peers.values())) {
          if (now - peer.info.lastSeen > this.opts.peerTimeoutMs) {
            this.log(
              `[CollabServer] evict ${peer.info.userId} (idle ${(now - peer.info.lastSeen) / 1000}s)`,
            );
            this.removePeer(session, peer.info.userId, "idle-timeout");
          }
        }
        if (session.peers.size > 0) {
          const presence: PresenceMessage = {
            kind: "PRESENCE",
            seq: ++session.seq,
            from: "server",
            projectId: session.projectId,
            serverTime: now,
            peers: Array.from(session.peers.values()).map((p) => ({ ...p.info })),
          };
          for (const p of session.peers.values()) {
            try {
              p.socket.send(presence);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }, this.opts.heartbeatMs);
  }

  private log(line: string): void {
    if (this.opts.logger) this.opts.logger(line);
  }
}

export interface ServerConnectionHandle {
  close(): void;
}

// ── Client ────────────────────────────────────────────────────────────────

export interface CollaborationClientOptions {
  projectId: string;
  userId: UserId;
  displayName: string;
  /** Hex colour string for the user's presence cursor. */
  color: string;
  /** Auth token forwarded in HELLO. Optional. */
  authToken?: string;
  /** Transport factory. Defaults to a WebSocket connecting to `url`. */
  connect?: () => {
    socket: CollaborationSocket;
    events: CollaborationSocketEvents;
  };
  /** URL used by the default browser WebSocket adapter. */
  url?: string;
  /** Optional local timeline replica. Created if omitted. */
  timeline?: CRDTTimeline;
  logger?: (line: string) => void;
  /** Initial reconnect delay in ms. */
  reconnectBaseMs?: number;
  /** Max reconnect delay ceiling. */
  reconnectMaxMs?: number;
}

export type CollabClientEventKind =
  | "CONNECTED"
  | "DISCONNECTED"
  | "PEER_JOINED"
  | "PEER_LEFT"
  | "PRESENCE"
  | "CURSOR"
  | "REMOTE_OP"
  | "LOCAL_OP"
  | "LOCK_GRANTED"
  | "LOCK_DENIED"
  | "LOCK_RELEASED"
  | "LATENCY"
  | "ERROR";

export interface CollabClientEvent {
  kind: CollabClientEventKind;
  peers: PeerInfo[];
  op?: TimelineOperation;
  peer?: PeerInfo;
  userId?: UserId;
  clipId?: ClipId;
  rttMs?: number;
  reason?: string;
  code?: string;
}

export type CollabClientListener = (e: CollabClientEvent) => void;

export interface PendingLockRequest {
  clipId: ClipId;
  resolve: (op: TimelineOperation) => void;
  reject: (reason: string) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class CollaborationClient {
  readonly timeline: CRDTTimeline;
  private readonly opts: CollaborationClientOptions;
  private socket: CollaborationSocket | null = null;
  private socketEvents: CollaborationSocketEvents | null = null;
  private socketUnsubs: Array<() => void> = [];
  private seq = 0;
  private peers = new Map<UserId, PeerInfo>();
  private pendingOutbound: CollabMessage[] = [];
  private pendingLocks = new Map<ClipId, PendingLockRequest>();
  private listeners = new Set<CollabClientListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingSent = 0;
  private smoothedRtt = 0;
  private closed = false;

  constructor(opts: CollaborationClientOptions) {
    this.opts = {
      reconnectBaseMs: 250,
      reconnectMaxMs: 10_000,
      ...opts,
    };
    this.timeline =
      opts.timeline ??
      new CRDTTimeline({
        projectId: opts.projectId,
        localUserId: opts.userId,
      });

    // Every time the local CRDT applies a *local* op, ship it to the server.
    this.timeline.subscribe((event) => {
      if (event.kind !== "OP_APPLIED") return;
      if (!event.op) return;
      if (event.op.userId !== this.opts.userId) return;
      this.sendOp(event.op);
      this.fire({ kind: "LOCAL_OP", peers: this.peerList(), op: event.op });
    });
  }

  connect(): void {
    if (this.closed) return;
    this.teardownSocket();
    try {
      const t = this.opts.connect
        ? this.opts.connect()
        : this.defaultConnect();
      this.socket = t.socket;
      this.socketEvents = t.events;
      this.socketUnsubs.push(
        t.events.onMessage((m) => this.handleMessage(m)),
        t.events.onClose((code, reason) => this.onSocketClose(code, reason)),
        t.events.onError((err) => this.fire({ kind: "ERROR", peers: this.peerList(), reason: err.message })),
      );
      this.sendHello();
    } catch (err) {
      this.log(
        `[CollabClient] connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket) {
      try {
        this.send({
          kind: "LEAVE",
          seq: ++this.seq,
          from: this.opts.userId,
          projectId: this.opts.projectId,
          userId: this.opts.userId,
          reason: "client-leave",
        });
      } catch {
        /* ignore */
      }
    }
    this.teardownSocket();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  isConnected(): boolean {
    return !!this.socket && this.socket.isOpen();
  }

  listPeers(): PeerInfo[] {
    return this.peerList();
  }

  getLatencyMs(): number {
    return Math.round(this.smoothedRtt);
  }

  sendCursor(time: number, selectedClipId: ClipId | null, editing: boolean): void {
    const msg: CursorMessage = {
      kind: "CURSOR",
      seq: ++this.seq,
      from: this.opts.userId,
      projectId: this.opts.projectId,
      userId: this.opts.userId,
      time,
      selectedClipId,
      editing,
    };
    this.send(msg);
  }

  /**
   * Request an exclusive lock on `clipId`. Resolves with the authoritative
   * LOCK op, or rejects when the server denies or the timeout elapses.
   */
  requestLock(clipId: ClipId, timeoutMs = 3000): Promise<TimelineOperation> {
    return new Promise<TimelineOperation>((resolve, reject) => {
      const existing = this.pendingLocks.get(clipId);
      if (existing) {
        clearTimeout(existing.timeoutHandle);
        existing.reject("superseded");
      }
      const timeoutHandle = setTimeout(() => {
        this.pendingLocks.delete(clipId);
        reject(new Error(`lock request timeout for ${clipId}`));
      }, timeoutMs);
      this.pendingLocks.set(clipId, { clipId, resolve, reject, timeoutHandle });
      const msg: LockRequestMessage = {
        kind: "LOCK_REQUEST",
        seq: ++this.seq,
        from: this.opts.userId,
        projectId: this.opts.projectId,
        clipId,
      };
      this.send(msg);
    });
  }

  releaseLock(clipId: ClipId): void {
    const held = this.timeline.getClipLock(clipId);
    if (held !== this.opts.userId) return;
    const op = this.timeline.unlockClip(clipId);
    const msg: LockReleaseMessage = {
      kind: "LOCK_RELEASE",
      seq: ++this.seq,
      from: this.opts.userId,
      projectId: this.opts.projectId,
      clipId,
      op,
    };
    this.send(msg);
  }

  subscribe(listener: CollabClientListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private defaultConnect(): {
    socket: CollaborationSocket;
    events: CollaborationSocketEvents;
  } {
    if (!this.opts.url) {
      throw new Error(
        "CollaborationClient: provide either `url` or a custom `connect` factory",
      );
    }
    return BrowserWebSocketAdapter.connect(this.opts.url);
  }

  private sendHello(): void {
    const msg: HelloMessage = {
      kind: "HELLO",
      seq: ++this.seq,
      from: this.opts.userId,
      projectId: this.opts.projectId,
      userId: this.opts.userId,
      displayName: this.opts.displayName,
      color: this.opts.color,
      clock: this.timeline.getVectorClock(),
      authToken: this.opts.authToken,
    };
    // HELLO is special: sent directly, not via outbound queue, because the
    // server needs it before any op can be processed.
    if (this.socket && this.socket.isOpen()) {
      this.socket.send(msg);
    } else {
      this.pendingOutbound.unshift(msg);
    }
  }

  private sendOp(op: TimelineOperation): void {
    const msg: OpMessage = {
      kind: "OP",
      seq: ++this.seq,
      from: this.opts.userId,
      projectId: this.opts.projectId,
      op,
    };
    this.send(msg);
  }

  private send(msg: CollabMessage): void {
    if (!this.socket || !this.socket.isOpen()) {
      this.pendingOutbound.push(msg);
      return;
    }
    try {
      this.socket.send(msg);
    } catch (err) {
      this.log(
        `[CollabClient] send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.pendingOutbound.push(msg);
    }
  }

  private flushOutbound(): void {
    if (!this.socket || !this.socket.isOpen()) return;
    const queue = this.pendingOutbound;
    this.pendingOutbound = [];
    for (const m of queue) {
      try {
        this.socket.send(m);
      } catch {
        this.pendingOutbound.push(m);
        break;
      }
    }
  }

  private handleMessage(msg: CollabMessage): void {
    switch (msg.kind) {
      case "WELCOME":
        this.reconnectAttempt = 0;
        this.peers.clear();
        for (const p of msg.peers) this.peers.set(p.userId, { ...p });
        if (msg.snapshot) this.timeline.applyBatch(msg.snapshot.ops);
        this.startPingLoop();
        this.flushOutbound();
        this.fire({ kind: "CONNECTED", peers: this.peerList() });
        this.fire({ kind: "PRESENCE", peers: this.peerList() });
        return;
      case "JOIN":
        this.peers.set(msg.peer.userId, { ...msg.peer });
        this.fire({
          kind: "PEER_JOINED",
          peers: this.peerList(),
          peer: { ...msg.peer },
        });
        return;
      case "LEAVE":
        this.peers.delete(msg.userId);
        // Clear any pending lock requests — the absent user cannot respond.
        this.fire({
          kind: "PEER_LEFT",
          peers: this.peerList(),
          userId: msg.userId,
          reason: msg.reason,
        });
        return;
      case "PRESENCE": {
        const next = new Map<UserId, PeerInfo>();
        for (const p of msg.peers) next.set(p.userId, { ...p });
        this.peers = next;
        this.fire({ kind: "PRESENCE", peers: this.peerList() });
        return;
      }
      case "CURSOR": {
        const p = this.peers.get(msg.userId);
        if (p) {
          p.cursorTime = msg.time;
          p.selectedClipId = msg.selectedClipId;
          p.editing = msg.editing;
          p.lastSeen = Date.now();
        }
        this.fire({ kind: "CURSOR", peers: this.peerList(), userId: msg.userId });
        return;
      }
      case "OP":
        this.timeline.apply(msg.op);
        this.fire({ kind: "REMOTE_OP", peers: this.peerList(), op: msg.op });
        return;
      case "OP_BATCH":
        this.timeline.applyBatch(msg.ops);
        for (const op of msg.ops) {
          this.fire({ kind: "REMOTE_OP", peers: this.peerList(), op });
        }
        return;
      case "STATE_SNAPSHOT":
        this.timeline.applyBatch(msg.ops);
        return;
      case "LOCK_GRANTED": {
        this.timeline.apply(msg.op);
        const pending = this.pendingLocks.get(msg.clipId);
        if (pending && msg.op.userId === this.opts.userId) {
          clearTimeout(pending.timeoutHandle);
          this.pendingLocks.delete(msg.clipId);
          pending.resolve(msg.op);
        }
        this.fire({
          kind: "LOCK_GRANTED",
          peers: this.peerList(),
          clipId: msg.clipId,
          userId: msg.op.userId,
          op: msg.op,
        });
        return;
      }
      case "LOCK_DENIED": {
        const pending = this.pendingLocks.get(msg.clipId);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
          this.pendingLocks.delete(msg.clipId);
          pending.reject(msg.reason);
        }
        this.fire({
          kind: "LOCK_DENIED",
          peers: this.peerList(),
          clipId: msg.clipId,
          userId: msg.heldBy,
          reason: msg.reason,
        });
        return;
      }
      case "LOCK_RELEASE":
        this.timeline.apply(msg.op);
        this.fire({
          kind: "LOCK_RELEASED",
          peers: this.peerList(),
          clipId: msg.clipId,
          userId: msg.op.userId,
        });
        return;
      case "PONG": {
        const rtt = Date.now() - msg.clientTime;
        this.smoothedRtt =
          this.smoothedRtt === 0 ? rtt : this.smoothedRtt * 0.7 + rtt * 0.3;
        this.fire({ kind: "LATENCY", peers: this.peerList(), rttMs: rtt });
        return;
      }
      case "ERROR":
        this.log(`[CollabClient] server error ${msg.code}: ${msg.message}`);
        this.fire({
          kind: "ERROR",
          peers: this.peerList(),
          code: msg.code,
          reason: msg.message,
        });
        return;
      case "HELLO":
      case "JOIN":
      case "LEAVE":
      case "STATE_REQUEST":
      case "LOCK_REQUEST":
      case "PING":
        return;
    }
  }

  private onSocketClose(code: number, reason: string): void {
    this.log(`[CollabClient] socket closed ${code} ${reason}`);
    this.teardownSocket();
    this.fire({ kind: "DISCONNECTED", peers: this.peerList(), reason });
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const base = this.opts.reconnectBaseMs ?? 250;
    const max = this.opts.reconnectMaxMs ?? 10_000;
    const attempt = this.reconnectAttempt;
    const delay = Math.min(max, base * Math.pow(2, Math.min(attempt, 10)));
    const jitter = Math.random() * 0.25 * delay;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay + jitter);
  }

  private startPingLoop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.socket || !this.socket.isOpen()) return;
      this.lastPingSent = Date.now();
      const msg: PingMessage = {
        kind: "PING",
        seq: ++this.seq,
        from: this.opts.userId,
        projectId: this.opts.projectId,
        pingId: `${this.opts.userId}-${this.lastPingSent}`,
        clientTime: this.lastPingSent,
      };
      this.send(msg);
    }, 3000);
  }

  private teardownSocket(): void {
    for (const u of this.socketUnsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.socketUnsubs = [];
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    this.socketEvents = null;
  }

  private peerList(): PeerInfo[] {
    return Array.from(this.peers.values()).map((p) => ({ ...p }));
  }

  private fire(event: CollabClientEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listener errors never break the client */
      }
    }
  }

  private log(line: string): void {
    if (this.opts.logger) this.opts.logger(line);
  }
}

// ── Browser WebSocket adapter ─────────────────────────────────────────────

/**
 * Lightweight adapter that wraps the browser WebSocket API to conform to
 * the `CollaborationSocket` / `CollaborationSocketEvents` interfaces.
 *
 * Intentionally tolerant of partial-browser-API environments (e.g. SSR):
 * if `WebSocket` is not defined, `connect` throws with a clear message.
 */
export const BrowserWebSocketAdapter = {
  connect(
    url: string,
  ): { socket: CollaborationSocket; events: CollaborationSocketEvents } {
    if (typeof WebSocket === "undefined") {
      throw new Error(
        "BrowserWebSocketAdapter.connect: WebSocket is not available in this environment",
      );
    }
    const ws = new WebSocket(url);
    const id = `ws-${Math.random().toString(36).slice(2, 8)}`;
    const messageHandlers = new Set<(m: CollabMessage) => void>();
    const closeHandlers = new Set<(code: number, reason: string) => void>();
    const errorHandlers = new Set<(err: Error) => void>();

    ws.addEventListener("message", (evt) => {
      try {
        const parsed = JSON.parse(String(evt.data)) as CollabMessage;
        for (const h of messageHandlers) h(parsed);
      } catch (err) {
        for (const h of errorHandlers) {
          h(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    ws.addEventListener("close", (evt) => {
      for (const h of closeHandlers) h(evt.code, evt.reason);
    });
    ws.addEventListener("error", () => {
      for (const h of errorHandlers) h(new Error("websocket-error"));
    });

    const socket: CollaborationSocket = {
      id,
      send(m) {
        ws.send(JSON.stringify(m));
      },
      close(code, reason) {
        try {
          ws.close(code, reason);
        } catch {
          /* ignore */
        }
      },
      isOpen() {
        return ws.readyState === WebSocket.OPEN;
      },
    };
    const events: CollaborationSocketEvents = {
      onMessage(h) {
        messageHandlers.add(h);
        return () => messageHandlers.delete(h);
      },
      onClose(h) {
        closeHandlers.add(h);
        return () => closeHandlers.delete(h);
      },
      onError(h) {
        errorHandlers.add(h);
        return () => errorHandlers.delete(h);
      },
    };
    return { socket, events };
  },
};

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * A minimal in-memory transport — useful for tests and for running a
 * server and client in the same process without a network.
 */
export function createInMemoryPair(id = "mem"): {
  clientSide: { socket: CollaborationSocket; events: CollaborationSocketEvents };
  serverSide: { socket: CollaborationSocket; events: CollaborationSocketEvents };
} {
  type Handler<T> = (v: T) => void;
  const mk = () => {
    const open = true;
    const msgH = new Set<Handler<CollabMessage>>();
    const closeH = new Set<Handler<{ code: number; reason: string }>>();
    const errH = new Set<Handler<Error>>();
    return { open, msgH, closeH, errH };
  };
  const a = mk();
  const b = mk();

  const makeSide = (
    self: ReturnType<typeof mk>,
    other: ReturnType<typeof mk>,
    sideId: string,
  ): { socket: CollaborationSocket; events: CollaborationSocketEvents } => {
    const socket: CollaborationSocket = {
      id: `${id}-${sideId}`,
      send(m) {
        if (!self.open || !other.open) return;
        // Queue micro-task to better emulate network asynchrony.
        Promise.resolve().then(() => {
          if (!other.open) return;
          for (const h of other.msgH) h(m);
        });
      },
      close(code = 1000, reason = "closed") {
        if (!self.open) return;
        self.open = false;
        for (const h of self.closeH) h({ code, reason });
        // Also inform the other side that we disconnected.
        if (other.open) {
          other.open = false;
          for (const h of other.closeH) h({ code, reason });
        }
      },
      isOpen() {
        return self.open;
      },
    };
    const events: CollaborationSocketEvents = {
      onMessage(h) {
        self.msgH.add(h);
        return () => self.msgH.delete(h);
      },
      onClose(h) {
        const wrap = (v: { code: number; reason: string }) => h(v.code, v.reason);
        self.closeH.add(wrap);
        return () => self.closeH.delete(wrap);
      },
      onError(h) {
        self.errH.add(h);
        return () => self.errH.delete(h);
      },
    };
    return { socket, events };
  };

  return {
    clientSide: makeSide(a, b, "client"),
    serverSide: makeSide(b, a, "server"),
  };
}

/** Helpful predicate — does this op target a currently-locked clip? */
export function opTouchesLockedClip(
  timeline: CRDTTimeline,
  op: TimelineOperation,
  me: UserId,
): boolean {
  const clipId = operationTarget(op);
  if (!clipId) return false;
  const holder = timeline.getClipLock(clipId);
  return !!holder && holder !== me;
}

export default CollaborationServer;
