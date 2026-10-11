import { NextRequest, NextResponse } from 'next/server'
import { runWorkerTick } from '@/lib/worker'
import { isWorkerRequestAuthorized } from '@/lib/workerAuth'

// Allow long-running drains on Vercel (Pro tier caps at 300s).
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Worker entrypoint. Triggered by:
 *  - a fire-and-forget ping after enqueue (POST, Bearer WORKER_SECRET)
 *  - Vercel cron, if one is added to vercel.json (GET, Bearer CRON_SECRET)
 *
 * The admin "Run worker now" button does NOT call this route — it goes through
 * the session-gated /api/admin/worker/run, so no secret reaches the browser.
 * Fails closed in production; see lib/workerAuth.ts.
 */
async function handle(request: NextRequest) {
  if (!isWorkerRequestAuthorized(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runWorkerTick()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error('[worker/tick] error:', error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

export const GET = handle
export const POST = handle
