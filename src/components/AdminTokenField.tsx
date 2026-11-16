"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ADMIN_TOKEN_KEY } from "@/lib/ui";

/**
 * Operator-only: saves the arena admin token in this browser. The parent
 * re-fetches /api/models from `onChange` and passes back whether the server
 * accepted the token: still unauthorized after a submit means it was rejected.
 * Once authorized it shrinks to a status line with the only way to remove the
 * token from this browser.
 */
export default function AdminTokenField({
  onChange,
  authorized = false,
}: {
  onChange: () => void | Promise<void>;
  authorized?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    try {
      setValue(window.localStorage.getItem(ADMIN_TOKEN_KEY) ?? "");
    } catch {
      /* storage blocked: start empty */
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    try {
      if (token) window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
      else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch {
      /* storage blocked: the token cannot be kept, the server will say so */
    }
    setBusy(true);
    setRejected(false);
    try {
      await onChange();
    } finally {
      if (mounted.current) {
        setBusy(false);
        setRejected(token.length > 0);
      }
    }
  };

  const forget = async () => {
    try {
      window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch {
      /* storage blocked: there was nothing kept to remove */
    }
    setValue("");
    setRejected(false);
    setBusy(true);
    try {
      await onChange();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (authorized) {
    return (
      <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
        <span>
          <span aria-hidden>🔓 </span>
          <span className="text-[var(--gold)] font-semibold">Operator mode</span> — real models and
          tournaments are unlocked in this browser.
        </span>
        <button
          type="button"
          onClick={forget}
          disabled={busy}
          className="underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-50"
        >
          {busy ? "Forgetting…" : "Forget token"}
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label
        htmlFor="arena-admin-token"
        className="block text-xs font-semibold text-[var(--muted)] uppercase tracking-wider"
      >
        Admin token
      </label>
      <div className="flex gap-2">
        <input
          id="arena-admin-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setRejected(false);
          }}
          placeholder="Operator only"
          aria-invalid={rejected}
          aria-describedby={rejected ? "arena-admin-token-error" : undefined}
          className="min-w-0 flex-1 bg-[var(--panel-2)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[var(--gold)]"
        />
        <button type="submit" className="btn btn-ghost text-sm whitespace-nowrap" disabled={busy}>
          {busy ? "Checking…" : "🔓 Unlock"}
        </button>
      </div>
      {rejected && (
        <div id="arena-admin-token-error" role="alert" className="text-xs text-[var(--blood)]">
          That token wasn&apos;t accepted.
        </div>
      )}
    </form>
  );
}
