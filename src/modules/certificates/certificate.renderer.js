import path from "node:path";
import PDFDocument from "pdfkit";
import { paths } from "../../config/paths.js";
import { loadAsJpeg } from "../../services/image.service.js";
import { toMarathiDigits } from "../../utils/format.js";

const FONT = path.join(paths.certificateAssets, "NotoSansDevanagari.ttf");

// Coordinates are template pixels: template.jpg is 923×655 and the PDF page uses the same units.
// Carried over from the 2025 system, where they were measured against this exact 2026 template.
const TEMPLATE = {
  file: path.join(paths.certificateAssets, "template.jpg"),
  width: 923,
  height: 655,
  nameLine: { x: 245, width: 305, baseline: 416 }, // blank line before "आपण सक्रिय सहभाग"
  photo: { cx: 153, cy: 535, r: 27 }, // round placeholder above "मी आणि माझा दुर्ग"
  number: { x: 167, y: 586, baseline: 601, coverWidth: 48, coverHeight: 20, background: "#E5D0C1" }, // after "सहभागी क्र."
  certNo: { baseline: 646 },
};

export async function renderCertificatePdf({ registration_id: id, name, photo_path: photoPath, certificate_no: certificateNo }) {
  const photo = await loadAsJpeg(photoPath, 160);
  return new Promise((resolve, reject) => {
    const t = TEMPLATE;
    const doc = new PDFDocument({
      size: [t.width, t.height],
      margin: 0,
      info: { Title: `अभिनंदन पत्र — ${name}`, Author: "AMRUT", Subject: "Amrut Durgotsav 2026" },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.image(t.file, 0, 0, { width: t.width, height: t.height });
    doc.registerFont("deva", FONT);
    doc.font("deva");

    // Name on the blank line, shrunk to fit long names
    let size = 20;
    while (size > 11 && doc.fontSize(size).widthOfString(name) > t.nameLine.width) size -= 1;
    doc.fontSize(size).fillColor("#3B2414")
      .text(name, t.nameLine.x, t.nameLine.baseline, { width: t.nameLine.width, align: "center", baseline: "alphabetic", lineBreak: false });

    if (photo) {
      const { cx, cy, r } = t.photo;
      doc.save().circle(cx, cy, r).clip();
      doc.image(photo, cx - r, cy - r, { width: r * 2, height: r * 2 });
      doc.restore();
    }

    // Replace the sample participant number printed on the template
    const n = t.number;
    doc.rect(n.x - 3, n.y, n.coverWidth, n.coverHeight).fill(n.background);
    doc.fontSize(12).fillColor("#1F1A17").text(toMarathiDigits(id), n.x, n.baseline, { baseline: "alphabetic", lineBreak: false });

    // Certificate number for authenticity check at /certificate (verify)
    // Printed on the dark outer border, hence the light colour
    doc.fontSize(8).fillColor("#E9D3A6")
      .text(`Certificate No. ${certificateNo}  ·  Verify at amrutdurgotsav.com/certificate`, 0, t.certNo.baseline,
        { width: t.width, align: "center", baseline: "alphabetic", lineBreak: false });

    doc.end();
  });
}
