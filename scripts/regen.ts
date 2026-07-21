/**
 * One-off: regenerate a single topic's articles through the (Claude) pipeline.
 * Usage: node --env-file=.env.local --import tsx scripts/regen.ts <topicId>
 */
import { generateTopicContent } from '../lib/synthesis'

async function main() {
  const id = process.argv[2]
  if (!id) throw new Error('usage: regen.ts <topicId>')
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not loaded')
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error('SUPABASE env not loaded')
  const t0 = Date.now()
  console.log(`[regen] starting ${id}`)
  const res = await generateTopicContent(id)
  console.log(`[regen] RESULT ${JSON.stringify(res)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[regen] ERROR', e)
    process.exit(1)
  })
