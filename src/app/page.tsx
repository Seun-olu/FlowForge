import type { Metadata } from "next";
import Link from "next/link";
import { getUser } from "@/server/auth";

export const metadata: Metadata = {
  title: "FlowForge — visual workflows with human approvals",
  description:
    "Design approval workflows on a canvas, publish a fixed version, and run it on a real engine with branches, approvals, retries and a full audit trail.",
};

const features = [
  { title: "Visual editor", body: "Drag Start, Condition, Approval, Action and End nodes onto a canvas. Broken nodes are highlighted as you build." },
  { title: "Versions you can trust", body: "Drafts save freely. Publishing validates the flow and freezes a numbered version; every run keeps the version it started on." },
  { title: "Human approvals", body: "Approval steps wait in an inbox. Approvers approve or reject with a comment, and each request can only be decided once." },
  { title: "Retries and idempotency", body: "Failed actions retry with exponential backoff. Starting a run twice with the same key returns the same run." },
  { title: "Safe conditions", body: "Branch on expressions like input.amount > 1000 — parsed by FlowForge itself, never eval'd." },
  { title: "Roles and audit", body: "Owners, admins, editors, approvers and viewers, enforced in the database. Every publish, decision and membership change is logged." },
];

const steps = [
  { n: "1", title: "Build", body: "Start from a blank canvas or the purchase-approval template." },
  { n: "2", title: "Publish", body: "Validation checks every path before a version goes live." },
  { n: "3", title: "Run", body: "Start runs with JSON input, then follow each step, approval and log line." },
];

/** A static picture of the sample flow, so the page explains itself before sign-up. */
function FlowDiagram() {
  const node = "rounded-lg border bg-white px-3 py-2 text-xs font-medium shadow-sm";
  return (
    <figure aria-label="Example workflow: purchases over 1000 need a manager's approval; smaller ones are approved automatically" className="relative mx-auto w-full max-w-md">
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 shadow-xl shadow-indigo-100">
        <div className="flex flex-col items-center gap-3" aria-hidden>
          <span className={`${node} border-emerald-300 text-emerald-800`}>▶ Start · purchase request</span>
          <span className="h-5 w-px bg-slate-300" />
          <span className={`${node} border-amber-300 text-amber-900`}>◇ input.amount &gt; 1000 ?</span>
          <div className="grid w-full grid-cols-2 gap-4 pt-1">
            <div className="flex flex-col items-center gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">true</span>
              <span className={`${node} border-indigo-300 text-indigo-800`}>✋ Manager approval</span>
              <span className="h-4 w-px bg-slate-300" />
              <span className={`${node} border-slate-300 text-slate-700`}>✉ Log decision</span>
            </div>
            <div className="flex flex-col items-center gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">false</span>
              <span className={`${node} border-sky-300 text-sky-800`}>⚙ Auto-approve</span>
              <span className="h-4 w-px bg-slate-300" />
              <span className={`${node} border-emerald-300 text-emerald-800`}>■ Done</span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-500">The built-in purchase-approval template</figcaption>
    </figure>
  );
}

export default async function Landing() {
  const user = await getUser();
  const primary = "inline-flex items-center justify-center rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600";
  const secondary = "inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600";

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="text-lg font-bold tracking-tight">Flow<span className="text-indigo-600">Forge</span></Link>
        <nav aria-label="Account" className="flex items-center gap-3 text-sm">
          {user ? (
            <Link href="/app" className={primary}>Open FlowForge</Link>
          ) : (
            <>
              <Link href="/login" className="font-medium text-slate-700 hover:text-slate-900">Sign in</Link>
              <Link href="/signup" className={primary}>Get started</Link>
            </>
          )}
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-10 sm:px-6 lg:grid-cols-2 lg:pt-16">
          <div>
            <p className="text-sm font-semibold text-indigo-600">Workflow automation · approvals · audit</p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
              Approval workflows you can see, version and trust.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
              Draw the process on a canvas, publish a fixed version, and let a real engine run it: branching on your data,
              waiting for people to approve, retrying what fails, and recording every step.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href={user ? "/app" : "/signup"} className={primary}>{user ? "Open FlowForge" : "Create a free account"}</Link>
              <a href="#how" className={secondary}>See how it works</a>
            </div>
            <p className="mt-4 text-sm text-slate-500">No setup: sign up, create an organisation, start from the purchase-approval template.</p>
          </div>
          <FlowDiagram />
        </section>

        <section aria-labelledby="features" className="border-y border-slate-100 bg-slate-50">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="features" className="text-2xl font-bold tracking-tight">Everything a sign-off process needs</h2>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <li key={f.title} className="rounded-xl border border-slate-200 bg-white p-5">
                  <h3 className="font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="how" aria-labelledby="how-title" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-16 sm:px-6">
          <h2 id="how-title" className="text-2xl font-bold tracking-tight">How it works</h2>
          <ol className="mt-8 grid gap-6 sm:grid-cols-3">
            {steps.map((s) => (
              <li key={s.n} className="flex gap-4">
                <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-600 font-bold text-white">{s.n}</span>
                <div>
                  <h3 className="font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-slate-600">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-12 rounded-2xl bg-indigo-600 px-6 py-10 text-center text-white sm:px-12">
            <h2 className="text-2xl font-bold">Try it with the sample workflow</h2>
            <p className="mx-auto mt-2 max-w-xl text-indigo-100">Run it with an amount of 50 to see it auto-approve, or 5000 to watch it wait in your approval inbox.</p>
            <Link href={user ? "/app" : "/signup"} className="mt-6 inline-flex rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
              {user ? "Open FlowForge" : "Get started free"}
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-slate-500 sm:px-6">
          <p>FlowForge — a portfolio project by Seun Olugbewesa.</p>
          <a href="https://github.com/Seun-olu/FlowForge" className="hover:text-slate-800" target="_blank" rel="noopener noreferrer">Source on GitHub</a>
        </div>
      </footer>
    </div>
  );
}
