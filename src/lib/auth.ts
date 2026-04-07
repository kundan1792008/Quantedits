/**
 * Quantmail Biometric SSO — JWT verification helpers.
 *
 * All API routes (and the Next.js middleware) use `verifyQuantmailJwt` to
 * authenticate requests.  Tokens are issued by the Quantmail identity
 * service and carry biometric-proof claims.
 *
 * Expected JWT payload shape:
 * {
 *   sub:           string   // quantmailId (stable user identifier)
 *   email:         string
 *   display_name?: string
 *   biometric:     boolean  // must be true for biometric-authenticated sessions
 *   iat:           number
 *   exp:           number
 * }
 */

import jwt from "jsonwebtoken";
import { logger } from "@/lib/logger";

export interface QuantmailJwtPayload {
  sub: string;
  email: string;
  display_name?: string;
  biometric: boolean;
  iat: number;
  exp: number;
}

const QUANTMAIL_JWT_SECRET =
  process.env.QUANTMAIL_JWT_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "quantmail-dev-secret");

/**
 * Verify a Quantmail JWT string and return the decoded payload.
 * Throws an error if the token is invalid, expired, or missing the biometric
 * proof flag.
 */
export function verifyQuantmailJwt(token: string): QuantmailJwtPayload {
  if (!QUANTMAIL_JWT_SECRET) {
    throw new Error("QUANTMAIL_JWT_SECRET is not configured");
  }

  const payload = jwt.verify(token, QUANTMAIL_JWT_SECRET) as QuantmailJwtPayload;

  if (!payload.biometric) {
    throw new Error("Token does not carry biometric proof");
  }

  return payload;
}

/**
 * Extract and verify the Quantmail JWT from an incoming Request's
 * `Authorization: Bearer <token>` header.
 *
 * Returns the decoded payload on success, or null on failure.
 */
export function extractAndVerifyJwt(
  request: Request,
): QuantmailJwtPayload | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  try {
    return verifyQuantmailJwt(token);
  } catch (err) {
    logger.warn({ err }, "JWT verification failed");
    return null;
  }
}
