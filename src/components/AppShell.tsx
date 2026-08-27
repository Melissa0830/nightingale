"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getToken, clearToken, fetchMe, type AuthIdentity } from "@/lib/auth-client";
import RoleNav from "./RoleNav";
import styles from "./AppShell.module.css";

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
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <span className={styles.brand}>NIGHTINGALE</span>
        <div className={styles.identity}>
          <span className={styles.roleBadge}>{identity.role}</span>
          <span className={styles.userId}>{identity.id}</span>
          <button type="button" className={styles.logout} onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>
      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <RoleNav />
        </aside>
        <main className={styles.content}>{children}</main>
      </div>
    </div>
  );
}
