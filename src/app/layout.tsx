import type { Metadata } from "next";
import { isEphemeralDemo } from "@/server/db";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowForge",
  description: "Visual workflow automation and approvals with a real execution engine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
      {isEphemeralDemo() && (
        <div role="note" className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-950">
          Preview: sign-up opens once this deployment is connected to a database.
        </div>
      )}
        {children}
      </body>
    </html>
  );
}
