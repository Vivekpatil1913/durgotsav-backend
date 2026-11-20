// The sample sheet admins download before an import: the exact columns, two example rows, a District drop-down
// (Maharashtra districts) and an instructions sheet.
import ExcelJS from "exceljs";
import { env } from "../../config/env.js";
import { loadDistricts, TEMPLATE_COLUMNS } from "./import.columns.js";

const EXAMPLES = [
  ["Rahul Patil", "9876543210", "Pune", "https://example-bucket.s3.ap-south-1.amazonaws.com/photos/rahul-patil.jpg", ""],
  ["Sneha Jadhav", "9123456780", "Nashik", "", "sneha-jadhav.jpg"],
];

export async function templateWorkbook() {
  const districts = (await loadDistricts()).list;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Amrut Durgotsav";

  const sheet = wb.addWorksheet("Registrations", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = TEMPLATE_COLUMNS.map((header, i) => ({ header, key: `c${i}`, width: [28, 16, 22, 60, 24][i] }));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB45309" } };
  // Mobile numbers as text, so Excel keeps them exactly as typed
  sheet.getColumn(2).numFmt = "@";
  for (const row of EXAMPLES) sheet.addRow(row);

  const list = wb.addWorksheet("Districts");
  list.columns = [{ header: "District", key: "en", width: 28 }, { header: "जिल्हा", key: "mr", width: 24 }];
  list.getRow(1).font = { bold: true };
  for (const d of districts) list.addRow({ en: d.name_en, mr: d.name_mr });
  // Drop-down on the District column (typing a name, in English or Marathi, works as well)
  const range = `Districts!$A$2:$A$${districts.length + 1}`;
  for (let r = 2; r <= 1000; r++) {
    sheet.getCell(`C${r}`).dataValidation = {
      type: "list", allowBlank: true, formulae: [range], showErrorMessage: false,
    };
  }

  const help = wb.addWorksheet("Instructions");
  help.getColumn(1).width = 120;
  [
    "How to fill this sheet",
    "",
    "• One participant per row in the Registrations sheet. Keep the first row (column names) as it is.",
    "• Full Name — mandatory (2 to 150 characters).",
    "• Mobile Number — mandatory, 10 digits (a +91 or 0 prefix and spaces are removed automatically).",
    "• District — mandatory, a Maharashtra district (see the Districts sheet; English or Marathi name).",
    `• Photo URL — a direct public link to a JPG / PNG / WebP image (for example an S3 URL), at most ${env.UPLOAD_MAX_MB} MB.`,
    "• Photo File Name — instead of a URL: the photo's file name inside the .zip you upload together with this sheet.",
    "• A row without a photo is imported without one; a row whose photo cannot be read is reported and not imported.",
    "• Every valid row is approved automatically and gets its certificate. A person already registered with the same",
    "  name and mobile number is skipped. Do not paste images into the sheet — use Photo URL or Photo File Name.",
    "• Large batches: save as .xlsx or .csv; there is no row limit (rows are processed in batches).",
  ].forEach((text, i) => {
    help.getCell(`A${i + 1}`).value = text;
    if (i === 0) help.getCell("A1").font = { bold: true, size: 14 };
  });

  return wb.xlsx.writeBuffer();
}
