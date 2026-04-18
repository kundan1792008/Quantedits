/**
 * POST /api/v1/engagement/suggestions
 *
 * Runs the suggestion engine against a ProjectProbe and persists each
 * candidate as an AiSuggestion record in PENDING state. Returns the list
 * of suggestions produced.
 *
 * GET /api/v1/engagement/suggestions?projectId=...
 *
 * Returns the authenticated user's PENDING suggestions for the project.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  authenticate,
  forbidden,
  notFound,
  validationError,
} from "@/lib/engagementHttp";
import { generateSuggestions } from "@/services/engagement";
import { Prisma } from "@/generated/prisma/client";

const ProbeSchema = z
  .object({
    projectId: z.string().cuid(),
    durationSec: z.number().optional(),
    fps: z.number().optional(),
    widthPx: z.number().int().optional(),
    heightPx: z.number().int().optional(),
    hasCaptions: z.boolean().optional(),
    hasCustomThumbnail: z.boolean().optional(),
    hasTitle: z.boolean().optional(),
    hasDescription: z.boolean().optional(),
    tagCount: z.number().int().optional(),
    audioLufs: z.number().optional(),
    audioPeakDb: z.number().optional(),
    hasAudio: z.boolean().optional(),
    cutCount: z.number().int().optional(),
    hasColorGrade: z.boolean().optional(),
    hasTransitions: z.boolean().optional(),
    hasIntroHook: z.boolean().optional(),
    hasMusic: z.boolean().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const log = logger.child({ route: "engagement/suggestions" });

  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError({ _: ["Body must be valid JSON"] });
  }
  const parsed = ProbeSchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.flatten().fieldErrors);

  const project = await prisma.project.findUnique({
    where: { id: parsed.data.projectId },
  });
  if (!project) return notFound("Project not found");
  if (project.userId !== authed.id) return forbidden();

  const candidates = generateSuggestions(parsed.data);

  // Persist new suggestions; idempotent per (userId, projectId, ruleId) for
  // PENDING entries so re-running doesn't clone rows.
  for (const c of candidates) {
    const existing = await prisma.aiSuggestion.findFirst({
      where: {
        userId: authed.id,
        projectId: parsed.data.projectId,
        ruleId: c.ruleId,
        status: "PENDING",
      },
    });
    if (existing) {
      await prisma.aiSuggestion.update({
        where: { id: existing.id },
        data: {
          title: c.title,
          body: c.body,
          severity: c.severity,
          context: c.context
            ? (c.context as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });
    } else {
      await prisma.aiSuggestion.create({
        data: {
          userId: authed.id,
          projectId: parsed.data.projectId,
          ruleId: c.ruleId,
          title: c.title,
          body: c.body,
          severity: c.severity,
          context: c.context
            ? (c.context as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });
    }
  }

  log.info(
    { projectId: parsed.data.projectId, count: candidates.length },
    "Suggestions generated",
  );

  return Response.json({ suggestions: candidates }, { status: 200 });
}

export async function GET(request: NextRequest) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) return validationError({ projectId: ["required"] });

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return notFound("Project not found");
  if (project.userId !== authed.id) return forbidden();

  const rows = await prisma.aiSuggestion.findMany({
    where: { userId: authed.id, projectId, status: "PENDING" },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ suggestions: rows }, { status: 200 });
}
