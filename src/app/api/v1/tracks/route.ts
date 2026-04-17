/**
 * GET  /api/v1/tracks?timelineId=...  — list tracks for a timeline
 * POST /api/v1/tracks                 — create a track
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "tracks" });

const TRACK_TYPES = ["VIDEO", "AUDIO", "TEXT", "AI_EFFECT"] as const;

const CreateTrackSchema = z.object({
  timelineId: z.string().cuid(),
  type: z.enum(TRACK_TYPES),
  name: z.string().min(1).max(80),
  index: z.number().int().min(0),
  muted: z.boolean().optional().default(false),
  solo: z.boolean().optional().default(false),
  locked: z.boolean().optional().default(false),
  volume: z.number().min(0).max(2).optional().default(1),
});

export async function GET(request: NextRequest) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const timelineId = request.nextUrl.searchParams.get("timelineId");
  if (!timelineId) {
    return Response.json(
      { error: "timelineId query param required" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { quantmailId: jwt.sub },
  });
  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  // Verify the timeline belongs to this user via project
  const timeline = await prisma.timeline.findUnique({
    where: { id: timelineId },
    include: { project: { select: { userId: true } } },
  });

  if (!timeline) {
    return Response.json({ error: "Timeline not found" }, { status: 404 });
  }
  if (timeline.project.userId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const tracks = await prisma.track.findMany({
    where: { timelineId },
    orderBy: { index: "asc" },
    include: {
      clips: {
        include: { keyframes: true },
        orderBy: { startSec: "asc" },
      },
    },
  });

  return Response.json({ tracks });
}

export async function POST(request: NextRequest) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateTrackSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation error", issues: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { timelineId, type, name, index, muted, solo, locked, volume } =
    parsed.data;

  const user = await prisma.user.findUnique({
    where: { quantmailId: jwt.sub },
  });
  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const timeline = await prisma.timeline.findUnique({
    where: { id: timelineId },
    include: { project: { select: { userId: true } } },
  });

  if (!timeline) {
    return Response.json({ error: "Timeline not found" }, { status: 404 });
  }
  if (timeline.project.userId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const track = await prisma.track.create({
    data: { timelineId, type, name, index, muted, solo, locked, volume },
  });

  log.info({ trackId: track.id, type, timelineId }, "Track created");
  return Response.json({ track }, { status: 201 });
}
