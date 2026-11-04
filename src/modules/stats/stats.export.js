// District statistics export (CSV / Excel) from districtReport(): a few dozen rows, built in memory. Excel has two
// sheets, district-wise (districts under their division, each division with its subtotal) and division-wise; the CSV is
// the district-wise sheet. Every sheet ends in the grand total, which matches the registrations the admin can see.
import { csvLine, sheetRow, xmlEsc, zipWriter } from "../award/award.export.js";

const istDateTime = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

const COUNT_HEAD = ["Registrations", "Verified", "Pending", "Rejected", "Duplicate", "Share %"];
const counts = (r) => [r.total, r.verified, r.pending, r.rejected, r.duplicate, r.share];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Rows of one sheet: { cells, style } where style is "head", "sub" (a subtotal) or undefined
function footer(generatedAt) {
  return [
    { cells: [] },
    { cells: ["", "Pending includes registrations waiting for more information."] },
    { cells: ["", `Generated ${istDateTime.format(generatedAt)} IST`] },
  ];
}

function districtSheet({ divisions, noDistrict, summary }, generatedAt) {
  const rows = [{ cells: ["S.No.", "Division", "Division (English)", "District", "District (English)", ...COUNT_HEAD], style: "head" }];
  let n = 0;
  for (const div of divisions) {
    for (const d of div.districts) rows.push({ cells: [++n, div.division, div.division_en, d.district, d.name_en, ...counts(d)] });
    rows.push({ cells: ["", div.division, div.division_en, "Division total", plural(div.districts.length, "district"), ...counts(div)], style: "sub" });
  }
  rows.push({ cells: ["", "", "", "No district", "Outside Maharashtra / India", ...counts(noDistrict)], style: "sub" });
  rows.push({ cells: ["", "", "", "Grand total", plural(summary.districts, "district"), ...counts(summary)], style: "head" });
  return [...rows, ...footer(generatedAt)];
}

function divisionSheet({ divisions, noDistrict, summary }, generatedAt) {
  const rows = [{ cells: ["S.No.", "Division", "Division (English)", "Districts", ...COUNT_HEAD], style: "head" }];
  divisions.forEach((div, i) => rows.push({ cells: [i + 1, div.division, div.division_en, div.districts.length, ...counts(div)] }));
  rows.push({ cells: ["", "No district", "Outside Maharashtra / India", "", ...counts(noDistrict)], style: "sub" });
  rows.push({ cells: ["", "Grand total", "", summary.districts, ...counts(summary)], style: "head" });
  return [...rows, ...footer(generatedAt)];
}

const withShare = (report) => ({ ...report, summary: { ...report.summary, share: report.summary.total ? 100 : 0 } });

export function toCsv(report, generatedAt = new Date()) {
  return Buffer.from(`﻿${districtSheet(withShare(report), generatedAt).map((r) => csvLine(r.cells)).join("")}`, "utf8");
}

// ---------------------------------------------------------------- XLSX (cell styles: 0 plain, 1 bold on saffron, 2 bold)

const STYLE = { head: ' s="1"', sub: ' s="2"' };

const workbookFiles = (names) => [
  { name: "[Content_Types].xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
  { name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
  { name: "xl/workbook.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
  { name: "xl/_rels/workbook.xml.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
  { name: "xl/styles.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFBECCB"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>` },
];

const sheetXml = (rows, widths) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows.map((r, i) => sheetRow(r.cells, i + 1, STYLE[r.style] ?? "")).join("")}</sheetData></worksheet>`;

export async function toXlsx(report, generatedAt = new Date()) {
  const data = withShare(report);
  const sheets = [
    { name: "District-wise", rows: districtSheet(data, generatedAt), widths: [7, 16, 18, 18, 26, 14, 10, 10, 10, 11, 9] },
    { name: "Division-wise", rows: divisionSheet(data, generatedAt), widths: [7, 18, 26, 10, 14, 10, 10, 10, 11, 9] },
  ];
  const chunks = [];
  const zip = zipWriter({ write: async (chunk) => { chunks.push(chunk); } });
  for (const f of workbookFiles(sheets.map((s) => s.name))) await zip.file(f.name, Buffer.from(f.xml, "utf8"));
  for (const [i, s] of sheets.entries()) await zip.file(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(s.rows, s.widths), "utf8"));
  await zip.finish();
  return Buffer.concat(chunks);
}
