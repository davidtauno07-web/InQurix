import { foldForSearch } from '../normalize.js';
import type { FinDocument, Finding, FinRecord } from './types.js';
import { blankFinding, evidenceFor, label, money, sameSupplier, withDocs } from './util.js';

interface Sighting { account: string; record?: FinRecord; doc?: FinDocument; date?: string; role: 'invoice' | 'payment' | 'instruction' | 'other' }

const ACCOUNT_IN_TEXT = /(?:account(?:\s+(?:number|no\.?))?|acc(?:ount)?\s*no\.?|a\/c)\s*[:#]?\s*(\d[\d\s-]{6,20}\d)/gi;
const HOLDER_IN_TEXT = /account\s+(?:holder|name)\s*[:#]?\s*([^\n,;]{3,60})/i;

export function accountsInText(text: string): string[] {
  return [...new Set([...text.matchAll(ACCOUNT_IN_TEXT)].map((m) => m[1].replace(/[\s-]/g, '')))];
}

/** Change of supplier bank details over time, from invoices, payments and correspondence. */
export function findBankDetailChanges(records: FinRecord[], documents: FinDocument[] = []): Finding[] {
  const bySupplier = new Map<string, { name: string; sightings: Sighting[] }>();
  const add = (key: string, name: string, s: Sighting) => {
    const e = bySupplier.get(key) ?? { name, sightings: [] };
    e.sightings.push(s);
    bySupplier.set(key, e);
  };
  for (const r of records) {
    const acct = r.bank?.accountNumber;
    if (!acct || !r.supplierNormalized) continue;
    add(r.supplierNormalized, r.supplier ?? r.supplierNormalized, { account: acct, record: r, date: r.date, role: r.docType === 'invoice' ? 'invoice' : r.docType === 'payment' || r.docType === 'bank_statement' ? 'payment' : 'other' });
  }
  const suppliers = [...bySupplier.keys()];
  for (const d of documents) {
    const text = d.segments.map((s) => s.text).join('\n');
    const accts = accountsInText(text);
    if (!accts.length) continue;
    const folded = foldForSearch(text);
    const sup = suppliers.find((k) => folded.includes(k) || folded.includes(k.split(' ')[0]));
    if (!sup) continue;
    if (records.some((r) => r.docId === d.docId && r.supplierNormalized && r.bank?.accountNumber && accts.includes(r.bank.accountNumber))) continue;
    for (const a of accts) add(sup, bySupplier.get(sup)!.name, { account: a, doc: d, date: d.email?.date?.slice(0, 10), role: 'instruction' });
  }
  const out: Finding[] = [];
  for (const [key, { name, sightings }] of bySupplier) {
    const accounts = [...new Set(sightings.map((s) => s.account))];
    if (accounts.length < 2) continue;
    const ordered = [...sightings].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
    const firstSeen = new Map<string, Sighting>();
    for (const s of ordered) if (!firstSeen.has(s.account)) firstSeen.set(s.account, s);
    const [original, ...changed] = [...firstSeen.values()];
    const count = (a: string) => sightings.filter((s) => s.account === a).length;
    const docName = (s: Sighting) => s.record?.docName ?? s.doc?.name ?? '';
    const paidTo = (a: string) => sightings.filter((s) => s.account === a && s.role === 'payment');
    const f = blankFinding({
      id: `bank-${key}`,
      investigation: 'bank_details',
      kind: 'bank_detail_change',
      label: 'Supplier details require verification',
      title: `${name}: ${accounts.length} different bank accounts`,
      summary: `Earliest account ${original.account} (${docName(original)}, ${original.date ?? 'undated'}). ${changed.map((c) => `Account ${c.account} first appears in ${docName(c)} (${c.date ?? 'undated'})`).join('. ')}.`,
      classification: 'unverified_indicator',
      strength: changed.some((c) => c.role === 'instruction') ? 'moderate' : 'weak',
      comparisons: [{ attribute: 'Bank account', values: [...firstSeen.values()].map((s) => ({ recordId: s.record?.id ?? -1, docId: s.record?.docId ?? s.doc!.docId, value: `${s.account} — seen ${count(s.account)}×, first ${s.date ?? 'undated'}` })), outcome: 'different' }],
      evidence: [...firstSeen.values()].map((s) => (s.record ? evidenceFor(s.record, 'bank', s.account) : { documentId: String(s.doc!.docId), documentName: s.doc!.name, excerpt: s.doc!.segments.find((x) => x.text.replace(/[\s-]/g, '').includes(s.account))?.text.slice(0, 300), field: 'bank account', originalValue: s.account })),
      limitations: ['Suppliers do change banks legitimately. This finding only shows that more than one account appears in your documents.'],
      verification: [`Call ${name} on a phone number from an earlier, trusted document or your supplier master file — not a number in the message that announced the change — and confirm the account.`, 'Check who approved the change in your supplier master data.'],
    });
    for (const c of changed) {
      const p = paidTo(c.account);
      if (p.length) {
        f.unresolved.push(`${p.length} payment${p.length > 1 ? 's' : ''} went to the new account ${c.account}: ${p.map((x) => `${x.record!.number ?? ''} ${money(x.record!.total, x.record!.currency)} on ${x.date ?? '?'}`).join('; ')}.`);
        f.amount = { value: p.reduce((s, x) => s + (x.record!.total ?? 0), 0), currency: p[0].record!.currency, nature: 'amount_at_risk' };
      }
      const holder = c.record?.bank?.accountHolder ?? c.doc?.segments.map((s) => s.text.match(HOLDER_IN_TEXT)?.[1]).find(Boolean)?.trim();
      if (holder && sameSupplier(foldForSearch(holder), key) === 'different') f.unresolved.push(`The account holder for ${c.account} is “${holder}”, which is not the supplier’s name.`);
    }
    withDocs(f, sightings.flatMap((s) => (s.record ? [s.record] : [])));
    f.docIds = [...new Set([...f.docIds, ...sightings.flatMap((s) => (s.doc ? [s.doc.docId] : []))])];
    out.push(f);
  }
  return out;
}

const URGENCY = [/\burgent(?:ly)?\b/i, /\bimmediately\b/i, /\btoday\b/i, /\bwithin (?:24|48) hours\b/i, /\bas soon as possible\b/i, /\boverdue\b.*\bsuspend/i];
const SECRECY = [/\bconfidential\b/i, /do not (?:call|phone|contact)/i, /\bkeep this (?:between us|private)\b/i, /\bonly (?:reply|respond) (?:to|by) (?:this )?e-?mail\b/i];
const CHANGE = [/\b(?:new|changed?|updated?)\s+(?:bank(?:ing)?\s+)?(?:details|account)/i, /\bbank(?:ing)? details (?:have )?changed\b/i, /\bplease (?:use|pay (?:in)?to) (?:the|our) new\b/i];

const deleet = (s: string) => s.toLowerCase().replace(/1/g, 'l').replace(/0/g, 'o').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/5/g, 's');
const supplierKey = (name: string) => name.toLowerCase().replace(/\((pty)\)|\b(ltd|limited|cc|inc|llc|pty)\b\.?/g, '').replace(/[^a-z]/g, '');
const domainOf = (email?: string) => email?.toLowerCase().match(/@([a-z0-9.-]+)/)?.[1];
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Potential impersonation / scam indicators in correspondence. Indicators only — never a conclusion. */
export function findScamIndicators(records: FinRecord[], documents: FinDocument[] = []): Finding[] {
  const knownDomains = new Map<string, Set<number>>();
  for (const r of records) {
    const d = domainOf(r.contact?.email);
    if (d) knownDomains.set(d, new Set([...(knownDomains.get(d) ?? []), r.docId]));
  }
  for (const doc of documents) {
    if (doc.email) continue;
    for (const s of doc.segments) for (const m of s.text.matchAll(EMAIL_RE)) {
      const d = domainOf(m[0])!;
      knownDomains.set(d, new Set([...(knownDomains.get(d) ?? []), doc.docId]));
    }
  }
  const bankFindings = findBankDetailChanges(records, documents);
  const out: Finding[] = [];
  for (const doc of documents) {
    if (doc.parentId !== undefined && documents.some((d) => d.docId === doc.parentId)) continue; // assessed with its message
    const family = [doc, ...documents.filter((d) => d.parentId === doc.docId)];
    const segments = family.flatMap((d) => d.segments.map((s) => ({ ...s, d })));
    const indicators: string[] = [];
    const evidence: Finding['evidence'] = [];
    const hit = (res: RegExp[], what: string) => {
      for (const re of res) {
        const seg = segments.find((s) => re.test(s.text)) ?? (doc.email?.subject && re.test(doc.email.subject) ? { ...doc.segments[0], text: `Subject: ${doc.email.subject}`, d: doc } : undefined);
        if (seg) {
          indicators.push(what);
          evidence.push({ documentId: String(seg.d.docId), documentName: seg.d.name, segmentOrdinal: seg.ordinal, location: seg.location, excerpt: seg.text.slice(0, 300), field: what });
          return true;
        }
      }
      return false;
    };
    const changes = hit(CHANGE, 'Requests a change of payment details');
    if (!changes) continue; // urgency or secrecy alone is ordinary business language
    hit(URGENCY, 'Urgent payment pressure');
    hit(SECRECY, 'Asks for secrecy or discourages verification');
    const sender = domainOf(doc.email?.from);
    let lookalike: string | undefined;
    if (sender && !knownDomains.has(sender)) {
      lookalike = [...knownDomains.keys()].find((k) => k !== sender && (deleet(k) === deleet(sender) || (deleet(sender).replace(/[^a-z]/g, '') === deleet(k).replace(/[^a-z]/g, ''))));
      if (lookalike) indicators.push(`Sender domain ${sender} resembles ${lookalike}, which appears in other supplier documents`);
      if (!lookalike) {
        const label = sender.split('.')[0];
        const key = deleet(label).replace(/[^a-z]/g, '');
        const named = deleet(label) !== label ? records.find((r) => r.supplier && supplierKey(r.supplier) === key) : undefined;
        if (named) indicators.push(`Sender domain ${sender} imitates the supplier name "${named.supplier}" with substituted characters`);
        if (named) lookalike = named.supplier;
      }
    }
    const bank = bankFindings.find((b) => family.some((d) => b.docIds.includes(d.docId)));
    if (bank) indicators.push('The account in this message differs from the account on earlier documents');
    if (indicators.length < 2) continue;
    const f = blankFinding({
      id: `scam-${doc.docId}`,
      investigation: 'scam_indicators',
      kind: lookalike ? 'possible_impersonation' : 'payment_instruction_risk',
      label: lookalike ? 'Possible impersonation indicator' : 'Payment instruction requires verification',
      title: doc.email?.subject ? `“${doc.email.subject}” from ${doc.email.from ?? 'unknown sender'}` : doc.name,
      summary: `${indicators.length} indicators: ${indicators.join('; ')}.`,
      classification: 'unverified_indicator',
      strength: lookalike && bank ? 'strong' : indicators.length >= 3 ? 'moderate' : 'weak',
      evidence: [...evidence, ...(lookalike ? [...(knownDomains.get(lookalike) ?? [])].slice(0, 2).map((id) => ({ documentId: String(id), documentName: records.find((r) => r.docId === id)?.docName ?? documents.find((d) => d.docId === id)?.name ?? '', field: 'known domain', originalValue: lookalike! })) : [])],
      unresolved: bank?.unresolved ?? [],
      amount: bank?.amount,
      limitations: ['These are patterns often seen in payment-redirection attempts, but a genuine supplier can send a message with the same features. InQurix cannot tell who sent the message.', 'Email headers (SPF/DKIM) are not verified.'],
      verification: ['Do not use contact details from this message. Phone the supplier on a number from your records.', 'Hold any payment to the new account until the change is confirmed.'],
      overlapsWith: bank ? [bank.id] : [],
    });
    f.docIds = [...new Set([...family.map((d) => d.docId), ...(bank?.docIds ?? [])])];
    f.recordIds = bank?.recordIds ?? [];
    out.push(f);
  }
  return out;
}

export { label };
