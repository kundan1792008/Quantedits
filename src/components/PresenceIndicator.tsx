/**
 * PresenceIndicator — Real-time collaborator presence UI components
 *
 * Renders cursor flags, avatar bubbles, editing-status badges, and a
 * minimap showing all collaborators' positions along the timeline ruler.
 * Designed for the Quantedits dark-theme editor (bg #0D0D11, border #1E1E2E).
 *
 * Sub-components exported:
 *   CursorFlag         – coloured flag pinned at a timeline position
 *   AvatarBubble       – circular avatar with initials, hover tooltip
 *   EditingStatusBadge – "UserX is editing Clip N" pill badge
 *   TimelineMinimap    – horizontal bar with all cursor dots (clickable)
 *   PresenceIndicator  – default export: orchestrates all of the above
 */

"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { EditorInfo } from "../services/CollaborationServer";

// ── Types ─────────────────────────────────────────────────────────────────

interface PresenceIndicatorProps {
  editors: EditorInfo[];
  durationSec: number;
  currentUserId: string;
  onCursorClick?: (userId: string) => void;
}

interface CursorFlagProps {
  editor: EditorInfo;
  durationSec: number;
  containerWidthPx: number;
  isCurrentUser: boolean;
}

interface AvatarBubbleProps {
  editor: EditorInfo;
  size?: "sm" | "md" | "lg";
  showTooltip?: boolean;
  isCurrentUser: boolean;
  onClick?: () => void;
}

interface EditingStatusBadgeProps {
  editor: EditorInfo;
  clipLabel?: string;
}

interface TimelineMinimapProps {
  editors: EditorInfo[];
  durationSec: number;
  currentUserId: string;
  onCursorClick?: (userId: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function formatTimecode(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const frames = Math.floor((sec % 1) * 30);
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── CursorFlag ─────────────────────────────────────────────────────────────

export function CursorFlag({
  editor,
  durationSec,
  containerWidthPx,
  isCurrentUser,
}: CursorFlagProps) {
  const pct = durationSec > 0 ? (editor.cursorPositionSec / durationSec) * 100 : 0;
  const clampedPct = Math.min(Math.max(pct, 0), 100);
  const leftPx = (clampedPct / 100) * containerWidthPx;

  return (
    <motion.div
      className="absolute top-0 bottom-0 pointer-events-none"
      style={{ left: leftPx }}
      initial={{ opacity: 0, scaleY: 0 }}
      animate={{ opacity: 1, scaleY: 1 }}
      exit={{ opacity: 0, scaleY: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      layout
      layoutId={`cursor-${editor.userId}`}
    >
      {/* Vertical line */}
      <div
        className="absolute top-0 bottom-0 w-px"
        style={{
          background: isCurrentUser
            ? `linear-gradient(to bottom, ${editor.color}, transparent)`
            : editor.color,
          opacity: isCurrentUser ? 0.5 : 0.85,
        }}
      />
      {/* Flag label */}
      <motion.div
        className="absolute top-0 left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-sm rounded-tl-none text-[10px] font-medium whitespace-nowrap select-none"
        style={{
          background: editor.color,
          color: "#0D0D11",
          transformOrigin: "top left",
        }}
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.1, type: "spring", stiffness: 500, damping: 30 }}
      >
        <span>{editor.userName}</span>
        {!isCurrentUser && (
          <span className="opacity-70">{formatTimecode(editor.cursorPositionSec)}</span>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── AvatarBubble ───────────────────────────────────────────────────────────

export function AvatarBubble({
  editor,
  size = "md",
  showTooltip = true,
  isCurrentUser,
  onClick,
}: AvatarBubbleProps) {
  const [hovered, setHovered] = useState(false);

  const sizeClass = {
    sm: "w-6 h-6 text-[9px]",
    md: "w-8 h-8 text-[11px]",
    lg: "w-10 h-10 text-[13px]",
  }[size];

  const lastSeenSec = Math.round((Date.now() - editor.lastSeen) / 1000);
  const isOnline = lastSeenSec < 15;

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <motion.button
        className={`relative ${sizeClass} rounded-full flex items-center justify-center font-bold cursor-pointer flex-shrink-0`}
        style={{
          background: hexToRgba(editor.color, 0.18),
          border: `2px solid ${editor.color}`,
          color: editor.color,
          outline: isCurrentUser ? `3px solid ${hexToRgba(editor.color, 0.4)}` : undefined,
          outlineOffset: isCurrentUser ? "2px" : undefined,
        }}
        onClick={onClick}
        whileHover={{ scale: 1.12 }}
        whileTap={{ scale: 0.95 }}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0, opacity: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 28 }}
      >
        {getInitials(editor.userName)}
        {/* Online indicator dot */}
        <span
          className="absolute bottom-0 right-0 w-2 h-2 rounded-full border border-[#0D0D11]"
          style={{ background: isOnline ? "#10B981" : "#6B7280" }}
        />
      </motion.button>

      {/* Tooltip */}
      <AnimatePresence>
        {showTooltip && hovered && (
          <motion.div
            className="absolute bottom-full left-1/2 mb-2 z-50 pointer-events-none"
            style={{ x: "-50%" }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
          >
            <div
              className="px-2.5 py-1.5 rounded-lg text-xs text-white whitespace-nowrap"
              style={{ background: "#1E1E2E", border: "1px solid #2E2E4E" }}
            >
              <div className="font-medium" style={{ color: editor.color }}>
                {editor.userName}
                {isCurrentUser && <span className="ml-1 text-[#6B7280]">(you)</span>}
              </div>
              <div className="text-[#6B7280] mt-0.5">
                {formatTimecode(editor.cursorPositionSec)}
              </div>
              <div className="text-[#6B7280]">
                {isOnline ? "● Online" : `Last seen ${lastSeenSec}s ago`}
              </div>
              {editor.lockedClips.size > 0 && (
                <div className="mt-0.5" style={{ color: editor.color }}>
                  Editing {editor.lockedClips.size} clip{editor.lockedClips.size > 1 ? "s" : ""}
                </div>
              )}
            </div>
            {/* Tooltip arrow */}
            <div
              className="absolute left-1/2 top-full w-0 h-0"
              style={{
                transform: "translateX(-50%)",
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderTop: "5px solid #1E1E2E",
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── EditingStatusBadge ─────────────────────────────────────────────────────

export function EditingStatusBadge({ editor, clipLabel }: EditingStatusBadgeProps) {
  const isActive = Date.now() - editor.lastSeen < 5000;

  return (
    <motion.div
      className="flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium"
      style={{
        background: hexToRgba(editor.color, 0.12),
        border: `1px solid ${hexToRgba(editor.color, 0.3)}`,
        color: editor.color,
      }}
      initial={{ opacity: 0, scale: 0.85, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.85, y: 4 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      {/* Pulsing dot */}
      <motion.span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: editor.color }}
        animate={isActive ? { opacity: [1, 0.4, 1] } : { opacity: 0.4 }}
        transition={
          isActive ? { repeat: Infinity, duration: 1.5, ease: "easeInOut" } : {}
        }
      />
      <span>
        <span className="font-semibold">{editor.userName}</span>
        {clipLabel ? ` is editing ${clipLabel}` : " is editing"}
      </span>
    </motion.div>
  );
}

// ── TimelineMinimap ────────────────────────────────────────────────────────

export function TimelineMinimap({
  editors,
  durationSec,
  currentUserId,
  onCursorClick,
}: TimelineMinimapProps) {
  const barRef = useRef<HTMLDivElement>(null);

  const handleBarClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!barRef.current || !onCursorClick) return;
      const rect = barRef.current.getBoundingClientRect();
      const xPct = (e.clientX - rect.left) / rect.width;
      if (durationSec <= 0) return;
      const clickedSec = xPct * durationSec;
      let closest: EditorInfo | null = null;
      let minDist = Infinity;
      for (const ed of editors) {
        const dist = Math.abs(ed.cursorPositionSec - clickedSec);
        if (dist < minDist) {
          minDist = dist;
          closest = ed;
        }
      }
      if (closest && minDist / durationSec < 0.05) {
        onCursorClick(closest.userId);
      }
    },
    [editors, durationSec, onCursorClick]
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[9px] font-mono text-[#3a3a5a] tracking-widest uppercase">
          Cursors
        </span>
        <span className="text-[9px] font-mono text-[#3a3a5a]">
          {formatTimecode(0)} — {formatTimecode(durationSec)}
        </span>
      </div>

      {/* Minimap bar */}
      <div
        ref={barRef}
        className="relative h-5 rounded overflow-hidden cursor-crosshair"
        style={{ background: "#0f0f18", border: "1px solid #1E1E2E" }}
        onClick={handleBarClick}
      >
        {/* Grid lines */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent, transparent 39px, #1E1E2E 39px, #1E1E2E 40px)",
          }}
        />

        {/* Editor cursor dots */}
        <AnimatePresence>
          {editors.map((editor) => {
            const pct =
              durationSec > 0 ? (editor.cursorPositionSec / durationSec) * 100 : 0;
            const clampedPct = Math.min(Math.max(pct, 0), 100);
            const isCurrentUser = editor.userId === currentUserId;

            return (
              <motion.button
                key={editor.userId}
                className="absolute top-1/2 rounded-full focus:outline-none"
                style={{
                  left: `${clampedPct}%`,
                  background: editor.color,
                  width: isCurrentUser ? 10 : 8,
                  height: isCurrentUser ? 10 : 8,
                  transform: "translate(-50%, -50%)",
                  boxShadow: isCurrentUser
                    ? `0 0 0 2px ${hexToRgba(editor.color, 0.4)}`
                    : undefined,
                  zIndex: isCurrentUser ? 2 : 1,
                }}
                title={`${editor.userName}: ${formatTimecode(editor.cursorPositionSec)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCursorClick?.(editor.userId);
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                whileHover={{ scale: 1.5 }}
                transition={{ type: "spring", stiffness: 600, damping: 30 }}
                layoutId={`minimap-cursor-${editor.userId}`}
                layout
              />
            );
          })}
        </AnimatePresence>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {editors.map((editor) => (
          <button
            key={editor.userId}
            className="flex items-center gap-1 text-[9px] hover:opacity-80 transition-opacity"
            style={{ color: editor.color }}
            onClick={() => onCursorClick?.(editor.userId)}
          >
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: editor.color }}
            />
            {editor.userName}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── PresenceIndicator (default export) ────────────────────────────────────

export default function PresenceIndicator({
  editors,
  durationSec,
  currentUserId,
  onCursorClick,
}: PresenceIndicatorProps) {
  const [showAvatarList, setShowAvatarList] = useState(false);
  const [containerWidth, setContainerWidth] = useState(800);

  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setContainerWidth(node.getBoundingClientRect().width);
  }, []);

  const otherEditors = editors.filter((e) => e.userId !== currentUserId);
  const currentEditor = editors.find((e) => e.userId === currentUserId);
  const editingEditors = editors.filter(
    (e) => e.lockedClips.size > 0 && e.userId !== currentUserId
  );
  const overflowCount = Math.max(0, editors.length - 4);
  const visibleAvatars = editors.slice(0, 4);

  return (
    <div className="flex flex-col gap-3" style={{ color: "#E2E2F0" }}>
      {/* ── Top bar: avatars + count ──────────────────────── */}
      <div
        className="flex items-center justify-between px-3 py-2 rounded-lg"
        style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
      >
        <div className="flex items-center gap-1.5">
          <AnimatePresence>
            {visibleAvatars.map((editor) => (
              <AvatarBubble
                key={editor.userId}
                editor={editor}
                size="sm"
                isCurrentUser={editor.userId === currentUserId}
                onClick={() => onCursorClick?.(editor.userId)}
              />
            ))}
          </AnimatePresence>
          {overflowCount > 0 && (
            <motion.button
              className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold"
              style={{
                background: "#1E1E2E",
                border: "1px solid #2E2E4E",
                color: "#7C3AED",
              }}
              onClick={() => setShowAvatarList((v) => !v)}
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
            >
              +{overflowCount}
            </motion.button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#3a3a5a] font-mono">
            {editors.length} editor{editors.length !== 1 ? "s" : ""}
          </span>
          {currentEditor && (
            <AvatarBubble
              editor={currentEditor}
              size="sm"
              isCurrentUser
              showTooltip={false}
            />
          )}
        </div>
      </div>

      {/* ── Expanded avatar list ───────────────────────────── */}
      <AnimatePresence>
        {showAvatarList && (
          <motion.div
            className="rounded-lg overflow-hidden"
            style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <div className="p-2 flex flex-col gap-1">
              {editors.map((editor) => (
                <button
                  key={editor.userId}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#1a1a2e] transition-colors text-left w-full"
                  onClick={() => {
                    onCursorClick?.(editor.userId);
                    setShowAvatarList(false);
                  }}
                >
                  <AvatarBubble
                    editor={editor}
                    size="sm"
                    showTooltip={false}
                    isCurrentUser={editor.userId === currentUserId}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate" style={{ color: editor.color }}>
                      {editor.userName}
                      {editor.userId === currentUserId && (
                        <span className="ml-1 text-[#6B7280] font-normal">(you)</span>
                      )}
                    </div>
                    <div className="text-[9px] text-[#3a3a5a] font-mono">
                      {formatTimecode(editor.cursorPositionSec)}
                    </div>
                  </div>
                  {editor.lockedClips.size > 0 && (
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{
                        background: hexToRgba(editor.color, 0.15),
                        color: editor.color,
                      }}
                    >
                      editing
                    </span>
                  )}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Editing status badges ──────────────────────────── */}
      <AnimatePresence>
        {editingEditors.length > 0 && (
          <motion.div
            className="flex flex-wrap gap-1.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {editingEditors.map((editor) => (
              <EditingStatusBadge key={editor.userId} editor={editor} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Timeline minimap ──────────────────────────────── */}
      <div
        className="rounded-lg p-3"
        style={{ background: "#0D0D11", border: "1px solid #1E1E2E" }}
      >
        <TimelineMinimap
          editors={editors}
          durationSec={durationSec}
          currentUserId={currentUserId}
          onCursorClick={onCursorClick}
        />
      </div>

      {/* ── Cursor flags overlay (must be placed inside a relative timeline container) */}
      {/* This ref-measured div provides width for flag positioning calculations */}
      <div
        ref={measureRef}
        className="relative h-8 rounded overflow-hidden"
        style={{ background: "#0f0f18", border: "1px solid #1E1E2E" }}
        aria-label="Cursor flags"
      >
        <AnimatePresence>
          {otherEditors.map((editor) => (
            <CursorFlag
              key={editor.userId}
              editor={editor}
              durationSec={durationSec}
              containerWidthPx={containerWidth}
              isCurrentUser={false}
            />
          ))}
          {currentEditor && (
            <CursorFlag
              key={currentEditor.userId}
              editor={currentEditor}
              durationSec={durationSec}
              containerWidthPx={containerWidth}
              isCurrentUser
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
