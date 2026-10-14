// Generates synthetic, clearly fictional business documents used by tests and demos.
// No real companies, people or bank accounts are represented.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const coreReq = createRequire(path.join(root, 'packages/core/package.json'));
const deskReq = createRequire(path.join(root, 'apps/desktop/package.json'));
const JSZip = coreReq('jszip');
const ExcelJS = coreReq('exceljs');
const PDFDocument = deskReq('pdfkit');
const { createCanvas } = coreReq('@napi-rs/canvas');

const out = path.resolve(process.argv[2] ?? path.join(root, 'fixtures/out'));
fs.mkdirSync(out, { recursive: true });
const w = (name, data) => fs.writeFileSync(path.join(out, name), data);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function pdf(lines, meta = {}) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: meta.title, Author: meta.author, CreationDate: meta.date ? new Date(meta.date) : new Date('2026-01-01') } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const l of lines) {
      if (l === '---page---') doc.addPage();
      else if (l.startsWith('# ')) doc.fontSize(18).text(l.slice(2)).moveDown(0.5).fontSize(11);
      else doc.fontSize(11).text(l).moveDown(l === '' ? 0.6 : 0.15);
    }
    doc.end();
  });
}

function scannedPdf(lines) {
  const canvas = createCanvas(1240, 1754);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1240, 1754);
  ctx.fillStyle = '#111'; ctx.font = '34px sans-serif';
  lines.forEach((l, i) => ctx.fillText(l, 90, 140 + i * 58));
  const png = canvas.toBuffer('image/png');
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), png }));
    doc.image(png, 0, 0, { width: 595.28, height: 841.89 });
    doc.end();
  });
}

async function docx(blocks, title) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Synthetic Fixture</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-15T09:00:00Z</dcterms:created></cp:coreProperties>`);
  const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const grouped = [];
  for (const b of blocks) {
    if (Array.isArray(b)) {
      const last = grouped[grouped.length - 1];
      if (Array.isArray(last)) last.push(b); else grouped.push([b]);
    } else grouped.push(b);
  }
  const body = grouped.map((b) => {
    if (Array.isArray(b)) return `<w:tbl>${b.map((row) => `<w:tr>${row.map((c) => `<w:tc>${p(String(c))}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
    if (b.startsWith('## ')) return p(b.slice(3), 'Heading2');
    if (b.startsWith('# ')) return p(b.slice(2), 'Heading1');
    return p(b);
  }).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function pptx(slides) {
  const zip = new JSZip();
  const n = slides.length;
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((s, i) => {
    const paras = s.lines.map((l) => `<a:p><a:r><a:t>${esc(l)}</a:t></a:r></a:p>`).join('');
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${esc(s.title)}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
    if (s.notes) {
      zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${esc(s.notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
      zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`);
    }
  });
  void n;
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const SUPPLIER = 'Kavango Office Supplies (Pty) Ltd';
const BUYER = 'Namib Coast Logistics CC';

w('invoice-INV-1048.pdf', await pdf([
  '# TAX INVOICE', `${SUPPLIER}`, 'VAT No: 4012345678', '12 Independence Avenue, Windhoek', '',
  'Invoice No: INV-1048', 'Invoice Date: 14/03/2026', 'Purchase Order: PO-7731', `Bill To: ${BUYER}`, '',
  'Description            Qty   Unit Price     Amount',
  'A4 Copy Paper (box)    40    N$ 210.00      N$ 8,400.00',
  'Toner Cartridge HP 26A  5    N$ 650.00      N$ 3,250.00',
  'Delivery                1    N$ 800.00      N$ 800.00', '',
  'Subtotal: N$ 12,450.00', 'VAT 15%: N$ 1,867.50', 'Total Due: N$ 14,317.50', '',
  'Payment Terms: 30 days from invoice date',
  'Bank: First National Bank Namibia', 'Account Holder: Kavango Office Supplies', 'Account Number: 62012345678', 'Branch Code: 280172',
], { title: 'Invoice INV-1048', author: SUPPLIER, date: '2026-03-14' }));

w('Kavango invoice 1048 (resent).pdf', await pdf([
  '# TAX INVOICE', `${SUPPLIER}`, '', 'Invoice Number: INV-01048', 'Date: 21/03/2026', `Customer: ${BUYER}`, '',
  'Total Due: N$ 14,317.50', 'Payment Terms: 30 days', 'Please note our NEW banking details below.',
  'Bank: Standard Bank Namibia', 'Account Holder: K. Supplies Trading', 'Account Number: 04123987650', 'Branch Code: 082372',
], { title: 'Invoice 1048', author: 'accounts', date: '2026-03-21' }));

w('purchase-order-PO-7731.docx', await docx([
  '# Purchase Order PO-7731', `Issued by ${BUYER} to ${SUPPLIER}.`, 'PO Date: 02/03/2026', 'Requested by: Operations',
  ['Item', 'Quantity', 'Unit Price', 'Line Total'],
  ['A4 Copy Paper (box)', '40', 'N$ 200.00', 'N$ 8,000.00'],
  ['Toner Cartridge HP 26A', '5', 'N$ 650.00', 'N$ 3,250.00'],
  ['Delivery', '1', 'N$ 700.00', 'N$ 700.00'],
  'PO Total (excl. VAT): N$ 11,950.00', 'Approved by: J. Shikongo, Finance Manager',
], 'Purchase Order PO-7731'));

w('service-agreement-kavango.docx', await docx([
  '# Supply and Service Agreement', `Contract No: CT-2025-019 between ${BUYER} and ${SUPPLIER}.`,
  '## 1. Term', 'This agreement commences on 01/04/2025 for an initial period of 12 months and renews automatically for successive 12 month periods.',
  '## 2. Termination', 'Either party may terminate on 60 days written notice before the renewal date.',
  '## 3. Pricing', 'Unit prices for A4 Copy Paper are fixed at N$ 200.00 per box for the contract term.',
  '## 4. Payment', 'Payment terms are 30 days from date of invoice.',
], 'Supply and Service Agreement'));

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Payments 2026');
ws.addRow(['Payment Date', 'Supplier', 'Reference', 'Invoice', 'Amount (NAD)', 'Account']);
const rows = [
  ['05/02/2026', 'Erongo Fuel Distributors', 'PAY-2201', 'EF-5531', 18250.0, '62055500111'],
  ['18/02/2026', 'Kavango Office Supplies', 'PAY-2214', 'INV-1032', 9870.5, '62012345678'],
  ['12/04/2026', 'Kavango Office Supplies', 'PAY-2290', 'INV-1048', 14317.5, '62012345678'],
  ['15/04/2026', 'Kavango Office Supplies', 'PAY-2297', 'INV-01048', 14317.5, '04123987650'],
  ['20/04/2026', 'Swakop Cleaning Services', 'PAY-2301', 'SC-889', 4600.0, '62077700222'],
];
for (const r of rows) ws.addRow(r);
ws.addRow(['', '', '', 'Total', { formula: 'SUM(E2:E6)', result: rows.reduce((a, r) => a + r[4], 0) }, '']);
w('payments-2026.xlsx', await wb.xlsx.writeBuffer());

w('board-meeting-2026-03.pptx', await pptx([
  { title: 'Board Meeting – March 2026', lines: ['Namib Coast Logistics CC', 'Operations and procurement review'] },
  { title: 'Supplier contracts', lines: ['Kavango Office Supplies agreement CT-2025-019 renews on 01/04/2026', 'Decision: renegotiate paper pricing before renewal'], notes: 'Finance to compare the last three invoices against the purchase orders.' },
  { title: 'Budget', lines: ['Office consumables budget 2026: N$ 150,000', 'Fuel budget increased by 8%'] },
]));

w('quote-Q-2207.txt', `QUOTATION Q-2207\n${SUPPLIER}\nDate: 20/02/2026\nValid for 30 days\n\nA4 Copy Paper (box) x 40 @ N$ 200.00 = N$ 8,000.00\nToner Cartridge HP 26A x 5 @ N$ 640.00 = N$ 3,200.00\nDelivery: N$ 700.00\n\nQuote total: N$ 11,900.00 excl. VAT\n`);

w('transactions-march.csv', 'Date;Description;Reference;Debit;Credit;Balance\n01/03/2026;Opening balance;;;;250000,00\n03/03/2026;Erongo Fuel Distributors;TRX-88121;18250,00;;231750,00\n09/03/2026;Customer receipt Walvis Freight;TRX-88160;;45000,00;276750,00\n10/03/2026;Kavango Office Supplies;TRX-88162;9870,50;;266879,50\n');

w('meeting-notes-procurement.rtf', '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs22 {\\b Procurement meeting notes}\\par 11/03/2026\\par Attendees: Finance, Operations\\par Action: confirm with Kavango Office Supplies by phone before changing any bank details.\\par Decision: all supplier bank detail changes require two approvals.\\par}');

w('intranet-supplier-policy.html', '<!doctype html><html><head><title>Supplier Payment Policy</title><script>alert("x")</script></head><body><h1>Supplier Payment Policy</h1><p>Bank detail changes must be verified by calling the supplier on a number already on file.</p><table><tr><th>Approval level</th><th>Limit</th></tr><tr><td>Finance Manager</td><td>N$ 50,000</td></tr><tr><td>Director</td><td>N$ 250,000</td></tr></table></body></html>');

const letter = Buffer.from(`Dear Customer,\n\nPlease update our banking details effective immediately.\nBank: Standard Bank Namibia\nAccount Number: 04123987650\nBranch Code: 082372\n\nKavango Office Supplies\n`).toString('base64');
w('bank-details-change.eml', [
  'From: "Kavango Accounts" <accounts@kavango-office-supp1ies.com>', `To: payables@namibcoast.example`, 'Subject: URGENT - updated banking details for invoice INV-1048',
  'Date: Thu, 19 Mar 2026 16:42:00 +0200', 'Message-ID: <fixture-1048@kavango-office-supp1ies.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BOUNDARY"', '',
  '--BOUNDARY', 'Content-Type: text/plain; charset=utf-8', '',
  'Good day,', '', 'Our bank account has changed. Please pay invoice INV-1048 (N$ 14,317.50) urgently to the new account in the attached letter today.', 'Kindly keep this confidential and do not call our office as we are being audited.', '', 'Regards,', 'Accounts Department', '',
  '--BOUNDARY', 'Content-Type: text/plain; name="bank-letter.txt"', 'Content-Disposition: attachment; filename="bank-letter.txt"', 'Content-Transfer-Encoding: base64', '', letter, '--BOUNDARY--', '',
].join('\r\n'));

const scanned = await scannedPdf(['DELIVERY NOTE DN-5520', SUPPLIER, 'Date: 16/03/2026', 'Purchase Order: PO-7731', 'A4 Copy Paper (box)   Qty 38', 'Toner Cartridge HP 26A   Qty 5', 'Received by: P. Nangolo']);
w('scanned-delivery-note-DN-5520.pdf', scanned.pdf);
w('whiteboard-photo.png', scanned.png);

w('program.exe', Buffer.from('MZ\x90\x00 not really a program'));
w('looks-like-text.pdf', 'This file claims to be a PDF but is plain text about invoice INV-9999.');

console.log(`Fixtures written to ${out}`);
