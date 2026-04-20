import {
  createDefaultTracks,
  type Clip,
  type Track,
} from "@/engine/TimelineRenderer";

export interface AssemblyHookSignal {
  id: string;
  title: string;
  startTimeSec: number;
  endTimeSec: number;
  confidence: number;
}

export interface AutoAssemblerInput {
  timelineId: string;
  fileName: string;
  durationSec: number;
  fileSizeMB: number;
  prompt?: string;
  hooks?: AssemblyHookSignal[];
}

export interface AssemblySegment {
  id: string;
  startSec: number;
  endSec: number;
  sourceStartSec: number;
  sourceEndSec: number;
  lane: "PRIMARY" | "BROLL" | "TEXT" | "EFFECT" | "AUDIO";
  label: string;
  reason: string;
  confidence: number;
}

export interface PredictiveAssemblyPlan {
  timelineId: string;
  sourceDurationSec: number;
  targetDurationSec: number;
  pacingProfile: "RAPID" | "BALANCED" | "CINEMATIC";
  silenceReductionPct: number;
  jumpCutCadenceSec: number;
  audioBed: string;
  summary: string;
  intent: string;
  hooks: AssemblyHookSignal[];
  segments: AssemblySegment[];
  tracks: Track[];
}

export const DEFAULT_DURATION_SEC = 45;
const SYNTHETIC_HOOK_ANCHORS = [0.06, 0.28, 0.56, 0.84] as const;
const PACING_FACTORS: Record<PredictiveAssemblyPlan["pacingProfile"], number> = {
  RAPID: 0.22,
  BALANCED: 0.31,
  CINEMATIC: 0.42,
};
const SEGMENT_LENGTHS: Record<PredictiveAssemblyPlan["pacingProfile"], number> = {
  RAPID: 2.4,
  BALANCED: 3.4,
  CINEMATIC: 5.5,
};
const JUMP_CUT_CADENCE: Record<PredictiveAssemblyPlan["pacingProfile"], number> = {
  RAPID: 1.9,
  BALANCED: 3.1,
  CINEMATIC: 4.8,
};
const SILENCE_REMOVAL_BASE = 28;
const SILENCE_REMOVAL_PER_HOOK = 6;
const SILENCE_REMOVAL_FILESIZE_STEP_MB = 40;
const MIN_SILENCE_REMOVAL_PCT = 24;
const MAX_SILENCE_REMOVAL_PCT = 72;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseTimecodeToSeconds(value: string): number {
  const parts = value
    .split(":")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return 0;
}

export function estimateDurationSeconds(label?: string): number {
  if (!label) return DEFAULT_DURATION_SEC;

  const hourMatch = label.match(/(\d+(?:\.\d+)?)\s*hr/i);
  if (hourMatch) {
    return Math.round(Number.parseFloat(hourMatch[1]) * 3600);
  }

  const minuteMatch = label.match(/(\d+(?:\.\d+)?)\s*min/i);
  if (minuteMatch) {
    return Math.round(Number.parseFloat(minuteMatch[1]) * 60);
  }

  const secondMatch = label.match(/(\d+(?:\.\d+)?)\s*s/i);
  if (secondMatch) {
    return Math.round(Number.parseFloat(secondMatch[1]));
  }

  return DEFAULT_DURATION_SEC;
}

function inferIntent(fileName: string, prompt?: string): string {
  const seed = `${fileName} ${prompt ?? ""}`.toLowerCase();

  if (seed.includes("launch") || seed.includes("product")) {
    return "product launch recap";
  }

  if (seed.includes("travel") || seed.includes("trip")) {
    return "travel highlight story";
  }

  if (seed.includes("podcast") || seed.includes("interview")) {
    return "insight-driven talking-head edit";
  }

  if (seed.includes("tutorial") || seed.includes("how to")) {
    return "educational how-to cut";
  }

  return "creator highlight recap";
}

function inferPacingProfile(
  durationSec: number,
  hookCount: number,
  prompt?: string,
): PredictiveAssemblyPlan["pacingProfile"] {
  const normalizedPrompt = prompt?.toLowerCase() ?? "";
  if (
    normalizedPrompt.includes("cinematic") ||
    normalizedPrompt.includes("documentary")
  ) {
    return "CINEMATIC";
  }

  if (hookCount >= 4 || durationSec > 180) {
    return "RAPID";
  }

  return "BALANCED";
}

function getAudioBed(intent: string, pacingProfile: PredictiveAssemblyPlan["pacingProfile"]): string {
  if (pacingProfile === "RAPID") {
    return `High-energy pulse bed for ${intent}`;
  }

  if (pacingProfile === "CINEMATIC") {
    return `Wide stereo underscore for ${intent}`;
  }

  return `Mid-tempo rhythm bed for ${intent}`;
}

function normalizeHooks(
  durationSec: number,
  hooks: AssemblyHookSignal[],
): AssemblyHookSignal[] {
  if (hooks.length > 0) {
    return [...hooks]
      .sort((a, b) => b.confidence - a.confidence || a.startTimeSec - b.startTimeSec)
      .slice(0, 4)
      .map((hook, index) => ({
        ...hook,
        id: `${hook.id}-normalized-${index}`,
        startTimeSec: clamp(hook.startTimeSec, 0, Math.max(durationSec - 1, 0)),
        endTimeSec: clamp(
          Math.max(hook.endTimeSec, hook.startTimeSec + 1),
          hook.startTimeSec + 1,
          durationSec,
        ),
      }));
  }

  return SYNTHETIC_HOOK_ANCHORS.map((anchor, index) => {
    const startTimeSec = Math.round(durationSec * anchor);

    return {
      id: `synthetic-hook-${index}`,
      title:
        index === 0
          ? "Cold open reveal"
          : index === SYNTHETIC_HOOK_ANCHORS.length - 1
            ? "Loop-safe closer"
            : `Momentum beat ${index}`,
      startTimeSec,
      endTimeSec: clamp(startTimeSec + 2, startTimeSec + 1, durationSec),
      confidence: clamp(82 - index * 6, 58, 92),
    };
  });
}

function computeTailDurationSec(
  sourceDurationSec: number,
  sourceEndSec: number,
): number {
  return Math.max(0, sourceDurationSec - sourceEndSec);
}

function buildSourceWindows(
  sourceDurationSec: number,
  segmentCount: number,
  hooks: AssemblyHookSignal[],
): Array<{ startSec: number; endSec: number; emphasis: string; confidence: number }> {
  const windows: Array<{
    startSec: number;
    endSec: number;
    emphasis: string;
    confidence: number;
  }> = [];
  const sourceStep = sourceDurationSec / Math.max(segmentCount, 1);

  for (let index = 0; index < segmentCount; index += 1) {
    const hook = hooks[index % hooks.length];
    const anchor = hook?.startTimeSec ?? index * sourceStep;
    const windowLength = clamp(sourceStep * 0.82, 2.5, 14);
    const startSec = clamp(anchor - windowLength * 0.35, 0, sourceDurationSec - 1);
    const endSec = clamp(startSec + windowLength, startSec + 1, sourceDurationSec);

    windows.push({
      startSec,
      endSec,
      emphasis:
        index === 0
          ? "hook"
          : index === segmentCount - 1
            ? "payoff"
            : index % 3 === 0
              ? "proof"
              : "story",
      confidence: clamp((hook?.confidence ?? 74) - index * 1.5, 52, 95),
    });
  }

  return windows;
}

function createClip(
  trackId: string,
  clipId: string,
  startSec: number,
  endSec: number,
  trimInSec: number,
  trimOutSec: number,
  label: string,
  properties: Clip["properties"],
): Clip {
  return {
    id: clipId,
    trackId,
    startSec,
    endSec,
    trimInSec,
    trimOutSec,
    properties,
    keyframes: [],
    label,
  };
}

export class AutoAssembler {
  buildPlan(input: AutoAssemblerInput): PredictiveAssemblyPlan {
    const sourceDurationSec = clamp(input.durationSec, 8, 14_400);
    const hooks = normalizeHooks(sourceDurationSec, input.hooks ?? []);
    const intent = inferIntent(input.fileName, input.prompt);
    const pacingProfile = inferPacingProfile(
      sourceDurationSec,
      hooks.length,
      input.prompt,
    );
    const pacingFactor = PACING_FACTORS[pacingProfile];
    const targetDurationSec = clamp(
      Math.round(sourceDurationSec * pacingFactor),
      14,
      75,
    );
    const segmentLength = SEGMENT_LENGTHS[pacingProfile];
    const segmentCount = Math.max(4, Math.round(targetDurationSec / segmentLength));
    const silenceReductionPct = clamp(
      SILENCE_REMOVAL_BASE +
        hooks.length * SILENCE_REMOVAL_PER_HOOK +
        Math.round(input.fileSizeMB / SILENCE_REMOVAL_FILESIZE_STEP_MB),
      MIN_SILENCE_REMOVAL_PCT,
      MAX_SILENCE_REMOVAL_PCT,
    );
    const jumpCutCadenceSec = JUMP_CUT_CADENCE[pacingProfile];
    const audioBed = getAudioBed(intent, pacingProfile);
    const sourceWindows = buildSourceWindows(
      sourceDurationSec,
      segmentCount,
      hooks,
    );
    const tracks = createDefaultTracks(input.timelineId);
    const primaryTrack = tracks.find((track) =>
      track.id.endsWith("track-video-1"),
    );
    const brollTrack = tracks.find((track) =>
      track.id.endsWith("track-video-2"),
    );
    const audioTrack = tracks.find((track) =>
      track.id.endsWith("track-audio-1"),
    );
    const musicTrack = tracks.find((track) =>
      track.id.endsWith("track-audio-2"),
    );
    const textTrack = tracks.find((track) => track.id.endsWith("track-text"));
    const effectTrack = tracks.find((track) =>
      track.id.endsWith("track-effects"),
    );
    const segments: AssemblySegment[] = [];

    if (
      !primaryTrack ||
      !brollTrack ||
      !audioTrack ||
      !musicTrack ||
      !textTrack ||
      !effectTrack
    ) {
      throw new Error("Default timeline tracks are incomplete");
    }

    let cursor = 0;
    for (let index = 0; index < sourceWindows.length; index += 1) {
      const sourceWindow = sourceWindows[index];
      const remaining = targetDurationSec - cursor;
      if (remaining <= 0.6) {
        break;
      }

      const minimumDuration = Math.min(1.4, remaining);
      const duration = clamp(
        Math.min(segmentLength, remaining),
        minimumDuration,
        remaining,
      );
      const endSec = cursor + duration;
      const clipId = `auto-primary-${index}`;

      primaryTrack.clips.push(
        createClip(
          primaryTrack.id,
          clipId,
          cursor,
          endSec,
          sourceWindow.startSec,
          computeTailDurationSec(sourceDurationSec, sourceWindow.endSec),
          `Scene ${index + 1}`,
          {
            opacity: 1,
            scale: index === 0 ? 1.06 : 1,
            positionX: 0,
            positionY: 0,
            rotation: 0,
          },
        ),
      );

      segments.push({
        id: clipId,
        startSec: cursor,
        endSec,
        sourceStartSec: sourceWindow.startSec,
        sourceEndSec: sourceWindow.endSec,
        lane: "PRIMARY",
        label: `Scene ${index + 1}`,
        reason: `Condenses ${sourceWindow.emphasis} material into a ${duration.toFixed(1)}s beat`,
        confidence: sourceWindow.confidence,
      });

      if ((index + 1) % 3 === 0 && endSec - cursor > 1.2) {
        const brollStart = clamp(cursor + 0.3, cursor, endSec - 0.5);
        const brollEnd = clamp(endSec - 0.25, brollStart + 0.4, endSec);
        const brollId = `auto-broll-${index}`;

        brollTrack.clips.push(
          createClip(
            brollTrack.id,
            brollId,
            brollStart,
            brollEnd,
            sourceWindow.startSec,
            computeTailDurationSec(sourceDurationSec, sourceWindow.endSec),
            `Support cut ${Math.floor(index / 3) + 1}`,
            {
              opacity: 0.92,
              scale: 1.04,
              positionX: 0,
              positionY: 0,
              rotation: 0,
            },
          ),
        );

        segments.push({
          id: brollId,
          startSec: brollStart,
          endSec: brollEnd,
          sourceStartSec: sourceWindow.startSec,
          sourceEndSec: sourceWindow.endSec,
          lane: "BROLL",
          label: `Support cut ${Math.floor(index / 3) + 1}`,
          reason: "Adds visual variety before the next predicted attention dip",
          confidence: clamp(sourceWindow.confidence - 3, 50, 92),
        });
      }

      cursor = endSec;
    }

    hooks.forEach((hook, index) => {
      const hookStart = clamp(index * jumpCutCadenceSec * 1.8, 0.2, targetDurationSec - 1.2);
      const hookEnd = clamp(hookStart + 1.6, hookStart + 0.8, targetDurationSec);
      const textId = `auto-hook-text-${index}`;
      const effectId = `auto-hook-fx-${index}`;

      textTrack.clips.push(
        createClip(
          textTrack.id,
          textId,
          hookStart,
          hookEnd,
          0,
          0,
          hook.title,
          {
            text: hook.title,
            fontSize: index === 0 ? 44 : 34,
            fontFamily: "Inter, sans-serif",
            color: "#ffffff",
            backgroundColor: index === 0 ? "#7C3AED" : "#13131A",
            borderRadius: 12,
            opacity: 1,
            scale: 1,
            positionX: 0,
            positionY: index === 0 ? -170 : -150,
            rotation: 0,
          },
        ),
      );

      effectTrack.clips.push(
        createClip(
          effectTrack.id,
          effectId,
          clamp(hookStart - 0.15, 0, targetDurationSec - 0.1),
          hookEnd,
          0,
          0,
          `Pulse ${index + 1}`,
          {
            opacity: 0.8,
            scale: 1.12,
            positionX: 0,
            positionY: 0,
            rotation: 0,
          },
        ),
      );

      segments.push({
        id: textId,
        startSec: hookStart,
        endSec: hookEnd,
        sourceStartSec: hook.startTimeSec,
        sourceEndSec: hook.endTimeSec,
        lane: "TEXT",
        label: hook.title,
        reason: "Front-loads a clear viewer promise at a predicted falloff checkpoint",
        confidence: hook.confidence,
      });
    });

    audioTrack.clips.push(
      createClip(
        audioTrack.id,
        "auto-dialog-bed",
        0,
        targetDurationSec,
        0,
        0,
        "Dialog spine",
        {
          volume: 1,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          rotation: 0,
        },
      ),
    );

    musicTrack.clips.push(
      createClip(
        musicTrack.id,
        "auto-music-bed",
        0,
        targetDurationSec,
        0,
        0,
        audioBed,
        {
          volume: pacingProfile === "CINEMATIC" ? 0.45 : 0.62,
          opacity: 1,
          scale: 1,
          positionX: 0,
          positionY: 0,
          rotation: 0,
        },
      ),
    );

    const summary = `Condenses ${Math.round(sourceDurationSec)}s of footage into a ${targetDurationSec}s ${intent} using ${primaryTrack.clips.length} primary cuts, ${textTrack.clips.length} hook overlays, and a ${pacingProfile.toLowerCase()} pacing profile.`;

    return {
      timelineId: input.timelineId,
      sourceDurationSec,
      targetDurationSec,
      pacingProfile,
      silenceReductionPct,
      jumpCutCadenceSec,
      audioBed,
      summary,
      intent,
      hooks,
      segments: segments.sort((a, b) => a.startSec - b.startSec),
      tracks,
    };
  }
}

export const autoAssembler = new AutoAssembler();
