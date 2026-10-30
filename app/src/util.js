import fs from "node:fs/promises";

// Small FIFO semaphore: caps how many Document Engine requests run at once.
export class Limiter {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export function slugify(name) {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\.pdf$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "document"
  );
}

export const titleFromFileName = (name) => name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();

export async function withRetry(fn, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err?.name === "AbortError") throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastError;
}
