/**
 * Claim flag rules (v4 spec §7.2) — the deterministic half.
 *
 *   npx tsx --env-file=.env.local scripts/flagClaims.ts <command>
 *
 * Four rules gate claims before synthesis. Two of them need no model at all, and
 * those are implemented here:
 *
 *   merge_fidelity — the canonical asserts a numeric specific (dose, threshold,
 *                    range, percentage) that NO member insight carried, i.e. the
 *                    merge invented specificity. §6 calls this "the cheap
 *                    automated half" of the merge-fidelity gate; the human half
 *                    is the review view in §7.3. It reuses the exact guard
 *                    enrich-merge already applies to its own rewrites
 *                    (`fidelityCheck`), so a merge is held to the same standard
 *                    whether the canonical was written by a seed or a rewrite.
 *   orphan_topic   — filed under no topic, or filed only approximately. Cheap to
 *                    review and it surfaces taxonomy gaps rather than claim bugs.
 *
 * The other two need a judge and are NOT implemented here:
 *   standalone     — "could a physician act on this sentence alone?" is a rubric
 *                    judgement (§7.2 is explicit that it is defined by a rubric,
 *                    validated against ~30 of Paul's rulings, and NOT tuned to
 *                    hit a count). Guessing at it in code would produce exactly
 *                    the "12% least-clear claims" the spec warns against.
 *   contradiction  — needs semantic comparison across claim pairs.
 *
 * Commands:
 *   run [--dry-run]   apply the deterministic rules; --dry-run prints only
 *   report            open flags by rule, with examples
 *
 * DB only, no LLM: safe to run while a pipeline drain is going.
 */

import { fidelityCheck } from '../lib/enrichMerge'

type ClaimRow = { id: string; canonical_statement: string; member_count: number }

async function loadDb() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured — need .env.local')
  return supabaseAdmin
}

/** Insert a flag, or leave the existing one alone. One row per (claim, rule),
 *  so re-running a rule is idempotent and never duplicates a reviewer's queue. */
async function raise(
  db: Awaited<ReturnType<typeof loadDb>>,
  claimId: string,
  rule: string,
  detail: string,
  evidence: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from('claim_flags')
    .upsert({ claim_id: claimId, rule, detail, evidence }, { onConflict: 'claim_id,rule', ignoreDuplicates: true })
  if (error) throw new Error(`raise ${rule} on ${claimId}: ${error.message}`)
}

async function run(dryRun: boolean): Promise<void> {
  const db = await loadDb()
  const { selectAllPaged } = await import('../lib/pagination')

  // ── merge_fidelity ────────────────────────────────────────
  // Only multi-member claims can have invented specificity: a single-member
  // claim's canonical IS its member, so there is nothing to have invented.
  const claims = await selectAllPaged<ClaimRow>(
    (from, to) => db
      .from('claims')
      .select('id, canonical_statement, member_count')
      .eq('status', 'active')
      .gt('member_count', 1)
      .order('created_at', { ascending: true })
      .range(from, to)
  )
  console.log(`merge_fidelity: checking ${claims.length} multi-member claim(s)…`)

  let fidelityFlags = 0
  for (let i = 0; i < claims.length; i += 200) {
    const batch = claims.slice(i, i + 200)
    const { data: members, error } = await db
      .from('claim_members')
      .select('claim_id, raw_insights(statement, direct_quote)')
      .in('claim_id', batch.map(c => c.id))
    if (error) throw new Error(`load members: ${error.message}`)

    const groundingByClaim = new Map<string, string[]>()
    for (const m of (members ?? []) as { claim_id: string; raw_insights: { statement: string; direct_quote: string | null } | null }[]) {
      const texts = groundingByClaim.get(m.claim_id) ?? []
      if (m.raw_insights?.statement) texts.push(m.raw_insights.statement)
      // The verbatim quote counts as grounding too: a number the speaker said
      // but the paraphrase dropped is still traceable to the source, and
      // flagging it would be a false positive.
      if (m.raw_insights?.direct_quote) texts.push(m.raw_insights.direct_quote)
      groundingByClaim.set(m.claim_id, texts)
    }

    for (const c of batch) {
      const grounding = groundingByClaim.get(c.id) ?? []
      if (grounding.length === 0) continue
      const { ok, invented } = fidelityCheck(c.canonical_statement, grounding)
      if (ok) continue
      fidelityFlags++
      if (dryRun) {
        console.log(`  ⚑ ${c.id}  invented ${JSON.stringify(invented)}`)
        console.log(`     «${c.canonical_statement.slice(0, 110)}»`)
      } else {
        await raise(db, c.id, 'merge_fidelity',
          `canonical asserts ${invented.join(', ')} — carried by no member`,
          { invented, member_count: c.member_count })
      }
    }
  }
  console.log(`merge_fidelity: ${fidelityFlags} flag(s)${dryRun ? ' (dry run)' : ''}`)

  // ── orphan_topic ──────────────────────────────────────────
  // `needs_tagging` claims are EXCLUDED. For a claim the tagger has not reached
  // yet, "no topic" means "not processed", not "orphan" — flagging it says
  // nothing about the claim and everything about queue order. Ignoring this
  // buried the rule's real signal: on first run it flagged 452 of 719 claims,
  // every one of them simply awaiting a deferred tagging pass. A review queue
  // that is two-thirds false positives is one nobody reads.
  const active = await selectAllPaged<{ id: string; canonical_statement: string; topic_fit: string | null }>(
    (from, to) => db
      .from('claims')
      .select('id, canonical_statement, topic_fit')
      .eq('status', 'active')
      .eq('needs_tagging', false)
      .order('created_at', { ascending: true })
      .range(from, to)
  )
  const links = await selectAllPaged<{ claim_id: string }>(
    (from, to) => db.from('claim_topics').select('claim_id').order('claim_id', { ascending: true }).range(from, to)
  )
  const filed = new Set(links.map(l => l.claim_id))

  let orphanFlags = 0
  for (const c of active) {
    const unfiled = !filed.has(c.id)
    const weak = c.topic_fit === 'unfiled'
    if (!unfiled && !weak) continue
    orphanFlags++
    if (dryRun) {
      console.log(`  ⚑ ${c.id}  ${unfiled ? 'no topic' : 'weak fit'}  «${c.canonical_statement.slice(0, 80)}»`)
    } else {
      await raise(db, c.id, 'orphan_topic',
        unfiled ? 'filed under no topic' : `weak topic fit (${c.topic_fit})`,
        { unfiled, topic_fit: c.topic_fit })
    }
  }
  console.log(`orphan_topic:   ${orphanFlags} flag(s)${dryRun ? ' (dry run)' : ''} of ${active.length} active claim(s)`)

  if (!dryRun) {
    console.log(`\nFlags recorded. They do NOT quarantine anything yet — quarantine is`)
    console.log(`claims.status = 'flagged', a deliberate step once the rubric is validated (§7.2).`)
  }
}

async function report(): Promise<void> {
  const db = await loadDb()
  const { data, error } = await db
    .from('claim_flags')
    .select('rule, detail, claim_id, resolved_at, claims(canonical_statement)')
    .is('resolved_at', null)
  if (error) throw new Error(error.message)

  type Row = { rule: string; detail: string | null; claim_id: string; claims: { canonical_statement: string } | null }
  const rows = (data ?? []) as Row[]
  const byRule = new Map<string, Row[]>()
  for (const r of rows) byRule.set(r.rule, [...(byRule.get(r.rule) ?? []), r])

  console.log(`\nOPEN CLAIM FLAGS — ${rows.length} total\n`)
  for (const [rule, list] of byRule) {
    console.log(`  ${rule.padEnd(16)} ${list.length}`)
    for (const r of list.slice(0, 5)) {
      console.log(`      ${r.detail ?? ''}`)
      console.log(`      «${(r.claims?.canonical_statement ?? '').slice(0, 96)}»`)
    }
    if (list.length > 5) console.log(`      … and ${list.length - 5} more`)
  }
  console.log()
}

// ── extraction_fidelity (LLM, spec §6.2) ────────────────────
/**
 * Flag a CLAIM when any of its member insights asserts something its source
 * chunk does not support. The fidelity failure is at the insight level, but the
 * gate acts on claims (they are what synthesis reads), so a claim is flagged if
 * ANY member is judged unfaithful, and the offending member + span travels on
 * the flag so review needs no re-derivation.
 *
 * ~1 LLM call per member insight, so it is bounded, resumable (skips claims
 * already flagged), and must NOT run alongside a pipeline drain — two heavy CLI
 * consumers throttle each other.
 */
async function runFidelity(limit: number | undefined, dryRun: boolean, sourceId?: string): Promise<void> {
  const db = await loadDb()
  const { selectAllPaged } = await import('../lib/pagination')
  const { judgeFidelity, isRealFidelity, isViolation } = await import('../lib/extractionFidelity')

  // COST: ~one LLM call per claim (~50s each via the local CLI), so a full-corpus
  // sweep of ~1200 claims is ~16 hours — NOT how this is meant to run. §7.2 is
  // explicit: run it incrementally per NEW source. `--source <id>` scopes it to
  // one source's claims (the intended path); `--limit N` bounds an ad-hoc run.
  // Never run this alongside a pipeline drain — two heavy CLI consumers throttle.
  //
  // One representative (seed) member per claim keeps it one call per CLAIM, not
  // per member: a claim's members are near-paraphrases of one idea, so the seed
  // is a fair proxy for whether extraction invented substance.
  let claims: { id: string }[]
  if (sourceId) {
    // Claims that have at least one member insight from this source.
    const memberClaims = await selectAllPaged<{ claim_id: string }>(
      (from, to) => db
        .from('claim_members')
        .select('claim_id, raw_insights!inner(source_id)')
        .eq('raw_insights.source_id', sourceId)
        .order('claim_id', { ascending: true })
        .range(from, to)
    )
    const ids = Array.from(new Set(memberClaims.map(m => m.claim_id)))
    claims = ids.map(id => ({ id }))
  } else {
    claims = await selectAllPaged<{ id: string }>(
      (from, to) => db.from('claims').select('id').eq('status', 'active').order('created_at', { ascending: true }).range(from, to)
    )
  }
  // Resume: skip claims already carrying this flag. (A FAITHFUL claim carries no
  // flag, so it is re-judged on a later run — acceptable for the incremental
  // per-source path, where each run covers only one source's claims once.)
  const existing = await selectAllPaged<{ claim_id: string }>(
    (from, to) => db.from('claim_flags').select('claim_id').eq('rule', 'extraction_fidelity').order('claim_id', { ascending: true }).range(from, to)
  )
  const flagged = new Set(existing.map(e => e.claim_id))
  let todo = claims.filter(c => !flagged.has(c.id))
  const outsideLimit = limit && todo.length > limit ? todo.length - limit : 0
  if (limit) todo = todo.slice(0, limit)
  console.log(`extraction_fidelity: judging ${todo.length} claim(s)${sourceId ? ` from source ${sourceId.slice(0, 8)}` : ''}${outsideLimit ? ` (${outsideLimit} more beyond --limit)` : ''}…`)

  let flags = 0, checked = 0
  for (const c of todo) {
    // Seed member + its chunk.
    const { data: mem } = await db
      .from('claim_members')
      .select('matched_by, raw_insights(statement, context_note, direct_quote, chunks(content))')
      .eq('claim_id', c.id)
      .order('matched_by', { ascending: true }) // 'auto' < 'human' < 'seed'; take seed if present below
    type M = { matched_by: string; raw_insights: { statement: string; context_note: string | null; direct_quote: string | null; chunks: { content: string } | null } | null }
    const members = (mem ?? []) as M[]
    const seed = members.find(m => m.matched_by === 'seed') ?? members[0]
    const chunk = seed?.raw_insights?.chunks?.content
    if (!seed?.raw_insights || !chunk) continue // manual sources may lack a chunk link

    const v = await judgeFidelity(seed.raw_insights.statement, chunk, {
      contextNote: seed.raw_insights.context_note,
      directQuote: seed.raw_insights.direct_quote,
    })
    checked++
    if (!isRealFidelity({ verdict: v.verdict, offending: v.offending, reasoning: v.reasoning })) continue
    if (!isViolation(v.verdict)) continue
    flags++
    if (dryRun) {
      console.log(`  ⚑ ${c.id}  ${v.verdict}  «${v.offending.slice(0, 60)}»  ${v.reasoning.slice(0, 70)}`)
    } else {
      await raise(db, c.id, 'extraction_fidelity',
        `${v.verdict}: ${v.reasoning}`,
        { verdict: v.verdict, offending: v.offending, statement: seed.raw_insights.statement })
    }
    if ((checked % 25) === 0) console.log(`  …${checked} checked, ${flags} flagged`)
  }
  console.log(`extraction_fidelity: ${flags} flag(s) over ${checked} claim(s) checked${dryRun ? ' (dry run)' : ''}`)
}

// ── manual review lane ──────────────────────────────────────
async function manualFlag(claimId: string, note: string): Promise<void> {
  const db = await loadDb()
  const { data: claim } = await db.from('claims').select('id').eq('id', claimId).maybeSingle()
  if (!claim) throw new Error(`no claim ${claimId}`)
  const { error } = await db
    .from('claim_flags')
    .upsert({ claim_id: claimId, rule: 'manual', detail: note || 'flagged for review' }, { onConflict: 'claim_id,rule', ignoreDuplicates: false })
  if (error) throw new Error(error.message)
  console.log(`Flagged ${claimId} (manual): ${note || '(no note)'}`)
}

async function resolveFlag(flagId: string, resolution: string): Promise<void> {
  const db = await loadDb()
  const allowed = ['approved', 'edited', 'split', 'narrowed', 'archived', 'false_positive', 'reworded']
  if (!allowed.includes(resolution)) throw new Error(`resolution must be one of: ${allowed.join(', ')}`)
  const { data, error } = await db
    .from('claim_flags')
    .update({ resolved_at: new Date().toISOString(), resolution })
    .eq('id', flagId)
    .select('claim_id, rule')
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error(`no flag ${flagId}`)
  console.log(`Resolved flag ${flagId} (${(data as { rule: string }).rule}) → ${resolution}`)
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2)
  switch (cmd) {
    case 'run': await run(a === '--dry-run'); return
    case 'fidelity': {
      // fidelity [--dry-run] [--limit N] [--source <id>]
      const args = process.argv.slice(3)
      const dry = args.includes('--dry-run')
      const li = args.indexOf('--limit')
      const si = args.indexOf('--source')
      await runFidelity(li > -1 ? Number(args[li + 1]) : undefined, dry, si > -1 ? args[si + 1] : undefined)
      return
    }
    case 'report': await report(); return
    case 'flag': {
      if (!a) throw new Error('usage: flag <claim_id> "<note>"')
      await manualFlag(a, b ?? ''); return
    }
    case 'resolve': {
      if (!a || !b) throw new Error('usage: resolve <flag_id> <approved|edited|split|narrowed|archived|false_positive|reworded>')
      await resolveFlag(a, b); return
    }
    default:
      console.log('usage: npx tsx --env-file=.env.local scripts/flagClaims.ts <run [--dry-run]|fidelity [--dry-run] [--limit N]|report|flag <claim_id> "note"|resolve <flag_id> <resolution>>')
      process.exit(1)
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
