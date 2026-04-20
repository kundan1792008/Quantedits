import {
  estimateExportTimeSec,
  estimateFileSizeMB,
  type ExportFormat,
  type ExportResolution,
} from "@/services/ExportService";
import type { PredictiveAssemblyPlan } from "@/services/AutoAssembler";

export interface RetentionCheckpoint {
  id: string;
  timeSec: number;
  label: string;
  action: string;
  confidence: number;
}

export interface ExportRecommendation {
  format: ExportFormat;
  resolution: ExportResolution;
  fps: 24 | 30 | 60;
  quality: number;
  estimatedFileSizeMB: number;
  estimatedExportTimeSec: number;
  note: string;
}

export interface PredictiveOptimizationReport {
  retentionScore: number;
  pacingScore: number;
  hookCoverageScore: number;
  readinessLabel: string;
  checkpoints: RetentionCheckpoint[];
  exportRecommendation: ExportRecommendation;
}

const RETENTION_SCORE_WEIGHTS = {
  hookCoverage: 0.38,
  pacing: 0.34,
  silenceReduction: 0.28,
} as const;
const MIN_DURATION_FOR_4K_SEC = 240;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTimestamp(timeSec: number): string {
  const mins = Math.floor(timeSec / 60);
  const secs = Math.round(timeSec % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function buildCheckpoints(plan: PredictiveAssemblyPlan): RetentionCheckpoint[] {
  const checkpoints: RetentionCheckpoint[] = [
    {
      id: "checkpoint-cold-open",
      timeSec: 0,
      label: "Cold open",
      action: "Open on the strongest visual promise before the first spoken setup beat.",
      confidence: clamp(plan.hooks[0]?.confidence ?? 84, 60, 96),
    },
    {
      id: "checkpoint-3-sec",
      timeSec: clamp(3, 0, plan.targetDurationSec),
      label: "3-second hold",
      action: "Introduce a supporting cut or caption pulse to preserve momentum at the first drop-off window.",
      confidence: clamp(plan.silenceReductionPct + 20, 58, 93),
    },
    {
      id: "checkpoint-midpoint",
      timeSec: clamp(plan.targetDurationSec * 0.42, 0, plan.targetDurationSec),
      label: "Midpoint proof",
      action: "Swap to proof-oriented footage and reinforce the narrative payoff before fatigue sets in.",
      confidence: clamp(plan.jumpCutCadenceSec * 16, 55, 88),
    },
    {
      id: "checkpoint-loop",
      timeSec: clamp(plan.targetDurationSec - 2.4, 0, plan.targetDurationSec),
      label: "Loop closer",
      action: "End on a compact callback frame so the final beat can resolve cleanly into a replay.",
      confidence: clamp((plan.hooks.at(-1)?.confidence ?? 76) + 4, 58, 95),
    },
  ];

  return checkpoints
    .filter((checkpoint) => checkpoint.timeSec <= plan.targetDurationSec)
    .map((checkpoint) => ({
      ...checkpoint,
      label: `${formatTimestamp(checkpoint.timeSec)} · ${checkpoint.label}`,
    }));
}

function buildExportRecommendation(
  plan: PredictiveAssemblyPlan,
): ExportRecommendation {
  const resolution: ExportResolution =
    plan.sourceDurationSec > MIN_DURATION_FOR_4K_SEC ? "4k" : "1080p";
  const fps: 24 | 30 | 60 =
    plan.pacingProfile === "CINEMATIC"
      ? 24
      : plan.pacingProfile === "RAPID"
        ? 60
        : 30;
  const format: ExportFormat = "mp4";
  const quality = plan.pacingProfile === "RAPID" ? 84 : 78;
  const estimatedFileSizeMB = estimateFileSizeMB(
    plan.targetDurationSec,
    format,
    resolution,
    quality,
  );
  const estimatedExportTimeSec = estimateExportTimeSec(
    plan.targetDurationSec,
    resolution,
    fps,
  );

  return {
    format,
    resolution,
    fps,
    quality,
    estimatedFileSizeMB,
    estimatedExportTimeSec,
    note:
      plan.pacingProfile === "RAPID"
        ? "Biases for crisp motion and short-form delivery."
        : "Balances quality and turnaround for a ready-to-publish first pass.",
  };
}

export class AlgoOptimizer {
  optimize(plan: PredictiveAssemblyPlan): PredictiveOptimizationReport {
    const hookCoverageScore = clamp(
      62 + plan.hooks.length * 7,
      60,
      94,
    );
    const pacingScore = clamp(
      70 +
        Math.round(plan.targetDurationSec / Math.max(plan.jumpCutCadenceSec, 1)) -
        (plan.pacingProfile === "CINEMATIC" ? 4 : 0),
      68,
      95,
    );
    const retentionScore = clamp(
      Math.round(
        hookCoverageScore * RETENTION_SCORE_WEIGHTS.hookCoverage +
          pacingScore * RETENTION_SCORE_WEIGHTS.pacing +
          plan.silenceReductionPct * RETENTION_SCORE_WEIGHTS.silenceReduction,
      ),
      70,
      96,
    );

    return {
      retentionScore,
      pacingScore,
      hookCoverageScore,
      readinessLabel:
        retentionScore >= 88
          ? "Ready for zero-click export"
          : "Needs one creative pass before export",
      checkpoints: buildCheckpoints(plan),
      exportRecommendation: buildExportRecommendation(plan),
    };
  }
}

export const algoOptimizer = new AlgoOptimizer();
