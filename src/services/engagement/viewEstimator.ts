/**
 * View Estimator — predicts view counts for a new video, grounded in the
 * user's *real* prior published videos.
 *
 * Honest-by-design contract:
 *  - When the user has 0 prior videos, we return `median: null` and
 *    `confidence: "insufficient_data"`. The UI shows "No estimate available"
 *    rather than a fabricated number.
 *  - When the user has 1–2 prior videos, confidence is "low" and we widen
 *    the band substantially.
 *  - We always return a `methodology` string so the user can judge the
 *    number themselves.
 *  - We do NOT claim the platform's algorithm will deliver these views —
 *    we only project from the creator's own observed distribution.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { ViewEstimate } from "./types";

export interface ViewEstimateContext {
  /** Expected final duration of the new video in seconds. */
  durationSec?: number;
  /** Quality score (0..100) of the new video, if computed. */
  qualityScore?: number;
}

export class ViewEstimator {
  constructor(private readonly prisma: PrismaClient) {}

  async estimate(
    userId: string,
    context: ViewEstimateContext = {},
  ): Promise<ViewEstimate> {
    const history = await this.prisma.publishedVideo.findMany({
      where: { userId },
      select: { viewCount: true, durationSec: true, publishedAt: true },
      orderBy: { publishedAt: "desc" },
      take: 50,
    });

    if (history.length === 0) {
      return {
        median: null,
        low: null,
        high: null,
        confidence: "insufficient_data",
        sampleSize: 0,
        methodology:
          "No estimate available. Once you've published a few videos we can project a range from your own view history.",
      };
    }

    const sorted = history
      .map((h) => h.viewCount)
      .slice()
      .sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    const p25 = percentile(sorted, 0.25);
    const p75 = percentile(sorted, 0.75);
    const iqr = Math.max(1, p75 - p25);

    // Optional, modest adjustment by quality score. We never claim quality
    // determines the exact view count — just apply a small scalar and
    // document it in the methodology string.
    let qualityAdjustment = 1;
    if (context.qualityScore !== undefined) {
      // Map 0..100 quality to 0.8..1.2 multiplier with 70 as neutral.
      const q = Math.max(0, Math.min(100, context.qualityScore));
      qualityAdjustment = 0.8 + (q / 100) * 0.4;
    }

    const center = Math.round(median * qualityAdjustment);
    // Confidence band widens when sample size is small.
    const bandMultiplier =
      history.length >= 10 ? 1 : history.length >= 5 ? 1.5 : 2.2;
    const low = Math.max(0, Math.round(center - iqr * bandMultiplier));
    const high = Math.round(center + iqr * bandMultiplier);

    const confidence: ViewEstimate["confidence"] =
      history.length >= 10 ? "high" : history.length >= 3 ? "medium" : "low";

    const methodology =
      `Estimate based on your ${history.length} most recent published video${history.length === 1 ? "" : "s"}. ` +
      `Midpoint is the median view count` +
      (context.qualityScore !== undefined
        ? `, adjusted by your current quality score (${context.qualityScore}/100).`
        : ".") +
      ` The range is your historic interquartile spread, widened for small samples. ` +
      `This is a projection from your own videos — actual views depend on platform ranking and timing, which we don't control.`;

    return {
      median: center,
      low,
      high,
      confidence,
      sampleSize: history.length,
      methodology,
    };
  }
}

/** Linear-interpolation percentile over a sorted numeric array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}
