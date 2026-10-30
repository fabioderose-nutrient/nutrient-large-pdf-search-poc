// Document library: imports the PDFs of ./documents, accepts uploads, keeps
// Document Engine, the page text index and the status shown in the UI in sync.
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import * as DE from "./de.js";
import { planLoad, buildProfile } from "./load-routing.js";
import { estimateOcrMs, runTargetedOcr } from "./ocr.js";
import { allDocs, getDoc, loadStore, patchDoc, putDoc, removeDoc } from "./store.js";
import { buildIndex, cachedIndex, dropIndex, hasIndexFile, loadIndex, textlessPages } from "./text-index.js";
import { slugify, titleFromFileName } from "./util.js";

const uploadsDir = path.join(config.dataDir, "uploads");
const sleep = (t) => new Promise((r) => setTimeout(r, t));

// Two serial job queues: ingestion (Document Engine upload, then text index)
// and OCR, so a long OCR run never blocks a new upload.
function makeQueue(name) {
  let chain = Promise.resolve();
  return (label, fn) => {
    chain = chain.then(() =>
      fn().catch((err) => console.error(`[${name}] ${label} failed:`, err?.message || err))
    );
    return chain;
  };
}
const ingest = makeQueue("ingest");
const ocrQueue = makeQueue("ocr");

const errorText = (err) => String(err?.message || err).slice(0, 500);

async function refreshFromEngine(id, patch = {}) {
  const [props, info] = await Promise.all([DE.documentProperties(id), DE.documentInfo(id)]);
  const prev = getDoc(id) || {};
  return putDoc({
    origin: "engine",
    status: "ready",
    error: null,
    index: null,
    textlessPages: [],
    ocr: { state: "idle" },
    ...prev,
    id,
    title: props.title || prev.title || id,
    byteSize: props.byteSize,
    sha: props.sourcePdfSha256,
    pageCount: info.pageCount,
    createdAt: props.createdAt || prev.createdAt,
    ...patch,
  });
}

function scheduleIndex(id) {
  const doc = getDoc(id);
  if (!doc) return;
  patchDoc(id, { status: "indexing", error: null, index: { done: 0, total: doc.pageCount } });
  ingest(`index ${id}`, async () => {
    const current = getDoc(id);
    if (!current) return;
    try {
      let last = 0;
      const entry = await buildIndex(id, current.sha, {
        onProgress: (done, total) => {
          if (done === total || Date.now() - last > 500) {
            last = Date.now();
            patchDoc(id, { index: { done, total } });
          }
        },
      });
      const textless = textlessPages(entry);
      patchDoc(id, {
        status: "ready",
        index: { done: entry.pageCount, total: entry.pageCount, ms: entry.buildMs, builtAt: entry.builtAt },
        textlessPages: textless,
        profile: buildProfile({ byteSize: current.byteSize, dims: entry.dims, textless }),
      });
      console.log(`[index] ${id}: ${entry.pageCount} pages in ${(entry.buildMs / 1000).toFixed(1)} s`);
      // Scanned or rasterised sheets are OCR'd in the background right away, so
      // they are searchable a few minutes after upload without anyone waiting.
      if (config.autoOcr && textless.length && getDoc(id)?.ocr?.state !== "done") startAutoOcr(id);
    } catch (err) {
      patchDoc(id, { status: "error", error: `Text extraction failed: ${errorText(err)}` });
    }
  });
}

// Documents present in Document Engine become library entries (and vice versa).
async function reconcile() {
  // Temporary OCR documents left behind by an interrupted run.
  const all = await DE.listDocuments();
  for (const d of all.filter((x) => /-ocr-[a-z0-9]+$/.test(x.id))) await DE.deleteDocument(d.id).catch(() => {});
  const engineDocs = all.filter((x) => !/-ocr-[a-z0-9]+$/.test(x.id));
  const ids = new Set(engineDocs.map((d) => d.id));
  for (const d of engineDocs) {
    try {
      await refreshFromEngine(d.id, getDoc(d.id) ? {} : { title: d.title });
    } catch (err) {
      console.error(`[library] cannot read ${d.id}:`, errorText(err));
    }
  }
  for (const doc of allDocs()) if (!ids.has(doc.id)) removeDoc(doc.id);
}

// Every PDF dropped in ./documents is uploaded to Document Engine once.
async function importFolder() {
  let names = [];
  try {
    names = (await fs.readdir(config.documentsDir)).filter((n) => n.toLowerCase().endsWith(".pdf")).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const id = slugify(name);
    if (getDoc(id)) continue;
    const full = path.join(config.documentsDir, name);
    const stat = await fs.stat(full);
    const title = titleFromFileName(name);
    putDoc({ id, title, fileName: name, origin: "folder", status: "processing", byteSize: stat.size, pageCount: 0, createdAt: new Date().toISOString(), ocr: { state: "idle" }, textlessPages: [] });
    ingest(`import ${name}`, async () => {
      try {
        const t0 = Date.now();
        await DE.uploadPdf(full, { id, title });
        await refreshFromEngine(id, { origin: "folder", uploadMs: Date.now() - t0 });
        scheduleIndex(id);
      } catch (err) {
        patchDoc(id, { status: "error", error: `Upload to Document Engine failed: ${errorText(err)}` });
      }
    });
  }
}

export async function initLibrary() {
  await fs.mkdir(uploadsDir, { recursive: true });
  for (const f of await fs.readdir(uploadsDir)) await fs.rm(path.join(uploadsDir, f), { force: true });
  loadStore();
  while (!(await DE.healthy())) {
    console.log("[library] waiting for Document Engine...");
    await sleep(3000);
  }
  await reconcile();
  await importFolder();
  for (const doc of allDocs()) {
    if (doc.status === "processing") continue;
    if (!(await hasIndexFile(doc.id, doc.sha))) scheduleIndex(doc.id);
    else if (doc.status !== "ready") patchDoc(doc.id, { status: "ready", error: null });
  }
  for (const doc of allDocs()) if (doc.ocr?.state === "running") patchDoc(doc.id, { ocr: { state: "idle" } });
  // Load the page text of ready documents into memory now, so the first
  // search after a restart does not pay for reading the index from disk.
  for (const doc of allDocs()) {
    if (doc.status !== "ready") continue;
    const entry = await loadIndex(doc.id, doc.sha);
    if (entry) patchDoc(doc.id, { profile: buildProfile({ byteSize: doc.byteSize, dims: entry.dims, textless: textlessPages(entry) }) });
    if (entry && config.autoOcr && textlessPages(entry).length && doc.ocr?.state !== "done" && doc.ocr?.state !== "error") startAutoOcr(doc.id);
  }
}

export async function receiveUpload(req, fileName) {
  const base = slugify(fileName);
  const id = getDoc(base) ? `${base}-${crypto.randomBytes(3).toString("hex")}` : base;
  const tmp = path.join(uploadsDir, `${id}.pdf`);
  await pipeline(req, createWriteStream(tmp));
  const fh = await fs.open(tmp);
  const head = Buffer.alloc(5);
  await fh.read(head, 0, 5, 0);
  const { size } = await fh.stat();
  await fh.close();
  if (head.toString("latin1") !== "%PDF-") {
    await fs.rm(tmp, { force: true });
    throw Object.assign(new Error("The file is not a PDF."), { status: 400 });
  }
  const title = titleFromFileName(fileName);
  const doc = putDoc({ id, title, fileName, origin: "upload", status: "processing", byteSize: size, pageCount: 0, createdAt: new Date().toISOString(), ocr: { state: "idle" }, textlessPages: [] });
  ingest(`upload ${id}`, async () => {
    try {
      const t0 = Date.now();
      await DE.uploadPdf(tmp, { id, title });
      await refreshFromEngine(id, { origin: "upload", uploadMs: Date.now() - t0 });
      scheduleIndex(id);
    } catch (err) {
      patchDoc(id, { status: "error", error: `Upload to Document Engine failed: ${errorText(err)}` });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  });
  return doc;
}

export async function deleteDocument(id) {
  const doc = getDoc(id);
  if (!doc) return false;
  await DE.deleteDocument(id);
  await dropIndex(id);
  removeDoc(id);
  return true;
}

function startAutoOcr(id) {
  try {
    requestOcr(id, "english", { auto: true });
    console.log(`[ocr] ${id}: started automatically for ${getDoc(id).textlessPages.length} pages without text`);
  } catch (err) {
    console.error(`[ocr] ${id}: not started:`, err.message);
  }
}

export function requestOcr(id, language = "english", { auto = false } = {}) {
  const doc = getDoc(id);
  if (!doc) throw Object.assign(new Error("Unknown document."), { status: 404 });
  if (doc.status !== "ready") throw Object.assign(new Error("The document is still being processed."), { status: 409 });
  if (doc.ocr?.state === "running") throw Object.assign(new Error("OCR is already running."), { status: 409 });
  const pages = doc.textlessPages || [];
  if (!pages.length) throw Object.assign(new Error("Every page already has a text layer."), { status: 400 });
  const estimate = estimateOcrMs(doc.byteSize, pages, cachedIndex(id)?.dims);
  patchDoc(id, { ocr: { state: "running", auto, pages, startedAt: new Date().toISOString(), ...estimate } });
  ocrQueue(`ocr ${id}`, async () => {
    const t0 = Date.now();
    try {
      const previous = await loadIndex(id, doc.sha);
      await runTargetedOcr(getDoc(id), pages, language, (phase) =>
        patchDoc(id, { ocr: { ...getDoc(id).ocr, phase, phaseAt: new Date().toISOString() } })
      );
      // Document Engine keeps reporting the sha of the uploaded file after
      // apply_instructions, so the index stays keyed on it; `revision` tells
      // open viewers to reload the rewritten document.
      const fresh = await refreshFromEngine(id, {
        status: "indexing",
        index: { done: 0, total: pages.length },
        revision: (getDoc(id).revision || 0) + 1,
      });
      // Only the OCR'd pages changed: re-extract just those.
      const entry = await buildIndex(id, fresh.sha, {
        onlyPages: pages,
        previous,
        onProgress: (done, total) => patchDoc(id, { index: { done, total } }),
      });
      const stillTextless = textlessPages(entry);
      patchDoc(id, {
        status: "ready",
        profile: buildProfile({ byteSize: getDoc(id).byteSize, dims: entry.dims, textless: stillTextless }),
        index: { done: entry.pageCount, total: entry.pageCount, ms: entry.buildMs, builtAt: entry.builtAt },
        textlessPages: stillTextless,
        ocr: { state: "done", auto, pages, ms: Date.now() - t0, finishedAt: new Date().toISOString(), recovered: pages.length - stillTextless.filter((p) => pages.includes(p)).length },
      });
      console.log(`[ocr] ${id}: ${pages.length} pages in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      patchDoc(id, { ocr: { state: "error", pages, error: errorText(err) } });
    }
  });
  return getDoc(id);
}

export function publicDoc(doc) {
  return {
    id: doc.id,
    title: doc.title,
    origin: doc.origin,
    status: doc.status,
    error: doc.error || null,
    pageCount: doc.pageCount || 0,
    byteSize: doc.byteSize || 0,
    sha: doc.sha || null,
    revision: doc.revision || 0,
    createdAt: doc.createdAt,
    index: doc.index || null,
    textlessPages: doc.textlessPages || [],
    ocr: doc.ocr || { state: "idle" },
    profile: doc.profile || null,
    loadPlan: planLoad(doc.profile),
  };
}

export const listPublic = () =>
  allDocs()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(publicDoc);
