// Browser-side counterpart to src/lib/auth/* (which is server-only and must
// never be imported from a Client Component). Wraps the existing Bearer-
// token API contract — no new auth mechanism, no cookies, no middleware.
//
// Token storage: sessionStorage. Chosen deliberately over localStorage for
// this prototype — it clears when the browser tab/session ends, matching
// "auth token persistence for the current browser session" rather than
// indefinite persistence. This is not a production-grade session strategy
// (no httpOnly cookie, no refresh flow); it is the smallest mechanism that
// satisfies the current single-token API.

const TOKEN_KEY = "nightingale_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

// Mirrors AuthUser from src/lib/auth/types.ts exactly — GET /api/auth/me
// returns this shape and nothing more (no name, no email, no clinic name).
export interface AuthIdentity {
  id: string;
  clinicId: string;
  role: "Patient" | "Staff" | "Clinician" | "Admin";
  patientId?: string;
}

export async function fetchMe(token: string): Promise<AuthIdentity | null> {
  const res = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as AuthIdentity;
}
