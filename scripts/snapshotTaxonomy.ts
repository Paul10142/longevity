/** Snapshot topics + claim_topics to scratchpad JSON (rollback insurance). */
import { supabaseAdmin } from "../lib/supabaseServer"
import { selectAllPaged } from "../lib/pagination"
import { writeFileSync } from "node:fs"

async function main() {
  const db = supabaseAdmin!
  const stamp = process.argv[2] ?? new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const topics = await selectAllPaged<Record<string, unknown>>((f, t) =>
    db.from("topics").select("id, name, parent_id, status, merged_into_id, is_spine, reviewed_by_human").order("id").range(f, t)
  )
  const ct = await selectAllPaged<Record<string, unknown>>((f, t) =>
    db.from("claim_topics").select("claim_id, topic_id, assigned_by").order("claim_id").range(f, t)
  )
  writeFileSync(`scratchpad/snapshot-topics-${stamp}.json`, JSON.stringify(topics))
  writeFileSync(`scratchpad/snapshot-claimtopics-${stamp}.json`, JSON.stringify(ct))
  console.log(`snapshot ${stamp}: ${topics.length} topics, ${ct.length} claim_topics rows`)
}
main().catch((e) => { console.error(e); process.exit(1) })
