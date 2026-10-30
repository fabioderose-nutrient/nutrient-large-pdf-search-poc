// Targeted OCR: only the pages without a text layer (rasterised drawings,
// scans, sheets whose text was converted to outlines) go through Document
// Engine's OCR. Pages that already have text are never touched.
//
// Document Engine pays a fixed cost (about 25 s here) for every separate page
// range it OCRs in place, so two strategies are used:
//   in place   1 or 2 contiguous ranges (e.g. a block of scanned sheets in a
//              drawing set): one apply_instructions call with an OCR action
//              on those ranges only.
//   one pass   3 ranges or more (pages scattered through a spec book):
//              1. Build API: extract the text-less pages into a small PDF and
//                 OCR it once;
//              2. store it as a temporary document;
//              3. apply_instructions: rebuild the document from its own pages
//                 with the OCR'd pages put back at their place, then delete
//                 the temporary document.
// Measured on two large construction PDFs: 19 sheets in 2 ranges, 2 min 50 s in place;
// 10 pages in 8 ranges, 6 min 33 s in place versus 3 min 24 s in one pass.
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import * as DE from "./de.js";

const SHEET_36X24 = 2592 * 1728; // PDF points
const ONE_PASS_FROM_RANGES = 3;

export function pageRanges(pages) {
  const ranges = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && p === last.end + 1) last.end = p;
    else ranges.push({ start: p, end: p });
  }
  return ranges;
}

export const ocrStrategy = (pages) => (pageRanges(pages).length >= ONE_PASS_FROM_RANGES ? "one-pass" : "in-place");

// Duration estimate shown in the UI while OCR runs.
export function estimateOcrMs(byteSize, pages, dims) {
  const strategy = ocrStrategy(pages);
  const ranges = pageRanges(pages).length;
  let ocrSeconds = config.ocrBaseSeconds;
  for (const p of pages) {
    const [w, h] = dims?.[p] || [2592, 1728];
    ocrSeconds += config.ocrSecondsPerLargeSheet * Math.min(2, Math.max(0.1, (w * h) / SHEET_36X24));
  }
  if (strategy === "in-place") ocrSeconds += (ranges - 1) * config.ocrSecondsPerExtraRange;
  const saveSeconds = (byteSize || 0) / 1048576 / config.ocrSaveMBPerSecond;
  return { strategy, estimatedOcrMs: Math.round(ocrSeconds * 1000), estimatedSaveMs: Math.round(saveSeconds * 1000) };
}

// In place: the whole document, with an OCR action on the given ranges only.
export function inPlaceInstructions(pageCount, ocrPages, language) {
  const set = new Set(ocrPages);
  const ranges = [];
  for (let p = 0; p < pageCount; p++) {
    const ocr = set.has(p);
    const last = ranges[ranges.length - 1];
    if (last && last.ocr === ocr) last.end = p;
    else ranges.push({ start: p, end: p, ocr });
  }
  return {
    parts: ranges.map((r) => ({
      document: { id: "#self" },
      pages: { start: r.start, end: r.end },
      ...(r.ocr ? { actions: [{ type: "ocr", language }] } : {}),
    })),
  };
}

// One pass, step 3: page `ocrPages[i]` is taken from page i of the
// temporary OCR'd document, every other page from the document itself.
export function reassemblyInstructions(pageCount, ocrPages, tmpId) {
  const sorted = [...ocrPages].sort((a, b) => a - b);
  const parts = [];
  let next = 0;
  sorted.forEach((p, i) => {
    if (p > next) parts.push({ document: { id: "#self" }, pages: { start: next, end: p - 1 } });
    parts.push({ document: { id: tmpId }, pages: { start: i, end: i } });
    next = p + 1;
  });
  if (next < pageCount) parts.push({ document: { id: "#self" }, pages: { start: next, end: pageCount - 1 } });
  return { parts };
}

export async function runTargetedOcr(doc, ocrPages, language = "english", onPhase = () => {}) {
  const sorted = [...ocrPages].sort((a, b) => a - b);
  onPhase("ocr");
  if (ocrStrategy(sorted) === "in-place") {
    const result = await DE.applyInstructions(doc.id, inPlaceInstructions(doc.pageCount, sorted, language));
    return { sha: result.sourcePdfSha256, byteSize: result.byteSize };
  }
  const pdf = await DE.buildPdf({
    parts: sorted.map((p) => ({ document: { id: doc.id }, pages: { start: p, end: p } })),
    actions: [{ type: "ocr", language }],
  });
  const tmpId = `${doc.id}-ocr-${Date.now().toString(36)}`;
  const tmpFile = path.join(config.dataDir, "uploads", `${tmpId}.pdf`);
  await fs.writeFile(tmpFile, pdf);
  try {
    await DE.uploadPdf(tmpFile, { id: tmpId, title: tmpId });
    onPhase("save");
    const result = await DE.applyInstructions(doc.id, reassemblyInstructions(doc.pageCount, sorted, tmpId));
    return { sha: result.sourcePdfSha256, byteSize: result.byteSize };
  } finally {
    await fs.rm(tmpFile, { force: true });
    await DE.deleteDocument(tmpId).catch(() => {});
  }
}
