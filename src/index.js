require("dotenv").config();
const express = require("express");
const fileUpload = require("express-fileupload");
const jwt = require("jsonwebtoken");
const pdfParse = require("pdf-parse");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "pdf-api-secret-key-2025";

// In-memory storage (no DB needed for testing)
const pdfStore = {}; // { id: { name, buffer, uploadedAt } }
const signedPdfStore = {}; // { id: { name, buffer, signedAt, driveUrl? } }

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(
  fileUpload({
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    useTempFiles: false,
  })
);

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "PDF Workflow API",
    version: "1.0.0",
    endpoints: [
      "POST /auth/login",
      "POST /pdf/upload",
      "GET  /pdf/list",
      "GET  /pdf/:id/preview",
      "POST /pdf/:id/search",
      "POST /pdf/:id/sign",
      "POST /pdf/:id/drive-upload",
      "GET  /pdf/:id/download",
      "GET  /pdf/signed/list",
    ],
  });
});

// ─── 1. LOGIN ─────────────────────────────────────────────────────────────────
/**
 * POST /auth/login
 * Body: { username: "admin", password: "admin" }
 * Returns: { token, user }
 */
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  if (username === "admin" && password === "admin") {
    const token = jwt.sign(
      { username, role: "admin", id: "usr_admin_001" },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    return res.json({
      token,
      user: { username, role: "admin", id: "usr_admin_001" },
      expiresIn: "8h",
    });
  }

  return res.status(401).json({ error: "Invalid credentials" });
});

// ─── 2. UPLOAD PDF ────────────────────────────────────────────────────────────
/**
 * POST /pdf/upload
 * Form-data: file (PDF)
 * Returns: { id, name, size, uploadedAt }
 */
app.post("/pdf/upload", authenticate, async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).json({ error: "No file uploaded. Use field name 'file'" });
  }

  const file = req.files.file;

  if (file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "Only PDF files are accepted" });
  }

  const id = uuidv4();
  pdfStore[id] = {
    id,
    name: file.name,
    buffer: file.data,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    uploadedBy: req.user.username,
  };

  res.status(201).json({
    id,
    name: file.name,
    size: file.size,
    uploadedAt: pdfStore[id].uploadedAt,
    message: "PDF uploaded successfully",
  });
});

// ─── 3. LIST PDFs ─────────────────────────────────────────────────────────────
app.get("/pdf/list", authenticate, (req, res) => {
  const list = Object.values(pdfStore).map(({ id, name, size, uploadedAt, uploadedBy }) => ({
    id, name, size, uploadedAt, uploadedBy,
  }));
  res.json({ count: list.length, pdfs: list });
});

// ─── 4. PDF PREVIEW (metadata + page count) ───────────────────────────────────
/**
 * GET /pdf/:id/preview
 * Returns: { id, name, pageCount, info, metadata }
 */
app.get("/pdf/:id/preview", authenticate, async (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: "PDF not found" });

  try {
    const data = await pdfParse(pdf.buffer);
    res.json({
      id: pdf.id,
      name: pdf.name,
      pageCount: data.numpages,
      info: data.info,
      metadata: data.metadata,
      textSnippet: data.text.substring(0, 500), // First 500 chars preview
      totalCharacters: data.text.length,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to parse PDF", details: err.message });
  }
});

// ─── 5. SEARCH PDF TEXT ──────────────────────────────────────────────────────
/**
 * POST /pdf/:id/search
 * Body: { query: "invoice number", caseSensitive: false }
 * Returns: { matches, count, pages }
 */
app.post("/pdf/:id/search", authenticate, async (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: "PDF not found" });

  const { query, caseSensitive = false } = req.body;
  if (!query || query.trim() === "") {
    return res.status(400).json({ error: "query field is required" });
  }

  try {
    const data = await pdfParse(pdf.buffer);
    const fullText = data.text;
    const searchText = caseSensitive ? fullText : fullText.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    // Find all occurrences with context
    const matches = [];
    let idx = searchText.indexOf(searchQuery);
    while (idx !== -1) {
      const contextStart = Math.max(0, idx - 80);
      const contextEnd = Math.min(fullText.length, idx + searchQuery.length + 80);
      matches.push({
        position: idx,
        context: fullText.substring(contextStart, contextEnd).replace(/\n/g, " ").trim(),
        matchedText: fullText.substring(idx, idx + query.length),
      });
      idx = searchText.indexOf(searchQuery, idx + 1);
    }

    res.json({
      query,
      caseSensitive,
      count: matches.length,
      found: matches.length > 0,
      matches: matches.slice(0, 20), // Return max 20 matches
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to search PDF", details: err.message });
  }
});

// ─── 6. SIGN PDF ──────────────────────────────────────────────────────────────
/**
 * POST /pdf/:id/sign
 * Body: {
 *   signerName: "John Doe",
 *   signerEmail: "john@example.com",
 *   signatureText: "John Doe",  // text-based sig
 *   page: 1,                    // page number (1-indexed), default last page
 *   x: 50, y: 50                // position (default bottom-right area)
 * }
 */
app.post("/pdf/:id/sign", authenticate, async (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: "PDF not found" });

  const {
    signerName = req.user.username,
    signerEmail = "",
    signatureText = req.user.username,
    page,
    x = 50,
    y = 50,
  } = req.body;

  try {
    const pdfDoc = await PDFDocument.load(pdf.buffer);
    const pages = pdfDoc.getPages();
    const targetPageIndex = page ? Math.min(page - 1, pages.length - 1) : pages.length - 1;
    const targetPage = pages[targetPageIndex];
    const { width, height } = targetPage.getSize();

    const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const sigFontSize = 16;
    const metaFontSize = 9;

    const signedAt = new Date().toISOString();

    // Draw signature box
    targetPage.drawRectangle({
      x: x,
      y: y,
      width: 260,
      height: 60,
      borderColor: rgb(0.2, 0.4, 0.8),
      borderWidth: 1.5,
      color: rgb(0.95, 0.97, 1),
    });

    // Signature text (cursive-style via oblique font)
    targetPage.drawText(signatureText, {
      x: x + 10,
      y: y + 32,
      size: sigFontSize,
      font,
      color: rgb(0.1, 0.2, 0.6),
    });

    // Meta line
    const metaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    targetPage.drawText(`Signed by: ${signerName} | ${signedAt.substring(0, 10)}`, {
      x: x + 10,
      y: y + 12,
      size: metaFontSize,
      font: metaFont,
      color: rgb(0.4, 0.4, 0.4),
    });

    if (signerEmail) {
      targetPage.drawText(signerEmail, {
        x: x + 10,
        y: y + 3,
        size: metaFontSize - 1,
        font: metaFont,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    const signedBuffer = Buffer.from(await pdfDoc.save());
    const signedId = uuidv4();

    signedPdfStore[signedId] = {
      id: signedId,
      originalId: pdf.id,
      name: `signed_${pdf.name}`,
      buffer: signedBuffer,
      signerName,
      signerEmail,
      signatureText,
      signedAt,
      signedBy: req.user.username,
    };

    res.json({
      signedId,
      originalId: pdf.id,
      name: `signed_${pdf.name}`,
      signerName,
      signedAt,
      message: "PDF signed successfully",
      downloadUrl: `/pdf/signed/${signedId}/download`,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to sign PDF", details: err.message });
  }
});

// ─── 7. DOWNLOAD SIGNED PDF ──────────────────────────────────────────────────
app.get("/pdf/signed/:id/download", authenticate, (req, res) => {
  const signed = signedPdfStore[req.params.id];
  if (!signed) return res.status(404).json({ error: "Signed PDF not found" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${signed.name}"`);
  res.send(signed.buffer);
});

// ─── 8. LIST SIGNED PDFs ─────────────────────────────────────────────────────
app.get("/pdf/signed/list", authenticate, (req, res) => {
  const list = Object.values(signedPdfStore).map(
    ({ id, originalId, name, signerName, signerEmail, signedAt, signedBy }) => ({
      id, originalId, name, signerName, signerEmail, signedAt, signedBy,
    })
  );
  res.json({ count: list.length, signedPdfs: list });
});

// ─── 9. UPLOAD TO GOOGLE DRIVE ───────────────────────────────────────────────
/**
 * POST /pdf/:id/drive-upload
 * Uploads the SIGNED pdf (by signedId) to Google Drive
 * Requires GOOGLE_SERVICE_ACCOUNT_JSON env variable
 */
app.post("/pdf/signed/:id/drive-upload", authenticate, async (req, res) => {
  const signed = signedPdfStore[req.params.id];
  if (!signed) return res.status(404).json({ error: "Signed PDF not found" });

  // If no Google credentials, simulate success (for testing without real Drive)
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const fakeUrl = `https://drive.google.com/file/d/mock_${uuidv4()}/view`;
    signedPdfStore[req.params.id].driveUrl = fakeUrl;
    return res.json({
      success: true,
      simulated: true,
      driveUrl: fakeUrl,
      message: "Drive upload simulated (no credentials configured). Set GOOGLE_SERVICE_ACCOUNT_JSON for real uploads.",
    });
  }

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });

    const drive = google.drive({ version: "v3", auth });
    const { Readable } = require("stream");
    const stream = Readable.from(signed.buffer);

    const response = await drive.files.create({
      requestBody: {
        name: signed.name,
        mimeType: "application/pdf",
        parents: process.env.GOOGLE_DRIVE_FOLDER_ID
          ? [process.env.GOOGLE_DRIVE_FOLDER_ID]
          : undefined,
      },
      media: { mimeType: "application/pdf", body: stream },
      fields: "id, webViewLink, webContentLink",
    });

    const driveUrl = response.data.webViewLink;
    signedPdfStore[req.params.id].driveUrl = driveUrl;

    res.json({
      success: true,
      fileId: response.data.id,
      driveUrl,
      downloadUrl: response.data.webContentLink,
      message: "PDF uploaded to Google Drive successfully",
    });
  } catch (err) {
    res.status(500).json({ error: "Google Drive upload failed", details: err.message });
  }
});

// ─── Download original PDF ────────────────────────────────────────────────────
app.get("/pdf/:id/download", authenticate, (req, res) => {
  const pdf = pdfStore[req.params.id];
  if (!pdf) return res.status(404).json({ error: "PDF not found" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${pdf.name}"`);
  res.send(pdf.buffer);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PDF Workflow API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/`);
});

module.exports = app;
