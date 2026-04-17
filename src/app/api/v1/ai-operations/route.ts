/**
 * GET  /api/v1/ai-operations?clipId=...  — list AI operations for a clip
 * POST /api/v1/ai-operations              — enqueue an AI operation
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { RenderJobStatus } from "@/generated/prisma/enums";

const log = logger.child({ route: "ai-operations" });

const AI_OPERATION_TYPES = [
  "REMOVE_BACKGROUND",
  "GENERATIVE_FILL",
  "STYLE_TRANSFER",
  "UPSCALE",
  "AUTO_COLOR",
] as const;

const CreateAIOpSchema = z.object({
  clipId: z.string().cuid(),
  type: z.enum(AI_OPERATION_TYPES),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(0).optional(),
});

async function resolveClipOwner(clipId: string): Promise<string | null> {
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
  if (!jwt) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const clipId = request.nextUrl.searchParams.get("clipId");
  if (!clipId) {
    return Response.json({ error: "clipId query param required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const ownerId = await resolveClipOwner(clipId);
  if (!ownerId) return Response.json({ error: "Clip not found" }, { status: 404 });
  if (ownerId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });

  const operations = await prisma.aIOperation.findMany({
    where: { clipId },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ operations });
}

export async function POST(request: NextRequest) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateAIOpSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation error", issues: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { clipId, type, params, startFrame, endFrame } = parsed.data;

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const ownerId = await resolveClipOwner(clipId);
  if (!ownerId) return Response.json({ error: "Clip not found" }, { status: 404 });
  if (ownerId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });

  const operation = await prisma.aIOperation.create({
    data: {
      clipId,
      type,
      params: params as object,
      startFrame: startFrame ?? null,
      endFrame: endFrame ?? null,
      status: RenderJobStatus.QUEUED,
    },
  });

  log.info({ operationId: operation.id, clipId, type }, "AI operation enqueued");

  // Background simulation
  void simulateAIOperation(operation.id, type);

  return Response.json({ operation }, { status: 201 });
}

async function simulateAIOperation(
  operationId: string,
  type: (typeof AI_OPERATION_TYPES)[number],
): Promise<void> {
  const durations: Record<(typeof AI_OPERATION_TYPES)[number], number[]> = {
    REMOVE_BACKGROUND: [30, 70, 100],
    GENERATIVE_FILL: [20, 50, 80, 100],
    STYLE_TRANSFER: [25, 60, 100],
    UPSCALE: [20, 50, 80, 100],
    AUTO_COLOR: [40, 80, 100],
  };

  try {
    await prisma.aIOperation.update({
      where: { id: operationId },
      data: { status: RenderJobStatus.PROCESSING, startedAt: new Date() },
    });

    for (const progress of durations[type]) {
      await new Promise<void>((r) => setTimeout(r, 400));
      await prisma.aIOperation.update({ where: { id: operationId }, data: { progress } });
    }

    await prisma.aIOperation.update({
      where: { id: operationId },
      data: {
        status: RenderJobStatus.DONE,
        result: { type, completedAt: new Date().toISOString() },
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    await prisma.aIOperation.update({
      where: { id: operationId },
      data: {
        status: RenderJobStatus.FAILED,
        errorMsg: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    });
  }
}
