/**
 * Synthesis stage (v2): topic + its claims → clinician article, patient
 * article, and protocol, each citing claim_ids per paragraph.
 *
 * Adapted from the v1 concept generators (lib/topicNarrative, topicProtocols),
 * repointed at the claims layer. A topic's content = its directly-linked claims
 * plus those of its descendant topics (rollup), prioritized and capped so we
 * stay within token limits. Clinician article is generated from claims; the
 * patient article is translated from the clinician version; the protocol is
 * generated from claims. Output is versioned and stamped with
 * claims_snapshot_at for staleness tracking.
 */

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'
import type { Claim, EvidenceType } from './types'

const SYNTHESIS_MODEL = 'gpt-5.1'
const MAX_CLAIMS = 250

let openaiInstance: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
    openaiInstance = new OpenAI({ apiKey })
  }
  return openaiInstance
}

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

// ── Claim prioritization (composite score; adapted from insightPrioritization) ─
const EVIDENCE_SCORE: Record<EvidenceType, number> = {
  MetaAnalysis: 5, RCT: 4, Cohort: 3, CaseSeries: 2,
  Mechanistic: 1, Animal: 1, Other: 1, ExpertOpinion: 0,
}
const ACTIONABILITY_SCORE: Record<string, number> = { High: 3, Medium: 2, Low: 1 }

function claimScore(c: Claim): number {
  const importance = (c.max_importance ?? 2) * 10
  const action = (ACTIONABILITY_SCORE[c.actionability ?? 'Medium'] ?? 2) * 5
  const evidence = (EVIDENCE_SCORE[c.best_evidence_type ?? 'Other'] ?? 1) * 3
  const corroboration = Math.min(c.source_count, 5) * 2 // claims seen across sources rank higher
  return importance + action + evidence + corroboration
}

function prioritizeClaims(claims: Claim[], audience?: 'patient' | 'clinician'): Claim[] {
  let pool = claims
  if (audience) {
    const want = audience === 'patient' ? 'Patient' : 'Clinician'
    pool = claims.filter(c => (c.primary_audience ?? 'Both') === want || (c.primary_audience ?? 'Both') === 'Both')
  }
  return [...pool].sort((a, b) => claimScore(b) - claimScore(a)).slice(0, MAX_CLAIMS)
}

// ── Topic rollup ────────────────────────────────────────────
async function topicAndDescendantIds(topicId: string): Promise<string[]> {
  const { data } = await db().from('topics').select('id, parent_id').eq('status', 'active')
  const childrenOf = new Map<string, string[]>()
  for (const t of (data ?? []) as { id: string; parent_id: string | null }[]) {
    if (!t.parent_id) continue
    if (!childrenOf.has(t.parent_id)) childrenOf.set(t.parent_id, [])
    childrenOf.get(t.parent_id)!.push(t.id)
  }
  const ids: string[] = []
  const stack = [topicId]
  while (stack.length) {
    const id = stack.pop()!
    ids.push(id)
    for (const c of childrenOf.get(id) ?? []) stack.push(c)
  }
  return ids
}

async function loadTopicClaims(topicId: string): Promise<Claim[]> {
  const topicIds = await topicAndDescendantIds(topicId)
  const { data: links } = await db().from('claim_topics').select('claim_id').in('topic_id', topicIds)
  const claimIds = Array.from(new Set((links ?? []).map((l: { claim_id: string }) => l.claim_id)))
  if (claimIds.length === 0) return []

  // Load in batches to avoid overly long IN clauses.
  const claims: Claim[] = []
  for (let i = 0; i < claimIds.length; i += 500) {
    const { data } = await db()
      .from('claims')
      .select('*')
      .in('id', claimIds.slice(i, i + 500))
      .eq('status', 'active')
    claims.push(...((data ?? []) as Claim[]))
  }
  return claims
}

// ── Prompts (adapted from v1, claims-based citations) ───────
const CLINICIAN_PROMPT = `
You are a physician building an evidence-based lifestyle-medicine reference. You are given a TOPIC and a set of verified CLAIMS (each with an id). Write a comprehensive clinician-facing article.

Sections (use those that apply): overview, mechanisms, protocols, risks, controversies.

Rules:
- Use ONLY the provided claims as factual source. Do NOT add facts from outside knowledge.
- Incorporate all material claims; connect related ones into coherent narrative. No word limit.
- Preserve numeric detail (doses, thresholds, frequencies, durations, populations).
- Be explicit about evidence strength where relevant. Refer to study types generically ("randomized trials"), never by name.
- Do not mention "claims", "insights", or transcripts. Professional prose for physicians.
- No H1 title heading in the body; start with section content.

Return STRICT JSON:
{"title":"...","sections":[{"id":"overview","title":"...","paragraphs":[{"id":"p1","text":"...","claim_ids":["<id>","<id>"]}]}]}
Every paragraph MUST list the claim_ids it primarily relied on.
`.trim()

const PATIENT_PROMPT = `
You translate a clinician article into a patient-accessible version (≈10th-grade reading level) for motivated laypeople.

Sections: big-picture, mechanisms, actions, risks, questions.

Rules:
- Base it ENTIRELY on the provided clinician article; add no new facts.
- Translate, don't summarize away — preserve all numeric detail and caveats.
- Simplify jargon, use analogies, keep advice general (suggest discussing with a clinician).
- No H1 title heading. No mention of "claims"/"insights".

Return STRICT JSON:
{"title":"...","sections":[{"id":"big-picture","title":"...","paragraphs":[{"id":"p1","text":"...","claim_ids":[]}]}]}
`.trim()

const PROTOCOL_PROMPT = `
You are a physician distilling verified CLAIMS into a concise, actionable PROTOCOL for a topic — the practical "what to do" derived from the evidence.

Sections (use those that apply): summary, who-its-for, steps, dosing-and-targets, monitoring, cautions.

Rules:
- Use ONLY the provided claims. Prefer high-actionability, high-importance, well-corroborated claims.
- Concrete and specific: doses, frequencies, thresholds, durations, populations. Numbered steps for sequences.
- Note evidence strength/uncertainty where it affects the recommendation. No study names.
- No H1 title heading. No mention of "claims"/"insights".

Return STRICT JSON:
{"title":"...","sections":[{"id":"summary","title":"...","paragraphs":[{"id":"p1","text":"...","claim_ids":["<id>"]}]}]}
Every paragraph MUST list the claim_ids it relied on.
`.trim()

type Outline = {
  title: string
  sections: { id: string; title: string; paragraphs: { id: string; text: string; claim_ids: string[] }[] }[]
}

function claimsBlock(claims: Claim[]): string {
  return claims
    .map(c => `[${c.id}] (${c.best_evidence_type ?? 'Other'}, imp ${c.max_importance ?? '?'}, ${c.source_count} src) ${c.canonical_statement}${c.context_note ? ` — ${c.context_note}` : ''}`)
    .join('\n')
}

function outlineToMarkdown(outline: Outline): string {
  const parts: string[] = []
  for (const s of outline.sections ?? []) {
    parts.push(`## ${s.title}`)
    for (const p of s.paragraphs ?? []) parts.push(p.text)
  }
  return parts.join('\n\n')
}

async function generateJson(system: string, user: string): Promise<Outline> {
  const completion = await getOpenAI().chat.completions.create({
    model: SYNTHESIS_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  })
  const raw = completion.choices[0]?.message?.content
  if (!raw) throw new Error('Empty synthesis response')
  return JSON.parse(raw) as Outline
}

async function nextVersion(table: 'topic_articles' | 'topic_protocols', topicId: string, audience?: string): Promise<number> {
  let q = db().from(table).select('version').eq('topic_id', topicId).order('version', { ascending: false }).limit(1)
  if (audience) q = q.eq('audience', audience)
  const { data } = await q
  return ((data?.[0]?.version as number) ?? 0) + 1
}

/**
 * Generate (or regenerate) the clinician article, patient article, and protocol
 * for a topic from its claims. Bumps version; stamps claims_snapshot_at.
 */
export async function generateTopicContent(topicId: string): Promise<{ claims: number; skipped?: boolean }> {
  const { data: topic, error } = await db()
    .from('topics')
    .select('id, name, description')
    .eq('id', topicId)
    .single()
  if (error || !topic) throw new Error(`Topic not found: ${error?.message}`)

  const allClaims = await loadTopicClaims(topicId)
  if (allClaims.length === 0) return { claims: 0, skipped: true }

  const run = await db()
    .from('pipeline_runs')
    .insert({ kind: 'generate_topic', status: 'running' })
    .select('id')
    .single()
  const runId = run.data?.id
  const snapshot = new Date().toISOString()
  const header = `Topic: ${topic.name}${topic.description ? `\nDescription: ${topic.description}` : ''}`

  try {
    // Clinician article from prioritized claims.
    const clinClaims = prioritizeClaims(allClaims, 'clinician')
    const clinician = await generateJson(
      CLINICIAN_PROMPT,
      `${header}\n\nClaims:\n${claimsBlock(clinClaims)}`
    )
    const clinVer = await nextVersion('topic_articles', topicId, 'clinician')
    await db().from('topic_articles').insert({
      topic_id: topicId, audience: 'clinician', version: clinVer,
      title: clinician.title, outline: clinician, body_markdown: outlineToMarkdown(clinician),
      generation_model: SYNTHESIS_MODEL, claims_snapshot_at: snapshot,
    })

    // Patient article translated from the clinician article.
    const patient = await generateJson(
      PATIENT_PROMPT,
      `${header}\n\nClinician article:\n${clinician.title}\n\n${outlineToMarkdown(clinician)}`
    )
    const patVer = await nextVersion('topic_articles', topicId, 'patient')
    await db().from('topic_articles').insert({
      topic_id: topicId, audience: 'patient', version: patVer,
      title: patient.title, outline: patient, body_markdown: outlineToMarkdown(patient),
      generation_model: SYNTHESIS_MODEL, claims_snapshot_at: snapshot,
    })

    // Protocol from prioritized (audience-agnostic) claims.
    const protoClaims = prioritizeClaims(allClaims)
    const protocol = await generateJson(
      PROTOCOL_PROMPT,
      `${header}\n\nClaims:\n${claimsBlock(protoClaims)}`
    )
    const protoVer = await nextVersion('topic_protocols', topicId)
    await db().from('topic_protocols').insert({
      topic_id: topicId, version: protoVer,
      title: protocol.title, outline: protocol, body_markdown: outlineToMarkdown(protocol),
      generation_model: SYNTHESIS_MODEL, claims_snapshot_at: snapshot,
    })

    if (runId) {
      await db().from('pipeline_runs').update({
        status: 'success', finished_at: new Date().toISOString(),
        stats: { topic: topic.name, claims: allClaims.length },
      }).eq('id', runId)
    }
    return { claims: allClaims.length }
  } catch (err) {
    if (runId) {
      await db().from('pipeline_runs').update({
        status: 'failed', finished_at: new Date().toISOString(),
        error_message: err instanceof Error ? err.message : String(err),
      }).eq('id', runId)
    }
    throw err
  }
}
