// Command-line benchmark, run inside the app container:
//
//   docker compose exec app npm run bench                      (every document, suggested queries)
//   docker compose exec app npm run bench -- <docId> "fire alarm" concrete
//   docker compose exec app npm run bench -- --engines=accelerated <docId> concrete
//
// Calls the running app (POST /api/bench) and prints one table per document.
const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`;
const args = process.argv.slice(2);
const enginesFlag = args.find((a) => a.startsWith("--engines="));
const engines = enginesFlag ? enginesFlag.slice(10).split(",") : ["native", "accelerated"];
const [docArg, ...queryArgs] = args.filter((a) => !a.startsWith("--"));

const fmt = (v) => (v == null ? "-" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
const pad = (s, n) => String(s).padEnd(n);

async function benchDoc(doc) {
  const queries = queryArgs.length ? queryArgs : (await (await fetch(`${base}/api/documents/${doc.id}/suggestions`)).json()).map((s) => s.q);
  console.log(`\n${doc.title}  (${doc.pageCount} pages, ${(doc.byteSize / 1048576).toFixed(0)} MB)`);
  console.log(`${pad("Query", 26)}${pad("Engine", 13)}${pad("First hit", 12)}${pad("All hits", 12)}${pad("Hits", 8)}Requests`);
  const res = await fetch(`${base}/api/bench`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId: doc.id, queries, engines }),
  });
  const rows = {};
  let buf = "";
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === "error") console.log(`  error: ${e.message}`);
      if (e.type !== "row") continue;
      if (e.error) {
        console.log(`${pad(e.query, 26)}${pad(e.engine, 13)}error: ${e.error}`);
        continue;
      }
      (rows[e.query] ||= {})[e.engine] = e;
      const speed = e.engine === "accelerated" && rows[e.query].native ? `   x${(rows[e.query].native.totalMs / e.totalMs).toFixed(0)} faster` : "";
      console.log(`${pad(e.query, 26)}${pad(e.engine, 13)}${pad(fmt(e.firstHitMs), 12)}${pad(fmt(e.totalMs), 12)}${pad(e.hits, 8)}${e.requests}${speed}`);
    }
  }
}

const docs = (await (await fetch(`${base}/api/documents`)).json()).filter((d) => d.status === "ready" && (!docArg || d.id === docArg));
if (!docs.length) {
  console.log(docArg ? `No ready document with id "${docArg}".` : "No ready document yet.");
  process.exit(1);
}
for (const doc of docs) await benchDoc(doc);
