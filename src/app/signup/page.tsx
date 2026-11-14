import { signUp } from "@/app/actions";
import { AuthForm } from "@/components/forms";
import { card } from "@/components/ui";

export default function SignupPage() {
  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <h1 className="mb-1 text-2xl font-semibold">Create your FlowForge account</h1>
      <p className="mb-6 text-sm text-slate-600">Local accounts; passwords are hashed with scrypt.</p>
      <div className={`${card} p-6`}><AuthForm action={signUp} mode="signup" /></div>
    </main>
  );
}
