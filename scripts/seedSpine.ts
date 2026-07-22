/**
 * Seed the curated taxonomy spine.
 *
 * These branches are the stable structure the pipeline files into. They are
 * created as human-authored and protected (`is_spine`), so tagging and
 * discovery may add children beneath them but can never rename, re-parent,
 * merge, or archive them.
 *
 *   npm run seed-spine -- --dry-run   # print the plan, write nothing
 *   npm run seed-spine                # create missing topics
 *
 * Idempotent: an existing topic with the same name is adopted into the spine
 * (marked, and re-parented if it was a stray root) rather than duplicated.
 */

import { supabaseAdmin } from '../lib/supabaseServer'
import { generateEmbedding } from '../lib/embeddings'

// Paul's curated top-level taxonomy (Attia/"Outlive"-aligned).
// "Metabolic Health" sits under Risks rather than Nutrition — a topic has one
// parent, and its primary framing here is disease risk (a horseman).
const SPINE: { name: string; children: string[] }[] = [
  {
    name: 'Exercise',
    children: [
      'Strength & Muscle Mass',
      'Stability',
      'Zone 2',
      'VO2 Max',
      // Generic phrasing on purpose — the equivalent term in the source
      // material is an author's coined phrase.
      'Defining Physical Goals in Old Age',
      'High Intensity & Zone 5 Training',
    ],
  },
  {
    name: 'Nutrition',
    children: ['Body Composition & DEXA', 'Protein', 'Alcohol', 'Fasting', 'Ketosis'],
  },
  { name: 'Sleep', children: [] },
  {
    name: 'Medications & Supplements',
    children: ['Medications', 'Supplements', 'Hormone Replacement Therapy'],
  },
  {
    name: 'Mental & Emotional Health',
    children: ['Quality of Life', 'Trauma & Therapy', 'Relationships', 'Mindfulness & Meditation'],
  },
  {
    name: 'Risks',
    children: [
      'Cardiovascular Disease',
      'Cancer',
      'Neurodegenerative Disease',
      'Metabolic Health',
      'Hormones',
      'Family Medical History & Genetics',
      'Accidental Death',
    ],
  },
]

/**
 * Existing topics that ARE a spine branch under a different name.
 *
 * Without this, seeding "Sleep" alongside the existing "Sleep & Circadian
 * Rhythm" (16 claims) would create exactly the duplicate roots this whole
 * change exists to prevent. Instead the existing row is adopted and renamed,
 * so it keeps its id, slug, and every claim already filed under it.
 *
 * Slugs are frozen by design (a rename never re-slugs), so existing topic URLs
 * and article citations keep working. See ARCHITECTURE.md.
 */
const ALIASES: Record<string, string[]> = {
  Sleep: ['Sleep & Circadian Rhythm'],
  'Mental & Emotional Health': ['Mental Health'],
}

function db() {
  if (!supabaseAdmin) throw new Error('Supabase admin client not configured')
  return supabaseAdmin
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

type Row = { id: string; name: string; parent_id: string | null; is_spine: boolean }

async function uniqueSlug(name: string): Promise<string> {
  let slug = slugify(name) || 'topic'
  for (let n = 2; ; n++) {
    const { data } = await db().from('topics').select('id').eq('slug', slug).limit(1)
    if (!data || data.length === 0) return slug
    slug = `${slugify(name)}-${n}`
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  if (dryRun) console.log('DRY RUN — nothing will be written\n')

  const { data: existingRows, error } = await db()
    .from('topics')
    .select('id, name, parent_id, is_spine')
    .eq('status', 'active')
  if (error) throw new Error(`Failed to load topics: ${error.message}`)

  const byName = new Map<string, Row>()
  for (const t of (existingRows ?? []) as Row[]) byName.set(t.name.toLowerCase(), t)

  let created = 0
  let adopted = 0

  for (const branch of SPINE) {
    let root = byName.get(branch.name.toLowerCase())

    // No exact match — adopt a known alias rather than creating a near-duplicate.
    if (!root) {
      for (const alias of ALIASES[branch.name] ?? []) {
        const candidate = byName.get(alias.toLowerCase())
        if (!candidate) continue
        console.log(`adopt   ${branch.name}  (renaming "${alias}", keeps its claims)`)
        if (!dryRun) {
          await db()
            .from('topics')
            .update({
              name: branch.name,
              parent_id: null,
              is_spine: true,
              created_by: 'human',
              reviewed_by_human: true,
            })
            .eq('id', candidate.id)
          adopted++
        }
        root = { ...candidate, name: branch.name, parent_id: null, is_spine: true }
        byName.set(branch.name.toLowerCase(), root)
        break
      }
      if (root) {
        for (const childName of branch.children) {
          const child = byName.get(childName.toLowerCase())
          if (child) {
            const misplaced = child.parent_id !== root.id
            console.log(`  ${misplaced ? 're-parent' : 'ok       '} ${childName}`)
            if (misplaced && !dryRun) {
              await db()
                .from('topics')
                .update({ parent_id: root.id, is_spine: true, reviewed_by_human: true })
                .eq('id', child.id)
              adopted++
            }
            continue
          }
          console.log(`  create    ${childName}`)
          if (dryRun) continue
          const embedding = await generateEmbedding(childName)
          const { data, error: insErr } = await db()
            .from('topics')
            .insert({
              name: childName,
              slug: await uniqueSlug(childName),
              parent_id: root.id,
              is_spine: true,
              created_by: 'human',
              reviewed_by_human: true,
              embedding,
            })
            .select('id, name, parent_id, is_spine')
            .single()
          if (insErr || !data) throw new Error(`Failed to create "${childName}": ${insErr?.message}`)
          byName.set(childName.toLowerCase(), data as Row)
          created++
        }
        continue
      }
    }

    if (root) {
      // Adopt the existing topic as spine rather than creating a duplicate.
      const needsUpdate = !root.is_spine || root.parent_id !== null
      console.log(
        needsUpdate
          ? `adopt   ${branch.name}${root.parent_id ? ' (promoting to top level)' : ''}`
          : `ok      ${branch.name}`
      )
      if (needsUpdate && !dryRun) {
        await db()
          .from('topics')
          .update({ is_spine: true, parent_id: null, created_by: 'human', reviewed_by_human: true })
          .eq('id', root.id)
        adopted++
      }
    } else {
      console.log(`create  ${branch.name}`)
      if (!dryRun) {
        const embedding = await generateEmbedding(branch.name)
        const { data, error: insErr } = await db()
          .from('topics')
          .insert({
            name: branch.name,
            slug: await uniqueSlug(branch.name),
            parent_id: null,
            is_spine: true,
            created_by: 'human',
            reviewed_by_human: true,
            embedding,
          })
          .select('id, name, parent_id, is_spine')
          .single()
        if (insErr || !data) throw new Error(`Failed to create "${branch.name}": ${insErr?.message}`)
        root = data as Row
        byName.set(branch.name.toLowerCase(), root)
        created++
      }
    }

    for (const childName of branch.children) {
      const child = byName.get(childName.toLowerCase())
      if (child) {
        // In a dry run the root may not exist yet; an existing child certainly
        // isn't parented to a topic that hasn't been created, so report the
        // re-parent that would actually happen rather than a misleading "ok".
        const misplaced = root ? child.parent_id !== root.id : true
        console.log(`  ${misplaced ? 're-parent' : 'ok       '} ${childName}`)
        if (misplaced && !dryRun && root) {
          await db()
            .from('topics')
            .update({ parent_id: root.id, is_spine: true, reviewed_by_human: true })
            .eq('id', child.id)
          adopted++
        }
        continue
      }

      console.log(`  create    ${childName}`)
      if (dryRun || !root) continue

      const embedding = await generateEmbedding(childName)
      const { data, error: insErr } = await db()
        .from('topics')
        .insert({
          name: childName,
          slug: await uniqueSlug(childName),
          parent_id: root.id,
          is_spine: true,
          created_by: 'human',
          reviewed_by_human: true,
          embedding,
        })
        .select('id, name, parent_id, is_spine')
        .single()
      if (insErr || !data) throw new Error(`Failed to create "${childName}": ${insErr?.message}`)
      byName.set(childName.toLowerCase(), data as Row)
      created++
    }
  }

  console.log(
    dryRun
      ? '\nDry run complete — re-run without --dry-run to apply.'
      : `\nSpine seeded: ${created} created, ${adopted} adopted/re-parented.`
  )
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
