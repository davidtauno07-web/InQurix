import { useCallback, useEffect, useRef, useState } from 'react';
import { Snippet, describeLocation, type Loc } from './Snippet';
import logo from './assets/logo.png';

export interface Evidence { segmentId: number; location: Loc; snippet: string; method: string; confidence?: number | null }
export interface Result { docId: number; name: string; path: string; attachmentName?: string; kind: string; status: string; modifiedMs: number; reasons: string[]; evidence: Evidence[]; duplicates: string[]; ocr: boolean }
export interface SearchResponse { results: Result[]; tookMs: number; semantic: boolean }

const isMac = window.inqurix.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl';

export function useSearch() {
  const [query, setQuery] = useState('');
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResp(null); return; }
    const id = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await window.inqurix.invoke<SearchResponse>('search', { query: q, limit: 30 });
        if (id === seq.current) setResp(r);
      } finally { if (id === seq.current) setBusy(false); }
    }, 140);
    return () => clearTimeout(t);
  }, [query]);
  return { query, setQuery, resp, busy };
}

export function QuickSearch() {
  const { query, setQuery, resp, busy } = useSearch();
  const [sel, setSel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const results = resp?.results ?? [];

  useEffect(() => {
    input.current?.focus();
    return window.inqurix.on('quick:shown', () => { input.current?.focus(); input.current?.select(); setMsg(null); });
  }, []);
  useEffect(() => setSel(0), [resp]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const open = useCallback(async (r: Result | undefined, reveal: boolean) => {
    if (!r) return;
    const res = await window.inqurix.invoke<{ ok: boolean; error?: string }>(reveal ? 'doc:reveal' : 'doc:open', r.docId, query);
    if (res.ok) void window.inqurix.invoke('quick:hide');
    else setMsg(res.error ?? 'Could not open the file');
  }, [query]);

  const onKey = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); void window.inqurix.invoke('quick:hide'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); void open(results[sel], mod); }
    else if (e.key === 'Backspace' && mod) { e.preventDefault(); setQuery(''); }
  };

  return (
    <div className="quick" onKeyDown={onKey}>
      <div className="quick-bar">
        <img src={logo} alt="" className="quick-logo" />
        <input ref={input} aria-label="Search your documents" placeholder="Search inside your documents…" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-controls="quick-results" aria-activedescendant={results[sel] ? `qr-${sel}` : undefined} />
        {busy && <span className="spinner" aria-label="Searching" />}
      </div>
      {msg && <div className="quick-msg" role="alert">{msg}</div>}
      <ul ref={list} id="quick-results" className="quick-results" role="listbox" aria-label="Results">
        {results.map((r, i) => (
          <li key={r.docId} id={`qr-${i}`} data-i={i} role="option" aria-selected={i === sel} className={i === sel ? 'sel' : ''} onMouseMove={() => setSel(i)} onClick={() => void open(r, false)}>
            <div className="r-head"><span className={`kind k-${r.kind}`}>{r.kind.toUpperCase()}</span><span className="r-name">{r.attachmentName ? `${r.attachmentName} (in ${r.name})` : r.name}</span></div>
            {r.evidence[0] && <div className="r-snip"><Snippet text={r.evidence[0].snippet} /></div>}
            <div className="r-meta">{[r.evidence[0] && describeLocation(r.evidence[0].location), r.reasons[0]].filter(Boolean).join(' · ')}</div>
            <div className="r-path" title={r.path}>{r.path}{r.duplicates.length ? ` (+${r.duplicates.length} identical cop${r.duplicates.length > 1 ? 'ies' : 'y'})` : ''}</div>
          </li>
        ))}
        {query.trim() && resp && !results.length && <li className="empty">No matches in your indexed folders. Check Sources for files that could not be read.</li>}
        {!query.trim() && <li className="empty">Type words, an amount, an invoice number or a question. Enter opens · {MOD}+Enter shows in folder · Esc closes</li>}
      </ul>
      <div className="quick-foot">
        <span>{resp ? `${results.length} result${results.length === 1 ? '' : 's'} · ${resp.tookMs} ms${resp.semantic ? ' · meaning search on' : ''}` : 'Local search · nothing leaves this computer'}</span>
        <button type="button" onClick={() => void window.inqurix.invoke('workspace:open', query ? `search?q=${encodeURIComponent(query)}` : '')}>Open full workspace</button>
      </div>
    </div>
  );
}
