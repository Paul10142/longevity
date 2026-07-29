/**
 * Overnight re-tag orchestrator (topic-curation phase).
 *
 *   SKIP_SYNTHESIS_FANOUT=1 npx tsx --env-file=.env.local scripts/retagLoop.ts
 *
 * Loops: drain tag_claims → run discovery to open branches for whatever didn't
 * fit → drain again (discovery auto-enqueues tag). Repeats until the "unfiled"
 * count (active claims the tagger couldn't home, topic_fit='unfiled') stops
 * dropping or reaches zero. Claims that need a brand-new ROOT can't be homed
 * automatically (roots require Paul's approval), so a plateau there is expected
 * and is the correct stop signal, not a failure.
 *
 * SKIP_SYNTHESIS_FANOUT=1 is REQUIRED — without it, handleTagClaims fans out to
 * paid update_topic article regen for every topic that gained a claim.
 *
 * Resumable: every job checkpoints in the jobs table, so if the process dies
 * (laptop sleep) re-running resumes mid-drain. Idempotent: tag only touches
 * needs_tagging=true claims.
 */
// `export {}` marks this file a module so its top-level `main` doesn't collide
// with pipeline.ts's global `main` (both use dynamic imports, no static import,
// which would otherwise leave them in the global script scope — a build error).
export {}

process.env.LLM_BACKEND = process.env.LLM_BACKEND || "claude-code"
process.env.SKIP_SYNTHESIS_FANOUT = process.env.SKIP_SYNTHESIS_FANOUT || "1"

const MAX_ROUNDS = Number(process.env.RETAG_MAX_ROUNDS ?? 8)

function log(msg: string) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`)
}

async function main() {
  const { enqueueJob } = await import("../lib/jobs")
  const { runWorkerTick } = await import("../lib/worker")
  const { supabaseAdmin } = await import("../lib/supabaseServer")
  const db = supabaseAdmin
  if (!db) throw new Error("Supabase not configured")

  const countBy = async (col: string, val: string | boolean): Promise<number> => {
    const { count } = await db
      .from("claims").select("id", { count: "exact", head: true })
      .eq("status", "active").eq(col, val as never)
    return count ?? 0
  }
  const snapshot = async () => ({
    unfiled: await countBy("topic_fit", "unfiled"),
    needsTagging: await countBy("needs_tagging", true),
    good: await countBy("topic_fit", "good"),
    approx: await countBy("topic_fit", "approximate"),
  })

  // Drain the queue: keep ticking until a tick processes nothing. Tolerates
  // transient CLI errors (log + brief backoff) up to a consecutive cap.
  const drain = async (label: string) => {
    let total = 0, errs = 0
    for (;;) {
      try {
        const { processed } = await runWorkerTick(15 * 60_000)
        total += processed
        errs = 0
        if (processed === 0) break
        log(`  [${label}] +${processed} (${total} total this drain)`)
      } catch (e) {
        errs++
        log(`  [${label}] tick error (${errs}/5): ${e instanceof Error ? e.message : e}`)
        if (errs >= 5) { log(`  [${label}] giving up this drain after 5 consecutive errors`); break }
        await new Promise((r) => setTimeout(r, 15_000))
      }
    }
    return total
  }

  log(`=== RE-TAG LOOP START (backend=${process.env.LLM_BACKEND}, fanout skipped) ===`)
  let s = await snapshot()
  log(`start: unfiled=${s.unfiled} needs_tagging=${s.needsTagging} good=${s.good} approx=${s.approx}`)

  let prevUnfiled = Number.POSITIVE_INFINITY
  let plateau = 0

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    log(`--- round ${round}/${MAX_ROUNDS} ---`)

    // 1) TAG: file everything currently flagged needs_tagging into the tree.
    await enqueueJob("tag_claims", {})
    await drain(`r${round}-tag`)
    s = await snapshot()
    log(`round ${round} after tag: unfiled=${s.unfiled} needs_tagging=${s.needsTagging} good=${s.good} approx=${s.approx}`)
    if (s.unfiled === 0 && s.needsTagging === 0) { log("all claims filed — done"); break }

    // 2) DISCOVER: open new branches under existing pillars for the remainder,
    //    then drain (discovery re-flags touched claims and auto-enqueues tag).
    await enqueueJob("discover_topics", {})
    await drain(`r${round}-discover`)
    s = await snapshot()
    log(`round ${round} after discover+tag: unfiled=${s.unfiled} needs_tagging=${s.needsTagging} good=${s.good} approx=${s.approx}`)
    if (s.unfiled === 0 && s.needsTagging === 0) { log("all claims filed — done"); break }

    // Stop when unfiled stops dropping across a full round (remainder needs new
    // ROOTS, which require Paul's approval — not something the loop can resolve).
    if (s.unfiled >= prevUnfiled) {
      plateau++
      log(`no progress on unfiled (${s.unfiled} >= ${prevUnfiled}) — plateau ${plateau}/2`)
      if (plateau >= 2) { log("plateaued — stopping"); break }
    } else {
      plateau = 0
    }
    prevUnfiled = s.unfiled
  }

  const final = await snapshot()
  const total = await countBy("status", "active")
  log(`=== RE-TAG LOOP DONE ===`)
  log(`final: active=${total} good=${final.good} approx=${final.approx} unfiled=${final.unfiled} needs_tagging=${final.needsTagging}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
