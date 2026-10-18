import type { BusinessRecord, EvidenceClass, EvidenceRef, SegmentLocation } from '../types.js';

/** A business record as stored in an index, linked to its source document. */
export interface FinRecord extends BusinessRecord {
  id: number;
  docId: number;
  docName: string;
  docPath?: string;
  /** File modification time; only used to say when information was recorded, never as proof. */
  modifiedMs?: number;
  /** Text of the segments referenced by fieldSources, keyed by ordinal, for evidence excerpts. */
  segmentText?: Record<number, { text: string; location?: SegmentLocation }>;
}

/** Document-level context for checks that need text (contracts, emails, letters). */
export interface FinDocument {
  docId: number;
  /** Set for email attachments: the containing message. */
  parentId?: number;
  name: string;
  path?: string;
  modifiedMs?: number;
  segments: { ordinal: number; text: string; location?: SegmentLocation }[];
  email?: { from?: string; subject?: string; date?: string };
}

export type InvestigationType =
  | 'duplicate_invoices'
  | 'duplicate_payments'
  | 'invoice_comparison'
  | 'bank_details'
  | 'scam_indicators'
  | 'record_gaps'
  | 'cost_savings'
  | 'obligations';

export interface AttributeComparison {
  attribute: string;
  values: { recordId: number; docId: number; value?: string }[];
  outcome: 'same' | 'equivalent' | 'different' | 'missing';
  note?: string;
}

export interface Calculation {
  description: string;
  expression: string;
  result: number;
  currency?: string;
}

export interface Obligation {
  kind: 'contract_start' | 'contract_end' | 'renewal' | 'notice_deadline' | 'payment_due' | 'quote_expiry' | 'warranty_expiry' | 'delivery' | 'other';
  date: string;
  basis: 'explicit' | 'calculated';
  sourceDate?: string;
  method?: string;
}

export interface Finding {
  id: string;
  investigation: InvestigationType;
  kind: string;
  /** Careful, non-accusatory label, e.g. "Supplier details require verification". */
  label: string;
  title: string;
  summary: string;
  classification: EvidenceClass;
  strength: 'strong' | 'moderate' | 'weak';
  /** Duplicate investigations only. */
  grade?: 'exact' | 'likely' | 'weak';
  recordIds: number[];
  docIds: number[];
  comparisons: AttributeComparison[];
  calculations: Calculation[];
  amount?: { value: number; currency?: string; nature: 'documented_overcharge' | 'potential_saving' | 'amount_at_risk' };
  obligation?: Obligation;
  assumptions: string[];
  limitations: string[];
  verification: string[];
  unresolved: string[];
  evidence: EvidenceRef[];
  /** Other findings describing (part of) the same underlying money or discrepancy. */
  overlapsWith: string[];
}

export interface InvestigationInput {
  records: FinRecord[];
  documents?: FinDocument[];
  /** ISO date used for "upcoming" calculations; defaults to today. */
  today?: string;
}

export interface InvestigationResult {
  type: InvestigationType;
  objective: string;
  scope: { records: number; documents: number; recordTypes: Record<string, number> };
  findings: Finding[];
  notes: string[];
  totals?: { documentedOvercharge: number; potentialSaving: number; amountAtRisk: number; currency?: string; overlapAdjusted: boolean };
}
