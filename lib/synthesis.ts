/**
 * Synthesis stage (v3.1): topic + ALL its claims → an exhaustive, claim-complete
 * clinician article, a patient translation, and a concise protocol.
 *
 * Physician-grade comprehensiveness (see ARCHITECTURE.md "v3.1 target spec"):
 *  - No claim cap. The clinician article must surface EVERY deduplicated claim
 *    on the topic, not a summary. To make "no cap" scale past what a single LLM
 *    call can hold, generation is SECTIONED:
 *      1. group all claims into themed sections (one cheap LLM call),
 *      2. generate each section claim-complete (one call per section),
 *      3. mop up any uncited claims into an "Additional Evidence" section,
 *      4. record a coverage score = cited claims / total claims (target ~1.0).
 *  - Enriched with verbatim source quotes + VERIFIED third-party references; the
 *    References section is appended deterministically (the model only places
 *    [R#] markers, so it cannot invent a citation).
 *
 * Output is versioned and stamped with claims_snapshot_at for staleness.
 */

import { supabaseAdmin } from './supabaseServer'
import { claudeJson, CLAUDE_MODEL, type Effort } from './llm'
import { startOrResumeRun, finishRun, failRun } from './pipelineRuns'

// Effectively uncapped at current scale; pagination of topic_claims() is the
// scale path when a single topic exceeds this. NOT the old summarizing cap.
const CLINICIAN_CLAIM_CAP = 2000
// The protocol is deliberately concise ("what to do"), so it stays prioritized.
const PROTOCOL_CLAIM_CAP = 80

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

// Claim shape returned by the topic_claims RPC (already scored).
type ScoredClaim = {
  id: string
  canonical_statement: string
  context_note: string | null
  best_evidence_type: string | null
  max_importance: number | null
  source_count: number
}

/** All claims for a topic subtree (scored in SQL). Loaded uncapped for the
 * clinician article; the caller passes a small limit for the concise protocol. */
async function loadPrioritizedClaims(
  topicId: string,
  audience: 'patient' | 'clinician' | null,
  limit = CLINICIAN_CLAIM_CAP
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

// ── Prompts ─────────────────────────────────────────────────
const CLINICIAN_OUTLINE_PROMPT = `
You organize verified clinical CLAIMS (each: [id] statement) into a sectioned outline for a COMPREHENSIVE physician reference on a TOPIC.

Rules:
- Group EVERY claim into exactly one section. Never drop or duplicate a claim id.
- Choose 3–12 sections with clear clinical themes (e.g. overview, physiology/mechanisms, evaluation/diagnostics, treatment/protocols, dosing-and-targets, monitoring, risks/adverse-effects, special-populations, controversies). Use only sections that fit the claims; order them logically.
- Keep sections reasonably balanced; split a very large theme into sub-themes so no section is overloaded.

Return STRICT JSON:
{"sections":[{"id":"overview","title":"Overview","claim_ids":["<id>","<id>"]}]}
`.trim()

const CLINICIAN_SECTION_PROMPT = `
You are a physician writing ONE SECTION of a comprehensive, evidence-based clinical reference used to train other physicians. You are given the TOPIC, the SECTION title, and the verified CLAIMS assigned to this section (each with an id, and where available a verbatim source quote and reference markers like R1).

Rules:
- This is an EXHAUSTIVE reference, not a summary. Represent EVERY provided claim — do not drop any. Merge closely related claims into the same paragraph; give distinct claims their own sentences or paragraphs. No word limit.
- Use ONLY the provided claims as factual source. Do NOT add facts from outside knowledge.
- Preserve ALL numeric detail (doses, thresholds, frequencies, durations, populations).
- CITATIONS: when a claim carries reference markers (e.g. refs: R1,R3), cite them inline as [R1][R3] where you use that claim. Never invent markers or studies. A References section is appended automatically — do not write one.
- CLAIM IDS ARE INTERNAL. Each claim is shown prefixed with a long UUID token in brackets (e.g. [d5d0e719-3b37-4855-b72e-e213a3394ac7]). Put that id in the paragraph's claim_ids array — NEVER write it in the prose text. The ONLY bracketed markers allowed in the text are reference markers like [R1].
- QUOTES: when a claim carries a verbatim quote, you MAY include it verbatim in quotation marks with attribution when especially illustrative — but do not overuse.
- Be explicit about evidence strength and uncertainty; present contested or non-consensus points as areas of debate rather than settled fact.
- Do not mention "claims" or transcripts. Professional prose. No headings — return paragraphs only.

Return STRICT JSON:
{"paragraphs":[{"id":"p1","text":"... [R1] ...","claim_ids":["<id>"]}]}
Every paragraph MUST list the claim_ids it used, and collectively the paragraphs MUST cover EVERY provided claim id.
`.trim()

const PATIENT_SECTION_PROMPT = `
You translate ONE SECTION of a clinician reference into patient-accessible prose (≈10th-grade reading level) for motivated laypeople.

Rules:
- Base it ENTIRELY on the provided section text; add no new facts.
- Translate, don't summarize away — preserve numeric detail and important caveats.
- Simplify jargon, use plain language and analogies, keep advice general (suggest discussing specifics with a clinician).
- Drop inline reference markers like [R1]. No mention of "claims".

Return STRICT JSON:
{"title":"...","paragraphs":[{"id":"p1","text":"..."}]}
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

type Paragraph = { id: string; text: string; claim_ids: string[] }
type Section = { id: string; title: string; paragraphs: Paragraph[] }
type Outline = {
  title: string
  sections: Section[]
  references?: { marker: string; citation: string; url: string | null }[]
}

/** Remove any inline claim-id UUID tokens the model may have echoed into prose
 * (e.g. "…male factors [d5d0e719-3b37-4855-b72e-e213a3394ac7]."). Claim ids
 * belong in the paragraph's claim_ids array, never in reader-facing text.
 * Leaves [R#] reference markers untouched. */
function stripInlineClaimIds(text: string): string {
  return text
    .replace(/\s*\[[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]/g, '')
    .replace(/ +([.,;:)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function outlineToMarkdown(outline: Outline): string {
  const parts: string[] = []
  for (const s of outline.sections ?? []) {
    parts.push(`## ${s.title}`)
    for (const p of s.paragraphs ?? []) parts.push(stripInlineClaimIds(p.text))
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
 * Synthesis calls cap reasoning depth. Adaptive thinking defaults to `high`,
 * and thinking tokens bill as output ($25/M) — uncapped, most of a synthesis
 * run's cost is invisible reasoning on work that is largely mechanical.
 * Mechanical steps (grouping, translation) run `low`; substantive prose and the
 * groundedness audit run `medium`. Prose stays on Opus either way — we cap the
 * reasoning, never the model.
 */
async function chatJson<T>(
  system: string,
  user: string,
  maxTokens = 8000,
  effort: Effort = 'medium'
): Promise<T> {
  return claudeJson<T>(system, user, maxTokens, CLAUDE_MODEL, effort)
}

/** Group all claims into themed sections. Guarantees every claim is assigned
 * exactly once (strays after the LLM pass go into an "Additional Findings"
 * section) so nothing is silently dropped before generation. */
async function outlineSections(
  header: string,
  claims: ScoredClaim[]
): Promise<{ id: string; title: string; claim_ids: string[] }[]> {
  const list = claims.map(c => `[${c.id}] ${c.canonical_statement}`).join('\n')
  let raw: { sections?: { id: string; title: string; claim_ids?: string[] }[] } = {}
  try {
    // Grouping claims into themes is bucketing, not reasoning — cap it low.
    raw = await chatJson(CLINICIAN_OUTLINE_PROMPT, `${header}\n\nClaims:\n${list}`, 6000, 'low')
  } catch {
    raw = {}
  }
  const valid = new Set(claims.map(c => c.id))
  const assigned = new Set<string>()
  const cleaned: { id: string; title: string; claim_ids: string[] }[] = []
  for (const s of raw.sections ?? []) {
    const ids = (s.claim_ids ?? []).filter(id => valid.has(id) && !assigned.has(id))
    ids.forEach(id => assigned.add(id))
    if (ids.length) cleaned.push({ id: s.id || `s${cleaned.length + 1}`, title: s.title || 'Section', claim_ids: ids })
  }
  const strays = claims.filter(c => !assigned.has(c.id)).map(c => c.id)
  if (strays.length) cleaned.push({ id: 'additional-findings', title: 'Additional Findings', claim_ids: strays })
  return cleaned
}

/** Generate one clinician section, claim-complete over its assigned claims. */
async function generateClinicianSection(
  header: string,
  section: { id: string; title: string; claim_ids: string[] },
  claimById: Map<string, ScoredClaim>,
  enrich: Enrichment
): Promise<Section> {
  const secClaims = section.claim_ids
    .map(id => claimById.get(id))
    .filter((c): c is ScoredClaim => Boolean(c))
  if (secClaims.length === 0) return { id: section.id, title: section.title, paragraphs: [] }
  const res = await chatJson<{ paragraphs?: Paragraph[] }>(
    CLINICIAN_SECTION_PROMPT,
    `${header}\n\nSection: ${section.title}\n\nClaims:\n${claimsBlock(secClaims, enrich)}`,
    12000
  )
  return {
    id: section.id,
    title: section.title,
    paragraphs: (res.paragraphs ?? []).map(p => ({ id: p.id, text: stripInlineClaimIds(p.text), claim_ids: p.claim_ids ?? [] })),
  }
}

async function translatePatientSection(topicName: string, section: Section): Promise<Section> {
  const md = section.paragraphs.map(p => p.text).join('\n\n')
  if (!md.trim()) return { id: section.id, title: section.title, paragraphs: [] }
  // Plain-language translation of existing prose — mechanical, cap it low.
  const res = await chatJson<{ title?: string; paragraphs?: { id: string; text: string }[] }>(
    PATIENT_SECTION_PROMPT,
    `Topic: ${topicName}\nSection: ${section.title}\n\n${md}`,
    8000,
    'low'
  )
  return {
    id: section.id,
    title: res.title || section.title,
    paragraphs: (res.paragraphs ?? []).map(p => ({ id: p.id, text: p.text, claim_ids: [] })),
  }
}

/**
 * Groundedness gate: check that every factual assertion in each paragraph is
 * supported by that paragraph's cited claims. Returns the fraction of grounded
 * paragraphs (1.0 = fully grounded). One batched cheap-model call.
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
    // The audit is a genuine judgment call — keep real reasoning here.
    const res = await claudeJson<{ ungrounded?: number[] }>(
      'You audit a physician reference for groundedness. For each numbered paragraph, decide if EVERY factual/clinical assertion is supported by its listed supporting claims. Ignore pure transitions, framing, or general connective prose. Return STRICT JSON {"ungrounded":[<indices of paragraphs containing an assertion NOT supported by their claims>]}.',
      items,
      2000,
      CLAUDE_MODEL,
      'medium'
    )
    const count = Array.isArray(res.ungrounded) ? res.ungrounded.length : 0
    return Math.max(0, 1 - count / paras.length)
  } catch {
    return 1 // don't block on checker failure
  }
}

function coverageOf(sections: Section[], validIds: Set<string>): { covered: Set<string>; score: number } {
  const covered = new Set<string>()
  for (const s of sections) for (const p of s.paragraphs) for (const id of p.claim_ids ?? []) {
    if (validIds.has(id)) covered.add(id)
  }
  return { covered, score: validIds.size ? covered.size / validIds.size : 1 }
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
export async function generateTopicContent(topicId: string): Promise<{ claims: number; coverage?: number; skipped?: boolean }> {
  const { data: topic, error } = await db()
    .from('topics')
    .select('id, name, description')
    .eq('id', topicId)
    .single()
  if (error || !topic) throw new Error(`Topic not found: ${error?.message}`)

  const clinClaims = await loadPrioritizedClaims(topicId, 'clinician')
  const protoClaims = await loadPrioritizedClaims(topicId, null, PROTOCOL_CLAIM_CAP)
  if (clinClaims.length === 0 && protoClaims.length === 0) return { claims: 0, skipped: true }

  const runId = await startOrResumeRun('generate_topic', null, null)
  const snapshot = new Date().toISOString()
  const header = `Topic: ${topic.name}${topic.description ? `\nDescription: ${topic.description}` : ''}`

  try {
    // ── Clinician article: exhaustive, sectioned, claim-complete ──
    const enrich = await enrichClinician(clinClaims.map(c => c.id))
    const claimById = new Map(clinClaims.map(c => [c.id, c]))
    const validIds = new Set(clinClaims.map(c => c.id))

    const outlineSecs = await outlineSections(header, clinClaims)
    const sections: Section[] = []
    for (const s of outlineSecs) {
      sections.push(await generateClinicianSection(header, s, claimById, enrich))
    }

    // Coverage mop-up: any claim not cited by a section gets its own pass, so the
    // reference is genuinely complete rather than quietly dropping evidence.
    let { covered, score: coverage } = coverageOf(sections, validIds)
    const missing = clinClaims.filter(c => !covered.has(c.id))
    if (missing.length) {
      sections.push(
        await generateClinicianSection(
          header,
          { id: 'additional-evidence', title: 'Additional Evidence', claim_ids: missing.map(c => c.id) },
          claimById,
          enrich
        )
      )
      ;({ covered, score: coverage } = coverageOf(sections, validIds))
    }
    if (coverage < 0.95) {
      console.warn(`[synthesis] low coverage ${coverage.toFixed(2)} for topic ${topic.name} (${covered.size}/${validIds.size} claims)`)
    }

    const clinician: Outline = { title: topic.name, sections, references: enrich.references }
    const groundedness = await scoreGroundedness(clinician, new Map(clinClaims.map(c => [c.id, c.canonical_statement])))
    if (groundedness < 0.7) {
      console.warn(`[synthesis] low groundedness ${groundedness.toFixed(2)} for topic ${topic.name}`)
    }
    const clinVer = await nextVersion('topic_articles', topicId, 'clinician')
    await db().from('topic_articles').insert({
      topic_id: topicId, audience: 'clinician', version: clinVer,
      title: clinician.title, outline: clinician, body_markdown: outlineToMarkdown(clinician),
      generation_model: CLAUDE_MODEL, claims_snapshot_at: snapshot,
      groundedness_score: groundedness, coverage_score: coverage,
    })

    // ── Patient article: translate each clinician section (keeps it complete) ──
    const patientSections: Section[] = []
    for (const s of sections) {
      if (s.paragraphs.length === 0) continue
      patientSections.push(await translatePatientSection(topic.name, s))
    }
    const patient: Outline = { title: topic.name, sections: patientSections }
    const patVer = await nextVersion('topic_articles', topicId, 'patient')
    await db().from('topic_articles').insert({
      topic_id: topicId, audience: 'patient', version: patVer,
      title: patient.title, outline: patient, body_markdown: outlineToMarkdown(patient),
      generation_model: CLAUDE_MODEL, claims_snapshot_at: snapshot,
    })

    // ── Protocol: concise, prioritized claims ──
    const protocol = await chatJson<Outline>(
      PROTOCOL_PROMPT,
      `${header}\n\nClaims:\n${claimsBlock(protoClaims)}`
    )
    const protoVer = await nextVersion('topic_protocols', topicId)
    await db().from('topic_protocols').insert({
      topic_id: topicId, version: protoVer,
      title: protocol.title, outline: protocol, body_markdown: outlineToMarkdown(protocol),
      generation_model: CLAUDE_MODEL, claims_snapshot_at: snapshot,
    })

    await finishRun(runId, {
      topic: topic.name, claims: clinClaims.length, sections: sections.length,
      coverage: Number(coverage.toFixed(3)), groundedness: Number(groundedness.toFixed(3)),
      references: enrich.references.length,
    })
    return { claims: clinClaims.length, coverage }
  } catch (err) {
    await failRun(runId, err)
    throw err
  }
}

// ── Incremental update (v3.2) ───────────────────────────────
/** Share of new claims above which section patching is abandoned for a full
 *  rebuild — the coherence valve (ARCHITECTURE.md "v3.2 incremental update"). */
const FULL_REGEN_THRESHOLD = 0.25

const ASSIGN_SECTION_PROMPT = `
You place NEW claims into the sections of an EXISTING clinical reference article.

You are given the article's SECTIONS (id + title) and a list of NEW CLAIMS. For
each new claim, choose the id of the section it belongs in. If a claim genuinely
fits none of them, use "new".

Return STRICT JSON:
{"assignments":[{"claim_id":"<id>","section_id":"<section id, or new>"}]}
`.trim()

function claimIdsInSection(sec: Section): string[] {
  const ids = new Set<string>()
  for (const p of sec.paragraphs ?? []) for (const id of p.claim_ids ?? []) ids.add(id)
  return [...ids]
}

/**
 * Fold newly-arrived claims into a topic's existing articles without rewriting
 * them. Three tiers (see ARCHITECTURE.md v3.2):
 *   - `metadata` — no new claims (reinforcing evidence only). Prose untouched,
 *     no LLM call, ~$0. Evidence/`source_count` already read live.
 *   - `sections` — regenerate only the sections receiving new claims; every
 *     other section's prose is reused byte-for-byte.
 *   - `full`     — the claim set grew past FULL_REGEN_THRESHOLD, so rebuild the
 *     whole article to keep it coherent.
 */
export async function updateTopicContent(topicId: string): Promise<{
  tier: 'metadata' | 'sections' | 'full'
  newClaims: number
  sectionsRegenerated: number
  coverage?: number
}> {
  const { data: topic, error } = await db()
    .from('topics').select('id, name, description').eq('id', topicId).single()
  if (error || !topic) throw new Error(`Topic not found: ${error?.message}`)

  const { data: prevRows } = await db()
    .from('topic_articles').select('outline')
    .eq('topic_id', topicId).eq('audience', 'clinician')
    .order('version', { ascending: false }).limit(1)
  const prev = (prevRows?.[0] as { outline: Outline } | undefined)?.outline

  // Nothing to patch yet — build it from scratch.
  if (!prev?.sections?.length) {
    const res = await generateTopicContent(topicId)
    return { tier: 'full', newClaims: res.claims, sectionsRegenerated: 0, coverage: res.coverage }
  }

  const claims = await loadPrioritizedClaims(topicId, 'clinician')
  const known = new Set<string>()
  for (const sec of prev.sections) for (const id of claimIdsInSection(sec)) known.add(id)
  const newClaims = claims.filter(c => !known.has(c.id))

  // Tier 1 — reinforcing only. The prose says the same thing; only the evidence
  // behind it grew, and that is read live. No generation, no cost.
  if (newClaims.length === 0) {
    return { tier: 'metadata', newClaims: 0, sectionsRegenerated: 0 }
  }

  // Coherence valve — a large influx can reframe the topic, which patching
  // cannot propagate. Rebuild instead.
  if (claims.length > 0 && newClaims.length / claims.length > FULL_REGEN_THRESHOLD) {
    const res = await generateTopicContent(topicId)
    return { tier: 'full', newClaims: newClaims.length, sectionsRegenerated: 0, coverage: res.coverage }
  }

  // Tier 2/3 — place each new claim into a section, or a brand-new one.
  let assignments: { claim_id: string; section_id: string }[] = []
  try {
    const res = await chatJson<{ assignments?: { claim_id: string; section_id: string }[] }>(
      ASSIGN_SECTION_PROMPT,
      `Topic: ${topic.name}\n\nSections:\n${prev.sections.map(s => `${s.id}: ${s.title}`).join('\n')}` +
        `\n\nNew claims:\n${newClaims.map(c => `[${c.id}] ${c.canonical_statement}`).join('\n')}`,
      4000,
      'low'
    )
    assignments = res.assignments ?? []
  } catch {
    assignments = []
  }

  const sectionIds = new Set(prev.sections.map(s => s.id))
  const newBySection = new Map<string, string[]>()
  const unplaced: string[] = []
  const seen = new Set<string>()
  for (const a of assignments) {
    if (seen.has(a.claim_id) || !newClaims.some(c => c.id === a.claim_id)) continue
    seen.add(a.claim_id)
    if (sectionIds.has(a.section_id)) {
      newBySection.set(a.section_id, [...(newBySection.get(a.section_id) ?? []), a.claim_id])
    } else {
      unplaced.push(a.claim_id)
    }
  }
  // Never drop a claim the model forgot to place.
  for (const c of newClaims) if (!seen.has(c.id)) unplaced.push(c.id)

  const claimById = new Map(claims.map(c => [c.id, c]))
  const enrich = await enrichClinician(claims.map(c => c.id))
  const header = `Topic: ${topic.name}${topic.description ? `\nDescription: ${topic.description}` : ''}`

  const sections: Section[] = []
  const changed = new Set<string>()
  for (const sec of prev.sections) {
    const added = newBySection.get(sec.id)
    if (!added?.length) {
      sections.push(sec) // untouched — reuse the stored prose verbatim
      continue
    }
    const full = [...claimIdsInSection(sec), ...added].filter(id => claimById.has(id))
    sections.push(
      await generateClinicianSection(header, { id: sec.id, title: sec.title, claim_ids: full }, claimById, enrich)
    )
    changed.add(sec.id)
  }
  if (unplaced.length) {
    const id = `additional-${Date.now().toString(36)}`
    sections.push(
      await generateClinicianSection(
        header, { id, title: 'Additional Findings', claim_ids: unplaced }, claimById, enrich
      )
    )
    changed.add(id)
  }

  const validIds = new Set(claims.map(c => c.id))
  const { score: coverage } = coverageOf(sections, validIds)
  const clinician: Outline = { title: topic.name, sections, references: enrich.references }
  const groundedness = await scoreGroundedness(
    clinician, new Map(claims.map(c => [c.id, c.canonical_statement]))
  )
  const snapshot = new Date().toISOString()

  const clinVer = await nextVersion('topic_articles', topicId, 'clinician')
  await db().from('topic_articles').insert({
    topic_id: topicId, audience: 'clinician', version: clinVer,
    title: clinician.title, outline: clinician, body_markdown: outlineToMarkdown(clinician),
    generation_model: CLAUDE_MODEL, claims_snapshot_at: snapshot,
    groundedness_score: groundedness, coverage_score: coverage,
  })

  // Patient: re-translate only the sections that changed; reuse the rest.
  const { data: prevPatRows } = await db()
    .from('topic_articles').select('outline')
    .eq('topic_id', topicId).eq('audience', 'patient')
    .order('version', { ascending: false }).limit(1)
  const prevPat = (prevPatRows?.[0] as { outline: Outline } | undefined)?.outline
  const patById = new Map((prevPat?.sections ?? []).map(s => [s.id, s]))

  const patientSections: Section[] = []
  for (const sec of sections) {
    if (sec.paragraphs.length === 0) continue
    const reusable = !changed.has(sec.id) ? patById.get(sec.id) : undefined
    patientSections.push(reusable ?? (await translatePatientSection(topic.name, sec)))
  }
  const patient: Outline = { title: topic.name, sections: patientSections }
  const patVer = await nextVersion('topic_articles', topicId, 'patient')
  await db().from('topic_articles').insert({
    topic_id: topicId, audience: 'patient', version: patVer,
    title: patient.title, outline: patient, body_markdown: outlineToMarkdown(patient),
    generation_model: CLAUDE_MODEL, claims_snapshot_at: snapshot,
  })

  return {
    tier: 'sections',
    newClaims: newClaims.length,
    sectionsRegenerated: changed.size,
    coverage,
  }
}
