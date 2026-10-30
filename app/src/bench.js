// Server-side benchmark: the same query through two paths.
//
//  native       Exactly what the Web SDK 1.23 built-in search UI does against
//               Document Engine in server-backed mode: sequential requests over
//               growing page windows (10, 20, 50, 100, 200, then 500 pages)
//               starting at the current page (page 1 here).
//  accelerated  This PoC (search.js).
//
// Both use the same Document Engine search endpoint, so hit counts must match.
import { performance } from "node:perf_hooks";
import { searchWindow } from "./de.js";
import { acceleratedSearch, warmUp } from "./search.js";

const WEB_SDK_SERVER_WINDOWS = [10, 20, 50, 100, 200, 500];
const ms = (t) => Math.round(t * 10) / 10;

export async function nativeServerSearch(doc, query, { signal } = {}) {
  const t0 = performance.now();
  let start = 0;
  let left = doc.pageCount;
  let step = 0;
  let hits = 0;
  let firstHitMs = null;
  let requests = 0;
  while (left > 0) {
    if (signal?.aborted) break;
    let size = WEB_SDK_SERVER_WINDOWS[step];
    step += step >= WEB_SDK_SERVER_WINDOWS.length - 1 ? 0 : 1;
    if (left < 1.5 * size) size = left;
    const res = await searchWindow(doc.id, query, start, size, signal);
    requests++;
    hits += res.length;
    if (res.length && firstHitMs === null) firstHitMs = ms(performance.now() - t0);
    left -= size;
    start += size;
  }
  return { hits, firstHitMs, totalMs: ms(performance.now() - t0), requests };
}

export async function acceleratedRun(doc, query, { signal } = {}) {
  let plan = null;
  const done = await acceleratedSearch({
    doc,
    query,
    fromPage: 0,
    signal,
    emit: (e) => {
      if (e.type === "plan") plan = e;
    },
  });
  return { hits: done.hits, firstHitMs: done.firstHitMs, totalMs: done.totalMs, requests: done.requests, candidatePages: plan?.candidatePages };
}

let running = false;

export async function runBenchmark({ doc, queries, engines, signal, emit }) {
  if (running) throw new Error("A benchmark is already running.");
  running = true;
  try {
    emit({ type: "start", doc: doc.id, queries, engines });
    // Same starting point as a user who just opened the document in the viewer.
    await warmUp(doc);
    for (const query of queries) {
      for (const engine of engines) {
        if (signal?.aborted) return;
        emit({ type: "running", query, engine });
        try {
          const r = engine === "native" ? await nativeServerSearch(doc, query, { signal }) : await acceleratedRun(doc, query, { signal });
          emit({ type: "row", query, engine, ...r });
        } catch (err) {
          if (signal?.aborted) return;
          emit({ type: "row", query, engine, error: String(err?.message || err) });
        }
      }
    }
    emit({ type: "done" });
  } finally {
    running = false;
  }
}
