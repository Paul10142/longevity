import { NextResponse } from "next/server"
import { runWorkerTick } from "@/lib/worker"

// Same budget as /api/worker/tick — this runs a full tick in-process.
export const maxDuration = 300
export const dynamic = "force-dynamic"

/**
 * The admin "Run worker now" button. Gated by the admin session in
 * middleware.ts (every /api/admin route is), so it runs the tick directly
 * instead of calling /api/worker/tick — WORKER_SECRET never leaves the server.
 */
export async function POST() {
  try {
    const result = await runWorkerTick()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("[admin/worker/run] error:", error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
