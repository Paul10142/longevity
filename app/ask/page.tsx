import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { AskClient } from "@/components/ask/AskClient"
import { isAdmin } from "@/lib/isAdmin"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Ask the Library",
  robots: { index: false, follow: false },
}

/**
 * Ask the Library: a physician's question in, a short cited brief out.
 *
 * Admin-only for now. `middleware.ts` is the real gate (/ask is on its
 * UNRELEASED list); this check is a second lock so the page never shows to a
 * visitor even if the two ship out of step, and it sends them home the same
 * way the middleware does.
 */
export default async function AskPage() {
  if (!(await isAdmin())) redirect("/")
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-10">
        <AskClient />
      </main>
    </div>
  )
}
