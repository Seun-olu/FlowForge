"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { FormState } from "@/app/actions";
import { btnDanger, btnPrimary, btnSecondary, FormMessage, input, label } from "./ui";

type Action = (state: FormState, form: FormData) => Promise<FormState>;

export function AuthForm({ action, mode }: { action: Action; mode: "login" | "signup" }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-4">
      {mode === "signup" && (
        <div>
          <label htmlFor="name" className={label}>Name</label>
          <input id="name" name="name" required className={input} autoComplete="name" />
        </div>
      )}
      <div>
        <label htmlFor="email" className={label}>Email</label>
        <input id="email" name="email" type="email" required className={input} autoComplete="email" />
      </div>
      <div>
        <label htmlFor="password" className={label}>Password</label>
        <input id="password" name="password" type="password" required minLength={8} className={input}
          autoComplete={mode === "signup" ? "new-password" : "current-password"} />
      </div>
      <FormMessage state={state} />
      <button className={`${btnPrimary} w-full`} disabled={pending}>{mode === "signup" ? "Create account" : "Sign in"}</button>
      <p className="text-center text-sm text-slate-600">
        {mode === "signup" ? <>Have an account? <Link className="text-indigo-600 underline" href="/login">Sign in</Link></>
          : <>New here? <Link className="text-indigo-600 underline" href="/signup">Create an account</Link></>}
      </p>
    </form>
  );
}

/** One-or-two field inline form (create org, create workflow, add member). */
export function InlineForm({ action, children, submit }: { action: Action; children: React.ReactNode; submit: string }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        {children}
        <button className={btnPrimary} disabled={pending}>{submit}</button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function RunForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-2">
      <div>
        <label htmlFor="run-input" className={label}>Input (JSON)</label>
        <textarea id="run-input" name="input" rows={4} defaultValue={'{\n  "amount": 1500\n}'} className={`${input} font-mono text-xs`} />
      </div>
      <div>
        <label htmlFor="idem" className={label}>Idempotency key (optional)</label>
        <input id="idem" name="idempotencyKey" className={input} placeholder="e.g. order-42" />
      </div>
      <FormMessage state={state} />
      <button className={`${btnPrimary} w-full`} disabled={pending}>{pending ? "Running…" : "Run published version"}</button>
    </form>
  );
}

export function DecisionForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [comment, setComment] = useState("");
  if (state?.ok) return <FormMessage state={state} />;
  return (
    <form action={formAction} className="space-y-2">
      <input name="comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500}
        placeholder="Comment (optional)" aria-label="Comment" className={input} />
      <div className="flex gap-2">
        <button name="decision" value="approved" className={btnPrimary} disabled={pending}>Approve</button>
        <button name="decision" value="rejected" className={btnDanger} disabled={pending}>Reject</button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function ActionButton({ action, children, danger }: { action: () => Promise<FormState>; children: React.ReactNode; danger?: boolean }) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="inline-flex flex-col gap-1">
      <button className={danger ? btnDanger : btnSecondary} disabled={pending}>{children}</button>
      <FormMessage state={state} />
    </form>
  );
}
