/**
 * POST /api/v1/edits/generate-timeline
 *
 * Accepts a natural-language prompt and returns a structured JSON timeline
 * compatible with standard video-editor timeline formats.
 *
 * The timeline includes:
 *  - Video cut segments
 *  - B-roll placeholder slots
 *  - Audio beat markers
 *
 * Authentication: Quantmail JWT (enforced by middleware).
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

// ── Request schema ────────────────────────────────────────────────────────

const GenerateTimelineSchema = z.object({
  prompt: z
    .string()
    .min(3, "Prompt must be at least 3 characters")
    .max(500, "Prompt must not exceed 500 characters"),
  projectId: z.string().cuid("projectId must be a valid CUID").optional(),
  durationSec: z
    .number()
    .int()
    .min(5)
    .max(600)
    .optional()
    .default(60),
});

export type GenerateTimelineRequest = z.infer<typeof GenerateTimelineSchema>;

// ── Timeline data types ───────────────────────────────────────────────────

interface VideoCut {
  id: string;
  trackIndex: number;
  startSec: number;
  endSec: number;
  label: string;
  filter?: string;
  broll?: BrollPlaceholder;
}

interface BrollPlaceholder {
  id: string;
  hint: string;
  durationSec: number;
}

interface AudioBeat {
  id: string;
  timeSec: number;
  type: "drop" | "buildup" | "transition" | "ambient";
  bpm?: number;
}

interface TimelineData {
  version: "1.0";
  prompt: string;
  durationSec: number;
  fps: number;
  cuts: VideoCut[];
  audioBeatMarkers: AudioBeat[];
  metadata: Record<string, unknown>;
}

// ── Generator ─────────────────────────────────────────────────────────────

/**
 * Deterministic AI-stub: builds a timeline from the prompt.
 *
 * Production: replace with a call to the AI inference service.
 */
function generateTimelineFromPrompt(
  prompt: string,
  durationSec: number,
): TimelineData {
  const lowerPrompt = prompt.toLowerCase();

  // Derive style/mood from prompt keywords
  const isCyberpunk =
    lowerPrompt.includes("cyberpunk") || lowerPrompt.includes("neon");
  const isCinematic =
    lowerPrompt.includes("cinematic") || lowerPrompt.includes("film");
  const isEnergetic =
    lowerPrompt.includes("energetic") ||
    lowerPrompt.includes("hype") ||
    lowerPrompt.includes("fast");

  const bpm = isEnergetic ? 128 : isCyberpunk ? 110 : 90;
  const beatIntervalSec = 60 / bpm;

  // Build video cuts
  const cutDurationSec = isEnergetic ? 2 : isCinematic ? 6 : 4;
  const cuts: VideoCut[] = [];
  let cursor = 0;
  let cutIdx = 0;

  while (cursor < durationSec) {
    const end = Math.min(cursor + cutDurationSec, durationSec);
    const isBrollSlot = cutIdx % 3 === 2;

    const cut: VideoCut = {
      id: `cut-${cutIdx}`,
      trackIndex: isBrollSlot ? 1 : 0,
      startSec: cursor,
      endSec: end,
      label: isBrollSlot
        ? `B-Roll Slot ${Math.floor(cutIdx / 3)}`
        : `Cut ${cutIdx + 1}`,
      filter: isCyberpunk
        ? "hue_shift:180,contrast:1.4,saturation:0.6"
        : isCinematic
          ? "letterbox:2.35,grade:teal_orange"
          : undefined,
      ...(isBrollSlot && {
        broll: {
          id: `broll-${Math.floor(cutIdx / 3)}`,
          hint: `${prompt} — context shot ${Math.floor(cutIdx / 3) + 1}`,
          durationSec: end - cursor,
        },
      }),
    };

    cuts.push(cut);
    cursor = end;
    cutIdx++;
  }

  // Build audio beat markers
  const audioBeatMarkers: AudioBeat[] = [];
  let beatTime = 0;
  let beatIdx = 0;

  while (beatTime < durationSec) {
    const isBuildup =
      beatTime > durationSec * 0.3 && beatTime < durationSec * 0.35;
    const isDrop =
      beatTime >= durationSec * 0.35 && beatTime < durationSec * 0.4;
    const isTransition = beatIdx % 16 === 0 && beatIdx > 0;

    audioBeatMarkers.push({
      id: `beat-${beatIdx}`,
      timeSec: parseFloat(beatTime.toFixed(3)),
      type: isDrop
        ? "drop"
        : isBuildup
          ? "buildup"
          : isTransition
            ? "transition"
            : "ambient",
      bpm,
    });

    beatTime += beatIntervalSec;
    beatIdx++;
  }

  return {
    version: "1.0",
    prompt,
    durationSec,
    fps: isCinematic ? 24 : 30,
    cuts,
    audioBeatMarkers,
    metadata: {
      style: isCyberpunk ? "cyberpunk" : isCinematic ? "cinematic" : "default",
      mood: isEnergetic ? "energetic" : "calm",
      estimatedBpm: bpm,
      totalCuts: cuts.length,
      brollSlots: cuts.filter((c) => c.broll).length,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Return an existing project or create a new one for the given user.
 */
async function getOrCreateProject(
  userId: string,
  projectId: string | undefined,
  title: string,
): Promise<string> {
  if (projectId) {
    return projectId;
  }
  const project = await prisma.project.create({
    data: { title, userId },
  });
  return project.id;
}

// ── Route handler ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const log = logger.child({ route: "generate-timeline" });

  // Auth — re-verify inside the handler for defence-in-depth
  const jwtPayload = extractAndVerifyJwt(request);
  if (!jwtPayload) {
    return Response.json(
      { error: "Unauthorized", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  // Parse + validate body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const parseResult = GenerateTimelineSchema.safeParse(rawBody);
  if (!parseResult.success) {
    return Response.json(
      {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        issues: parseResult.error.flatten().fieldErrors,
      },
      { status: 422 },
    );
  }

  const { prompt, projectId, durationSec } = parseResult.data;

  log.info({ userId: jwtPayload.sub, prompt, durationSec }, "Generating timeline");

  // Validate project belongs to user (if provided)
  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return Response.json(
        { error: "Project not found", code: "NOT_FOUND" },
        { status: 404 },
      );
    }

    if (project.userId !== jwtPayload.sub) {
      return Response.json(
        { error: "Forbidden", code: "FORBIDDEN" },
        { status: 403 },
      );
    }
  }

  // Generate the timeline
  const timelineData = generateTimelineFromPrompt(prompt, durationSec);

  // Persist to database
  const resolvedProjectId = await getOrCreateProject(
    jwtPayload.sub,
    projectId,
    prompt.slice(0, 80),
  );

  const timeline = await prisma.timeline.create({
    data: {
      projectId: resolvedProjectId,
      prompt,
      data: timelineData as object,
    },
  });

  log.info(
    { timelineId: timeline.id, cuts: timelineData.cuts.length },
    "Timeline generated",
  );

  return Response.json(
    {
      timelineId: timeline.id,
      projectId: timeline.projectId,
      timeline: timelineData,
    },
    { status: 201 },
  );
}
