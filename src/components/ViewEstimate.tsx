/**
 * ViewEstimate — honest pre-export view projection.
 *
 * Contract:
 *  - Displays `null` state clearly ("No estimate available") when we don't
 *    have enough historical data.
 *  - Shows the median AND the confidence band so users see the uncertainty.
 *  - Always renders the methodology so users can judge the number.
 *  - Label is "Estimate" — never "You'll get X views".
 */

"use client";

import { motion } from "framer-motion";
import { TrendingUp, Info } from "lucide-react";
import type { ViewEstimate as ViewEstimateData } from "@/services/engagement/types";

export interface ViewEstimateProps {
  estimate: ViewEstimateData | null;
  loading?: boolean;
}

function formatCompact(n: number): string {
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export default function ViewEstimate({
  estimate,
  loading,
}: ViewEstimateProps) {
  return (
    <section
      aria-label="Pre-publish view estimate"
      className="rounded-xl p-4"
      style={{ background: "#13131A", border: "1px solid #1E1E2E" }}
    >
      <header className="flex items-center gap-2 mb-3">
        <TrendingUp size={14} className="text-[#8888aa]" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8888aa]">
          View estimate
        </h3>
      </header>

      {loading && !estimate && (
        <p className="text-xs text-[#5a5a7a]">Computing…</p>
      )}

      {estimate && estimate.confidence === "insufficient_data" && (
        <>
          <p className="text-xs text-[#B8B8D0] font-semibold mb-1">
            No estimate available
          </p>
          <p className="text-[11px] text-[#8888aa]">{estimate.methodology}</p>
        </>
      )}

      {estimate && estimate.median !== null && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-baseline gap-2 mb-2"
          >
            <span className="text-3xl font-bold text-[#06B6D4]">
              ~{formatCompact(estimate.median)}
            </span>
            <span className="text-xs text-[#8888aa]">estimated views</span>
          </motion.div>
          {estimate.low !== null && estimate.high !== null && (
            <p className="text-[11px] text-[#8888aa] mb-2">
              Typical range:{" "}
              <span className="font-mono">
                {formatCompact(estimate.low)} – {formatCompact(estimate.high)}
              </span>
            </p>
          )}
          <p className="text-[10px] uppercase tracking-widest text-[#5a5a7a] mb-2">
            Confidence: {estimate.confidence} · based on {estimate.sampleSize}{" "}
            prior video{estimate.sampleSize === 1 ? "" : "s"}
          </p>
          <p className="flex items-start gap-1.5 text-[10px] text-[#5a5a7a]">
            <Info size={10} className="shrink-0 mt-0.5" />
            <span>{estimate.methodology}</span>
          </p>
        </>
      )}
    </section>
  );
}
