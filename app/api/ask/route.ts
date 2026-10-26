import { NextRequest, NextResponse, after } from "next/server"
import { isAdmin } from "@/lib/isAdmin"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { ask, checkQuestion } from "@/lib/ask/ask"
import type { AskEvent } from "@/lib/ask/types"

export const dynamic = "force-dynamic"
// Hobby caps a function at 60 s (ARCHITECTURE.md "Deployment"); Pro allows 300.
// Streaming starts the response early, which is what makes the cap survivable;
// the measured latency is in docs/ask-the-library-design.md §7.
export const maxDuration = 60

/**
 * Ask the Library: POST { question, refresh? } -> NDJSON, one event per line
 * (docs/ask-the-library-design.md §6.7). Admin-only for now (middleware.ts gates
 * the path; this checks the session again so the route is safe on its own).
 */
export async function POST(request: NextRequest) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })

  let body: { question?: unknown; refresh?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Send JSON: { question }" }, { status: 400 })
  }
  const checked = checkQuestion(body.question)
  if (!checked.ok) return NextResponse.json({ error: checked.message }, { status: 400 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      // A client that navigates away must not abort the answer: it is still
      // worth storing (and was already paid for), so writes just stop.
      const emit = (event: AskEvent) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"))
        } catch {
          open = false
        }
      }
      await ask(checked.question, {
        emit,
        schedule: (fn) => after(fn),
        askedBy: "admin",
        refresh: body.refresh === true,
      })
      try {
        controller.close()
      } catch { /* already closed by the client */ }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
