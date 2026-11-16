import Link from "next/link";
import { signIn } from "@/app/actions";
import { AuthForm } from "@/components/forms";
import { card } from "@/components/ui";

export default function LoginPage() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-semibold"><Link href="/" className="hover:text-indigo-700">FlowForge</Link></h1>
      <p className="mb-6 text-sm text-slate-600">Sign in to build and run workflows.</p>
      <div className={`${card} p-6`}><AuthForm action={signIn} mode="login" /></div>
    </main>
  );
}
