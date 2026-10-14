/**
 * Core domain types shared by the desktop app and the company server.
 * Everything that is presented to a user as evidence must be traceable to
 * a document + a location within that document.
 */

export type FileKind =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'pptx'
  | 'txt'
  | 'csv'
  | 'rtf'
  | 'html'
  | 'eml'
  | 'image'
  | 'zip'
  | 'unknown';

export type IndexStatus =
  | 'discovered'
  | 'queued'
  | 'processing'
  | 'indexed'
  | 'partial'
  | 'empty'
  | 'skipped'
  | 'failed'
  | 'unsupported'
  | 'encrypted'
  | 'ocr_required'
  | 'unavailable'
  | 'deleted';

/** Structural address of a segment inside its document. */
export interface SegmentLocation {
  page?: number;
  pageCount?: number;
  sheet?: string;
  row?: number;
  column?: string;
  cell?: string;
  range?: string;
  slide?: number;
  section?: string;
  heading?: string;
  paragraph?: number;
  line?: number;
  messageId?: string;
  attachment?: string;
}

export type SegmentKind =
  | 'paragraph'
  | 'heading'
  | 'page'
  | 'row'
  | 'table'
  | 'slide'
  | 'email_header'
  | 'email_body'
  | 'cell'
  | 'ocr_block';

export type ExtractionMethod = 'text' | 'pdf_text' | 'ooxml' | 'spreadsheet' | 'html' | 'rtf' | 'email' | 'ocr';

export interface ExtractedSegment {
  ordinal: number;
  kind: SegmentKind;
  text: string;
  location: SegmentLocation;
  method: ExtractionMethod;
  /** 0..1, only for OCR output */
  confidence?: number;
  /** For spreadsheet rows: the header->value map when a header row was detected. */
  fields?: Record<string, string>;
  /** For spreadsheet rows: column letter -> displayed value, formula and header. */
  cells?: Record<string, { v: string; f?: string; h?: string }>;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  pageCount?: number;
  sheetNames?: string[];
  slideCount?: number;
  email?: {
    from?: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    date?: string;
    messageId?: string;
    attachments?: { filename: string; size: number; contentType: string }[];
  };
}

export interface ExtractionWarning {
  code: string;
  message: string;
}

export interface ExtractionResult {
  kind: FileKind;
  status: Extract<IndexStatus, 'indexed' | 'partial' | 'empty' | 'unsupported' | 'encrypted' | 'ocr_required' | 'failed'>;
  segments: ExtractedSegment[];
  metadata: DocumentMetadata;
  warnings: ExtractionWarning[];
  /** For emails: attachments extracted and processed as child documents. */
  children?: { name: string; result: ExtractionResult }[];
  /** Average OCR confidence when OCR was used. */
  ocrConfidence?: number;
}

export type EntityType =
  | 'amount'
  | 'date'
  | 'invoice_number'
  | 'po_number'
  | 'quote_number'
  | 'delivery_note_number'
  | 'credit_note_number'
  | 'payment_reference'
  | 'transaction_id'
  | 'contract_number'
  | 'supplier'
  | 'bank_account'
  | 'bank_name'
  | 'branch_code'
  | 'swift'
  | 'iban'
  | 'account_holder'
  | 'email'
  | 'phone'
  | 'vat_number'
  | 'payment_terms'
  | 'notice_period'
  | 'renewal_term'
  | 'percentage';

export type EntityOrigin = 'extracted' | 'inferred';

export interface ExtractedEntity {
  type: EntityType;
  /** Exactly as it appears in the source. */
  original: string;
  /** Normalised representation used for matching (never shown as if it were the source). */
  normalized: string;
  /** Numeric value for amounts/percentages/terms (days). */
  numeric?: number;
  currency?: string;
  /** For dates: ISO yyyy-mm-dd */
  isoDate?: string;
  /** Contextual label such as "invoice date", "due date", "total". */
  label?: string;
  origin: EntityOrigin;
  confidence: number;
  /** Ordinal of the segment the entity was found in. */
  segmentOrdinal: number;
  /** Character offset within the segment text. */
  offset: number;
}

export type BusinessDocType =
  | 'invoice'
  | 'purchase_order'
  | 'quotation'
  | 'delivery_note'
  | 'payment'
  | 'bank_statement'
  | 'credit_note'
  | 'contract'
  | 'remittance'
  | 'subscription'
  | 'other';

export interface LineItem {
  description: string;
  quantity?: number;
  unitPrice?: number;
  total?: number;
  segmentOrdinal: number;
  original: string;
}

/** Structured business record derived from one document (or one spreadsheet row). */
export interface BusinessRecord {
  docType: BusinessDocType;
  docTypeConfidence: number;
  supplier?: string;
  supplierNormalized?: string;
  number?: string;
  numberNormalized?: string;
  date?: string;
  dueDate?: string;
  currency?: string;
  total?: number;
  subtotal?: number;
  tax?: number;
  discount?: number;
  poReference?: string;
  invoiceReference?: string;
  quoteReference?: string;
  paymentReference?: string;
  transactionId?: string;
  paymentStatus?: 'completed' | 'instruction' | 'reversed' | 'refunded' | 'unknown';
  installment?: { index: number; of?: number };
  recurring?: { period: 'monthly' | 'annual' | 'quarterly' | 'weekly'; servicePeriod?: string };
  servicePeriod?: string;
  bank?: { accountNumber?: string; bankName?: string; branchCode?: string; swift?: string; iban?: string; accountHolder?: string };
  contact?: { email?: string; phone?: string };
  paymentTermsDays?: number;
  lineItems: LineItem[];
  /** Field -> segment ordinal where it was found, for evidence linking. */
  fieldSources: Partial<Record<string, number>>;
  /** Spreadsheet row records carry the row number */
  rowLocation?: SegmentLocation;
}

/** Evidence classifications mandated by the product spec. */
export type EvidenceClass =
  | 'direct_evidence'
  | 'inferred_relationship'
  | 'potential_discrepancy'
  | 'unverified_indicator'
  | 'missing_evidence';

export interface EvidenceRef {
  documentId: string;
  documentName: string;
  segmentOrdinal?: number;
  location?: SegmentLocation;
  excerpt?: string;
  field?: string;
  originalValue?: string;
  normalizedValue?: string;
  method?: ExtractionMethod | 'record';
}
