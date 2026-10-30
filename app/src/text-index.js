// Page text index.
//
// Right after upload, the text of every page is extracted once by Document
// Engine (GET /pages/:n/text, one line per entry with its bounding box) and
// stored in /data/text/<id>.json. Searches use it only to know WHICH pages can
// contain the query; the exact matching and the highlight rectangles still come
// from Document Engine's search on those pages (see search.js).
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { documentInfo, pageTextLines } from "./de.js";
import { withRetry, writeFileAtomic } from "./util.js";

const dir = path.join(config.dataDir, "text");
const cache = new Map(); // id -> entry (LRU)
const inflight = new Map();
const MAX_CACHED = 6;
const round = (n) => Math.round(n * 100) / 100;

// Applied to both page text and queries. It folds more than Document Engine
// does (case, ligatures, quotes, dashes, whitespace), so candidate pages are
// always a superset of the pages Document Engine will actually match.
export function normalize(s) {
  return String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−­]/g, "-")
    .replace(/\s+/g, " ");
}

const indexFile = (id) => path.join(dir, `${id}.json`);

function toEntry(file) {
  const texts = file.pages.map((lines) => normalize(lines.map((l) => l[0]).join(" ")));
  return {
    sha: file.sha,
    pageCount: file.pageCount,
    dims: file.dims,
    pages: file.pages,
    texts,
    chars: texts.map((t) => t.replace(/ /g, "").length),
    builtAt: file.builtAt,
    buildMs: file.buildMs,
    suggestions: null,
  };
}

function remember(id, entry) {
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  return entry;
}

export async function hasIndexFile(id, sha) {
  try {
    const head = (await fs.readFile(indexFile(id), "utf8")).slice(0, 400);
    return head.includes(`"sha":"${sha}"`);
  } catch {
    return false;
  }
}

export async function loadIndex(id, sha) {
  const hit = cache.get(id);
  if (hit && (!sha || hit.sha === sha)) return remember(id, hit);
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    try {
      const file = JSON.parse(await fs.readFile(indexFile(id), "utf8"));
      if (sha && file.sha !== sha) return null;
      return remember(id, toEntry(file));
    } catch {
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}

// In-memory entry if already loaded (no disk access).
export const cachedIndex = (id) => cache.get(id) || null;

export async function dropIndex(id) {
  cache.delete(id);
  await fs.rm(indexFile(id), { force: true });
}

// Extracts every page (or only `onlyPages`, reusing the rest from `previous`).
export async function buildIndex(id, sha, { onProgress = () => {}, onlyPages = null, previous = null } = {}) {
  const t0 = Date.now();
  const info = await documentInfo(id);
  const pageCount = info.pageCount;
  const dims = info.pages.map((p) => [round(p.width), round(p.height)]);
  const pages = previous && onlyPages ? previous.pages.slice() : new Array(pageCount);
  const todo = onlyPages || Array.from({ length: pageCount }, (_, i) => i);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const lines = await withRetry(() => pageTextLines(id, p));
      pages[p] = lines.map((l) => [l.contents, round(l.left), round(l.top), round(l.width), round(l.height)]);
      onProgress(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.indexConcurrency, todo.length) }, worker));
  const file = { version: 1, id, sha, pageCount, builtAt: new Date().toISOString(), buildMs: Date.now() - t0, dims, pages };
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(indexFile(id), JSON.stringify(file));
  return remember(id, toEntry(file));
}

// Pages that may contain the query: every word of the query occurs on the page.
// Also returns an instant estimate of the number of exact phrase occurrences.
export function findCandidates(entry, query) {
  const tokens = normalize(query).trim().split(" ").filter(Boolean);
  if (!tokens.length) return { pages: [], estimate: 0 };
  const phrase = tokens.join(" ");
  const pages = [];
  let estimate = 0;
  for (let p = 0; p < entry.texts.length; p++) {
    const t = entry.texts[p];
    if (!tokens.every((k) => t.includes(k))) continue;
    pages.push(p);
    for (let i = t.indexOf(phrase); i !== -1; i = t.indexOf(phrase, i + phrase.length)) estimate++;
  }
  return { pages, estimate };
}

// Pages without a text layer (scanned or rasterised drawings).
export const textlessPages = (entry) => entry.chars.flatMap((n, p) => (n < 12 ? [p] : []));

const STOP = new Set(
  ("the and for with shall that this from are not all any per section part each other such than into have been " +
    "where which when must will under over only also these those their there provide provided include including " +
    "required requirements accordance specified indicated unless otherwise")
    .split(" ")
);

// Realistic test queries derived from the document itself (used to pre-fill the
// benchmark): a reference code, a rare word, a mid-frequency word, a common
// phrase and a very frequent word.
export function suggestQueries(entry) {
  if (entry.suggestions) return entry.suggestions;
  const df = new Map();
  const bi = new Map();
  const clean = (w) => (w || "").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  for (const t of entry.texts) {
    const toks = t.split(" ");
    const seen = new Set();
    const seenBi = new Set();
    for (let i = 0; i < toks.length; i++) {
      const w = clean(toks[i]);
      if (w.length < 2) continue;
      seen.add(w);
      const n = clean(toks[i + 1]);
      if (/^[a-z]{4,}$/.test(w) && /^[a-z]{4,}$/.test(n) && !STOP.has(w) && !STOP.has(n)) seenBi.add(`${w} ${n}`);
    }
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
    for (const b of seenBi) bi.set(b, (bi.get(b) || 0) + 1);
  }
  const n = entry.pageCount;
  const words = [...df].filter(([w]) => /^[a-z]{5,14}$/.test(w) && !STOP.has(w));
  const pick = (list, score) => list.sort((a, b) => score(a) - score(b) || (a[0] < b[0] ? -1 : 1))[0];
  const out = [];
  const add = (kind, e) => e && !out.some((o) => o.q === e[0]) && out.push({ q: e[0], kind, pages: e[1] });
  // Sheet numbers (A-101, AG-1.2, E3.01, L102) or spec section numbers (081113).
  const code = /^([a-z]{1,3}-?\d{1,3}(\.\d{1,3})?[a-z]?|\d{6})$/;
  add("Reference code", pick([...df].filter(([w, c]) => code.test(w) && /\d/.test(w) && c >= 2 && c <= 6), ([w, c]) => -(w.includes("-") || w.includes(".")) * 10 - c));
  add("Rare word", pick(words.filter(([w, c]) => c >= 2 && c <= 3 && w.length >= 8), ([w, c]) => -w.length - c));
  add("Mid-frequency word", pick(words.slice(), ([, c]) => Math.abs(c - Math.max(4, n * 0.03))));
  add("Common phrase", pick([...bi].filter(([, c]) => c <= n * 0.25), ([, c]) => -c));
  add("Very frequent word", pick(words.filter(([, c]) => c <= n * 0.5), ([, c]) => -c));
  entry.suggestions = out;
  return out;
}
