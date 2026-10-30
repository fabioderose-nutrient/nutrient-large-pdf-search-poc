import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import express from "express";
import jwt from "jsonwebtoken";
import { Agent, setGlobalDispatcher } from "undici";
import { config } from "./config.js";
import * as DE from "./de.js";
import { runBenchmark } from "./bench.js";
import { deleteDocument, initLibrary, listPublic, publicDoc, receiveUpload, requestOcr } from "./library.js";
import { planLoad, routingConfig } from "./load-routing.js";
import { acceleratedSearch, warmUp } from "./search.js";
import { getDoc } from "./store.js";
import { loadIndex, suggestQueries } from "./text-index.js";

// Large documents: uploads, OCR and full-document scans can take minutes.
setGlobalDispatcher(new Agent({ headersTimeout: 20 * 60 * 1000, bodyTimeout: 20 * 60 * 1000, connections: 64 }));

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
if (!fs.existsSync(config.jwtPrivateKeyPath)) {
  console.error(`[app] ${config.jwtPrivateKeyPath} not found. Run scripts/generate-keys.sh first.`);
  process.exit(1);
}
const jwtKey = fs.readFileSync(config.jwtPrivateKeyPath, "utf8");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireDoc = (req) => {
  const doc = getDoc(req.params.id);
  if (!doc) throw Object.assign(new Error("Unknown document."), { status: 404 });
  return doc;
};

// NDJSON streaming helper: one JSON object per line, flushed immediately.
function ndjson(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return {
    signal: controller.signal,
    emit: (obj) => {
      if (!res.writableEnded && !controller.signal.aborted) res.write(`${JSON.stringify(obj)}\n`);
    },
    end: () => res.end(),
  };
}

app.get("/api/config", (req, res) => {
  res.json({
    serverUrl: config.dePublicUrl,
    webSdkLicenseKey: config.webSdkLicenseKey,
    routing: routingConfig(),
    searchConcurrency: config.searchConcurrency,
  });
});

app.get("/api/health", wrap(async (req, res) => res.json({ app: true, documentEngine: await DE.healthy() })));

app.get("/api/documents", (req, res) => res.json(listPublic()));

// Raw PDF body (streamed to disk, then to Document Engine): POST /api/documents?name=file.pdf
app.post(
  "/api/documents",
  wrap(async (req, res) => {
    const name = path.basename(String(req.query.name || "document.pdf"));
    const doc = await receiveUpload(req, name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`);
    res.status(202).json(publicDoc(doc));
  })
);

app.delete(
  "/api/documents/:id",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    if (doc.origin === "folder") throw Object.assign(new Error("Documents from the documents folder are re-imported at start-up; remove the file from the folder instead."), { status: 400 });
    await deleteDocument(doc.id);
    res.json({ ok: true });
  })
);

// How the viewer should open the document (server-backed or in the browser),
// for a given user bandwidth. See load-routing.js.
app.get("/api/documents/:id/load-plan", (req, res) => {
  const doc = requireDoc(req);
  const bandwidthMbps = Number(req.query.bandwidth) || config.clientBandwidthMbps;
  res.json({ profile: doc.profile || null, ...planLoad(doc.profile, { bandwidthMbps }) });
});

// Viewer session for server-backed mode: Document Engine URL + signed JWT.
app.get(
  "/api/documents/:id/session",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    const token = jwt.sign({ document_id: doc.id, permissions: ["read-document", "write", "download"] }, jwtKey, {
      algorithm: "RS256",
      expiresIn: "12h",
    });
    warmUp(doc);
    res.json({ serverUrl: config.dePublicUrl, documentId: doc.id, jwt: token });
  })
);

// Original PDF for the in-browser (WebAssembly) comparison mode.
app.get(
  "/api/documents/:id/source.pdf",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    const up = await DE.sourcePdf(doc.id);
    if (!up.ok) throw Object.assign(new Error(`Document Engine returned ${up.status}`), { status: 502 });
    res.setHeader("Content-Type", "application/pdf");
    const len = up.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    Readable.fromWeb(up.body).pipe(res);
  })
);

// Accelerated search, streamed as NDJSON: plan, hits (one line per Document
// Engine request), done.
app.get(
  "/api/documents/:id/search",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    const query = String(req.query.q || "").trim();
    if (query.length < 2) throw Object.assign(new Error("Type at least 2 characters."), { status: 400 });
    if (!doc.pageCount) throw Object.assign(new Error("The document is still being processed."), { status: 409 });
    const out = ndjson(res);
    try {
      await acceleratedSearch({ doc, query, fromPage: Number(req.query.from) || 0, signal: out.signal, emit: out.emit });
    } catch (err) {
      out.emit({ type: "error", message: String(err?.message || err) });
    }
    out.end();
  })
);

// Text lines with coordinates for one page (localized text blocks).
app.get(
  "/api/documents/:id/pages/:page/lines",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    const entry = await loadIndex(doc.id, doc.sha);
    if (!entry) throw Object.assign(new Error("The text index is not ready yet."), { status: 409 });
    const p = Number(req.params.page);
    if (!(p >= 0 && p < entry.pageCount)) throw Object.assign(new Error("Page out of range."), { status: 400 });
    const [width, height] = entry.dims[p];
    res.json({
      pageIndex: p,
      width,
      height,
      lines: entry.pages[p].map(([text, left, top, w, h]) => ({ text, left, top, width: w, height: h })),
    });
  })
);

// Whole document as JSON: every text line with its page and bounding box.
app.get(
  "/api/documents/:id/text-lines.json",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    const entry = await loadIndex(doc.id, doc.sha);
    if (!entry) throw Object.assign(new Error("The text index is not ready yet."), { status: 409 });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.id}-text-lines.json"`);
    res.write(`{"document":${JSON.stringify({ id: doc.id, title: doc.title, pageCount: entry.pageCount, units: "PDF points, origin top-left" })},"pages":[`);
    for (let p = 0; p < entry.pageCount; p++) {
      const [width, height] = entry.dims[p];
      const lines = entry.pages[p].map(([text, left, top, w, h]) => ({ text, left, top, width: w, height: h }));
      res.write(`${p ? "," : ""}${JSON.stringify({ pageIndex: p, width, height, lines })}`);
    }
    res.end("]}");
  })
);

app.get(
  "/api/documents/:id/suggestions",
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    const entry = await loadIndex(doc.id, doc.sha);
    res.json(entry ? suggestQueries(entry) : []);
  })
);

app.post(
  "/api/documents/:id/ocr",
  express.json(),
  wrap(async (req, res) => {
    const doc = requireDoc(req);
    res.status(202).json(publicDoc(requestOcr(doc.id, req.body?.language || "english")));
  })
);

app.post(
  "/api/bench",
  express.json(),
  wrap(async (req, res) => {
    const doc = getDoc(String(req.body?.docId || ""));
    if (!doc) throw Object.assign(new Error("Unknown document."), { status: 404 });
    const queries = (req.body.queries || []).map((q) => String(q).trim()).filter((q) => q.length >= 2).slice(0, 20);
    const engines = (req.body.engines || ["native", "accelerated"]).filter((e) => e === "native" || e === "accelerated");
    if (!queries.length || !engines.length) throw Object.assign(new Error("Nothing to run."), { status: 400 });
    const out = ndjson(res);
    try {
      await runBenchmark({ doc, queries, engines, signal: out.signal, emit: out.emit });
    } catch (err) {
      out.emit({ type: "error", message: String(err?.message || err) });
    }
    out.end();
  })
);

// Web SDK assets, self-hosted from the npm package.
const sdkDir = path.join(here, "..", "node_modules", "@nutrient-sdk", "viewer", "dist");
app.use("/vendor/nutrient", express.static(sdkDir, { maxAge: "7d", immutable: true }));
app.use(express.static(path.join(here, "..", "public"), { extensions: ["html"] }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: String(err.message || err) });
});

app.listen(config.port, () => console.log(`[app] http://localhost:${config.port}`));
initLibrary().catch((err) => console.error("[library] init failed", err));
