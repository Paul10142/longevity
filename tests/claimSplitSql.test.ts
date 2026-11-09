/**
 * apply_claim_split (supabase/migrations_v2/041_claim_split_repair.sql) run FOR REAL against a throwaway local
 * PostgreSQL: the actual migration files 037 and 041 on a small copy of the tables they touch
 * (tests/fixtures/claimSplitSchema.sql). Proves what TypeScript tests cannot: the whole split is ONE transaction.
 *
 *   - a 2-way and a 5-way split write every row (members moved, claims, vectors, aggregates, flag, audit);
 *   - a write that fails halfway (bad vector after the members were moved, or an id that already exists) leaves
 *     the database exactly as it was, and the same plan then applies cleanly;
 *   - a repeat of an already repaired claim, or a claim that changed meanwhile, writes nothing.
 *
 * Needs the PostgreSQL server programs (initdb, pg_ctl, psql); skipped, with a message, when they are not installed.
 * Never touches Supabase or any real data.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')

function findBinDir(): string | null {
  const dirs = [
    process.env.PG_BIN_DIR ?? '',
    ...(process.env.PATH ?? '').split(path.delimiter),
    ...['17', '16', '15', '14'].flatMap(v => [`/opt/homebrew/opt/postgresql@${v}/bin`, `/usr/local/opt/postgresql@${v}/bin`, `/usr/lib/postgresql/${v}/bin`]),
  ].filter(Boolean)
  return dirs.find(d => ['initdb', 'pg_ctl', 'psql'].every(b => existsSync(path.join(d, b)))) ?? null
}
const BIN = findBinDir()
const CAN_RUN = BIN !== null && !(typeof process.getuid === 'function' && process.getuid() === 0)
const skip = CAN_RUN ? false : 'PostgreSQL server programs (initdb, pg_ctl, psql) not found, or running as root'

let work = ''
let sock = ''

const bin = (name: string) => path.join(BIN!, name)
/** A valid locale for the server programs (macOS refuses to start a postmaster under an invalid inherited one). */
const PGENV = { ...process.env, LC_ALL: 'C', LANG: 'C', PGPORT: '54329' }

function psql(args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync(bin('psql'), ['-h', sock, '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', env: PGENV })
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
function run(sql: string): string {
  const r = psql(['-c', sql])
  assert.equal(r.status, 0, `SQL failed: ${r.err}\n${sql}`)
  return r.out
}
function file(f: string): void {
  const r = psql(['-f', f])
  assert.equal(r.status, 0, `${f}: ${r.err}`)
}
/** Rows of a query as objects. */
function rows<T = Record<string, unknown>>(sql: string): T[] {
  return JSON.parse(run(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`)) as T[]
}

before(() => {
  if (!CAN_RUN) return
  work = mkdtempSync(path.join(tmpdir(), 'pgsplit-'))
  sock = work
  const data = path.join(work, 'data')
  const init = spawnSync(bin('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8', '--locale=C'], { encoding: 'utf8', env: PGENV })
  assert.equal(init.status, 0, `initdb: ${init.stderr}`)
  const start = spawnSync(bin('pg_ctl'), ['-D', data, '-o', `-c listen_addresses= -k ${sock} -c fsync=off -c port=54329`, '-l', path.join(work, 'pg.log'), '-w', 'start'], { encoding: 'utf8', env: PGENV })
  assert.equal(start.status, 0, `pg_ctl start: ${start.stderr}${existsSync(path.join(work, 'pg.log')) ? readFileSync(path.join(work, 'pg.log'), 'utf8') : ''}`)
  file(path.join(ROOT, 'tests/fixtures/claimSplitSchema.sql'))
  file(path.join(ROOT, 'supabase/migrations_v2/037_claim_repairs.sql'))
  file(path.join(ROOT, 'supabase/migrations_v2/041_claim_split_repair.sql'))
})

after(() => {
  if (!CAN_RUN || !work) return
  spawnSync(bin('pg_ctl'), ['-D', path.join(work, 'data'), '-m', 'immediate', '-w', 'stop'], { encoding: 'utf8', env: PGENV })
  rmSync(work, { recursive: true, force: true })
})

// ── Fixtures ────────────────────────────────────────────────────

const ORIGINAL = '11111111-1111-4111-8111-111111111111'
const FLAG = '22222222-2222-4222-8222-222222222222'
const OLD_WORDING = 'Creatine raises muscle phosphocreatine and may help memory in sleep-deprived adults.'
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
const insight = (n: number) => uuid('00000000', n)
const newClaim = (n: number) => uuid('99999999', n)
const SRC_A = uuid('aaaaaaaa', 1)
const SRC_B = uuid('aaaaaaaa', 2)

type Seed = { insights: Array<{ n: number; source: string; importance: number | null; evidence: string; matchedBy?: string }> }
const DEFAULT_SEED: Seed = {
  insights: [
    { n: 1, source: SRC_A, importance: 2, evidence: 'RCT', matchedBy: 'seed' },
    { n: 2, source: SRC_B, importance: 3, evidence: 'Animal' },
    { n: 3, source: SRC_B, importance: 1, evidence: 'MetaAnalysis' },
    { n: 4, source: SRC_A, importance: null, evidence: 'Other' },
    { n: 5, source: SRC_A, importance: 2, evidence: 'Cohort' },
    { n: 6, source: SRC_B, importance: 1, evidence: 'ExpertOpinion' },
    { n: 7, source: SRC_B, importance: 3, evidence: 'Mechanistic' },
    { n: 8, source: SRC_A, importance: 2, evidence: 'CaseSeries' },
  ],
}

/** An empty database with one quarantined claim (ORIGINAL) holding every seeded insight, an open flag and a vector. */
function reset(seed: Seed = DEFAULT_SEED): void {
  run('truncate public.claim_repairs, public.claim_embeddings, public.claim_flags, public.claim_members, public.claims, public.raw_insights cascade')
  run(`insert into public.claims (id, canonical_statement, context_note, status, best_evidence_type, max_importance, actionability, primary_audience, insight_type, qualifiers, member_count, source_count, needs_tagging)
       values ('${ORIGINAL}', '${OLD_WORDING}', 'In healthy adults.', 'flagged', 'RCT', 3, 'High', 'Both', 'Explanation', '{"dose":"5 g/day"}', ${seed.insights.length}, 2, false)`)
  for (const i of seed.insights) {
    run(`insert into public.raw_insights (id, source_id, statement, importance, evidence_type) values ('${insight(i.n)}', '${i.source}', 'insight ${i.n}', ${i.importance ?? 'null'}, '${i.evidence}')`)
    run(`insert into public.claim_members (claim_id, raw_insight_id, match_confidence, matched_by) values ('${ORIGINAL}', '${insight(i.n)}', 0.9, '${i.matchedBy ?? 'auto'}')`)
  }
  run(`insert into public.claim_flags (id, claim_id, rule, detail, evidence) values ('${FLAG}', '${ORIGINAL}', 'extraction_fidelity', 'ADDED_DETAIL: adds a thing', '{"verdict":"ADDED_DETAIL"}')`)
  run(`insert into public.claim_embeddings (claim_id, embedding) values ('${ORIGINAL}', '[9,9,9]')`)
}

type Piece = { id: string; statement: string; members: number[]; embedding?: string }
function planJson(pieces: Piece[]): string {
  return JSON.stringify({
    status_after: 'active',
    claims: pieces.map(p => ({ id: p.id, statement: p.statement, member_ids: p.members.map(insight), embedding: p.embedding ?? '[1,2,3]' })),
    audit: { verdict_before: 'ADDED_DETAIL', offending_before: 'x', reasoning_before: 'adds a thing', attempts: [{ kind: 'split', claims: pieces.map(p => p.id) }], note: 'test split', model: 'test-model' },
    flag_repair: { outcome: 'repaired', run_id: 'repair-test', split_into: pieces.map(p => p.id) },
  })
}
const TWO: Piece[] = [
  { id: ORIGINAL, statement: 'Creatine raises muscle phosphocreatine.', members: [1, 2, 3, 4] },
  { id: newClaim(1), statement: 'Creatine may help memory in sleep-deprived adults.', members: [5, 6, 7, 8] },
]
const FIVE: Piece[] = [
  { id: ORIGINAL, statement: 'Fact A.', members: [1, 2] },
  { id: newClaim(1), statement: 'Fact B.', members: [3] },
  { id: newClaim(2), statement: 'Fact C.', members: [4, 5] },
  { id: newClaim(3), statement: 'Fact D.', members: [6] },
  { id: newClaim(4), statement: 'Fact E.', members: [7, 8] },
]

/** Call the function with a plan; returns the parsed answer, or the error text when it raised. */
function apply(pieces: Piece[] | string, opts: { expected?: string; flag?: string } = {}): { answer?: { status: string; reason?: string; claim_ids?: string[] }; error?: string } {
  const plan = typeof pieces === 'string' ? pieces : planJson(pieces)
  const f = path.join(work, 'call.sql')
  writeFileSync(f, `select public.apply_claim_split('${ORIGINAL}'::uuid, '${opts.flag ?? FLAG}'::uuid, 'repair-test', $q$${opts.expected ?? OLD_WORDING}$q$, $plan$${plan}$plan$::jsonb);\n`)
  const r = psql(['-f', f])
  if (r.status !== 0) return { error: r.err }
  return { answer: JSON.parse(r.out) }
}

/** Everything a split could change, as plain data, to compare before and after. */
function snapshot() {
  return {
    claims: rows(`select id, canonical_statement, context_note, status, best_evidence_type, max_importance, member_count, source_count, needs_tagging, split_from_claim_id, actionability, primary_audience, insight_type, qualifiers from public.claims order by id`),
    members: rows(`select claim_id, raw_insight_id, matched_by, match_confidence::float from public.claim_members order by raw_insight_id`),
    embeddings: rows(`select claim_id, embedding::text from public.claim_embeddings order by claim_id`),
    flags: rows(`select id, claim_id, resolved_at is not null as resolved, resolution, evidence from public.claim_flags order by id`),
    repairs: rows(`select claim_id, outcome from public.claim_repairs order by claim_id`),
    insights: rows(`select * from public.raw_insights order by id`),
  }
}

// ── Splits ──────────────────────────────────────────────────────

test('a 2-way split writes every row in one transaction', { skip }, () => {
  reset()
  const before = snapshot()
  const { answer, error } = apply(TWO)
  assert.equal(error, undefined)
  assert.equal(answer?.status, 'applied')
  assert.deepEqual(answer?.claim_ids, [ORIGINAL, newClaim(1)])

  const s = snapshot()
  const byId = (id: string) => s.claims.find(c => c.id === id) as Record<string, unknown>
  // claim 0 keeps the original id, takes the first wording, goes back to active and is queued for re-tagging
  assert.equal(byId(ORIGINAL).canonical_statement, TWO[0].statement)
  assert.equal(byId(ORIGINAL).status, 'active')
  assert.equal(byId(ORIGINAL).needs_tagging, true)
  assert.equal(byId(ORIGINAL).split_from_claim_id, null)
  // the new claim: its wording, copied context, provenance, queued for tagging, active
  const n = byId(newClaim(1))
  assert.equal(n.canonical_statement, TWO[1].statement)
  assert.equal(n.status, 'active')
  assert.equal(n.needs_tagging, true)
  assert.equal(n.split_from_claim_id, ORIGINAL)
  assert.equal(n.context_note, 'In healthy adults.')
  assert.equal(n.actionability, 'High')
  assert.equal(n.primary_audience, 'Both')
  assert.equal(n.insight_type, 'Explanation')
  assert.deepEqual(n.qualifiers, { dose: '5 g/day' })
  // every insight is in exactly the claim the plan named; nothing lost, nothing duplicated; matched_by kept
  assert.equal(s.members.length, 8)
  for (const p of TWO) for (const m of p.members) assert.equal((s.members.find(x => x.raw_insight_id === insight(m)) as Record<string, unknown>).claim_id, p.id)
  assert.equal((s.members.find(x => x.raw_insight_id === insight(1)) as Record<string, unknown>).matched_by, 'seed')
  assert.equal((s.members.find(x => x.raw_insight_id === insight(1)) as Record<string, unknown>).match_confidence, 0.9)
  // aggregates are recomputed for BOTH claims (insights 1-4: sources A,B; evidence best MetaAnalysis; max importance 3)
  assert.equal(byId(ORIGINAL).member_count, 4)
  assert.equal(byId(ORIGINAL).source_count, 2)
  assert.equal(byId(ORIGINAL).max_importance, 3)
  assert.equal(byId(ORIGINAL).best_evidence_type, 'MetaAnalysis')
  assert.equal(n.member_count, 4)
  assert.equal(n.source_count, 2)
  assert.equal(n.max_importance, 3)
  assert.equal(n.best_evidence_type, 'Cohort') // 5 Cohort, 6 ExpertOpinion, 7 Mechanistic, 8 CaseSeries -> Cohort outranks the rest
  // vectors: claim 0 replaced, new claim created
  assert.deepEqual(s.embeddings, [{ claim_id: ORIGINAL, embedding: '[1,2,3]' }, { claim_id: newClaim(1), embedding: '[1,2,3]' }])
  // the flag resolved as reworded and records the split
  assert.equal(s.flags[0].resolved, true)
  assert.equal(s.flags[0].resolution, 'reworded')
  assert.deepEqual((s.flags[0].evidence as { repair: { split_into: string[] }; verdict: string }).repair.split_into, [ORIGINAL, newClaim(1)])
  assert.equal((s.flags[0].evidence as { verdict: string }).verdict, 'ADDED_DETAIL', 'the flag evidence it already had is kept')
  // the OLD wording is saved
  const audit = rows<{ claim_id: string; outcome: string; original_statement: string; new_statement: string; verdict_before: string; flag_id: string; attempts: unknown; model: string }>(`select * from public.claim_repairs`)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].claim_id, ORIGINAL)
  assert.equal(audit[0].outcome, 'repaired')
  assert.equal(audit[0].original_statement, OLD_WORDING)
  assert.equal(audit[0].new_statement, TWO[0].statement)
  assert.equal(audit[0].verdict_before, 'ADDED_DETAIL')
  assert.equal(audit[0].flag_id, FLAG)
  assert.equal(audit[0].model, 'test-model')
  assert.ok(Array.isArray(audit[0].attempts))
  // raw_insights are immutable
  assert.deepEqual(s.insights, before.insights)
})

test('a 5-way split makes four new claims with the right members and aggregates', { skip }, () => {
  reset()
  const { answer, error } = apply(FIVE)
  assert.equal(error, undefined)
  assert.equal(answer?.status, 'applied')
  const s = snapshot()
  assert.equal(s.claims.length, 5)
  assert.equal(s.members.length, 8)
  assert.equal(s.embeddings.length, 5)
  assert.deepEqual(s.repairs, [{ claim_id: ORIGINAL, outcome: 'repaired' }])
  for (const p of FIVE) {
    const c = s.claims.find(x => x.id === p.id) as Record<string, unknown>
    assert.equal(c.canonical_statement, p.statement)
    assert.equal(c.status, 'active')
    assert.equal(c.member_count, p.members.length)
    assert.equal(s.members.filter(m => m.claim_id === p.id).length, p.members.length)
  }
  assert.equal(s.claims.filter(c => c.split_from_claim_id === ORIGINAL).length, 4)
  // a claim whose only insight has no importance keeps max_importance null: claim C holds 4 (null) and 5 (2) -> 2; claim 4 alone would be null
  assert.equal((s.claims.find(c => c.id === newClaim(2)) as Record<string, unknown>).max_importance, 2)
})

// ── A write that fails halfway changes nothing ──────────────────

test('a vector that fails AFTER the members were moved rolls everything back, and the same plan then applies', { skip }, () => {
  reset()
  const before = snapshot()
  const bad = FIVE.map((p, i) => (i === 4 ? { ...p, embedding: 'not-a-vector' } : p)) // the very last write
  const first = apply(bad)
  assert.match(first.error ?? '', /halfvec|violates check|invalid/i, 'the write fails')
  assert.deepEqual(snapshot(), before, 'the database is exactly as it was: members, claims, vectors, flag, no audit row')
  assert.equal(before.claims[0].status, 'flagged')

  const second = apply(FIVE) // resume: same ids, good vector
  assert.equal(second.answer?.status, 'applied')
  assert.equal(snapshot().claims.length, 5)
})

test('an id that already exists fails in the middle of the new claims and rolls everything back', { skip }, () => {
  reset()
  // a claim with the id the plan wants for its 3rd piece already exists (a collision)
  run(`insert into public.claims (id, canonical_statement, status) values ('${newClaim(2)}', 'bystander', 'active')`)
  const before = snapshot()
  const r = apply(FIVE)
  assert.match(r.error ?? '', /duplicate key|already exists|unique/i)
  assert.deepEqual(snapshot(), before)
  assert.equal(before.claims.find(c => c.id === newClaim(1)), undefined, 'the piece created before the collision is gone too')
})

// ── Re-runs and stale claims ────────────────────────────────────

test('re-running an already repaired claim writes nothing (also with a different set of new ids)', { skip }, () => {
  reset()
  assert.equal(apply(TWO).answer?.status, 'applied')
  const after = snapshot()
  assert.equal(apply(TWO).answer?.status, 'already_applied')
  const other = TWO.map((p, i) => (i === 0 ? p : { ...p, id: newClaim(9) }))
  assert.equal(apply(other).answer?.status, 'already_applied')
  assert.deepEqual(snapshot(), after)
  assert.equal(after.repairs.length, 1)
})

test('a claim whose wording, status, flag or members changed since it was read is stale and untouched', { skip }, () => {
  reset()
  let before = snapshot()
  assert.deepEqual(apply(TWO, { expected: 'Somebody edited this.' }).answer, { status: 'stale', reason: 'the claim wording changed after it was read' })
  assert.deepEqual(snapshot(), before)

  run(`update public.claim_flags set resolved_at = now(), resolution = 'false_positive' where id = '${FLAG}'`)
  before = snapshot()
  assert.equal(apply(TWO).answer?.reason, 'the flag is no longer open')
  assert.deepEqual(snapshot(), before)

  reset()
  run(`update public.claims set status = 'active' where id = '${ORIGINAL}'`)
  before = snapshot()
  assert.match(apply(TWO).answer?.reason ?? '', /no longer quarantined/)
  assert.deepEqual(snapshot(), before)

  reset()
  run(`insert into public.raw_insights (id, source_id, statement, importance, evidence_type) values ('${insight(99)}', '${SRC_A}', 'late arrival', 1, 'Other')`)
  run(`insert into public.claim_members (claim_id, raw_insight_id) values ('${ORIGINAL}', '${insight(99)}')`) // consolidation attached a 9th insight after the plan was made
  before = snapshot()
  assert.match(apply(TWO).answer?.reason ?? '', /member insights changed/)
  assert.deepEqual(snapshot(), before, 'no insight is dropped: the plan did not know about the 9th')
})

test('a plan that leaves an insight behind, repeats one, or has fewer than two claims is refused without writing', { skip }, () => {
  reset()
  const before = snapshot()
  const leaves = apply([{ ...TWO[0], members: [1, 2, 3] }, TWO[1]]) // insight 4 nowhere
  assert.match(leaves.answer?.reason ?? '', /member insights changed/)
  const twice = apply([{ ...TWO[0], members: [1, 2, 3, 4, 5] }, TWO[1]]) // insight 5 in both
  assert.match(twice.answer?.reason ?? '', /member insights changed/)
  assert.match(apply([TWO[0]]).error ?? '', /at least two claims/)
  assert.match(apply([TWO[1], TWO[0]]).error ?? '', /first claim of the plan must be the original/)
  assert.match(apply([{ ...TWO[0], statement: '  ' }, TWO[1]]).error ?? '', /no statement/)
  assert.match(apply(planJson(TWO).replace('"status_after":"active"', '"status_after":"approved"')).error ?? '', /status_after/)
  assert.deepEqual(snapshot(), before)
})

test('only the service role may call the function', { skip }, () => {
  const acl = run(`select has_function_privilege('anon', 'public.apply_claim_split(uuid,uuid,text,text,jsonb)', 'execute')::text || ',' || has_function_privilege('authenticated', 'public.apply_claim_split(uuid,uuid,text,text,jsonb)', 'execute')::text || ',' || has_function_privilege('service_role', 'public.apply_claim_split(uuid,uuid,text,text,jsonb)', 'execute')::text`)
  assert.equal(acl, 'false,false,true')
})
