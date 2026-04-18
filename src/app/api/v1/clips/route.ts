/**
 * GET  /api/v1/clips?trackId=...  — list clips for a track
 * POST /api/v1/clips               — create a clip
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "clips" });

const CreateClipSchema = z.object({
  trackId: z.string().cuid(),
  assetId: z.string().cuid().optional(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  trimInSec: z.number().min(0).optional().default(0),
  trimOutSec: z.number().min(0).optional().default(0),
  properties: z.record(z.string(), z.unknown()).optional().default({}),
});

export async function GET(request: NextRequest) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const trackId = request.nextUrl.searchParams.get("trackId");
  if (!trackId) {
    return Response.json({ error: "trackId query param required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    include: {
      timeline: { include: { project: { select: { userId: true } } } },
    },
  });

  if (!track) {
    return Response.json({ error: "Track not found" }, { status: 404 });
  }
  if (track.timeline.project.userId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const clips = await prisma.clip.findMany({
    where: { trackId },
    include: { keyframes: true },
    orderBy: { startSec: "asc" },
  });

  return Response.json({ clips });
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

  const parsed = CreateClipSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation error", issues: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { trackId, assetId, startSec, endSec, trimInSec, trimOutSec, properties } = parsed.data;

  if (endSec <= startSec) {
    return Response.json(
      { error: "endSec must be greater than startSec" },
      { status: 422 },
    );
  }

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const track = await prisma.track.findUnique({
    where: { id: trackId },
    include: {
      timeline: { include: { project: { select: { userId: true } } } },
    },
  });

  if (!track) {
    return Response.json({ error: "Track not found" }, { status: 404 });
  }
  if (track.timeline.project.userId !== user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // If assetId provided, verify it belongs to the user
  if (assetId) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.userId !== user.id) {
      return Response.json({ error: "Asset not found or forbidden" }, { status: 404 });
    }
  }

  const clip = await prisma.clip.create({
    data: {
      trackId,
      assetId: assetId ?? null,
      startSec,
      endSec,
      trimInSec,
      trimOutSec,
      properties: properties as object,
    },
    include: { keyframes: true },
  });

  log.info({ clipId: clip.id, trackId, startSec, endSec }, "Clip created");
  return Response.json({ clip }, { status: 201 });
}
