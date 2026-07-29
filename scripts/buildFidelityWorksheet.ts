/**
 * Build the extraction-fidelity LABEL WORKSHEET for Paul (Phase 1a — certify the judge).
 *
 * Zero LLM, zero DB: joins the committed 40-pair sample
 * (eval/extraction-eval-pairs.json) with the judge's verdicts
 * (eval/extraction-run.json) into a self-contained, mobile-friendly HTML page.
 *
 * Paul rules each insight FAITHFUL / ADDED_DETAIL / DROPPED_QUALIFIER /
 * UNRESOLVED_REFERENCE (judge's take hidden behind a toggle so his ruling is
 * independent). Rulings persist to localStorage; "Export gold set" downloads
 * eval/extraction-goldset.json in the exact GoldLabel schema evalExtraction.ts
 * `score` reads → then judge↔human κ.
 *
 *   npx tsx scripts/buildFidelityWorksheet.ts  > scratchpad/extraction-fidelity-worksheet.html
 */
import { readFileSync } from 'node:fs'

type Pair = {
  id: string
  source_title: string
  statement: string
  context_note: string | null
  direct_quote: string | null
  quote_verified: boolean
  chunk_text: string
}
type Run = { id: string; verdict: string; offending: string; reasoning: string }

const pairs = JSON.parse(readFileSync('eval/extraction-eval-pairs.json', 'utf8')) as Pair[]
const runs = JSON.parse(readFileSync('eval/extraction-run.json', 'utf8')) as Run[]
const runById = new Map(runs.map(r => [r.id, r]))

const items = pairs.map((p, i) => {
  const r = runById.get(p.id)
  return {
    n: i + 1,
    id: p.id,
    source: p.source_title,
    statement: p.statement,
    context: p.context_note,
    quote: p.direct_quote,
    quote_verified: p.quote_verified,
    chunk: p.chunk_text,
    judge_verdict: r?.verdict ?? 'UNSURE',
    judge_offending: r?.offending ?? '',
    judge_reasoning: r?.reasoning ?? '',
  }
})

const DATA = JSON.stringify(items)

const html = `<style>
  :root{--bg:#0b0e14;--card:#151a23;--edge:#232b39;--ink:#e6e9ef;--dim:#95a0b4;--accent:#5b9dff;
        --ok:#3fb96b;--flag:#e5624a;--warn:#e0a44a;--chip:#1e2632}
  @media (prefers-color-scheme:light){:root{--bg:#f5f6f8;--card:#fff;--edge:#e3e6ec;--ink:#141821;--dim:#5a6474;--chip:#eef1f6}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--edge);padding:12px 16px}
  header h1{margin:0 0 4px;font-size:16px}
  .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--dim)}
  .bar b{color:var(--ink)}
  button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--edge);background:var(--chip);color:var(--ink);padding:7px 12px}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  main{max-width:820px;margin:0 auto;padding:16px}
  .card{background:var(--card);border:1px solid var(--edge);border-radius:12px;padding:16px;margin:0 0 18px}
  .meta{font-size:12px;color:var(--dim);display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .src{background:var(--chip);border-radius:6px;padding:2px 8px}
  .statement{font-size:16px;font-weight:600;margin:6px 0 10px}
  .quote{font-size:13px;color:var(--dim);border-left:3px solid var(--edge);padding:4px 10px;margin:8px 0}
  .quote.v{border-left-color:var(--ok)}
  details{margin:10px 0}
  summary{cursor:pointer;color:var(--accent);font-size:13px}
  .chunk{white-space:pre-wrap;font-size:13px;color:var(--dim);background:var(--bg);border:1px solid var(--edge);
         border-radius:8px;padding:10px;margin-top:8px;max-height:280px;overflow:auto}
  .judge{font-size:13px;background:var(--bg);border:1px dashed var(--edge);border-radius:8px;padding:8px 10px;margin-top:8px}
  .verdicts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .verdicts label{flex:1;min-width:130px;text-align:center;padding:9px 6px;border:1px solid var(--edge);
         border-radius:9px;font-size:13px;font-weight:600;user-select:none}
  .verdicts input{display:none}
  .verdicts label.ok.sel{background:var(--ok);border-color:var(--ok);color:#fff}
  .verdicts label.flag.sel{background:var(--flag);border-color:var(--flag);color:#fff}
  .verdicts label.warn.sel{background:var(--warn);border-color:var(--warn);color:#fff}
  .agree{font-size:12px;margin-top:8px;color:var(--dim)}
  .done{outline:2px solid var(--ok);outline-offset:2px}
  footer{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--edge);padding:10px 16px;
         display:flex;gap:10px;align-items:center;justify-content:space-between;font-size:13px}
  .pill{background:var(--chip);border-radius:20px;padding:3px 10px}
</style>
</head>
<body>
<header>
  <h1>Extraction Fidelity — gold labeling <span style="color:var(--dim);font-weight:400">(Phase 1a · certify the judge)</span></h1>
  <div class="bar">
    <span>Rule each insight against its source chunk. <b>Rule first, then reveal the judge.</b></span>
  </div>
  <div class="bar" style="margin-top:6px">
    <span class="pill">Progress <b id="prog">0/${items.length}</b></span>
    <span class="pill">Agree w/ judge <b id="agree">–</b></span>
    <label style="font-size:12px"><input type="checkbox" id="revealAll"> reveal all judge takes</label>
    <button id="jump">Next unlabeled</button>
  </div>
</header>
<main id="list"></main>
<footer>
  <span style="color:var(--dim)">Verdicts: <b>FAITHFUL</b> = fully supported · <b>ADDED_DETAIL</b> = asserts more than the chunk (the cardinal failure) · <b>DROPPED_QUALIFIER</b> = lost a limiting condition · <b>UNRESOLVED_REFERENCE</b> = dangling "this/that/the study"</span>
  <button class="primary" id="export">Export gold set ↓</button>
</footer>
<script>
const ITEMS = ${DATA};
const KEY = 'extraction-goldset-v1';
const VERDICTS = [
  ['FAITHFUL','ok'],['ADDED_DETAIL','flag'],['DROPPED_QUALIFIER','warn'],['UNRESOLVED_REFERENCE','warn']
];
const store = JSON.parse(localStorage.getItem(KEY) || '{}');
const esc = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function render(){
  const list = document.getElementById('list');
  list.innerHTML = ITEMS.map(it=>{
    const cur = store[it.id];
    const vbtns = VERDICTS.map(([v,cls])=>
      \`<label class="\${cls} \${cur===v?'sel':''}"><input type="radio" name="v\${it.n}" value="\${v}" \${cur===v?'checked':''}>\${v}</label>\`
    ).join('');
    return \`<div class="card \${cur?'done':''}" id="c\${it.n}" data-id="\${it.id}">
      <div class="meta"><span class="src">\${esc(it.source)}</span><span>#\${it.n} of \${ITEMS.length}</span>
        <span>quote \${it.quote_verified?'✓ verbatim':'—'}</span></div>
      <div class="statement">\${esc(it.statement)}</div>
      \${it.context?\`<div class="meta">context: \${esc(it.context)}</div>\`:''}
      \${it.quote?\`<div class="quote \${it.quote_verified?'v':''}">"\${esc(it.quote)}"</div>\`:''}
      <details><summary>Show source chunk</summary><div class="chunk">\${esc(it.chunk)}</div></details>
      <details class="jd" \${document.getElementById('revealAll')&&document.getElementById('revealAll').checked?'open':''}>
        <summary>Reveal judge's take</summary>
        <div class="judge"><b>\${it.judge_verdict}</b> \${it.judge_offending?'· «'+esc(it.judge_offending)+'»':''}<br>
        <span style="color:var(--dim)">\${esc(it.judge_reasoning)}</span></div>
      </details>
      <div class="verdicts">\${vbtns}</div>
      <div class="agree" id="a\${it.n}"></div>
    </div>\`;
  }).join('');
  ITEMS.forEach(it=>{
    document.querySelectorAll('input[name="v'+it.n+'"]').forEach(r=>{
      r.onchange = ()=>{ store[it.id]=r.value; localStorage.setItem(KEY,JSON.stringify(store));
        document.getElementById('c'+it.n).classList.add('done');
        document.querySelectorAll('#c'+it.n+' .verdicts label').forEach(l=>l.classList.remove('sel'));
        r.parentElement.classList.add('sel'); updateStats(); };
    });
  });
  updateStats();
}
function updateStats(){
  const n = Object.keys(store).length;
  document.getElementById('prog').textContent = n+'/'+ITEMS.length;
  let same=0,tot=0;
  ITEMS.forEach(it=>{ if(store[it.id]){tot++; if(store[it.id]===it.judge_verdict)same++;} });
  document.getElementById('agree').textContent = tot?Math.round(same/tot*100)+'% ('+same+'/'+tot+')':'–';
}
document.getElementById('revealAll').onchange = e=>{
  document.querySelectorAll('details.jd').forEach(d=>d.open=e.target.checked);
};
document.getElementById('jump').onclick = ()=>{
  const next = ITEMS.find(it=>!store[it.id]);
  if(next) document.getElementById('c'+next.n).scrollIntoView({behavior:'smooth',block:'center'});
  else alert('All '+ITEMS.length+' labeled — hit Export gold set.');
};
document.getElementById('export').onclick = ()=>{
  const gold = ITEMS.map(it=>({
    id: it.id,
    label: store[it.id] || it.judge_verdict,
    confirmed: Boolean(store[it.id]),
    labeled_by: store[it.id] ? 'paul' : 'claude-proposed',
    rationale: store[it.id] ? '' : it.judge_reasoning
  }));
  const blob = new Blob([JSON.stringify(gold,null,2)+'\\n'],{type:'application/json'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download='extraction-goldset.json'; a.click();
  const labeled = Object.keys(store).length;
  alert('Exported '+gold.length+' labels ('+labeled+' confirmed by you). Save to eval/extraction-goldset.json, then run:  npx tsx --env-file=.env.local scripts/evalExtraction.ts score');
};
render();
</script>
</body>
</html>`

process.stdout.write(html)
