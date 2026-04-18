/**
 * GET  /api/v1/export-jobs?projectId=...  — list export jobs for a project
 * POST /api/v1/export-jobs                 — create / enqueue an export job
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { RenderJobStatus } from "@/generated/prisma/enums";

const log = logger.child({ route: "export-jobs" });

const RENDER_OUTPUT_BASE_URL =
  process.env.RENDER_OUTPUT_BASE_URL ?? "https://renders.quantedits.io";

const EXPORT_FORMATS = ["MP4", "WEBM", "PRORES"] as const;
const EXPORT_RESOLUTIONS = ["RES_720P", "RES_1080P", "RES_4K", "CUSTOM"] as const;

const CreateExportJobSchema = z.object({
  projectId: z.string().cuid(),
  format: z.enum(EXPORT_FORMATS).optional().default("MP4"),
  resolution: z.enum(EXPORT_RESOLUTIONS).optional().default("RES_1080P"),
  fps: z.number().int().refine((v) => [24, 30, 60].includes(v), {
    message: "fps must be 24, 30, or 60",
  }).optional().default(30),
  quality: z.number().int().min(0).max(100).optional().default(80),
});

export async function GET(request: NextRequest) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return Response.json({ error: "projectId query param required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (project.userId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });

  const jobs = await prisma.exportJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ jobs });
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

  const parsed = CreateExportJobSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation error", issues: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }

  const { projectId, format, resolution, fps, quality } = parsed.data;

  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (project.userId !== user.id) return Response.json({ error: "Forbidden" }, { status: 403 });

  const job = await prisma.exportJob.create({
    data: { projectId, format, resolution, fps, quality, status: RenderJobStatus.QUEUED },
  });

  log.info({ jobId: job.id, projectId, format, resolution, fps }, "Export job created");

  // Background simulation
  void simulateExport(job.id, projectId, format);

  return Response.json({ job }, { status: 201 });
}

async function simulateExport(
  jobId: string,
  projectId: string,
  format: (typeof EXPORT_FORMATS)[number],
): Promise<void> {
  try {
    await prisma.exportJob.update({
      where: { id: jobId },
      data: { status: RenderJobStatus.PROCESSING, startedAt: new Date() },
    });

    for (const progress of [20, 50, 80, 100]) {
      await new Promise<void>((r) => setTimeout(r, 600));
      await prisma.exportJob.update({
        where: { id: jobId },
        data: { progress },
      });
    }

    const ext = format === "MP4" ? "mp4" : format === "WEBM" ? "webm" : "mov";
    const outputUrl = `${RENDER_OUTPUT_BASE_URL}/${projectId}/${jobId}/output.${ext}`;

    await prisma.exportJob.update({
      where: { id: jobId },
      data: { status: RenderJobStatus.DONE, outputUrl, finishedAt: new Date() },
    });
  } catch (err) {
    await prisma.exportJob.update({
      where: { id: jobId },
      data: {
        status: RenderJobStatus.FAILED,
        errorMsg: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    });
  }
}
