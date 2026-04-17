"use client";

/**
 * SocialValidationPreview
 * ───────────────────────
 *
 * Pre-export widget that tells the creator how many views their video
 * is predicted to get — the social-validation motivator from issue #14.
 */

import { motion } from "framer-motion";
import { Eye, Heart, MessageSquare, Share2, TrendingUp } from "lucide-react";

import type { PredictionResult } from "@/services/CreationAddiction";

interface SocialValidationPreviewProps {
  prediction: PredictionResult;
  /** 1.0 for baseline, >1.0 when a streak/boost is active. */
  boostMultiplier?: number;
}

export default function SocialValidationPreview({
  prediction,
  boostMultiplier = 1,
}: SocialValidationPreviewProps) {
  const boosted = boostMultiplier > 1;
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-500/15 via-violet-500/10 to-transparent p-4 backdrop-blur"
    >
      <header className="flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-indigo-300" />
        <h3 className="text-sm font-semibold text-white">Predicted performance</h3>
        {boosted && (
          <span className="ml-auto rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-300">
            {boostMultiplier.toFixed(1)}× boost
          </span>
        )}
      </header>

      <p className="mt-3 text-sm text-white/80">{prediction.summary}</p>

      <div className="mt-3 flex items-end gap-3">
        <motion.div
          key={prediction.predictedViews}
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="text-3xl font-semibold text-white"
        >
          ~{prediction.shortPreview}
        </motion.div>
        <div className="pb-1 text-xs text-white/60">
          <span className="font-mono">{prediction.lowViews.toLocaleString()}</span>
          <span className="mx-1">–</span>
          <span className="font-mono">{prediction.highViews.toLocaleString()}</span>
          <span className="ml-1">views</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <EngagementStat
          icon={<Heart className="h-3.5 w-3.5 text-rose-300" />}
          label="Likes"
          value={prediction.engagement.likes}
        />
        <EngagementStat
          icon={<MessageSquare className="h-3.5 w-3.5 text-sky-300" />}
          label="Comments"
          value={prediction.engagement.comments}
        />
        <EngagementStat
          icon={<Share2 className="h-3.5 w-3.5 text-emerald-300" />}
          label="Shares"
          value={prediction.engagement.shares}
        />
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-white/40">
        <Eye className="h-3 w-3" />
        Predictions update as you polish — finish editing to unlock the full boost.
      </div>
    </motion.section>
  );
}

function EngagementStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-lg bg-white/5 p-2">
      <div className="flex items-center gap-1 text-white/60">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <div className="mt-1 text-sm font-semibold text-white">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
