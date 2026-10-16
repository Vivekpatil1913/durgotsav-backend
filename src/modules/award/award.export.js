// Nomination exports (CSV / Excel / PDF). CSV and Excel stream cursor batches from streamExportRows() straight to
// the response; the PDF (capped at EXPORT_LIMITS.pdf rows) is laid out from the collected rows.
import path from "node:path";
import zlib from "node:zlib";
import PDFDocument from "pdfkit";
import { paths } from "../../config/paths.js";
import { CATEGORIES, STATUSES, workLabel } from "./award.constants.js";

const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

export const COLUMNS = [
  ["reference_no", "संदर्भ क्रमांक / Reference"],
  ["category", "विभाग / Category"],
  ["nominee_name", "नामनिर्देशित / Nominee"],
  ["mobile", "मोबाईल / Mobile"],
  ["email", "ई-मेल / Email"],
  ["nominator_name", "नामनिर्देशक / Nominator"],
  ["nominator_mobile", "नामनिर्देशक मोबाईल"],
  ["district", "जिल्हा / District"],
  ["taluka", "तालुका / Taluka"],
  ["work_categories", "कार्यक्षेत्र / Work categories"],
  ["work_started_year", "कार्य सुरू वर्ष"],
  ["status", "स्थिती / Status"],
  ["submitted_at", "सादर दिनांक / Submitted"],
];

export function displayRow(r) {
  return {
    ...r,
    category: CATEGORIES[r.category]?.mr ?? r.category,
    status: `${STATUSES[r.status]?.mr ?? r.status} (${STATUSES[r.status]?.en ?? ""})`,
    work_categories: (r.work_categories ?? []).map((k) => workLabel(r.category, k)).join("; "),
    submitted_at: r.submitted_at ? istDateTime.format(new Date(r.submitted_at)) : "",
  };
}

// Formula-injection safe CSV cell
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvLine = (cells) => `${cells.map(csvCell).join(",")}\r\n`;

/**
 * Wraps a writable (the HTTP response) so each write waits for the socket to drain.
 * Throws once the client has gone away, which stops the database cursor feeding it.
 */
export function responseSink(stream) {
  const gone = () => Object.assign(new Error("Client closed the download"), { aborted: true });
  return {
    write(chunk) {
      if (stream.destroyed || stream.writableEnded) return Promise.reject(gone());
      if (stream.write(chunk)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = (err) => { stream.off("drain", done); stream.off("close", done); err || stream.destroyed ? reject(gone()) : resolve(); };
        stream.on("drain", done);
        stream.on("close", done);
      });
    },
  };
}

// Streaming writers: start() → rows(batch) for every cursor batch → finish(). Memory stays at one batch.

export function csvWriter(sink) {
  return {
    start: () => sink.write(Buffer.from(`﻿${csvLine(COLUMNS.map(([, l]) => l))}`, "utf8")),
    rows: (rows) => sink.write(Buffer.from(rows.map(displayRow).map((r) => csvLine(COLUMNS.map(([k]) => r[k]))).join(""), "utf8")),
    finish: async () => {},
  };
}

// ---------------------------------------------------------------- XLSX (minimal OOXML package, inline strings, streamed)

const xmlEsc = (s) => String(s ?? "")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const SYNC_FLUSH = { finishFlush: zlib.constants.Z_SYNC_FLUSH };

/**
 * Writes a ZIP archive straight to `sink`. Small files go in whole; one entry can be streamed: its chunks are
 * deflated independently with a sync flush (non-final blocks that concatenate into one valid deflate stream) and its
 * CRC/sizes follow in a data descriptor, so nothing has to be held in memory.
 */
function zipWriter(sink) {
  const central = [];
  let offset = 0;
  const emit = async (buf) => { offset += buf.length; await sink.write(buf); };

  const localHeader = (nameBuf, flags, crc, csize, size) => {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt32LE(0, 10);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(csize, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    return h;
  };

  return {
    async file(name, data) {
      const nameBuf = Buffer.from(name, "utf8");
      const deflated = zlib.deflateRawSync(data);
      const entry = { nameBuf, flags: 0x0800, crc: zlib.crc32(data), csize: deflated.length, size: data.length, at: offset };
      central.push(entry);
      await emit(localHeader(nameBuf, entry.flags, entry.crc, entry.csize, entry.size));
      await emit(nameBuf);
      await emit(deflated);
    },
    async stream(name) {
      const nameBuf = Buffer.from(name, "utf8");
      const entry = { nameBuf, flags: 0x0808, crc: 0, csize: 0, size: 0, at: offset }; // UTF-8 names + data descriptor
      central.push(entry);
      await emit(localHeader(nameBuf, entry.flags, 0, 0, 0));
      await emit(nameBuf);
      return {
        async write(data) {
          entry.crc = zlib.crc32(data, entry.crc);
          entry.size += data.length;
          const d = zlib.deflateRawSync(data, SYNC_FLUSH);
          entry.csize += d.length;
          await emit(d);
        },
        async end() {
          const last = zlib.deflateRawSync(Buffer.alloc(0)); // final empty block
          entry.csize += last.length;
          await emit(last);
          const dd = Buffer.alloc(16);
          dd.writeUInt32LE(0x08074b50, 0);
          dd.writeUInt32LE(entry.crc >>> 0, 4);
          dd.writeUInt32LE(entry.csize, 8);
          dd.writeUInt32LE(entry.size, 12);
          await emit(dd);
        },
      };
    },
    async finish() {
      const start = offset;
      for (const e of central) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(e.flags, 8);
        c.writeUInt16LE(8, 10);
        c.writeUInt32LE(0, 12);
        c.writeUInt32LE(e.crc >>> 0, 16);
        c.writeUInt32LE(e.csize, 20);
        c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nameBuf.length, 28);
        c.writeUInt32LE(e.at, 42);
        await emit(c);
        await emit(e.nameBuf);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(offset - start, 12);
      end.writeUInt32LE(start, 16);
      await emit(end);
    },
  };
}

const XLSX_STATIC = (sheetName) => [
  { name: "[Content_Types].xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
  { name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
  { name: "xl/workbook.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
  { name: "xl/_rels/workbook.xml.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
  { name: "xl/styles.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBECCB"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs></styleSheet>` },
];

const XLSX_WIDTHS = [18, 16, 30, 13, 26, 24, 14, 16, 16, 40, 12, 26, 20];

const sheetRow = (cells, rowNo, style = "") => `<row r="${rowNo}">${cells.map((v, ci) => {
  const ref = `${colName(ci)}${rowNo}`;
  return typeof v === "number"
    ? `<c r="${ref}"${style}><v>${v}</v></c>`
    : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}).join("")}</row>`;

export function xlsxWriter(sink, sheetName = "Nominations") {
  const zip = zipWriter(sink);
  let sheet;
  let rowNo = 1;
  return {
    async start() {
      for (const f of XLSX_STATIC(sheetName)) await zip.file(f.name, Buffer.from(f.xml, "utf8"));
      sheet = await zip.stream("xl/worksheets/sheet1.xml");
      await sheet.write(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${XLSX_WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${sheetRow(COLUMNS.map(([, l]) => l), 1, ' s="1"')}`, "utf8"));
    },
    async rows(rows) {
      const xml = rows.map(displayRow).map((r) => sheetRow(COLUMNS.map(([k]) => r[k]), ++rowNo)).join("");
      await sheet.write(Buffer.from(xml, "utf8"));
    },
    async finish() {
      await sheet.write(Buffer.from(`</sheetData><autoFilter ref="A1:${colName(COLUMNS.length - 1)}${rowNo}"/></worksheet>`, "utf8"));
      await sheet.end();
      await zip.finish();
    },
  };
}

// ---------------------------------------------------------------- PDF (landscape table)

const FONT = path.join(paths.certificateAssets, "NotoSansDevanagari.ttf");
const PDF_COLS = [
  ["reference_no", "संदर्भ क्र.", 92],
  ["category", "विभाग", 70],
  ["nominee_name", "नामनिर्देशित", 130],
  ["nominator_name", "नामनिर्देशक", 100],
  ["mobile", "मोबाईल", 64],
  ["district", "जिल्हा", 70],
  ["taluka", "तालुका", 70],
  ["status", "स्थिती", 88],
  ["submitted_at", "सादर दिनांक", 86],
];

export function toPdf(rows, { title, filters }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28, info: { Title: title, Author: "AMRUT" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("deva", FONT);
    doc.font("deva");

    const left = doc.page.margins.left;
    const bottom = doc.page.height - doc.page.margins.bottom;
    const header = () => {
      let x = left;
      const y = doc.y;
      doc.rect(left, y - 2, PDF_COLS.reduce((s, c) => s + c[2], 0), 18).fill("#FBECCB");
      doc.fillColor("#3B2414").fontSize(8.5);
      for (const [, label, w] of PDF_COLS) {
        doc.text(label, x + 3, y + 1, { width: w - 6, lineBreak: false, ellipsis: true });
        x += w;
      }
      doc.y = y + 20;
    };

    doc.fontSize(15).fillColor("#3B2414").text(title);
    doc.fontSize(8.5).fillColor("#6E5843")
      .text(`Generated ${istDateTime.format(new Date())} IST · ${rows.length} records${filters ? ` · Filters: ${filters}` : ""}`);
    doc.moveDown(0.6);
    header();

    for (const r of rows.map(displayRow)) {
      doc.fontSize(8);
      const heights = PDF_COLS.map(([k, , w]) => doc.heightOfString(String(r[k] ?? ""), { width: w - 6 }));
      const h = Math.min(Math.max(...heights), 40) + 6;
      if (doc.y + h > bottom) {
        doc.addPage();
        header();
      }
      let x = left;
      const y = doc.y;
      doc.fillColor("#24170D");
      for (const [k, , w] of PDF_COLS) {
        doc.text(String(r[k] ?? ""), x + 3, y + 2, { width: w - 6, height: h - 4, ellipsis: true });
        x += w;
      }
      doc.moveTo(left, y + h).lineTo(x, y + h).lineWidth(0.4).strokeColor("#E6D2AF").stroke();
      doc.y = y + h + 1;
    }
    if (!rows.length) doc.fontSize(10).fillColor("#6E5843").text("No nominations match these filters.");
    doc.end();
  });
}
