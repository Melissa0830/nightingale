import jwt from "jsonwebtoken";
import type { AuthUser } from "./types";
import { ApiError } from "@/lib/errors";

const VALID_ROLES = new Set(["Patient", "Staff", "Clinician", "Admin"]);
const JWT_EXPIRES_IN = "8h";

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Server configuration error — do not expose details to client.
    throw new Error("JWT_SECRET environment variable is not set");
  }
  return secret;
}

/**
 * Runtime validation of a decoded JWT payload into AuthUser.
 *
 * Design decisions:
 * - role=Patient requires patientId (non-empty string after trim).
 * - role!=Patient: patientId is stripped from the returned AuthUser, even if
 *   present in the token. patientId is only meaningful for Patient-role RBAC;
 *   preserving it for other roles could create confused-deputy risk.
 * - All validation failures throw ApiError(401) with a generic message.
 *   No token parse details are leaked to the caller.
 */
function validatePayload(payload: unknown): AuthUser {
  if (typeof payload !== "object" || payload === null) {
    throw new ApiError(401, "Invalid or expired token");
  }

  const p = payload as Record<string, unknown>;

  if (typeof p["id"] !== "string" || p["id"].trim().length === 0) {
    throw new ApiError(401, "Invalid or expired token");
  }
  if (typeof p["clinicId"] !== "string" || p["clinicId"].trim().length === 0) {
    throw new ApiError(401, "Invalid or expired token");
  }
  if (typeof p["role"] !== "string" || !VALID_ROLES.has(p["role"])) {
    throw new ApiError(401, "Invalid or expired token");
  }

  const role = p["role"] as AuthUser["role"];

  if (role === "Patient") {
    if (
      typeof p["patientId"] !== "string" ||
      p["patientId"].trim().length === 0
    ) {
      throw new ApiError(401, "Invalid or expired token");
    }
    return {
      id: p["id"],
      clinicId: p["clinicId"],
      role,
      patientId: p["patientId"],
    };
  }

  // Non-Patient roles: strip patientId — it plays no authorization role here.
  return { id: p["id"], clinicId: p["clinicId"], role };
}

/**
 * Sign an AuthUser payload into a JWT string.
 * Used by the login route to issue tokens for prototype auth.
 */
export function signToken(user: AuthUser): string {
  return jwt.sign(user, getSecret(), {
    expiresIn: JWT_EXPIRES_IN,
    algorithm: "HS256",
  });
}

/**
 * Verify and decode a JWT string into a validated AuthUser.
 * Throws ApiError 401 for any failure: missing, malformed, expired, or
 * payload that does not satisfy AuthUser constraints.
 * Explicitly restricts to HS256 to prevent algorithm confusion attacks.
 */
export function verifyToken(token: string): AuthUser {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
  } catch {
    throw new ApiError(401, "Invalid or expired token");
  }
  return validatePayload(decoded);
}

/**
 * Extract and verify the Bearer token from a Next.js Request.
 * Throws ApiError 401 if the Authorization header is absent or invalid.
 */
export function authenticate(request: Request): AuthUser {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ApiError(401, "Missing or malformed Authorization header");
  }
  return verifyToken(authHeader.slice(7));
}
