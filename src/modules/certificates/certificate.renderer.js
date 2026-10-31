import fs from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import sharp from "sharp";
import { EDITION_YEAR } from "../../config/edition.js";
import { paths } from "../../config/paths.js";
import { loadAsJpeg } from "../../services/image.service.js";
import { formatRegistrationNo, toMarathiDigits } from "../../utils/format.js";

const FONT = path.join(paths.certificateAssets, "NotoSansDevanagari.ttf");
// Participant name: Mukta SemiBold (SIL Open Font License, OFL-Mukta.txt). The certificate's sentence is set in
// Utsaah Bold, a Microsoft font that may not be installed on the server; Mukta SemiBold is the closest open font
// (same letter shapes, stroke weight within 2 %, Devanagari + Latin).
const NAME_FONT = path.join(paths.certificateAssets, "Mukta-SemiBold.ttf");

// Coordinates are PDF points of the 2026 design ("Durgotsav Certificate Sign.pdf", 1200×855.75 pt).
// template.jpg is that PDF rendered at 2× (2400×1712), which the designer supplied with the photo area and the
// दुर्गवीर number left empty; it is drawn scaled down to the page size, so it stays sharp when printed.
// The year is part of the artwork ("दुर्गोत्सव २०२६ मध्ये"): a new edition needs that year's template.jpg.
const TEMPLATE = {
  file: path.join(paths.certificateAssets, "template.jpg"),
  width: 1200,
  height: 855.75,
  // Blank line before "आपण सक्रिय सहभाग". Its rule (y 549–551.5) is one line pitch (36 pt, the paragraph's is 37.3)
  // below the sentence above, so the name sits ON the rule as the next line of the paragraph: baseline just above it,
  // leaving 11–13 pt to the sentence above, like the paragraph's own 10 pt between lines.
  // Mukta at 21.2 pt has the same letter height as the sentence's Utsaah Bold at 27.82 pt (Utsaah is drawn small for
  // its point size); the name is 10 % larger (23.3 pt) so it stands out.
  // Long names first get smaller down to minSize, then narrower down to minScaling %, and only names far beyond
  // normal length go smaller still.
  // rule: where hanging vowel signs (ु ू ृ) cross it, the rule is broken around them in the paper colour (skip-ink).
  nameLine: {
    x: 318, width: 398, baseline: 547, size: 23.3, minSize: 16.5, minScaling: 80,
    rule: { top: 548.5, height: 3.5, paper: "#ECE8E3", gap: 1.3 },
  },
  photo: { x: 124, y: 670.5, width: 161, height: 77, radius: 6 }, // empty area above "मी आणि माझा दुर्ग"
  // after "दुर्गवीर क्र." (same baseline); free paper up to the seal at x≈495, so longer numbers only shrink past maxWidth
  durgveerNo: { x: 206, baseline: 788, size: 17, maxWidth: 150 },
  certNo: { baseline: 842, size: 11 }, // dark outer border
  // Blank paper under the AMRUT logo and left of the gold border line (x≈1120), above the paragraph (y≈415):
  // verification QR code, registration number and the registration's date and time (SRS v2.1 §5)
  stamp: { cx: 1003, qrTop: 205, qrSize: 96, quiet: 4, lines: [316, 333, 348], size: 9.5, captionSize: 8.5, color: "#4A3523" },
};

const NAME_COLOR = "#3B2414";
const QR_COLOR = "#1E140C";
const CERT_NO_COLOR = "#E9D3A6";

// Same artwork and fonts on every certificate: read once, so a render only does the participant-specific work.
let assets;
const loadAssets = () => {
  if (!assets) {
    const font = fs.readFileSync(FONT);
    const nameFont = fs.readFileSync(NAME_FONT);
    assets = { template: fs.readFileSync(TEMPLATE.file), font, nameFont, glyphs: { deva: fontkit.create(font), name: fontkit.create(nameFont) } };
  }
  return assets;
};

// Largest size (and, if needed, horizontal scaling) at which `text` fits the line. widthAt(size, scaling %) measures.
function fitToLine(widthAt, { width, size, minSize, minScaling }) {
  let s = size;
  while (s > minSize && widthAt(s) > width) s -= 0.25;
  if (widthAt(s) <= width) return { size: s, scaling: 100, width: widthAt(s) };
  const scaling = Math.max(minScaling, Math.floor((width / widthAt(s)) * 100));
  while (s > 4 && widthAt(s, scaling) > width) s -= 0.25;
  return { size: s, scaling, width: widthAt(s, scaling) };
}

// "दिनांक: ०५/११/२०२६ · वेळ: १४:३२" in Indian time; null when the registration time is unknown
const IST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function registeredLine(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(IST.formatToParts(d).map((p) => [p.type, p.value]));
  return toMarathiDigits(`दिनांक: ${parts.day}/${parts.month}/${parts.year} · वेळ: ${parts.hour}:${parts.minute}`);
}

// Everything printed on the certificate besides the artwork, in one place for the PDF and the image
function printedText(cert) {
  const { stamp } = TEMPLATE;
  return {
    durgveer: toMarathiDigits(cert.durgveer_no),
    certNo: `Certificate No. ${cert.certificate_no}  ·  Verify at amrutdurgotsav.com/certificate`,
    stampLines: [
      { text: "पडताळणीसाठी QR स्कॅन करा", size: stamp.captionSize },
      { text: `नोंदणी क्र. ${formatRegistrationNo(cert.registration_id)}`, size: stamp.size },
      { text: registeredLine(cert.registered_at), size: stamp.size },
    ].map((l, i) => ({ ...l, baseline: stamp.lines[i] })).filter((l) => l.text),
  };
}

const qrModules = (cert) => QRCode.create(cert.verify_url || cert.certificate_no, { errorCorrectionLevel: "M" }).modules;

// The data needed for a correct certificate is missing (no photo file, no दुर्गवीर number). Retrying will not help.
export class CertificateDataError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function prepare(cert, { requirePhoto }) {
  const { registration_id: id, durgveer_no: durgveerNo, photo_path: photoPath } = cert;
  if (!Number.isInteger(durgveerNo) || durgveerNo < 1) {
    throw new CertificateDataError("NO_DURGVEER_NO", `Certificate of registration ${id} has no दुर्गवीर number`);
  }
  const t = TEMPLATE.photo;
  const photo = await loadAsJpeg(photoPath, t.width * 3, t.height * 3, "attention");
  if (!photo && requirePhoto) {
    throw new CertificateDataError("PHOTO_MISSING", `Photo of registration ${id} could not be read (${photoPath ?? "none on record"})`);
  }
  return photo;
}

// ---------------------------------------------------------------- PDF

// pdfkit embeds a Buffer image again on every doc.image call: open the artwork once per document, so a
// several-page "download all" PDF carries it once
const templateImages = new WeakMap();
function templateImage(doc) {
  if (!templateImages.has(doc)) templateImages.set(doc, doc.openImage(loadAssets().template));
  return templateImages.get(doc);
}

function drawPage(doc, cert, photo) {
  const t = TEMPLATE;
  const text = printedText(cert);
  doc.image(templateImage(doc), 0, 0, { width: t.width, height: t.height });

  // Name centred on the blank line, a little larger than the sentence around it; long names are fitted to the line.
  // Narrowing is a transform, not pdfkit's horizontalScaling: pdfkit re-positions Devanagari text after every
  // positioned vowel sign without that scaling, which would leave gaps and push the name past the line.
  const { name } = cert;
  doc.font("name");
  const fit = fitToLine((s, scaling = 100) => doc.fontSize(s).widthOfString(name, { horizontalScaling: scaling }), t.nameLine);
  const nameX = t.nameLine.x + (t.nameLine.width - fit.width) / 2;
  const nameOptions = { baseline: "alphabetic", lineBreak: false };
  const { rule } = t.nameLine;
  doc.save();
  if (fit.scaling !== 100) doc.scale(fit.scaling / 100, 1, { origin: [nameX, t.nameLine.baseline] });
  doc.fontSize(fit.size);
  // Skip-ink: a paper-coloured outline of the name, clipped to the rule's band, opens a small gap in the rule
  // wherever a hanging vowel sign crosses it; nothing outside that band is touched
  doc.save().rect(0, rule.top, t.width, rule.height).clip();
  doc.lineWidth(rule.gap * 2).lineJoin("round").strokeColor(rule.paper).fillColor(rule.paper)
    .text(name, nameX, t.nameLine.baseline, { ...nameOptions, fill: true, stroke: true });
  doc.restore();
  doc.fillColor(NAME_COLOR).text(name, nameX, t.nameLine.baseline, nameOptions);
  doc.restore();
  doc.font("deva");

  if (photo) {
    const { x, y, width, height, radius } = t.photo;
    doc.save().roundedRect(x, y, width, height, radius).clip();
    doc.image(photo, x, y, { width, height });
    doc.restore();
  }

  // दुर्गवीर number: unique per certificate, assigned once from a database sequence.
  // Bold like the "दुर्गवीर क्र." label: fill + a thin stroke (pdfkit embeds only the font's default Regular outlines).
  let numberSize = t.durgveerNo.size;
  while (numberSize > 10 && doc.fontSize(numberSize).widthOfString(text.durgveer) > t.durgveerNo.maxWidth) numberSize -= 0.5;
  doc.save().lineWidth(0.45).strokeColor("#000000").fontSize(numberSize).fillColor("#000000")
    .text(text.durgveer, t.durgveerNo.x, t.durgveerNo.baseline, { baseline: "alphabetic", lineBreak: false, fill: true, stroke: true });
  doc.restore();

  // Verification QR (vector modules on a white quiet zone), registration number and date/time under the logo
  const { stamp } = t;
  const modules = qrModules(cert);
  const cell = stamp.qrSize / modules.size;
  const qrX = stamp.cx - stamp.qrSize / 2;
  doc.save().roundedRect(qrX - stamp.quiet, stamp.qrTop - stamp.quiet, stamp.qrSize + stamp.quiet * 2, stamp.qrSize + stamp.quiet * 2, 3).fill("#FFFFFF");
  for (let r = 0; r < modules.size; r++) {
    for (let c = 0; c < modules.size; c++) if (modules.get(r, c)) doc.rect(qrX + c * cell, stamp.qrTop + r * cell, cell + 0.02, cell + 0.02);
  }
  doc.fill(QR_COLOR).restore();
  for (const line of text.stampLines) {
    doc.fontSize(line.size);
    doc.fillColor(stamp.color).text(line.text, stamp.cx - doc.widthOfString(line.text) / 2, line.baseline, { baseline: "alphabetic", lineBreak: false });
  }

  // Certificate number for authenticity check at /certificate (verify)
  // Printed on the dark outer border, hence the light colour. The explicit height stops pdfkit
  // from treating text this close to the page edge as overflow and starting a second page.
  doc.fontSize(t.certNo.size).fillColor(CERT_NO_COLOR)
    .text(text.certNo, 0, t.certNo.baseline, { width: t.width, height: 40, align: "center", baseline: "alphabetic", lineBreak: false });
}

function pdfDocument(info) {
  const { font, nameFont } = loadAssets();
  const doc = new PDFDocument({ size: [TEMPLATE.width, TEMPLATE.height], margin: 0, autoFirstPage: false, info: { Author: "AMRUT", Subject: `Amrut Durgotsav ${EDITION_YEAR}`, ...info } });
  doc.registerFont("deva", font);
  doc.registerFont("name", nameFont);
  const done = new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  return { doc, done };
}

const addPage = (doc) => doc.addPage({ size: [TEMPLATE.width, TEMPLATE.height], margin: 0 });

/**
 * cert: { registration_id, name, photo_path, certificate_no, durgveer_no, registered_at, verify_url }
 * requirePhoto: refuse to render without the participant's photo (emailed certificates). Downloads stay lenient.
 */
export async function renderCertificatePdf(cert, { requirePhoto = false } = {}) {
  const photo = await prepare(cert, { requirePhoto });
  const { doc, done } = pdfDocument({
    Title: `अभिनंदन पत्र — ${cert.name}`,
    // Lets anyone holding the file trace it back to exactly one registration
    Keywords: `${formatRegistrationNo(cert.registration_id)}, ${cert.certificate_no}, Durgveer ${cert.durgveer_no}`,
  });
  addPage(doc);
  drawPage(doc, cert, photo);
  doc.end();
  return done;
}

// Several certificates (one mobile number's registrations) as the pages of one PDF: "download all"
export async function renderCertificatesPdf(certs, { requirePhoto = false } = {}) {
  const photos = await Promise.all(certs.map((c) => prepare(c, { requirePhoto })));
  const { doc, done } = pdfDocument({
    Title: "अभिनंदन पत्रे",
    Keywords: certs.map((c) => c.certificate_no).join(", "),
  });
  certs.forEach((cert, i) => {
    addPage(doc);
    drawPage(doc, cert, photos[i]);
  });
  doc.end();
  return done;
}

// ---------------------------------------------------------------- high-resolution image

// The image is the template at its own 2× size. Text is drawn as glyph outlines laid out by fontkit — the same
// shaping engine pdfkit uses — so the image matches the PDF without the server needing any installed fonts.
const SCALE = 2;
const px = (pt) => +(pt * SCALE).toFixed(2);

function textPath(font, text, { x, baseline, size, scaling = 100 }) {
  const run = font.layout(text);
  const k = (size / font.unitsPerEm) * SCALE;
  const kx = k * (scaling / 100);
  let pen = px(x);
  let d = "";
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    d += glyph.path.scale(kx, -k).translate(pen + pos.xOffset * kx, px(baseline) - pos.yOffset * k).toSVG();
    pen += pos.xAdvance * kx;
  });
  return d;
}

const widthOf = (font, text, size, scaling = 100) => (font.layout(text).advanceWidth / font.unitsPerEm) * size * (scaling / 100);

export async function renderCertificateImage(cert, { requirePhoto = false, quality = 92 } = {}) {
  const photo = await prepare(cert, { requirePhoto });
  const t = TEMPLATE;
  const { template, glyphs } = loadAssets();
  const text = printedText(cert);
  const W = Math.round(t.width * SCALE);
  const H = Math.round(t.height * SCALE);

  const fit = fitToLine((s, scaling = 100) => widthOf(glyphs.name, cert.name, s, scaling), t.nameLine);
  const nameD = textPath(glyphs.name, cert.name, { x: t.nameLine.x + (t.nameLine.width - fit.width) / 2, baseline: t.nameLine.baseline, size: fit.size, scaling: fit.scaling });
  const { rule } = t.nameLine;

  let numberSize = t.durgveerNo.size;
  while (numberSize > 10 && widthOf(glyphs.deva, text.durgveer, numberSize) > t.durgveerNo.maxWidth) numberSize -= 0.5;

  const { stamp } = t;
  const modules = qrModules(cert);
  const cell = px(stamp.qrSize / modules.size);
  const qrX = px(stamp.cx - stamp.qrSize / 2);
  const qrY = px(stamp.qrTop);
  let qrD = "";
  for (let r = 0; r < modules.size; r++) {
    for (let c = 0; c < modules.size; c++) if (modules.get(r, c)) qrD += `M${(qrX + c * cell).toFixed(2)} ${(qrY + r * cell).toFixed(2)}h${cell + 0.05}v${cell + 0.05}h-${cell + 0.05}z`;
  }
  const lines = text.stampLines.map((l) => `<path fill="${stamp.color}" d="${textPath(glyphs.deva, l.text, { x: stamp.cx - widthOf(glyphs.deva, l.text, l.size) / 2, baseline: l.baseline, size: l.size })}"/>`);
  const certNoWidth = widthOf(glyphs.deva, text.certNo, t.certNo.size);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs><clipPath id="rule"><rect x="0" y="${px(rule.top)}" width="${W}" height="${px(rule.height)}"/></clipPath></defs>
    <path d="${nameD}" clip-path="url(#rule)" fill="${rule.paper}" stroke="${rule.paper}" stroke-width="${px(rule.gap * 2)}" stroke-linejoin="round"/>
    <path d="${nameD}" fill="${NAME_COLOR}"/>
    <path d="${textPath(glyphs.deva, text.durgveer, { x: t.durgveerNo.x, baseline: t.durgveerNo.baseline, size: numberSize })}" fill="#000" stroke="#000" stroke-width="${px(0.45)}"/>
    <rect x="${qrX - px(stamp.quiet)}" y="${qrY - px(stamp.quiet)}" width="${px(stamp.qrSize + stamp.quiet * 2)}" height="${px(stamp.qrSize + stamp.quiet * 2)}" rx="${px(3)}" fill="#fff"/>
    <path d="${qrD}" fill="${QR_COLOR}" shape-rendering="crispEdges"/>
    ${lines.join("")}
    <path d="${textPath(glyphs.deva, text.certNo, { x: (t.width - certNoWidth) / 2, baseline: t.certNo.baseline, size: t.certNo.size })}" fill="${CERT_NO_COLOR}"/>
  </svg>`;

  const layers = [{ input: Buffer.from(svg), top: 0, left: 0 }];
  if (photo) {
    const { x, y, width, height, radius } = t.photo;
    const [w, h] = [px(width), px(height)].map(Math.round);
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${px(radius)}" fill="#fff"/></svg>`);
    const rounded = await sharp(photo).resize(w, h, { fit: "cover", position: "attention" })
      .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    layers.unshift({ input: rounded, left: Math.round(px(x)), top: Math.round(px(y)) });
  }
  // Plain libjpeg, not mozjpeg: mozjpeg's trellis quantisation and progressive scans encode this image about five
  // times slower for only ~5 % fewer bytes, time a participant waits for on every download
  return sharp(template).resize(W, H, { fit: "fill" }).composite(layers)
    .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: false }).toBuffer();
}
