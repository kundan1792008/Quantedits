"use client";

/**
 * DraftAnxietyBanner
 * ──────────────────
 *
 * Appears at the top of the editor when the user has one or more drafts
 * that have been idle for 24+ hours.  Copy escalates with the oldest
 * draft's tier — the same ladder used by the push service.
 */

import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Clock } from "lucide-react";

import type { DraftRecord } from "@/services/CreationAddiction";

interface DraftAnxietyBannerProps {
  drafts: DraftRecord[];
  now: number;
  onOpenDraft?: (id: string) => void;
  onDismiss?: () => void;
}

const MS_PER_HOUR = 60 * 60 * 1_000;

export default function DraftAnxietyBanner({
  drafts,
  now,
  onOpenDraft,
  onDismiss,
}: DraftAnxietyBannerProps) {
  const idle = drafts
    .filter((d) => !d.published && now - d.lastEditedAt >= 24 * MS_PER_HOUR)
    .sort((a, b) => a.lastEditedAt - b.lastEditedAt);

  return (
    <AnimatePresence>
      {idle.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          className="flex items-center gap-3 rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-500/15 via-rose-500/10 to-transparent px-4 py-2.5 backdrop-blur"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
          <div className="flex-1 text-xs text-white">
            <span className="font-semibold">
              {idle.length === 1
                ? "You have an unfinished project."
                : `You have ${idle.length} unfinished projects.`}
            </span>{" "}
            <span className="text-white/70">Your audience is waiting.</span>
            <ul className="mt-1 space-y-0.5 text-[11px] text-white/60">
              {idle.slice(0, 3).map((d) => {
                const hours = Math.floor((now - d.lastEditedAt) / MS_PER_HOUR);
                return (
                  <li
                    key={d.id}
                    className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-white/5"
                  >
                    <Clock className="h-3 w-3 text-white/40" />
                    <span className="truncate">{d.title}</span>
                    <span className="ml-auto font-mono text-white/50">
                      {hours}h idle
                    </span>
                    {onOpenDraft && (
                      <button
                        type="button"
                        onClick={() => onOpenDraft(d.id)}
                        className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white hover:bg-white/20"
                      >
                        Resume
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg bg-white/5 px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-white/60 hover:bg-white/10"
            >
              Later
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
