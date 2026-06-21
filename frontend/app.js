// Static fallback used only when the Flask API isn't reachable (e.g. opening
// index.html over file://). Points at the single dataset store; the manual file
// picker covers anything else.
const DATA_CANDIDATES = ["../data/DSPR_dataset.json", "data/DSPR_dataset.json", "DSPR_dataset.json"];
let RECORDS = [];
let BACKEND = false; // true once we confirm the Flask API is reachable

// Parse a records blob, tolerating both a JSON array (DSPR_dataset.json) and
// newline-delimited JSON (the legacy/exported math_paired.jsonl shape).
function parseJSONL(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr;
    } catch (e) { /* fall through to line-by-line */ }
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* skip bad line */ }
  }
  return out;
}

// Browse data set: every natively-shaped record from /api/records — our Original
// and Verified records (each already carries original/simple/hard fields).
// Unverified records live in the Verify tab.
async function fetchBrowseRecords() {
  const base = await (await fetch("/api/records")).json();
  return Array.isArray(base) ? base : [];
}

// Re-pull the Browse data set after a status change (pull, approve, auto-verify)
// so each problem shows up in its correct location without a manual reload.
async function refreshBrowse() {
  if (!BACKEND) return;
  try {
    onLoaded(await fetchBrowseRecords(), "/api/records");
  } catch (e) { /* non-fatal */ }
}

async function tryAutoLoad() {
  // Prefer the Flask API (records from DSPR_dataset.json, routed by status).
  try {
    const recs = await fetchBrowseRecords();
    if (Array.isArray(recs) && recs.length) {
      BACKEND = true;
      onLoaded(recs, "/api/records");
      return true;
    }
  } catch (e) { /* no backend -> fall through to static files */ }

  for (const url of DATA_CANDIDATES) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        const recs = parseJSONL(text);
        if (recs.length) { onLoaded(recs, url); return true; }
      }
    } catch (e) { /* file:// or missing -> try next */ }
  }
  return false;
}

function showFilePicker(msg) {
  const row = document.getElementById("loaderRow");
  row.innerHTML = "";
  const note = document.createElement("span");
  note.className = "sub";
  note.innerHTML = (msg || "") + " Load a <code class='kbd'>.jsonl</code> file manually:";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".jsonl,.json,.txt";
  input.addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onLoaded(parseJSONL(reader.result), file.name);
    reader.readAsText(file);
  });
  row.appendChild(note);
  row.appendChild(input);
}

function onLoaded(recs, source) {
  RECORDS = recs;
  document.getElementById("loaderRow").innerHTML =
    `<span class="sub">Loaded <b>${recs.length}</b> records from <code class="kbd">${source}</code></span>`;
  populateTypeFilter();
  render();
}

function populateTypeFilter() {
  const sel = document.getElementById("typeFilter");
  const cur = sel.value;
  // Rebuild from scratch each load — appending caused duplicate options.
  // Trim so " Algebra"/"Algebra" collapse into one entry.
  const types = [...new Set(RECORDS.map(r => (r.type || "").trim()).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All types</option>';
  for (const t of types) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    sel.appendChild(opt);
  }
  sel.value = cur;  // preserve the user's current selection across reloads
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Wrap *bare* multi-line math environments (align*, aligned, gather, cases...)
// in $$...$$ so KaTeX renders them in display mode, one step per line.
// Environments already inside $, $$, \[ or \( are left untouched.
function wrapBareEnvironments(s) {
  const ENV = /^\\begin\{(align\*?|aligned|gather\*?|gathered|alignat\*?|cases|split|multline\*?|eqnarray\*?)\}/;
  let out = "";
  let i = 0;
  const n = s.length;
  let closer = ""; // non-empty while inside a math region; holds the expected closing token
  while (i < n) {
    if (!closer) {
      // Currently outside math: detect a math opener...
      if (s.startsWith("$$", i)) { closer = "$$"; out += "$$"; i += 2; continue; }
      if (s[i] === "$")          { closer = "$";  out += "$";  i += 1; continue; }
      if (s.startsWith("\\[", i)) { closer = "\\]"; out += "\\["; i += 2; continue; }
      if (s.startsWith("\\(", i)) { closer = "\\)"; out += "\\("; i += 2; continue; }
      // ...or a bare environment to wrap.
      const m = ENV.exec(s.slice(i));
      if (m) {
        const endTok = "\\end{" + m[1] + "}";
        const endIdx = s.indexOf(endTok, i);
        if (endIdx !== -1) {
          const block = s.slice(i, endIdx + endTok.length);
          out += "$$" + block + "$$";
          i = endIdx + endTok.length;
          continue;
        }
      }
      out += s[i]; i += 1;
    } else {
      // Inside math: copy verbatim until the matching closer.
      if (s.startsWith(closer, i)) { out += closer; i += closer.length; closer = ""; continue; }
      out += s[i]; i += 1;
    }
  }
  return out;
}

// Escape HTML but keep LaTeX delimiters intact; pull [asy]...[/asy] into <details>.
// (KaTeX auto-render reads textContent, where &amp;/&lt; decode back to & / <,
//  so escaping does not corrupt the math, including align '&' columns.)
function renderMathField(raw) {
  const parts = String(raw).split(/(\[asy\][\s\S]*?\[\/asy\])/g);
  let html = "";
  for (const p of parts) {
    if (/^\[asy\][\s\S]*\[\/asy\]$/.test(p)) {
      html += `<details class="asy"><summary>Asymptote graph code</summary><pre>${escapeHtml(p)}</pre></details>`;
    } else {
      html += escapeHtml(wrapBareEnvironments(p));
    }
  }
  return html;
}

// Run KaTeX auto-render on an element (pre/code tags ignored by default, so asy is safe).
function typesetMath(el) {
  if (typeof renderMathInElement !== "function") {
    setTimeout(() => typesetMath(el), 120); // KaTeX script not ready yet
    return;
  }
  renderMathInElement(el, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "\\[", right: "\\]", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\(", right: "\\)", display: false },
    ],
    throwOnError: false,
  });
}

// --------------------------------------------------------------------------
// Shared Problem Viewer — one display component + navigation model reused by
// the Pull, Generate, and Verify sections. Each section normalizes its own data
// into a single ViewerModel, then renders through renderProblemDisplay so the
// ID header, color-coded tags, centered problem statement, and (optional)
// expandable perturbations look identical everywhere.
//
//   ViewerModel = {
//     id,                                  // dataset-position id (or "—")
//     sourceAbbrev,                        // short source label ("NM"); optional
//     tags: [{text, kind}],                // kind ∈ level|type|author|verifier|aug
//     problem,                             // original statement
//     answer,                              // optional solution/answer string
//     perturbations: [{kind, problem, answer, uid}]   // optional
//   }
// --------------------------------------------------------------------------
function renderTags(tags) {
  return (tags || [])
    .filter(t => t && t.text)
    .map(t => `<span class="badge ${t.kind || ""}">${escapeHtml(String(t.text))}</span>`)
    .join("");
}

// Map a dataset facet key to a tag colour class.
function facetTagKind(key) {
  if (key === "level") return "level";
  if (key === "source" || key === "problem_source") return "source";
  return "type";
}

// Read-only variant card shown inside a Problem Viewer's perturbations section.
function viewerVariantBlock(v) {
  const tag = v.kind === "hard" ? "hard" : (v.kind === "simple" ? "simple" : "original");
  const ans = v.answer ? `
      <div class="answer-wrap">
        <div class="answer-label">Answer</div>
        <div class="answer-text">${renderMathField(String(v.answer))}</div>
      </div>` : "";
  return `
    <div class="variant ${tag}"${v.uid ? ` data-uid="${escapeHtml(v.uid)}"` : ""}>
      <div class="variant-head"><span class="vtag ${tag}">${escapeHtml(v.kind || "")}</span></div>
      <div class="problem-text">${renderMathField(v.problem || "")}</div>
      ${ans}
    </div>`;
}

// Render the shared *display* region into a container. Section-specific bodies
// (editors, action buttons) live in sibling elements and are never touched here.
// opts.perturbations:
//   - true            -> emit read-only variants from model.perturbations
//   - "host"          -> emit an empty expandable <details> whose .pv-pert-body
//                        the caller fills itself (Verify, to attach buttons)
function renderProblemDisplay(container, model, opts) {
  opts = opts || {};
  const el = typeof container === "string" ? document.getElementById(container) : container;
  if (!el) return;
  if (!model) {
    el.innerHTML = '<div class="hint">No problem to display.</div>';
    return;
  }
  const answer = model.answer
    ? `<div class="pv-answer">
         <div class="preview-label">Answer / Solution</div>
         <div class="preview answer-text">${renderMathField(String(model.answer))}</div>
       </div>` : "";
  let pert = "";
  if (opts.perturbations) {
    const n = (model.perturbations || []).length;
    const inner = opts.perturbations === "host"
      ? "" : (model.perturbations || []).map(viewerVariantBlock).join("");
    pert = `<details class="pv-perturbations" open>
        <summary>Perturbations${n ? ` (${n})` : ""}</summary>
        <div class="pv-pert-body variant-row">${inner}</div>
      </details>`;
  }
  el.innerHTML = `
    <div class="pv-head">
      <span class="pid">${escapeHtml(idLabel(model.sourceAbbrev, model.id ?? "—"))}</span>
      ${renderTags(model.tags)}
    </div>
    <div class="pv-problem">
      <span class="vtag original">original</span>
      <div class="preview">${renderMathField(model.problem || "")}</div>
    </div>
    ${answer}
    ${pert}`;
  typesetMath(el);
}

// Shared navigation: indicator text + Prev/Next disabled state + jump bounds.
// els = {prev, next, indicator, jump} of element ids.
function updateNav(els, idx, total, id) {
  const ind = document.getElementById(els.indicator);
  const prev = els.prev ? document.getElementById(els.prev) : null;
  const next = els.next ? document.getElementById(els.next) : null;
  const jump = els.jump ? document.getElementById(els.jump) : null;
  if (idx < 0 || !total) {
    if (ind) ind.textContent = "—";
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    if (jump) { jump.value = ""; jump.disabled = true; }
    return;
  }
  if (ind) ind.textContent =
    `Problem ${idx + 1} / ${total}` + (id != null && id !== "" && id !== "—" ? ` · ID: ${id}` : "");
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx >= total - 1;
  if (jump) { jump.disabled = false; jump.max = total; }
}

// Wire a jump number input + Go button (and Enter) to a 0-based onJump(idx).
function wireJump(jumpId, goId, getTotal, onJump) {
  const input = document.getElementById(jumpId);
  const go = document.getElementById(goId);
  const fire = () => {
    const total = getTotal();
    let n = parseInt(input.value, 10);
    if (!Number.isFinite(n) || !total) return;
    n = Math.min(total, Math.max(1, n));
    onJump(n - 1);
  };
  if (go) go.addEventListener("click", fire);
  if (input) input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); fire(); }
  });
}

function variantBlock(tag, obj) {
  if (!obj) return "";
  const problem = obj.problem ?? "";
  const answer = (obj.solution ?? obj.answer ?? "(no answer field)");
  const ansStr = typeof answer === "object" ? JSON.stringify(answer, null, 2) : String(answer);
  return `
    <div class="variant ${tag}">
      <div class="variant-head">
        <span class="vtag ${tag}">${tag}</span>
        <button class="toggle-ans">Show answer</button>
      </div>
      <div class="problem-text">${renderMathField(problem)}</div>
      <div class="answer-wrap hidden">
        <div class="answer-label">Answer / Solution</div>
        <div class="answer-text">${renderMathField(ansStr)}</div>
      </div>
    </div>`;
}

function render() {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const typeF = document.getElementById("typeFilter").value;
  const list = document.getElementById("list");
  const variantsToShow = ["original", "simple", "hard"];

  let shown = 0;
  const html = [];
  for (const r of RECORDS) {
    if (typeF && (r.type || "").trim() !== typeF) continue;
    if (q) {
      const hay = (String(r.problem_id) + " " + (r.type||"") + " " +
        JSON.stringify(r.original||"") + JSON.stringify(r.simple||"") + JSON.stringify(r.hard||"")).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    shown++;
    const originalBlock = variantBlock("original", r.original);
    const simpleBlock = variantBlock("simple", r.simple);
    const hardBlock = variantBlock("hard", r.hard);
    html.push(`
      <div class="card">
        <div class="card-head">
          <span class="pid">${escapeHtml(
            r.source && r.id != null ? idLabel(sourceAbbrev(r.source), r.id) : `ID: ${r.problem_id ?? "?"}`
          )}</span>
          ${r.type ? `<span class="badge type">${escapeHtml(r.type)}</span>` : ""}
          ${r.level ? `<span class="badge level">${escapeHtml(r.level)}</span>` : ""}
          ${r.create_author ? `<span class="badge author">${escapeHtml(r.create_author)}</span>` : ""}
          ${r.verify_author ? `<span class="badge verifier">${escapeHtml(r.verify_author)}</span>` : ""}
        </div>
        <div class="variants">
          ${originalBlock}
          <div class="variant-row">${simpleBlock}${hardBlock}</div>
        </div>
      </div>`);
  }
  list.innerHTML = html.join("");
  document.getElementById("empty").classList.toggle("hidden", shown > 0);
  document.getElementById("count").textContent = `${shown} / ${RECORDS.length} shown`;

  // freshly-rendered cards start with answers hidden — reset the toggle
  ANSWERS_SHOWN = false;
  document.getElementById("toggleAllBtn").textContent = "Show all answers";

  // wire per-answer toggles
  list.querySelectorAll(".toggle-ans").forEach(btn => {
    btn.addEventListener("click", () => {
      const wrap = btn.closest(".variant").querySelector(".answer-wrap");
      const nowHidden = wrap.classList.toggle("hidden");
      btn.textContent = nowHidden ? "Show answer" : "Hide answer";
    });
  });

  typesetMath(list);
}

let ANSWERS_SHOWN = false;
function setAllAnswers(visible) {
  ANSWERS_SHOWN = visible;
  document.querySelectorAll(".answer-wrap").forEach(w => w.classList.toggle("hidden", !visible));
  document.querySelectorAll(".toggle-ans").forEach(b => b.textContent = visible ? "Hide answer" : "Show answer");
  document.getElementById("toggleAllBtn").textContent = visible ? "Hide all answers" : "Show all answers";
}

document.getElementById("search").addEventListener("input", render);
document.getElementById("typeFilter").addEventListener("change", render);
document.getElementById("toggleAllBtn").addEventListener("click", () => setAllAnswers(!ANSWERS_SHOWN));

// --------------------------------------------------------------------------
// Top-level tab switching: browse / pull / generate / verify
// --------------------------------------------------------------------------
// "Create" merges the former Pull, Generate, and Verify tabs onto one screen,
// shown in that order; their sections all live inside #createView.
const TABS = ["browse", "create"];
const NAV_ID = { browse: "navBrowse", create: "navCreate" };
const ACTIVE_TAB_KEY = "dspr.activeTab";

function showTab(name) {
  // Old saved values (pull/generate/verify) now all map to the merged Create tab.
  if (["pull", "generate", "verify"].includes(name)) name = "create";
  if (!TABS.includes(name)) name = "browse";
  const browse = name === "browse";
  document.getElementById("browseView").classList.toggle("hidden", !browse);
  document.getElementById("createView").classList.toggle("hidden", browse);
  document.getElementById("browseControls").style.display = browse ? "" : "none";

  for (const t of TABS) {
    document.getElementById(NAV_ID[t]).classList.toggle("active", t === name);
  }
  if (!browse) {
    // All three sections are visible at once, so populate each in order.
    refreshCreateScreen();
    initDatasetBrowser();
    populateBaseSelect();
    loadPending();
    if (GEN_MODE === "llm") connectAndRefreshLLM();
  }
  try { localStorage.setItem(ACTIVE_TAB_KEY, name); } catch (e) { /* storage disabled */ }
}

function setStatus(id, msg, kind) {
  const el = document.getElementById(id);
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function refreshCreateScreen() {
  if (!BACKEND) {
    setStatus("pullStatus",
      "Backend not detected. Run  python DSPR_Training_Data/app.py  and open http://127.0.0.1:8000 to enable pulling and saving.",
      "err");
  } else {
    setStatus("pullStatus", "", "");
  }
}

// Base problems for the Generate tab are "Original (unperturbed)" records from
// DSPR_dataset.json (the "Pull" output).
let RAW_RECORDS = [];
let BASE_IDX = -1;   // pointer into RAW_RECORDS (sorted by problem_id)
// IDs consumed (saved) this session but not yet confirmed removed by the server.
// Applied as a filter whenever we re-fetch raw problems, then cleared once the
// fresh server response lands (server is the source of truth after a re-fetch).
let CONSUMED_PIDS = new Set();
async function populateBaseSelect() {
  if (!BACKEND) {
    setStatus("generateStatus", "Backend not detected — run app.py to load pulled problems.", "err");
    RAW_RECORDS = []; BASE_IDX = -1; updateBaseNav(); return;
  }
  try {
    const data = await (await fetch("/api/raw")).json();
    RAW_RECORDS = Array.isArray(data.records) ? data.records : [];
    // Navigate in ascending problem_id order so Prev/Next match the ID labels.
    RAW_RECORDS.sort((a, b) => (a.problem_id ?? 0) - (b.problem_id ?? 0));
    // Hide any problems saved this session that the server may not have flushed yet,
    // then clear the set — the server response is now the source of truth.
    RAW_RECORDS = RAW_RECORDS.filter(r => !CONSUMED_PIDS.has(r.problem_id));
    CONSUMED_PIDS.clear();
    if (!data.exists) {
      setStatus("generateStatus",
        "No problems pulled yet — DSPR_dataset.json has no original problems. Use the Pull tab first.", "err");
    } else if (!RAW_RECORDS.length) {
      setStatus("generateStatus",
        "No original problems found — pull some problems first.", "err");
    } else {
      setStatus("generateStatus", `${RAW_RECORDS.length} pulled problem(s) available.`, "ok");
    }
  } catch (e) {
    setStatus("generateStatus", "Failed to load raw problems: " + e.message, "err");
    RAW_RECORDS = [];
  }
  BASE_IDX = RAW_RECORDS.length ? 0 : -1;
  updateBaseNav();
}

// Refresh the shared nav indicator + Prev/Next state, then re-render the viewer.
function updateBaseNav() {
  const r = currentBase();
  updateNav({ prev: "basePrev", next: "baseNext", indicator: "baseIndicator", jump: "baseJump" },
            BASE_IDX, RAW_RECORDS.length, r ? (r.problem_id ?? "") : "");
  onBaseChange();
}

function stepBase(delta) {
  if (!RAW_RECORDS.length) return;
  BASE_IDX = Math.min(RAW_RECORDS.length - 1, Math.max(0, BASE_IDX + delta));
  updateBaseNav();
}

function currentBase() {
  if (BASE_IDX < 0 || BASE_IDX >= RAW_RECORDS.length) return null;
  return RAW_RECORDS[BASE_IDX];
}

function renderPreviewInto(id, text) {
  const el = document.getElementById(id);
  el.innerHTML = renderMathField(text || "");
  typesetMath(el);
}

// Grow a textarea to fit its content so no inner scrollbar appears.
function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// Convert an "Original (unperturbed)" record from DSPR_dataset.json into a ViewerModel.
function rawRecordToModel(rec) {
  if (!rec) return null;
  const orig = rec.original || {};
  const tags = [];
  if (rec.type) tags.push({ text: rec.type, kind: "type" });
  if (rec.level) tags.push({ text: rec.level, kind: "level" });
  const author = (document.getElementById("createAuthor").value || "").trim();
  if (author) tags.push({ text: author, kind: "author" });
  tags.push({ text: "needs perturbation", kind: "aug" });
  return {
    id: rec.id ?? rec.problem_id ?? "—",
    sourceAbbrev: sourceAbbrev(rec.source),
    tags,
    problem: orig.problem || rec.problem || "",
    answer: orig.solution ?? rec.solution ?? rec.answer ?? "",
    perturbations: null,
  };
}

// Render the shared display for the current base problem (does NOT touch the
// simple/hard editors, so it is safe to call on author-name keystrokes).
function renderGenDisplay() {
  const r = currentBase();
  if (!r) {
    document.getElementById("genDisplay").innerHTML =
      '<div class="hint">No base problem available — pull some in the Pull section first.</div>';
    return;
  }
  renderProblemDisplay("genDisplay", rawRecordToModel(r));
}

function onBaseChange() {
  const r = currentBase();
  // LLM Generation availability depends on the selected base problem too.
  updateLLMControls();
  renderGenDisplay();
  if (!r) return;
  const orig = r.original || {};
  const p = orig.problem || r.problem || "";
  // Prefill variant editors with the original as a starting point.
  const sp = document.getElementById("simpleProblem");
  const hp = document.getElementById("hardProblem");
  sp.value = p; hp.value = p;
  autoGrow(sp); autoGrow(hp);
  renderPreviewInto("simplePreview", p);
  renderPreviewInto("hardPreview", p);
}

// --------------------------------------------------------------------------
// Dataset browser (Pull section): three source tabs (MATH / NuminaMath /
// OpenMathInstruct-2) sharing one filter/sort/search/preview/pull interface.
// Records are a streamed sample from the backend; filtering + sorting happen
// client-side so they apply instantly. Pulling one record appends it to
// DSPR_dataset.json via /api/pull_record. The visual language follows the
// Profile "Projects" page (filter chips, card list, sort dropdown).
// --------------------------------------------------------------------------
const DS_SAMPLE_LIMIT = 200;  // rows streamed per dataset

const DS = {
  datasets: [],        // [{id,label,description,facets,sorts}] from /api/datasets
  current: null,       // active dataset id
  cache: {},           // id -> {records, facets, sorts}
  selected: {},        // id -> { facetKey: Set(values) }
  search: "",
  sort: "",
  filtered: [],        // current filtered+sorted result (the working set)
  idx: -1,             // pointer into DS.filtered (single-card navigator)
  inited: false,
};

// Best-effort load of dataset provider metadata (tabs + the source→abbrev map),
// so the Browse and Generate views can render "{ABBR} #{id}" even before the
// Pull tab is opened. Safe to call repeatedly; only fetches once. No BACKEND
// guard — it runs at startup before BACKEND is known and fails closed.
async function ensureDatasetMeta() {
  if (DS.datasets.length) return;
  try {
    const data = await (await fetch("/api/datasets")).json();
    DS.datasets = (data && data.datasets) || [];
  } catch (e) { /* non-fatal — display falls back to the raw source name */ }
}

// Short label for a stored source name (e.g. "NuminaMath-1.5" → "NM"), from the
// provider metadata. Falls back to the raw source string when unknown.
function sourceAbbrev(source) {
  if (!source) return "";
  const d = DS.datasets.find(x => x.source === source);
  return (d && d.abbrev) || source;
}

// Compose the ID header label: "{ABBR} #{id}" when a source is known,
// otherwise the plain "#{id}" used by source-less records (math_paired.jsonl).
function idLabel(abbrev, id) {
  if (id == null || id === "" || id === "—") return abbrev ? `${abbrev} #—` : "#—";
  return abbrev ? `${abbrev} #${id}` : `#${id}`;
}

// Dataset blurb for the Pull tab with its name hyperlinked to the HuggingFace
// dataset page. Descriptions read "{NAME} — {blurb}"; the leading {NAME} (up to
// the em dash) becomes the link, the rest stays plain text. Falls back to the
// plain description when no repo is known.
function datasetDescHtml(meta) {
  if (!meta || !meta.description) return "";
  const desc = meta.description;
  if (!meta.repo) return escapeHtml(desc);
  const href = `https://huggingface.co/datasets/${meta.repo}`;
  const sep = desc.indexOf("—");
  const name = (sep >= 0 ? desc.slice(0, sep) : desc).trim();
  const rest = sep >= 0 ? desc.slice(sep) : "";
  const link = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
  return rest ? `${link} ${escapeHtml(rest)}` : link;
}

async function initDatasetBrowser() {
  if (DS.inited) { renderDatasetBrowser(); return; }
  if (!BACKEND) {
    setStatus("pullStatus",
      "Backend not detected — run app.py to browse and pull datasets.", "err");
    return;
  }
  await ensureDatasetMeta();
  if (!DS.datasets.length) {
    setStatus("pullStatus", "Failed to load dataset list or no sources configured.", "err");
    return;
  }
  DS.inited = true;
  buildDatasetTabs();
  selectDataset(DS.datasets[0].id);
}

function buildDatasetTabs() {
  const tabs = document.getElementById("dsTabs");
  tabs.innerHTML = "";
  for (const d of DS.datasets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = d.label;
    btn.dataset.ds = d.id;
    btn.addEventListener("click", () => selectDataset(d.id));
    tabs.appendChild(btn);
  }
}

function currentDataset() {
  return DS.datasets.find(d => d.id === DS.current) || null;
}

async function selectDataset(id) {
  DS.current = id;
  DS.search = "";
  DS.sort = "";
  if (!DS.selected[id]) DS.selected[id] = {};
  document.getElementById("dsSearch").value = "";
  document.querySelectorAll("#dsTabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.ds === id));
  const meta = currentDataset();
  document.getElementById("dsDesc").innerHTML = datasetDescHtml(meta);
  // Populate the sort dropdown for this dataset.
  const sortSel = document.getElementById("dsSort");
  sortSel.innerHTML = '<option value="">Sort: default</option>';
  for (const s of (meta && meta.sorts) || []) {
    const opt = document.createElement("option");
    opt.value = s.key; opt.textContent = "Sort: " + s.label;
    sortSel.appendChild(opt);
  }
  await ensureDatasetLoaded(id);
  renderDatasetBrowser();
}

async function ensureDatasetLoaded(id) {
  if (DS.cache[id]) return;
  const viewer = document.getElementById("dsViewer");
  viewer.innerHTML = '<div class="empty">Streaming sample from HuggingFace…</div>';
  setStatus("pullStatus", "", "");
  try {
    const res = await fetch(`/api/dataset_records?dataset=${encodeURIComponent(id)}&limit=${DS_SAMPLE_LIMIT}`);
    const data = await res.json();
    if (!data.ok) {
      viewer.innerHTML = `<div class="empty">Could not load this dataset.</div>`;
      setStatus("pullStatus", "Dataset load failed: " + data.error, "err");
      return;
    }
    DS.cache[id] = { records: data.records || [], facets: data.facets || [], sorts: data.sorts || [] };
  } catch (e) {
    viewer.innerHTML = `<div class="empty">Could not load this dataset.</div>`;
    setStatus("pullStatus", "Dataset request failed: " + e.message, "err");
  }
}

// Toggle a facet value in the current dataset's selection set.
function toggleFacet(facetKey, value) {
  const sel = DS.selected[DS.current];
  if (!sel[facetKey]) sel[facetKey] = new Set();
  if (sel[facetKey].has(value)) sel[facetKey].delete(value);
  else sel[facetKey].add(value);
  if (!sel[facetKey].size) delete sel[facetKey];
  renderDatasetBrowser();
}

function clearDatasetFilters() {
  DS.selected[DS.current] = {};
  DS.search = "";
  DS.sort = "";
  document.getElementById("dsSearch").value = "";
  document.getElementById("dsSort").value = "";
  renderDatasetBrowser();
}

// Records passing the active facet selections + search box, then sorted.
function filteredDatasetRecords() {
  const cache = DS.cache[DS.current];
  if (!cache) return [];
  const sel = DS.selected[DS.current] || {};
  const q = DS.search.trim().toLowerCase();
  let recs = cache.records.filter(r => {
    // AND across facets, OR within a facet's selected values. The synthetic
    // "__status" facet maps the boolean r.pulled onto new / already pulled.
    for (const key of Object.keys(sel)) {
      const want = sel[key];
      if (!want.size) continue;
      const val = key === "__status"
        ? (r.pulled ? "already pulled" : "new")
        : String(r[key] ?? "").trim();
      if (!want.has(val)) return false;
    }
    if (q) {
      const hay = ((r.problem || "") + " " + (r.answer || "") + " " + (r.type || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (DS.sort) {
    recs = [...recs].sort((a, b) =>
      String(a[DS.sort] ?? "").localeCompare(String(b[DS.sort] ?? "")));
  }
  return recs;
}

// A filter/sort/search/tab change rebuilds the working set and snaps back to
// the first matching problem; Prev/Next/jump then move within it.
function renderDatasetBrowser() {
  if (!DS.current || !DS.cache[DS.current]) return;
  DS.filtered = filteredDatasetRecords();
  DS.idx = DS.filtered.length ? 0 : -1;
  renderDatasetFilters();
  renderDatasetCurrent();
}

function renderDatasetFilters() {
  const panel = document.getElementById("dsFilters");
  const cache = DS.cache[DS.current];
  const sel = DS.selected[DS.current] || {};
  if (!cache) { panel.innerHTML = ""; return; }
  // Synthetic "Status" facet (derived from r.pulled) prepended to the data
  // facets, so users can isolate new samples or ones already pulled.
  const statusValues = [];
  if (cache.records.some(r => !r.pulled)) statusValues.push("new");
  if (cache.records.some(r => r.pulled)) statusValues.push("already pulled");
  const facets = [{ key: "__status", label: "Status", values: statusValues }]
    .concat(cache.facets);
  const groups = facets.filter(f => f.values.length).map(f => {
    const chips = f.values.map(v => {
      const active = sel[f.key] && sel[f.key].has(v);
      return `<button type="button" class="ds-chip${active ? " active" : ""}" ` +
             `data-facet="${escapeHtml(f.key)}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
    }).join("");
    const count = sel[f.key] ? sel[f.key].size : 0;
    return `<div class="ds-fgroup">
        <div class="ds-fhead">${escapeHtml(f.label)}${count ? ` <span class="ds-fcount">${count}</span>` : ""}</div>
        <div class="ds-chips">${chips}</div>
      </div>`;
  }).join("");
  panel.innerHTML = `<div class="ds-fpanel-title">Filters</div>${groups}`;
  panel.querySelectorAll(".ds-chip").forEach(btn =>
    btn.addEventListener("click", () => toggleFacet(btn.dataset.facet, btn.dataset.value)));
}

// Convert a streamed dataset record into the shared ViewerModel.
function datasetRecordToModel(r) {
  const meta = currentDataset();
  const cache = DS.cache[DS.current];
  const tags = [];
  for (const f of (cache ? cache.facets : [])) {
    const val = String(r[f.key] ?? "").trim();
    if (val) tags.push({ text: val, kind: facetTagKind(f.key) });
  }
  tags.push({ text: r.pulled ? "already pulled" : "not pulled", kind: "aug" });
  return {
    id: r.id ?? "—",              // dataset-position id, shown before pulling too
    sourceAbbrev: meta ? meta.abbrev : "",
    tags,
    problem: r.problem || "",
    answer: r.answer || r.solution || "",
    perturbations: null,
  };
}

function currentDatasetRecord() {
  if (DS.idx < 0 || DS.idx >= DS.filtered.length) return null;
  return DS.filtered[DS.idx];
}

function stepDataset(delta) {
  if (!DS.filtered.length) return;
  DS.idx = Math.min(DS.filtered.length - 1, Math.max(0, DS.idx + delta));
  renderDatasetCurrent();
}

// Render the single focused problem through the shared Problem Viewer, refresh
// the nav indicator, and set the Pull button state for the current record.
function renderDatasetCurrent() {
  const total = DS.cache[DS.current] ? DS.cache[DS.current].records.length : 0;
  document.getElementById("dsCount").textContent = `${DS.filtered.length} / ${total} match`;
  const viewer = document.getElementById("dsViewer");
  const pullBtn = document.getElementById("dsPull");
  const rec = currentDatasetRecord();
  updateNav({ prev: "dsPrev", next: "dsNext", indicator: "dsIndicator", jump: "dsJump" },
            DS.idx, DS.filtered.length, "");
  // "Pull all selected" acts on every filtered record not already pulled.
  const pending = DS.filtered.filter(r => !r.pulled).length;
  const pullAllBtn = document.getElementById("dsPullAll");
  pullAllBtn.disabled = pending === 0;
  pullAllBtn.textContent = pending ? `Pull all selected (${pending}) →` : "Pull all selected →";
  if (!rec) {
    viewer.innerHTML = '<div class="empty">No problems match your filters.</div>';
    pullBtn.disabled = true;
    pullBtn.textContent = "Pull this problem →";
    return;
  }
  renderProblemDisplay(viewer, datasetRecordToModel(rec));
  pullBtn.disabled = !!rec.pulled;
  pullBtn.textContent = rec.pulled ? "Already pulled ✓" : "Pull this problem →";
}

async function pullDatasetRecord() {
  const rec = currentDatasetRecord();
  if (!rec) return;
  const pullBtn = document.getElementById("dsPull");
  pullBtn.disabled = true;
  pullBtn.textContent = "Pulling…";
  try {
    const res = await fetch("/api/pull_record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset: DS.current, record: rec }),
    });
    const data = await res.json();
    if (!data.ok) {
      setStatus("pullStatus", "Pull failed: " + data.error, "err");
      if (data.error && data.error.includes("duplicate")) rec.pulled = true;
      renderDatasetCurrent();
      return;
    }
    rec.pulled = true;
    setStatus("pullStatus",
      `Pulled problem ${data.record.problem_id} from ${currentDataset().label} → ${data.file}.`, "ok");
    renderDatasetCurrent();
    // Keep the Browse view and the Generate base list in sync.
    await refreshBrowse();
    populateBaseSelect();
  } catch (e) {
    setStatus("pullStatus", "Request failed: " + e.message, "err");
    renderDatasetCurrent();
  }
}

// Pull every record passing the current filters/search that isn't already pulled.
// Works off a snapshot so the set is stable even though each pull flips r.pulled.
async function pullAllFiltered() {
  const targets = DS.filtered.filter(r => !r.pulled);
  if (!targets.length) return;
  const pullBtn = document.getElementById("dsPull");
  const pullAllBtn = document.getElementById("dsPullAll");
  pullBtn.disabled = true;
  pullAllBtn.disabled = true;
  let pulled = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const rec = targets[i];
    pullAllBtn.textContent = `Pulling ${i + 1} / ${targets.length}…`;
    try {
      const res = await fetch("/api/pull_record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: DS.current, record: rec }),
      });
      const data = await res.json();
      if (data.ok) { rec.pulled = true; pulled++; }
      else { if (data.error && data.error.includes("duplicate")) rec.pulled = true; failed++; }
    } catch (e) {
      failed++;
    }
  }
  const label = currentDataset() ? currentDataset().label : DS.current;
  setStatus("pullStatus",
    `Pulled ${pulled} problem(s) from ${label}` + (failed ? `, ${failed} failed/skipped.` : "."),
    failed ? "err" : "ok");
  renderDatasetCurrent();
  // Keep the Browse view and the Generate base list in sync (once, after the batch).
  await refreshBrowse();
  populateBaseSelect();
}

async function savePerturbation() {
  if (!BACKEND) { setStatus("saveStatus", "Backend not detected — see the Pull tab note.", "err"); return; }
  const r = currentBase();
  if (!r) { setStatus("saveStatus", "Select a base problem first (use Prev/Next).", "err"); return; }
  const orig = r.original || {};
  const originalProblem = (orig.problem || r.problem || "").trim();

  const createAuthor = document.getElementById("createAuthor").value.trim();
  const variants = ["simple", "hard"].map(kind => ({
    kind,
    problem: document.getElementById(kind + "Problem").value.trim(),
    answer: document.getElementById(kind + "Answer").value.trim(),
  }));

  // Each variant must differ from the original problem, carry an answer, and have an author.
  const warnings = [];
  if (!createAuthor) warnings.push("Author name is required.");
  for (const v of variants) {
    const label = v.kind[0].toUpperCase() + v.kind.slice(1);
    if (v.problem === originalProblem) warnings.push(`${label} problem hasn't been changed from the original.`);
    if (!v.answer) warnings.push(`${label} variant is missing an answer.`);
  }
  if (warnings.length) {
    setStatus("saveStatus", warnings.map(w => "⚠ " + w).join("\n"), "err");
    return;
  }

  const autoVerify = document.getElementById("autoVerify").checked;
  const savedPid = r.problem_id;
  const byKind = Object.fromEntries(variants.map(v => [v.kind, { problem: v.problem, answer: v.answer }]));
  try {
    const res = await fetch("/api/save_variant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: r.problem_id,
        simple: byKind.simple,
        hard: byKind.hard,
        create_author: createAuthor,
        auto_verify: autoVerify,
      }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus("saveStatus", "Error saving: " + data.error, "err"); return; }
    await advanceAfterSave(savedPid, autoVerify);
  } catch (e) {
    setStatus("saveStatus", "Request failed: " + e.message, "err");
  }
}

// --------------------------------------------------------------------------
// Generation modes (Generate section). Each mode owns one panel inside the
// base-problem card; the selector buttons are built from this registry, so
// adding another backend/provider is just a new entry + panel + onEnter hook.
// --------------------------------------------------------------------------
const GEN_MODES = [
  { id: "manual", label: "Manual Creation", panel: "modeManual", onEnter() {} },
  { id: "llm", label: "LLM Generation", panel: "modeLLM", onEnter() { connectAndRefreshLLM(); } },
];
let GEN_MODE = "manual";

function buildGenModeNav() {
  const nav = document.getElementById("genModeNav");
  nav.innerHTML = "";
  for (const m of GEN_MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = m.label;
    btn.dataset.mode = m.id;
    btn.addEventListener("click", () => setGenMode(m.id));
    nav.appendChild(btn);
  }
  setGenMode(GEN_MODE);
}

function setGenMode(id) {
  const mode = GEN_MODES.find(m => m.id === id) || GEN_MODES[0];
  GEN_MODE = mode.id;
  for (const m of GEN_MODES) {
    document.getElementById(m.panel).classList.toggle("hidden", m.id !== mode.id);
  }
  document.querySelectorAll("#genModeNav button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode.id));
  mode.onEnter();
}

// --------------------------------------------------------------------------
// LLM Generation mode: backend/GPU status checks + one-click generation.
// --------------------------------------------------------------------------
let LLM_STATUS = { checked: false, server: false, available: false,
                   reason: "Status not checked yet — open the LLM Generation panel.", data: null };

// Entered the LLM panel (or hit Refresh): lazily connect to Ollama — opening
// the SSH tunnel on the backend if a remote host is configured — and reflect
// the outcome. A "connecting…" indicator shows until the attempt resolves.
async function connectAndRefreshLLM() {
  const body = document.getElementById("llmStatusBody");
  body.innerHTML =
    '<div class="status-line"><span class="dot connecting"></span>' +
    '<b>Connecting</b><span class="detail">Reaching the Ollama host…</span></div>';
  let data = null;
  try {
    const res = await fetch("/api/llm_connect", { method: "POST" });
    data = await res.json();
  } catch (e) { /* fetch failed -> server offline */ }

  if (!data) {
    LLM_STATUS = { checked: true, server: false, available: false,
      reason: "Backend server is offline — run start.sh (or python app.py serve).", data: null };
    renderLLMStatus();
    updateLLMControls();
    return;
  }

  BACKEND = true; // a live response proves the API is up

  // No local config: guide the user to the example rather than pretend to connect.
  if (data.configured === false) {
    const hint = escapeHtml(data.hint_file || "ollama.local.sh.example");
    body.innerHTML =
      `<div class="hint">${escapeHtml(data.error || "Ollama is not configured.")}` +
      `<br>Run <code>cp ${hint} ollama.local.sh</code> in the repo root, fill in your ` +
      `host (or leave the SSH vars blank for a local Ollama), then restart the server.</div>`;
    LLM_STATUS = { checked: true, server: true, available: false,
      reason: data.error || "No ollama.local.sh — see the setup note above.", data: null };
    updateLLMControls();
    return;
  }

  LLM_STATUS = { checked: true, server: true, available: !!data.available,
    reason: data.reason || "", data };
  populateModelOptions(data.ollama || {});
  renderLLMStatus();
  updateLLMControls();
}

// Fill #llmModel with the models installed on the Ollama host, preferring the
// user's last pick, then the backend default, then the first available.
function populateModelOptions(o) {
  const sel = document.getElementById("llmModel");
  const models = o.models || [];
  if (!models.length) {
    sel.innerHTML = "<option>—</option>";
    sel.disabled = true;
    return;
  }
  const saved = localStorage.getItem("llmModel");
  const preferred = models.includes(saved) ? saved
                  : (models.includes(o.model) ? o.model : models[0]);
  sel.innerHTML = models.map(m =>
    `<option value="${escapeHtml(m)}"${m === preferred ? " selected" : ""}>${escapeHtml(m)}</option>`
  ).join("");
  sel.disabled = false;
}

function dotLine(state, label, detail) {
  return `<div class="status-line"><span class="dot ${state}"></span>` +
         `<b>${label}</b><span class="detail">${escapeHtml(detail || "")}</span></div>`;
}

const GIB = 1024; // MiB per GiB
function fmtGiB(mib) { return (mib / GIB).toFixed(1) + " GiB"; }

// qwen2.5:7b needs ~5 GiB; flag GPUs that lack comfortable headroom for it.
const FREE_OK_MIB = 8 * GIB;

// GPU readout led by free VRAM (the stat that matters for picking a card on a
// shared box). Numbers come pre-parsed (MiB) from /api/llm_status. Free VRAM
// and the used/total fraction each get their own row.
function renderGpuTable(gpus) {
  const rows = gpus.map((x) => {
    const freeClass = x.mem_free_mib >= FREE_OK_MIB ? "ok" : "warn";
    const pctFree = Math.round((x.mem_free_mib / x.mem_total_mib) * 100);
    return `<div class="gpu-row">
      <div class="gpu-idx">GPU ${x.index}</div>
      <div class="gpu-stats">
        <div class="gpu-free ${freeClass}">${fmtGiB(x.mem_free_mib)} free <span class="muted">(${pctFree}%)</span></div>
        <div class="gpu-frac muted">${fmtGiB(x.mem_used_mib)} / ${fmtGiB(x.mem_total_mib)} used</div>
        <div class="gpu-name muted">${escapeHtml(x.name)}</div>
      </div>
    </div>`;
  });
  return `<div class="gpu-table">${rows.join("")}</div>`;
}

function renderLLMStatus() {
  const rows = [];
  rows.push(dotLine(LLM_STATUS.server ? "ok" : "err", "Server",
    LLM_STATUS.server ? "Backend online" : "Backend offline"));
  const d = LLM_STATUS.data;
  if (d) {
    const o = d.ollama || {};
    rows.push(dotLine(o.reachable ? "ok" : "err", "LLM service",
      o.reachable ? `Ollama reachable at ${o.host} (model: ${o.model})`
                  : (o.error || "Unreachable")));
    const g = d.gpu || {};
    rows.push(dotLine(g.detected ? "ok" : "warn", "GPU",
      g.detected ? `${g.gpus.length} GPU(s) on the Ollama host`
                 : (g.error || "No GPU detected")));
    if (g.detected) rows.push(renderGpuTable(g.gpus));
  }
  document.getElementById("llmStatusBody").innerHTML = rows.join("");
}

// Enable the LLM Generation button only when every prerequisite holds; the
// banner always states either readiness or the first blocking reason.
function updateLLMControls() {
  let reason = "";
  if (!BACKEND) reason = "Backend not detected — start app.py to enable LLM generation.";
  else if (!LLM_STATUS.checked) reason = "Status not checked yet — click Refresh status.";
  else if (!LLM_STATUS.available) reason = LLM_STATUS.reason;
  else if (!currentBase()) reason = "No base problem selected — pull problems in the Pull section first.";
  document.getElementById("llmGenerateBtn").disabled = !!reason;
  const banner = document.getElementById("llmAvailability");
  banner.textContent = reason || "LLM generation is ready.";
  banner.className = "llm-banner " + (reason ? "err" : "ok");
}

async function llmGenerate() {
  if (!BACKEND) { setStatus("saveStatus", "Backend not detected — see the Pull section note.", "err"); return; }
  const r = currentBase();
  if (!r) { setStatus("saveStatus", "Select a base problem first (use Prev/Next).", "err"); return; }
  const autoVerify = document.getElementById("llmAutoVerify").checked;
  const btn = document.getElementById("llmGenerateBtn");
  btn.disabled = true;
  setStatus("saveStatus", "Asking the LLM to generate simple + hard variants…", "");
  try {
    const res = await fetch("/api/llm_generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        problem_id: r.problem_id,
        auto_verify: autoVerify,
        model: document.getElementById("llmModel").value || undefined,
      }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus("saveStatus", "LLM error: " + data.error, "err"); updateLLMControls(); return; }
    // Advance, exactly like a manual save.
    await advanceAfterSave(r.problem_id, autoVerify);
  } catch (e) {
    setStatus("saveStatus", "Request failed: " + e.message, "err");
  }
  updateLLMControls();
}

async function advanceAfterSave(pid, autoVerify) {
  // The perturbations now live on the same record, which has left "Original"
  // status — so it drops out of the base pool. Track + remove it locally for
  // immediate feedback (no server delete; the record stays, just re-statused).
  CONSUMED_PIDS.add(pid);
  RAW_RECORDS = RAW_RECORDS.filter(r => r.problem_id !== pid);
  if (BASE_IDX >= RAW_RECORDS.length) BASE_IDX = RAW_RECORDS.length - 1;
  // Clear variant editors.
  ["simpleProblem", "hardProblem"].forEach(id => {
    const el = document.getElementById(id); el.value = ""; autoGrow(el);
  });
  ["simpleAnswer", "hardAnswer"].forEach(id => document.getElementById(id).value = "");
  updateBaseNav(); // re-renders base preview for the new current record
  const remaining = RAW_RECORDS.length;
  const dest = autoVerify ? "Verified" : "Unverified";
  setStatus("saveStatus",
    `Saved → ${dest}. ${remaining} problem(s) remaining.`, "ok");
  // The base left the Generate pool; an auto-verified pair joins Browse. Either
  // way the Browse data set changed, so refresh it.
  await refreshBrowse();
}

// --------------------------------------------------------------------------
// Verify tab: review pending perturbations one problem at a time (Prev/Next),
// approve -> verified or reject. Mirrors the Generate tab's base navigation
// instead of listing every pending problem at once.
// --------------------------------------------------------------------------
// Pending records — one per problem (each holds its own simple + hard).
let PENDING_GROUPS = [];   // array of pending records, navigated one at a time
let VERIFY_IDX = -1;       // pointer into PENDING_GROUPS

async function loadPending() {
  if (!BACKEND) {
    setStatus("verifyStatus", "Backend not detected — run app.py to verify.", "err");
    PENDING_GROUPS = []; VERIFY_IDX = -1; updateVerifyNav();
    return;
  }
  setStatus("verifyStatus", "", "");
  try {
    const data = await (await fetch("/api/pending")).json();
    if (!data.exists) {
      setStatus("verifyStatus",
        "Nothing to verify yet — no unverified perturbations in DSPR_dataset.json. Generate perturbations first.", "err");
      PENDING_GROUPS = []; VERIFY_IDX = -1; updateVerifyNav();
      return;
    }
    setPendingGroups(Array.isArray(data.records) ? data.records : []);
  } catch (e) {
    setStatus("verifyStatus", "Request failed: " + e.message, "err");
  }
}

// Each pending record is its own problem now, so just store the list + reset.
function setPendingGroups(recs) {
  PENDING_GROUPS = Array.isArray(recs) ? recs : [];
  VERIFY_IDX = PENDING_GROUPS.length ? 0 : -1;
  updateVerifyNav();
}

// Refresh the shared nav indicator + Prev/Next state, then render the record.
function updateVerifyNav() {
  const cur = (VERIFY_IDX >= 0 && PENDING_GROUPS[VERIFY_IDX]) ? PENDING_GROUPS[VERIFY_IDX] : null;
  updateNav({ prev: "verifyPrev", next: "verifyNext", indicator: "verifyIndicator", jump: "verifyJump" },
            VERIFY_IDX, PENDING_GROUPS.length, cur ? (cur.problem_id ?? "") : "");
  renderCurrentPending();
}

function stepVerify(delta) {
  if (!PENDING_GROUPS.length) return;
  VERIFY_IDX = Math.min(PENDING_GROUPS.length - 1, Math.max(0, VERIFY_IDX + delta));
  updateVerifyNav();
}

function pendingVariantBlock(tag, obj) {
  if (!obj) return "";
  return `
    <div class="variant ${tag}">
      <div class="variant-head">
        <span class="vtag ${tag}">${tag}</span>
      </div>
      <div class="problem-text">${renderMathField(obj.problem || "")}</div>
      ${obj.answer ? `
        <div class="answer-wrap">
          <div class="answer-label">Answer</div>
          <div class="answer-text">${renderMathField(obj.answer)}</div>
        </div>` : ""}
    </div>`;
}

// Convert a pending record into the shared ViewerModel. Perturbations are a
// structured extension of the base problem, not a separate UI entity.
function pendingGroupToModel(rec) {
  if (!rec) return null;
  const orig = rec.original || {};
  const tags = [];
  if (rec.type) tags.push({ text: rec.type, kind: "type" });
  if (rec.level) tags.push({ text: rec.level, kind: "level" });
  if (rec.create_author) tags.push({ text: rec.create_author, kind: "author" });
  tags.push({ text: "pending review", kind: "aug" });
  const perturbations = [["simple", rec.simple], ["hard", rec.hard]]
    .filter(([, v]) => v)
    .map(([kind, v]) => ({ kind, problem: v.problem, answer: v.answer }));
  return {
    id: rec.id ?? rec.problem_id ?? "—",
    sourceAbbrev: sourceAbbrev(rec.source),
    tags,
    problem: orig.problem || rec.original_problem || "",
    answer: "",
    perturbations,
  };
}

// Render the record at VERIFY_IDX through the shared Problem Viewer, then fill
// the perturbations section. The original/simple/hard variants form one bundle
// that is approved or rejected together, so there is a single action row for
// the whole problem rather than per-variant buttons.
function renderCurrentPending() {
  const list = document.getElementById("verifyList");
  if (VERIFY_IDX < 0 || !PENDING_GROUPS.length) {
    list.innerHTML = '<div class="empty">Nothing awaiting verification.</div>';
    return;
  }
  const rec = PENDING_GROUPS[VERIFY_IDX];
  list.innerHTML = `
    <div class="card">
      <div class="pv-host" id="verifyDisplay"></div>
      <div class="variant-row" id="verifyVariants"></div>
      <div class="loader-row verify-actions" style="margin-top:14px">
        <button class="btn-accent verifyApprove">Approve pair &rarr; verified</button>
        <button class="verifyReject">Reject pair</button>
      </div>
    </div>`;
  renderProblemDisplay("verifyDisplay", pendingGroupToModel(rec));
  const variantsEl = list.querySelector("#verifyVariants");
  if (variantsEl) {
    variantsEl.innerHTML = pendingVariantBlock("simple", rec.simple) + pendingVariantBlock("hard", rec.hard);
    typesetMath(variantsEl);
  }
  list.querySelector(".verifyApprove").addEventListener("click", () => decidePending("verify"));
  list.querySelector(".verifyReject").addEventListener("click", () => decidePending("reject"));
}

async function decidePending(action) {
  // Act on the whole problem, keyed by problem_id.
  const rec = PENDING_GROUPS[VERIFY_IDX];
  if (!rec || rec.problem_id == null) return;
  if (action === "verify") {
    const author = document.getElementById("verifyAuthor").value.trim();
    if (!author) {
      setStatus("verifyStatus", "⚠ Verifier name is required before approving.", "err");
      return;
    }
  }
  const verifyAuthor = document.getElementById("verifyAuthor").value.trim();
  try {
    const res = await fetch("/api/" + action, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_id: rec.problem_id, verify_author: verifyAuthor }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus("verifyStatus", "Error: " + data.error, "err"); return; }
    // Decided — drop the record and advance.
    PENDING_GROUPS.splice(VERIFY_IDX, 1);
    // Stay on the same index (now the next problem); clamp to the new end.
    if (VERIFY_IDX >= PENDING_GROUPS.length) VERIFY_IDX = PENDING_GROUPS.length - 1;
    setStatus("verifyStatus",
      action === "verify" ? "Pair marked Verified in DSPR_dataset.json." : "Pair rejected — base problem returned to the Generate pool.", "ok");
    updateVerifyNav();
    // Approve adds a Verified pair to Browse; Reject restores an Original base —
    // both change the Browse data set.
    await refreshBrowse();
  } catch (e) {
    setStatus("verifyStatus", "Request failed: " + e.message, "err");
  }
}

document.getElementById("navBrowse").addEventListener("click", () => showTab("browse"));
document.getElementById("navCreate").addEventListener("click", () => showTab("create"));
document.getElementById("refreshPending").addEventListener("click", loadPending);
// Shared navigation model: Prev/Next + jump-to-index for all three sections.
document.getElementById("basePrev").addEventListener("click", () => stepBase(-1));
document.getElementById("baseNext").addEventListener("click", () => stepBase(1));
document.getElementById("verifyPrev").addEventListener("click", () => stepVerify(-1));
document.getElementById("verifyNext").addEventListener("click", () => stepVerify(1));
document.getElementById("dsPrev").addEventListener("click", () => stepDataset(-1));
document.getElementById("dsNext").addEventListener("click", () => stepDataset(1));
document.getElementById("dsPull").addEventListener("click", pullDatasetRecord);
document.getElementById("dsPullAll").addEventListener("click", pullAllFiltered);
wireJump("baseJump", "baseJumpGo", () => RAW_RECORDS.length,
  (i) => { BASE_IDX = i; updateBaseNav(); });
wireJump("verifyJump", "verifyJumpGo", () => PENDING_GROUPS.length,
  (i) => { VERIFY_IDX = i; updateVerifyNav(); });
wireJump("dsJump", "dsJumpGo", () => DS.filtered.length,
  (i) => { DS.idx = i; renderDatasetCurrent(); });
document.getElementById("dsSearch").addEventListener("input", (e) => {
  DS.search = e.target.value;
  renderDatasetBrowser();
});
document.getElementById("dsSort").addEventListener("change", (e) => {
  DS.sort = e.target.value;
  renderDatasetBrowser();
});
document.getElementById("dsClear").addEventListener("click", clearDatasetFilters);
document.getElementById("dsReload").addEventListener("click", () => {
  if (DS.current) { delete DS.cache[DS.current]; selectDataset(DS.current); }
});
document.getElementById("savePerturbation").addEventListener("click", savePerturbation);
document.getElementById("llmGenerateBtn").addEventListener("click", llmGenerate);
document.getElementById("llmStatusRefresh").addEventListener("click", connectAndRefreshLLM);
document.getElementById("llmModel").addEventListener("change", (e) => {
  if (e.target.value) localStorage.setItem("llmModel", e.target.value);
});
document.getElementById("simpleProblem").addEventListener("input", (e) => {
  autoGrow(e.target);
  renderPreviewInto("simplePreview", e.target.value);
});
document.getElementById("hardProblem").addEventListener("input", (e) => {
  autoGrow(e.target);
  renderPreviewInto("hardPreview", e.target.value);
});
document.getElementById("createAuthor").addEventListener("input", () => {
  // Re-render only the display (keeps the author tag fresh; leaves editors alone).
  renderGenDisplay();
});

(async () => {
  buildGenModeNav(); // selector buttons + default Manual Creation panel
  // Load the source→abbrev map first so the initial Browse render shows
  // "{ABBR} #{id}" rather than the raw source name.
  await ensureDatasetMeta();
  const ok = await tryAutoLoad();
  if (!ok) showFilePicker("Could not auto-load data (opening via file:// blocks fetch).");
  // Restore the tab the user was last on (data load done, so BACKEND is known).
  let saved = "browse";
  try { saved = localStorage.getItem(ACTIVE_TAB_KEY) || "browse"; } catch (e) { /* storage disabled */ }
  showTab(saved);
})();
