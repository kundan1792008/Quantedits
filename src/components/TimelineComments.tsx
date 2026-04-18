"use client";

/**
 * TimelineComments — Timestamp-pinned comment system for collaborative editing
 *
 * Features:
 *   - Pin comments to specific timestamps on the timeline
 *   - Threaded replies on comments
 *   - @mention collaborators (with dropdown autocomplete)
 *   - Resolve / un-resolve comment threads
 *   - Click timeline ruler to open "add comment" at that position
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageCircle,
  X,
  Check,
  CornerDownRight,
  AtSign,
  Send,
  RotateCcw,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Comment {
  id: string;
  projectId: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  timestampSec: number;
  content: string;
  createdAt: number; // epoch ms
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface CommentThread {
  id: string;
  rootComment: Comment;
  replies: Comment[];
  isResolved: boolean;
}

export interface Collaborator {
  userId: string;
  userName: string;
  color: string;
}

interface TimelineCommentsProps {
  projectId: string;
  currentUserId: string;
  currentUserName: string;
  durationSec: number;
  threads: CommentThread[];
  collaborators?: Collaborator[];
  onAddComment: (timestampSec: number, content: string) => void;
  onReply: (threadId: string, content: string) => void;
  onResolve: (threadId: string) => void;
  onUnresolve: (threadId: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function formatRelative(epochMs: number): string {
  const diffSec = Math.floor((Date.now() - epochMs) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/** Render comment text with @mention highlighting */
function renderCommentContent(content: string): React.ReactNode {
  const parts = content.split(/(@\w+)/g);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <span key={i} style={{ color: "#06B6D4", fontWeight: 600 }}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// ── MentionInput ──────────────────────────────────────────────────────────

interface MentionInputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: () => void;
  collaborators: Collaborator[];
  placeholder?: string;
  disabled?: boolean;
}

function MentionInput({
  value,
  onChange,
  onSubmit,
  collaborators,
  placeholder = "Add a comment…",
  disabled = false,
}: MentionInputProps) {
  const [mentionSearch, setMentionSearch] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const filteredCollabs = mentionSearch !== null
    ? collaborators.filter((c) =>
        c.userName.toLowerCase().includes(mentionSearch.toLowerCase()),
      )
    : [];

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    onChange(v);

    // Detect @ trigger
    const cursor = e.target.selectionStart ?? v.length;
    const beforeCursor = v.slice(0, cursor);
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setMentionSearch(atMatch[1]);
      setMentionStart(cursor - atMatch[0].length);
    } else {
      setMentionSearch(null);
    }
  };

  const insertMention = (collab: Collaborator) => {
    const before = value.slice(0, mentionStart);
    const after = value.slice(textareaRef.current?.selectionStart ?? value.length);
    const newVal = `${before}@${collab.userName} ${after}`;
    onChange(newVal);
    setMentionSearch(null);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (mentionSearch !== null && filteredCollabs.length > 0) {
        insertMention(filteredCollabs[0]);
      } else {
        onSubmit();
      }
    }
    if (e.key === "Escape") {
      setMentionSearch(null);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        style={{
          width: "100%",
          background: "#0a0a12",
          border: "1px solid #2a2a3e",
          borderRadius: "6px",
          color: "#e0e0f0",
          fontSize: "12px",
          padding: "8px 10px",
          resize: "none",
          outline: "none",
          fontFamily: "inherit",
          lineHeight: 1.5,
        }}
      />
      <AnimatePresence>
        {mentionSearch !== null && filteredCollabs.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            style={{
              position: "absolute",
              bottom: "calc(100% + 4px)",
              left: 0,
              background: "#12121e",
              border: "1px solid #2a2a3e",
              borderRadius: "6px",
              overflow: "hidden",
              zIndex: 50,
              minWidth: "160px",
            }}
          >
            {filteredCollabs.map((c) => (
              <button
                key={c.userId}
                onClick={() => insertMention(c)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "6px 10px",
                  background: "transparent",
                  border: "none",
                  color: "#e0e0f0",
                  fontSize: "12px",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "#1e1e2e";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <span
                  style={{
                    width: "20px",
                    height: "20px",
                    borderRadius: "50%",
                    background: c.color,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "9px",
                    color: "#fff",
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {getInitials(c.userName)}
                </span>
                <span style={{ color: "#06B6D4" }}>@{c.userName}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── CommentPin ────────────────────────────────────────────────────────────

interface CommentPinProps {
  thread: CommentThread;
  durationSec: number;
  isActive: boolean;
  onClick: () => void;
}

function CommentPin({ thread, durationSec, isActive, onClick }: CommentPinProps) {
  const pct = Math.min(
    100,
    Math.max(0, (thread.rootComment.timestampSec / durationSec) * 100),
  );
  const color = thread.isResolved ? "#3a3a5a" : thread.rootComment.authorColor;
  const replyCount = thread.replies.length;

  return (
    <motion.button
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={{ scale: 1.2 }}
      onClick={onClick}
      title={`${thread.rootComment.authorName}: ${thread.rootComment.content}`}
      style={{
        position: "absolute",
        left: `${pct}%`,
        bottom: 0,
        transform: "translateX(-50%)",
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
        zIndex: isActive ? 20 : 10,
      }}
    >
      {/* Vertical line */}
      <div
        style={{
          width: "2px",
          height: "16px",
          background: color,
          margin: "0 auto",
          opacity: thread.isResolved ? 0.4 : 1,
        }}
      />
      {/* Bubble */}
      <div
        style={{
          width: "22px",
          height: "22px",
          borderRadius: "50% 50% 50% 0",
          transform: "rotate(-45deg)",
          background: isActive ? color : `${color}cc`,
          border: `2px solid ${isActive ? "#fff" : color}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: isActive ? `0 0 8px ${color}80` : "none",
        }}
      >
        <span
          style={{
            transform: "rotate(45deg)",
            fontSize: "9px",
            color: "#fff",
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          {replyCount > 0 ? replyCount + 1 : <MessageCircle size={8} />}
        </span>
      </div>
    </motion.button>
  );
}

// ── CommentThreadPanel ────────────────────────────────────────────────────

interface CommentThreadPanelProps {
  thread: CommentThread;
  currentUserId: string;
  currentUserName: string;
  collaborators: Collaborator[];
  onReply: (content: string) => void;
  onResolve: () => void;
  onUnresolve: () => void;
  onClose: () => void;
}

function CommentThreadPanel({
  thread,
  currentUserId,
  currentUserName,
  collaborators,
  onReply,
  onResolve,
  onUnresolve,
  onClose,
}: CommentThreadPanelProps) {
  const [replyText, setReplyText] = useState("");

  const handleSubmitReply = () => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    onReply(trimmed);
    setReplyText("");
  };

  const allComments = [thread.rootComment, ...thread.replies];

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      style={{
        position: "absolute",
        right: "8px",
        top: "8px",
        width: "280px",
        background: "#0f0f1a",
        border: "1px solid #2a2a3e",
        borderRadius: "10px",
        overflow: "hidden",
        zIndex: 40,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #1e1e2e",
          gap: "8px",
        }}
      >
        <MessageCircle size={13} color="#7C3AED" />
        <span style={{ fontSize: "11px", color: "#7a7aaa", fontFamily: "monospace" }}>
          {formatTimecode(thread.rootComment.timestampSec)}
        </span>
        <div style={{ flex: 1 }} />
        {thread.isResolved ? (
          <button
            onClick={onUnresolve}
            title="Re-open thread"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px" }}
          >
            <RotateCcw size={13} color="#5a5a7a" />
          </button>
        ) : (
          <button
            onClick={onResolve}
            title="Resolve thread"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px" }}
          >
            <Check size={13} color="#10B981" />
          </button>
        )}
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", padding: "2px" }}
        >
          <X size={13} color="#5a5a7a" />
        </button>
      </div>

      {/* Resolved banner */}
      {thread.isResolved && (
        <div
          style={{
            padding: "4px 12px",
            background: "#10B98115",
            borderBottom: "1px solid #10B98130",
            fontSize: "10px",
            color: "#10B981",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <Check size={10} />
          Resolved{thread.rootComment.resolvedBy ? ` by ${thread.rootComment.resolvedBy}` : ""}
        </div>
      )}

      {/* Comment list */}
      <div style={{ maxHeight: "240px", overflowY: "auto", padding: "8px 0" }}>
        {allComments.map((comment, idx) => (
          <div
            key={comment.id}
            style={{
              padding: "6px 12px",
              display: "flex",
              gap: "8px",
              alignItems: "flex-start",
            }}
          >
            {idx > 0 && (
              <CornerDownRight
                size={10}
                color="#3a3a5a"
                style={{ flexShrink: 0, marginTop: "6px" }}
              />
            )}
            {/* Avatar */}
            <div
              style={{
                width: idx === 0 ? "24px" : "18px",
                height: idx === 0 ? "24px" : "18px",
                borderRadius: "50%",
                background: comment.authorColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: idx === 0 ? "9px" : "8px",
                color: "#fff",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {getInitials(comment.authorName)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "6px",
                  marginBottom: "2px",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    color: comment.authorColor,
                  }}
                >
                  {comment.authorName}
                </span>
                <span style={{ fontSize: "10px", color: "#3a3a5a" }}>
                  {formatRelative(comment.createdAt)}
                </span>
              </div>
              <p
                style={{
                  fontSize: "11px",
                  color: "#c0c0d8",
                  margin: 0,
                  lineHeight: 1.5,
                  wordBreak: "break-word",
                }}
              >
                {renderCommentContent(comment.content)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Reply input */}
      {!thread.isResolved && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid #1e1e2e",
            display: "flex",
            gap: "6px",
            alignItems: "flex-end",
          }}
        >
          <div style={{ flex: 1 }}>
            <MentionInput
              value={replyText}
              onChange={setReplyText}
              onSubmit={handleSubmitReply}
              collaborators={collaborators}
              placeholder={`Reply as ${currentUserName}…`}
            />
          </div>
          <button
            onClick={handleSubmitReply}
            disabled={!replyText.trim()}
            style={{
              background: replyText.trim() ? "#7C3AED" : "#2a2a3e",
              border: "none",
              borderRadius: "6px",
              width: "28px",
              height: "28px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: replyText.trim() ? "pointer" : "default",
              flexShrink: 0,
            }}
          >
            <Send size={12} color={replyText.trim() ? "#fff" : "#5a5a7a"} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ── NewCommentPanel ───────────────────────────────────────────────────────

interface NewCommentPanelProps {
  timestampSec: number;
  currentUserName: string;
  collaborators: Collaborator[];
  onSubmit: (content: string) => void;
  onClose: () => void;
}

function NewCommentPanel({
  timestampSec,
  currentUserName,
  collaborators,
  onSubmit,
  onClose,
}: NewCommentPanelProps) {
  const [text, setText] = useState("");

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      style={{
        position: "absolute",
        right: "8px",
        top: "8px",
        width: "260px",
        background: "#0f0f1a",
        border: "1px solid #7C3AED50",
        borderRadius: "10px",
        overflow: "hidden",
        zIndex: 40,
        boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #1e1e2e",
          gap: "6px",
        }}
      >
        <AtSign size={12} color="#7C3AED" />
        <span style={{ fontSize: "11px", color: "#7a7aaa", fontFamily: "monospace" }}>
          {formatTimecode(timestampSec)}
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{ background: "none", border: "none", cursor: "pointer", padding: "2px" }}
        >
          <X size={13} color="#5a5a7a" />
        </button>
      </div>
      <div style={{ padding: "10px 12px" }}>
        <p style={{ fontSize: "11px", color: "#5a5a7a", margin: "0 0 8px 0" }}>
          Comment as <span style={{ color: "#c0c0d8" }}>{currentUserName}</span>
        </p>
        <MentionInput
          value={text}
          onChange={setText}
          onSubmit={handleSubmit}
          collaborators={collaborators}
          placeholder="Type a comment… (Enter to post)"
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
          <button
            onClick={handleSubmit}
            disabled={!text.trim()}
            style={{
              background: text.trim() ? "#7C3AED" : "#2a2a3e",
              border: "none",
              borderRadius: "6px",
              padding: "5px 12px",
              fontSize: "11px",
              color: text.trim() ? "#fff" : "#5a5a7a",
              cursor: text.trim() ? "pointer" : "default",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <Send size={11} />
            Post
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ── TimelineComments (default export) ────────────────────────────────────

export default function TimelineComments({
  projectId: _projectId,
  currentUserId,
  currentUserName,
  durationSec,
  threads,
  collaborators = [],
  onAddComment,
  onReply,
  onResolve,
  onUnresolve,
}: TimelineCommentsProps) {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [pendingTimestamp, setPendingTimestamp] = useState<number | null>(null);
  const rulerRef = useRef<HTMLDivElement>(null);

  // Close panels when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-comment-panel]") && !target.closest("[data-comment-pin]")) {
        setActiveThreadId(null);
        setPendingTimestamp(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleRulerClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!rulerRef.current) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const sec = Math.max(0, Math.min(durationSec, pct * durationSec));
      setPendingTimestamp(sec);
      setActiveThreadId(null);
    },
    [durationSec],
  );

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        background: "#0D0D11",
        borderTop: "1px solid #1E1E2E",
      }}
    >
      {/* ── Timeline ruler (click to add comment) ── */}
      <div
        ref={rulerRef}
        onClick={handleRulerClick}
        title="Click to add a comment at this timestamp"
        style={{
          position: "relative",
          height: "40px",
          cursor: "crosshair",
          borderBottom: "1px solid #1E1E2E",
          overflow: "visible",
        }}
      >
        {/* Ruler tick marks */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "flex-end",
            paddingBottom: "2px",
          }}
        >
          {Array.from({ length: 11 }, (_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                borderLeft: "1px solid #2a2a3e",
                height: "100%",
                display: "flex",
                alignItems: "flex-end",
                paddingBottom: "3px",
                paddingLeft: "2px",
              }}
            >
              <span style={{ fontSize: "9px", color: "#3a3a5a", fontFamily: "monospace" }}>
                {formatTimecode((i / 10) * durationSec)}
              </span>
            </div>
          ))}
        </div>

        {/* Comment pins */}
        {threads.map((thread) => (
          <div key={thread.id} data-comment-pin>
            <CommentPin
              thread={thread}
              durationSec={durationSec}
              isActive={activeThreadId === thread.id}
              onClick={() => {
                setActiveThreadId((prev) =>
                  prev === thread.id ? null : thread.id,
                );
                setPendingTimestamp(null);
              }}
            />
          </div>
        ))}

        {/* Pending new comment marker */}
        {pendingTimestamp !== null && (
          <motion.div
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            style={{
              position: "absolute",
              left: `${Math.min(100, (pendingTimestamp / durationSec) * 100)}%`,
              top: 0,
              bottom: 0,
              width: "2px",
              background: "#7C3AED",
              transformOrigin: "bottom",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      {/* ── Thread count bar ── */}
      <div
        style={{
          padding: "4px 12px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <MessageCircle size={11} color="#3a3a5a" />
        <span style={{ fontSize: "10px", color: "#3a3a5a", fontFamily: "monospace" }}>
          {threads.filter((t) => !t.isResolved).length} open
          {" · "}
          {threads.filter((t) => t.isResolved).length} resolved
        </span>
        <span style={{ fontSize: "10px", color: "#2a2a4a", marginLeft: "auto" }}>
          Click ruler to add comment
        </span>
      </div>

      {/* ── Floating panels ── */}
      <AnimatePresence>
        {activeThread && (
          <div key="thread-panel" data-comment-panel>
            <CommentThreadPanel
              thread={activeThread}
              currentUserId={currentUserId}
              currentUserName={currentUserName}
              collaborators={collaborators}
              onReply={(content) => onReply(activeThread.id, content)}
              onResolve={() => onResolve(activeThread.id)}
              onUnresolve={() => onUnresolve(activeThread.id)}
              onClose={() => setActiveThreadId(null)}
            />
          </div>
        )}
        {pendingTimestamp !== null && (
          <div key="new-panel" data-comment-panel>
            <NewCommentPanel
              timestampSec={pendingTimestamp}
              currentUserName={currentUserName}
              collaborators={collaborators}
              onSubmit={(content) => {
                onAddComment(pendingTimestamp, content);
                setPendingTimestamp(null);
              }}
              onClose={() => setPendingTimestamp(null)}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
