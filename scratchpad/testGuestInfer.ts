export {}
process.env.LLM_BACKEND = process.env.LLM_BACKEND || 'claude-code'
async function main() {
  const { supabaseAdmin } = await import('../lib/supabaseServer')
  const { inferGuestsFromIntro } = await import('../lib/extraction')
  if (!supabaseAdmin) throw new Error('no db')
  const { data } = await supabaseAdmin
    .from('sources').select('title, transcript')
    .ilike('title', '%255%CVD%').limit(1).single()
  if (!data?.transcript) throw new Error('no transcript')
  console.log('episode:', data.title)
  console.log('inferred guests:', await inferGuestsFromIntro(data.transcript))
}
main().catch(e => { console.error(e); process.exit(1) })
