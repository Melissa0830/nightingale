"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setToken } from "@/lib/auth-client";
import styles from "./login.module.css";

// POST /api/auth/login currently accepts only { email } — no password
// field exists on the route, so none is rendered here (see
// src/app/api/auth/login/route.ts). Adding one would be inventing a field
// the backend does not read.
const DEMO_ACCOUNTS = [
  { label: "Clinician", email: "clinician.a@clinic-a.test" },
  { label: "Staff", email: "staff.a@clinic-a.test" },
  { label: "Patient", email: "patient.a@clinic-a.test" },
  { label: "Admin", email: "admin.a@clinic-a.test" },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitLogin(loginEmail: string) {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail }),
      });
      if (!res.ok) {
        setError("Unable to sign in. Check the credentials and try again.");
        return;
      }
      const data = (await res.json()) as { token?: string };
      if (!data.token) {
        setError("Unable to sign in. Check the credentials and try again.");
        return;
      }
      setToken(data.token);
      router.replace("/");
    } catch {
      setError("Unable to sign in. Check the credentials and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    void submitLogin(email.trim());
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>NIGHTINGALE</h1>
        <p className={styles.subtitle}>Shared longitudinal care record</p>

        <form onSubmit={handleSubmit} className={styles.form}>
          <label htmlFor="email" className={styles.label}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={styles.input}
            required
          />

          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </form>

        <div className={styles.demo}>
          <p className={styles.demoLabel}>Demo accounts</p>
          <div className={styles.demoButtons}>
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                className={styles.demoButton}
                disabled={submitting}
                onClick={() => void submitLogin(account.email)}
              >
                {account.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
