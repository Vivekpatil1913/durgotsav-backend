// Reads an import sheet row by row without loading it whole: .xlsx through a streaming worksheet parser (xlsx.stream.js),
// .csv through a small streaming parser. Memory stays flat whether the sheet has 150 rows or millions. Only text is
// read — photos are given as URLs or ZIP file names, never embedded in the workbook.
import fs from "node:fs";
import { cellText, ImportFileError, mapHeader } from "./import.columns.js";
import { xlsxRows } from "./xlsx.stream.js";

export const SHEET_TYPES = { ".xlsx": "xlsx", ".csv": "csv" };

// Raw rows of the first worksheet: { rowNo, cells } with cells as a 0-based array of raw values
async function* xlsxRawRows(file) {
  try {
    yield* xlsxRows(file);
  } catch (err) {
    if (err instanceof ImportFileError) throw err;
    throw new ImportFileError(`The Excel file could not be read (${err.message}). Save it as .xlsx (Excel Workbook) and try again`);
  }
}

/**
 * CSV (RFC 4180: quoted fields may hold commas, quotes and line breaks). The delimiter — comma, semicolon or tab — is
 * taken from the header line. A UTF-8 byte-order mark is skipped.
 */
async function* csvRawRows(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 256 * 1024 });
  let delimiter = null;
  let field = "";
  let row = [];
  let inQuotes = false;
  let pendingQuote = false; // a quote inside quotes: the end of the field, or the first half of ""
  let rowNo = 1;
  let first = true;
  let header = "";
  const endRow = function* () {
    row.push(field);
    field = "";
    yield { rowNo, cells: row };
    row = [];
    rowNo++;
  };
  for await (let chunk of stream) {
    if (first) {
      chunk = chunk.replace(/^﻿/, "");
      first = false;
    }
    if (!delimiter) {
      header += chunk;
      const line = header.split(/\r?\n/)[0];
      if (header.length < 64 * 1024 && !/\r?\n/.test(header)) continue;
      const counts = [",", ";", "\t"].map((d) => [d, line.split(d).length]);
      delimiter = counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts[0][0] : ",";
      chunk = header;
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') {
            field += '"';
            continue;
          }
          inQuotes = false; // fall through: this character follows the closing quote
        } else if (ch === '"') {
          pendingQuote = true;
          continue;
        } else {
          field += ch;
          continue;
        }
      }
      if (ch === '"' && field === "") inQuotes = true;
      else if (ch === delimiter) {
        row.push(field);
        field = "";
      } else if (ch === "\n") yield* endRow();
      else if (ch !== "\r") field += ch;
    }
  }
  if (!delimiter && header) {
    // A file shorter than one chunk with no line break: the header line alone
    delimiter = ",";
    for (const cell of header.split(",")) row.push(cell);
    yield { rowNo, cells: row };
    return;
  }
  if (field !== "" || row.length) yield* endRow();
}

const rawRows = (file, type) => (type === "csv" ? csvRawRows(file) : xlsxRawRows(file));
const isBlank = (cells) => cells.every((c) => cellText(c) === "");

/**
 * The sheet's data rows: { rowNo, name, phone, district, photoUrl, photoFile } as trimmed text (rowNo as Excel shows it,
 * header = row 1). The header is the first non-empty row; empty rows are skipped.
 */
export async function* readRows(file, type) {
  let columns = null;
  for await (const { rowNo, cells } of rawRows(file, type)) {
    if (isBlank(cells)) continue;
    if (!columns) {
      columns = mapHeader(cells.map(cellText));
      continue;
    }
    const at = (field) => (columns[field] === undefined ? "" : cellText(cells[columns[field]]));
    yield { rowNo, name: at("name"), phone: at("phone"), district: at("district"), photoUrl: at("photoUrl"), photoFile: at("photoFile") };
  }
  if (!columns) throw new ImportFileError("The sheet is empty. Add the column names in the first row and one participant per row");
}

/** Data rows in the sheet (a first, quick pass, so the progress bar knows the total). */
export async function countRows(file, type) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for await (const _ of readRows(file, type)) n++;
  return n;
}
