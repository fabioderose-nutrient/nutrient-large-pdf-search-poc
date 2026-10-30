// Library metadata (status of each document), persisted to /data/library.json.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { writeFileAtomic } from "./util.js";

const file = path.join(config.dataDir, "library.json");
let docs = {};
let saveTimer = null;

export function loadStore() {
  try {
    docs = JSON.parse(fs.readFileSync(file, "utf8")).docs || {};
  } catch {
    docs = {};
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFileAtomic(file, JSON.stringify({ docs }, null, 1)).catch((err) => console.error("[store] save failed", err));
  }, 200);
}

export const getDoc = (id) => docs[id] || null;
export const allDocs = () => Object.values(docs);

export function putDoc(doc) {
  docs[doc.id] = doc;
  scheduleSave();
  return doc;
}

export function patchDoc(id, patch) {
  if (!docs[id]) return null;
  docs[id] = { ...docs[id], ...patch };
  scheduleSave();
  return docs[id];
}

export function removeDoc(id) {
  delete docs[id];
  scheduleSave();
}
