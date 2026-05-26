import 'dotenv/config';
import express from 'express';
import fileUpload from 'express-fileupload';
import jwt from 'jsonwebtoken';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
GlobalWorkerOptions.workerSrc = path.join(
  __dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
);

async function parsePdf(buffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + '\n';
  }
  return { text: text.trim(), numpages: pdf.numPages };
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'pdf-api-secret-key-2025';

const pdfStore = {};
const signedPdfStore = {};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 }, useTempFiles: false }));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok', message: 'PDF Workflow API', version: '2.0.0',
    endpoints: [
      'POST /auth/login', 'POST /pdf/upload', 'GET /pdf/list',
      'GET /pdf/:id/preview', 'POST /pdf/:id/search', 'POST /pdf/:id/sign',
      'GET /pdf/signed/list', 'GET /pdf/signed/:id/download',
      'POST /pdf/signed/:id/drive-upload', 'GET /pdf/:id/download',
    ],
  });
});

// ─── 1. Login ─────────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
  if (username === 'admin' && password === 'admin') {
    const token = jwt.sign({ username, role: 'admin', id: 'usr_admin_001' }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, user: { username, role: 'admin', id: 'usr_admin_001' }, expiresIn: '8h' });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

// ─── 2. Upload PDF ────────────────────────────────────────────────────────────
app.post('/pdf/upload', authenticate, async (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'" });
  const file = req.files.file;
  if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are accepted' });
  const id = uuidv4();
  pdfStore[id] = { id, name: file.name, buffer: file.data, size: file.size, uploadedAt: new Date().toISOString(), uploadedBy: req.user.username };
  res.status(201).json({ id, name: file.name, size: file.size, uploadedAt: pdfStore[id].uploadedAt, message: 'PDF uploaded successfully' });
});

// ─── 3. List PDFs ─────────────────────────────────────────────────────────────
app.get('/pdf/list', authenticate, (req, res) => {
  const list = Object.values(pdfStore).map(({ id, name, size, uploadedAt, uploadedBy }) => ({ id, name, size, uploadedAt, uploadedBy }));
  res.json({ count: list.length, pdfs: list });
});

// ─── 4. Signed PDF list (must be before /pdf/:id routes) ─────────────────────
app.get('/pdf/signed/list', authenticate, (req, res) => {
  const list = Object.values(signedPdfStore).map(({ id, originalId, name, signerName, signerEmail, signedAt, signedBy }) => ({ id, originalId, name, signerName, signerEmail, signedAt, signedBy }));
  res.json({ count: list.length, signedPdfs: list });
});

// ─── 5. Download signed PDF ───────────────────────────────────────────────────
app.get('/pdf/signed/:id/download', authenticate, (req, res) => {
  const signed = signedPdfStore[req.params.id];
  if (!signed) return res.status(404).json({ error: 'Signed PDF not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${signed.name}"`);
  res.send(signed.buffer);
});

// ─── 6. Drive upload ──────────────────────────────────────────────────────────
app.post('/pdf/signed/:id/drive-upload', authenticate, async (req, res) => {
  const signed = signedPdfStore[req.params.id];
  if (!signed) return res.status(404).json({ error: 'Signed PDF not found' });
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const fakeUrl = `https://drive.google.com/file/d/mock_${uuidv4()}/view`;
    signedPdfStore[req.params.id].driveUrl = fakeUrl;
    return res.json({ success: true, simulated: true, driveUrl: fakeUrl, message: 'Drive upload simulated (no credentials configured).' });
  }
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive.file'] });
    const drive = google.drive({ version: 'v3', auth });
    const { Readable } = await import('stream');
    const stream = Readable.from(signed.buffer);
    const response = await drive.files.create({
      requestBody: { name: signed.name, mimeType: 'application/pdf', parents: process.env.GOOGLE_DRIVE_FOLDER_ID ? [process.env.GOOGLE_DRIVE_FOLDER_ID] : undefined },
      media: { mimeType: 'application/pdf', body: stream },
      fields: 'id, webViewLink, webContentLink',
    });
    const driveUrl = response.data.webViewLink;
    signedPdfStore[req.params.id].driveUrl = driveUrl;
    res.json({ success: true, fileId: response.data.id, driveUrl, downloadUrl: response.data.webContentLink, message: 'PDF uploaded to Google Drive successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Google Drive upload failed', details: err.message });
  }
});

// ─── 7. Preview PDF ───────────────────────────────────────────────────────────
app.get('/pdf/:id/preview', authenticate, async (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: 'PDF not found' });
  try {
    const { text, numpages } = await parsePdf(pdf.buffer);
    res.json({ id: pdf.id, name: pdf.name, pageCount: numpages, textSnippet: text.substring(0, 500), totalCharacters: text.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse PDF', details: err.message });
  }
});

// ─── 8. Search PDF ────────────────────────────────────────────────────────────
app.post('/pdf/:id/search', authenticate, async (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: 'PDF not found' });
  const { query, caseSensitive = false } = req.body;
  if (!query || query.trim() === '') return res.status(400).json({ error: 'query field is required' });
  try {
    const { text: fullText, numpages } = await parsePdf(pdf.buffer);
    const searchText = caseSensitive ? fullText : fullText.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();
    const matches = [];
    let idx = searchText.indexOf(searchQuery);
    while (idx !== -1) {
      const contextStart = Math.max(0, idx - 80);
      const contextEnd = Math.min(fullText.length, idx + searchQuery.length + 80);
      matches.push({ position: idx, context: fullText.substring(contextStart, contextEnd).replace(/\n/g, ' ').trim(), matchedText: fullText.substring(idx, idx + query.length) });
      idx = searchText.indexOf(searchQuery, idx + 1);
    }
    res.json({ query, caseSensitive, count: matches.length, found: matches.length > 0, matches: matches.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to search PDF', details: err.message });
  }
});

// ─── 9. Sign PDF ──────────────────────────────────────────────────────────────
app.post('/pdf/:id/sign', authenticate, async (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: 'PDF not found' });
  const { signerName = req.user.username, signerEmail = '', signatureText = req.user.username, page, x = 50, y = 50 } = req.body;
  try {
    const pdfDoc = await PDFDocument.load(pdf.buffer);
    const pages = pdfDoc.getPages();
    const targetPage = pages[page ? Math.min(page - 1, pages.length - 1) : pages.length - 1];
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const metaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const signedAt = new Date().toISOString();
    targetPage.drawRectangle({ x, y, width: 260, height: 60, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 1.5, color: rgb(0.95, 0.97, 1) });
    targetPage.drawText(signatureText, { x: x + 10, y: y + 32, size: 16, font, color: rgb(0.1, 0.2, 0.6) });
    targetPage.drawText(`Signed by: ${signerName} | ${signedAt.substring(0, 10)}`, { x: x + 10, y: y + 12, size: 9, font: metaFont, color: rgb(0.4, 0.4, 0.4) });
    if (signerEmail) targetPage.drawText(signerEmail, { x: x + 10, y: y + 3, size: 8, font: metaFont, color: rgb(0.5, 0.5, 0.5) });
    const signedBuffer = Buffer.from(await pdfDoc.save());
    const signedId = uuidv4();
    signedPdfStore[signedId] = { id: signedId, originalId: pdf.id, name: `signed_${pdf.name}`, buffer: signedBuffer, signerName, signerEmail, signatureText, signedAt, signedBy: req.user.username };
    res.json({ signedId, originalId: pdf.id, name: `signed_${pdf.name}`, signerName, signedAt, message: 'PDF signed successfully', downloadUrl: `/pdf/signed/${signedId}/download` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sign PDF', details: err.message });
  }
});

// ─── 10. Download original PDF ────────────────────────────────────────────────
app.get('/pdf/:id/download', authenticate, (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: 'PDF not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdf.name}"`);
  res.send(pdf.buffer);
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`PDF Workflow API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});

// ─── INVOICE ROUTES ──────────────────────────────────────────────────────────
// Lazy-import the invoice generator (ESM, same module scope)
let _invoiceGen;
async function getInvoiceGen() {
  if (!_invoiceGen) {
    _invoiceGen = await import('./invoiceGenerator.js');
  }
  return _invoiceGen;
}

/**
 * GET /invoice/sample/:preset
 * Returns a ready-made PDF for preset: consulting | startup | agency
 */
app.get('/invoice/sample/:preset?', async (req, res) => {
  try {
    const { generateInvoicePdf, buildSampleInvoice } = await getInvoiceGen();
    const preset  = req.params.preset || 'consulting';
    const data    = buildSampleInvoice(preset);
    const pdfBuf  = await generateInvoicePdf(data);
    const name    = `invoice-${data.invoiceNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdfBuf);
  } catch (err) {
    console.error('Invoice sample error:', err);
    res.status(500).json({ error: 'Failed to generate invoice', details: err.message });
  }
});

/**
 * POST /invoice/generate
 * Fully custom invoice. Body = full invoice JSON (see schema below).
 *
 * Schema (all fields optional — sensible defaults provided):
 * {
 *   invoiceNumber, issueDate, dueDate, status, currency, taxRate, discount, notes, terms,
 *   from: { company, address, city, phone, email, website, taxId },
 *   to:   { company, name, address, city, email },
 *   items: [{ description, quantity, rate, detail? }]
 * }
 */
app.post('/invoice/generate', async (req, res) => {
  try {
    const { generateInvoicePdf } = await getInvoiceGen();
    const data   = req.body ?? {};
    const pdfBuf = await generateInvoicePdf(data);
    const num    = data.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`;
    const name   = `invoice-${num}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdfBuf);
  } catch (err) {
    console.error('Invoice generate error:', err);
    res.status(500).json({ error: 'Failed to generate invoice', details: err.message });
  }
});

/**
 * GET /invoice/presets
 * Returns list of available preset names and their data (for reference)
 */
app.get('/invoice/presets', async (req, res) => {
  try {
    const { buildSampleInvoice } = await getInvoiceGen();
    const presets = ['consulting', 'startup', 'agency'];
    const summary = presets.map(p => {
      const d = buildSampleInvoice(p);
      const subtotal = d.items.reduce((s, i) => s + i.quantity * i.rate, 0);
      return {
        preset: p,
        invoiceNumber: d.invoiceNumber,
        client: d.to.company,
        status: d.status,
        itemCount: d.items.length,
        subtotal,
        url: `/invoice/sample/${p}`,
      };
    });
    res.json({ presets: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /invoice/upload-and-store
 * Generates invoice + stores it in pdfStore (so it can be searched, signed, uploaded)
 * Returns pdfId for use with other API routes.
 */
app.post('/invoice/upload-and-store', authenticate, async (req, res) => {
  try {
    const { generateInvoicePdf, buildSampleInvoice } = await getInvoiceGen();
    const data   = Object.keys(req.body ?? {}).length > 0
                 ? req.body
                 : buildSampleInvoice('consulting');
    const pdfBuf = await generateInvoicePdf(data);
    const num    = data.invoiceNumber || `INV-${Date.now().toString().slice(-6)}`;
    const id     = uuidv4();
    const name   = `invoice-${num}.pdf`;
    pdfStore[id] = {
      id, name,
      buffer:     pdfBuf,
      size:       pdfBuf.length,
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.user?.username ?? 'api',
      isInvoice:  true,
      invoiceData: data,
    };
    res.status(201).json({
      id, name, size: pdfBuf.length,
      message: 'Invoice generated and stored. Use this id with /pdf/:id/preview, /search, /sign, etc.',
      previewUrl:   `/pdf/${id}/preview`,
      downloadUrl:  `/pdf/${id}/download`,
      signUrl:      `/pdf/${id}/sign`,
    });
  } catch (err) {
    console.error('Invoice store error:', err);
    res.status(500).json({ error: 'Failed to generate/store invoice', details: err.message });
  }
});
