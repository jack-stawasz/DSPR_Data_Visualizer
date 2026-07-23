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
  requestAnimationFrame(syncHeaderHeight);
}

// The header is sticky and its height varies (loaderRow content, wrapped
// controls on narrow screens), so .ds-filters' sticky offset is driven by
// this CSS var rather than a hardcoded px value — otherwise the sidebar
// scrolls up under the header and its top gets clipped/inaccessible.
function syncHeaderHeight() {
  const header = document.querySelector("header");
  if (!header) return;
  document.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
}
window.addEventListener("resize", syncHeaderHeight);

function onLoaded(recs, source) {
  RECORDS = recs;
  document.getElementById("loaderRow").innerHTML =
    `<span class="sub">Loaded <b>${recs.length}</b> records from <code class="kbd">${source}</code></span>`;
  renderBrowseFacets();
  render();
  requestAnimationFrame(syncHeaderHeight);
}

// --------------------------------------------------------------------------
// Browse facets: chip-based filters over the full dataset (every pipeline
// stage — Original/Kept/Rejected/Unverified/Verified — now that /api/records
// returns everything). Mirrors the Filter tab's facet pattern
// (FILTER_FACETS/filterFacetDefs/renderFilterFacets) but without the Filter
// tab's sort/threshold controls, which don't apply to Browse.
// --------------------------------------------------------------------------
const BROWSE_FACETS = {};   // facetKey -> Set(values)

// get(r) pulls each facet's value off a record. Provider-declared facets
// beyond type/level/source (NuminaMath's question_type/source, OpenMath's
// problem_source) live under r.facets, namespaced there by norm_to_raw to
// avoid colliding with the record's own top-level "source" field.
const BROWSE_FACET_DEFS = [
  { key: "status", label: "Pipeline stage", get: r => r.status },
  { key: "source", label: "Source dataset", get: r => r.source },
  { key: "level", label: "Level", get: r => r.level },
  { key: "type", label: "Subject", get: r => r.type },
  { key: "problem_type", label: "Problem Type", get: r => r.facets && r.facets.problem_type },
  { key: "question_type", label: "Question Type", get: r => r.facets && r.facets.question_type },
  { key: "row_source", label: "Row Source", get: r => r.facets && r.facets.source },
  { key: "problem_source", label: "Problem Source", get: r => r.facets && r.facets.problem_source },
  { key: "create_author", label: "Created by", get: r => r.create_author },
  { key: "verify_author", label: "Verified by", get: r => r.verify_author },
];

function browseFacetDefs() {
  return BROWSE_FACET_DEFS.map(f => {
    const values = [...new Set(RECORDS.map(r => (f.get(r) || "").toString().trim()).filter(Boolean))].sort();
    return { key: f.key, label: f.label, values };
  }).filter(f => f.values.length);
}

function matchesBrowseFacets(r) {
  for (const f of BROWSE_FACET_DEFS) {
    const want = BROWSE_FACETS[f.key];
    if (want && want.size && !want.has((f.get(r) || "").toString().trim())) return false;
  }
  return true;
}

function toggleBrowseFacet(key, value) {
  if (!BROWSE_FACETS[key]) BROWSE_FACETS[key] = new Set();
  const set = BROWSE_FACETS[key];
  if (set.has(value)) set.delete(value); else set.add(value);
  if (!set.size) delete BROWSE_FACETS[key];
  renderBrowseFacets();
  render();
}

function clearBrowseFilters() {
  for (const k of Object.keys(BROWSE_FACETS)) delete BROWSE_FACETS[k];
  renderBrowseFacets();
  render();
}

function renderBrowseFacets() {
  const panel = document.getElementById("browseFacets");
  if (!panel) return;
  const defs = browseFacetDefs();
  const groups = defs.map(f => {
    const chips = f.values.map(v => {
      const active = BROWSE_FACETS[f.key] && BROWSE_FACETS[f.key].has(v);
      return `<button type="button" class="ds-chip${active ? " active" : ""}" ` +
             `data-facet="${escapeHtml(f.key)}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
    }).join("");
    const count = BROWSE_FACETS[f.key] ? BROWSE_FACETS[f.key].size : 0;
    return `<div class="ds-fgroup">
        <div class="ds-fhead">${escapeHtml(f.label)}${count ? ` <span class="ds-fcount">${count}</span>` : ""}</div>
        <div class="ds-chips">${chips}</div>
      </div>`;
  }).join("");
  panel.innerHTML = `
    <div class="ds-fhead-row">
      <span class="ds-fpanel-title">Filters</span>
      <button id="browseFilterClear" type="button" class="ds-fclear">Clear</button>
    </div>
    ${groups || `<div class="hint">No records loaded yet.</div>`}`;
  panel.querySelector("#browseFilterClear").addEventListener("click", clearBrowseFilters);
  panel.querySelectorAll(".ds-chip").forEach(btn =>
    btn.addEventListener("click", () => toggleBrowseFacet(btn.dataset.facet, btn.dataset.value)));
}

// Visual mapping from a record's pipeline stage to an existing badge colour —
// reuses .badge.kept (green) / .badge.rejected (red) / .badge.aug (muted).
function statusBadgeKind(status) {
  if (status === "Verified") return "kept";
  if (status === "Filtered (rejected)") return "rejected";
  return "aug";
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

// A perturbation's answer comes back as a *bare* LaTeX expression (e.g.
// "\frac{1}{2}" or "\left[ \frac{\pi^2}{8}, \frac{5\pi^2}{4} \right]") with no
// $ or \( \) delimiters, so KaTeX auto-render would leave it as raw source.
// Wrap a bare, math-looking answer in $...$ so it typesets; leave answers that
// already carry their own delimiters (or are plain prose) to renderMathField.
function renderAnswerField(raw) {
  const s = String(raw).trim();
  if (!s) return "";
  const hasDelims = /\$|\\\(|\\\[|\\begin\{/.test(s);
  const looksLikeMath = /[\\^_{}=+\-*/]|\d/.test(s);
  return hasDelims || !looksLikeMath ? renderMathField(s) : `$${escapeHtml(s)}$`;
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
    .map(t => {
      const title = t.title ? ` title="${escapeHtml(String(t.title))}"` : "";
      return `<span class="badge ${t.kind || ""}"${title}>${escapeHtml(String(t.text))}</span>`;
    })
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
         <div class="preview answer-text">${renderAnswerField(String(model.answer))}</div>
       </div>` : "";
  const debugSample = model.debugSample
    ? `<details class="pv-debug-sample">
        <summary>Last eval sample (raw model output)</summary>
        <div class="preview">${escapeHtml(model.debugSample)}</div>
      </details>` : "";
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
    ${debugSample}
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

// --------------------------------------------------------------------------
// Shared batch operations — one implementation reused by the Pull, Generate,
// and Verify sections. Each section supplies a small descriptor (its eligible
// list, the current item, and a per-item action); everything else — the type
// dropdown, the size/percentage inputs, the Ordered/Random toggle, the
// selection maths, and the run loop — lives here so the behaviour is identical
// everywhere and adding it to a new section is just a descriptor + one host.
//
//   BatchConfig = { count, mode: "ordered"|"random" }
//   Section     = { status, batch, getEligible(), getCurrent(),
//                   runOne(item, opts), afterBatch(summary, opts), onProgress? }
//
// The count input and the percentage slider are two views of one quantity: the
// number of eligible problems to operate on. Editing either updates the other,
// both clamped against the live pool size (opts.getTotal). The count is reset to
// the max available when set too high, to 0 when negative, and rounded to a whole
// number; the slider snaps the count to the matching percentage of the pool.
// --------------------------------------------------------------------------

// Build the batch controls into a host element and return a { getConfig, refresh }
// handle. opts.getTotal() supplies the current eligible-pool size; opts.onChange
// (optional) fires whenever any control changes so a section can refresh its
// action button label/state.
function createBatchControl(hostId, opts) {
  opts = opts || {};
  const host = document.getElementById(hostId);
  if (!host) return { getConfig: () => ({ count: 0, mode: "ordered" }), refresh: () => {} };
  host.innerHTML = `
    <label class="batch-count">
      <input type="number" class="batch-num batch-count-input" min="0" step="1"
             value="${opts.defaultCount || 1}" aria-label="Number of problems" />
      <span class="batch-unit">problems</span>
    </label>
    <span class="batch-slider-wrap">
      <input type="range" class="batch-slider" min="0" max="100" step="1" value="0"
             aria-label="Percentage of problems" />
      <span class="batch-pct-readout">0%</span>
    </span>
    <span class="batch-mode" role="group" aria-label="Selection mode">
      <button type="button" class="batch-mode-btn active" data-mode="ordered">Ordered</button>
      <button type="button" class="batch-mode-btn" data-mode="random">Random</button>
    </span>`;
  const countInput = host.querySelector(".batch-count-input");
  const slider = host.querySelector(".batch-slider");
  const pctReadout = host.querySelector(".batch-pct-readout");
  const modeWrap = host.querySelector(".batch-mode");
  let mode = "ordered";
  let count = Math.max(0, Math.round(opts.defaultCount || 1));   // source of truth
  const total = () => Math.max(0, opts.getTotal ? opts.getTotal() : 0);
  const fireChange = () => { if (opts.onChange) opts.onChange(); };

  // Mirror the current count onto the slider + readout (count input optionally,
  // so a user mid-keystroke isn't fought). Percentage is count / pool size.
  function reflect(rewriteCount) {
    const max = total();
    if (rewriteCount) countInput.value = String(count);
    const pct = max ? Math.round((count / max) * 100) : 0;
    slider.value = String(pct);
    pctReadout.textContent = pct + "%";
  }

  // Count edited: round floats, floor negatives at 0, cap at the pool size.
  function commitCount(rewriteCount) {
    const max = total();
    let n = Math.round(Number(countInput.value));
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > max) n = max;
    count = n;
    reflect(rewriteCount);
    fireChange();
  }

  // Slider moved: count becomes that percentage of the live pool size.
  function commitPct() {
    const max = total();
    const pct = Math.max(0, Math.min(100, Math.round(Number(slider.value) || 0)));
    count = Math.round((pct / 100) * max);
    countInput.value = String(count);
    pctReadout.textContent = pct + "%";
    fireChange();
  }

  countInput.addEventListener("input", () => commitCount(false));  // live, keep text
  countInput.addEventListener("change", () => commitCount(true));  // normalize on blur
  slider.addEventListener("input", commitPct);
  modeWrap.querySelectorAll(".batch-mode-btn").forEach(b =>
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      modeWrap.querySelectorAll(".batch-mode-btn").forEach(x => x.classList.toggle("active", x === b));
      fireChange();
    }));
  reflect(true);
  return {
    getConfig() {
      return { count: Math.max(0, Math.min(total(), count)), mode };
    },
    // Re-sync the display when the pool size changes underneath us (records
    // pulled/generated/verified). Clamp the count down to a shrunken pool, but
    // never invent a larger count than the user asked for.
    refresh() {
      const max = total();
      if (count > max) count = max;
      reflect(true);
    },
  };
}

// How many items a config asks for, given the eligible pool size.
function batchCount(config, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(total, Math.floor(config.count || 0)));
}

// Pick n distinct items from arr at random (partial Fisher–Yates).
function sampleN(arr, n) {
  const a = arr.slice();
  const take = Math.min(n, a.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, take);
}

// Resolve a config into the concrete list of items to operate on. Eligibility is
// the caller's responsibility (eligible is already status-scoped); this only
// decides which of those eligible items the batch touches.
//   ordered     → start at current and walk forward, wrapping with modulo
//   random      → a random distinct sample
function selectBatchItems(eligible, current, config) {
  const total = eligible.length;
  const n = batchCount(config, total);
  if (n <= 0) return [];
  if (config.mode === "random") return sampleN(eligible, n);
  let start = eligible.indexOf(current);
  if (start < 0) start = 0;                      // no current selection → from the top
  const out = [];
  for (let k = 0; k < n; k++) out.push(eligible[(start + k) % total]);
  return out;
}

// Shared batch progress bar (Generate / Pull). ids = { wrap, bar } of the track
// and fill element ids. setBatchProgress reveals the bar and fills it to the
// fraction completed before step i of total; finishBatchProgress flashes it to
// 100% then hides+resets it. A single-item run shows an empty bar that flashes
// full, matching the multi-item behaviour.
function setBatchProgress(ids, i, total) {
  const wrap = document.getElementById(ids.wrap);
  const bar = document.getElementById(ids.bar);
  if (!wrap || !bar) return;
  wrap.classList.remove("hidden");
  bar.style.width = (total > 1 ? ((i - 1) / total) * 100 : 0) + "%";
}
function finishBatchProgress(ids) {
  const wrap = document.getElementById(ids.wrap);
  const bar = document.getElementById(ids.bar);
  if (!wrap || !bar) return;
  bar.style.width = "100%";
  setTimeout(() => { wrap.classList.add("hidden"); bar.style.width = "0%"; }, 400);
}
const GEN_PROGRESS = { wrap: "genProgressWrap", bar: "genProgressBar" };
const PULL_PROGRESS = { wrap: "pullProgressWrap", bar: "pullProgressBar" };

// Run a section's action across its batch selection: read the config, resolve
// the items, apply runOne to each in turn (reporting progress), then hand the
// section a single afterBatch so it refreshes its UI/state once.
async function runBatch(section, opts) {
  opts = opts || {};
  const config = section.batch.getConfig();
  const eligible = section.getEligible();
  const items = selectBatchItems(eligible, section.getCurrent(), config);
  if (!items.length) {
    setStatus(section.status, opts.emptyMsg || "No eligible problems to operate on.", "err");
    return { ok: 0, fail: 0, total: 0 };
  }
  let ok = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    if (section.onProgress) section.onProgress(i + 1, items.length);
    const res = await section.runOne(items[i], opts);
    if (res && res.ok) ok++; else fail++;
  }
  const summary = { ok, fail, total: items.length };
  if (section.afterBatch) await section.afterBatch(summary, opts);
  return summary;
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
  const list = document.getElementById("list");
  const variantsToShow = ["original", "simple", "hard"];

  let shown = 0;
  const html = [];
  for (const r of RECORDS) {
    if (!matchesBrowseFacets(r)) continue;
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
          ${r.status ? `<span class="badge ${statusBadgeKind(r.status)}">${escapeHtml(r.status)}</span>` : ""}
          ${r.type ? `<span class="badge type">${escapeHtml(r.type)}</span>` : ""}
          ${r.level ? `<span class="badge level">${escapeHtml(r.level)}</span>` : ""}
          ${r.create_author ? `<span class="badge author">${escapeHtml(r.create_author)}</span>` : ""}
          ${r.verify_author ? `<span class="badge verifier">${escapeHtml(r.verify_author)}</span>` : ""}
          ${renderTags([solveTag(r), graderErrorTag(r)])}
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
  // Browse's facet sidebar needs extra width so it doesn't shrink the card
  // column (see main.wide in styles.css).
  document.querySelector("main").classList.toggle("wide", browse);

  for (const t of TABS) {
    document.getElementById(NAV_ID[t]).classList.toggle("active", t === name);
  }
  if (!browse) {
    // All four sections are visible at once, so populate each in order.
    refreshCreateScreen();
    initDatasetBrowser();
    loadFilterPool();       // Filter step (Original/Kept/Rejected pool)
    populateBaseSelect();   // Generate step (Kept pool)
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
        "No problems pulled yet — DSPR_dataset.json is empty. Use the Pull tab first.", "err");
    } else if (!RAW_RECORDS.length) {
      setStatus("generateStatus",
        "No Kept problems yet — evaluate and Apply filters in the Filter step to promote problems here.", "err");
    } else {
      setStatus("generateStatus", "", "");  // count is redundant with the nav indicator
    }
  } catch (e) {
    setStatus("generateStatus", "Failed to load raw problems: " + e.message, "err");
    RAW_RECORDS = [];
  }
  BASE_IDX = RAW_RECORDS.length ? 0 : -1;
  updateBaseNav();
}

// Load the Filter step's working pool (non-generated records: Original / Kept /
// Rejected) — separate from Generate's Kept-only base pool (RAW_RECORDS).
async function loadFilterPool() {
  if (!BACKEND) { FILTER_RECORDS = []; refreshFilterSection({ reset: true }); return; }
  try {
    const data = await (await fetch("/api/filter_pool")).json();
    FILTER_RECORDS = Array.isArray(data.records) ? data.records : [];
    FILTER_RECORDS.sort((a, b) => (a.problem_id ?? 0) - (b.problem_id ?? 0));
  } catch (e) {
    FILTER_RECORDS = [];
    setStatus("filterStatus", "Failed to load the filter pool: " + e.message, "err");
  }
  refreshFilterSection({ reset: true });
}

// Refresh the shared nav indicator + Prev/Next state, then re-render the viewer.
function updateBaseNav() {
  // No ID in the generate-section indicator (omit the id arg); other sections keep it.
  updateNav({ prev: "basePrev", next: "baseNext", indicator: "baseIndicator", jump: "baseJump" },
            BASE_IDX, RAW_RECORDS.length);
  if (genSection.batch) genSection.batch.refresh();  // track the base pool size
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
  const host = document.getElementById("genDisplay");
  // The LLM Generation mode generates from the selected base directly, so the
  // original-problem viewer is hidden there to reduce clutter.
  if (GEN_MODE === "llm") { host.innerHTML = ""; return; }
  const r = currentBase();
  if (!r) {
    host.innerHTML =
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
  filtered: [],        // current filtered result (the working set)
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
  if (!DS.selected[id]) DS.selected[id] = {};
  document.getElementById("dsSearch").value = "";
  document.querySelectorAll("#dsTabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.ds === id));
  const meta = currentDataset();
  document.getElementById("dsDesc").innerHTML = datasetDescHtml(meta);
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

// Records passing the active facet selections + search box.
function filteredDatasetRecords() {
  const cache = DS.cache[DS.current];
  if (!cache) return [];
  const sel = DS.selected[DS.current] || {};
  const q = DS.search.trim().toLowerCase();
  return cache.records.filter(r => {
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
  if (!panel) return;   // facet filtering moved to the Filter step; Pull has no panel
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
  const viewer = document.getElementById("dsViewer");
  const rec = currentDatasetRecord();
  updateNav({ prev: "dsPrev", next: "dsNext", indicator: "dsIndicator", jump: "dsJump" },
            DS.idx, DS.filtered.length, "");
  if (!rec) {
    viewer.innerHTML = '<div class="empty">No problems match your filters.</div>';
  } else {
    renderProblemDisplay(viewer, datasetRecordToModel(rec));
  }
  updatePullButton();
}

// problem_ids pulled in the current batch — consumed by the optional eval phase.
let PULLED_PIDS = [];

// Pull section batch descriptor. Eligible = filtered records not yet pulled;
// the per-item action posts one record to /api/pull_record. The shared runBatch
// drives Single / Batch Size / Percentage and Ordered / Random off this.
const pullSection = {
  status: "pullStatus",
  batch: null,   // createBatchControl handle, set during init
  getEligible: () => DS.filtered.filter(r => !r.pulled),
  getCurrent: () => currentDatasetRecord(),
  async runOne(rec) {
    try {
      const res = await fetch("/api/pull_record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: DS.current, record: rec }),
      });
      const data = await res.json();
      if (data.ok) {
        rec.pulled = true;
        if (data.record && data.record.problem_id != null) PULLED_PIDS.push(data.record.problem_id);
        return { ok: true };
      }
      // A duplicate is already in the store — treat it as pulled, count as a skip.
      if (data.error && data.error.includes("duplicate")) rec.pulled = true;
      return { ok: false, error: data.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  onProgress(i, total) {
    if (total > 1) setStatus("pullStatus", `Pulling ${i} / ${total}…`, "");
    setBatchProgress(PULL_PROGRESS, i, total);
  },
  async afterBatch({ ok, fail }) {
    finishBatchProgress(PULL_PROGRESS);
    const label = currentDataset() ? currentDataset().label : DS.current;
    setStatus("pullStatus",
      `Pulled ${ok} problem(s) from ${label}` + (fail ? `, ${fail} failed/skipped.` : "."),
      fail ? "err" : "ok");
    renderDatasetCurrent();
    // Keep Browse, the Generate base list, and the Filter pool in sync.
    await refreshBrowse();
    await populateBaseSelect();
    await loadFilterPool();
    // Optional eval phase: score the just-pulled problems (two progress bars).
    const evalOn = document.getElementById("pullEval") && document.getElementById("pullEval").checked;
    const pids = PULLED_PIDS.slice();
    PULLED_PIDS = [];
    if (evalOn && pids.length) {
      await evalPulledBatch(pids);
      await loadFilterPool();   // reflect the new solve scores
      await refreshBrowse();
    }
  },
};

// Enable/label the Pull button from the current batch config: it reflects how
// many eligible records the count/slider selection would touch.
function updatePullButton() {
  const btn = document.getElementById("dsPull");
  if (!btn || !pullSection.batch) return;
  pullSection.batch.refresh();   // re-sync count/slider against the filtered pool
  const cfg = pullSection.batch.getConfig();
  const rec = currentDatasetRecord();
  const n = selectBatchItems(pullSection.getEligible(), rec, cfg).length;
  btn.disabled = n === 0;
  btn.textContent = n ? `Pull ${n} selected →` : "Pull selected →";
}

// Poll one record's eval job to completion, driving the per-trial bar from the
// job's {trial, trials} progress. ~700ms cadence for a responsive 0→N sweep.
async function pollEvalWithTrials(pid, trialBar, trialLabel) {
  for (let i = 0; i < 1200; i++) {   // ~14 min ceiling
    await new Promise(r => setTimeout(r, 700));
    let data;
    try {
      data = await (await fetch(`/api/eval_status?problem_id=${encodeURIComponent(pid)}`)).json();
    } catch (e) { return { state: "error", error: "lost connection to the backend" }; }
    const p = data.progress;
    if (p && p.trials) {
      trialBar.style.width = (p.trial / p.trials) * 100 + "%";
      if (trialLabel) trialLabel.textContent = `Trials ${p.trial} / ${p.trials}`;
    }
    if (data.state && !["queued", "running"].includes(data.state)) {
      if (data.state === "done") trialBar.style.width = "100%";
      return data;
    }
  }
  return { state: "error", error: "evaluation timed out" };
}

// Eval phase after a pull (toggle on): score each pulled problem in turn, with an
// outer bar over problems and an inner bar sweeping the N sampling trials.
async function evalPulledBatch(pids) {
  const wrap = document.getElementById("pullEvalWrap");
  const probBar = document.getElementById("pullEvalProblemBar");
  const trialBar = document.getElementById("pullEvalTrialBar");
  const probLabel = document.getElementById("pullEvalProblemLabel");
  const trialLabel = document.getElementById("pullEvalTrialLabel");
  setStatus("pullEvalStatus", "Connecting to the eval service…", "");
  if (!(await ensureEvalReady())) {
    setStatus("pullEvalStatus",
      "Eval service unavailable: " + (EVAL_STATUS.reason || "unreachable") +
      " — problems were pulled but not scored.", "err");
    return;
  }
  if (wrap) wrap.classList.remove("hidden");
  const total = pids.length;
  let done = 0, failed = 0;
  for (const pid of pids) {
    if (probLabel) probLabel.textContent = `Problem ${done + 1} / ${total}`;
    if (probBar) probBar.style.width = (done / total) * 100 + "%";
    if (trialBar) trialBar.style.width = "0%";
    if (trialLabel) trialLabel.textContent = "Trials";
    setStatus("pullEvalStatus", `Evaluating ${done + 1} / ${total} on the GPU host…`, "");
    let enqueued = false;
    try {
      const data = await (await fetch("/api/eval_record", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_id: pid }),
      })).json();
      enqueued = !!data.ok;
    } catch (e) { /* fall through to failed */ }
    if (enqueued) {
      const res = await pollEvalWithTrials(pid, trialBar, trialLabel);
      if (res.state === "done" && res.evaluation) {
        const rec = FILTER_RECORDS.find(r => r.problem_id === pid);
        if (rec) rec.evaluation = res.evaluation;
      } else {
        failed++;
      }
    } else {
      failed++;
    }
    done++;
    if (probBar) probBar.style.width = (done / total) * 100 + "%";
  }
  if (trialBar) trialBar.style.width = "100%";
  setStatus("pullEvalStatus",
    `Evaluated ${total - failed} / ${total} problem(s)` + (failed ? `, ${failed} failed.` : "."),
    failed ? "err" : "ok");
  setTimeout(() => {
    if (wrap) wrap.classList.add("hidden");
    if (probBar) probBar.style.width = "0%";
    if (trialBar) trialBar.style.width = "0%";
  }, 900);
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
  renderGenDisplay();  // reflect the mode (original viewer hidden in LLM mode)
  mode.onEnter();
}

// Top-right Refresh for the Generate section: re-read pulled problems in Manual
// mode, or reconnect/refresh Ollama in LLM mode.
function refreshGenerateSection() {
  if (GEN_MODE === "llm") connectAndRefreshLLM();
  else populateBaseSelect();
}

// --------------------------------------------------------------------------
// LLM Generation mode: backend/GPU status checks + one-click generation.
// --------------------------------------------------------------------------
let LLM_STATUS = { checked: false, server: false, available: false,
                   reason: "Status not checked yet — open the LLM Generation panel.", data: null };
// Model selection is the only interactive pick (seeded from last session). The
// GPU column is informational — the shared host auto-schedules — so we just
// highlight the GPU it's most likely to use; that's derived at render time.
let SELECTED_MODEL = localStorage.getItem("llmModel"); // full model name or null

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
  seedModelSelection(data.ollama || {});
  // Probe the CoTSimilarity eval shim over the same tunnel and show its row.
  await connectEval();
  renderLLMStatus();
  updateLLMControls();
}

// Seed/repair the singleton selections after a status refresh: keep the user's
// pick if still present, else default to the saved pick or the first available.
function seedModelSelection(o) {
  const models = (o && o.model_info) || [];
  if (!models.some(m => m.full === SELECTED_MODEL)) {
    SELECTED_MODEL = models.length ? models[0].full : null;
  }
}

// The GPU the shared Ollama scheduler is most likely to place the model on:
// the most-free card, tie-broken to the lowest index (matches observed behavior).
function predictedGpuIndex(gpus) {
  if (!gpus.length) return null;
  return gpus.reduce((a, b) => (b.mem_free_mib > a.mem_free_mib ? b : a)).index;
}

function dotLine(state, label, detail) {
  return `<div class="status-line"><span class="dot ${state}"></span>` +
         `<b>${label}</b><span class="detail">${escapeHtml(detail || "")}</span></div>`;
}

const GIB = 1024; // MiB per GiB
function fmtGiB(mib) { return (mib / GIB).toFixed(1) + " GiB"; }

// qwen2.5:7b needs ~5 GiB; flag GPUs that lack comfortable headroom for it.
const FREE_OK_MIB = 8 * GIB;

// GPU column: a read-only readout led by free VRAM (the stat that matters on a
// shared box). The host auto-schedules, so this is NOT user-selectable — we just
// glow the card the scheduler is most likely to use and tag it "will be used".
function renderGpuColumn(gpus) {
  if (!gpus.length) return '<div class="hint">No GPU detected.</div>';
  const target = predictedGpuIndex(gpus);
  return gpus.map((x) => {
    const freeClass = x.mem_free_mib >= FREE_OK_MIB ? "ok" : "warn";
    const pctFree = Math.round((x.mem_free_mib / x.mem_total_mib) * 100);
    const isTarget = x.index === target;
    return `<div class="pick-card static${isTarget ? " selected" : ""}">
      <div class="gpu-idx">GPU ${x.index}</div>
      <div class="gpu-stats">
        <div class="gpu-free ${freeClass}">${fmtGiB(x.mem_free_mib)} free <span class="muted">(${pctFree}%)</span></div>
        <div class="gpu-frac muted">${fmtGiB(x.mem_used_mib)} / ${fmtGiB(x.mem_total_mib)} used</div>
        <div class="gpu-name muted">${escapeHtml(x.name)}</div>
      </div>
      ${isTarget ? '<div class="gpu-target">will be used</div>' : ""}
    </div>`;
  }).join("");
}

// Model column: one selectable card per installed model, showing name, version,
// and parameter size ("?" when the host couldn't report it).
function renderModelColumn(modelInfo) {
  if (!modelInfo.length) return '<div class="hint">No models installed.</div>';
  return modelInfo.map((m) => {
    const sel = m.full === SELECTED_MODEL ? " selected" : "";
    return `<div class="pick-card${sel}" data-model="${escapeHtml(m.full)}">
      <div class="model-name">${escapeHtml(m.name)}</div>
      <div class="model-meta muted">${escapeHtml(m.version)} · ${escapeHtml(m.parameter_size)} parameters</div>
    </div>`;
  }).join("");
}

function renderLLMStatus() {
  const rows = [];
  rows.push(dotLine(LLM_STATUS.server ? "ok" : "err", "Server",
    LLM_STATUS.server ? "Backend online" : "Backend offline"));
  const d = LLM_STATUS.data;
  if (d) {
    const o = d.ollama || {};
    rows.push(dotLine(o.reachable ? "ok" : "err", "LLM service",
      o.reachable ? `Ollama reachable at ${o.host}`
                  : (o.error || "Unreachable")));
    const g = d.gpu || {};
    rows.push(dotLine(g.detected ? "ok" : "warn", "GPU",
      g.detected ? `${g.gpus.length} GPU(s) on the Ollama host`
                 : (g.error || "No GPU detected")));
    // Two selectable columns (GPU left, models right) once Ollama is reachable.
    if (o.reachable) {
      rows.push(
        `<div class="llm-cols">
           <div class="llm-col">
             <div class="col-head">GPU — auto-selected (most free)</div>
             ${renderGpuColumn((g && g.gpus) || [])}
           </div>
           <div class="llm-col">
             <div class="col-head">Model — pick one to generate with</div>
             ${renderModelColumn(o.model_info || [])}
           </div>
         </div>`);
    }
  }
  // CoTSimilarity eval service row (probed alongside Ollama over the same tunnel).
  if (EVAL_STATUS.checked) {
    const st = EVAL_STATUS.reachable ? (EVAL_STATUS.ged_ready ? "ok" : "warn") : "err";
    const detail = EVAL_STATUS.reachable
      ? (`Eval shim reachable at ${EVAL_STATUS.host}` +
         (EVAL_STATUS.ged_ready ? "" : " — GED disabled (set DEEPSEEK_API_KEY on the remote)"))
      : (EVAL_STATUS.reason || "Unreachable");
    rows.push(dotLine(st, "CoT eval", detail));
  }
  document.getElementById("llmStatusBody").innerHTML = rows.join("");
}

// Enable the LLM Generation button only when every prerequisite holds; the
// banner always states either readiness or the first blocking reason.
function updateLLMControls() {
  let reason = "";
  if (!BACKEND) reason = "Backend not detected — start app.py to enable LLM generation.";
  else if (!LLM_STATUS.checked) reason = "Status not checked yet — click Refresh.";
  else if (!LLM_STATUS.available) reason = LLM_STATUS.reason;
  else if (!SELECTED_MODEL) reason = "Select a model from the column above.";
  else if (!currentBase()) reason = "No base problem selected — pull problems in the Pull section first.";
  document.getElementById("llmGenerateBtn").disabled = !!reason;
  const banner = document.getElementById("llmAvailability");
  banner.textContent = reason || "LLM generation is ready.";
  banner.className = "llm-banner " + (reason ? "err" : "ok");
}

// Generate section batch descriptor — LLM generation. Eligible = the Original
// base pool (RAW_RECORDS); the per-item action posts to /api/llm_generate and
// drops the record from the base pool once it leaves "Original" status. (Manual
// authoring stays single-only below — the same hand-written text can't sensibly
// be applied to many problems, so only the LLM action is batchable.)
const genSection = {
  status: "saveStatus",
  batch: null,
  getEligible: () => RAW_RECORDS,
  getCurrent: () => currentBase(),
  async runOne(rec, opts) {
    try {
      const res = await fetch("/api/llm_generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          problem_id: rec.problem_id,
          auto_verify: !!opts.autoVerify,
          model: SELECTED_MODEL || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error };
      // The record now carries perturbations and has left "Original" status, so
      // it drops out of the base pool (mirrors advanceAfterSave for one record).
      CONSUMED_PIDS.add(rec.problem_id);
      RAW_RECORDS = RAW_RECORDS.filter(r => r.problem_id !== rec.problem_id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  onProgress(i, total) {
    setStatus("saveStatus",
      total > 1 ? `Generating ${i} / ${total}…`
                : "Asking the LLM to generate simple + hard variants…", "");
    setBatchProgress(GEN_PROGRESS, i, total);
  },
  async afterBatch({ ok, fail }, opts) {
    finishBatchProgress(GEN_PROGRESS);
    if (BASE_IDX >= RAW_RECORDS.length) BASE_IDX = RAW_RECORDS.length - 1;
    updateBaseNav();  // re-renders the base preview for the new current record
    const dest = opts.autoVerify ? "Verified" : "Unverified";
    setStatus("saveStatus",
      `Generated ${ok} → ${dest}` + (fail ? `, ${fail} failed.` : ".") +
      ` ${RAW_RECORDS.length} problem(s) remaining.`, fail ? "err" : "ok");
    await refreshBrowse();
    updateLLMControls();
  },
};

async function llmGenerate() {
  if (!BACKEND) { setStatus("saveStatus", "Backend not detected — see the Pull section note.", "err"); return; }
  if (!currentBase()) { setStatus("saveStatus", "Select a base problem first (use Prev/Next).", "err"); return; }
  const autoVerify = document.getElementById("llmAutoVerify").checked;
  document.getElementById("llmGenerateBtn").disabled = true;
  await runBatch(genSection, { autoVerify, emptyMsg: "No base problems available to generate." });
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
  if (verifySection.batch) verifySection.batch.refresh();  // track the pending pool size
  renderCurrentPending();
}

function stepVerify(delta) {
  if (!PENDING_GROUPS.length) return;
  VERIFY_IDX = Math.min(PENDING_GROUPS.length - 1, Math.max(0, VERIFY_IDX + delta));
  updateVerifyNav();
}

function pendingVariantBlock(tag, obj, ev) {
  if (!obj) return "";
  return `
    <div class="variant ${tag}">
      <div class="variant-head">
        <span class="vtag ${tag}">${tag}</span>
        ${evalPairBadge(ev, tag)}
      </div>
      <div class="problem-text">${renderMathField(obj.problem || "")}</div>
      ${obj.answer ? `
        <div class="answer-wrap">
          <div class="answer-label">Answer</div>
          <div class="answer-text">${renderAnswerField(obj.answer)}</div>
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
  const solve = rec.evaluation && rec.evaluation.solvability;
  if (solve && solve.pass_rate != null) {
    tags.push({ text: `orig solve ${Math.round(solve.pass_rate * 100)}%`, kind: "eval" });
  }
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
// approved or rejected together by the shared Approve/Reject action row (static
// in index.html, alongside the batch control — mirroring the Pull/Generate
// sections); here we only toggle that row's enabled state.
function renderCurrentPending() {
  const list = document.getElementById("verifyList");
  const approve = document.getElementById("verifyApprove");
  const reject = document.getElementById("verifyReject");
  if (VERIFY_IDX < 0 || !PENDING_GROUPS.length) {
    list.innerHTML = '<div class="empty">Nothing awaiting verification.</div>';
    if (approve) approve.disabled = true;
    if (reject) reject.disabled = true;
    return;
  }
  const rec = PENDING_GROUPS[VERIFY_IDX];
  list.innerHTML = `
    <div class="card">
      <div class="pv-host" id="verifyDisplay"></div>
      <div class="variant-row" id="verifyVariants"></div>
    </div>`;
  renderProblemDisplay("verifyDisplay", pendingGroupToModel(rec));
  const variantsEl = list.querySelector("#verifyVariants");
  if (variantsEl) {
    variantsEl.innerHTML = pendingVariantBlock("simple", rec.simple, rec.evaluation)
                         + pendingVariantBlock("hard", rec.hard, rec.evaluation);
    typesetMath(variantsEl);
  }
  if (approve) approve.disabled = false;
  if (reject) reject.disabled = false;
}

// Verify section batch descriptor. Eligible = the pending pool (PENDING_GROUPS);
// the per-item action posts to /api/verify or /api/reject (chosen by the button
// pressed). The whole original/simple/hard bundle is decided together per record.
const verifySection = {
  status: "verifyStatus",
  batch: null,
  getEligible: () => PENDING_GROUPS,
  getCurrent: () => (VERIFY_IDX >= 0 && VERIFY_IDX < PENDING_GROUPS.length ? PENDING_GROUPS[VERIFY_IDX] : null),
  async runOne(rec, opts) {
    if (!rec || rec.problem_id == null) return { ok: false, error: "missing problem_id" };
    try {
      const res = await fetch("/api/" + opts.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_id: rec.problem_id, verify_author: opts.verifyAuthor || "" }),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error };
      const i = PENDING_GROUPS.indexOf(rec);
      if (i >= 0) PENDING_GROUPS.splice(i, 1);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  onProgress(i, total) {
    if (total > 1) setStatus("verifyStatus", `Processing ${i} / ${total}…`, "");
  },
  async afterBatch({ ok, fail }, opts) {
    // Stay on the same index (now the next pending problem); clamp to the new end.
    if (VERIFY_IDX >= PENDING_GROUPS.length) VERIFY_IDX = PENDING_GROUPS.length - 1;
    updateVerifyNav();
    const verb = opts.action === "verify" ? "Verified" : "Rejected";
    const tail = opts.action === "verify"
      ? "marked Verified in DSPR_dataset.json."
      : "rejected — base problem(s) returned to the Generate pool.";
    setStatus("verifyStatus",
      `${verb} ${ok} pair(s)` + (fail ? `, ${fail} failed.` : "") + ` — ${tail}`, fail ? "err" : "ok");
    // Approve adds Verified pairs to Browse; Reject restores Original bases —
    // both change the Browse data set.
    await refreshBrowse();
  },
};

// Approve or reject the batch selection (the button pressed picks the action;
// the batch control picks how many). Verifier name is required to approve.
async function runVerifyBatch(action) {
  const verifyAuthor = document.getElementById("verifyAuthor").value.trim();
  if (action === "verify" && !verifyAuthor) {
    setStatus("verifyStatus", "⚠ Verifier name is required before approving.", "err");
    return;
  }
  await runBatch(verifySection, {
    action, verifyAuthor,
    emptyMsg: action === "verify" ? "Nothing pending to approve." : "Nothing pending to reject.",
  });
}

// --------------------------------------------------------------------------
// CoTSimilarity sample evaluation. Two signals scored on the remote GPU host:
// solvability (does the math model solve it, pass-rate over N samples) at the
// Pull/base stage, and the full pair (solvability + reasoning-structure GED of
// simple/hard vs the original) at Verify. Runs are slow, so the backend queues
// them as background jobs and caches the result onto the record; here we enqueue
// then poll /api/eval_status, and surface the cached result as badges.
// --------------------------------------------------------------------------
let EVAL_STATUS = { checked: false, available: false, reachable: false,
                    ged_ready: false, reason: "", host: "", n: null };

// Open the shared SSH tunnel (if needed) and probe the eval shim. Idempotent.
async function connectEval() {
  try {
    const data = await (await fetch("/api/eval_connect", { method: "POST" })).json();
    if (data.configured === false) {
      EVAL_STATUS = { checked: true, available: false, reachable: false,
        ged_ready: false, reason: data.error || "Eval service not configured.",
        host: "", n: null };
    } else {
      const s = data.service || {};
      EVAL_STATUS = { checked: true, available: !!data.available, reachable: !!s.reachable,
        ged_ready: !!s.ged_ready, reason: data.reason || "", host: s.host || "", n: s.n };
    }
  } catch (e) {
    EVAL_STATUS = { checked: true, available: false, reachable: false,
      ged_ready: false, reason: "Backend server is offline.", host: "", n: null };
  }
}

async function ensureEvalReady() {
  if (EVAL_STATUS.available) return true;
  await connectEval();
  return EVAL_STATUS.available;
}

// Poll a record's eval job until it leaves the running/queued state (~15 min cap).
async function pollEvalUntilDone(pid) {
  for (let i = 0; i < 450; i++) {
    await new Promise(r => setTimeout(r, 2000));
    let data;
    try {
      data = await (await fetch(`/api/eval_status?problem_id=${encodeURIComponent(pid)}`)).json();
    } catch (e) { return { state: "error", error: "lost connection to the backend" }; }
    if (data.state && !["queued", "running"].includes(data.state)) return data;
  }
  return { state: "error", error: "evaluation timed out (still running on the server)" };
}

// Enqueue + poll one record's evaluation, reporting into statusId. onDone(evaluation)
// fires with the cached evaluation block when the job finishes successfully.
async function runRecordEval(pid, statusId, onDone) {
  if (!BACKEND) { setStatus(statusId, "Backend not detected — start the server first.", "err"); return; }
  if (pid == null) { setStatus(statusId, "This record has no problem_id to evaluate.", "err"); return; }
  setStatus(statusId, "Connecting to the eval service…", "");
  if (!(await ensureEvalReady())) {
    setStatus(statusId, "Eval service unavailable: " + (EVAL_STATUS.reason || "unreachable"), "err");
    return;
  }
  try {
    const data = await (await fetch("/api/eval_record", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ problem_id: pid }),
    })).json();
    if (!data.ok) { setStatus(statusId, "Error: " + data.error, "err"); return; }
  } catch (e) { setStatus(statusId, "Request failed: " + e.message, "err"); return; }
  setStatus(statusId, "Evaluating on the GPU host — this can take a few minutes…", "");
  const result = await pollEvalUntilDone(pid);
  if (result.state === "done" && result.evaluation) {
    const warns = (result.evaluation.warnings || []);
    setStatus(statusId, "Done." + (warns.length ? " " + warns.join(" ") : ""), warns.length ? "" : "ok");
    onDone(result.evaluation);
  } else if (result.state === "error") {
    setStatus(statusId, "Evaluation failed: " + (result.error || "unknown error"), "err");
  } else {
    setStatus(statusId, "Evaluation returned no result.", "err");
  }
}

// Colour a pass-rate badge: green ≥80%, amber ≥40%, else red.
function passRateKind(pct) { return pct >= 80 ? "ok" : (pct >= 40 ? "warn" : "err"); }

// Solvability badge HTML from an evaluation block (used on the base problem).
function evalSolveBadge(ev) {
  const s = ev && ev.solvability;
  if (!s || s.pass_rate == null) return "";
  const pct = Math.round(s.pass_rate * 100);
  return `<span class="badge eval ${passRateKind(pct)}" ` +
         `title="Model solved ${pct}% of ${s.n} sampled attempts">solve ${pct}%</span>`;
}

// Solve-% of a record's ORIGINAL problem, as an integer percent or null when
// unevaluated. Prefers the base-stage solvability pass-rate, falling back to the
// original's pass-rate from a full pair eval (a Verified record may carry only that).
function solvePct(rec) {
  const ev = rec && rec.evaluation;
  const pr = (ev && ev.solvability && ev.solvability.pass_rate != null)
    ? ev.solvability.pass_rate
    : (ev && ev.pair && ev.pair.original && ev.pair.original.pass_rate != null
        ? ev.pair.original.pass_rate : null);
  return pr == null ? null : Math.round(pr * 100);
}

// Solve-% tag descriptor ({text, kind}) for a record — "solve N%" (coloured by
// pass rate) or a muted "solve n/a" before evaluation. Shared by the Filter
// viewer and the Browse cards.
function solveTag(rec) {
  const pct = solvePct(rec);
  return pct == null
    ? { text: "solve n/a", kind: "eval na" }
    : { text: `solve ${pct}%`, kind: "eval " + passRateKind(pct) };
}

// Extra warning tag when the grader itself crashed on one or more trials —
// distinguishes "the shim's answer_check threw" from a genuine low score,
// which otherwise look identical (both render as a low/0% solve tag).
function graderErrorTag(rec) {
  const errs = rec && rec.evaluation && rec.evaluation.debug && rec.evaluation.debug.errors;
  if (!errs || !errs.length) return null;
  return { text: "grader error", kind: "grader-err", title: errs[0] };
}

// Per-variant pair badge (pass-rate + structural similarity) for simple/hard.
function evalPairBadge(ev, which) {
  const p = ev && ev.pair && ev.pair[which];
  if (!p) return "";
  const parts = [];
  if (p.pass_rate != null) parts.push(`solve ${Math.round(p.pass_rate * 100)}%`);
  if (p.similarity_normalized != null) parts.push(`sim ${Number(p.similarity_normalized).toFixed(2)}`);
  else if (p.ged != null) parts.push(`GED ${p.ged}`);
  if (!parts.length) return "";
  return `<span class="badge eval" title="CoTSimilarity: solvability + reasoning-structure similarity vs original">${escapeHtml(parts.join(" · "))}</span>`;
}

async function evalCurrentPending() {
  const rec = verifySection.getCurrent();
  if (!rec) { setStatus("verifyEvalStatus", "No pending problem selected.", "err"); return; }
  const btn = document.getElementById("verifyEvalBtn");
  if (btn) btn.disabled = true;
  await runRecordEval(rec.problem_id, "verifyEvalStatus", (ev) => {
    rec.evaluation = ev;        // cache on the in-memory pending record
    renderCurrentPending();     // re-render so the variant badges appear
  });
  if (btn) btn.disabled = false;
}

// --------------------------------------------------------------------------
// Filter section: the required pipeline stage between Pull and Generate. It
// works over the non-generated pool (Original / Kept / Rejected, from
// /api/filter_pool) — separate from Generate's Kept-only base pool. Evaluate
// solvability, narrow by solve-% threshold + Level/Subject facets, then "Apply
// filters" to commit: problems passing the filters are marked Kept (→ Generate),
// the rest Rejected. The threshold/facets are the whitelist; Apply is the gate.
// --------------------------------------------------------------------------
let FILTER_RECORDS = [];          // the filter pool (Original/Kept/Rejected)
let FILTER_FILTERED = [];         // working set (view over FILTER_RECORDS)
let FILTER_IDX = -1;              // pointer into FILTER_FILTERED
const FILTER_FACETS = {};         // facetKey -> Set(values)
let FILTER_THRESHOLD = 0;         // min solve %, 0 = off
let FILTER_SORT = "";             // "" | "level" | "type" | "solve_desc" | "solve_asc"

function currentFilterRecord() {
  if (FILTER_IDX < 0 || FILTER_IDX >= FILTER_FILTERED.length) return null;
  return FILTER_FILTERED[FILTER_IDX];
}

// Does a record pass the active facet scope? (Threshold applied separately.)
function filterMatchesScope(r) {
  for (const key of Object.keys(FILTER_FACETS)) {
    const want = FILTER_FACETS[key];
    if (want && want.size && !want.has(String(r[key] ?? "").trim())) return false;
  }
  return true;
}

// The whitelist: records passing the active facets, then the solve-% threshold
// (which hides — and on Apply rejects — not-yet-evaluated "n/a" problems), then
// the sort order.
function filteredOriginals() {
  const recs = FILTER_RECORDS.filter(r => {
    if (!filterMatchesScope(r)) return false;
    if (FILTER_THRESHOLD > 0) {
      const pct = solvePct(r);
      if (pct == null || pct < FILTER_THRESHOLD) return false;
    }
    return true;
  });
  if (FILTER_SORT === "level") {
    return [...recs].sort((a, b) =>
      String(a.level || "").localeCompare(String(b.level || ""), undefined, { numeric: true }));
  }
  if (FILTER_SORT === "type") {
    return [...recs].sort((a, b) => String(a.type || "").localeCompare(String(b.type || "")));
  }
  if (FILTER_SORT === "solve_desc" || FILTER_SORT === "solve_asc") {
    const dir = FILTER_SORT === "solve_desc" ? -1 : 1;
    return [...recs].sort((a, b) => {
      const pa = solvePct(a), pb = solvePct(b);
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1;   // n/a sinks to the bottom either direction
      if (pb == null) return -1;
      return dir * (pa - pb);
    });
  }
  return recs;
}

// Level (natural sort) + Subject(type) facet definitions from the filter pool.
function filterFacetDefs() {
  const levels = [...new Set(FILTER_RECORDS.map(r => (r.level || "").trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const subjects = [...new Set(FILTER_RECORDS.map(r => (r.type || "").trim()).filter(Boolean))].sort();
  return [{ key: "level", label: "Level", values: levels },
          { key: "type", label: "Subject", values: subjects }];
}

function toggleFilterFacet(key, value) {
  if (!FILTER_FACETS[key]) FILTER_FACETS[key] = new Set();
  const set = FILTER_FACETS[key];
  if (set.has(value)) set.delete(value); else set.add(value);
  if (!set.size) delete FILTER_FACETS[key];
  refreshFilterSection({ reset: true });
}

function clearFilterFilters() {
  for (const k of Object.keys(FILTER_FACETS)) delete FILTER_FACETS[k];
  FILTER_THRESHOLD = 0;
  FILTER_SORT = "";
  refreshFilterSection({ reset: true });   // rebuilds the panel from state
}

// Renders the filters rail: a Clear button + count, the min-solve-% slider, then
// the Level/Subject facet chips. All controls live here and are (re)wired on each
// rebuild; the threshold slider avoids rebuilding the panel on input so a drag
// isn't interrupted (it re-renders only the viewer via skipFacets).
function renderFilterFacets() {
  const panel = document.getElementById("filterFacets");
  if (!panel) return;
  const defs = filterFacetDefs().filter(f => f.values.length);
  const groups = defs.map(f => {
    const chips = f.values.map(v => {
      const active = FILTER_FACETS[f.key] && FILTER_FACETS[f.key].has(v);
      return `<button type="button" class="ds-chip${active ? " active" : ""}" ` +
             `data-facet="${escapeHtml(f.key)}" data-value="${escapeHtml(v)}">${escapeHtml(v)}</button>`;
    }).join("");
    const count = FILTER_FACETS[f.key] ? FILTER_FACETS[f.key].size : 0;
    return `<div class="ds-fgroup">
        <div class="ds-fhead">${escapeHtml(f.label)}${count ? ` <span class="ds-fcount">${count}</span>` : ""}</div>
        <div class="ds-chips">${chips}</div>
      </div>`;
  }).join("");
  panel.innerHTML = `
    <div class="ds-fhead-row">
      <span class="ds-fpanel-title">Filters</span>
      <button id="filterClear" type="button" class="ds-fclear">Clear</button>
    </div>
    <div class="ds-fcount-line"><span class="count" id="filterCount"></span></div>
    <div class="ds-fgroup">
      <div class="ds-fhead">Sort</div>
      <select id="filterSort" class="ds-sort" aria-label="Sort filter pool">
        <option value="">Sort: default</option>
        <option value="level">Sort: Level</option>
        <option value="type">Sort: Subject</option>
        <option value="solve_desc">Sort: Solve % (high&rarr;low)</option>
        <option value="solve_asc">Sort: Solve % (low&rarr;high)</option>
      </select>
    </div>
    <div class="ds-fgroup">
      <div class="ds-fhead">Min solve %</div>
      <span class="batch-slider-wrap">
        <input type="range" id="filterThreshold" class="batch-slider" min="0" max="100" step="5"
               value="${FILTER_THRESHOLD}" aria-label="Minimum solve percentage" />
        <span class="batch-pct-readout" id="filterThresholdReadout">${FILTER_THRESHOLD}%</span>
      </span>
    </div>
    ${groups || `<div class="hint">No pulled problems yet.</div>`}`;
  panel.querySelector("#filterClear").addEventListener("click", clearFilterFilters);
  const sortSel = panel.querySelector("#filterSort");
  sortSel.value = FILTER_SORT;
  sortSel.addEventListener("change", () => {
    FILTER_SORT = sortSel.value;
    refreshFilterSection({ reset: true, skipFacets: true });
  });
  const thr = panel.querySelector("#filterThreshold");
  const readout = panel.querySelector("#filterThresholdReadout");
  thr.addEventListener("input", () => {
    FILTER_THRESHOLD = Math.max(0, Math.min(100, parseInt(thr.value, 10) || 0));
    readout.textContent = FILTER_THRESHOLD + "%";
    refreshFilterSection({ reset: true, skipFacets: true });  // keep the slider element alive mid-drag
  });
  panel.querySelectorAll(".ds-chip").forEach(btn =>
    btn.addEventListener("click", () => toggleFilterFacet(btn.dataset.facet, btn.dataset.value)));
}

// Current disposition of a filter-pool record → a viewer tag.
function dispositionTag(rec) {
  const s = rec.status || "";
  if (s === "Filtered (kept)") return { text: "kept", kind: "kept" };
  if (s === "Filtered (rejected)") return { text: "rejected", kind: "rejected" };
  return { text: "unfiltered", kind: "aug" };
}

// Convert a filter-pool record into a ViewerModel carrying its disposition +
// solve-% tags.
function filterRecordToModel(rec) {
  const orig = rec.original || {};
  const tags = [];
  if (rec.type) tags.push({ text: rec.type, kind: "type" });
  if (rec.level) tags.push({ text: rec.level, kind: "level" });
  tags.push(dispositionTag(rec));
  tags.push(solveTag(rec));
  tags.push(graderErrorTag(rec));
  return {
    id: rec.id ?? rec.problem_id ?? "—",
    sourceAbbrev: sourceAbbrev(rec.source),
    tags,
    problem: orig.problem || rec.problem || "",
    answer: orig.solution ?? rec.solution ?? rec.answer ?? "",
    perturbations: null,
    debugSample: (rec.evaluation && rec.evaluation.debug && rec.evaluation.debug.sample_response) || null,
  };
}

function renderFilterCurrent() {
  const total = FILTER_RECORDS.length;
  const countEl = document.getElementById("filterCount");
  if (countEl) countEl.textContent = `${FILTER_FILTERED.length} / ${total} shown`;
  const rec = currentFilterRecord();
  updateNav({ prev: "filterPrev", next: "filterNext", indicator: "filterIndicator", jump: "filterJump" },
            FILTER_IDX, FILTER_FILTERED.length, rec ? (rec.problem_id ?? "") : "");
  const viewer = document.getElementById("filterViewer");
  if (viewer) {
    if (!rec) {
      viewer.innerHTML = total
        ? '<div class="empty">No problems match your filters.</div>'
        : '<div class="hint">Pull some problems first (with "Evaluate solvability" on to score them).</div>';
    } else {
      renderProblemDisplay(viewer, filterRecordToModel(rec));
    }
  }
}

// Recompute the working set + facets and re-render. opts.reset snaps to the first
// match (facet/search/threshold change); otherwise the current record is kept in
// view when it survives the filter (e.g. after evaluating it in place).
function refreshFilterSection(opts) {
  opts = opts || {};
  const keep = opts.reset ? null : currentFilterRecord();
  FILTER_FILTERED = BACKEND ? filteredOriginals() : [];
  if (keep) {
    const i = FILTER_FILTERED.indexOf(keep);
    FILTER_IDX = i >= 0 ? i
      : (FILTER_FILTERED.length ? Math.min(Math.max(FILTER_IDX, 0), FILTER_FILTERED.length - 1) : -1);
  } else {
    FILTER_IDX = FILTER_FILTERED.length ? 0 : -1;
  }
  if (!opts.skipFacets) renderFilterFacets();
  renderFilterCurrent();
}

function stepFilter(delta) {
  if (!FILTER_FILTERED.length) return;
  FILTER_IDX = Math.min(FILTER_FILTERED.length - 1, Math.max(0, FILTER_IDX + delta));
  renderFilterCurrent();
}

// Commit the current filter partition (the whitelist gate). Everything passing
// the active filters → Kept (→ Generate); every other pool record → Rejected.
async function applyFilter() {
  if (!BACKEND) { setStatus("filterApplyStatus", "Backend not detected.", "err"); return; }
  if (!FILTER_RECORDS.length) {
    setStatus("filterApplyStatus", "Nothing to filter — pull some problems first.", "err");
    return;
  }
  const keepSet = new Set(filteredOriginals().map(r => r.problem_id));
  const keep = [...keepSet];
  const reject = FILTER_RECORDS.filter(r => !keepSet.has(r.problem_id)).map(r => r.problem_id);
  // Warn specifically about un-evaluated problems that Apply would reject (a
  // threshold > 0 hides "solve n/a" rows, so they land in the reject set).
  const naRejected = FILTER_RECORDS.filter(
    r => !keepSet.has(r.problem_id) && solvePct(r) == null).length;
  const msg = `Apply filters?\n\n` +
    `• Keep (→ Generate): ${keep.length}\n` +
    `• Reject: ${reject.length}` +
    (naRejected ? `  (${naRejected} not yet evaluated)` : "") +
    `\n\nKept problems move to Generate; rejected ones are excluded (reversible by re-applying).`;
  if (!window.confirm(msg)) return;

  const btn = document.getElementById("filterApplyBtn");
  if (btn) btn.disabled = true;
  setStatus("filterApplyStatus", "Applying…", "");
  try {
    const data = await (await fetch("/api/apply_filter", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep, reject }),
    })).json();
    if (!data.ok) { setStatus("filterApplyStatus", "Error: " + (data.error || "apply failed"), "err"); return; }
    setStatus("filterApplyStatus",
      `Applied — ${data.kept} kept, ${data.rejected} rejected.`, "ok");
    await loadFilterPool();      // reflect new dispositions in the Filter pool
    await populateBaseSelect();  // Generate now sees the newly-kept problems
    await refreshBrowse();       // Browse = Kept + Verified
  } catch (e) {
    setStatus("filterApplyStatus", "Request failed: " + e.message, "err");
  } finally {
    if (btn) btn.disabled = false;
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
document.getElementById("verifyApprove").addEventListener("click", () => runVerifyBatch("verify"));
document.getElementById("verifyReject").addEventListener("click", () => runVerifyBatch("reject"));
document.getElementById("dsPrev").addEventListener("click", () => stepDataset(-1));
document.getElementById("dsNext").addEventListener("click", () => stepDataset(1));
document.getElementById("dsPull").addEventListener("click", () => {
  PULLED_PIDS = [];   // fresh batch — the eval phase consumes only this pull's ids
  runBatch(pullSection, { emptyMsg: "Nothing to pull — every matching problem is already pulled." });
});
// "Evaluate solvability" toggle in Pull — persist across reloads.
(() => {
  const t = document.getElementById("pullEval");
  if (!t) return;
  t.checked = localStorage.getItem("pullEval") === "1";
  t.addEventListener("change", () => localStorage.setItem("pullEval", t.checked ? "1" : "0"));
})();
document.getElementById("filterPrev").addEventListener("click", () => stepFilter(-1));
document.getElementById("filterNext").addEventListener("click", () => stepFilter(1));
document.getElementById("filterApplyBtn").addEventListener("click", applyFilter);
document.getElementById("filterRefresh").addEventListener("click", () => loadFilterPool());
// Build the shared batch controls for each section (hosts exist in index.html).
pullSection.batch = createBatchControl("pullBatch",
  { onChange: updatePullButton, getTotal: () => pullSection.getEligible().length });
genSection.batch = createBatchControl("genBatch",
  { getTotal: () => genSection.getEligible().length });
verifySection.batch = createBatchControl("verifyBatch",
  { getTotal: () => verifySection.getEligible().length });
wireJump("baseJump", "baseJumpGo", () => RAW_RECORDS.length,
  (i) => { BASE_IDX = i; updateBaseNav(); });
wireJump("verifyJump", "verifyJumpGo", () => PENDING_GROUPS.length,
  (i) => { VERIFY_IDX = i; updateVerifyNav(); });
wireJump("dsJump", "dsJumpGo", () => DS.filtered.length,
  (i) => { DS.idx = i; renderDatasetCurrent(); });
wireJump("filterJump", "filterJumpGo", () => FILTER_FILTERED.length,
  (i) => { FILTER_IDX = i; renderFilterCurrent(); });
document.getElementById("dsSearch").addEventListener("input", (e) => {
  DS.search = e.target.value;
  renderDatasetBrowser();
});
document.getElementById("dsReload").addEventListener("click", () => {
  if (DS.current) { delete DS.cache[DS.current]; selectDataset(DS.current); }
});
// (filter search removed; threshold slider + Clear are wired inside renderFilterFacets)
document.getElementById("savePerturbation").addEventListener("click", savePerturbation);
document.getElementById("verifyEvalBtn").addEventListener("click", evalCurrentPending);
document.getElementById("llmGenerateBtn").addEventListener("click", llmGenerate);
document.getElementById("generateRefresh").addEventListener("click", refreshGenerateSection);
// Model selection (delegated — cards are re-rendered). GPU cards are static.
document.getElementById("llmStatusBody").addEventListener("click", (e) => {
  const card = e.target.closest(".pick-card[data-model]");
  if (!card) return;
  SELECTED_MODEL = card.dataset.model;
  localStorage.setItem("llmModel", SELECTED_MODEL);
  document.getElementById("llmStatusBody")
    .querySelectorAll(".pick-card[data-model]").forEach(c => c.classList.toggle("selected", c === card));
  updateLLMControls();
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
  syncHeaderHeight();
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
