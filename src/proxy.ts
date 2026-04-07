/**
 * Next.js Proxy — Quantmail Biometric SSO guard.
 *
 * Protects all `/api/v1/*` routes.  Requests without a valid Quantmail
 * JWT (with biometric proof) are rejected with 401.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyQuantmailJwt } from "@/lib/auth";

const PROTECTED_PREFIX = "/api/v1";

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith(PROTECTED_PREFIX)) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing Quantmail JWT", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }

  const token = authHeader.slice(7);
  try {
    verifyQuantmailJwt(token);
    return NextResponse.next();
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired Quantmail JWT", code: "UNAUTHENTICATED" },
      { status: 401 },
    );
  }
}

export const config = {
  matcher: ["/api/v1/:path*"],
};
