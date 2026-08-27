"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, clearToken, fetchMe, type AuthIdentity } from "@/lib/auth-client";
import RoleNav from "./RoleNav";
import styles from "./AppShell.module.css";

// Exposes the identity AppShell already resolved (role/clinicId/patientId)
// to descendants (RoleNav, the /patients pages) so they don't each make
// their own redundant /auth/me call. Small, single-purpose context — not a
// general state-management layer.
const AuthContext = createContext<AuthIdentity | null>(null);

export function useAuthIdentity(): AuthIdentity {
  const identity = useContext(AuthContext);
  if (!identity) {
    throw new Error("useAuthIdentity must be used within AppShell");
  }
  return identity;
}

// Owns the browser-only auth check (token presence + /auth/me validation)
// so that src/app/page.tsx can stay a Server Component. Renders nothing of
// the authenticated shell until identity is confirmed, to avoid flashing
// shell content before a redirect.
export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    fetchMe(token).then((me) => {
      if (cancelled) return;
      if (!me) {
        // Stored token is invalid/expired — clear it rather than leave
        // stale state, per the "clean re-auth path" requirement.
        clearToken();
        router.replace("/login");
        return;
      }
      setIdentity(me);
      setChecking(false);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  function handleLogout() {
    // No backend logout endpoint exists — none is invented. Logging out is
    // purely a client-side state/storage clear.
    clearToken();
    router.replace("/login");
  }

  if (checking || !identity) {
    return (
      <div className={styles.loading} role="status">
        Loading Nightingale…
      </div>
    );
  }

  return (
    <AuthContext.Provider value={identity}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.topbarLeft}>
            <span className={styles.brand}>Nightingale</span>
            <RoleNav />
          </div>
          <div className={styles.identity}>
            <span className={styles.roleBadge}>{identity.role}</span>
            <span className={styles.userId} title={identity.id}>
              {identity.id}
            </span>
            <button type="button" className={styles.logout} onClick={handleLogout}>
              Logout
            </button>
          </div>
        </header>
        <main className={styles.content}>{children}</main>
      </div>
    </AuthContext.Provider>
  );
}
