/**
 * Shared helpers for the engagement API routes.
 *
 * Keeps every route handler small and consistent:
 *  - Extracts + verifies the Quantmail JWT.
 *  - Upserts the local User row from the JWT payload.
 *  - Provides JSON error helpers with stable error codes.
 */

import type { NextRequest } from "next/server";
import { extractAndVerifyJwt } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type AuthedUser = {
  id: string;
  email: string;
  displayName: string;
  quantmailId: string;
};

export type AuthedRequest = {
  user: AuthedUser;
};

export async function authenticate(
  request: NextRequest,
): Promise<AuthedUser | Response> {
  const payload = extractAndVerifyJwt(request);
  if (!payload) {
    return Response.json(
      { error: "Unauthorized", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  const user = await prisma.user.upsert({
    where: { quantmailId: payload.sub },
    update: {
      email: payload.email,
      displayName: payload.display_name ?? payload.email,
    },
    create: {
      quantmailId: payload.sub,
      email: payload.email,
      displayName: payload.display_name ?? payload.email,
    },
  });

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    quantmailId: user.quantmailId,
  };
}

export function badRequest(message: string): Response {
  return Response.json(
    { error: message, code: "BAD_REQUEST" },
    { status: 400 },
  );
}

export function validationError(issues: unknown): Response {
  return Response.json(
    { error: "Validation failed", code: "VALIDATION_ERROR", issues },
    { status: 422 },
  );
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message, code: "NOT_FOUND" }, { status: 404 });
}

export function forbidden(message = "Forbidden"): Response {
  return Response.json({ error: message, code: "FORBIDDEN" }, { status: 403 });
}
