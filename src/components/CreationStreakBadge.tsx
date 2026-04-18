"use client";

/**
 * StreakBadge
 * ───────────
 *
 * Displays the user's current daily creation streak, the boost multiplier
 * it unlocks, and the next milestone they're chasing.  The UI is
 * deliberately celebratory — flames, gradients, and an animated counter
 * to reinforce the habit loop described in issue #14.
 */

import { motion } from "framer-motion";
import { Flame } from "lucide-react";

import type { StreakState } from "@/services/CreationAddiction";

interface StreakBadgeProps {
  state: StreakState;
  boost: number;
}

const MILESTONES = [3, 7, 14, 30, 60, 90];

export default function StreakBadge({ state, boost }: StreakBadgeProps) {
  const nextMilestone = MILESTONES.find((m) => state.current < m) ?? 365;
  const daysToNext = Math.max(0, nextMilestone - state.current);
  const ringFill =
    state.current === 0
      ? 0
      : Math.min(1, state.current / nextMilestone);
  const dashTotal = 2 * Math.PI * 22;
  const dashOffset = dashTotal * (1 - ringFill);

  return (
    <motion.div
      layout
      className="flex items-center gap-3 rounded-2xl border border-white/10 bg-gradient-to-br from-rose-500/20 via-orange-500/15 to-yellow-500/10 p-3 backdrop-blur"
    >
      <div className="relative h-14 w-14 shrink-0">
        <svg viewBox="0 0 50 50" className="h-full w-full -rotate-90">
          <circle
            cx="25"
            cy="25"
            r="22"
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="3"
          />
          <motion.circle
            cx="25"
            cy="25"
            r="22"
            fill="none"
            stroke="url(#streak-gradient)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={dashTotal}
            initial={false}
            animate={{ strokeDashoffset: dashOffset }}
            transition={{ type: "spring", stiffness: 90, damping: 25 }}
          />
          <defs>
            <linearGradient id="streak-gradient" x1="0" x2="1">
              <stop offset="0" stopColor="#fbbf24" />
              <stop offset="1" stopColor="#f43f5e" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <Flame className="h-5 w-5 text-amber-300" />
        </div>
      </div>

      <div className="flex-1">
        <div className="flex items-center gap-2">
          <motion.span
            key={state.current}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-lg font-semibold text-white"
          >
            {state.current}
          </motion.span>
          <span className="text-xs text-white/60">day streak</span>
          {boost > 1 && (
            <span className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-200">
              {boost.toFixed(1)}× boost
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-white/60">
          {state.current === 0
            ? "Save a draft today to start your streak."
            : daysToNext === 0
              ? `🎉 You just hit ${nextMilestone} days!`
              : `${daysToNext} day${daysToNext === 1 ? "" : "s"} to unlock ${boostCopy(nextMilestone)}`}
        </p>
        {state.longest > state.current && (
          <p className="text-[10px] uppercase tracking-widest text-white/35">
            Longest ever: {state.longest} days
          </p>
        )}
      </div>
    </motion.div>
  );
}

function boostCopy(milestone: number): string {
  if (milestone >= 30) return "3× visibility";
  if (milestone >= 14) return "2.1× visibility";
  if (milestone >= 7) return "1.5× visibility";
  return "1.2× visibility";
}
