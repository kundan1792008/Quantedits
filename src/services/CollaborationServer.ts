/**
 * CollaborationServer — Real-time multi-editor session management
 *
 * Manages collaborative editing sessions for the Quantedits timeline.
 * Designed to be driven by a Next.js API route (App Router) via HTTP polling
 * or a WebSocket upgrade handler. The class itself is pure TypeScript with
 * no runtime dependencies beyond Node's built-in EventEmitter pattern.
 *
 * Wiring with Next.js App Router (WebSocket upgrade):
 *   // app/api/collaborate/route.ts
 *   import { collaborationServer } from "@/services/CollaborationServer";
 *   export function GET(req: Request) {
 *     // Upgrade to WebSocket using the native Bun/Node adapter, then call
 *     // collaborationServer.handleWebSocketMessage(sessionId, userId, data)
 *   }
 *
 * Features:
 *   - Session lifecycle: create / join / leave
 *   - Cursor position broadcasting
 *   - Clip locking / unlocking
 *   - CRDT operation fan-out
 *   - Stale editor cleanup (>30 s idle)
 *   - Event emitter for server-side subscribers
 *   - 8 distinct avatar colours auto-assigned on join
 */

import type { CRDTOperation } from "./CRDTTimeline";

// ── Constants ─────────────────────────────────────────────────────────────

/** 8 visually distinct hex colours for editor avatars / cursor flags. */
export const EDITOR_COLORS: readonly string[] = [
  "#7C3AED", // violet
  "#06B6D4", // cyan
  "#EC4899", // pink
  "#F59E0B", // amber
  "#10B981", // emerald
  "#EF4444", // red
  "#3B82F6", // blue
  "#A78BFA", // lavender
] as const;

const MAX_EDITORS_PER_SESSION = 8;
const MIN_EDITORS_PER_SESSION = 1;
const STALE_EDITOR_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────

export interface EditorInfo {
  userId: string;
  userName: string;
  /** Hex colour assigned on join */
  color: string;
  /** Timeline cursor position in seconds */
  cursorPositionSec: number;
  /** Wall-clock ms of last activity */
  lastSeen: number;
  /** Clip IDs currently locked by this editor */
  lockedClips: Set<string>;
}

export interface CollaborationSession {
  projectId: string;
  sessionId: string;
  /** userId → EditorInfo */
  editors: Map<string, EditorInfo>;
  /** clipId → userId who holds the lock */
  lockedClips: Map<string, string>;
  createdAt: number;
}

// ── Event Types ───────────────────────────────────────────────────────────

export type CollaborationEventType =
  | "editorJoined"
  | "editorLeft"
  | "operationBroadcast"
  | "cursorMoved"
  | "clipLocked"
  | "clipUnlocked"
  | "sessionCreated"
  | "sessionClosed";

export interface EditorJoinedEvent {
  type: "editorJoined";
  sessionId: string;
  editor: EditorInfo;
}

export interface EditorLeftEvent {
  type: "editorLeft";
  sessionId: string;
  userId: string;
}

export interface OperationBroadcastEvent {
  type: "operationBroadcast";
  sessionId: string;
  operation: CRDTOperation;
  excludeUserId?: string;
}

export interface CursorMovedEvent {
  type: "cursorMoved";
  sessionId: string;
  userId: string;
  positionSec: number;
}

export interface ClipLockedEvent {
  type: "clipLocked";
  sessionId: string;
  userId: string;
  clipId: string;
}

export interface ClipUnlockedEvent {
  type: "clipUnlocked";
  sessionId: string;
  userId: string;
  clipId: string;
}

export interface SessionCreatedEvent {
  type: "sessionCreated";
  sessionId: string;
  projectId: string;
}

export interface SessionClosedEvent {
  type: "sessionClosed";
  sessionId: string;
}

export type CollaborationEvent =
  | EditorJoinedEvent
  | EditorLeftEvent
  | OperationBroadcastEvent
  | CursorMovedEvent
  | ClipLockedEvent
  | ClipUnlockedEvent
  | SessionCreatedEvent
  | SessionClosedEvent;

type EventListener<T extends CollaborationEvent = CollaborationEvent> = (event: T) => void;

// ── ID Generation ─────────────────────────────────────────────────────────

function generateSessionId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "ses_";
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ── CollaborationServer Class ─────────────────────────────────────────────

export class CollaborationServer {
  /** sessionId → CollaborationSession */
  private sessions: Map<string, CollaborationSession> = new Map();

  /** Registered event listeners keyed by event type */
  private listeners: Map<string, Set<EventListener>> = new Map();

  /** NodeJS-style interval handle for stale-editor cleanup */
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupInterval();
  }

  // ── Event Emitter ──────────────────────────────────────────────────────

  on<T extends CollaborationEvent>(
    eventType: CollaborationEventType,
    listener: EventListener<T>
  ): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener as EventListener);
  }

  off<T extends CollaborationEvent>(
    eventType: CollaborationEventType,
    listener: EventListener<T>
  ): void {
    this.listeners.get(eventType)?.delete(listener as EventListener);
  }

  emit(event: CollaborationEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[CollaborationServer] Listener threw for event "${event.type}":`, err);
      }
    }
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────

  /**
   * Create a new collaboration session for the given project.
   * Returns the new sessionId.
   */
  createSession(projectId: string): string {
    const sessionId = generateSessionId();
    const session: CollaborationSession = {
      projectId,
      sessionId,
      editors: new Map(),
      lockedClips: new Map(),
      createdAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    this.emit({ type: "sessionCreated", sessionId, projectId });
    return sessionId;
  }

  /**
   * Add an editor to an existing session.
   * Assigns a unique colour from EDITOR_COLORS.
   * Throws if session not found or at capacity.
   */
  joinSession(sessionId: string, userId: string, userName: string): EditorInfo {
    const session = this.requireSession(sessionId);

    // Idempotent — return existing info if already joined
    if (session.editors.has(userId)) {
      const existing = session.editors.get(userId)!;
      existing.lastSeen = Date.now();
      return existing;
    }

    const activeEditors = session.editors.size;
    if (activeEditors >= MAX_EDITORS_PER_SESSION) {
      throw new Error(
        `Session ${sessionId} is at maximum capacity (${MAX_EDITORS_PER_SESSION} editors).`
      );
    }

    const usedColors = new Set(
      Array.from(session.editors.values()).map((e) => e.color)
    );
    const color =
      EDITOR_COLORS.find((c) => !usedColors.has(c)) ?? EDITOR_COLORS[activeEditors % EDITOR_COLORS.length];

    const editor: EditorInfo = {
      userId,
      userName,
      color,
      cursorPositionSec: 0,
      lastSeen: Date.now(),
      lockedClips: new Set(),
    };

    session.editors.set(userId, editor);
    this.emit({ type: "editorJoined", sessionId, editor });

    return editor;
  }

  /**
   * Remove an editor from a session and release all their clip locks.
   */
  leaveSession(sessionId: string, userId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const editor = session.editors.get(userId);
    if (!editor) return;

    // Release all locks held by this editor
    for (const clipId of editor.lockedClips) {
      session.lockedClips.delete(clipId);
      this.emit({ type: "clipUnlocked", sessionId, userId, clipId });
    }

    session.editors.delete(userId);
    this.emit({ type: "editorLeft", sessionId, userId });

    // Close session if completely empty
    if (session.editors.size === 0) {
      this.closeSession(sessionId);
    }
  }

  /** Permanently remove a session and all its state. */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emit({ type: "sessionClosed", sessionId });
  }

  // ── Operation Fan-out ──────────────────────────────────────────────────

  /**
   * Broadcast a CRDT operation to all editors in the session.
   * Pass `excludeUserId` to skip the originating editor.
   *
   * In a real WebSocket setup, wire this event to your WS send loop:
   *   server.on("operationBroadcast", ({ operation, excludeUserId }) => {
   *     for (const [uid, socket] of socketMap) {
   *       if (uid !== excludeUserId) socket.send(JSON.stringify(operation));
   *     }
   *   });
   */
  broadcastOperation(
    sessionId: string,
    op: CRDTOperation,
    excludeUserId?: string
  ): void {
    const session = this.requireSession(sessionId);

    // Touch the sender's lastSeen
    const sender = session.editors.get(op.userId);
    if (sender) sender.lastSeen = Date.now();

    this.emit({ type: "operationBroadcast", sessionId, operation: op, excludeUserId });
  }

  // ── Cursor Tracking ────────────────────────────────────────────────────

  /**
   * Update a collaborator's cursor position and broadcast to peers.
   */
  updateCursor(sessionId: string, userId: string, positionSec: number): void {
    const session = this.requireSession(sessionId);
    const editor = session.editors.get(userId);
    if (!editor) throw new Error(`User ${userId} is not in session ${sessionId}.`);

    editor.cursorPositionSec = positionSec;
    editor.lastSeen = Date.now();

    this.emit({ type: "cursorMoved", sessionId, userId, positionSec });
  }

  // ── Clip Locking ───────────────────────────────────────────────────────

  /**
   * Attempt to lock a clip for exclusive editing.
   * Returns `true` if the lock was granted, `false` if held by another editor.
   */
  lockClip(sessionId: string, userId: string, clipId: string): boolean {
    const session = this.requireSession(sessionId);
    const editor = this.requireEditor(session, userId);

    const currentHolder = session.lockedClips.get(clipId);

    // Already locked by this user — idempotent
    if (currentHolder === userId) return true;

    // Locked by someone else
    if (currentHolder !== undefined) return false;

    session.lockedClips.set(clipId, userId);
    editor.lockedClips.add(clipId);
    editor.lastSeen = Date.now();

    this.emit({ type: "clipLocked", sessionId, userId, clipId });
    return true;
  }

  /**
   * Release a clip lock.
   * Only the lock holder (or any admin) can unlock.
   */
  unlockClip(sessionId: string, userId: string, clipId: string): void {
    const session = this.requireSession(sessionId);
    const currentHolder = session.lockedClips.get(clipId);

    if (currentHolder === undefined) return; // Already unlocked

    if (currentHolder !== userId) {
      throw new Error(
        `User ${userId} cannot unlock clip ${clipId} — it is locked by ${currentHolder}.`
      );
    }

    session.lockedClips.delete(clipId);

    const editor = session.editors.get(userId);
    if (editor) {
      editor.lockedClips.delete(clipId);
      editor.lastSeen = Date.now();
    }

    this.emit({ type: "clipUnlocked", sessionId, userId, clipId });
  }

  /**
   * Force-release a lock (e.g. when a clip is deleted or an editor disconnects unexpectedly).
   */
  forceUnlockClip(sessionId: string, clipId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const holder = session.lockedClips.get(clipId);
    if (!holder) return;

    session.lockedClips.delete(clipId);
    const editor = session.editors.get(holder);
    if (editor) editor.lockedClips.delete(clipId);

    this.emit({ type: "clipUnlocked", sessionId, userId: holder, clipId });
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  getSession(sessionId: string): CollaborationSession | undefined {
    return this.sessions.get(sessionId);
  }

  getEditors(sessionId: string): EditorInfo[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return Array.from(session.editors.values());
  }

  /** Returns the EditorInfo for one user in a session. */
  getEditor(sessionId: string, userId: string): EditorInfo | undefined {
    return this.sessions.get(sessionId)?.editors.get(userId);
  }

  /** Returns which user holds a lock on `clipId`, or undefined. */
  getLockHolder(sessionId: string, clipId: string): string | undefined {
    return this.sessions.get(sessionId)?.lockedClips.get(clipId);
  }

  /** All active sessions keyed by sessionId. */
  getAllSessions(): Map<string, CollaborationSession> {
    return new Map(this.sessions);
  }

  /** Number of active sessions. */
  getSessionCount(): number {
    return this.sessions.size;
  }

  // ── WebSocket Message Handler ──────────────────────────────────────────

  /**
   * Handle a raw JSON message from a WebSocket client.
   * Wire this to your WS `message` event handler.
   *
   * Supported message shapes:
   *   { type: "JOIN", sessionId, userId, userName }
   *   { type: "LEAVE", sessionId, userId }
   *   { type: "OPERATION", sessionId, operation: CRDTOperation }
   *   { type: "CURSOR", sessionId, userId, positionSec }
   *   { type: "LOCK_CLIP", sessionId, userId, clipId }
   *   { type: "UNLOCK_CLIP", sessionId, userId, clipId }
   *
   * Returns a serialisable response object to send back to the caller.
   */
  handleWebSocketMessage(rawMessage: string): Record<string, unknown> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawMessage) as Record<string, unknown>;
    } catch {
      return { error: "Invalid JSON" };
    }

    const { type, sessionId, userId } = msg;

    if (typeof sessionId !== "string" || typeof userId !== "string") {
      return { error: "Missing sessionId or userId" };
    }

    switch (type) {
      case "JOIN": {
        const userName = typeof msg.userName === "string" ? msg.userName : String(userId);
        try {
          const editor = this.joinSession(sessionId, userId, userName);
          return { type: "JOINED", editor: this.serializeEditor(editor) };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }

      case "LEAVE": {
        this.leaveSession(sessionId, userId);
        return { type: "LEFT" };
      }

      case "OPERATION": {
        const op = msg.operation as CRDTOperation | undefined;
        if (!op) return { error: "Missing operation" };
        this.broadcastOperation(sessionId, op, userId);
        return { type: "OP_ACK", operationId: op.operationId };
      }

      case "CURSOR": {
        const positionSec = typeof msg.positionSec === "number" ? msg.positionSec : 0;
        try {
          this.updateCursor(sessionId, userId, positionSec);
          return { type: "CURSOR_ACK" };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }

      case "LOCK_CLIP": {
        const clipId = typeof msg.clipId === "string" ? msg.clipId : "";
        const granted = this.lockClip(sessionId, userId, clipId);
        return { type: "LOCK_RESULT", clipId, granted };
      }

      case "UNLOCK_CLIP": {
        const clipId = typeof msg.clipId === "string" ? msg.clipId : "";
        try {
          this.unlockClip(sessionId, userId, clipId);
          return { type: "UNLOCK_ACK", clipId };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }

      default:
        return { error: `Unknown message type: ${String(type)}` };
    }
  }

  // ── Stale Editor Cleanup ───────────────────────────────────────────────

  /**
   * Evict editors who haven't sent any activity in STALE_EDITOR_MS.
   * Called automatically every 15 seconds.
   */
  evictStaleEditors(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      for (const [userId, editor] of session.editors) {
        if (now - editor.lastSeen > STALE_EDITOR_MS) {
          this.leaveSession(sessionId, userId);
        }
      }
    }
  }

  private startCleanupInterval(): void {
    if (typeof setInterval !== "undefined") {
      this.cleanupInterval = setInterval(() => this.evictStaleEditors(), 15_000);
    }
  }

  /** Stop the background cleanup interval (call on server shutdown). */
  destroy(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
    this.listeners.clear();
  }

  // ── Private Utilities ──────────────────────────────────────────────────

  private requireSession(sessionId: string): CollaborationSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private requireEditor(session: CollaborationSession, userId: string): EditorInfo {
    const editor = session.editors.get(userId);
    if (!editor) {
      throw new Error(`User ${userId} is not in session ${session.sessionId}.`);
    }
    return editor;
  }

  /** Convert EditorInfo (which has Sets) to a plain JSON-safe object. */
  private serializeEditor(editor: EditorInfo): Record<string, unknown> {
    return {
      userId: editor.userId,
      userName: editor.userName,
      color: editor.color,
      cursorPositionSec: editor.cursorPositionSec,
      lastSeen: editor.lastSeen,
      lockedClips: Array.from(editor.lockedClips),
    };
  }

  // ── Session Diagnostics ────────────────────────────────────────────────

  /** Return a serialisable summary of all sessions (for health endpoints). */
  getHealthStatus(): Record<string, unknown> {
    const sessions: Record<string, unknown>[] = [];
    for (const [id, session] of this.sessions) {
      sessions.push({
        sessionId: id,
        projectId: session.projectId,
        editorCount: session.editors.size,
        lockedClipCount: session.lockedClips.size,
        createdAt: session.createdAt,
        editors: Array.from(session.editors.values()).map((e) => ({
          userId: e.userId,
          userName: e.userName,
          cursorPositionSec: e.cursorPositionSec,
          lastSeen: e.lastSeen,
        })),
      });
    }
    return {
      sessionCount: this.sessions.size,
      sessions,
      maxEditorsPerSession: MAX_EDITORS_PER_SESSION,
      minEditorsPerSession: MIN_EDITORS_PER_SESSION,
    };
  }
}

// ── Singleton Export ───────────────────────────────────────────────────────

/**
 * Module-level singleton for use in Next.js API routes.
 * In the App Router, import this singleton so that state is shared
 * across hot-reload boundaries via the Node.js module cache.
 */
const globalWithCollab = global as typeof globalThis & { _collabServer?: CollaborationServer };

if (!globalWithCollab._collabServer) {
  globalWithCollab._collabServer = new CollaborationServer();
}

export const collaborationServer: CollaborationServer = globalWithCollab._collabServer;
