/**
 * GET  /api/v1/keyframes?clipId=...  — list keyframes for a clip
 * POST /api/v1/keyframes              — create a keyframe
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "keyframes" });

const KEYFRAME_EASINGS = [
  "LINEAR",
  "EASE_IN",
  "EASE_OUT",
  "EASE_IN_OUT",
  "BEZIER",
  "STEP",
] as const;

const CreateKeyframeSchema = z.object({
  clipId: z.string().cuid(),
  property: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Property must be a valid identifier"),
  timeSec: z.number().min(0),
  value: z.number(),
  easing: z.enum(KEYFRAME_EASINGS).optional().default("LINEAR"),
});

async function resolveClipUser(clipId: string): Promise<string | null> {
  const clip = await prisma.clip.findUnique({
    where: { id: clipId },
    include: {
      track: {
        include: {
          timeline: { include: { project: { select: { userId: true } } } },
        },
      },
    },
  });
  return clip?.track.timeline.project.userId ?? null;
}

export async function GET(request: NextRequest) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clipId = request.nextUrl.searchParams.get("clipId");
  if (!clipId) {
    return Response.json({ error: "clipId query param required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const ownerId = await resolveClipUser(clipId);
  if (!ownerId) return Response.json({ error: "Clip not found" }, { status: 404 });
  if (ownerId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });

  const keyframes = await prisma.keyframe.findMany({
    where: { clipId },
    orderBy: [{ property: "asc" }, { timeSec: "asc" }],
  });

  return Response.json({ keyframes });
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

  const parsed = CreateKeyframeSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation error", issues: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { clipId, property, timeSec, value, easing } = parsed.data;

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const ownerId = await resolveClipUser(clipId);
  if (!ownerId) return Response.json({ error: "Clip not found" }, { status: 404 });
  if (ownerId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });

  // Upsert: if a keyframe already exists at this property+time, update it
  const existing = await prisma.keyframe.findFirst({
    where: {
      clipId,
      property,
      timeSec: { gte: timeSec - 0.001, lte: timeSec + 0.001 },
    },
  });

  let keyframe;
  if (existing) {
    keyframe = await prisma.keyframe.update({
      where: { id: existing.id },
      data: { value, easing },
    });
  } else {
    keyframe = await prisma.keyframe.create({
      data: { clipId, property, timeSec, value, easing },
    });
  }

  log.info({ keyframeId: keyframe.id, clipId, property, timeSec }, "Keyframe upserted");
  return Response.json({ keyframe }, { status: 201 });
}
