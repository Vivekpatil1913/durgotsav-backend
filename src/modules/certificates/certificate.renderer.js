import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
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
  certNo: { baseline: 842 }, // dark outer border
};

// Same artwork and font on every certificate: read once, so a render only does the participant-specific work.
let assets;
const loadAssets = () =>
  (assets ??= { template: fs.readFileSync(TEMPLATE.file), font: fs.readFileSync(FONT), nameFont: fs.readFileSync(NAME_FONT) });

// Largest size (and, if needed, horizontal scaling) at which `text` fits the line. The current font must be set.
function fitToLine(doc, text, { width, size, minSize, minScaling }) {
  const widthAt = (s, scaling = 100) => doc.fontSize(s).widthOfString(text, { horizontalScaling: scaling });
  let s = size;
  while (s > minSize && widthAt(s) > width) s -= 0.25;
  if (widthAt(s) <= width) return { size: s, scaling: 100, width: widthAt(s) };
  const scaling = Math.max(minScaling, Math.floor((width / widthAt(s)) * 100));
  while (s > 4 && widthAt(s, scaling) > width) s -= 0.25;
  return { size: s, scaling, width: widthAt(s, scaling) };
}

// The data needed for a correct certificate is missing (no photo file, no दुर्गवीर number). Retrying will not help.
export class CertificateDataError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * cert: { registration_id, name, photo_path, certificate_no, durgveer_no }
 * requirePhoto: refuse to render without the participant's photo (emailed certificates). Downloads stay lenient.
 */
export async function renderCertificatePdf(cert, { requirePhoto = false } = {}) {
  const { registration_id: id, name, photo_path: photoPath, certificate_no: certificateNo, durgveer_no: durgveerNo } = cert;
  if (!Number.isInteger(durgveerNo) || durgveerNo < 1) {
    throw new CertificateDataError("NO_DURGVEER_NO", `Certificate of registration ${id} has no दुर्गवीर number`);
  }
  const t = TEMPLATE;
  const { template, font, nameFont } = loadAssets();
  const photo = await loadAsJpeg(photoPath, t.photo.width * 3, t.photo.height * 3, "attention");
  if (!photo && requirePhoto) {
    throw new CertificateDataError("PHOTO_MISSING", `Photo of registration ${id} could not be read (${photoPath ?? "none on record"})`);
  }
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [t.width, t.height],
      margin: 0,
      info: {
        Title: `अभिनंदन पत्र — ${name}`,
        Author: "AMRUT",
        Subject: `Amrut Durgotsav ${EDITION_YEAR}`,
        // Lets anyone holding the file trace it back to exactly one registration
        Keywords: `${formatRegistrationNo(id)}, ${certificateNo}, Durgveer ${durgveerNo}`,
      },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.image(template, 0, 0, { width: t.width, height: t.height });
    doc.registerFont("deva", font);
    doc.registerFont("name", nameFont);

    // Name centred on the blank line, a little larger than the sentence around it; long names are fitted to the line.
    // Narrowing is a transform, not pdfkit's horizontalScaling: pdfkit re-positions Devanagari text after every
    // positioned vowel sign without that scaling, which would leave gaps and push the name past the line.
    doc.font("name");
    const fit = fitToLine(doc, name, t.nameLine);
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
    doc.fillColor("#3B2414").text(name, nameX, t.nameLine.baseline, nameOptions);
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
    const number = toMarathiDigits(durgveerNo);
    let numberSize = t.durgveerNo.size;
    while (numberSize > 10 && doc.fontSize(numberSize).widthOfString(number) > t.durgveerNo.maxWidth) numberSize -= 0.5;
    doc.save().lineWidth(0.45).strokeColor("#000000").fontSize(numberSize).fillColor("#000000")
      .text(number, t.durgveerNo.x, t.durgveerNo.baseline, { baseline: "alphabetic", lineBreak: false, fill: true, stroke: true });
    doc.restore();

    // Certificate number for authenticity check at /certificate (verify)
    // Printed on the dark outer border, hence the light colour. The explicit height stops pdfkit
    // from treating text this close to the page edge as overflow and starting a second page.
    doc.fontSize(11).fillColor("#E9D3A6")
      .text(`Certificate No. ${certificateNo}  ·  Verify at amrutdurgotsav.com/certificate`, 0, t.certNo.baseline,
        { width: t.width, height: 40, align: "center", baseline: "alphabetic", lineBreak: false });

    doc.end();
  });
}
