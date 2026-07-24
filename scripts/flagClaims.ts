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

async function main() {
  const [cmd, flag] = process.argv.slice(2)
  switch (cmd) {
    case 'run': await run(flag === '--dry-run'); return
    case 'report': await report(); return
    default:
      console.log('usage: npx tsx --env-file=.env.local scripts/flagClaims.ts <run [--dry-run]|report>')
      process.exit(1)
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
