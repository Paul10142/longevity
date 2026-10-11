/**
 * Who may trigger a worker tick (`/api/worker/tick`).
 *
 * A tick drains the job queue and makes paid LLM calls, so the endpoint FAILS
 * CLOSED: a caller must present one of these as `Authorization: Bearer <secret>`.
 *
 *  - WORKER_SECRET — sent by `pingWorker` after each enqueue (server-side only).
 *  - CRON_SECRET   — sent automatically by Vercel cron, if a cron is ever added.
 *
 * Any other header (e.g. `x-vercel-cron`) is NOT trusted: callers can forge it.
 *
 * The one exception: outside production (`next dev`) with no secret configured
 * at all, the endpoint stays open so local development works without setup.
 * Vercel production and preview builds run with NODE_ENV=production.
 */

import { safeEqual } from './adminAuth'

type WorkerAuthEnv = {
  WORKER_SECRET?: string
  CRON_SECRET?: string
  NODE_ENV?: string
}

export function isWorkerRequestAuthorized(
  authorization: string | null,
  env: WorkerAuthEnv = process.env
): boolean {
  const secrets = [env.WORKER_SECRET, env.CRON_SECRET].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  )
  if (secrets.length === 0) return env.NODE_ENV !== 'production'
  if (!authorization) return false
  return secrets.some((s) => safeEqual(authorization, `Bearer ${s}`))
}
