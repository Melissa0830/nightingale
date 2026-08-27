"use client";

import { useEffect, useState } from "react";
import { useAuthIdentity } from "./AppShell";
import { getToken } from "@/lib/auth-client";
import styles from "./CommentsSection.module.css";

// Mirrors GET/POST /api/timeline/:id/comments and PATCH /api/comments/:id
// exactly (re-confirmed against the current route files this block).
// Important correction to an assumption in the task brief: Comment has
// NO authorRole field — only a raw authorId. There is still no generic
// user-name/role lookup endpoint, so authorId is shown verbatim in muted
// technical text rather than fabricating a role or name.
interface Comment {
  id: string;
  timelineEntryId: string;
  authorId: string;
  content: string;
  resolved: boolean;
  assignedToId: string | null;
  mentions: string[];
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

type Status = "loading" | "ok" | "error";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

export default function CommentsSection({ entryId }: { entryId: string }) {
  const identity = useAuthIdentity();
  // Confirmed from the actual routes: POST and PATCH both reject Patient
  // AND Admin (403) — only Staff/Clinician may mutate. Admin therefore
  // gets read-only comments, no form, no Resolve/Reopen controls — never
  // a disabled fake control.
  const canMutate = identity.role === "Clinician" || identity.role === "Staff";

  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "error"));
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [mutateError, setMutateError] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetch(`/api/timeline/${entryId}/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = (await res.json()) as Comment[];
        setComments(data);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  // Called only from event handlers (post-mutation refresh), never from
  // an effect body — a plain async helper, not subject to the
  // set-state-in-effect rule.
  async function refetchComments() {
    const token = getToken();
    if (!token) return;
    const res = await fetch(`/api/timeline/${entryId}/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as Comment[];
      setComments(data);
    }
  }

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const token = getToken();
    if (!token) {
      setSubmitError("Unable to add comment.");
      setSubmitting(false);
      return;
    }
    try {
      const res = await fetch(`/api/timeline/${entryId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: trimmed }),
      });
      if (!res.ok) {
        setSubmitError("Unable to add comment.");
        return;
      }
      setDraft("");
      await refetchComments();
    } catch {
      setSubmitError("Unable to add comment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleResolve(comment: Comment) {
    setMutatingId(comment.id);
    setMutateError(null);
    const token = getToken();
    if (!token) {
      setMutateError("Unable to update comment.");
      setMutatingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/comments/${comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ resolved: !comment.resolved }),
      });
      if (!res.ok) {
        setMutateError("Unable to update comment.");
        return;
      }
      await refetchComments();
    } catch {
      setMutateError("Unable to update comment.");
    } finally {
      setMutatingId(null);
    }
  }

  if (status === "loading") {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Comments</h3>
        <p className={styles.state} role="status">
          Loading comments…
        </p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Comments</h3>
        <p className={styles.state}>Unable to load comments.</p>
      </section>
    );
  }

  // Backend guarantees createdAt-ascending ordering (confirmed from the
  // route); presentation groups Open before Resolved without re-sorting
  // within each group.
  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  function renderComment(comment: Comment) {
    return (
      <li key={comment.id} className={styles.item}>
        <p className={styles.author}>{comment.authorId}</p>
        <p className={styles.content}>{comment.content}</p>
        <p className={styles.meta}>
          {formatDateTime(comment.createdAt)}
          {comment.assignedToId ? ` · Assigned to: ${comment.assignedToId}` : ""}
        </p>
        <p className={styles.status}>{comment.resolved ? "Resolved" : "Open"}</p>
        {canMutate && (
          <button
            type="button"
            className={styles.resolveButton}
            disabled={mutatingId === comment.id}
            onClick={() => handleToggleResolve(comment)}
          >
            {mutatingId === comment.id
              ? "Updating…"
              : comment.resolved
                ? "Reopen"
                : "Resolve"}
          </button>
        )}
      </li>
    );
  }

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        Comments{comments.length > 0 ? ` · ${comments.length}` : ""}
      </h3>

      {comments.length === 0 && <p className={styles.state}>No comments yet.</p>}

      {open.length > 0 && (
        <ul className={styles.list}>{open.map(renderComment)}</ul>
      )}

      {resolved.length > 0 && (
        <>
          <p className={styles.groupLabel}>Resolved</p>
          <ul className={styles.list}>{resolved.map(renderComment)}</ul>
        </>
      )}

      {mutateError && <p className={styles.error}>{mutateError}</p>}

      {canMutate && (
        <form className={styles.form} onSubmit={handleAddComment}>
          <label htmlFor="new-comment" className={styles.formLabel}>
            Add internal comment
          </label>
          <textarea
            id="new-comment"
            className={styles.textarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
          />
          <button
            type="submit"
            className={styles.submitButton}
            disabled={submitting || draft.trim().length === 0}
          >
            {submitting ? "Adding…" : "Add comment"}
          </button>
          {submitError && <p className={styles.error}>{submitError}</p>}
        </form>
      )}
    </section>
  );
}
