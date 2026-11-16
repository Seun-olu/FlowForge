import Link from "next/link";
import { signIn } from "@/app/actions";
import { AuthForm } from "@/components/forms";
import { isEphemeralDemo } from "@/server/db";
import { card } from "@/components/ui";

export default function LoginPage() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-semibold"><Link href="/" className="hover:text-indigo-700">FlowForge</Link></h1>
      <p className="mb-6 text-sm text-slate-600">Sign in to build and run workflows.</p>
      {isEphemeralDemo() ? (
        <div role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-semibold">Accounts aren&apos;t available on this preview yet.</p>
          <p className="mt-1">This deployment isn&apos;t connected to a database, so sign-up and sign-in are switched off rather than losing your account.</p>
        </div>
      ) : (
        <div className={`${card} p-6`}><AuthForm action={signIn} mode="login" /></div>
      )}
    </main>
  );
}
