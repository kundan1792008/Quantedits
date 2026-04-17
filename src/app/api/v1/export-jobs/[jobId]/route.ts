/**
 * GET  /api/v1/export-jobs/[jobId]  — get an export job's status
 * DELETE /api/v1/export-jobs/[jobId] — cancel / delete an export job
 */

import type { NextRequest } from "next/server";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { RenderJobStatus } from "@/generated/prisma/enums";

const log = logger.child({ route: "export-jobs/[jobId]" });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { jobId } = await params;
  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const job = await prisma.exportJob.findUnique({
    where: { id: jobId },
    include: { project: { select: { userId: true } } },
  });

  if (!job) return Response.json({ error: "Export job not found" }, { status: 404 });
  if (job.project.userId !== user.id)
    return Response.json({ error: "Forbidden" }, { status: 403 });

  return Response.json({ job });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const jwt = extractAndVerifyJwt(request);
  if (!jwt) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { jobId } = await params;
  const user = await prisma.user.findUnique({ where: { quantmailId: jwt.sub } });
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });

  const job = await prisma.exportJob.findUnique({
    where: { id: jobId },
    include: { project: { select: { userId: true } } },
  });

  if (!job) return Response.json({ error: "Export job not found" }, { status: 404 });
  if (job.project.userId !== user.id)
    return Response.json({ error: "Forbidden" }, { status: 403 });

  if (
    job.status === RenderJobStatus.QUEUED ||
    job.status === RenderJobStatus.PROCESSING
  ) {
    await prisma.exportJob.update({
      where: { id: jobId },
      data: {
        status: RenderJobStatus.FAILED,
        errorMsg: "Cancelled by user",
        finishedAt: new Date(),
      },
    });
    log.info({ jobId }, "Export job cancelled by user");
    return Response.json({ message: "Export job cancelled" });
  }

  await prisma.exportJob.delete({ where: { id: jobId } });
  log.info({ jobId }, "Export job deleted");
  return Response.json({ message: "Deleted" });
}
