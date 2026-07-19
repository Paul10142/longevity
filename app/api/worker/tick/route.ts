import { NextRequest, NextResponse } from 'next/server'
import { runWorkerTick } from '@/lib/worker'

// Allow long-running drains on Vercel (Pro tier caps at 300s).
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Worker entrypoint. Triggered by:
 *  - Vercel cron (GET, see vercel.json)
 *  - a fire-and-forget ping after enqueue (POST)
 *  - the admin "Run worker now" button (POST)
 *
 * If WORKER_SECRET is set, callers must present it as a Bearer token.
 * Cron requests carry Vercel's own auth header and are allowed through.
 */
async function authorize(request: NextRequest): Promise<boolean> {
  const secret = process.env.WORKER_SECRET
  if (!secret) return true
  const header = request.headers.get('authorization')
  if (header === `Bearer ${secret}`) return true
  // Vercel cron requests include this header automatically.
  if (request.headers.get('x-vercel-cron')) return true
  return false
}

async function handle(request: NextRequest) {
  if (!(await authorize(request))) {
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
