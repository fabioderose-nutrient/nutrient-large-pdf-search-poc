// Decides how a document should be opened in the viewer:
//
//   server   Document Engine renders the pages and streams image tiles; the
//            browser never downloads the PDF (instant open whatever the size).
//   browser  Web SDK standalone: the PDF is downloaded and opened with
//            WebAssembly in the tab (no server rendering cost, works offline
//            once loaded), fine for small and simple files.
//
// The decision uses the document's complexity profile, built once at upload
// time, and an estimate of how long the browser would need to open it.
import { config } from "./config.js";

const LETTER_AREA = 612 * 792; // PDF points
const LARGE_FORMAT_AREA = 2 * LETTER_AREA; // above tabloid / A3: drawing sheets

// Complexity profile of a document, from Document Engine's page info and the
// page text index (see text-index.js).
export function buildProfile({ byteSize, dims, textless }) {
  const pageCount = dims.length;
  const largeFormatPages = dims.filter(([w, h]) => w * h > LARGE_FORMAT_AREA).length;
  const largest = dims.reduce((m, d) => (d[0] * d[1] > m[0] * m[1] ? d : m), [0, 0]);
  const sizeMB = byteSize / 1048576;
  return {
    sizeMB: Math.round(sizeMB * 10) / 10,
    pageCount,
    largeFormatPages,
    scannedPages: textless.length,
    mbPerPage: pageCount ? Math.round((sizeMB / pageCount) * 100) / 100 : 0,
    largestSheet: largest[0] ? `${Math.round(largest[0] / 72)} x ${Math.round(largest[1] / 72)} in` : null,
  };
}

// Seconds the browser would need before the first page shows: download of
// the whole PDF at the given bandwidth, then WebAssembly parsing and first
// render (coefficients measured with Web SDK 1.23 on an Apple M2 Pro laptop,
// see README).
export function estimateBrowserOpen(profile, bandwidthMbps) {
  const download = (profile.sizeMB * 8) / Math.max(1, bandwidthMbps);
  const processing =
    config.clientOpenBaseSeconds +
    profile.sizeMB * config.clientOpenSecondsPerMB +
    profile.pageCount * config.clientOpenSecondsPerPage;
  return { download, processing, total: download + processing };
}

export function planLoad(profile, { bandwidthMbps = config.clientBandwidthMbps } = {}) {
  if (!profile) return { mode: "server", reasons: ["Document still being analysed"], estimate: null, bandwidthMbps };
  const estimate = estimateBrowserOpen(profile, bandwidthMbps);
  const reasons = [];
  if (estimate.total > config.maxClientOpenSeconds)
    reasons.push(`Opening it in the browser would take about ${fmtSeconds(estimate.total)} at ${bandwidthMbps} Mbit/s (limit ${config.maxClientOpenSeconds} s)`);
  if (profile.sizeMB > config.maxClientMB) reasons.push(`${profile.sizeMB} MB is above the ${config.maxClientMB} MB browser limit`);
  if (profile.pageCount > config.maxClientPages) reasons.push(`${profile.pageCount} pages is above the ${config.maxClientPages}-page browser limit`);
  if (profile.largeFormatPages > config.maxClientLargeFormatPages)
    reasons.push(`${profile.largeFormatPages} large-format sheets (limit ${config.maxClientLargeFormatPages}), heavy to render in the browser`);
  const mode = reasons.length ? "server" : "browser";
  if (mode === "browser") reasons.push(`Small enough for the browser: about ${fmtSeconds(estimate.total)} to open at ${bandwidthMbps} Mbit/s`);
  return { mode, reasons, estimate, bandwidthMbps };
}

function fmtSeconds(s) {
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
}

export const routingConfig = () => ({
  bandwidthMbps: config.clientBandwidthMbps,
  maxClientOpenSeconds: config.maxClientOpenSeconds,
  maxClientMB: config.maxClientMB,
  maxClientPages: config.maxClientPages,
  maxClientLargeFormatPages: config.maxClientLargeFormatPages,
});
