/**
 * Update a single AI suggestion (applied / dismissed).
 *
 * PATCH /api/v1/engagement/suggestions/:id
 * Body: { status: "APPLIED" | "DISMISSED" }
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  authenticate,
  forbidden,
  notFound,
  validationError,
} from "@/lib/engagementHttp";

const BodySchema = z.object({
  status: z.enum(["APPLIED", "DISMISSED"]),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError({ _: ["Body must be valid JSON"] });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error.flatten().fieldErrors);

  const suggestion = await prisma.aiSuggestion.findUnique({ where: { id } });
  if (!suggestion) return notFound("Suggestion not found");
  if (suggestion.userId !== authed.id) return forbidden();

  const updated = await prisma.aiSuggestion.update({
    where: { id },
    data: { status: parsed.data.status },
  });
  return Response.json({ suggestion: updated }, { status: 200 });
}
