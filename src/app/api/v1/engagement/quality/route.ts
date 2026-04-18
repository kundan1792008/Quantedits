/**
 * POST /api/v1/engagement/quality
 *
 * Evaluates a ProjectProbe against the transparent quality ruleset and
 * persists the result. The score can legitimately reach 100.
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { authenticate, forbidden, notFound, validationError } from "@/lib/engagementHttp";
import { evaluateQuality } from "@/services/engagement";

const ProbeSchema = z
  .object({
    projectId: z.string().cuid(),
    durationSec: z.number().min(0).optional(),
    fps: z.number().min(1).max(240).optional(),
    widthPx: z.number().int().min(16).max(16384).optional(),
    heightPx: z.number().int().min(16).max(16384).optional(),
    hasCaptions: z.boolean().optional(),
    hasCustomThumbnail: z.boolean().optional(),
    hasTitle: z.boolean().optional(),
    hasDescription: z.boolean().optional(),
    tagCount: z.number().int().min(0).max(1000).optional(),
    audioLufs: z.number().min(-70).max(0).optional(),
    audioPeakDb: z.number().min(-70).max(6).optional(),
    hasAudio: z.boolean().optional(),
    cutCount: z.number().int().min(0).max(100000).optional(),
    hasColorGrade: z.boolean().optional(),
    hasTransitions: z.boolean().optional(),
    hasIntroHook: z.boolean().optional(),
    hasMusic: z.boolean().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const log = logger.child({ route: "engagement/quality" });

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
  const probe = parsed.data;

  const project = await prisma.project.findUnique({
    where: { id: probe.projectId },
  });
  if (!project) return notFound("Project not found");
  if (project.userId !== authed.id) return forbidden();

  const score = evaluateQuality(probe);

  await prisma.qualityCheckRun.create({
    data: {
      projectId: probe.projectId,
      score: score.score,
      results: score as unknown as object,
    },
  });

  log.info(
    { projectId: probe.projectId, score: score.score },
    "Quality check computed",
  );

  return Response.json({ score }, { status: 200 });
}
