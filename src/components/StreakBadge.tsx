/**
 * StreakBadge — opt-in, neutral creation-day counter.
 *
 * Contract:
 *  - Shows an enable toggle when the user hasn't opted in. Hidden otherwise
 *    unless the user has an active streak they want to see.
 *  - Never claims the streak unlocks platform benefits or algorithm boosts.
 *  - Provides a Reset control so users are in charge of the number.
 */

"use client";

import { motion } from "framer-motion";
import { Flame, Info } from "lucide-react";
import type { StreakStatus } from "@/services/engagement/types";

export interface StreakBadgeProps {
  status: StreakStatus | null;
  loading?: boolean;
  onEnable?: () => void;
  onDisable?: () => void;
  onReset?: () => void;
}

export default function StreakBadge({
  status,
  loading,
  onEnable,
  onDisable,
  onReset,
}: StreakBadgeProps) {
  return (
    <section
      aria-label="Creation streak"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <Flame size={14} className="text-[#8888aa]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8888aa]">
          Creation streak
        </h3>
      </header>

      {loading && !status && (
        <p className="text-xs text-[#5a5a7a]">Loading…</p>
      )}

      {status && !status.enabled && (
        <div>
          <p className="text-xs text-[#B8B8D0] mb-2">
            Streak tracking is off. Turn it on to count consecutive days you
            create or edit a project. Turning it on doesn&apos;t affect your
            reach on Quanttube — it&apos;s just a personal tracker.
          </p>
          <button
            type="button"
            onClick={onEnable}
            className="text-[11px] font-semibold px-3 py-1.5 rounded text-white"
            style={{
              background: "linear-gradient(135deg, #7C3AED 0%, #06B6D4 100%)",
            }}
          >
            Enable streak tracker
          </button>
        </div>
      )}

      {status && status.enabled && (
        <>
          <div className="flex items-baseline gap-3 mb-2">
            <motion.span
              key={status.current}
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="text-4xl font-bold text-[#F97316]"
            >
              {status.current}
            </motion.span>
            <span className="text-sm text-[#8888aa]">
              day{status.current === 1 ? "" : "s"}
            </span>
            {status.countedToday && (
              <span
                className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded"
                style={{ background: "#10B98133", color: "#10B981" }}
              >
                Today counted
              </span>
            )}
          </div>
          <p className="text-[11px] text-[#8888aa]">
            Longest: {status.longest} day{status.longest === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={onDisable}
              className="text-[10px] text-[#8888aa] hover:text-[#E8E8F0] transition-colors"
            >
              Turn off
            </button>
            <span className="text-[#3a3a5a]">·</span>
            <button
              type="button"
              onClick={onReset}
              className="text-[10px] text-[#8888aa] hover:text-[#E8E8F0] transition-colors"
            >
              Reset to 0
            </button>
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[10px] text-[#5a5a7a]">
            <Info size={10} className="shrink-0 mt-0.5" />
            <span>
              Streaks are a personal habit aid. They have no effect on how
              Quanttube ranks or distributes your videos.
            </span>
          </p>
        </>
      )}
    </section>
  );
}
