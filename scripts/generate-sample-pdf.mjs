// Generates a large synthetic construction PDF with a real text layer, to try
// the demo without your own files: 36 x 24 in drawing sheets (sheet index,
// plans, keyed notes, title blocks) followed by a letter-size project manual
// (specification sections). Every word is drawn as text, so Document Engine
// can extract and search it. The content is made up.
//
//   node scripts/generate-sample-pdf.mjs                     400 pages
//   node scripts/generate-sample-pdf.mjs --pages 4000        4,000 pages
//   node scripts/generate-sample-pdf.mjs --pages 800 --out documents/big.pdf
//
// Options: --pages N (default 400), --sheets-ratio R (share of drawing sheets,
// default 0.6), --seed N (default 1), --out FILE (default
// documents/sample-construction-set-<N>-pages.pdf).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { pages: 400, sheetsRatio: 0.6, seed: 1, out: null };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (key === "--pages") out.pages = Number(value());
    else if (key === "--sheets-ratio") out.sheetsRatio = Number(value());
    else if (key === "--seed") out.seed = Number(value());
    else if (key === "--out") out.out = value();
    else if (key === "--help" || key === "-h") {
      console.log("Usage: node scripts/generate-sample-pdf.mjs [--pages N] [--sheets-ratio R] [--seed N] [--out FILE]");
      process.exit(0);
    } else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!(out.pages >= 4)) throw new Error("--pages must be at least 4");
  if (!(out.sheetsRatio >= 0 && out.sheetsRatio <= 1)) throw new Error("--sheets-ratio must be between 0 and 1");
  out.out = path.resolve(root, out.out || `documents/sample-construction-set-${out.pages}-pages.pdf`);
  return out;
}

// Small deterministic PRNG (mulberry32): the same options give the same file.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    sample: (list, n) => {
      const copy = list.slice();
      const outList = [];
      while (copy.length && outList.length < n) outList.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return outList;
    },
  };
}

// ------------------------------------------------------------------ content

const PROJECT = {
  name: "EXAMPLE CIVIC CENTER",
  phase: "PHASE 2 - NEW BUILDING AND SITE WORK",
  address: "100 SAMPLE AVENUE, ANYTOWN",
  architect: "EXAMPLE ARCHITECTS",
  engineer: "SAMPLE ENGINEERING GROUP",
  number: "PRJ-0000",
  issue: "ISSUED FOR CONSTRUCTION",
};

const DISCIPLINES = [
  { code: "G", name: "GENERAL", titles: ["COVER SHEET AND SHEET INDEX", "CODE ANALYSIS", "LIFE SAFETY PLAN", "ACCESSIBILITY DETAILS"] },
  { code: "C", name: "CIVIL", titles: ["SITE PLAN", "GRADING AND DRAINAGE PLAN", "UTILITY PLAN", "EROSION CONTROL PLAN", "SITE DETAILS"] },
  { code: "L", name: "LANDSCAPE", titles: ["PLANTING PLAN", "HARDSCAPE PLAN", "IRRIGATION PLAN", "LANDSCAPE DETAILS"] },
  { code: "A", name: "ARCHITECTURAL", titles: ["FLOOR PLAN", "REFLECTED CEILING PLAN", "ROOF PLAN", "EXTERIOR ELEVATIONS", "BUILDING SECTIONS", "WALL SECTIONS", "ENLARGED PLANS", "DOOR SCHEDULE AND DETAILS", "STAIR DETAILS", "FINISH PLAN"] },
  { code: "S", name: "STRUCTURAL", titles: ["FOUNDATION PLAN", "FRAMING PLAN", "ROOF FRAMING PLAN", "STRUCTURAL NOTES", "CONCRETE DETAILS", "STEEL DETAILS"] },
  { code: "M", name: "MECHANICAL", titles: ["HVAC PLAN", "DUCTWORK PLAN", "MECHANICAL SCHEDULES", "MECHANICAL DETAILS", "CONTROLS DIAGRAMS"] },
  { code: "P", name: "PLUMBING", titles: ["PLUMBING PLAN", "SANITARY RISER DIAGRAM", "DOMESTIC WATER PLAN", "PLUMBING SCHEDULES"] },
  { code: "FP", name: "FIRE PROTECTION", titles: ["FIRE SPRINKLER PLAN", "FIRE PROTECTION DETAILS", "STANDPIPE RISER DIAGRAM"] },
  { code: "E", name: "ELECTRICAL", titles: ["LIGHTING PLAN", "POWER PLAN", "FIRE ALARM PLAN", "ONE-LINE DIAGRAM", "PANEL SCHEDULES", "ELECTRICAL DETAILS"] },
  { code: "T", name: "TECHNOLOGY", titles: ["TELECOMMUNICATIONS PLAN", "PHONE AND DATA OUTLET PLAN", "SECURITY PLAN", "AUDIO VISUAL PLAN"] },
];

const LEVELS = ["BASEMENT", "LEVEL 1", "LEVEL 2", "LEVEL 3", "LEVEL 4", "ROOF"];
const AREAS = ["AREA A", "AREA B", "AREA C", "AREA D"];

const ROOMS = [
  "OFFICE", "CORRIDOR", "LOBBY", "CONFERENCE", "STORAGE", "MECHANICAL", "ELECTRICAL", "JANITOR", "RESTROOM",
  "BREAK ROOM", "STAIR", "ELEVATOR", "TELECOM", "OPEN OFFICE", "RECEPTION", "MEETING ROOM", "COPY ROOM",
  "SERVER ROOM", "LOADING DOCK", "VESTIBULE", "WORKROOM", "FILE ROOM", "LOCKER ROOM", "TRAINING ROOM",
];

const KEYED_NOTES = [
  "PROVIDE HOLLOW METAL DOOR FRAME, SEE DOOR SCHEDULE.",
  "FIRE ALARM PULL STATION, MOUNT AT 48 IN. ABOVE FINISHED FLOOR.",
  "CONCRETE SLAB ON GRADE OVER VAPOR RETARDER, SEE STRUCTURAL.",
  "PHONE AND DATA OUTLET, COORDINATE LOCATION WITH OWNER.",
  "FIRE EXTINGUISHER CABINET, SEMI-RECESSED.",
  "GYPSUM BOARD PARTITION TO UNDERSIDE OF DECK.",
  "ACOUSTICAL CEILING TILE, SEE REFLECTED CEILING PLAN.",
  "RESILIENT BASE AT ALL GYPSUM BOARD WALLS.",
  "EXPANSION JOINT COVER ASSEMBLY.",
  "ROOF DRAIN AND OVERFLOW DRAIN, SEE PLUMBING.",
  "SMOKE DETECTOR, SEE FIRE ALARM PLAN.",
  "CONCRETE HOUSEKEEPING PAD FOR MECHANICAL EQUIPMENT.",
  "FIRE RATED HOLLOW METAL DOOR, 90 MINUTE LABEL.",
  "WALL MOUNTED PHONE, PROVIDE BACKING IN WALL.",
  "STRUCTURAL STEEL LINTEL OVER OPENING.",
  "FIRE ALARM HORN STROBE, WALL MOUNTED.",
  "CAST-IN-PLACE CONCRETE STAIR, SEE DETAILS.",
  "ALUMINUM STOREFRONT SYSTEM WITH INSULATED GLAZING.",
  "TACTILE WARNING SURFACE AT CURB RAMP.",
  "ELECTRIC WATER COOLER WITH BOTTLE FILLER.",
  "ACCESS CONTROL CARD READER AT DOOR.",
  "FLOOR DRAIN, SLOPE FLOOR TO DRAIN.",
  "CONTROL JOINT IN CONCRETE SLAB AT 15 FT ON CENTER MAXIMUM.",
  "EMERGENCY LIGHTING UNIT WITH BATTERY BACKUP.",
];

const GENERAL_NOTES = [
  "ALL DIMENSIONS ARE TO FACE OF STUD UNLESS NOTED OTHERWISE.",
  "VERIFY ALL DIMENSIONS AND CONDITIONS IN THE FIELD BEFORE STARTING WORK.",
  "DO NOT SCALE DRAWINGS. WRITTEN DIMENSIONS GOVERN.",
  "COORDINATE WORK WITH STRUCTURAL, MECHANICAL, PLUMBING AND ELECTRICAL DRAWINGS.",
  "PROVIDE FIRE STOPPING AT ALL PENETRATIONS OF RATED ASSEMBLIES.",
  "REFER TO THE PROJECT MANUAL FOR PRODUCTS AND EXECUTION REQUIREMENTS.",
  "PATCH AND REPAIR ALL SURFACES DAMAGED DURING CONSTRUCTION.",
  "CONTRACTOR SHALL MAINTAIN EXITS AND FIRE PROTECTION DURING CONSTRUCTION.",
];

const SPEC_SECTIONS = [
  ["011000", "SUMMARY"], ["012500", "SUBSTITUTION PROCEDURES"], ["013300", "SUBMITTAL PROCEDURES"],
  ["014000", "QUALITY REQUIREMENTS"], ["017700", "CLOSEOUT PROCEDURES"], ["024119", "SELECTIVE DEMOLITION"],
  ["033000", "CAST-IN-PLACE CONCRETE"], ["042200", "CONCRETE UNIT MASONRY"], ["051200", "STRUCTURAL STEEL FRAMING"],
  ["055000", "METAL FABRICATIONS"], ["061000", "ROUGH CARPENTRY"], ["072100", "THERMAL INSULATION"],
  ["075423", "THERMOPLASTIC POLYOLEFIN ROOFING"], ["078413", "PENETRATION FIRESTOPPING"], ["079200", "JOINT SEALANTS"],
  ["081113", "HOLLOW METAL DOORS AND FRAMES"], ["081416", "FLUSH WOOD DOORS"], ["084113", "ALUMINUM-FRAMED ENTRANCES AND STOREFRONTS"],
  ["087100", "DOOR HARDWARE"], ["092216", "NON-STRUCTURAL METAL FRAMING"], ["092900", "GYPSUM BOARD"],
  ["095113", "ACOUSTICAL PANEL CEILINGS"], ["096513", "RESILIENT BASE AND ACCESSORIES"], ["099123", "INTERIOR PAINTING"],
  ["104416", "FIRE EXTINGUISHERS"], ["142400", "HYDRAULIC ELEVATORS"], ["211313", "WET-PIPE SPRINKLER SYSTEMS"],
  ["221116", "DOMESTIC WATER PIPING"], ["230593", "TESTING, ADJUSTING, AND BALANCING FOR HVAC"], ["233113", "METAL DUCTS"],
  ["260519", "LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS AND CABLES"], ["265119", "LED INTERIOR LIGHTING"],
  ["271500", "COMMUNICATIONS HORIZONTAL CABLING"], ["283111", "DIGITAL, ADDRESSABLE FIRE ALARM SYSTEM"],
  ["312000", "EARTH MOVING"], ["321216", "ASPHALT PAVING"], ["329300", "PLANTS"],
];

const SPEC_ARTICLES = {
  1: ["SUMMARY", "REFERENCES", "ACTION SUBMITTALS", "INFORMATIONAL SUBMITTALS", "QUALITY ASSURANCE", "DELIVERY, STORAGE, AND HANDLING", "FIELD CONDITIONS", "WARRANTY"],
  2: ["MANUFACTURERS", "PERFORMANCE REQUIREMENTS", "MATERIALS", "ACCESSORIES", "FABRICATION", "FINISHES", "SOURCE QUALITY CONTROL"],
  3: ["EXAMINATION", "PREPARATION", "INSTALLATION", "FIELD QUALITY CONTROL", "ADJUSTING", "CLEANING", "PROTECTION"],
};

const SPEC_SENTENCES = [
  "Comply with the requirements of the authorities having jurisdiction.",
  "Submit product data for each type of product, including construction details and finishes.",
  "Coordinate the work of this Section with adjacent construction, including concrete, masonry and gypsum board assemblies.",
  "Deliver materials to the site in the original unopened packaging, labeled with the manufacturer name and product type.",
  "Store products indoors in a dry location, protected from damage and the weather.",
  "Install products in accordance with the manufacturer written instructions and the approved shop drawings.",
  "Hollow metal frames shall be set plumb, level and square, and anchored to the adjacent construction.",
  "Fire alarm devices shall be listed for the intended use and compatible with the fire alarm control unit.",
  "Concrete shall reach the specified compressive strength at 28 days, verified by field cured test cylinders.",
  "Provide phone and data outlets at the locations shown on the technology drawings.",
  "Examine substrates for compliance with requirements for installation tolerances and other conditions affecting performance.",
  "Proceed with installation only after unsatisfactory conditions have been corrected.",
  "Clean exposed surfaces and remove temporary labels and protective coverings after installation.",
  "Repair or replace damaged work that cannot be restored to its original condition.",
  "The Contractor shall engage a qualified testing agency to perform tests and inspections.",
  "Firestopping shall be installed at all penetrations through fire-resistance-rated walls and floors.",
  "Provide shop drawings showing layout, elevations, sections and details, including anchorage and accessories.",
  "Warranty period shall be two years from the date of Substantial Completion.",
  "Sealants shall be compatible with joint substrates and with each other.",
  "Prime and paint surfaces as indicated in the finish schedule.",
];

// ------------------------------------------------------------------ drawing

const SHEET = { width: 36 * 72, height: 24 * 72 }; // 36 x 24 in
const LETTER = { width: 8.5 * 72, height: 11 * 72 };
const INK = rgb(0.1, 0.1, 0.12);
const GREY = rgb(0.55, 0.57, 0.6);
const LIGHT = rgb(0.82, 0.84, 0.87);

function buildSheetList(count, r) {
  const sheets = [{ number: "G-001", title: "COVER SHEET AND SHEET INDEX", discipline: "GENERAL" }];
  const counters = {};
  while (sheets.length < count) {
    const d = r.pick(DISCIPLINES.slice(1));
    counters[d.code] = (counters[d.code] || 0) + 1;
    const n = counters[d.code];
    const series = 100 * (1 + Math.floor((n - 1) / 20));
    const number = `${d.code}-${series + ((n - 1) % 20) + 1}`;
    const title = `${r.pick(LEVELS)} ${r.pick(d.titles)} - ${r.pick(AREAS)}`;
    sheets.push({ number, title, discipline: d.name });
  }
  return sheets;
}

function text(page, str, x, y, size, font, color = INK) {
  page.drawText(str, { x, y, size, font, color });
}

function titleBlock(page, fonts, sheet, index, total) {
  const { width, height } = SHEET;
  const w = 330;
  const x = width - 36 - w;
  page.drawRectangle({ x: 36, y: 36, width: width - 72, height: height - 72, borderColor: INK, borderWidth: 2 });
  page.drawLine({ start: { x, y: 36 }, end: { x, y: height - 36 }, color: INK, thickness: 1.5 });
  let y = height - 80;
  text(page, PROJECT.architect, x + 16, y, 16, fonts.bold);
  text(page, "ARCHITECTURE - INTERIORS - PLANNING", x + 16, (y -= 18), 8, fonts.regular, GREY);
  text(page, PROJECT.engineer, x + 16, (y -= 30), 11, fonts.bold);
  text(page, "STRUCTURAL - MECHANICAL - ELECTRICAL - PLUMBING", x + 16, (y -= 14), 8, fonts.regular, GREY);
  y -= 50;
  text(page, PROJECT.name, x + 16, y, 15, fonts.bold);
  text(page, PROJECT.phase, x + 16, (y -= 16), 8, fonts.regular);
  text(page, PROJECT.address, x + 16, (y -= 12), 8, fonts.regular);
  text(page, `PROJECT NO. ${PROJECT.number}`, x + 16, (y -= 12), 8, fonts.regular);
  y -= 40;
  text(page, "REVISIONS", x + 16, y, 9, fonts.bold);
  for (let i = 1; i <= 4; i++) {
    y -= 16;
    page.drawLine({ start: { x: x + 16, y: y - 4 }, end: { x: x + w - 16, y: y - 4 }, color: LIGHT, thickness: 0.5 });
    if (i <= (index % 3) + 1) text(page, `${i}   ADDENDUM ${i}   ${String(i * 7).padStart(2, "0")}/0${i}/2026`, x + 16, y, 8, fonts.regular);
  }
  text(page, PROJECT.issue, x + 16, 300, 10, fonts.bold);
  text(page, `SHEET ${index + 1} OF ${total}`, x + 16, 284, 8, fonts.regular);
  page.drawLine({ start: { x, y: 260 }, end: { x: x + w, y: 260 }, color: INK, thickness: 1 });
  text(page, sheet.discipline, x + 16, 236, 9, fonts.regular, GREY);
  const titleLines = wrap(sheet.title, 26);
  titleLines.forEach((line, i) => text(page, line, x + 16, 214 - i * 18, 14, fonts.bold));
  page.drawLine({ start: { x, y: 140 }, end: { x: x + w, y: 140 }, color: INK, thickness: 1 });
  text(page, "SCALE: 1/8 IN. = 1 FT-0 IN.", x + 16, 120, 8, fonts.regular);
  text(page, sheet.number, x + 16, 62, 40, fonts.bold);
}

function wrap(str, max) {
  const lines = [];
  let line = "";
  for (const word of str.split(" ")) {
    if ((line + " " + word).trim().length > max && line) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

function drawingSheet(pdf, fonts, sheet, index, total, sheets, r) {
  const page = pdf.addPage([SHEET.width, SHEET.height]);
  titleBlock(page, fonts, sheet, index, total);
  const left = 90;
  const right = SHEET.width - 36 - 330 - 420; // keyed notes column on the right
  const bottom = 110;
  const top = SHEET.height - 110;

  if (index === 0) return coverSheet(page, fonts, sheets);

  // Structural grid with bubbles.
  const cols = r.int(6, 10);
  const rows = r.int(4, 7);
  const dx = (right - left) / cols;
  const dy = (top - bottom) / rows;
  for (let c = 0; c <= cols; c++) {
    const x = left + c * dx;
    page.drawLine({ start: { x, y: bottom }, end: { x, y: top }, color: LIGHT, thickness: 0.6, dashArray: [12, 6] });
    page.drawCircle({ x, y: top + 22, size: 14, borderColor: INK, borderWidth: 1 });
    text(page, String(c + 1), x - 4, top + 18, 11, fonts.bold);
  }
  for (let j = 0; j <= rows; j++) {
    const y = bottom + j * dy;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, color: LIGHT, thickness: 0.6, dashArray: [12, 6] });
    page.drawCircle({ x: left - 24, y, size: 14, borderColor: INK, borderWidth: 1 });
    text(page, String.fromCharCode(65 + rows - j), left - 28, y - 4, 11, fonts.bold);
  }

  // Rooms with names, numbers, door tags and keyed note tags.
  const level = 100 * r.int(1, 4);
  let room = level + 1;
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < rows; j++) {
      if (r.next() < 0.2) continue;
      const x = left + c * dx + 6;
      const y = bottom + j * dy + 6;
      page.drawRectangle({ x, y, width: dx - 12, height: dy - 12, borderColor: INK, borderWidth: 2.5 });
      text(page, r.pick(ROOMS), x + 14, y + dy / 2, 10, fonts.bold);
      text(page, String(room), x + 14, y + dy / 2 - 14, 9, fonts.regular);
      if (r.next() < 0.6) {
        page.drawRectangle({ x: x + dx - 70, y: y + 10, width: 40, height: 16, borderColor: INK, borderWidth: 0.8 });
        text(page, `D${room}`, x + dx - 66, y + 14, 8, fonts.regular);
      }
      if (r.next() < 0.5) {
        page.drawRectangle({ x: x + 14, y: y + 14, width: 18, height: 18, borderColor: INK, borderWidth: 0.8 });
        text(page, String(r.int(1, 12)), x + 18, y + 19, 8, fonts.bold);
      }
      room++;
    }
  }

  // Keyed notes and general notes.
  const nx = right + 40;
  let y = top;
  text(page, "KEYED NOTES", nx, y, 12, fonts.bold);
  r.sample(KEYED_NOTES, 12).forEach((note, i) => {
    const lines = wrap(note, 52);
    y -= 20;
    text(page, String(i + 1), nx, y, 9, fonts.bold);
    lines.forEach((line, k) => text(page, line, nx + 22, y - k * 12, 9, fonts.regular));
    y -= (lines.length - 1) * 12;
  });
  y -= 40;
  text(page, "GENERAL NOTES", nx, y, 12, fonts.bold);
  r.sample(GENERAL_NOTES, 5).forEach((note, i) => {
    const lines = wrap(note, 52);
    y -= 20;
    text(page, String.fromCharCode(65 + i), nx, y, 9, fonts.bold);
    lines.forEach((line, k) => text(page, line, nx + 22, y - k * 12, 9, fonts.regular));
    y -= (lines.length - 1) * 12;
  });
  y -= 40;
  const refs = r.sample(sheets.slice(1), 3);
  text(page, "REFERENCE SHEETS", nx, y, 12, fonts.bold);
  refs.forEach((ref) => text(page, `${ref.number}  ${ref.title}`, nx, (y -= 16), 8, fonts.regular));

  text(page, sheet.title, left, 70, 14, fonts.bold);
  text(page, "SCALE: 1/8 IN. = 1 FT-0 IN.", left, 54, 9, fonts.regular);
}

function coverSheet(page, fonts, sheets) {
  text(page, PROJECT.name, 90, SHEET.height - 140, 48, fonts.bold);
  text(page, PROJECT.phase, 90, SHEET.height - 180, 20, fonts.regular);
  text(page, PROJECT.address, 90, SHEET.height - 206, 14, fonts.regular);
  text(page, PROJECT.issue, 90, SHEET.height - 240, 14, fonts.bold);
  text(page, "SHEET INDEX", 90, SHEET.height - 300, 16, fonts.bold);
  // Up to 6 columns of sheet numbers and titles; long sets list the first ones.
  const perColumn = 48;
  const maxColumns = 6;
  sheets.slice(0, perColumn * maxColumns).forEach((s, i) => {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    const x = 90 + col * 360;
    const y = SHEET.height - 330 - row * 24;
    text(page, s.number, x, y, 9, fonts.bold);
    text(page, s.title.slice(0, 44), x + 52, y, 8, fonts.regular);
  });
  if (sheets.length > perColumn * maxColumns)
    text(page, `AND ${sheets.length - perColumn * maxColumns} MORE SHEETS`, 90, 90, 10, fonts.bold);
}

// ------------------------------------------------------------- spec pages

function specPages(pdf, fonts, count, r) {
  const pages = [];
  let s = 0;
  while (pages.length < count) {
    const [number, title] = SPEC_SECTIONS[s % SPEC_SECTIONS.length];
    s++;
    const sectionPages = Math.min(count - pages.length, r.int(3, 9));
    let pageInSection = 0;
    let page = null;
    let y = 0;
    const newPage = () => {
      page = pdf.addPage([LETTER.width, LETTER.height]);
      pages.push(page);
      pageInSection++;
      text(page, `${PROJECT.name} - ${PROJECT.number}`, 54, LETTER.height - 40, 8, fonts.regular, GREY);
      text(page, PROJECT.issue, LETTER.width - 54 - 120, LETTER.height - 40, 8, fonts.regular, GREY);
      const footer = `${title}`;
      text(page, footer.slice(0, 60), 54, 36, 8, fonts.regular);
      text(page, `${number} - ${pageInSection}`, LETTER.width - 54 - 70, 36, 9, fonts.bold);
      y = LETTER.height - 80;
    };
    newPage();
    text(page, `SECTION ${number.slice(0, 2)} ${number.slice(2, 4)} ${number.slice(4)}`, 54, y, 12, fonts.bold);
    text(page, title, 54, (y -= 16), 12, fonts.bold);
    y -= 20;
    let part = 1;
    let article = 0;
    let paragraph = 0;
    while (pageInSection <= sectionPages) {
      if (y < 90) {
        if (pageInSection === sectionPages) break;
        newPage();
      }
      if (article === 0 || r.next() < 0.25) {
        if (part < 3 && (article >= SPEC_ARTICLES[part].length || (article > 2 && r.next() < 0.3))) {
          part++;
          article = 0;
        }
        if (article === 0) {
          const label = part === 1 ? "GENERAL" : part === 2 ? "PRODUCTS" : "EXECUTION";
          text(page, `PART ${part} - ${label}`, 54, y, 10, fonts.bold);
          y -= 18;
        }
        article++;
        paragraph = 0;
        text(page, `${part}.${article}  ${SPEC_ARTICLES[part][(article - 1) % SPEC_ARTICLES[part].length]}`, 54, y, 10, fonts.bold);
        y -= 16;
      }
      const letter = String.fromCharCode(65 + (paragraph++ % 26));
      const lines = wrap(`${r.pick(SPEC_SENTENCES)} ${r.pick(SPEC_SENTENCES)}`, 92);
      text(page, `${letter}.`, 72, y, 9, fonts.regular);
      lines.forEach((line, k) => text(page, line, 90, y - k * 12, 9, fonts.regular));
      y -= lines.length * 12 + 8;
    }
    text(page, `END OF SECTION ${number}`, 54, Math.max(y, 60), 9, fonts.bold);
  }
  return pages;
}

// ------------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const r = rng(opts.seed);
const t0 = Date.now();
const pdf = await PDFDocument.create();
pdf.setTitle(`Sample construction set, ${opts.pages} pages (synthetic)`);
pdf.setAuthor("Nutrient large PDF search PoC generator");
pdf.setSubject("Synthetic drawing sheets and project manual for search tests");
pdf.setCreator("scripts/generate-sample-pdf.mjs");
const fonts = {
  regular: await pdf.embedFont(StandardFonts.Helvetica),
  bold: await pdf.embedFont(StandardFonts.HelveticaBold),
};

const sheetCount = Math.max(1, Math.round(opts.pages * opts.sheetsRatio));
const sheets = buildSheetList(sheetCount, r);
sheets.forEach((sheet, i) => drawingSheet(pdf, fonts, sheet, i, sheets.length, sheets, r));
specPages(pdf, fonts, opts.pages - sheetCount, r);

const bytes = await pdf.save({ useObjectStreams: true });
await fs.mkdir(path.dirname(opts.out), { recursive: true });
await fs.writeFile(opts.out, bytes);
console.log(
  `Wrote ${path.relative(process.cwd(), opts.out)}: ${pdf.getPageCount()} pages ` +
    `(${sheetCount} drawing sheets of 36 x 24 in, ${opts.pages - sheetCount} letter pages), ` +
    `${(bytes.length / 1048576).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s.`
);
