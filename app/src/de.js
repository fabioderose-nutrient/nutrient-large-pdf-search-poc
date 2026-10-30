// Thin client for the Nutrient Document Engine HTTP API.
import { openAsBlob } from "node:fs";
import { config } from "./config.js";

export class DocumentEngineError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function de(pathAndQuery, opts = {}) {
  return fetch(config.deInternalUrl + pathAndQuery, {
    ...opts,
    headers: { Authorization: `Token token=${config.deApiToken}`, ...(opts.headers || {}) },
  });
}

async function deJson(pathAndQuery, opts = {}) {
  const res = await de(pathAndQuery, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 400);
    throw new DocumentEngineError(`Document Engine returned ${res.status} for ${pathAndQuery.split("?")[0]}: ${body}`, res.status);
  }
  return res.json();
}

export async function healthy() {
  try {
    const res = await de("/healthcheck");
    return res.ok;
  } catch {
    return false;
  }
}

export async function listDocuments() {
  const all = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("cursor", cursor);
    const body = await deJson(`/api/documents?${qs}`);
    all.push(...body.data);
    cursor = body.next_cursor;
  } while (cursor);
  return all;
}

export const documentProperties = (id) => deJson(`/api/documents/${encodeURIComponent(id)}/properties`).then((r) => r.data);
export const documentInfo = (id) => deJson(`/api/documents/${encodeURIComponent(id)}/document_info`).then((r) => r.data);

// Streams a PDF from disk to Document Engine without loading it into memory.
export async function uploadPdf(filePath, { id, title }) {
  const form = new FormData();
  form.append("document_id", id);
  form.append("title", title);
  form.append("file", await openAsBlob(filePath, { type: "application/pdf" }), `${title}.pdf`);
  return deJson("/api/documents", { method: "POST", body: form }).then((r) => r.data);
}

export async function deleteDocument(id) {
  const res = await de(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new DocumentEngineError(`Delete failed with ${res.status}`, res.status);
}

// Text lines of one page, each with its bounding box in PDF points (top-left origin).
export const pageTextLines = (id, pageIndex, signal) =>
  deJson(`/api/documents/${encodeURIComponent(id)}/pages/${pageIndex}/text`, { signal }).then((r) => r.textLines);

// Exact text search on a page window [start, start + limit). Same endpoint the
// Web SDK uses in server-backed mode; returns hits with highlight rectangles.
export async function searchWindow(id, query, start, limit, signal) {
  const qs = new URLSearchParams({
    q: query,
    start: String(start),
    limit: String(limit),
    type: "text",
    include_annotations: "false",
    case_sensitive: "false",
  });
  const body = await deJson(`/api/documents/${encodeURIComponent(id)}/search?${qs}`, { signal });
  return body.data.filter((h) => !h.isAnnotation);
}

// Runs Build API instructions on an existing document and persists the result
// as the document's new source PDF.
export const applyInstructions = (id, instructions) =>
  deJson(`/api/documents/${encodeURIComponent(id)}/apply_instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(instructions),
  }).then((r) => r.data);

// Stateless Build API: returns the generated PDF (nothing is stored).
export async function buildPdf(instructions) {
  const form = new FormData();
  form.append("instructions", JSON.stringify(instructions));
  const res = await de("/api/build", { method: "POST", body: form });
  if (!res.ok) throw new DocumentEngineError(`Build API returned ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Original PDF bytes (used by the in-browser comparison mode).
export const sourcePdf = (id) => de(`/api/documents/${encodeURIComponent(id)}/pdf?source=true`);
