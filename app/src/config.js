// Runtime configuration (environment variables set in docker-compose.yml).
import path from "node:path";

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),

  // Document Engine as seen from this container, and as seen from the browser.
  deInternalUrl: (process.env.DE_INTERNAL_URL || "http://localhost:5200").replace(/\/$/, ""),
  dePublicUrl: process.env.DE_PUBLIC_URL || "http://localhost:5200/",
  deApiToken: process.env.DE_API_TOKEN || "",

  jwtPrivateKeyPath: process.env.JWT_PRIVATE_KEY_PATH || path.resolve("../keys/jwt-private.pem"),
  webSdkLicenseKey: process.env.WEB_SDK_LICENSE_KEY || "",

  documentsDir: process.env.DOCUMENTS_DIR || path.resolve("../documents"),
  dataDir: process.env.DATA_DIR || "/data",

  // Load routing (load-routing.js): a document opens in the browser (Web SDK
  // standalone) only if all of these hold, otherwise it opens server-backed.
  clientBandwidthMbps: num(process.env.CLIENT_BANDWIDTH_MBPS, 50), // assumed user connection
  maxClientOpenSeconds: num(process.env.MAX_CLIENT_OPEN_SECONDS, 5),
  maxClientMB: num(process.env.MAX_CLIENT_MB, 150),
  maxClientPages: num(process.env.MAX_CLIENT_PAGES, 1500),
  maxClientLargeFormatPages: num(process.env.MAX_CLIENT_LARGE_FORMAT_PAGES, 50),
  // Browser open-time model (download excluded), measured with Web SDK 1.23.
  clientOpenBaseSeconds: num(process.env.CLIENT_OPEN_BASE_SECONDS, 0.6),
  clientOpenSecondsPerMB: num(process.env.CLIENT_OPEN_SECONDS_PER_MB, 0.012),
  clientOpenSecondsPerPage: num(process.env.CLIENT_OPEN_SECONDS_PER_PAGE, 0.0015),

  // OCR the pages without a text layer automatically after upload.
  autoOcr: (process.env.AUTO_OCR || "true") !== "false",
  // OCR time model used for the progress estimate (12 CPU cores).
  ocrBaseSeconds: num(process.env.OCR_BASE_SECONDS, 15),
  ocrSecondsPerLargeSheet: num(process.env.OCR_SECONDS_PER_LARGE_SHEET, 8), // one 36x24" sheet
  ocrSecondsPerExtraRange: num(process.env.OCR_SECONDS_PER_EXTRA_RANGE, 27),
  ocrSaveMBPerSecond: num(process.env.OCR_SAVE_MB_PER_SECOND, 16),

  // Parallel Document Engine requests for one search, shared by all users.
  searchConcurrency: num(process.env.SEARCH_CONCURRENCY, 12),
  // Parallel page-text requests while a document is being indexed.
  indexConcurrency: num(process.env.INDEX_CONCURRENCY, 8),
  // Contiguous candidate pages are grouped into one Document Engine request:
  // at most this many pages per request, bridging gaps of up to this many pages.
  maxPagesPerRequest: num(process.env.MAX_PAGES_PER_REQUEST, 16),
  maxGapPages: num(process.env.MAX_GAP_PAGES, 2),
};
