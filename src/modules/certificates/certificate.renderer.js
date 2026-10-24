import path from "node:path";
import PDFDocument from "pdfkit";
import { EDITION_YEAR } from "../../config/edition.js";
import { paths } from "../../config/paths.js";
import { loadAsJpeg } from "../../services/image.service.js";
import { toMarathiDigits } from "../../utils/format.js";

const FONT = path.join(paths.certificateAssets, "NotoSansDevanagari.ttf");

// Coordinates are PDF points of the 2026 design ("Durgotsav Certificate.pdf", 1200×855.75 pt).
// template.jpg is that PDF rendered at 2× (2400×1712) with the sample participant number and
// sample photo removed, so it stays sharp when printed and is drawn scaled down to the page size.
// The year is part of the artwork ("दुर्गोत्सव २०२६ मध्ये"): a new edition needs that year's template.jpg.
const TEMPLATE = {
  file: path.join(paths.certificateAssets, "template.jpg"),
  width: 1200,
  height: 855.75,
  nameLine: { x: 318, width: 396, baseline: 543 }, // blank line before "आपण सक्रिय सहभाग"
  photo: { x: 124, y: 671, width: 161, height: 76, radius: 8 }, // frame above "मी आणि माझा दुर्ग"
  number: { x: 212, baseline: 789 }, // after "सहभागी क्र."
  certNo: { baseline: 842 }, // dark outer border
};

export async function renderCertificatePdf({ registration_id: id, name, photo_path: photoPath, certificate_no: certificateNo }) {
  const photo = await loadAsJpeg(photoPath, TEMPLATE.photo.width * 3, TEMPLATE.photo.height * 3);
  return new Promise((resolve, reject) => {
    const t = TEMPLATE;
    const doc = new PDFDocument({
      size: [t.width, t.height],
      margin: 0,
      info: { Title: `अभिनंदन पत्र — ${name}`, Author: "AMRUT", Subject: `Amrut Durgotsav ${EDITION_YEAR}` },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.image(t.file, 0, 0, { width: t.width, height: t.height });
    doc.registerFont("deva", FONT);
    doc.font("deva");

    // Name on the blank line, shrunk to fit long names
    let size = 26;
    while (size > 13 && doc.fontSize(size).widthOfString(name) > t.nameLine.width) size -= 1;
    doc.fontSize(size).fillColor("#3B2414")
      .text(name, t.nameLine.x, t.nameLine.baseline, { width: t.nameLine.width, align: "center", baseline: "alphabetic", lineBreak: false });

    if (photo) {
      const { x, y, width, height, radius } = t.photo;
      doc.save().roundedRect(x, y, width, height, radius).clip();
      doc.image(photo, x, y, { width, height });
      doc.restore();
    }

    // Unique participant number (registration id) in the slot left blank on the template
    doc.fontSize(17).fillColor("#000000")
      .text(toMarathiDigits(id), t.number.x, t.number.baseline, { baseline: "alphabetic", lineBreak: false });

    // Certificate number for authenticity check at /certificate (verify)
    // Printed on the dark outer border, hence the light colour. The explicit height stops pdfkit
    // from treating text this close to the page edge as overflow and starting a second page.
    doc.fontSize(11).fillColor("#E9D3A6")
      .text(`Certificate No. ${certificateNo}  ·  Verify at amrutdurgotsav.com/certificate`, 0, t.certNo.baseline,
        { width: t.width, height: 40, align: "center", baseline: "alphabetic", lineBreak: false });

    doc.end();
  });
}
