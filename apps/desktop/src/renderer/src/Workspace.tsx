import { useCallback, useEffect, useState } from 'react';
import { Snippet, describeLocation, type Loc } from './Snippet';
import { useSearch, type Result } from './QuickSearch';
import logo from './assets/logo.png';
import { Investigations } from './Investigations';

const inv = window.inqurix.invoke;
const isMac = window.inqurix.platform === 'darwin';
type Page = 'search' | 'investigations' | 'sources' | 'library' | 'settings' | 'onboarding';
interface Source { id: number; path: string; name: string; enabled: number; include_hidden: number; docs: number; failed: number; exclusions: string | null; last_scan_at?: string | null }
interface Progress { sourceId: number; phase: string; discovered: number; processed: number; indexed: number; failed: number; current?: string }
interface IdxState { paused: boolean; busy: boolean; queue: number }
interface Settings { shortcut: string; launchAtLogin: boolean; ocr: boolean; semantic: boolean; reconcileMinutes: number; onboarded: boolean; keepHistory: boolean; theme: string; reminders: boolean }

function useIndexing() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [state, setState] = useState<IdxState>({ paused: false, busy: false, queue: 0 });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const a = window.inqurix.on('index:progress', (p) => setProgress(p as Progress));
    const b = window.inqurix.on('index:state', (s) => setState(s as IdxState));
    let t: ReturnType<typeof setTimeout> | undefined;
    const c = window.inqurix.on('index:changed', () => { clearTimeout(t); t = setTimeout(() => setTick((x) => x + 1), 400); });
    return () => { a(); b(); c(); clearTimeout(t); };
  }, []);
  return { progress, state, tick };
}

export function Workspace({ route }: { route: string }) {
  const [base, qs] = route.split('?');
  const [page, setPage] = useState<Page>((base as Page) || 'search');
  const initialQ = new URLSearchParams(qs ?? '').get('q') ?? '';
  const [invType, setInvType] = useState<string | undefined>(new URLSearchParams(qs ?? '').get('type') ?? undefined);
  const idx = useIndexing();
  const [shortcutErr, setShortcutErr] = useState<string | null>(null);
  useEffect(() => { setPage((base as Page) || 'search'); }, [route, base]);
  const go = (p: Page) => { setPage(p); if (window.location.hash !== `#workspace/${p}`) window.location.hash = `workspace/${p}`; };
  useEffect(() => window.inqurix.on('shortcut:error', (m) => setShortcutErr(String(m))), []);

  if (page === 'onboarding') return <Onboarding done={() => setPage('search')} idx={idx} />;
  const nav: [Page, string][] = [['search', 'Search'], ['investigations', 'Investigations'], ['library', 'History & saved'], ['sources', 'Sources & indexing'], ['settings', 'Settings']];
  return (
    <div className="ws">
      <aside className="ws-nav">
        <div className="brand"><img src={logo} alt="" /><span>InQurix</span></div>
        <nav aria-label="Main">{nav.map(([p, l]) => <button key={p} type="button" className={page === p ? 'active' : ''} aria-current={page === p ? 'page' : undefined} onClick={() => { go(p); if (p !== 'investigations') setInvType(undefined); }}>{l}</button>)}</nav>
        <IndexBadge {...idx} />
      </aside>
      <main className="ws-main">
        {shortcutErr && <div className="banner warn" role="alert">{shortcutErr} <button type="button" onClick={() => go('settings')}>Change</button></div>}
        {page === 'search' && <SearchPage initialQ={initialQ} investigate={(t) => { setInvType(t); go('investigations'); }} />}
        {page === 'investigations' && <Investigations initialType={invType} />}
        {page === 'library' && <Library />}
        {page === 'sources' && <Sources idx={idx} />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

function IndexBadge({ progress, state }: ReturnType<typeof useIndexing>) {
  const label = state.paused ? 'Indexing paused' : state.busy ? (progress && progress.phase !== 'done' ? `Indexing ${progress.processed}/${progress.discovered || '…'}` : 'Indexing…') : 'Index up to date';
  return (
    <div className="idx-badge" aria-live="polite">
      <span className={`dot ${state.paused ? 'paused' : state.busy ? 'busy' : 'ok'}`} />{label}
      <button type="button" onClick={() => void inv(state.paused ? 'index:resume' : 'index:pause')}>{state.paused ? 'Resume' : 'Pause'}</button>
    </div>
  );
}

function SearchPage({ initialQ, investigate }: { initialQ: string; investigate: (type: string) => void }) {
  const { query, setQuery, resp, busy } = useSearch();
  const [suggest, setSuggest] = useState<{ type: string; title: string } | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const type = query.trim() ? await inv<string | null>('investigations:suggest', query) : null;
      const types = type ? await inv<{ type: string; title: string }[]>('investigations:types') : [];
      if (live) setSuggest(type ? types.find((x) => x.type === type) ?? null : null);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);
  const [selected, setSelected] = useState<Result | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (initialQ) setQuery(initialQ); }, [initialQ, setQuery]);
  useEffect(() => { setSelected(resp?.results[0] ?? null); setSaved(false); }, [resp]);
  return (
    <div className="search-page">
      <div className="search-row">
        <input autoFocus aria-label="Search" placeholder="Search words, amounts, invoice numbers, people, or describe what you need…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" disabled={!query.trim() || saved} onClick={async () => { await inv('saved:add', query.trim(), query.trim()); setSaved(true); }}>{saved ? 'Saved' : 'Save search'}</button>
      </div>
      <p className="hint">Filters: <code>type:pdf</code> <code>after:2026-01-01</code> <code>before:2026-06-30</code> <code>in:Finance</code> · quotes for exact phrases{busy ? ' · searching…' : resp ? ` · ${resp.results.length} results in ${resp.tookMs} ms` : ''}</p>
      {suggest && <div className="banner info" role="status">This looks like an analysis question. Search results below show matching documents; the <strong>{suggest.title}</strong> investigation compares records across all of them. <button type="button" className="primary" onClick={() => investigate(suggest.type)}>Open investigation</button></div>}
      <div className="split">
        <ul className="results" aria-label="Results">
          {resp?.results.map((r) => (
            <li key={r.docId}>
              <button type="button" className={selected?.docId === r.docId ? 'res sel' : 'res'} onClick={() => setSelected(r)}>
                <div className="r-head"><span className={`kind k-${r.kind}`}>{r.kind.toUpperCase()}</span><span className="r-name">{r.attachmentName ? `${r.attachmentName} (in ${r.name})` : r.name}</span></div>
                {r.evidence[0] && <div className="r-snip"><Snippet text={r.evidence[0].snippet} /></div>}
                <div className="r-meta">{r.reasons.join(' · ')}</div>
              </button>
            </li>
          ))}
          {resp && !resp.results.length && <li className="empty">No matches. Try fewer words, check spelling, or add the folder that holds the file under Sources.</li>}
        </ul>
        {selected && <DocPanel key={selected.docId} result={selected} query={query} />}
      </div>
    </div>
  );
}

interface DocDetail { doc: { id: number; name: string; path: string; kind: string; status: string; status_detail: string | null; size: number; mtime_ms: number; source_name: string; title: string | null; warnings: string | null }; segments: { id: number; ordinal: number; text: string; location: string; method: string; confidence: number | null }[]; entities: { type: string; original: string }[]; records: { doc_type: string; data: string }[]; children: { id: number; name: string; status: string }[]; pinned: boolean }

function DocPanel({ result, query }: { result: Result; query: string }) {
  const [d, setD] = useState<DocDetail | null>(null);
  const [related, setRelated] = useState<{ id: number; name: string; types: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [focusSeg, setFocusSeg] = useState<number | null>(result.evidence[0]?.segmentId ?? null);
  useEffect(() => {
    void inv<DocDetail>('doc:get', result.docId).then(setD);
    void inv<{ id: number; name: string; types: string }[]>('doc:related', result.docId).then(setRelated);
  }, [result]);
  useEffect(() => { if (focusSeg) document.getElementById(`seg-${focusSeg}`)?.scrollIntoView({ block: 'center' }); }, [focusSeg, d]);
  const act = useCallback(async (ch: 'doc:open' | 'doc:reveal') => { const r = await inv<{ ok: boolean; error?: string }>(ch, result.docId, query); setErr(r.ok ? null : r.error ?? 'Failed'); }, [result.docId, query]);
  if (!d) return <section className="doc-panel">Loading…</section>;
  const rec = d.records[0] ? (JSON.parse(d.records[0].data) as Record<string, unknown>) : null;
  const warnings = d.doc.warnings ? (JSON.parse(d.doc.warnings) as string[]) : [];
  return (
    <section className="doc-panel" aria-label="Document evidence">
      <h2>{d.doc.name}</h2>
      <p className="path">{d.doc.path}</p>
      <div className="actions">
        <button type="button" onClick={() => void act('doc:open')}>Open original</button>
        <button type="button" onClick={() => void act('doc:reveal')}>{isMac ? 'Show in Finder' : 'Show in folder'}</button>
        <button type="button" onClick={async () => { const p = await inv<boolean>('pins:toggle', d.doc.id); setD({ ...d, pinned: p }); }}>{d.pinned ? 'Unpin' : 'Pin'}</button>
      </div>
      {err && <div className="banner warn" role="alert">{err}</div>}
      {warnings.map((w) => <div key={w} className="banner info">{w}</div>)}
      <h3>Why this matched</h3>
      <ul className="reasons">{result.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <h3>Evidence</h3>
      <ul className="evidence">{result.evidence.map((e) => (
        <li key={e.segmentId}><button type="button" onClick={() => setFocusSeg(e.segmentId)}><span className="loc">{describeLocation(e.location) || 'document'}{e.method === 'ocr' ? ` · OCR ${e.confidence != null ? Math.round(e.confidence * 100) + '%' : ''}` : ''}</span><Snippet text={e.snippet} /></button></li>
      ))}</ul>
      {rec && <><h3>Extracted fields ({String(rec.docType).replace('_', ' ')})</h3><dl className="fields">{['number', 'supplier', 'date', 'dueDate', 'total', 'currency', 'poReference', 'invoiceReference'].filter((k) => rec[k] !== undefined).map((k) => <div key={k}><dt>{k}</dt><dd>{String(rec[k])}</dd></div>)}</dl><p className="hint">Extracted automatically. Check against the original before relying on it.</p></>}
      {related.length > 0 && <><h3>Related documents</h3><ul className="related">{related.map((r) => <li key={r.id}>{r.name} <span className="hint">shares {r.types.replace(/_/g, ' ')}</span></li>)}</ul></>}
      {d.children.length > 0 && <><h3>Attachments</h3><ul>{d.children.map((c) => <li key={c.id}>{c.name} <span className="hint">{c.status}</span></li>)}</ul></>}
      <h3>Content preview</h3>
      <div className="preview">{d.segments.map((s) => (
        <div key={s.id} id={`seg-${s.id}`} className={s.id === focusSeg ? 'seg focus' : 'seg'}><span className="loc">{describeLocation(JSON.parse(s.location) as Loc)}</span><pre>{s.text}</pre></div>
      ))}</div>
    </section>
  );
}

function Library() {
  const [h, setH] = useState<{ id: number; query: string; at: string; result_count: number }[]>([]);
  const [s, setS] = useState<{ id: number; name: string; query: string }[]>([]);
  const [p, setP] = useState<{ id: number; name: string; path: string }[]>([]);
  const [r, setR] = useState<{ id: number; name: string; path: string; at: string }[]>([]);
  const load = useCallback(() => { void inv<typeof h>('history:list').then(setH); void inv<typeof s>('saved:list').then(setS); void inv<typeof p>('pins:list').then(setP); void inv<typeof r>('recent:list').then(setR); }, []);
  useEffect(load, [load]);
  const go = (q: string) => { window.location.hash = `workspace/search?q=${encodeURIComponent(q)}`; };
  return (
    <div className="library">
      <section><h2>Saved searches</h2><ul>{s.map((x) => <li key={x.id}><button type="button" className="link" onClick={() => go(x.query)}>{x.name}</button> <button type="button" className="small" onClick={async () => { await inv('saved:remove', x.id); load(); }}>Remove</button></li>)}{!s.length && <li className="empty">None yet</li>}</ul></section>
      <section><h2>Pinned documents</h2><ul>{p.map((x) => <li key={x.id}><button type="button" className="link" onClick={() => void inv('doc:open', x.id)}>{x.name}</button> <span className="hint">{x.path}</span></li>)}{!p.length && <li className="empty">None yet</li>}</ul></section>
      <section><h2>Recently opened</h2><ul>{r.map((x) => <li key={x.id}><button type="button" className="link" onClick={() => void inv('doc:open', x.id)}>{x.name}</button> <span className="hint">{new Date(x.at).toLocaleString()}</span></li>)}{!r.length && <li className="empty">None yet</li>}</ul></section>
      <section><h2>Search history</h2><button type="button" className="small" onClick={async () => { await inv('history:clear'); load(); }}>Clear history</button><ul>{h.map((x) => <li key={x.id}><button type="button" className="link" onClick={() => go(x.query)}>{x.query}</button> <span className="hint">{x.result_count} results · {new Date(x.at).toLocaleString()}</span></li>)}{!h.length && <li className="empty">No searches yet</li>}</ul></section>
    </div>
  );
}

function Sources({ idx }: { idx: ReturnType<typeof useIndexing> }) {
  const [list, setList] = useState<Source[]>([]);
  const [fails, setFails] = useState<{ id: number; name: string; path: string; status: string; status_detail: string | null }[]>([]);
  const [status, setStatus] = useState<{ counts: { status: string; n: number }[]; segments: number; embeddings: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { void inv<Source[]>('sources:list').then(setList); void inv<typeof fails>('index:failures').then(setFails); void inv<typeof status>('index:status').then(setStatus); }, []);
  useEffect(load, [load, idx.tick]);
  const add = async () => { const r = await inv<{ id?: number; error?: string } | null>('sources:add'); if (r?.error) setErr(r.error); else { setErr(null); load(); } };
  return (
    <div className="sources">
      <div className="row"><h2>Authorised folders</h2><button type="button" onClick={() => void add()}>Add folder…</button><button type="button" onClick={() => void inv('sources:rescan')}>Rescan all</button></div>
      <p className="hint">InQurix only reads folders you add here. Files stay where they are; the index is stored on this computer.</p>
      {err && <div className="banner warn" role="alert">{err}</div>}
      {idx.progress && idx.state.busy && <div className="progress" role="status">Scanning: {idx.progress.processed} of {idx.progress.discovered} files · {idx.progress.indexed} indexed · {idx.progress.failed} failed{idx.progress.current ? ` · ${idx.progress.current}` : ''}<progress max={idx.progress.discovered || 1} value={idx.progress.processed} /></div>}
      <table className="tbl"><thead><tr><th>Folder</th><th>Documents</th><th>Problems</th><th>Enabled</th><th>Hidden files</th><th>Exclusions</th><th /></tr></thead><tbody>
        {list.map((s) => (
          <tr key={s.id}>
            <td title={s.path}><strong>{s.name}</strong><div className="hint">{s.path}</div></td><td>{s.docs}</td><td>{s.failed}</td>
            <td><input type="checkbox" aria-label={`Enable ${s.name}`} checked={!!s.enabled} onChange={async (e) => { await inv('sources:update', s.id, { enabled: e.target.checked }); load(); }} /></td>
            <td><input type="checkbox" aria-label={`Include hidden files in ${s.name}`} checked={!!s.include_hidden} onChange={async (e) => { await inv('sources:update', s.id, { include_hidden: e.target.checked }); load(); }} /></td>
            <td><textarea aria-label={`Exclusions for ${s.name}`} defaultValue={s.exclusions ?? ''} placeholder={'Private/**\n*.tmp'} onBlur={(e) => void inv('exclusions:set', s.id, e.target.value.split('\n'))} /></td>
            <td><button type="button" className="small" onClick={() => void inv('sources:rescan', s.id)}>Rescan</button> <button type="button" className="small danger" onClick={async () => { if (confirm(`Stop indexing ${s.path} and remove its entries from the index? Your files are not touched.`)) { await inv('sources:remove', s.id); setTimeout(load, 300); } }}>Remove</button></td>
          </tr>
        ))}
        {!list.length && <tr><td colSpan={7} className="empty">No folders yet. Add one to start indexing.</td></tr>}
      </tbody></table>
      {status && <p className="hint">Index: {status.counts.map((c) => `${c.n} ${c.status}`).join(' · ') || 'empty'} · {status.segments} passages · {status.embeddings} meaning vectors</p>}
      <h2>Files needing attention</h2>
      <table className="tbl"><thead><tr><th>File</th><th>Status</th><th>Detail</th></tr></thead><tbody>
        {fails.map((f) => <tr key={f.id}><td title={f.path}>{f.name}</td><td><span className={`st st-${f.status}`}>{f.status.replace('_', ' ')}</span></td><td>{f.status_detail}</td></tr>)}
        {!fails.length && <tr><td colSpan={3} className="empty">Nothing to fix.</td></tr>}
      </tbody></table>
    </div>
  );
}

function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [info, setInfo] = useState<{ version: string; userData: string } | null>(null);
  const [recording, setRecording] = useState(false);
  useEffect(() => { void inv<Settings>('settings:get').then(setS); void inv<typeof info>('app:info').then(setInfo); }, []);
  if (!s) return null;
  const upd = async (patch: Partial<Settings>) => setS(await inv<Settings>('settings:update', patch));
  const onShortcutKey = (e: React.KeyboardEvent) => {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.metaKey && 'Command', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    if (!mods.length) return;
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    setRecording(false);
    void upd({ shortcut: [...mods, key].join('+') });
  };
  const Toggle = ({ k, label, hint }: { k: keyof Settings; label: string; hint: string }) => (
    <label className="setting"><input type="checkbox" checked={!!s[k]} onChange={(e) => void upd({ [k]: e.target.checked })} /><span><strong>{label}</strong><span className="hint">{hint}</span></span></label>
  );
  return (
    <div className="settings">
      <h2>Settings</h2>
      <div className="setting"><span><strong>Quick Search shortcut</strong><span className="hint">Opens the search panel from any application.</span></span>
        {recording ? <input autoFocus aria-label="Press the new shortcut" className="shortcut-rec" placeholder="Press keys…" onKeyDown={onShortcutKey} onBlur={() => setRecording(false)} readOnly /> : <button type="button" onClick={() => setRecording(true)}><kbd>{s.shortcut}</kbd> Change</button>}
      </div>
      <Toggle k="launchAtLogin" label="Start InQurix when I sign in" hint="Keeps the shortcut available and the index current." />
      <Toggle k="ocr" label="Read scanned documents and images (OCR)" hint="Runs locally. Uses more CPU while indexing." />
      <Toggle k="semantic" label="Search by meaning" hint="Uses a small model on this computer; queries are never sent online." />
      <Toggle k="keepHistory" label="Keep search history" hint="Stored only in the local index." />
      <label className="setting"><span><strong>Full check for changes every</strong><span className="hint">File changes are picked up immediately; this catches anything missed while closed.</span></span>
        <select value={s.reconcileMinutes} onChange={(e) => void upd({ reconcileMinutes: Number(e.target.value) })}>{[15, 30, 60, 240, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}</select>
      </label>
      <section aria-label="About InQurix"><h2>About InQurix</h2><p><strong>The Local Intelligence and Analysis Engine</strong>. Discover. Connect. Analyze. Understand.</p>{info && <p className="hint">Version {info.version} · Index location: {info.userData}</p>}</section>
    </div>
  );
}

function Onboarding({ done, idx }: { done: () => void; idx: ReturnType<typeof useIndexing> }) {
  const [step, setStep] = useState(0);
  const [sources, setSources] = useState<Source[]>([]);
  const [shortcut, setShortcut] = useState('');
  const load = useCallback(() => void inv<Source[]>('sources:list').then(setSources), []);
  useEffect(() => { load(); void inv<Settings>('settings:get').then((s) => setShortcut(s.shortcut)); }, [load, idx.tick]);
  const finish = async () => { await inv('settings:update', { onboarded: true }); window.location.hash = 'workspace/search'; done(); };
  return (
    <div className="onboarding">
      <img src={logo} alt="InQurix" className="ob-logo" />
      {step === 0 && <><h1>InQurix — The Local Intelligence and Analysis Engine</h1><p className="tagline">Discover. Connect. Analyze. Understand.</p><p>InQurix reads the documents in folders you choose so you can search inside them, connect related records and analyse them: words, amounts, invoice numbers, people and meaning. Everything is processed on this computer, and search keeps working offline once its local components are installed.</p><button type="button" className="primary" onClick={() => setStep(1)}>Get started</button></>}
      {step === 1 && <><h1>Choose folders to search</h1><p>InQurix never scans your whole computer. Add the folders that hold your documents. You can change this later.</p>
        <ul className="ob-sources">{sources.map((s) => <li key={s.id}>{s.path} <span className="hint">{s.docs} documents</span></li>)}</ul>
        <button type="button" onClick={async () => { await inv('sources:add'); load(); }}>Add folder…</button>
        {idx.state.busy && idx.progress && <p role="status">Indexing {idx.progress.processed} of {idx.progress.discovered} files…</p>}
        <div className="row"><button type="button" onClick={() => setStep(2)}>{sources.length ? 'Continue' : 'Skip for now'}</button></div></>}
      {step === 2 && <><h1>Search from anywhere</h1><p>Press <kbd>{shortcut}</kbd> in any application to open Quick Search. Type, use the arrow keys, and press Enter to open the original file{isMac ? ', or ⌘+Enter to show it in Finder' : ', or Ctrl+Enter to show it in its folder'}. Esc closes it. Indexing continues in the background.</p><button type="button" className="primary" onClick={() => void finish()}>Start searching</button></>}
    </div>
  );
}
