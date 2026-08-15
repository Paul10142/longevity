export {}
import { readFileSync } from 'node:fs'
const pairs = JSON.parse(readFileSync('eval/extraction-eval-pairs.json','utf8')) as any[]
const run = JSON.parse(readFileSync('eval/extraction-run.json','utf8')) as any[]
const gold = JSON.parse(readFileSync('eval/extraction-goldset.json','utf8')) as any[]
const runById = new Map(run.map(r=>[r.id,r])); const goldById = new Map(gold.map(g=>[g.id,g]))
for (let i=0;i<pairs.length;i++){
  const p=pairs[i], r=runById.get(p.id), g=goldById.get(p.id)
  if(!r||!g) continue
  if(r.verdict!==g.label){
    console.log(`#${i+1} — judge: ${r.verdict} | paul: ${g.label}`)
    console.log(`   statement: ${p.statement.slice(0,110)}`)
    if(r.offending) console.log(`   judge points at: «${r.offending.slice(0,80)}»`)
    console.log()
  }
}
