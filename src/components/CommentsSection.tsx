"use client";

import { useEffect, useState } from "react";
import { useAuthIdentity } from "./AppShell";
import { getToken } from "@/lib/auth-client";
import styles from "./CommentsSection.module.css";

// Mirrors GET/POST /api/timeline/:id/comments and PATCH /api/comments/:id
// exactly (re-confirmed against the current route files this block).
// Comment has NO authorRole field — only a raw authorId, assignedToId, and
// a mentions string[] of user ids. Those ids are resolved to display names
// via GET /api/collaborators (same-clinic Staff/Clinician only); an id
// that does not resolve is shown as a truthful fallback, never a guess.
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

interface Collaborator {
  id: string;
  name: string;
  role: "Staff" | "Clinician";
}

type Status = "loading" | "ok" | "error";
type CollabStatus = "loading" | "ok" | "error";

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

export default function CommentsSection({
  entryId,
  // Called after a server-confirmed change to the set of UNRESOLVED
  // comments on this patient — a new unresolved comment, a resolve, or a
  // reopen. That is the only comment mutation that moves Glance's Open
  // Actions count. Assignment / reassignment / clearing an assignee and
  // mention selection all leave the unresolved-comment set unchanged, so
  // they never call this.
  onOpenActionsChanged,
}: {
  entryId: string;
  onOpenActionsChanged?: () => void;
}) {
  const identity = useAuthIdentity();
  // Confirmed from the actual routes: POST and PATCH both reject Patient
  // AND Admin (403) — only Staff/Clinician may mutate. Admin therefore
  // gets read-only comments, no form, no Resolve/Reopen/Assign controls.
  const canMutate = identity.role === "Clinician" || identity.role === "Staff";

  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "error"));
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [draftMentions, setDraftMentions] = useState<string[]>([]);
  const [draftAssignee, setDraftAssignee] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [mutateError, setMutateError] = useState<string | null>(null);

  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>(() =>
    getToken() ? "loading" : "error",
  );

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

  // Collaborator directory is entry-independent (it is "my clinic"), but a
  // remount per entry is cheap and keeps this component self-contained.
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetch(`/api/collaborators`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setCollabStatus("error");
          return;
        }
        const data = (await res.json()) as Collaborator[];
        setCollaborators(data);
        setCollabStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setCollabStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const collaboratorById = new Map(collaborators.map((c) => [c.id, c]));

  // Truthful only: a resolved same-clinic collaborator → "Name · Role";
  // an id that does not resolve (stale, or a role no longer eligible) →
  // an explicit fallback, never an invented name.
  function labelFor(userId: string | null): string {
    if (!userId) return "Unassigned";
    const c = collaboratorById.get(userId);
    if (c) return `${c.name} · ${c.role}`;
    if (collabStatus === "ok") return "Unknown collaborator";
    return userId;
  }

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

  function addDraftMention(userId: string) {
    if (!userId) return;
    setDraftMentions((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
  }
  function removeDraftMention(userId: string) {
    setDraftMentions((prev) => prev.filter((id) => id !== userId));
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
      const payload: {
        content: string;
        mentions?: string[];
        assignedToId?: string;
      } = { content: trimmed };
      if (draftMentions.length > 0) payload.mentions = draftMentions;
      if (draftAssignee) payload.assignedToId = draftAssignee;

      const res = await fetch(`/api/timeline/${entryId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setSubmitError("Unable to add comment.");
        return;
      }
      setDraft("");
      setDraftMentions([]);
      setDraftAssignee("");
      await refetchComments();
      // A new comment is always created unresolved -> Open Actions +1.
      onOpenActionsChanged?.();
    } catch {
      setSubmitError("Unable to add comment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function patchComment(commentId: string, body: Record<string, unknown>) {
    setMutatingId(commentId);
    setMutateError(null);
    const token = getToken();
    if (!token) {
      setMutateError("Unable to update comment.");
      setMutatingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setMutateError("Unable to update comment.");
        return;
      }
      await refetchComments();
      // Only a resolve / reopen changes the unresolved-comment set that
      // Glance's Open Actions counts. An assignment-only PATCH does not.
      if ("resolved" in body) {
        onOpenActionsChanged?.();
      }
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
  // route); presentation groups Open before Resolved without re-sorting.
  const open = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);
  const unselectedCollaborators = collaborators.filter((c) => !draftMentions.includes(c.id));

  function renderComment(comment: Comment) {
    const busy = mutatingId === comment.id;
    return (
      <li key={comment.id} className={styles.item}>
        <p className={styles.author}>{labelFor(comment.authorId)}</p>
        <p className={styles.content}>{comment.content}</p>
        {comment.mentions.length > 0 && (
          <p className={styles.meta}>
            Mentioned: {comment.mentions.map((id) => labelFor(id)).join(" · ")}
          </p>
        )}
        <p className={styles.meta}>
          {formatDateTime(comment.createdAt)} ·{" "}
          {comment.assignedToId
            ? `Assigned to: ${labelFor(comment.assignedToId)}`
            : "Unassigned"}
        </p>
        <p className={styles.status}>{comment.resolved ? "Resolved" : "Open"}</p>

        {canMutate && (
          <div className={styles.commentActions}>
            <label className={styles.assignControl}>
              <span className={styles.assignLabel}>Assign to</span>
              <select
                className={styles.select}
                value={comment.assignedToId ?? ""}
                disabled={busy || collabStatus !== "ok"}
                onChange={(e) =>
                  patchComment(comment.id, {
                    assignedToId: e.target.value === "" ? null : e.target.value,
                  })
                }
              >
                <option value="">Unassigned</option>
                {collaborators.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.role}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.resolveButton}
              disabled={busy}
              onClick={() =>
                patchComment(comment.id, { resolved: !comment.resolved })
              }
            >
              {busy ? "Updating…" : comment.resolved ? "Reopen" : "Resolve"}
            </button>
          </div>
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

      {open.length > 0 && <ul className={styles.list}>{open.map(renderComment)}</ul>}

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

          <div className={styles.composerControls}>
            <div className={styles.composerField}>
              <label htmlFor="mention-select" className={styles.assignLabel}>
                Mention
              </label>
              {collabStatus === "error" ? (
                <span className={styles.state}>Collaborator list unavailable.</span>
              ) : (
                <select
                  id="mention-select"
                  className={styles.select}
                  value=""
                  disabled={
                    collabStatus !== "ok" || unselectedCollaborators.length === 0
                  }
                  onChange={(e) => {
                    addDraftMention(e.target.value);
                    e.currentTarget.selectedIndex = 0;
                  }}
                >
                  <option value="">
                    {collabStatus === "loading" ? "Loading…" : "Add person…"}
                  </option>
                  {unselectedCollaborators.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.role}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className={styles.composerField}>
              <label htmlFor="assign-select" className={styles.assignLabel}>
                Assign to
              </label>
              <select
                id="assign-select"
                className={styles.select}
                value={draftAssignee}
                disabled={collabStatus !== "ok"}
                onChange={(e) => setDraftAssignee(e.target.value)}
              >
                <option value="">Unassigned</option>
                {collaborators.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.role}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {draftMentions.length > 0 && (
            <ul className={styles.chipRow}>
              {draftMentions.map((id) => (
                <li key={id} className={styles.chip}>
                  <span>{labelFor(id)}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={`Remove mention ${labelFor(id)}`}
                    onClick={() => removeDraftMention(id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

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
