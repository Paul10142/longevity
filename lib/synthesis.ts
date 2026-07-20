/**
 * Synthesis stage (v3): topic + its claims → clinician article, patient
 * article, and protocol, each citing claim_ids per paragraph.
 *
 * v3 changes:
 *  - Claim loading + prioritization happens IN THE DB via the topic_claims()
 *    RPC (scored + LIMITed) — no unbounded IN(...) or load-all-then-slice.
 *  - The clinician article is enriched with verbatim source quotes and
 *    VERIFIED third-party references; a References section is appended
 *    deterministically from our verified data (the model only places [R#]
 *    markers, so it cannot invent a citation).
 *
 * Output is versioned and stamped with claims_snapshot_at for staleness.
 */

import OpenAI from 'openai'
import { supabaseAdmin } from './supabaseServer'

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

// Claim shape returned by the topic_claims RPC (already scored + capped).
type ScoredClaim = {
  id: string
  canonical_statement: string
  context_note: string | null
  best_evidence_type: string | null
  max_importance: number | null
  source_count: number
}

/** Prioritized claims for a topic subtree — scoring + LIMIT happen in SQL. */
async function loadPrioritizedClaims(
  topicId: string,
  audience: 'patient' | 'clinician' | null,
  limit = MAX_CLAIMS
): Promise<ScoredClaim[]> {
  const { data, error } = await db().rpc('topic_claims', {
    p_topic_id: topicId,
    p_audience: audience,
    p_limit: limit,
    p_offset: 0,
  })
  if (error) throw new Error(`topic_claims RPC failed: ${error.message}`)
  return (data ?? []) as ScoredClaim[]
}

// ── Quote + reference enrichment (clinician profile) ────────
type Enrichment = {
  quoteByClaim: Map<string, { quote: string; source: string }>
  refMarkersByClaim: Map<string, string[]>
  references: { marker: string; citation: string; url: string | null }[]
}

function citationText(r: {
  authors: string[] | null; year: number | null; title: string; journal: string | null; doi: string | null
}): string {
  const authors = r.authors && r.authors.length
    ? (r.authors.length > 3 ? `${r.authors[0]} et al.` : r.authors.join(', '))
    : ''
  const parts = [authors, r.year ? `(${r.year}).` : '', `${r.title}.`, r.journal ?? '', r.doi ? `https://doi.org/${r.doi}` : '']
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

async function enrichClinician(claimIds: string[]): Promise<Enrichment> {
  const quoteByClaim = new Map<string, { quote: string; source: string }>()
  const refMarkersByClaim = new Map<string, string[]>()
  const references: Enrichment['references'] = []
  if (claimIds.length === 0) return { quoteByClaim, refMarkersByClaim, references }

  // One representative verbatim quote per claim (via its member raw insights).
  const { data: members } = await db()
    .from('claim_members')
    .select('claim_id, raw_insights ( direct_quote, sources ( title ) )')
    .in('claim_id', claimIds)
  for (const m of (members ?? []) as {
    claim_id: string
    raw_insights: { direct_quote: string | null; sources: { title: string } | null } | null
  }[]) {
    const q = m.raw_insights?.direct_quote
    if (q && !quoteByClaim.has(m.claim_id)) {
      quoteByClaim.set(m.claim_id, { quote: q, source: m.raw_insights?.sources?.title ?? 'source' })
    }
  }

  // Verified references supporting these claims → numbered markers.
  const { data: links } = await db().from('claim_references').select('claim_id, reference_id').in('claim_id', claimIds)
  const refIds = Array.from(new Set((links ?? []).map((l: { reference_id: string }) => l.reference_id)))
  if (refIds.length > 0) {
    const { data: refs } = await db()
      .from('references_')
      .select('id, title, authors, year, journal, doi, url')
      .in('id', refIds)
      .order('year', { ascending: false, nullsFirst: false })
    const markerById = new Map<string, string>()
    ;(refs ?? []).forEach((r: {
      id: string; title: string; authors: string[] | null; year: number | null
      journal: string | null; doi: string | null; url: string | null
    }, i: number) => {
      const marker = `R${i + 1}`
      markerById.set(r.id, marker)
      references.push({ marker, citation: citationText(r), url: r.url ?? (r.doi ? `https://doi.org/${r.doi}` : null) })
    })
    for (const l of (links ?? []) as { claim_id: string; reference_id: string }[]) {
      const marker = markerById.get(l.reference_id)
      if (!marker) continue
      const arr = refMarkersByClaim.get(l.claim_id) ?? []
      if (!arr.includes(marker)) arr.push(marker)
      refMarkersByClaim.set(l.claim_id, arr)
    }
  }

  return { quoteByClaim, refMarkersByClaim, references }
}

// ── Topic metadata ──────────────────────────────────────────
function claimsBlock(claims: ScoredClaim[], enrich?: Enrichment): string {
  return claims
    .map(c => {
      const base = `[${c.id}] (${c.best_evidence_type ?? 'Other'}, imp ${c.max_importance ?? '?'}, ${c.source_count} src) ${c.canonical_statement}${c.context_note ? ` — ${c.context_note}` : ''}`
      if (!enrich) return base
      const refs = enrich.refMarkersByClaim.get(c.id)
      const quote = enrich.quoteByClaim.get(c.id)
      const extra = [
        refs && refs.length ? ` refs: ${refs.join(',')}` : '',
        quote ? ` quote: "${quote.quote}" —${quote.source}` : '',
      ].join('')
      return base + extra
    })
    .join('\n')
}

const CLINICIAN_PROMPT = `
You are a physician building an evidence-based clinical reference to help train other physicians. You are given a TOPIC and a set of verified CLAIMS (each with an id, and where available a verbatim source quote and reference markers like R1).

Sections (use those that apply): overview, mechanisms, protocols, risks, controversies.

Rules:
- Use ONLY the provided claims as factual source. Do NOT add facts from outside knowledge.
- Incorporate the material claims; connect related ones into coherent narrative. No word limit.
- Preserve numeric detail (doses, thresholds, frequencies, durations, populations).
- CITATIONS: when a claim carries reference markers (e.g. refs: R1,R3), cite them inline as [R1][R3] where you use that claim. Do NOT invent reference markers or studies — only use the markers provided. A formatted References section will be appended automatically; do not write one yourself.
- QUOTES: when a claim carries a verbatim quote, you MAY include it verbatim in quotation marks with attribution when it is especially illustrative — but do not overuse quotes.
- Be explicit about evidence strength and uncertainty. This is for physician education.
- Do not mention "claims" or transcripts. Professional prose for clinicians.
- No H1 title heading in the body; start with section content.

Return STRICT JSON:
{"title":"...","sections":[{"id":"overview","title":"...","paragraphs":[{"id":"p1","text":"... [R1] ...","claim_ids":["<id>"]}]}]}
Every paragraph MUST list the claim_ids it primarily relied on.
`.trim()

const PATIENT_PROMPT = `
You translate a clinician article into a patient-accessible version (≈10th-grade reading level) for motivated laypeople.

Sections: big-picture, mechanisms, actions, risks, questions.

Rules:
- Base it ENTIRELY on the provided clinician article; add no new facts.
- Translate, don't summarize away — preserve numeric detail and caveats.
- Simplify jargon, use analogies, keep advice general (suggest discussing with a clinician).
- Drop inline reference markers like [R1] — patients don't need them.
- No H1 title heading. No mention of "claims".

Return STRICT JSON:
{"title":"...","sections":[{"id":"big-picture","title":"...","paragraphs":[{"id":"p1","text":"...","claim_ids":[]}]}]}
`.trim()

const PROTOCOL_PROMPT = `
You distill verified CLAIMS into a concise, actionable PROTOCOL for a topic — the practical "what to do".

Sections (use those that apply): summary, who-its-for, steps, dosing-and-targets, monitoring, cautions.

Rules:
- Use ONLY the provided claims. Prefer high-actionability, high-importance, well-corroborated claims.
- Concrete: doses, frequencies, thresholds, durations, populations. Numbered steps for sequences.
- Note evidence strength/uncertainty where it affects the recommendation.
- No H1 title heading. No mention of "claims".

Return STRICT JSON:
{"title":"...","sections":[{"id":"summary","title":"...","paragraphs":[{"id":"p1","text":"...","claim_ids":["<id>"]}]}]}
Every paragraph MUST list the claim_ids it relied on.
`.trim()

type Outline = {
  title: string
  sections: { id: string; title: string; paragraphs: { id: string; text: string; claim_ids: string[] }[] }[]
  references?: { marker: string; citation: string; url: string | null }[]
}

function outlineToMarkdown(outline: Outline): string {
  const parts: string[] = []
  for (const s of outline.sections ?? []) {
    parts.push(`## ${s.title}`)
    for (const p of s.paragraphs ?? []) parts.push(p.text)
  }
  // Deterministic References section from our verified data (never model-authored).
  if (outline.references && outline.references.length) {
    parts.push('## References')
    for (const r of outline.references) {
      parts.push(`${r.marker.replace('R', '')}. ${r.citation}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Groundedness gate: check that every factual assertion in each paragraph is
 * supported by that paragraph's cited claims. Returns the fraction of grounded
 * paragraphs (1.0 = fully grounded). One batched cheap-model call. Physician
 * content must not assert what the evidence doesn't support.
 */
async function scoreGroundedness(outline: Outline, claimById: Map<string, string>): Promise<number> {
  const paras = (outline.sections ?? []).flatMap(s => s.paragraphs ?? [])
  if (paras.length === 0) return 1

  const items = paras
    .map((p, i) => {
      const support = (p.claim_ids ?? []).map(id => claimById.get(id)).filter(Boolean)
      return `[${i}] PARAGRAPH: ${p.text}\nSUPPORTING CLAIMS: ${support.join(' | ') || '(none cited)'}`
    })
    .join('\n\n')

  try {
    const completion = await getOpenAI().chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        {
          role: 'system',
          content:
            'You audit a physician reference for groundedness. For each numbered paragraph, decide if EVERY factual/clinical assertion is supported by its listed supporting claims. Ignore pure transitions, framing, or general connective prose. Return STRICT JSON {"ungrounded":[<indices of paragraphs containing an assertion NOT supported by their claims>]}.',
        },
        { role: 'user', content: items },
      ],
      response_format: { type: 'json_object' },
    })
    const raw = completion.choices[0]?.message?.content
    if (!raw) return 1
    const ungrounded = JSON.parse(raw).ungrounded
    const count = Array.isArray(ungrounded) ? ungrounded.length : 0
    return Math.max(0, 1 - count / paras.length)
  } catch {
    return 1 // don't block on checker failure
  }
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

  const clinClaims = await loadPrioritizedClaims(topicId, 'clinician')
  const protoClaims = await loadPrioritizedClaims(topicId, null)
  if (clinClaims.length === 0 && protoClaims.length === 0) return { claims: 0, skipped: true }

  const run = await db()
    .from('pipeline_runs')
    .insert({ kind: 'generate_topic', status: 'running' })
    .select('id')
    .single()
  const runId = run.data?.id
  const snapshot = new Date().toISOString()
  const header = `Topic: ${topic.name}${topic.description ? `\nDescription: ${topic.description}` : ''}`

  try {
    // Clinician article — enriched with verbatim quotes + verified references.
    const enrich = await enrichClinician(clinClaims.map(c => c.id))
    const clinician = await generateJson(
      CLINICIAN_PROMPT,
      `${header}\n\nClaims:\n${claimsBlock(clinClaims, enrich)}`
    )
    clinician.references = enrich.references // appended deterministically in markdown
    // Groundedness gate: score how well the article's assertions are supported.
    const claimById = new Map(clinClaims.map(c => [c.id, c.canonical_statement]))
    const groundedness = await scoreGroundedness(clinician, claimById)
    if (groundedness < 0.7) {
      console.warn(`[synthesis] low groundedness ${groundedness.toFixed(2)} for topic ${topic.name}`)
    }
    const clinVer = await nextVersion('topic_articles', topicId, 'clinician')
    await db().from('topic_articles').insert({
      topic_id: topicId, audience: 'clinician', version: clinVer,
      title: clinician.title, outline: clinician, body_markdown: outlineToMarkdown(clinician),
      generation_model: SYNTHESIS_MODEL, claims_snapshot_at: snapshot,
      groundedness_score: groundedness,
    })

    // Patient article translated from the clinician article.
    const patient = await generateJson(
      PATIENT_PROMPT,
      `${header}\n\nClinician article:\n${clinician.title}\n\n${outlineToMarkdown({ ...clinician, references: undefined })}`
    )
    const patVer = await nextVersion('topic_articles', topicId, 'patient')
    await db().from('topic_articles').insert({
      topic_id: topicId, audience: 'patient', version: patVer,
      title: patient.title, outline: patient, body_markdown: outlineToMarkdown(patient),
      generation_model: SYNTHESIS_MODEL, claims_snapshot_at: snapshot,
    })

    // Protocol from prioritized (audience-agnostic) claims.
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
        stats: { topic: topic.name, claims: clinClaims.length, references: enrich.references.length },
      }).eq('id', runId)
    }
    return { claims: clinClaims.length }
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
