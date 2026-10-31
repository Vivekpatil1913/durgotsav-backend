// What the certificate prints, checked on the rendered image (the PDF draws the same text from the same layout).
// No database: the renderer works from the certificate's fields alone.
import "./helpers.js";
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import sharp from "sharp";
import { paths } from "../src/config/paths.js";
import { renderCertificateImage, renderCertificatePdf } from "../src/modules/certificates/certificate.renderer.js";

const cert = { registration_id: 10000, name: "hello", photo_path: null, certificate_no: "AMRUT-DGT26-010000", durgveer_no: 10000 };
const template = path.join(paths.certificateAssets, "template.jpg");

// Pixels inside a box of the 2400×1712 image where the certificate clearly differs from the empty template (ink, not
// JPEG noise)
async function printedPixels(image, box) {
  const area = (input) => sharp(input).resize(2400, 1712, { fit: "fill" }).extract(box).greyscale().raw().toBuffer();
  const [printed, blank] = await Promise.all([area(image), area(template)]);
  let count = 0;
  for (let i = 0; i < printed.length; i++) if (Math.abs(printed[i] - blank[i]) > 64) count++;
  return count;
}

describe("certificate layout", () => {
  test("nothing is printed under the AMRUT logo (no QR code, registration number or date)", async () => {
    const image = await renderCertificateImage(cert);
    // x 900–1110 pt, y 190–360 pt at 2×: where the QR code and its three lines used to be
    const under = await printedPixels(image, { left: 1800, top: 380, width: 420, height: 340 });
    assert.ok(under < 50, `${under} printed pixels under the logo`);
  });

  test("the name and the certificate number are still printed", async () => {
    const image = await renderCertificateImage(cert);
    const name = await printedPixels(image, { left: 636, top: 1040, width: 796, height: 60 });
    const footer = await printedPixels(image, { left: 600, top: 1650, width: 1200, height: 40 });
    assert.ok(name > 500, `name line: ${name} printed pixels`);
    assert.ok(footer > 500, `certificate number: ${footer} printed pixels`);
    const pdf = await renderCertificatePdf(cert);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });
});
