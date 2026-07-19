import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { enqueueJob, pingWorker } from "@/lib/jobs"

/** Enqueue synthesis (clinician + patient article + protocol) for one topic. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  }
  const { id } = await params
  await enqueueJob("generate_topic", { topic_id: id })
  pingWorker(request.nextUrl.origin)
  return NextResponse.json({ ok: true, message: "Synthesis queued." })
}
