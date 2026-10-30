// Accelerated search.
//
//  1. The page text index (text-index.js) returns, in a few milliseconds, the
//     pages that can contain the query (every word present on the page).
//  2. Only those pages are searched by Document Engine (its exact text search,
//     the same endpoint the Web SDK calls in server-backed mode), in parallel,
//     starting from the page the user is looking at.
//  3. Hits are streamed back as soon as each request completes, and the
//     browser feeds them into the Web SDK search UI.
//
// Result: identical hits to the built-in search (same engine, same phrase
// matching, same highlight rectangles), but Document Engine only reads the
// handful of pages that matter instead of the whole 500 MB document.
import { performance } from "node:perf_hooks";
import { config } from "./config.js";
import { searchWindow } from "./de.js";
import { findCandidates, loadIndex } from "./text-index.js";
import { Limiter } from "./util.js";

// Shared by every search and warm-up so that concurrent users cannot overload
// Document Engine's worker pool.
export const deLimiter = new Limiter(config.searchConcurrency);

const ms = (t) => Math.round(t * 10) / 10;

// Groups candidate pages into page windows, forward from the current page
// first, then from the start of the document up to the current page. Windows
// are kept small enough that every parallel slot gets about two requests, so
// one long window on heavy drawing sheets never holds up the end of a search.
export function planRequests(pages, fromPage) {
  const forward = pages.filter((p) => p >= fromPage);
  const wrapped = pages.filter((p) => p < fromPage);
  const span = Math.max(1, Math.min(config.maxPagesPerRequest, Math.ceil(pages.length / (config.searchConcurrency * 2))));
  const gap = span > 2 ? config.maxGapPages : 0;
  const runs = [];
  for (const segment of [forward, wrapped]) {
    let cur = null;
    for (const p of segment) {
      // The very first window is a single page: it answers first.
      const fits = cur && runs.length > 1 && p - (cur.start + cur.limit) <= gap && p - cur.start + 1 <= span;
      if (fits) cur.limit = p - cur.start + 1;
      else runs.push((cur = { start: p, limit: 1 }));
    }
  }
  return runs;
}

export async function acceleratedSearch({ doc, query, fromPage = 0, signal, emit = () => {} }) {
  const t0 = performance.now();
  const entry = doc.sha ? await loadIndex(doc.id, doc.sha) : null;
  let pages;
  let estimate = null;
  if (entry) ({ pages, estimate } = findCandidates(entry, query));
  else pages = Array.from({ length: doc.pageCount }, (_, i) => i); // index not built yet: scan everything
  const start = Math.min(Math.max(0, Number(fromPage) || 0), Math.max(0, doc.pageCount - 1));
  const runs = planRequests(pages, start);
  emit({
    type: "plan",
    indexed: Boolean(entry),
    pageCount: doc.pageCount,
    candidatePages: pages.length,
    requests: runs.length,
    pagesScanned: runs.reduce((a, r) => a + r.limit, 0),
    estimatedMatches: estimate,
    planMs: ms(performance.now() - t0),
  });

  let hits = 0;
  let firstHitMs = null;
  let completed = 0;
  let errors = 0;
  await Promise.all(
    runs.map((run) =>
      deLimiter.run(async () => {
        if (signal?.aborted) return;
        const a = performance.now();
        try {
          const res = await searchWindow(doc.id, query, run.start, run.limit, signal);
          completed++;
          if (signal?.aborted) return;
          hits += res.length;
          if (res.length && firstHitMs === null) firstHitMs = ms(performance.now() - t0);
          emit({
            type: "hits",
            start: run.start,
            limit: run.limit,
            ms: ms(performance.now() - a),
            hits: res.map((h) => ({ p: h.pageIndex, text: h.previewText, range: h.rangeInPreview, rects: h.rectsOnPage })),
          });
        } catch (err) {
          if (err?.name === "AbortError" || signal?.aborted) return;
          errors++;
          emit({ type: "warning", start: run.start, limit: run.limit, message: String(err?.message || err) });
        }
      })
    )
  );
  const summary = {
    type: "done",
    aborted: Boolean(signal?.aborted),
    hits,
    firstHitMs,
    totalMs: ms(performance.now() - t0),
    requests: completed,
    errors,
  };
  emit(summary);
  return summary;
}

// Opens the document in Document Engine's PDF workers before the first search
// (the first request on a cold worker pays the cost of opening a 500 MB file).
const lastWarm = new Map();
export function warmUp(doc) {
  const now = Date.now();
  if (!doc.pageCount || now - (lastWarm.get(doc.id) || 0) < 10 * 60 * 1000) return Promise.resolve();
  lastWarm.set(doc.id, now);
  const n = Math.min(config.searchConcurrency, doc.pageCount);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const page = Math.floor((i * doc.pageCount) / n);
    jobs.push(deLimiter.run(() => searchWindow(doc.id, "qzxwarmup", page, 1).catch(() => {})));
  }
  return Promise.all(jobs);
}
