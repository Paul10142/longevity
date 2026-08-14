/** Recompute topics.claim_count after the orphaned-topic-link repair. */
export {}
async function main() {
  const { recomputeTopicCounts } = await import('../lib/taxonomy')
  await recomputeTopicCounts()
  console.log('topic claim counts recomputed')
}
main().catch(e => { console.error(e); process.exit(1) })
