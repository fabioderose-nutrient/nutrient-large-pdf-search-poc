// Construction Document Search PoC - front end.
//
// Three ways to search the same document, switchable from the top bar:
//   accelerated  Web SDK server-backed viewer; the built-in search UI is kept,
//                but queries go to /api/documents/:id/search which streams the
//                hits computed by Document Engine on candidate pages only.
//   native       Web SDK server-backed viewer with its built-in search, as it
//                works out of the box against Document Engine.
//   browser      Web SDK standalone (WebAssembly): the PDF is downloaded and
//                searched inside this tab.

const $ = (sel) => document.querySelector(sel);
const SEARCH_DEBOUNCE_MS = 250; // same typing pause as the Web SDK built-in search
const ENGINE_LABEL = { accelerated: "Accelerated", native: "Built-in, Document Engine", browser: "Built-in, Web SDK in browser" };
const ENGINE_SHORT = { accelerated: "Accelerated", native: "Built-in DE", browser: "Built-in WASM" };
const ENGINE_DESC = {
  accelerated: "Document Engine, candidate pages only, in parallel",
  native: "Document Engine, whole document in growing page windows (Web SDK default)",
  browser: "WebAssembly engine inside this browser tab",
};

const state = {
  config: null,
  docs: [],
  currentId: null,
  loadChoice: "auto", // "auto" | "server" | "browser" (Open with)
  searchChoice: "accelerated", // "accelerated" | "builtin"
  bandwidth: 50, // Mbit/s assumed for the users (Auto routing)
  plans: {}, // docId -> load plan for the current bandwidth
  plan: null, // load plan of the open document
  openMs: null,
  mode: null, // "server" | "browser" (what the viewer is loaded with)
  instance: null,
  loadToken: 0,
  measure: null,
  history: loadHistory(),
  searchEntries: [], // DE /search resource timings (built-in modes)
  linesEnabled: false,
  linesPage: null,
  bench: { controller: null, rows: [] },
};

// ---------------------------------------------------------------- utilities
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function fmtMs(v) {
  if (v == null || Number.isNaN(v)) return "-";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60000) return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} s`;
  const m = Math.floor(v / 60000);
  const s = Math.round((v % 60000) / 1000);
  return `${m} min ${String(s).padStart(2, "0")} s`;
}
const fmtNum = (n) => (n == null ? "-" : n.toLocaleString("en-US"));
const fmtMB = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const currentDoc = () => state.docs.find((d) => d.id === state.currentId) || null;

function pageRanges(pages) {
  const out = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}-${b + 1}`)).join(", ");
}

let toastTimer;
function toast(msg, kind = "info", ms = 4200) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("pdf-search-history") || "[]");
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    localStorage.setItem("pdf-search-history", JSON.stringify(state.history.slice(0, 15)));
  } catch {}
}

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/></svg>',
  browser: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>',
};

// ---------------------------------------------------------------- library
async function refreshDocs() {
  try {
    const docs = await api("/api/documents");
    const prev = currentDoc();
    state.docs = docs;
    renderLibrary();
    renderSidePanels();
    const now = currentDoc();
    // The open document was rewritten by OCR: reopen it on the new version.
    if (prev && now && now.status === "ready" && (now.revision || 0) > (state.openedRevision ?? 0)) {
      toast("Document updated by OCR. Reopening it with the new text layer.");
      openDocument(now.id, state.mode, state.plan);
    }
  } catch (err) {
    console.error(err);
  }
  const busy = state.docs.some((d) => d.status === "processing" || d.status === "indexing" || d.ocr?.state === "running");
  clearTimeout(refreshDocs.timer);
  refreshDocs.timer = setTimeout(refreshDocs, busy ? 1500 : 10000);
}

function statusChips(d) {
  const chips = [];
  if (d.status === "processing") chips.push(`<span class="chip chip-info">${ICON.clock}Uploading to Document Engine</span>`);
  if (d.status === "indexing") chips.push(`<span class="chip chip-info">${ICON.clock}Extracting text ${fmtNum(d.index?.done || 0)} / ${fmtNum(d.index?.total || d.pageCount)}</span>`);
  if (d.status === "ready") chips.push(`<span class="chip chip-ok">${ICON.check}Search index ready</span>`);
  if (d.status === "error") chips.push(`<span class="chip chip-err" title="${esc(d.error || "")}">${ICON.warn}Error</span>`);
  if (d.ocr?.state === "running") chips.push(`<span class="chip chip-info">${ICON.clock}OCR running</span>`);
  else if (d.textlessPages?.length) chips.push(`<span class="chip chip-warn" title="Pages ${pageRanges(d.textlessPages)}">${ICON.warn}${d.textlessPages.length} pages without text</span>`);
  const plan = state.plans[d.id] || d.loadPlan;
  if (d.pageCount && plan?.estimate) chips.push(`<span class="chip" title="${esc(plan.reasons.join(". "))}">${plan.mode === "server" ? ICON.server : ICON.browser}Auto: ${plan.mode === "server" ? "Document Engine" : "Web SDK"}</span>`);
  return chips.join("");
}

function renderLibrary() {
  $("#doc-count").textContent = state.docs.length ? `${state.docs.length}` : "";
  const list = $("#doc-list");
  if (!state.docs.length) {
    list.innerHTML = '<li class="muted small">No documents yet. Add a PDF above, or drop files in the documents folder and restart.</li>';
    return;
  }
  list.innerHTML = state.docs
    .map((d) => {
      const pct = d.status === "indexing" && d.index?.total ? Math.round((100 * (d.index.done || 0)) / d.index.total) : null;
      return `<li class="doc ${d.id === state.currentId ? "active" : ""}" data-id="${esc(d.id)}" tabindex="0" role="button" aria-label="Open ${esc(d.title)}">
        <div class="doc-title">${esc(d.title)}</div>
        <div class="doc-meta">${d.pageCount ? `${fmtNum(d.pageCount)} pages &middot; ` : ""}${fmtMB(d.byteSize || 0)}</div>
        <div class="doc-status">${statusChips(d)}</div>
        ${pct != null ? `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>` : ""}
        ${d.origin === "upload" ? `<button class="doc-delete" data-delete="${esc(d.id)}" title="Delete this document" aria-label="Delete ${esc(d.title)}">${ICON.trash}</button>` : ""}
      </li>`;
    })
    .join("");
}

$("#doc-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-delete]");
  if (del) {
    e.stopPropagation();
    const d = state.docs.find((x) => x.id === del.dataset.delete);
    if (!d || !window.confirm(`Delete "${d.title}" from Document Engine?`)) return;
    try {
      if (d.id === state.currentId) await closeViewer();
      await api(`/api/documents/${encodeURIComponent(d.id)}`, { method: "DELETE" });
      toast("Document deleted.");
      refreshDocs();
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const li = e.target.closest(".doc");
  if (li) selectDocument(li.dataset.id);
});
$("#doc-list").addEventListener("keydown", (e) => {
  const li = e.target.closest(".doc");
  if (li && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    selectDocument(li.dataset.id);
  }
});

// Load plan of a document for the selected user bandwidth (load-routing.js).
async function fetchPlan(id) {
  const plan = await api(`/api/documents/${encodeURIComponent(id)}/load-plan?bandwidth=${state.bandwidth}`);
  state.plans[id] = plan;
  return plan;
}

async function refreshPlans() {
  await Promise.all(state.docs.filter((d) => d.profile).map((d) => fetchPlan(d.id).catch(() => null)));
  renderLibrary();
}

// Auto routing: simple files open in the browser,
// heavy ones server-backed. "Open with" overrides it at any time.
async function selectDocument(id, { force = false } = {}) {
  const d = state.docs.find((x) => x.id === id);
  if (!d) return;
  if (!d.pageCount) return toast("This document is still being uploaded to Document Engine.");
  let plan = null;
  try {
    plan = await fetchPlan(id);
  } catch {}
  const mode = state.loadChoice === "auto" ? plan?.mode || "server" : state.loadChoice;
  if (mode === "browser" && plan?.mode === "server")
    toast(`Opening ${fmtMB(d.byteSize)} in the browser: the whole file is downloaded and processed with WebAssembly in this tab. Auto would use Document Engine.`, "info", 9000);
  if (!force && id === state.currentId && mode === state.mode && state.instance) {
    state.plan = plan;
    renderRoute();
    return;
  }
  openDocument(id, mode, plan);
}

// Upload: raw PDF body streamed to the app, then to Document Engine.
function uploadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return toast("Only PDF files are supported.", "error");
  const box = $("#upload-progress");
  box.hidden = false;
  $("#upload-name").textContent = `Uploading ${file.name} (${fmtMB(file.size)})`;
  $("#upload-bar").style.width = "0%";
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/documents?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader("Content-Type", "application/pdf");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) $("#upload-bar").style.width = `${Math.round((100 * e.loaded) / e.total)}%`;
  };
  xhr.onload = () => {
    box.hidden = true;
    if (xhr.status >= 200 && xhr.status < 300) {
      toast("Uploaded. Document Engine is processing it, then the text index is built.");
      refreshDocs();
    } else {
      let msg = `Upload failed (${xhr.status})`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      toast(msg, "error");
    }
  };
  xhr.onerror = () => {
    box.hidden = true;
    toast("Upload failed.", "error");
  };
  xhr.send(file);
}
$("#file-input").addEventListener("change", (e) => {
  uploadFile(e.target.files[0]);
  e.target.value = "";
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => (e.preventDefault(), dz.classList.add("drag"))));
["dragleave", "drop"].forEach((t) => dz.addEventListener(t, () => dz.classList.remove("drag")));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadFile(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------- viewer
async function closeViewer() {
  state.loadToken++;
  if (state.instance) {
    try {
      NutrientViewer.unload(state.instance);
    } catch {}
  }
  state.instance = null;
  state.mode = null;
  state.currentId = null;
  $("#viewer-bar").hidden = true;
  $("#empty-state").hidden = false;
  renderLibrary();
  renderSidePanels();
}

async function openDocument(id, mode, plan) {
  const d = state.docs.find((x) => x.id === id);
  if (!d) return;
  const token = ++state.loadToken;
  abortAccelerated();
  if (state.instance) {
    try {
      NutrientViewer.unload(state.instance);
    } catch {}
    state.instance = null;
  }
  state.currentId = id;
  state.openedRevision = d.revision || 0;
  state.mode = mode;
  state.plan = plan || state.plans[id] || null;
  state.openMs = null;
  state.linesPage = null;
  renderLibrary();
  renderRoute();
  renderSidePanels();
  $("#empty-state").hidden = true;
  $("#viewer-bar").hidden = false;
  $("#viewer-title").textContent = d.title;
  const modeChip = $("#viewer-mode");
  modeChip.textContent = mode === "server" ? "Document Engine (server-backed)" : "Web SDK (in the browser)";
  modeChip.className = `chip ${mode === "server" ? "chip-info" : ""}`;
  const loading = $("#viewer-loading");
  loading.hidden = false;
  $("#viewer-loading-text").textContent =
    mode === "server" ? "Opening document from Document Engine..." : `Downloading ${fmtMB(d.byteSize)} into the browser, then opening it with WebAssembly. Large files take a while.`;

  const t0 = performance.now();
  try {
    if (typeof NutrientViewer === "undefined") throw new Error("The Nutrient Web SDK script did not load.");
    const common = {
      container: "#viewer",
      baseUrl: `${location.origin}/vendor/nutrient/`,
      theme: NutrientViewer.Theme.LIGHT,
      toolbarPlacement: NutrientViewer.ToolbarPlacement.TOP,
    };
    let conf;
    if (mode === "server") {
      const s = await api(`/api/documents/${encodeURIComponent(id)}/session`);
      conf = { ...common, serverUrl: s.serverUrl, documentId: s.documentId, authPayload: { jwt: s.jwt }, instant: true };
    } else {
      conf = { ...common, document: `/api/documents/${encodeURIComponent(id)}/source.pdf` };
      if (state.config.webSdkLicenseKey) conf.licenseKey = state.config.webSdkLicenseKey;
    }
    const instance = await NutrientViewer.load(conf);
    if (token !== state.loadToken) {
      NutrientViewer.unload(instance);
      return;
    }
    state.instance = instance;
    state.openMs = performance.now() - t0;
    wireInstance(instance);
    fitFirstPage(instance);
    renderRoute();
    renderSidePanels();
  } catch (err) {
    if (token === state.loadToken) {
      console.error(err);
      toast(`Could not open the document: ${err.message || err}`, "error", 8000);
    }
  } finally {
    if (token === state.loadToken) loading.hidden = true;
  }
}

// Spec books often end with large-format drawing sheets; the default zoom then
// fits the widest sheet and letter pages look tiny. Fit the first page instead.
function fitFirstPage(instance) {
  const n = instance.totalPageCount;
  const w0 = instance.pageInfoForIndex(0)?.width || 0;
  let maxW = 0;
  for (let i = 0; i < n; i++) maxW = Math.max(maxW, instance.pageInfoForIndex(i)?.width || 0);
  if (!w0 || maxW < 1.5 * w0) return;
  const avail = $("#viewer").clientWidth - 64;
  instance.setViewState((v) => v.set("zoom", Math.max(0.1, Math.min(2, avail / w0))));
}

function wireInstance(instance) {
  instance.addEventListener("search.termChange", onTermChange);
  instance.addEventListener("search.stateChange", onSearchState);
  instance.addEventListener("viewState.currentPageIndex.change", (page) => {
    if (state.linesEnabled) showLines(page);
  });
  if (state.linesEnabled) showLines(instance.viewState.currentPageIndex);
}

// Resource timings of the Web SDK's own /search requests (built-in modes).
try {
  performance.setResourceTimingBufferSize(5000);
} catch {}
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (/\/search\?q=/.test(e.name) && !e.name.includes("/api/documents/")) {
      state.searchEntries.push({ name: e.name, start: e.startTime, end: e.responseEnd });
      if (state.searchEntries.length > 500) state.searchEntries.splice(0, 250);
      if (state.measure && !state.measure.done) updatePerf();
    }
  }
}).observe({ type: "resource", buffered: false });

// ---------------------------------------------------------------- switches
// Engine key used for measurements: accelerated, native (built-in search on a
// server-backed viewer) or browser (built-in search in WebAssembly).
const currentEngine = () => (state.searchChoice === "accelerated" ? "accelerated" : state.mode === "browser" ? "browser" : "native");

function renderSwitches() {
  document.querySelectorAll("#load-switch button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.load === state.loadChoice)));
  document.querySelectorAll("#search-switch button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.search === state.searchChoice)));
}

document.querySelectorAll("#load-switch button").forEach((b) =>
  b.addEventListener("click", () => {
    state.loadChoice = b.dataset.load;
    renderSwitches();
    if (state.currentId) selectDocument(state.currentId);
  })
);
document.querySelectorAll("#search-switch button").forEach((b) =>
  b.addEventListener("click", () => {
    state.searchChoice = b.dataset.search;
    renderSwitches();
    abortAccelerated();
    // Clear the previous results so the next search is measured cleanly.
    if (state.instance) state.instance.setSearchState((s) => s.set("results", NutrientViewer.Immutable.List()).set("isLoading", false));
    state.measure = null;
    renderSidePanels();
  })
);
$("#bandwidth").addEventListener("change", async (e) => {
  state.bandwidth = Number(e.target.value);
  await refreshPlans();
  // In Auto, a slower network can move the open document to Document Engine (or back).
  if (state.currentId && state.loadChoice === "auto") {
    const plan = state.plans[state.currentId];
    if (plan && plan.mode !== state.mode) toast(`At ${state.bandwidth} Mbit/s, Auto now opens this document with ${plan.mode === "server" ? "Document Engine" : "the Web SDK in the browser"}.`);
    selectDocument(state.currentId);
  } else renderRoute();
});

// The line under the document title: which loader is used and why.
function renderRoute() {
  const d = currentDoc();
  const plan = state.plan;
  const sum = $("#route-summary");
  const body = $("#route-body");
  $("#viewer-open").textContent = state.openMs != null ? `opened in ${fmtMs(state.openMs)}` : "";
  if (!d || !plan?.estimate) {
    sum.textContent = "";
    body.innerHTML = "";
    return;
  }
  const how = state.loadChoice === "auto" ? "Auto routing" : "Forced by Open with";
  const loader = state.mode === "server" ? "Document Engine" : "Web SDK in the browser";
  const est = plan.estimate;
  sum.innerHTML = `${how}: <b>${loader}</b>. In the browser this file would take about <b>${fmtMs(est.total * 1000)}</b> to open at ${plan.bandwidthMbps} Mbit/s.`;
  const p = plan.profile || d.profile || {};
  const rows = [
    ["File size", `${fmtNum(p.sizeMB)} MB`],
    ["Pages", fmtNum(p.pageCount)],
    ["Large-format sheets", fmtNum(p.largeFormatPages)],
    ["Largest sheet", p.largestSheet || "-"],
    ["Pages without text (scans)", fmtNum(p.scannedPages)],
    ["Average per page", `${p.mbPerPage} MB`],
    ["Browser download", fmtMs(est.download * 1000)],
    ["Browser processing", fmtMs(est.processing * 1000)],
  ];
  const r = state.config.routing;
  body.innerHTML = `<div><ul>${plan.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
    <div class="route-note">Auto opens a file in the browser only if it opens within ${r.maxClientOpenSeconds} s and stays under ${r.maxClientMB} MB, ${fmtNum(r.maxClientPages)} pages and ${r.maxClientLargeFormatPages} large-format sheets; otherwise Document Engine renders it on the server. Thresholds are set in docker-compose.yml.</div>`;
}

// ---------------------------------------------------------------- search
let debounceTimer = null;
let accel = null; // { controller, term, results: [], applied, focusKey }

function abortAccelerated() {
  clearTimeout(debounceTimer);
  if (accel?.controller) accel.controller.abort();
  accel = null;
}

function onTermChange(event) {
  const term = event.term;
  if (state.searchChoice !== "accelerated") {
    beginMeasure(term, currentEngine());
    return;
  }
  // Accelerated: keep the built-in search UI, replace where results come from.
  event.preventDefault();
  const instance = state.instance;
  instance.setSearchState((s) => s.set("term", term));
  abortAccelerated();
  if (term.trim().length < 2) {
    instance.setSearchState((s) => s.set("results", NutrientViewer.Immutable.List()).set("isLoading", false).set("focusedResultIndex", -1));
    state.measure = null;
    updatePerf();
    return;
  }
  instance.setSearchState((s) => s.set("isLoading", true));
  debounceTimer = setTimeout(() => runAccelerated(term), SEARCH_DEBOUNCE_MS);
}

function beginMeasure(term, engine) {
  if (!term || term.trim().length < 2) {
    state.measure = null;
    updatePerf();
    return;
  }
  const now = performance.now();
  state.measure = {
    term,
    engine,
    doc: state.currentId,
    changedAt: now,
    t0: engine === "browser" ? now + SEARCH_DEBOUNCE_MS : null,
    firstAt: null,
    doneAt: null,
    sawLoading: false,
    hits: 0,
    pages: 0,
    plan: null,
    requestsDone: 0,
    done: false,
  };
  updatePerf();
  tickPerf();
}

// Built-in modes: results arrive through the Web SDK search state.
function onSearchState(s) {
  const m = state.measure;
  if (accel && state.searchChoice === "accelerated") {
    // Remember which result the user focused, so streaming inserts do not move it.
    const idx = s.focusedResultIndex;
    if (idx >= 0 && idx !== accel.appliedFocus && accel.sorted?.[idx]) accel.focusKey = accel.sorted[idx].key;
    return;
  }
  if (!m || m.engine === "accelerated" || m.done || s.term !== m.term) return;
  if (s.isLoading) m.sawLoading = true;
  const n = s.results.size;
  if (n > 0 && m.firstAt == null) m.firstAt = performance.now();
  m.hits = n;
  m.pages = new Set(s.results.map((r) => r.pageIndex).toArray()).size;
  if (m.sawLoading && !s.isLoading) {
    m.doneAt = performance.now();
    m.done = true;
    setTimeout(() => finishMeasure(m), 400); // let the last resource timing arrive
  }
  updatePerf();
}

function measureStart(m) {
  if (m.engine === "native") {
    const first = state.searchEntries.find((e) => e.start >= m.changedAt && e.name.includes(`q=${encodeURIComponent(m.term)}`));
    m.requestsDone = state.searchEntries.filter((e) => e.start >= m.changedAt && e.name.includes(`q=${encodeURIComponent(m.term)}`)).length;
    if (first) m.t0 = first.start;
  }
  return m.t0;
}

function finishMeasure(m) {
  measureStart(m);
  if (m.t0 == null) m.t0 = m.changedAt + SEARCH_DEBOUNCE_MS;
  pushHistory(m);
  updatePerf();
}

function pushHistory(m) {
  state.history.unshift({
    term: m.term,
    engine: m.engine,
    doc: m.doc,
    first: m.firstAt != null ? m.firstAt - m.t0 : null,
    total: m.doneAt != null ? m.doneAt - m.t0 : null,
    hits: m.hits,
  });
  state.history = state.history.slice(0, 15);
  saveHistory();
  renderHistory();
}

async function runAccelerated(term) {
  const instance = state.instance;
  const doc = currentDoc();
  if (!instance || !doc) return;
  const controller = new AbortController();
  const run = { controller, term, results: [], sorted: [], focusKey: null, appliedFocus: -1, dirty: false, timer: null };
  accel = run;
  const m = {
    term,
    engine: "accelerated",
    doc: doc.id,
    t0: performance.now(),
    firstAt: null,
    doneAt: null,
    hits: 0,
    pages: 0,
    plan: null,
    requestsDone: 0,
    done: false,
  };
  state.measure = m;
  updatePerf();
  tickPerf();
  const pageSet = new Set();
  const from = instance.viewState.currentPageIndex;
  const apply = (final) => {
    if (accel !== run) return;
    run.timer = null;
    run.sorted = run.results.slice().sort((a, b) => a.p - b.p || a.top - b.top || a.left - b.left);
    let focus = -1;
    if (run.focusKey) focus = run.sorted.findIndex((r) => r.key === run.focusKey);
    if (focus < 0 && run.sorted.length) {
      // Like the built-in search: focus the first hit from the current page on.
      focus = run.sorted.findIndex((r) => r.p >= from);
      if (focus < 0) focus = 0;
      run.focusKey = run.sorted[focus].key;
    }
    run.appliedFocus = focus;
    const list = NutrientViewer.Immutable.List(run.sorted.map((r) => r.result));
    instance.setSearchState((s) => s.set("term", term).set("results", list).set("isLoading", !final).set("focusedResultIndex", focus));
    if (!run.jumped && focus >= 0) {
      // Like the built-in search: bring the first hit into view once.
      run.jumped = true;
      const r = run.sorted[focus].result;
      instance.jumpToRect(r.pageIndex, NutrientViewer.Geometry.Rect.union(r.rectsOnPage));
    }
  };
  const schedule = () => {
    if (!run.timer) run.timer = setTimeout(() => apply(false), 120);
  };
  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/search?q=${encodeURIComponent(term)}&from=${from}`, { signal: controller.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Search failed (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.type === "plan") m.plan = e;
        else if (e.type === "hits") {
          m.requestsDone++;
          for (const h of e.hits) {
            const rects = h.rects.map(([left, top, width, height]) => new NutrientViewer.Geometry.Rect({ left, top, width, height }));
            const first = h.rects[0] || [0, 0];
            run.results.push({
              p: h.p,
              left: first[0],
              top: first[1],
              key: `${h.p}:${first[0].toFixed(1)}:${first[1].toFixed(1)}`,
              result: new NutrientViewer.SearchResult({
                pageIndex: h.p,
                previewText: h.text,
                locationInPreview: h.range?.[0] ?? null,
                lengthInPreview: h.range?.[1] ?? null,
                rectsOnPage: NutrientViewer.Immutable.List(rects),
                isAnnotation: false,
              }),
            });
            pageSet.add(h.p);
          }
          m.hits = run.results.length;
          m.pages = pageSet.size;
          if (e.hits.length && m.firstAt == null) {
            m.firstAt = performance.now();
            apply(false); // first hits: show them right away
          } else if (e.hits.length) schedule();
          updatePerf();
        } else if (e.type === "done") {
          m.doneAt = performance.now();
          m.done = true;
        } else if (e.type === "error") throw new Error(e.message);
      }
    }
    if (accel !== run) return;
    clearTimeout(run.timer);
    apply(true);
    if (!m.doneAt) {
      m.doneAt = performance.now();
      m.done = true;
    }
    pushHistory(m);
    updatePerf();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    toast(err.message, "error");
    instance.setSearchState((s) => s.set("isLoading", false));
    m.done = true;
    updatePerf();
  }
}

// ---------------------------------------------------------------- perf panel
function tickPerf() {
  cancelAnimationFrame(tickPerf.raf);
  const loop = () => {
    updatePerf();
    if (state.measure && !state.measure.done) tickPerf.raf = requestAnimationFrame(loop);
  };
  tickPerf.raf = requestAnimationFrame(loop);
}

function classFor(v, good, slow) {
  if (v == null) return "";
  return v <= good ? "good" : v <= slow ? "slow" : "bad";
}

function updatePerf() {
  const m = state.measure;
  const engineChip = $("#perf-engine");
  const engine = m?.engine || currentEngine();
  engineChip.textContent = ENGINE_LABEL[engine];
  engineChip.dataset.engine = engine;
  const doc = state.docs.find((d) => d.id === (m?.doc || state.currentId));
  const set = (id, text, cls = "") => {
    const el = $(id);
    el.textContent = text;
    el.className = `metric-value ${cls}`;
  };
  const facts = [];
  if (!m) {
    $("#perf-query").innerHTML = '<span class="muted">Run a search in the viewer.</span>';
    set("#m-first", "-");
    set("#m-total", "-");
    set("#m-hits", "-");
    set("#m-pages", "-");
    $("#m-bar").style.width = "0%";
  } else {
    if (m.engine === "native") measureStart(m);
    const t0 = m.t0;
    const now = performance.now();
    $("#perf-query").textContent = `"${m.term}"`;
    const first = t0 != null && m.firstAt != null ? m.firstAt - t0 : null;
    const total = t0 != null ? (m.doneAt ?? now) - t0 : null;
    set("#m-first", first != null ? fmtMs(first) : m.done ? "no hits" : "...", classFor(first, 500, 3000));
    set("#m-total", total == null ? "..." : m.done ? fmtMs(total) : `${fmtMs(Math.max(0, total))}...`, m.done ? classFor(total, 3000, 15000) : "");
    set("#m-hits", fmtNum(m.hits));
    set("#m-pages", fmtNum(m.pages));
    let pct = m.done ? 100 : 0;
    if (!m.done && m.plan?.requests) pct = Math.round((100 * m.requestsDone) / m.plan.requests);
    else if (!m.done) pct = 15;
    $("#m-bar").style.width = `${pct}%`;
    facts.push(["Engine", ENGINE_DESC[m.engine]]);
    if (m.plan) {
      facts.push(["Candidate pages (text index)", `${fmtNum(m.plan.candidatePages)} of ${fmtNum(m.plan.pageCount)} in ${fmtMs(m.plan.planMs)}`]);
      facts.push(["Document Engine requests", `${fmtNum(m.requestsDone)} / ${fmtNum(m.plan.requests)}, up to ${state.config.searchConcurrency} in parallel`]);
      if (m.plan.estimatedMatches != null) facts.push(["Instant estimate", `${fmtNum(m.plan.estimatedMatches)} matches`]);
    }
    if (m.engine === "native") facts.push(["Document Engine requests", `${fmtNum(m.requestsDone)}${m.done ? "" : " so far"}, one at a time, whole document`]);
    if (m.engine === "browser") facts.push(["Network requests", "none, the whole PDF is in this tab"]);
  }
  if (doc) facts.push(["Document", `${fmtNum(doc.pageCount)} pages, ${fmtMB(doc.byteSize)}`]);
  $("#perf-facts").innerHTML = facts.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join("");
}

function renderHistory() {
  const rows = state.history;
  $("#history").innerHTML = rows.length
    ? rows
        .map(
          (h) => `<tr title="${esc(`${ENGINE_LABEL[h.engine]} on ${state.docs.find((d) => d.id === h.doc)?.title || h.doc}`)}">
        <td><span class="tag tag-${h.engine}"></span>${esc(h.term)}</td>
        <td>${esc(ENGINE_SHORT[h.engine])}</td>
        <td class="num">${fmtMs(h.first)}</td>
        <td class="num">${fmtMs(h.total)}</td>
        <td class="num">${fmtNum(h.hits)}</td></tr>`
        )
        .join("")
    : '<tr class="empty-row"><td colspan="5">Searches you run appear here, to compare engines.</td></tr>';
}
$("#clear-history").addEventListener("click", () => {
  state.history = [];
  saveHistory();
  renderHistory();
});

// ---------------------------------------------------------------- OCR + text lines
function renderSidePanels() {
  const d = currentDoc();
  const ocrCard = $("#ocr-card");
  const linesCard = $("#lines-card");
  if (!d || d.status !== "ready") {
    ocrCard.hidden = d?.ocr?.state !== "running";
    linesCard.hidden = true;
  } else {
    linesCard.hidden = false;
    $("#lines-download").href = `/api/documents/${encodeURIComponent(d.id)}/text-lines.json`;
    const pages = d.textlessPages || [];
    const ocr = d.ocr || { state: "idle" };
    ocrCard.hidden = !pages.length && ocr.state !== "running" && ocr.state !== "done";
    const btn = $("#ocr-run");
    const bar = $("#ocr-bar");
    bar.hidden = ocr.state !== "running";
    if (ocr.state === "running") {
      const since = ocr.startedAt ? Date.now() - Date.parse(ocr.startedAt) : 0;
      const ocrMs = ocr.estimatedOcrMs || 0;
      const est = ocrMs + (ocr.estimatedSaveMs || 0);
      const onePass = ocr.strategy === "one-pass";
      const saving = onePass && (ocr.phase ? ocr.phase === "save" : since >= ocrMs);
      const step = !onePass
        ? `OCR of <b>${ocr.pages.length}</b> pages (${esc(pageRanges(ocr.pages))}), then the ${fmtMB(d.byteSize)} document is saved`
        : saving
          ? `Step 2 of 2: putting the OCR'd pages back into the ${fmtMB(d.byteSize)} document`
          : `Step 1 of 2: OCR of <b>${ocr.pages.length}</b> scattered pages in one pass (${esc(pageRanges(ocr.pages))})`;
      const left = est - since;
      const eta = est ? (left > 5000 ? `about ${fmtMs(left)} left` : "taking a little longer than estimated") : "";
      $("#ocr-text").innerHTML = `${ocr.auto ? "Started automatically. " : ""}${step}. ${fmtMs(since)} elapsed${eta ? `, ${eta}` : ""} (estimate). Search keeps working on every other page meanwhile.`;
      $("#ocr-bar-fill").style.width = `${est ? Math.min(97, Math.round((100 * since) / est)) : 30}%`;
      btn.disabled = true;
      btn.hidden = true;
    } else if (pages.length) {
      $("#ocr-text").innerHTML = `<b>${pages.length}</b> pages have no text layer (raster drawings or scans), so search cannot find anything on them: pages ${esc(pageRanges(pages))}. Document Engine can OCR these pages only, without touching the others.`;
      btn.disabled = false;
      btn.hidden = false;
    } else if (ocr.state === "done") {
      $("#ocr-text").innerHTML = `OCR finished${ocr.auto ? " (started automatically)" : ""}: <b>${ocr.pages.length}</b> pages made searchable in ${fmtMs(ocr.ms)}. Every page now has a text layer.`;
      btn.hidden = true;
    }
    if (ocr.state === "error") $("#ocr-text").innerHTML += `<br><span class="chip chip-err">${ICON.warn}${esc(ocr.error)}</span>`;
  }
  updatePerf();
}

$("#ocr-run").addEventListener("click", async () => {
  const d = currentDoc();
  if (!d) return;
  try {
    await api(`/api/documents/${encodeURIComponent(d.id)}/ocr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    toast("OCR started on the pages without text.");
    refreshDocs();
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#lines-toggle").addEventListener("change", (e) => {
  state.linesEnabled = e.target.checked;
  if (state.linesEnabled && state.instance) showLines(state.instance.viewState.currentPageIndex);
  else clearLines();
});

function clearLines() {
  if (state.instance && state.linesPage != null) {
    try {
      state.instance.removeCustomOverlayItem("text-lines");
    } catch {}
  }
  state.linesPage = null;
  $("#lines-list").innerHTML = "";
  $("#lines-meta").textContent = "";
}

async function showLines(page) {
  const d = currentDoc();
  const instance = state.instance;
  if (!d || !instance) return;
  try {
    const data = await api(`/api/documents/${encodeURIComponent(d.id)}/pages/${page}/lines`);
    if (!state.linesEnabled || state.instance !== instance) return;
    clearLines();
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "lines-overlay");
    svg.style.pointerEvents = "none";
    svg.style.display = "block";
    svg.setAttribute("width", data.width);
    svg.setAttribute("height", data.height);
    svg.setAttribute("viewBox", `0 0 ${data.width} ${data.height}`);
    data.lines.forEach((l, i) => {
      if (!l.text.trim()) return;
      const r = document.createElementNS(NS, "rect");
      // Inline attributes: overlay items render inside the viewer's own DOM,
      // where this page's stylesheet does not apply.
      r.setAttribute("fill", "rgba(3, 105, 161, 0.08)");
      r.setAttribute("stroke", "rgba(3, 105, 161, 0.8)");
      r.setAttribute("stroke-width", "1");
      r.setAttribute("vector-effect", "non-scaling-stroke");
      r.setAttribute("x", l.left);
      r.setAttribute("y", l.top);
      r.setAttribute("width", Math.max(l.width, 0.5));
      r.setAttribute("height", Math.max(l.height, 0.5));
      r.dataset.i = i;
      svg.appendChild(r);
    });
    instance.setCustomOverlayItem(
      new NutrientViewer.CustomOverlayItem({ id: "text-lines", node: svg, pageIndex: page, position: new NutrientViewer.Geometry.Point({ x: 0, y: 0 }) })
    );
    state.linesPage = page;
    state.linesSvg = svg;
    state.linesData = data;
    const visible = data.lines.map((l, i) => ({ ...l, i })).filter((l) => l.text.trim());
    $("#lines-meta").textContent = `Page ${page + 1}: ${fmtNum(visible.length)} text lines. Click one to locate it.`;
    $("#lines-list").innerHTML = visible
      .slice(0, 500)
      .map((l) => `<li data-i="${l.i}"><span>${esc(l.text.trim())}</span><span>${Math.round(l.left)}, ${Math.round(l.top)}</span></li>`)
      .join("");
  } catch (err) {
    $("#lines-meta").textContent = err.message;
  }
}

$("#lines-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li || !state.instance || !state.linesData) return;
  const l = state.linesData.lines[Number(li.dataset.i)];
  state.linesSvg?.querySelectorAll("rect[data-focus]").forEach((r) => {
    r.removeAttribute("data-focus");
    r.setAttribute("fill", "rgba(3, 105, 161, 0.08)");
    r.setAttribute("stroke", "rgba(3, 105, 161, 0.8)");
    r.setAttribute("stroke-width", "1");
  });
  const rect = state.linesSvg?.querySelector(`rect[data-i="${li.dataset.i}"]`);
  if (rect) {
    rect.setAttribute("data-focus", "1");
    rect.setAttribute("fill", "rgba(250, 204, 21, 0.4)");
    rect.setAttribute("stroke", "#ca8a04");
    rect.setAttribute("stroke-width", "2");
  }
  $("#lines-list").querySelectorAll("li.on").forEach((x) => x.classList.remove("on"));
  li.classList.add("on");
  const pad = 40;
  state.instance.jumpToRect(
    state.linesPage,
    new NutrientViewer.Geometry.Rect({ left: l.left - pad, top: l.top - pad, width: l.width + 2 * pad, height: l.height + 2 * pad })
  );
});

// ---------------------------------------------------------------- benchmark
const bench = $("#bench");

async function fillBenchQueries(docId) {
  const defaults = ["fire alarm", "concrete"];
  let suggestions = [];
  try {
    suggestions = (await api(`/api/documents/${encodeURIComponent(docId)}/suggestions`)).map((s) => s.q);
  } catch {}
  const list = [...new Set([...suggestions.slice(0, 4), ...defaults])];
  $("#bench-queries").value = list.join("\n");
}

$("#open-bench").addEventListener("click", async () => {
  const ready = state.docs.filter((d) => d.status === "ready");
  if (!ready.length) return toast("No document is ready yet.");
  const sel = $("#bench-doc");
  sel.innerHTML = ready.map((d) => `<option value="${esc(d.id)}">${esc(d.title)} (${fmtNum(d.pageCount)} pages)</option>`).join("");
  sel.value = ready.some((d) => d.id === state.currentId) ? state.currentId : ready[0].id;
  updateBrowserBenchRow();
  if (!state.bench.rows.length || !$("#bench-queries").value.trim()) await fillBenchQueries(sel.value);
  bench.showModal();
});
$("#bench-close").addEventListener("click", () => bench.close());
$("#bench-doc").addEventListener("change", (e) => {
  fillBenchQueries(e.target.value);
  updateBrowserBenchRow();
});

function updateBrowserBenchRow() {
  const ok = state.mode === "browser" && state.instance && state.currentId === $("#bench-doc").value;
  const row = $("#bench-browser-row");
  const cb = row.querySelector("input");
  row.classList.toggle("disabled", !ok);
  cb.disabled = !ok;
  if (!ok) cb.checked = false;
}

function benchRowHtml(r) {
  const native = state.bench.rows.find((x) => x.query === r.query && x.engine === "native" && !x.error && x.totalMs != null);
  const speed = r.engine === "accelerated" && native && r.totalMs ? `x${Math.max(1, Math.round(native.totalMs / r.totalMs))}` : "";
  if (r.running) return `<tr class="running"><td>${esc(r.query)}</td><td><span class="tag tag-${r.engine}"></span>${ENGINE_LABEL[r.engine]}</td><td class="num" colspan="5">running...</td></tr>`;
  if (r.error) return `<tr><td>${esc(r.query)}</td><td><span class="tag tag-${r.engine}"></span>${ENGINE_LABEL[r.engine]}</td><td colspan="5"><span class="chip chip-err">${esc(r.error)}</span></td></tr>`;
  return `<tr><td>${esc(r.query)}</td><td><span class="tag tag-${r.engine}"></span>${ENGINE_LABEL[r.engine]}</td>
    <td class="num">${r.firstHitMs == null ? (r.hits ? "n/a" : "no hits") : fmtMs(r.firstHitMs)}</td>
    <td class="num">${fmtMs(r.totalMs)}</td><td class="num">${fmtNum(r.hits)}</td>
    <td class="num">${r.requests == null ? "-" : fmtNum(r.requests)}</td><td class="num speed">${speed}</td></tr>`;
}
function renderBench() {
  $("#bench-rows").innerHTML = state.bench.rows.map(benchRowHtml).join("");
  $("#bench-csv").disabled = !state.bench.rows.some((r) => !r.running);
}

$("#bench-run").addEventListener("click", async () => {
  const docId = $("#bench-doc").value;
  const queries = $("#bench-queries").value.split("\n").map((q) => q.trim()).filter((q) => q.length >= 2);
  const engines = [...bench.querySelectorAll("fieldset input:checked")].map((i) => i.value);
  if (!queries.length || !engines.length) return toast("Add at least one query and one engine.");
  const serverEngines = engines.filter((e) => e !== "browser");
  state.bench.rows = [];
  renderBench();
  const controller = new AbortController();
  state.bench.controller = controller;
  $("#bench-run").hidden = true;
  $("#bench-stop").hidden = false;
  $("#bench-status").textContent = "Running...";
  try {
    if (serverEngines.length) {
      const res = await fetch("/api/bench", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, queries, engines: serverEngines }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Benchmark failed (${res.status})`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line) continue;
          const e = JSON.parse(line);
          if (e.type === "running") {
            state.bench.rows.push({ query: e.query, engine: e.engine, running: true });
            $("#bench-status").textContent = `Running "${e.query}" with ${ENGINE_LABEL[e.engine]}...`;
          } else if (e.type === "row") {
            const idx = state.bench.rows.findIndex((r) => r.running && r.query === e.query && r.engine === e.engine);
            const row = { query: e.query, engine: e.engine, firstHitMs: e.firstHitMs, totalMs: e.totalMs, hits: e.hits, requests: e.requests, error: e.error };
            if (idx >= 0) state.bench.rows[idx] = row;
            else state.bench.rows.push(row);
          } else if (e.type === "error") throw new Error(e.message);
          renderBench();
        }
      }
    }
    if (engines.includes("browser") && state.mode === "browser" && state.instance) {
      for (const q of queries) {
        if (controller.signal.aborted) break;
        state.bench.rows.push({ query: q, engine: "browser", running: true });
        renderBench();
        $("#bench-status").textContent = `Running "${q}" in this browser...`;
        const t = performance.now();
        const res = await state.instance.search(q);
        state.bench.rows[state.bench.rows.length - 1] = { query: q, engine: "browser", firstHitMs: null, totalMs: performance.now() - t, hits: res.size, requests: null };
        renderBench();
      }
    }
    $("#bench-status").textContent = "Done.";
  } catch (err) {
    $("#bench-status").textContent = controller.signal.aborted ? "Stopped." : err.message;
    state.bench.rows = state.bench.rows.filter((r) => !r.running);
    renderBench();
  } finally {
    $("#bench-run").hidden = false;
    $("#bench-stop").hidden = true;
    state.bench.controller = null;
  }
});
$("#bench-stop").addEventListener("click", () => state.bench.controller?.abort());

$("#bench-csv").addEventListener("click", () => {
  const doc = state.docs.find((d) => d.id === $("#bench-doc").value);
  const header = ["document", "pages", "query", "engine", "first_result_ms", "all_results_ms", "hits", "requests"];
  const lines = state.bench.rows
    .filter((r) => !r.running && !r.error)
    .map((r) => [doc?.title, doc?.pageCount, r.query, r.engine, r.firstHitMs ?? "", Math.round(r.totalMs), r.hits, r.requests ?? ""]);
  const csv = [header, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `search-benchmark-${doc?.id || "document"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- start
(async function init() {
  $("#kbd-mod").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "Cmd" : "Ctrl";
  renderHistory();
  try {
    state.config = await api("/api/config");
    state.bandwidth = state.config.routing.bandwidthMbps;
    const sel = $("#bandwidth");
    if (![...sel.options].some((o) => Number(o.value) === state.bandwidth)) sel.add(new Option(`Configured, ${state.bandwidth} Mbit/s`, String(state.bandwidth)));
    sel.value = String(state.bandwidth);
  } catch (err) {
    toast(`Cannot reach the app server: ${err.message}`, "error", 10000);
    return;
  }
  await refreshDocs();
  await refreshPlans();
  const first = state.docs.find((d) => d.status === "ready");
  if (first) selectDocument(first.id);
})();
