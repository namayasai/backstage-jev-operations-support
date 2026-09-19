import { useRef, useState, type ReactNode } from 'react';
import { evaluationRequestByteLength, MAX_EVALUATION_BYTES, evaluationRequestSchema, workflows, sampleText, sampleCandidates, type Candidate, type EvaluationRequest, type EvaluationResult, type WorkflowId } from '@namayasai/backstage-plugin-jev-operations-support-common';

export interface TechDocsOptions {
  entityRef: string;
  annotation?: string;
  unsupportedReason?: string;
  load: (relativePath: string) => Promise<string>;
}

export interface WorkbenchProps {
  evaluate: (request: EvaluationRequest) => Promise<EvaluationResult>;
  loadCandidates?: (workflow: WorkflowId, term: string) => Promise<Candidate[]>;
  renderCandidateLink?: (candidate: Candidate) => ReactNode;
  initialWorkflow?: WorkflowId;
  initialText?: string;
  contextNote?: ReactNode;
  techDocs?: TechDocsOptions;
  demo?: boolean;
}

/** Shared by every Jev view so a view can be mounted on its own and still be styled. */
export const jevStyles = `
.jev,.jev-tabs{--ink:#e9f0f5;--muted:#a6b8c8;--line:#304253;--panel:#172736;--accent:#8fe5cb;color-scheme:dark}
.jev{background:#0d1924;color:var(--ink);font:15px/1.6 system-ui,sans-serif;min-height:100vh;padding:38px 5%;box-sizing:border-box}
.jev *{box-sizing:border-box}.jev button,.jev input,.jev textarea{font:inherit}.jev button{cursor:pointer}.jev button:disabled{cursor:wait;opacity:.55}.jev button:focus-visible,.jev input:focus-visible,.jev textarea:focus-visible,.jev a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.jev h1,.jev h2,.jev h3,.jev p{margin:0}.jev h1{font-size:clamp(30px,4vw,44px);line-height:1.2;letter-spacing:-1.5px}.jev h2{font-size:24px;letter-spacing:-.6px}.jev h3{font-size:16px}.jev a{color:var(--accent)}
.jev-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}.jev-brand{font-size:13px;letter-spacing:3px;font-weight:700}.jev-pill{border:1px solid var(--line);border-radius:30px;padding:5px 13px;font-size:12px;letter-spacing:.4px;color:var(--muted)}
.jev-intro{max-width:790px;margin-bottom:32px}.jev-intro p{color:var(--muted);margin-top:12px;font-size:16px}.jev-grid{display:grid;grid-template-columns:245px minmax(0,1fr);gap:30px;max-width:1400px;margin:auto}.jev-nav{display:flex;flex-direction:column;gap:7px}.jev-nav button{background:none;border:1px solid transparent;text-align:left;color:var(--muted);padding:14px;border-radius:10px;display:flex;gap:12px;align-items:center}.jev-nav button[aria-pressed=true]{background:#203b42;border-color:#46736d;color:var(--accent)}.jev-num{font:12px ui-monospace,monospace;opacity:.7}.jev-nav small{display:block;margin:18px 14px;color:var(--muted);font-size:12px}
.jev-panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:26px;min-width:0}.jev-panel p{color:var(--muted);margin-top:5px}.jev-label{display:block;font-weight:600;margin:24px 0 8px}.jev textarea,.jev input{width:100%;background:#101e2b;color:var(--ink);border:1px solid #42596b;border-radius:8px;padding:13px}.jev textarea{min-height:230px;resize:vertical;line-height:1.65}.jev-help{font-size:12px;color:var(--muted);margin-top:7px}.jev-actions{display:flex;align-items:center;gap:12px;margin-top:20px;flex-wrap:wrap}.jev-primary{background:var(--accent);color:#0a2822;border:none;border-radius:8px;padding:11px 23px;font-weight:700!important}.jev-secondary{background:transparent;border:1px solid #496171;border-radius:8px;color:var(--ink);padding:8px 13px}.jev-quiet{background:none;border:none;color:var(--muted);padding:8px}.jev-banner{background:#2c2a1b;color:#f6dfa1;border:1px solid #665b34;border-radius:8px;padding:11px 15px;margin-bottom:20px;font-size:13px}.jev-error{background:#422a32;color:#ffd3d6;border:1px solid #a3616f;border-radius:8px;padding:12px;margin-top:16px}.jev-candidates{border-top:1px solid var(--line);margin-top:23px;padding-top:18px}.jev-candidate{display:grid;grid-template-columns:1fr auto;gap:8px;border:1px solid var(--line);border-radius:9px;padding:12px;margin-top:10px}.jev-candidate textarea{min-height:65px;font-size:13px}.jev-candidate-fields{display:grid;gap:8px}.jev-candidate-fields input{font-size:13px;padding:8px}.jev-results{margin-top:25px}.jev-result-header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}.jev-result{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:10px 0;padding:18px 21px}.jev-result-line{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.jev-status{font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:4px 9px;border-radius:5px;white-space:nowrap}.jev-pass{background:#204c42;color:#a4efd4}.jev-attention{background:#494021;color:#ffe4a2}.jev-review{background:#3b3552;color:#d9ccff}.jev-value{font:24px ui-monospace,monospace;margin:11px 0 5px}.jev-result p{font-size:13px;color:var(--muted)}.jev-meter{background:#0a151f;height:5px;border-radius:6px;margin:12px 0;overflow:hidden}.jev-meter span{display:block;height:100%;background:var(--accent)}.jev-result details{margin-top:10px;font-size:12px;color:var(--muted)}.jev-result dl{display:grid;grid-template-columns:1fr auto;gap:4px 20px}.jev-result dt{overflow-wrap:anywhere}.jev-result dd{margin:0}.jev-footer{font-size:12px;color:var(--muted);margin-top:22px}.jev-empty{padding:27px;border:1px dashed var(--line);border-radius:12px;margin-top:24px;color:var(--muted);text-align:center}.jev-count{font:12px ui-monospace,monospace;color:var(--muted)}
.jev-context{border:1px solid var(--line);border-radius:10px;padding:13px 16px;margin-top:20px;font-size:13px;color:var(--muted)}.jev-context strong{display:block;color:var(--ink);margin-bottom:4px}
.jev-techdocs{border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-top:20px}.jev-techdocs .jev-label{margin-top:16px}
.jev-status-message{font-size:12px;color:var(--accent);margin-top:10px}
.jev-tabs{display:flex;gap:8px;flex-wrap:wrap;background:#0d1924;font:15px/1.6 system-ui,sans-serif;padding:26px 5% 0}.jev-tabs button{font:inherit;cursor:pointer;background:none;border:1px solid var(--line);border-radius:9px;color:var(--muted);padding:9px 17px}.jev-tabs button[aria-pressed=true]{background:#203b42;border-color:#46736d;color:var(--accent)}.jev-tabs button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.jev-alerts{max-width:1400px;margin:auto}.jev-alert{display:block;width:100%;text-align:left;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}.jev-alert[aria-pressed=true]{background:#203b42;border-color:#46736d}
@media(max-width:850px){.jev{padding:24px 18px}.jev-tabs{padding:18px 18px 0}.jev-grid{grid-template-columns:1fr}.jev-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.jev-nav small{display:none}.jev-panel{padding:20px}.jev-top{margin-bottom:24px}.jev-intro{margin-bottom:24px}}
`;

export function JevWorkbench({ evaluate, loadCandidates, renderCandidateLink, initialWorkflow = 'readiness', initialText, contextNote, techDocs, demo = false }: WorkbenchProps) {
  const [workflow, setWorkflow] = useState<WorkflowId>(initialWorkflow);
  const [text, setText] = useState(initialText ?? '');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [result, setResult] = useState<EvaluationResult>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [catalogTerm, setCatalogTerm] = useState('');
  const [error, setError] = useState('');
  const [techDocsPath, setTechDocsPath] = useState('index.html');
  const [techDocsBusy, setTechDocsBusy] = useState(false);
  const [techDocsSource, setTechDocsSource] = useState('');
  const generation = useRef(0);
  const current = workflows.find(w => w.id === workflow)!;
  const needsCandidates = ['templates', 'ownership', 'search'].includes(workflow);
  const requestCandidates = needsCandidates ? candidates.map(candidate => ({ ...candidate, id: candidate.id.trim(), title: candidate.title.trim() })) : [];
  const requestBytes = evaluationRequestByteLength({ workflow, text: text.trim(), candidates: requestCandidates });
  const textTooLong = text.length > 16000;
  const byteOverflow = requestBytes > MAX_EVALUATION_BYTES;
  const inputBlocked = textTooLong || byteOverflow;
  function clearResult() { generation.current++; setResult(undefined); setError(''); }
  function switchWorkflow(id: WorkflowId) { clearResult(); setWorkflow(id); setText(''); setCandidates([]); setCatalogTerm(''); setTechDocsSource(''); }
  function updateCandidate(index: number, field: 'title' | 'description', value: string) {
    clearResult(); setCandidates(old => old.map((c, i) => i === index ? { ...c, [field]: value } : c));
  }
  async function run() {
    setError(''); setResult(undefined);
    if (textTooLong || byteOverflow) {
      setError(textTooLong ? 'Context exceeds the 16,000 character limit. Shorten it before evaluating.' : `Request is ${requestBytes.toLocaleString()} UTF-8 bytes; the limit is ${MAX_EVALUATION_BYTES.toLocaleString()}. Shorten the context or candidate descriptions before evaluating.`);
      return;
    }
    const parsed = evaluationRequestSchema.safeParse({ workflow, text, candidates: needsCandidates ? candidates : [] });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(' ')); return; }
    const version = ++generation.current;
    setBusy(true);
    try { const value = await evaluate(parsed.data); if (version === generation.current) setResult(value); }
    catch (e) { if (version === generation.current) setError(e instanceof Error ? e.message : 'Evaluation failed.'); }
    finally { setBusy(false); }
  }
  async function fromCatalog() {
    if (!loadCandidates) return;
    const version = ++generation.current; setResult(undefined); setError(''); setLoading(true);
    try { const values = await loadCandidates(workflow, catalogTerm); if (version === generation.current) { setCandidates(values); if (!values.length) setError('No catalog entries matched. Try a different filter or add candidates manually.'); } }
    catch (e) { if (version === generation.current) setError(e instanceof Error ? e.message : 'Catalog could not be loaded.'); }
    finally { setLoading(false); }
  }
  async function fromTechDocs() {
    if (!techDocs) return;
    if (techDocs.unsupportedReason) { setError(techDocs.unsupportedReason); return; }
    const version = ++generation.current;
    setError(''); setTechDocsBusy(true);
    try {
      const value = await techDocs.load(techDocsPath);
      if (!value.trim()) throw new Error('The selected TechDocs page has no readable text. Choose another page.');
      if (version !== generation.current) return;
      clearResult(); setText(value); setTechDocsSource(techDocsPath);
    } catch (e) {
      if (version === generation.current) setError(e instanceof Error ? e.message : 'TechDocs could not be loaded.');
    } finally { setTechDocsBusy(false); }
  }
  function example() {
    clearResult(); setTechDocsSource(''); setText(sampleText[workflow]);
    setCandidates(workflow === 'templates' ? [
      { id: 'node', title: 'Node.js + PostgreSQL', description: 'HTTP service with Node.js, PostgreSQL migrations, and Kubernetes deployment.' },
      { id: 'static', title: 'Static website', description: 'Static HTML and CSS website hosted on object storage. No server or database.' },
    ] : needsCandidates ? sampleCandidates : []);
  }
  return <main className="jev">
    <style>{jevStyles}</style>
    <header className="jev-top"><span className="jev-brand">JEV / OPERATIONS SUPPORT</span><span className="jev-pill">{demo ? 'FIXTURE PLAYGROUND' : 'DECISION WORKBENCH'}</span></header>
    <div className="jev-intro"><h1>Small decisions.<br />A clearer path forward.</h1><p>Six focused workflows for your developer platform. Bring the context, inspect the evidence, and keep uncertainty visible.</p></div>
    {demo && <div className="jev-banner" role="note">Demo mode — results are fixed illustrative examples. No API call is made, and your text is not evaluated.</div>}
    <div className="jev-grid">
      <nav className="jev-nav" aria-label="Decision workflows">
        {workflows.map((w, i) => <button key={w.id} aria-pressed={workflow === w.id} disabled={busy || loading || techDocsBusy} onClick={() => switchWorkflow(w.id)}><span className="jev-num">0{i + 1}</span>{w.title}</button>)}
        <small>Each workflow asks narrow questions.<br /><br />Recommendations never change ownership, deploy software, or resolve incidents.</small>
      </nav>
      <section aria-label={current.title}>
        <div className="jev-panel">
          <h2>{current.title}</h2><p>{current.description}</p>
          {contextNote && <div className="jev-context" role="note"><strong>Entity context</strong>{contextNote}</div>}
          {techDocs && <div className="jev-techdocs">
            <h3>Load TechDocs for this entity</h3>
            <p className="jev-help">Load a page into the editor for review. It is not sent to Jev until you explicitly evaluate it.</p>
            <label className="jev-label" htmlFor="jev-techdocs-path">Relative page path</label>
            <input id="jev-techdocs-path" value={techDocsPath} placeholder="index.html or operations/runbook" onChange={e => { setTechDocsPath(e.target.value); setError(''); }} disabled={busy || loading || techDocsBusy || Boolean(techDocs.unsupportedReason)} />
            <div className="jev-actions"><button className="jev-secondary" disabled={busy || loading || techDocsBusy || Boolean(techDocs.unsupportedReason)} onClick={fromTechDocs}>{techDocsBusy ? 'Loading TechDocs…' : 'Load into editor'}</button></div>
            {techDocs.unsupportedReason && <p className="jev-status-message" role="status">{techDocs.unsupportedReason}</p>}
            {techDocsSource && <p className="jev-status-message" role="status">Preview source: TechDocs page {techDocs.entityRef}/{techDocsSource} ({techDocsSource === 'index.html' ? 'full rendered page' : 'selected page; it may be a partial excerpt'}). Review or edit the text below, then choose Evaluate explicitly.</p>}
            <p className="jev-help">Entity: {techDocs.entityRef}{techDocs.annotation ? ` · techdocs-ref: ${techDocs.annotation} (display only)` : ''}</p>
          </div>}
          <label className="jev-label" htmlFor="jev-context">Context</label>
          <textarea id="jev-context" value={text} placeholder={current.prompt} onChange={e => { clearResult(); setText(e.target.value); }} disabled={busy || techDocsBusy} />
          <div className="jev-help">{current.prompt} <span className="jev-count">{text.length.toLocaleString()} / 16,000 chars · {requestBytes.toLocaleString()} / {MAX_EVALUATION_BYTES.toLocaleString()} UTF-8 bytes</span></div>
          {needsCandidates && <div className="jev-candidates">
            <h3>Candidates <span className="jev-count">{candidates.length} / 20</span></h3>
            <p className="jev-help">Use a small, relevant shortlist. Descriptions are sent with your context.</p>
            {loadCandidates && <><label className="jev-label" htmlFor="jev-catalog-filter">Catalog filter</label><input id="jev-catalog-filter" placeholder="Optional keyword, e.g. payments" value={catalogTerm} onChange={e => setCatalogTerm(e.target.value)} disabled={busy || loading || techDocsBusy} /></>}
            {candidates.map((c, i) => <div className="jev-candidate" key={c.id}>
              <div className="jev-candidate-fields"><input aria-label={`Candidate ${i + 1} title`} value={c.title} maxLength={200} onChange={e => updateCandidate(i, 'title', e.target.value)} disabled={busy || techDocsBusy} /><textarea aria-label={`Candidate ${i + 1} description`} value={c.description} maxLength={1500} onChange={e => updateCandidate(i, 'description', e.target.value)} disabled={busy || techDocsBusy} /></div>
              <button className="jev-quiet" aria-label={`Remove candidate ${i + 1}`} disabled={busy || techDocsBusy} onClick={() => { clearResult(); setCandidates(candidates.filter((_, j) => i !== j)); }}>×</button>
            </div>)}
            <div className="jev-actions"><button className="jev-secondary" disabled={busy || loading || techDocsBusy || candidates.length >= 20} onClick={() => { clearResult(); setCandidates([...candidates, { id: crypto.randomUUID(), title: '', description: '' }]); }}>+ Add candidate</button>
              {loadCandidates && <button className="jev-secondary" disabled={busy || loading || techDocsBusy} onClick={fromCatalog}>{loading ? 'Loading…' : 'Load from catalog'}</button>}</div>
            {loadCandidates && <p className="jev-help">Loads up to 20 matching entries in catalog order. This evaluates only your shortlist, not the entire catalog.</p>}
          </div>}
          {(error || inputBlocked) && <div className="jev-error" role="alert">{error || (textTooLong ? 'Context exceeds the 16,000 character limit. Shorten it before evaluating.' : `Request exceeds the ${MAX_EVALUATION_BYTES.toLocaleString()} UTF-8 byte budget. Shorten the context or candidate descriptions; no text will be truncated.`)}</div>}
          <div className="jev-actions"><button className="jev-primary" disabled={busy || loading || techDocsBusy || inputBlocked} onClick={run}>{busy ? 'Evaluating…' : demo ? 'Show example result →' : 'Evaluate with Jev →'}</button><button className="jev-quiet" disabled={busy || loading || techDocsBusy} onClick={example}>Load example input</button></div>
          <div className="jev-help">{demo ? 'Fixtures stay in your browser.' : 'Evaluation sends this context and candidate descriptions to TypeSafe through your Backstage backend.'}</div>
        </div>
        <div aria-live="polite" aria-busy={busy}>
          {result ? <div className="jev-results">
            <div className="jev-result-header"><h2>{workflow === 'search' ? 'Ranked candidates' : 'Decision details'}</h2><span className="jev-pill">{result.mode === 'demo' ? 'ILLUSTRATIVE RESULT' : result.model}</span></div>
            {result.mode === 'demo' && !demo && <div className="jev-banner">Backend demo mode is enabled. These fixed results do not evaluate your input.</div>}
            {result.findings.map(f => <article className="jev-result" key={f.id}>
              <div className="jev-result-line"><h3>{f.title}</h3><span className={`jev-status jev-${f.status}`}>{f.status === 'pass' ? 'Clear signal' : f.status === 'attention' ? 'Check this' : 'Needs review'}</span></div>
              <p style={{ marginTop: 8 }}>{f.statement}</p>
              <div className="jev-value">{f.kind === 'noul' ? `${Math.round(Number(f.value) * 100)}%` : f.kind === 'score' ? `${Number(f.value).toFixed(2)} / 3` : f.value}</div>
              {f.kind !== 'choice' && <div className="jev-meter" aria-hidden="true"><span style={{ width: `${Number(f.value) * (f.kind === 'score' ? 100 / 3 : 100)}%` }} /></div>}
              <p>{f.kind === 'noul' ? 'Estimated probability that this statement is supported by the supplied context.' : `Model confidence: ${Math.round((f.confidence ?? 0) * 100)}%. Confidence is not a guarantee of correctness.`}</p>
              <p style={{ marginTop: 10 }}>{f.guidance}</p>
              {f.candidate?.entityRef && <p style={{ marginTop: 10 }}>{renderCandidateLink ? renderCandidateLink(f.candidate) : <>Catalog entity: <code>{f.candidate.entityRef}</code></>}</p>}
              {f.probabilities && <details><summary>Probability distribution</summary><dl>{Object.entries(f.probabilities).map(([key, value]) => <div key={key} style={{ display: 'contents' }}><dt>{f.levels?.[Number(key)] ?? (/^c\d+$/.test(key) ? candidates[Number(key.slice(1))]?.title : key) ?? key}</dt><dd>{(value * 100).toFixed(1)}%</dd></div>)}</dl></details>}
            </article>)}
            <div className="jev-footer">{new Date(result.evaluatedAt).toLocaleString()} · {result.needsReview ? 'Review the highlighted items with the responsible team.' : 'Verify recommendations against the original sources.'}<br />A negative finding means the supplied context did not establish the condition. It does not prove the condition is absent in the real service.</div>
          </div> : <div className="jev-empty">{busy ? 'Asking focused questions about your context…' : 'Your results will appear here, with uncertainty shown for each decision.'}</div>}
        </div>
      </section>
    </div>
  </main>;
}
