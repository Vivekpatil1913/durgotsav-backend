// Streaming reader for the first worksheet of an .xlsx file. An .xlsx is a ZIP of XML parts: yauzl opens the archive by
// its central directory (any part can be read in any order, whatever order the writing program stored them in), and
// saxes parses the worksheet XML chunk by chunk, so rows are handed out while the file is read and memory stays flat
// however many rows the sheet has. Only cell text is read — no styles, images or formulas.
// (exceljs' own streaming reader stops early on current Node versions; exceljs is still used to write the template.)
import { SaxesParser } from "saxes";
import yauzl from "yauzl";

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
});

async function indexEntries(zip) {
  const entries = new Map();
  await new Promise((resolve, reject) => {
    zip.on("entry", (entry) => {
      entries.set(entry.fileName.replace(/^\/+/, ""), entry);
      zip.readEntry();
    });
    zip.once("end", resolve);
    zip.once("error", reject);
    zip.readEntry();
  });
  return entries;
}

const openStream = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
});

/**
 * Feeds a part's XML through a SAX parser. `handlers` receive saxes events; `drain()` (optional) is called after each
 * chunk and may return items to yield, so a caller can stream results out while the part is still being read.
 */
async function* parsePart(zip, entry, setup) {
  const parser = new SaxesParser({ xmlns: false, position: false });
  const out = [];
  setup(parser, out);
  let failure = null;
  parser.on("error", (err) => { failure = err; });
  const stream = await openStream(zip, entry);
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    parser.write(chunk);
    if (failure) throw failure;
    while (out.length) yield out.shift();
  }
  parser.close();
  if (failure) throw failure;
  while (out.length) yield out.shift();
}

async function readWhole(zip, entry, setup) {
  const items = [];
  for await (const item of parsePart(zip, entry, setup)) items.push(item);
  return items;
}

// "AB12" → 27 (0-based column index)
function columnIndex(ref) {
  const letters = /^[A-Z]+/i.exec(ref ?? "")?.[0];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// 27 → "AB"
function columnName(index) {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// =HYPERLINK("https://…", "text") → the link
function hyperlinkFormula(formula) {
  const m = /HYPERLINK\(\s*"((?:[^"]|"")*)"/i.exec(formula ?? "");
  return m ? m[1].replace(/""/g, '"') : null;
}

// Most cells a hyperlink range ("D2:D5000") is expanded to
const MAX_LINK_CELLS = 2_000_000;

/**
 * Hyperlinks of a worksheet: cell reference ("D3") → target URL. Excel keeps them after the cell data (<hyperlinks>,
 * targets in the sheet's relationships part), so the sheet is read once for them before its rows are — only when its
 * relationships hold any external hyperlink.
 */
async function sheetHyperlinks(zip, entries, sheetPath) {
  const relsPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const relsEntry = entries.get(relsPath);
  if (!relsEntry) return new Map();
  const targets = new Map(await readWhole(zip, relsEntry, (p, out) => {
    p.on("opentag", (tag) => {
      const a = tag.attributes;
      if (tag.name.replace(/^.*:/, "") === "Relationship" && /\/hyperlink$/.test(a.Type ?? "")) out.push([a.Id, a.Target]);
    });
  }));
  const links = new Map();
  if (!targets.size) return links;
  for await (const [ref, target] of parsePart(zip, entries.get(sheetPath), (p, out) => {
    p.on("opentag", (tag) => {
      if (tag.name.replace(/^.*:/, "") !== "hyperlink") return;
      const rid = tag.attributes["r:id"] ?? Object.entries(tag.attributes).find(([k]) => /(^|:)id$/.test(k))?.[1];
      const target = targets.get(rid);
      if (target && tag.attributes.ref) out.push([tag.attributes.ref, target]);
    });
  })) {
    const [from, to = from] = ref.toUpperCase().split(":");
    const c1 = columnIndex(from);
    const c2 = columnIndex(to);
    const r1 = parseInt(from.replace(/^[A-Z]+/, ""), 10);
    const r2 = parseInt(to.replace(/^[A-Z]+/, ""), 10);
    if (c1 === null || c2 === null || !r1 || !r2) continue;
    for (let r = r1; r <= r2 && links.size < MAX_LINK_CELLS; r++) {
      for (let c = c1; c <= c2; c++) links.set(`${columnName(c)}${r}`, target);
    }
  }
  return links;
}

// Path of the first worksheet, from xl/workbook.xml (sheet order) and its relationships
async function firstSheetPath(zip, entries) {
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const [rid] = await readWhole(zip, workbook, (p, out) => {
      p.on("opentag", (tag) => {
        if (tag.name.replace(/^.*:/, "") === "sheet" && !out.length) out.push(tag.attributes["r:id"] ?? Object.entries(tag.attributes).find(([k]) => /(^|:)id$/.test(k))?.[1]);
      });
    });
    const targets = await readWhole(zip, rels, (p, out) => {
      p.on("opentag", (tag) => {
        if (tag.name.replace(/^.*:/, "") === "Relationship") out.push([tag.attributes.Id, tag.attributes.Target]);
      });
    });
    const target = targets.find(([id]) => id === rid)?.[1];
    if (target) {
      const resolved = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
      if (entries.has(resolved)) return resolved;
    }
  }
  return [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.slice(19), 10) - parseInt(b.slice(19), 10))[0] ?? null;
}

// Shared strings table (<si> items: plain <t>, or rich-text runs <r><t>; phonetic runs <rPh> are left out)
async function sharedStrings(zip, entries) {
  const entry = entries.get("xl/sharedStrings.xml");
  if (!entry) return [];
  return readWhole(zip, entry, (p, out) => {
    let text = null;
    let inT = false;
    let phonetic = 0;
    p.on("opentag", (tag) => {
      const name = tag.name.replace(/^.*:/, "");
      if (name === "si") text = "";
      else if (name === "rPh") phonetic++;
      else if (name === "t" && phonetic === 0) inT = true;
    });
    p.on("text", (t) => { if (inT && text !== null) text += t; });
    p.on("cdata", (t) => { if (inT && text !== null) text += t; });
    p.on("closetag", (tag) => {
      const name = tag.name.replace(/^.*:/, "");
      if (name === "t") inT = false;
      else if (name === "rPh") phonetic--;
      else if (name === "si") {
        out.push(text);
        text = null;
      }
    });
  });
}

/**
 * Rows of the first worksheet: { rowNo, cells } (cells 0-based; shared strings resolved; numbers as numbers; booleans
 * as booleans; a cell with a hyperlink — inserted, or a HYPERLINK() formula — as { text, hyperlink }). Rows Excel left
 * out (empty) are not yielded.
 */
export async function* xlsxRows(file) {
  const zip = await openZip(file);
  try {
    const entries = await indexEntries(zip);
    const sheetPath = await firstSheetPath(zip, entries);
    if (!sheetPath) throw new Error("no worksheet found");
    const strings = await sharedStrings(zip, entries);
    const links = await sheetHyperlinks(zip, entries, sheetPath);
    yield* parsePart(zip, entries.get(sheetPath), (p, out) => {
      let row = null;
      let rowNo = 0;
      let cell = null;
      let capture = false;
      p.on("opentag", (tag) => {
        const name = tag.name.replace(/^.*:/, "");
        if (name === "row") {
          rowNo = tag.attributes.r ? Number(tag.attributes.r) : rowNo + 1;
          row = [];
        } else if (name === "c" && row) {
          const index = columnIndex(tag.attributes.r) ?? row.length;
          cell = { index, ref: tag.attributes.r?.toUpperCase() ?? `${columnName(index)}${rowNo}`, type: tag.attributes.t ?? "n", text: "", formula: "" };
        } else if (cell && (name === "v" || (name === "t" && cell.type === "inlineStr"))) {
          capture = "text";
        } else if (cell && name === "f") {
          capture = "formula";
        }
      });
      const onText = (t) => {
        if (capture === "text") cell.text += t;
        else if (capture === "formula") cell.formula += t;
      };
      p.on("text", onText);
      p.on("cdata", onText);
      p.on("closetag", (tag) => {
        const name = tag.name.replace(/^.*:/, "");
        if (name === "v" || name === "t" || name === "f") capture = false;
        else if (name === "c" && cell) {
          const { type, text } = cell;
          let value = text;
          if (type === "s") value = strings[Number(text)] ?? "";
          else if (type === "b") value = text === "1";
          else if (type === "e") value = "";
          else if (type === "n" && text !== "" && Number.isFinite(Number(text))) value = Number(text);
          const link = links.get(cell.ref) ?? hyperlinkFormula(cell.formula);
          row[cell.index] = link ? { text: value, hyperlink: link } : value;
          cell = null;
        } else if (name === "row" && row) {
          out.push({ rowNo, cells: Array.from(row, (v) => v ?? "") });
          row = null;
        }
      });
    });
  } finally {
    zip.close();
  }
}
