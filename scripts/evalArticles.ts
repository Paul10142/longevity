/**
 * Article-quality eval set (v4 spec §6.1, guiding doc §D Phase 0 step 4).
 *
 *   npx tsx scripts/evalArticles.ts <command>
 *
 * A FIXED set of topics whose article metrics are recorded now, so every later
 * synthesis change can be measured as "did the articles get better or worse?"
 * instead of argued. It changes no behaviour and costs a few dollars.
 *
 * It also produces the SENTENCE-LEVEL groundedness baselines the real floor is
 * re-derived from (spec §8/F5): today's stored scores are PARAGRAPH-level, but
 * the v4 rewrite scores sentences — a stricter, finer distribution — so the
 * paragraph-era 0.85/cap-2 placeholders cannot be shipped onto sentence scores
 * unexamined. This measures the sentence distribution on the current prose.
 *
 * Commands:
 *   snapshot            Record stored groundedness/coverage/length/paragraph
 *                       count for the eval topics → eval/article-eval-baseline.json.
 *                       Needs .env.local (Supabase).
 *   sentences [--limit] Re-audit the eval articles at SENTENCE granularity (Haiku)
 *                       → eval/article-sentence-baseline.json. Needs Supabase + LLM.
 *
 * EVAL_TOPICS spans the current groundedness range (AMPK 0.40 → Functional Aging
 * 0.86) so the set is representative, not cherry-picked. Adjust to the real slugs
 * once confirmed against the DB.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { claudeJson, CLAUDE_BULK_MODEL } from '../lib/llm'

const EVAL_DIR = 'eval'
const BASELINE_FILE = `${EVAL_DIR}/article-eval-baseline.json`
const SENTENCE_FILE = `${EVAL_DIR}/article-sentence-baseline.json`

// The fixed eval set — chosen to span the groundedness range. These are topic
// NAMES; `snapshot` resolves each to its latest clinician article.
const EVAL_TOPICS = [
  'AMPK Signaling',       // ~0.40 — thin claims, worst groundedness
  'Cognitive Aging',      // ~0.60
  'Sleep & Cognition',    // ~0.67
  'Sleep',                // ~0.70
  'Functional Aging',     // ~0.86 — best, for the top of the range
]

type Paragraph = { id: string; text: string; claim_ids: string[] }
type Section = { id: string; title: string; paragraphs: Paragraph[] }
type Outline = { title: string; sections: Section[] }

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

async function db() {
  process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  if (!supabaseAdmin) throw new Error('Supabase not configured — need .env.local')
  return supabaseAdmin
}

/** Latest clinician article row for a topic name. */
async function loadArticle(sb: Awaited<ReturnType<typeof db>>, name: string) {
  const { data: topic } = await sb.from('topics').select('id, name').eq('name', name).maybeSingle()
  if (!topic) return null
  const { data: rows } = await sb
    .from('topic_articles')
    .select('outline, body_markdown, groundedness_score, coverage_score, version')
    .eq('topic_id', topic.id).eq('audience', 'clinician')
    .order('version', { ascending: false }).limit(1)
  const row = rows?.[0]
  return row ? { topicId: topic.id as string, name: topic.name as string, ...row } : null
}

async function snapshot(): Promise<void> {
  const sb = await db()
  const out = []
  for (const name of EVAL_TOPICS) {
    const a = await loadArticle(sb, name)
    if (!a) { console.warn(`  ! topic not found: ${name}`); continue }
    const outline = a.outline as Outline | null
    const paragraphs = (outline?.sections ?? []).reduce((n, s) => n + (s.paragraphs?.length ?? 0), 0)
    out.push({
      name: a.name,
      version: a.version,
      groundedness_score: a.groundedness_score,
      coverage_score: a.coverage_score,
      body_chars: (a.body_markdown as string | null)?.length ?? 0,
      sections: outline?.sections?.length ?? 0,
      paragraphs,
    })
    console.log(`  ${a.name}: g=${a.groundedness_score ?? '—'} cov=${a.coverage_score ?? '—'} ${((a.body_markdown as string | null)?.length ?? 0)} chars, ${paragraphs} paras`)
  }
  writeJson(BASELINE_FILE, { captured_at: new Date().toISOString(), topics: out })
  console.log(`\nWrote ${out.length} baseline(s) → ${BASELINE_FILE}`)
}

/** Split prose into sentences — naive, adequate for a baseline instrument. */
function splitSentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+|\S[^.!?]*$/g)?.map(s => s.trim()).filter(Boolean) ?? []
}

/** Audit one article at sentence granularity: each declarative sentence is
 *  checked against the claims cited by its paragraph. Returns the ungrounded
 *  count and total, so the sentence-level ratio can be compared to the stored
 *  paragraph-level score. */
async function auditSentences(sb: Awaited<ReturnType<typeof db>>, outline: Outline): Promise<{ total: number; ungrounded: number }> {
  // Gather claim statements cited across the article.
  const ids = Array.from(new Set(outline.sections.flatMap(s => s.paragraphs.flatMap(p => p.claim_ids ?? []))))
  const stmt = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('claims').select('id, canonical_statement').in('id', ids.slice(i, i + 200))
    for (const c of (data ?? []) as { id: string; canonical_statement: string }[]) stmt.set(c.id, c.canonical_statement)
  }

  let total = 0, ungrounded = 0
  for (const s of outline.sections) {
    for (const p of s.paragraphs ?? []) {
      const sentences = splitSentences(p.text)
      if (sentences.length === 0) continue
      const support = (p.claim_ids ?? []).map(id => stmt.get(id)).filter(Boolean)
      const items = sentences.map((t, i) => `[${i}] ${t}`).join('\n')
      total += sentences.length
      try {
        const res = await claudeJson<{ ungrounded?: number[] }>(
          'You audit a physician reference at the SENTENCE level. For each numbered sentence, decide if EVERY factual/clinical assertion it makes is supported by the SUPPORTING CLAIMS. A pure transition/framing sentence that asserts no fact is grounded. Return STRICT JSON {"ungrounded":[<indices of sentences making an assertion NOT supported by the claims>]}.',
          `SUPPORTING CLAIMS:\n${support.join('\n') || '(none cited)'}\n\nSENTENCES:\n${items}`,
          1500,
          CLAUDE_BULK_MODEL
        )
        ungrounded += Array.isArray(res.ungrounded) ? res.ungrounded.filter(i => i >= 0 && i < sentences.length).length : 0
      } catch {
        // skip a failed paragraph audit rather than bias the ratio
        total -= sentences.length
      }
    }
  }
  return { total, ungrounded }
}

async function sentences(limit?: number): Promise<void> {
  const sb = await db()
  const names = limit ? EVAL_TOPICS.slice(0, limit) : EVAL_TOPICS
  const out = []
  for (const name of names) {
    const a = await loadArticle(sb, name)
    if (!a?.outline) { console.warn(`  ! no article: ${name}`); continue }
    const { total, ungrounded } = await auditSentences(sb, a.outline as Outline)
    const ratio = total ? 1 - ungrounded / total : 1
    out.push({ name: a.name, sentences: total, ungrounded, sentence_groundedness: Number(ratio.toFixed(3)), stored_paragraph_groundedness: a.groundedness_score })
    console.log(`  ${a.name}: sentence g=${ratio.toFixed(3)} (${ungrounded}/${total} ungrounded)  vs stored paragraph g=${a.groundedness_score ?? '—'}`)
    writeJson(SENTENCE_FILE, { captured_at: new Date().toISOString(), topics: out })
  }
  console.log(`\nWrote ${out.length} sentence baseline(s) → ${SENTENCE_FILE}`)
  console.log('Use this distribution to set the real sentence-level floor + cap before Phase 3 (spec §8/F5).')
}

async function main() {
  const [cmd, flag, flagVal] = process.argv.slice(2)
  const limit = flag === '--limit' ? Number(flagVal) : undefined
  switch (cmd) {
    case 'snapshot': await snapshot(); return
    case 'sentences': await sentences(limit); return
    default:
      console.log('usage: npx tsx scripts/evalArticles.ts <snapshot|sentences [--limit N]>')
      process.exit(1)
  }
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1) })
