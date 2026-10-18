import { useCallback, useEffect, useState } from 'react';
import type { Finding, InvestigationType } from '@inqurix/core/finance-types';

const inv = window.inqurix.invoke;
interface TypeInfo { type: InvestigationType; title: string; objective: string; credits: number }
interface ListRow { id: number; type: string; title: string; status: string; created_at: string; completed_at: string | null; error: string | null; findings: number | null }
type ReviewStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved';
interface Stored {
  id: number; type: string; title: string; status: string; created_at: string; completed_at: string | null; error: string | null; params: { supplier?: string };
  result: null | { objective: string; scope: { records: number; documents: number; recordTypes: Record<string, number> }; findings: Finding[]; notes: string[]; totals?: { documentedOvercharge: number; potentialSaving: number; amountAtRisk: number; currency?: string; overlapAdjusted: boolean }; reviews: Record<string, { status: ReviewStatus; note?: string; at: string }> };
}

const fmt = (n: number, c?: string) => `${c === 'NAD' ? 'N$' : c ?? ''} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
const CLASS_LABEL: Record<string, string> = { direct_evidence: 'Direct evidence', inferred_relationship: 'Inferred relationship', potential_discrepancy: 'Potential discrepancy', unverified_indicator: 'Unverified indicator', missing_evidence: 'Missing evidence' };

export function Investigations({ initialType }: { initialType?: string }) {
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [list, setList] = useState<ListRow[]>([]);
  const [current, setCurrent] = useState<Stored | null>(null);
  const [supplier, setSupplier] = useState('');
  const [running, setRunning] = useState<string | null>(null);
  const refresh = useCallback(() => void inv<ListRow[]>('investigations:list').then(setList), []);
  const open = useCallback(async (id: number) => setCurrent(await inv<Stored>('investigations:get', id)), []);
  useEffect(() => { void inv<TypeInfo[]>('investigations:types').then(setTypes); refresh(); }, [refresh]);
  const run = async (t: string) => {
    setRunning(t);
    try { const id = await inv<number>('investigations:run', t, { supplier: supplier.trim() || undefined }); refresh(); await open(id); } finally { setRunning(null); }
  };
  return (
    <div className="investigations">
      <h1>Investigations</h1>
      <p className="hint">Investigations run only when you start them, on the documents in your authorised folders, entirely on this computer. Findings are evidence to review — not conclusions.</p>
      <div className="inv-scope"><label>Limit to supplier (optional) <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Kavango" /></label></div>
      <ul className="inv-types">
        {types.map((t) => (
          <li key={t.type} className={initialType === t.type ? 'suggested' : undefined}>
            <strong>{t.title}</strong><span>{t.objective}</span>
            <button type="button" className={initialType === t.type ? 'primary' : undefined} disabled={!!running} onClick={() => void run(t.type)}>{running === t.type ? 'Running…' : 'Run'}</button>
          </li>
        ))}
      </ul>
      <div className="split">
        <section aria-label="Previous investigations" className="inv-list">
          <h2>History</h2>
          {!list.length && <p className="empty">No investigations yet.</p>}
          <ul>{list.map((r) => (
            <li key={r.id}><button type="button" className={current?.id === r.id ? 'res sel' : 'res'} onClick={() => void open(r.id)}><span className="r-name">{r.title}</span><span className="r-meta">{r.created_at.slice(0, 16).replace('T', ' ')} · {r.status === 'completed' ? `${r.findings ?? 0} findings` : r.status}</span></button></li>
          ))}</ul>
        </section>
        {current && <InvestigationView key={current.id} inv={current} reload={() => void open(current.id)} onDelete={async () => { await inv('investigations:delete', current.id); setCurrent(null); refresh(); }} />}
      </div>
    </div>
  );
}

function InvestigationView({ inv: s, reload, onDelete }: { inv: Stored; reload: () => void; onDelete: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  if (s.status === 'failed') return <section className="doc-panel"><h2>{s.title}</h2><div className="banner warn" role="alert">The investigation failed: {s.error}</div></section>;
  const r = s.result;
  if (!r) return <section className="doc-panel">Running…</section>;
  const exp = async (f: 'md' | 'json' | 'csv') => { const x = await inv<{ ok: boolean; path?: string; error?: string; canceled?: boolean }>('investigations:export', s.id, f); setMsg(x.ok ? `Saved to ${x.path}` : x.canceled ? null : x.error ?? 'Export failed'); };
  return (
    <section className="doc-panel inv-view" aria-label="Investigation">
      <h2>{s.title}</h2>
      <p><strong>Objective:</strong> {r.objective}</p>
      <p className="hint">Scope: {r.scope.records} structured records in {r.scope.documents} documents ({Object.entries(r.scope.recordTypes).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') || 'none'}).</p>
      {r.notes.slice(1).map((n) => <div key={n} className="banner info">{n}</div>)}
      {r.totals && (
        <div className="inv-totals">
          {r.totals.documentedOvercharge > 0 && <div><span>Documented overcharge</span><strong>{fmt(r.totals.documentedOvercharge, r.totals.currency)}</strong></div>}
          {r.totals.potentialSaving > 0 && <div><span>Potential saving</span><strong>{fmt(r.totals.potentialSaving, r.totals.currency)}</strong></div>}
          {r.totals.amountAtRisk > 0 && <div><span>Amount requiring verification</span><strong>{fmt(r.totals.amountAtRisk, r.totals.currency)}</strong></div>}
          {r.totals.overlapAdjusted && <p className="hint">Overlapping findings are counted once.</p>}
        </div>
      )}
      <div className="actions">
        <button type="button" onClick={() => void exp('md')}>Export report (Markdown)</button>
        <button type="button" onClick={() => void exp('csv')}>Export CSV</button>
        <button type="button" onClick={() => void exp('json')}>Export JSON</button>
        <button type="button" className="danger" onClick={onDelete}>Delete</button>
      </div>
      {msg && <div className="banner info" role="status">{msg}</div>}
      {!r.findings.length && <p className="empty">Nothing found in the indexed documents for this investigation. That does not prove there is nothing to find outside the authorised folders.</p>}
      <ol className="findings">{r.findings.map((f) => <FindingCard key={f.id} f={f} invId={s.id} review={r.reviews[f.id]} reload={reload} />)}</ol>
    </section>
  );
}

function FindingCard({ f, invId, review, reload }: { f: Finding; invId: number; review?: { status: ReviewStatus; note?: string }; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(review?.note ?? '');
  const [reminded, setReminded] = useState(false);
  const status = review?.status ?? 'open';
  const set = async (st: ReviewStatus) => { await inv('investigations:review', invId, f.id, st, note); reload(); };
  const docs = [...new Map(f.evidence.map((e) => [e.documentId, e.documentName])).entries()];
  const list = (t: string, xs: string[]) => (xs.length ? <><h4>{t}</h4><ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul></> : null);
  return (
    <li className={`finding st-${status}`}>
      <button type="button" className="f-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`badge c-${f.classification}`}>{f.label}</span>
        <span className="f-title">{f.title}</span>
        <span className="r-meta">{CLASS_LABEL[f.classification]} · {f.strength} evidence{f.amount ? ` · ${fmt(f.amount.value, f.amount.currency)}` : ''}{status !== 'open' ? ` · ${status}` : ''}</span>
      </button>
      <p>{f.summary}</p>
      {open && (
        <div className="f-body">
          {f.comparisons.length > 0 && (
            <table className="tbl cmp"><thead><tr><th>Attribute</th><th>Values</th><th>Result</th></tr></thead>
              <tbody>{f.comparisons.map((c, i) => <tr key={i} className={`o-${c.outcome}`}><td>{c.attribute}</td><td>{c.values.map((v) => v.value ?? '—').join(' │ ')}</td><td>{c.outcome}{c.note ? ` — ${c.note}` : ''}</td></tr>)}</tbody></table>
          )}
          {f.calculations.length > 0 && <><h4>Calculations</h4><ul>{f.calculations.map((c, i) => <li key={i}>{c.description}: <code>{c.expression}</code> = <strong>{fmt(c.result, c.currency)}</strong></li>)}</ul></>}
          {list('Unresolved questions', f.unresolved)}
          {list('Assumptions', f.assumptions)}
          {list('Limitations', f.limitations)}
          {list('How to verify', f.verification)}
          <h4>Evidence</h4>
          <ul className="evidence">{f.evidence.map((e, i) => <li key={i}><span className="loc">{e.documentName}{e.field ? ` · ${e.field}` : ''}{e.originalValue ? `: ${e.originalValue}` : ''}</span>{e.excerpt && <span className="excerpt">{e.excerpt.slice(0, 240)}</span>}</li>)}</ul>
          <div className="actions">{docs.map(([id, name]) => <button key={id} type="button" onClick={() => void inv('doc:open', Number(id))}>Open {name}</button>)}</div>
          {f.obligation && <button type="button" disabled={reminded} onClick={async () => { await inv('reminders:add', { docId: f.docIds[0], title: f.title, dueDate: f.obligation!.date, basis: f.obligation!.basis, evidence: f.summary }); setReminded(true); }}>{reminded ? 'Reminder added' : 'Remind me'}</button>}
          <label className="f-note">Reviewer note <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></label>
          <div className="actions" role="group" aria-label="Review">
            <button type="button" onClick={() => void set('confirmed')}>Confirmed issue</button>
            <button type="button" onClick={() => void set('dismissed')}>Not an issue</button>
            <button type="button" onClick={() => void set('resolved')}>Resolved</button>
            {status !== 'open' && <button type="button" onClick={() => void set('open')}>Reopen</button>}
          </div>
        </div>
      )}
    </li>
  );
}
