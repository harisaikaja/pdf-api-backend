// invoiceGenerator.js — Dynamic, realistic invoice PDF generator using pdf-lib
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

// ── Color palette ─────────────────────────────────────────────────────────────
const C = {
  primary:  rgb(0.05, 0.31, 0.65),
  accent:   rgb(0.00, 0.63, 0.55),
  dark:     rgb(0.10, 0.10, 0.14),
  mid:      rgb(0.40, 0.42, 0.48),
  light:    rgb(0.92, 0.94, 0.97),
  white:    rgb(1.00, 1.00, 1.00),
  green:    rgb(0.05, 0.60, 0.35),
  red:      rgb(0.75, 0.15, 0.15),
  rowAlt:   rgb(0.96, 0.97, 0.99),
  border:   rgb(0.82, 0.85, 0.91),
};

const money = (n) => `$${Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const pad   = (n) => String(n).padStart(2, '0');

function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${pad(dt.getMonth()+1)}/${pad(dt.getDate())}/${dt.getFullYear()}`;
}

function drawRect(page, x, y, w, h, color, opts = {}) {
  page.drawRectangle({ x, y, width: w, height: h, color,
    ...(opts.stroke ? { borderColor: opts.strokeColor || C.border, borderWidth: opts.strokeWidth || 0.5 } : {}),
  });
}

function drawText(page, text, x, y, font, size, color, opts = {}) {
  let str = String(text ?? '');
  if (opts.maxWidth) {
    while (str.length > 1 && font.widthOfTextAtSize(str, size) > opts.maxWidth) str = str.slice(0, -1);
    if (str !== String(text ?? '')) str = str.slice(0, -1) + '…';
  }
  const w = font.widthOfTextAtSize(str, size);
  const dx = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w/2 : x;
  page.drawText(str, { x: dx, y, size, font, color: color || C.dark });
}

export async function generateInvoicePdf(data) {
  const d = data ?? {};

  // Defaults
  const invoiceNumber = d.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`;
  const issueDate     = d.issueDate     || new Date();
  const dueDate       = d.dueDate       || new Date(Date.now() + 30*86400000);
  const status        = (d.status       || 'UNPAID').toUpperCase();
  const currency      = d.currency      || 'USD';
  const taxRate       = typeof d.taxRate === 'number' ? d.taxRate : 0.08;
  const discount      = d.discount      || 0;
  const notes         = d.notes         || '';
  const terms         = d.terms         || 'Payment due within 30 days. Late payments incur 1.5% monthly interest.';

  const fr = d.from || {};
  const from = {
    company: fr.company || 'Hari Sai Solutions LLC',
    address: fr.address || '1234 Innovation Drive, Suite 500',
    city:    fr.city    || 'Grand Rapids, MI 49503',
    phone:   fr.phone   || '+1 (616) 555-0199',
    email:   fr.email   || 'billing@harisai.dev',
    website: fr.website || 'harisai.dev',
    taxId:   fr.taxId   || 'EIN: 38-1234567',
  };

  const to = d.to || {};
  const client = {
    company: to.company || 'Acme Corporation',
    name:    to.name    || 'John Smith',
    address: to.address || '789 Client Ave, Floor 3',
    city:    to.city    || 'New York, NY 10001',
    email:   to.email   || 'accounts@acme.com',
  };

  const items = d.items && d.items.length > 0 ? d.items : [
    { description: 'Software Engineering Services', quantity: 40, rate: 150, detail: 'Backend API development (April 2025)' },
    { description: 'UI/UX Design & Implementation', quantity: 16, rate: 125, detail: 'Dashboard redesign and component library' },
    { description: 'DevOps & Infrastructure Setup',  quantity: 8,  rate: 175, detail: 'AWS deployment, CI/CD pipeline' },
    { description: 'Technical Documentation',        quantity: 4,  rate: 100, detail: 'API docs, runbooks, architecture diagrams' },
  ];

  // Computed totals
  const subtotal    = items.reduce((s, i) => s + i.quantity * i.rate, 0);
  const taxable     = subtotal - discount;
  const tax         = taxable * taxRate;
  const total       = taxable + tax;

  // Create document
  const doc  = await PDFDocument.create();
  const W = 612, H = 792;
  const page = doc.addPage([W, H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  let y = H;

  // ── HEADER BAR ───────────────────────────────────────────────────────────────
  drawRect(page, 0, H-110, W, 110, C.primary);
  drawText(page, from.company,                        40, H-42, bold,    20, C.white);
  drawText(page, from.address,                        40, H-60, regular,  9, rgb(0.75,0.85,1));
  drawText(page, from.city,                           40, H-73, regular,  9, rgb(0.75,0.85,1));
  drawText(page, `${from.email}  ·  ${from.phone}`,  40, H-86, regular,8.5, rgb(0.75,0.85,1));
  drawText(page, from.taxId,                          40, H-99, regular,  8, rgb(0.65,0.75,0.92));
  drawText(page, 'INVOICE',         W-40, H-42, bold,    28, C.white, { align: 'right' });
  drawText(page, `# ${invoiceNumber}`, W-40, H-62, regular, 11, rgb(0.80,0.88,1), { align: 'right' });

  // Status badge
  const statusMap = { PAID: C.green, UNPAID: C.accent, OVERDUE: C.red, DRAFT: C.mid };
  const badgeColor = statusMap[status] || C.mid;
  const bW = 72, bH = 20, bX = W-40-bW, bY = H-97;
  drawRect(page, bX, bY, bW, bH, badgeColor);
  drawText(page, status, bX+bW/2, bY+5.5, bold, 9, C.white, { align: 'center' });

  y = H - 110;

  // ── META BAR ─────────────────────────────────────────────────────────────────
  drawRect(page, 0, y-44, W, 44, C.light);
  drawRect(page, 0, y-44, W, 1,  C.border);
  const metas = [
    { label: 'Issue Date', value: fmtDate(issueDate) },
    { label: 'Due Date',   value: fmtDate(dueDate)   },
    { label: 'Currency',   value: currency            },
    { label: 'Website',    value: from.website        },
  ];
  metas.forEach(({ label, value }, i) => {
    const cx = 40 + i * (W / 4);
    drawText(page, label, cx, y-18, regular, 7.5, C.mid);
    drawText(page, value, cx, y-32, bold,    9.5, C.primary);
  });
  y -= 44;

  // ── BILL TO ───────────────────────────────────────────────────────────────────
  y -= 24;
  drawText(page, 'BILL TO', 40, y, bold, 7.5, C.accent);
  y -= 16; drawText(page, client.company, 40, y, bold,    13,  C.dark);
  y -= 15; drawText(page, client.name,    40, y, regular, 10,  C.mid);
  y -= 14; drawText(page, client.address, 40, y, regular, 9.5, C.mid);
  y -= 13; drawText(page, client.city,    40, y, regular, 9.5, C.mid);
  y -= 13; drawText(page, client.email,   40, y, oblique,  9,  C.primary);

  // Amount due (right side)
  let sy = y + 14*4 + 15 + 16 + 8;
  drawText(page, 'AMOUNT DUE',   W-200, sy,    bold,    7.5, C.accent);
  sy -= 18; drawText(page, money(total), W-40, sy, bold, 22, C.primary, { align: 'right' });
  sy -= 14; drawText(page, `Due ${fmtDate(dueDate)}`, W-40, sy, regular, 8.5, C.mid, { align: 'right' });

  y -= 28;

  // ── ITEMS TABLE ───────────────────────────────────────────────────────────────
  y -= 16;
  const tL = 40, tR = W-40, tW = tR - tL;
  const cx = { desc: tL, qty: tL + tW*0.44, rate: tL + tW*0.56, amt: tL + tW*0.74 };

  // Table header
  drawRect(page, tL, y-22, tW, 22, C.primary);
  drawText(page, 'DESCRIPTION', cx.desc+8,  y-14, bold, 8, C.white);
  drawText(page, 'QTY',         cx.qty+4,   y-14, bold, 8, C.white);
  drawText(page, 'UNIT PRICE',  cx.rate+4,  y-14, bold, 8, C.white);
  drawText(page, 'AMOUNT',      tR-8,       y-14, bold, 8, C.white, { align: 'right' });
  y -= 22;

  items.forEach((item, idx) => {
    const lineTotal = item.quantity * item.rate;
    const rowH      = item.detail ? 26 : 20;
    const rowBg     = idx % 2 === 0 ? C.white : C.rowAlt;
    drawRect(page, tL, y-rowH, tW, rowH, rowBg);
    drawRect(page, tL, y-rowH, tW, 0.5, C.border);
    drawText(page, item.description,      cx.desc+8,  y-11, bold,    9,   C.dark, { maxWidth: tW*0.38 });
    if (item.detail) drawText(page, item.detail, cx.desc+8, y-22, oblique, 7.5, C.mid, { maxWidth: tW*0.38 });
    drawText(page, String(item.quantity), cx.qty+4,   y-11, regular, 9,   C.dark);
    drawText(page, money(item.rate),      cx.rate+4,  y-11, regular, 9,   C.dark);
    drawText(page, money(lineTotal),      tR-8,       y-11, bold,    9,   C.dark, { align: 'right' });
    y -= rowH;
  });
  drawRect(page, tL, y, tW, 1, C.border);

  // ── TOTALS ────────────────────────────────────────────────────────────────────
  y -= 16;
  const totLines = [
    { label: 'Subtotal', value: money(subtotal) },
    ...(discount > 0 ? [{ label: 'Discount', value: `– ${money(discount)}`, color: C.green }] : []),
    { label: `Tax (${(taxRate*100).toFixed(0)}%)`, value: money(tax) },
  ];
  totLines.forEach(({ label, value, color }) => {
    drawText(page, label, W-220, y, regular, 9, C.mid);
    drawText(page, value, W-40,  y, regular, 9, color || C.dark, { align: 'right' });
    y -= 19;
  });
  // Grand total
  drawRect(page, W-228, y-6, 188, 28, C.primary);
  drawText(page, 'TOTAL DUE', W-220, y+7, bold, 9, C.white);
  drawText(page, money(total), W-40, y+7, bold, 14, C.white, { align: 'right' });
  y -= 28;

  // ── NOTES ─────────────────────────────────────────────────────────────────────
  if (notes) {
    y -= 24;
    drawText(page, 'NOTES', 40, y, bold, 8, C.accent);
    y -= 14;
    const words = notes.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (regular.widthOfTextAtSize(test, 8.5) > tW) {
        drawText(page, line, 40, y, regular, 8.5, C.mid);
        y -= 12; line = word;
      } else { line = test; }
    }
    if (line) { drawText(page, line, 40, y, regular, 8.5, C.mid); y -= 12; }
  }

  // ── FOOTER ────────────────────────────────────────────────────────────────────
  const fH = 48;
  drawRect(page, 0, 0, W, fH, C.light);
  drawRect(page, 0, fH, W, 1, C.border);
  drawRect(page, 0, 0, W, 4, C.accent);
  drawText(page, 'PAYMENT TERMS', 40, fH-12, bold, 7, C.accent);
  drawText(page, terms, 40, fH-25, regular, 7.5, C.mid, { maxWidth: 380 });
  drawText(page, 'MAKE CHECKS PAYABLE TO', W-200, fH-12, bold, 7, C.accent);
  drawText(page, from.company, W-40, fH-25, bold, 9, C.primary, { align: 'right' });
  drawText(page, from.email,   W-40, fH-37, regular, 8, C.mid,  { align: 'right' });
  drawText(page, `Page 1 of 1  ·  Generated ${fmtDate(new Date())}`, W/2, 8, regular, 6.5, C.mid, { align: 'center' });

  // Metadata
  doc.setTitle(`Invoice ${invoiceNumber} — ${client.company}`);
  doc.setAuthor(from.company);
  doc.setCreationDate(new Date());

  return Buffer.from(await doc.save());
}

// ── Sample presets ────────────────────────────────────────────────────────────
export function buildSampleInvoice(preset = 'consulting') {
  const presets = {
    consulting: {
      invoiceNumber: 'INV-2025-0047',
      issueDate: '2025-05-01',
      dueDate:   '2025-05-31',
      status:    'UNPAID',
      taxRate:   0.08,
      discount:  500,
      notes: 'Thank you for your continued business. All deliverables have been uploaded to the shared project repository. Please review and confirm receipt.',
      from: {
        company: 'Hari Sai Solutions LLC',
        address: '1234 Innovation Drive, Suite 500',
        city:    'Grand Rapids, MI 49503',
        phone:   '+1 (616) 555-0199',
        email:   'billing@harisai.dev',
        website: 'harisai.dev',
        taxId:   'EIN: 38-1234567',
      },
      to: {
        company: 'Blue Nucleus Inc.',
        name:    'Dr. Sarah Mansour',
        address: '401 W Fulton St, GVSU CoN',
        city:    'Grand Rapids, MI 49504',
        email:   'smansour@bluenucleus.edu',
      },
      items: [
        { description: 'LLM-Integrated Clinical Platform',  quantity: 80, rate: 135.00, detail: 'NextJS/Supabase backend + MCP integration (Sprint 3 & 4)' },
        { description: 'Nurse Simulation Module',           quantity: 24, rate: 125.00, detail: 'Scenario engine, adaptive branching logic' },
        { description: 'API Testing & QA Automation',       quantity: 12, rate: 110.00, detail: 'Playwright API test suite — 31 test cases' },
        { description: 'Technical Architecture Review',      quantity:  4, rate: 175.00, detail: 'Security audit, performance profiling' },
        { description: 'DevOps & CI/CD Setup',              quantity:  6, rate: 150.00, detail: 'Render deployment, GitHub Actions pipeline' },
      ],
    },
    startup: {
      invoiceNumber: 'INV-2025-0031',
      issueDate: '2025-04-15',
      dueDate:   '2025-05-15',
      status:    'PAID',
      taxRate:   0.07,
      discount:  0,
      notes: 'Project milestone 2 completed. All code merged to main and deployed to staging. Next milestone kickoff scheduled for June 1.',
      from: {
        company: 'Hari Sai Kaja — Freelance',
        address: '50 Commerce SW, Unit 201',
        city:    'Grand Rapids, MI 49503',
        phone:   '+1 (616) 555-0142',
        email:   'hari@harisai-kaja.dev',
        website: 'harisai-kaja.vercel.app',
        taxId:   'SSN/EIN on file',
      },
      to: {
        company: 'Mechanize AI',
        name:    'Engineering Billing',
        address: '340 Pine St, Suite 800',
        city:    'San Francisco, CA 94104',
        email:   'billing@mechanize.ai',
      },
      items: [
        { description: 'Senior Backend Engineer (Contract)', quantity: 80, rate: 175.00, detail: 'Python microservices, data pipelines — April 2025' },
        { description: 'Database Design & Optimization',     quantity: 16, rate: 165.00, detail: 'PostgreSQL schema, query optimization, indexing' },
        { description: 'Code Review & Architecture',         quantity:  8, rate: 190.00, detail: 'PR reviews, design docs, RFC authoring' },
      ],
    },
    agency: {
      invoiceNumber: 'INV-2025-0018',
      issueDate: '2025-03-01',
      dueDate:   '2025-03-15',
      status:    'OVERDUE',
      taxRate:   0.085,
      discount:  250,
      notes: 'This invoice is now past due. Please remit payment immediately to avoid service interruption. Contact billing@harisai.dev if you have questions.',
      terms: 'OVERDUE — Original due date: 03/15/2025. Late fee of 1.5%/month applies.',
      from: {
        company: 'Hari Sai Solutions LLC',
        address: '1234 Innovation Drive, Suite 500',
        city:    'Grand Rapids, MI 49503',
        phone:   '+1 (616) 555-0199',
        email:   'billing@harisai.dev',
        website: 'harisai.dev',
        taxId:   'EIN: 38-1234567',
      },
      to: {
        company: 'BDIPlus Analytics',
        name:    'Finance Department',
        address: '200 State St, Floor 4',
        city:    'Chicago, IL 60601',
        email:   'ap@bdiplus.com',
      },
      items: [
        { description: 'Data Engineering — Kafka Pipelines',  quantity: 60, rate: 145.00, detail: '10M+ records/day streaming architecture' },
        { description: 'Snowflake Data Warehouse Setup',      quantity: 20, rate: 155.00, detail: 'Schema design, ETL jobs, cost optimization' },
        { description: 'Dashboard & Reporting Layer',         quantity: 16, rate: 130.00, detail: 'KPI dashboards, executive reporting views' },
        { description: 'Knowledge Transfer Sessions',         quantity:  4, rate: 200.00, detail: '2x 2-hour team walkthroughs + documentation' },
      ],
    },
  };
  return presets[preset] || presets.consulting;
}
