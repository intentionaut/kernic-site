const $ = (id) => document.getElementById(id);
const state = {
  name: "",
  vibeId: null,
  baseSeed: "#2563eb",
  accentSeed: null,
  accentExact: true,
  hue: 220,
  harmony: "analogous",
  tint: "match", // match | warm | cool | pure
  fonts: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
  radiusStyle: "soft",
  ratio: 1.25,
  darkDefault: false,
  mode: "light",
  chromaScale: null,
  lRange: null,
  meta: null,
  looks: [],
  activeLookId: null,
  ramps: null,
  gradients: null,
  /** Raw nested {light,dark} semantics — exactly what gets saved to JSON. */
  semanticRaw: null,
};

/** Flatten nested {light,dark} semantic maps for the active preview mode. */
function pickMode(sem, mode) {
  const out = {};
  if (!sem) return out;
  for (const k of ["background", "surface", "text", "mutedText", "border", "ring"]) {
    const v = sem[k];
    out[k] = typeof v === "string" ? v : v?.[mode];
  }
  return out;
}

function tintHue() {
  if (state.tint === "match") return state.hue;
  if (state.tint === "pure") return null;
  if (state.tint === "warm") return 60;
  return 230; // cool
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 1800);
}

function setStatus(msg, cls = "") {
  const s = $("status");
  s.textContent = msg;
  s.className = `status ${cls}`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/* ---------- palette + preview ---------- */

/** Monotonic request id — a slow /api/palette reply must never clobber a newer one. */
let paletteSeq = 0;
let palettePending = false;
let paletteInFlight = false;
let paletteLastRun = 0;
let palettePumpTimer = null;
const PALETTE_MIN_MS = 80;

/**
 * Coalescing entry point for continuous controls (the hue slider fires ~60×/s).
 * At most one request is in flight and at most one starts per PALETTE_MIN_MS,
 * and a trailing run always happens so the final slider position is the one shown.
 */
function schedulePaletteRefresh() {
  palettePending = true;
  pumpPalette();
}

function pumpPalette() {
  if (paletteInFlight || !palettePending) return;
  const wait = PALETTE_MIN_MS - (Date.now() - paletteLastRun);
  if (wait > 0) {
    clearTimeout(palettePumpTimer);
    palettePumpTimer = setTimeout(pumpPalette, wait);
    return;
  }
  palettePending = false;
  paletteInFlight = true;
  paletteLastRun = Date.now();
  refreshPalette()
    .catch((e) => setStatus(e.message, "err"))
    .finally(() => { paletteInFlight = false; pumpPalette(); });
}

async function refreshPalette() {
  $("hueVal").textContent = `${state.hue}°`;
  const seq = ++paletteSeq;
  const payload = { harmony: state.harmony, neutralTintHue: tintHue() };
  if (state.chromaScale != null) payload.chromaScale = state.chromaScale;
  if (state.lRange) payload.lRange = state.lRange;
  if (state.accentExact) {
    payload.primarySeed = state.baseSeed;
    payload.accentSeed = state.accentSeed ?? undefined;
  } else {
    payload.baseSeed = state.baseSeed;
    payload.targetHue = state.hue;
  }
  const result = await api("/api/palette", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (seq !== paletteSeq) return; // a newer request already answered — drop this one
  state.ramps = result.colors;
  state.semanticRaw = result.semantic;
  state.gradients = result.gradients;
  renderRamps();
  renderPreview();
}

/** Structural signature of the ramp set — when it is unchanged we repaint in place. */
let rampsSig = "";

function buildRampRows(entries) {
  const host = $("ramps");
  host.innerHTML = "";
  for (const [name, ramp] of entries) {
    const row = document.createElement("div");
    row.className = "ramp-row";
    const label = document.createElement("span");
    label.className = "ramp-name";
    label.textContent = name;
    row.appendChild(label);
    for (const stop of Object.keys(ramp)) {
      const sw = document.createElement("div");
      sw.className = "swatch";
      sw.textContent = stop;
      row.appendChild(sw);
    }
    host.appendChild(row);
  }
}

function renderRamps() {
  const host = $("ramps");
  const entries = Object.entries(state.ramps);
  const sig = entries.map(([n, r]) => `${n}:${Object.keys(r).join(",")}`).join("|");
  if (sig !== rampsSig) {
    buildRampRows(entries);
    rampsSig = sig;
  }
  entries.forEach(([, ramp], ri) => {
    const row = host.children[ri];
    Object.values(ramp).forEach((hex, si) => {
      const sw = row.children[si + 1]; // child 0 is the ramp name
      if (!sw || sw.dataset.hex === hex) return;
      sw.dataset.hex = hex;
      sw.style.background = hex;
      const lum = parseInt(hex.slice(1, 3), 16) * 0.2126 + parseInt(hex.slice(3, 5), 16) * 0.7152 + parseInt(hex.slice(5, 7), 16) * 0.0722;
      sw.style.color = lum > 150 ? "#000" : "#fff";
      sw.title = hex;
    });
  });
}

/* ---------- google fonts: safe names, safe URLs, deduplicated loading ---------- */

/**
 * Allowlist for family names. Everything that reaches a Google Fonts URL or a CSS
 * custom property passes through here, so quotes, semicolons, backslashes and
 * angle brackets can never get into either.
 */
const SAFE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function isSafeFamily(family) {
  return typeof family === "string" && SAFE_FAMILY.test(family.trim());
}

const FONT_FALLBACK = {
  heading: "ui-serif, Georgia, serif",
  body: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, monospace",
};

/** A font stack that is always safe to interpolate into CSS. */
function fontStack(family, fallback) {
  return isSafeFamily(family) ? `"${family.trim()}", ${fallback}` : fallback;
}

/** Generic face standing in for a catalog category until its webfont arrives. */
function categoryGeneric(category) {
  const c = String(category ?? "").toLowerCase().replace(/\s+/g, "-");
  if (c === "serif") return "serif";
  if (c === "monospace") return "ui-monospace, monospace";
  if (c === "handwriting") return "cursive";
  return "ui-sans-serif, sans-serif";
}

function fontCssUrl(family, extra) {
  const name = family.trim().split(/ +/).map(encodeURIComponent).join("+");
  return `https://fonts.googleapis.com/css2?family=${name}${extra}&display=swap`;
}

/** family -> <link>. Full weights, kept for the session. */
const loadedFaces = new Map();
/** family -> <link>. Name-only subset used to render dropdown rows in their own face. */
const previewFaces = new Map();

/** Idempotent: a family is only ever requested once, however many callers ask. */
function loadFontFace(family) {
  if (!isSafeFamily(family)) return;
  const name = family.trim();
  if (loadedFaces.has(name)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.font = name;
  link.href = fontCssUrl(name, ":wght@400;500;600;700");
  document.head.appendChild(link);
  loadedFaces.set(name, link);
  const subset = previewFaces.get(name); // the full face supersedes the subset
  if (subset) {
    subset.remove();
    previewFaces.delete(name);
  }
}

/**
 * Dropdown rows show their own typeface, but a webfont per row is the exact trap
 * that made init slow. These requests are subsetted to the family name's own
 * characters, only fire for rows actually on screen, and are dropped again as
 * soon as those rows go away.
 */
function loadPreviewFace(family) {
  if (!isSafeFamily(family)) return;
  const name = family.trim();
  if (loadedFaces.has(name) || previewFaces.has(name)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.fontPreview = name;
  link.href = fontCssUrl(name, `&text=${encodeURIComponent(name)}`);
  document.head.appendChild(link);
  previewFaces.set(name, link);
}

function releasePreviewFaces(keep) {
  for (const [name, link] of previewFaces) {
    if (keep.has(name)) continue;
    link.remove();
    previewFaces.delete(name);
  }
}

function scaleVars() {
  const names = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"];
  const exps = [-1, -0.5, 0, 1, 2, 3, 5, 7, 9];
  return names.map((n, i) => [`--text-${n}`, Math.pow(state.ratio, exps[i]).toFixed(3) + "rem"]);
}

/** One <style> element holds every preview token, so a repaint is a single write. */
let pvStyleEl = null;
let pvStyleText = "";

function previewStyle() {
  if (!pvStyleEl) {
    pvStyleEl = document.createElement("style");
    pvStyleEl.id = "pvVars";
    document.head.appendChild(pvStyleEl);
  }
  return pvStyleEl;
}

function renderPreview() {
  const pv = $("preview");
  pv.dataset.vibe = state.vibeId ?? "custom";
  const sem = pickMode(state.semanticRaw, state.mode);
  const inv = pickMode(state.semanticRaw, state.mode === "light" ? "dark" : "light");
  const r = state.meta.radii[state.radiusStyle];
  const decl = [];
  const set = (k, v) => {
    if (v == null) return;
    const s = String(v);
    if (s.includes("}") || s.includes("<")) return; // never let a value escape the rule
    decl.push(`${k}:${s}`);
  };

  for (const [rampName, ramp] of Object.entries(state.ramps))
    for (const [stop, hex] of Object.entries(ramp))
      set(`--color-${rampName}-${stop}`, hex);

  const grads = state.gradients ?? {};
  set("--gradient-primary", grads.primary ?? "none");
  set("--gradient-mesh", grads.mesh ?? "none");
  set("--gradient-text", grads.text ?? "none");

  set("--pv-background", sem.background);
  set("--pv-surface", sem.surface);
  set("--pv-text", sem.text);
  set("--pv-muted-text", sem.mutedText);
  set("--pv-border", sem.border);
  set("--semantic-ring", sem.ring);
  set("--pv-inverse-bg", inv.background);
  set("--pv-inverse-text", inv.text);
  set("--pv-inverse-muted", inv.mutedText);
  set("--font-heading", fontStack(state.fonts.heading, FONT_FALLBACK.heading));
  set("--font-body", fontStack(state.fonts.body, FONT_FALLBACK.body));
  set("--font-mono", fontStack(state.fonts.mono, FONT_FALLBACK.mono));
  set("--radius-sm", r.sm);
  set("--radius-md", r.md);
  set("--radius-lg", r.lg);
  for (const [k, v] of scaleVars()) set(k, v);

  const text = `#preview{${decl.join(";")}}`;
  if (text !== pvStyleText) {
    previewStyle().textContent = text;
    pvStyleText = text;
  }

  loadFontFace(state.fonts.heading);
  loadFontFace(state.fonts.body);
  loadFontFace(state.fonts.mono);

  document.querySelectorAll("#modeRow button").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === state.mode));
}

/* ---------- font search combobox ---------- */

const FONT_LIMIT = 24;
const FONT_DEBOUNCE_MS = 170;
const FACE_SETTLE_MS = 260;

/** lowercase family -> canonical family. Everything we have ever seen from the server. */
const knownFamilies = new Map();

function rememberFamily(family) {
  if (isSafeFamily(family)) knownFamilies.set(family.trim().toLowerCase(), family.trim());
}

async function searchFontsApi(q) {
  const body = await api(`/api/fonts?q=${encodeURIComponent(q)}&limit=${FONT_LIMIT}`);
  const results = (body.results ?? []).filter((f) => isSafeFamily(f?.family));
  for (const f of results) rememberFamily(f.family);
  return {
    results,
    // `total` is the pre-truncation match count; older servers omit it.
    total: typeof body.total === "number" ? body.total : results.length,
    live: body.live !== false,
  };
}

/** A searchable, keyboard-driven picker over the whole Google Fonts catalog. */
function createFontCombo(inputId, key) {
  const input = $(inputId);
  const pop = $(`${inputId}Pop`);
  const list = $(`${inputId}List`);
  const meta = $(`${inputId}Meta`);

  let seq = 0;          // monotonic — a late reply for an older query is discarded
  let timer = null;     // debounce handle
  let pending = null;   // the search currently running, awaited before validating
  let faceTimer = null;
  let results = [];
  let active = -1;
  let open = false;
  let committed = state.fonts[key];

  function setOpen(next) {
    open = next;
    pop.hidden = !next;
    input.setAttribute("aria-expanded", String(next));
    if (next) return;
    input.removeAttribute("aria-activedescendant");
    active = -1;
    clearTimeout(faceTimer);
    releasePreviewFaces(new Set());
  }

  function setActive(i) {
    const prev = list.children[active];
    if (prev) {
      prev.classList.remove("on");
      prev.setAttribute("aria-selected", "false");
    }
    active = i;
    const next = list.children[i];
    if (!next) return input.removeAttribute("aria-activedescendant");
    next.classList.add("on");
    next.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", next.id);
    next.scrollIntoView({ block: "nearest" });
  }

  function render(found, total, live) {
    results = found;
    list.innerHTML = "";
    found.forEach((f, i) => {
      const li = document.createElement("li");
      li.id = `${inputId}-opt-${i}`;
      li.className = "combo-opt";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.dataset.family = f.family;
      const fam = document.createElement("span");
      fam.className = "combo-fam";
      fam.textContent = f.family;
      fam.style.fontFamily = fontStack(f.family, categoryGeneric(f.category));
      const cat = document.createElement("span");
      cat.className = "combo-cat";
      cat.textContent = f.category ?? "";
      li.append(fam, cat);
      list.appendChild(li);
    });

    const notes = [];
    if (found.length === 0) notes.push("No matching Google Font");
    else if (total > found.length) notes.push(`showing ${found.length} of ${total} — keep typing`);
    if (!live) notes.push("offline — showing bundled fonts");
    meta.textContent = notes.join(" · ");
    meta.hidden = notes.length === 0;

    setActive(found.length ? 0 : -1);
    scheduleFaces();
  }

  function scheduleFaces() {
    clearTimeout(faceTimer);
    faceTimer = setTimeout(loadVisibleFaces, FACE_SETTLE_MS);
  }

  /** Only rows currently on screen get a typeface, and only once typing settles. */
  function loadVisibleFaces() {
    if (!open) return;
    const box = list.getBoundingClientRect();
    const keep = new Set();
    for (const li of list.children) {
      const r = li.getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom) keep.add(li.dataset.family);
    }
    releasePreviewFaces(keep);
    for (const family of keep) loadPreviewFace(family);
  }

  async function runSearch(q) {
    const id = ++seq;
    try {
      const { results: found, total, live } = await searchFontsApi(q);
      if (id !== seq) return; // superseded
      render(found, total, live);
    } catch {
      if (id !== seq) return;
      render([], 0, true);
      meta.textContent = "Font search unavailable";
      meta.hidden = false;
    }
  }

  function queueSearch(q) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pending = runSearch(q); }, FONT_DEBOUNCE_MS);
  }

  /** Run any debounced search now — a blur must not validate against stale results. */
  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      pending = runSearch(input.value.trim());
    }
    if (pending) await pending;
  }

  function commit(family) {
    const name = String(family ?? "").trim();
    if (!isSafeFamily(name)) return revert(`“${name}” isn't a usable font name.`);
    committed = name;
    rememberFamily(name);
    input.value = name;
    state.fonts[key] = name;
    loadFontFace(name);
    setOpen(false);
    renderPreview();
  }

  function revert(msg) {
    input.value = committed;
    setOpen(false);
    if (!msg) return;
    setStatus(msg, "err");
    toast(msg);
  }

  /** Never apply a family that isn't in the catalog — it would 404 into serif. */
  async function validate() {
    const typed = input.value.trim();
    if (!typed || typed === committed) return revert(null);
    await flush();
    const canonical = knownFamilies.get(typed.toLowerCase());
    if (canonical) commit(canonical);
    else revert(`No Google Font called “${typed}” — kept ${committed}.`);
  }

  input.addEventListener("focus", () => {
    setOpen(true);
    input.select();
    pending = runSearch(input.value.trim());
    pop.scrollIntoView({ block: "nearest" });
  });

  input.addEventListener("input", () => {
    if (!open) setOpen(true);
    queueSearch(input.value.trim());
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        pending = runSearch(input.value.trim());
        return;
      }
      if (!results.length) return;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      setActive((active + dir + results.length) % results.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (open && results[active]) commit(results[active].family);
      else validate();
      return;
    }
    if (e.key === "Escape") {
      if (open) e.stopPropagation();
      input.value = committed;
      setOpen(false);
      return;
    }
    if (e.key === "Tab" && open && results[active] && input.value.trim() !== committed) {
      commit(results[active].family);
    }
  });

  input.addEventListener("blur", () => {
    if (open || input.value.trim() !== committed) validate();
  });

  // keep focus on the input so blur-validation never races a row click
  list.addEventListener("mousedown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = e.target.closest(".combo-opt");
    if (li) commit(li.dataset.family);
  });
  list.addEventListener("scroll", scheduleFaces, { passive: true });

  return {
    /** Adopt a value chosen elsewhere (a look, a loaded system) as the valid one. */
    setValue(family) {
      const name = String(family ?? "").trim();
      committed = name;
      input.value = name;
      rememberFamily(name);
    },
  };
}

const fontCombos = {};

/* ---------- controls ---------- */

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ---------- shuffle history (in-memory, session-only, never persisted) ---------- */
const HIST_MAX = 8;
let shuffleHistory = []; // {id, label, snap}
let activeHistId = null;

function snapshotState(label, id) {
  return {
    id,
    label,
    vibeId: state.vibeId,
    baseSeed: state.baseSeed,
    accentSeed: state.accentSeed,
    accentExact: false,
    hue: state.hue,
    harmony: state.harmony,
    tint: state.tint,
    fonts: { ...state.fonts },
    radiusStyle: state.radiusStyle,
    ratio: state.ratio,
    darkDefault: state.darkDefault,
    mode: state.mode,
    chromaScale: state.chromaScale,
    lRange: state.lRange,
    ramps: state.ramps,
    semanticRaw: state.semanticRaw,
    gradients: state.gradients,
  };
}

function restoreSnapshot(snap) {
  Object.assign(state, snap, { fonts: { ...snap.fonts } });
  activeHistId = snap.id;
  syncControls();
  renderRamps();
  renderPreview();
  renderVibes();
  renderLooks();
  markActiveLook();
  renderHistory();
}

function renderHistory() {
  const host = $("historyStrip");
  host.innerHTML = "";
  $("historySection").style.display = shuffleHistory.length ? "" : "none";
  for (const h of shuffleHistory) {
    const chip = document.createElement("button");
    chip.className = "hist-chip" + (h.id === activeHistId ? " on" : "");
    chip.title = h.label;
    const r = h.snap.ramps;
    for (const hex of [r.primary["400"], r.primary["600"], r.accent["500"], r.neutral["300"]]) {
      const i = document.createElement("i");
      i.style.background = hex;
      chip.appendChild(i);
    }
    chip.onclick = () => restoreSnapshot(h.snap);
    host.appendChild(chip);
  }
}

function markActiveLook() {
  document.querySelectorAll(".look-card").forEach((c) =>
    c.classList.toggle("on", c.dataset.look === state.activeLookId));
}

/** One-click identity: a look applies everything — seeds, fonts, radius, scale, mode. */
function applyLook(look) {
  state.activeLookId = look.id;
  state.vibeId = look.vibeId;
  state.baseSeed = look.primarySeed;
  state.accentSeed = look.accentSeed;
  state.accentExact = true;
  state.hue = Math.round(hexToHue(look.primarySeed));
  const t = look.neutralTintHue;
  state.tint = t == null ? "pure" : t === 60 ? "warm" : t === 230 ? "cool" : "match";
  state.darkDefault = !!look.darkDefault;
  state.mode = look.darkDefault ? "dark" : "light";
  state.chromaScale = look.chromaScale ?? null;
  state.lRange = look.lRange ?? null;
  state.fonts = { ...look.fonts };
  state.radiusStyle = look.radius;
  state.ratio = look.ratio;
  if (!state.name.trim()) state.name = slugify(look.label);
  syncControls();
  refreshPalette();
  markActiveLook();
  renderVibes();
  renderLooks();
}

function renderLooks() {
  const host = $("looksGrid");
  host.innerHTML = "";
  const themed = state.looks.filter((l) => l.vibeId === state.vibeId);
  const vibe = state.meta?.vibes.find((v) => v.id === state.vibeId);
  $("looksLabel").textContent = vibe ? `${vibe.label} looks` : "Looks";
  if (themed.length === 0) {
    $("looksSection").style.display = "none";
    return;
  }
  $("looksSection").style.display = "";
  for (const look of themed) {
    const card = document.createElement("div");
    card.className = "look-card" + (state.activeLookId === look.id ? " on" : "");
    card.dataset.look = look.id;

    const sem = look.semantic, c = look.colors;
    const frame = document.createElement("div");
    frame.className = "lc-frame";
    frame.style.background = sem.background;
    frame.style.color = sem.text;
    frame.innerHTML =
      `<div class="lc-head">Design, done</div>` +
      `<div class="lc-lines"><i></i><i></i></div>` +
      `<div class="lc-row"><span class="lc-btn" style="--lc-btn:${c.primary["600"]}">Get started</span>` +
      `<span class="lc-chip" style="color:${c.accent["500"]}">${look.label.split(" ")[0]}</span></div>`;

    const strip = document.createElement("div");
    strip.className = "lc-strip";
    for (const hex of [c.primary["200"], c.primary["400"], c.primary["600"], c.accent["500"], c.neutral["800"]]) {
      const i = document.createElement("i");
      i.style.background = hex;
      strip.appendChild(i);
    }

    const name = document.createElement("div");
    name.className = "lc-name";
    name.textContent = look.label + (look.darkDefault ? "  ☾" : "");

    frame.querySelector(".lc-head").style.fontFamily = fontStack(look.fonts.heading, "serif");

    card.append(frame, strip, name);
    card.onclick = () => applyLook(look);
    host.appendChild(card);

    observeLookFont(card, look.fonts.heading);
  }
}

/**
 * Look cards used to request a webfont each, on every render — dozens of parallel
 * Google Fonts requests on load and on every theme switch. Now a card's face is
 * fetched only once it is actually scrolled into view, and only once per family.
 */
let lookFontObserver = null;

function observeLookFont(card, family) {
  if (!isSafeFamily(family) || loadedFaces.has(family.trim())) return;
  if (!("IntersectionObserver" in window)) return loadFontFace(family);
  if (!lookFontObserver) {
    lookFontObserver = new IntersectionObserver(
      (entries, obs) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          loadFontFace(e.target.dataset.font);
          obs.unobserve(e.target);
        }
      },
      { rootMargin: "150px" }
    );
  }
  card.dataset.font = family.trim();
  lookFontObserver.observe(card);
}

function renderVibes() {
  const host = $("vibes");
  host.innerHTML = "";
  for (const v of state.meta.vibes) {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.vibeId === v.id ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.background = v.primarySeed;
    chip.append(dot, document.createTextNode(v.label));
    chip.title = v.description;
    chip.onclick = () => applyVibe(v);
    host.appendChild(chip);
  }
}

/** Picking a theme auto-applies its recommended look — opinionated by design. */
function applyVibe(v) {
  const recommended = state.looks.find((l) => l.vibeId === v.id);
  if (recommended) {
    applyLook(recommended);
    return;
  }
  state.vibeId = v.id;
  state.activeLookId = null;
  markActiveLook();
  state.baseSeed = v.primarySeed;
  state.accentSeed = v.accentSeed;
  state.accentExact = true;
  state.hue = Math.round(hexToHue(v.primarySeed));
  state.darkDefault = v.darkModeDefault;
  state.mode = v.darkModeDefault ? "dark" : "light";
  state.chromaScale = v.chromaScale ?? null;
  state.lRange = v.lRange ?? null;
  state.fonts = { ...v.fonts };
  state.radiusStyle = v.radius;
  state.ratio = v.typeRatio;
  syncControls();
  refreshPalette().then(renderVibes);
}

// approximate hue from hex via HSL (client-side display only)
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255,
    g = parseInt(hex.slice(3, 5), 16) / 255,
    b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 220;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function renderRadiusRow() {
  const host = $("radiusRow");
  host.innerHTML = "";
  for (const key of Object.keys(state.meta.radii)) {
    const b = document.createElement("button");
    b.textContent = key[0].toUpperCase() + key.slice(1);
    b.classList.toggle("on", state.radiusStyle === key);
    b.onclick = () => { state.radiusStyle = key; renderRadiusRow(); renderPreview(); };
    host.appendChild(b);
  }
}

function syncControls() {
  $("sysname").value = state.name;
  $("hue").value = state.hue;
  $("harmony").value = state.harmony;
  fontCombos.heading.setValue(state.fonts.heading);
  fontCombos.body.setValue(state.fonts.body);
  fontCombos.mono.setValue(state.fonts.mono);
  $("ratio").value = String(state.ratio);
  document.querySelectorAll("#tintRow button").forEach((b) =>
    b.classList.toggle("on", b.dataset.tint === state.tint));
  renderRadiusRow();
}

function buildSystemPayload() {
  return {
    schemaVersion: 1,
    name: state.name,
    vibe: state.vibeId ?? "custom",
    colors: state.ramps,
    semantic: state.semanticRaw,
    gradients: state.gradients ?? undefined,
    fonts: state.fonts,
    radius: { style: state.radiusStyle, ...state.meta.radii[state.radiusStyle] },
    typeScale: { ratio: Number(state.ratio), baseRem: 1 },
    extensions: {
      seeds: {
        baseSeed: state.baseSeed,
        accentSeed: state.accentSeed,
        targetHue: state.hue,
        harmony: state.harmony,
        neutralTintHue: tintHue(),
        darkDefault: state.darkDefault,
        ...(state.chromaScale != null ? { chromaScale: state.chromaScale } : {}),
        ...(state.lRange ? { lRange: state.lRange } : {}),
      },
    },
  };
}

async function save() {
  state.name = $("sysname").value.trim();
  if (!state.name) state.name = "your system";
  try {
    const { name } = await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSystemPayload()),
    });
    state.name = name;
    setStatus(`Keep "${name}": npm install -g kernic`, "ok");
    toast("npm install -g kernic");
  } catch (e) {
    setStatus(e.message, "err");
  }
}

/* ---------- init ---------- */

async function init() {
  state.meta = await api("/api/meta");

  try {
    const { looks } = await api("/api/looks");
    state.looks = looks;
    renderLooks();
  } catch {}

  const ratioSel = $("ratio");
  for (const r of state.meta.ratios) {
    const o = document.createElement("option");
    o.value = String(r);
    o.textContent = `${r} ${ratioLabel(r)}`;
    ratioSel.appendChild(o);
  }

  // warm the server-side catalog so the first font search is instant
  searchFontsApi("").catch(() => {});

  const params = new URLSearchParams(location.search);
  const loadName = params.get("load");
  if (loadName) {
    try {
      const { system, seeds } = await api(`/api/load/${encodeURIComponent(loadName)}`);
      state.name = system.name;
      state.vibeId = system.vibe;
      state.fonts = system.fonts;
      state.radiusStyle = system.radius.style;
      state.ratio = system.typeScale.ratio;
      state.baseSeed = seeds.baseSeed || seeds.primarySeed || system.colors.primary["500"];
      state.accentSeed = seeds.accentSeed || system.colors.accent["500"];
      state.accentExact = true;
      state.hue = seeds.targetHue ?? Math.round(hexToHue(state.baseSeed));
      state.harmony = seeds.harmony ?? "analogous";
      state.darkDefault = !!seeds.darkDefault;
      state.mode = state.darkDefault ? "dark" : "light";
      const t = seeds.neutralTintHue;
      state.tint = t === undefined || t === null ? "pure" : t === 60 ? "warm" : t === 230 ? "cool" : "match";
      state.chromaScale = seeds.chromaScale ?? null;
      state.lRange = seeds.lRange ?? null;
      state.ramps = system.colors;
      state.semanticRaw = system.semantic;
      state.gradients = system.gradients ?? null;
      renderRamps();
      renderPreview();
      syncControls();
      renderVibes();
      setStatus(`Editing "${system.name}"`, "");
      return;
    } catch (e) {
      setStatus(e.message, "err");
    }
  }

  // fresh session → open on an opinionated default look
  const defaultLook = state.looks.find((l) => l.id === "boardroom") ?? state.looks[0];
  if (defaultLook) applyLook(defaultLook);
  else {
    const vibe = state.meta.vibes.find((v) => v.id === "corporate-clean") ?? state.meta.vibes[0];
    applyVibe(vibe);
  }
  renderVibes();
}

function ratioLabel(r) {
  return { 1.125: "(major second)", 1.2: "(minor third)", 1.25: "(major third)", 1.333: "(perfect fourth)", 1.414: "(augmented fourth)", 1.618: "(golden)" }[r] ?? "";
}

/* events */
for (const [id, key] of [["fHeading", "heading"], ["fBody", "body"], ["fMono", "mono"]])
  fontCombos[key] = createFontCombo(id, key);

$("ramps").addEventListener("click", (e) => {
  const hex = e.target.closest(".swatch")?.dataset.hex;
  if (!hex) return;
  navigator.clipboard?.writeText(hex);
  toast(`${hex} copied`);
});

$("hue").addEventListener("input", (e) => {
  state.hue = Number(e.target.value);
  $("hueVal").textContent = `${state.hue}°`; // readout stays instant; the fetch coalesces
  state.accentExact = false; // slider takes over — rotate hue, keep vibe's L/C character
  schedulePaletteRefresh();
});
$("harmony").addEventListener("change", (e) => {
  state.harmony = e.target.value;
  state.accentExact = false;
  refreshPalette();
});
$("ratio").addEventListener("change", (e) => { state.ratio = Number(e.target.value); renderPreview(); });
$("randomize").onclick = async () => {
  const { seed } = await api("/api/random");
  state.baseSeed = seed;
  state.hue = Math.round(hexToHue(seed));
  state.accentExact = false;
  syncControls();
  refreshPalette();
};
$("rerollAccent").onclick = () => {
  const shifts = ["analogous", "complementary", "triadic"];
  state.harmony = shifts[Math.floor(Math.random() * shifts.length)];
  state.accentExact = false;
  syncControls();
  refreshPalette();
};
$("shuffle").onclick = async () => {
  const { seed } = await api("/api/random");
  const v = state.meta.vibes[Math.floor(Math.random() * state.meta.vibes.length)];
  const harmonies = ["analogous", "complementary", "triadic"];
  state.activeLookId = null;
  markActiveLook();
  state.vibeId = v.id;
  state.baseSeed = seed;
  state.accentSeed = null;
  state.accentExact = false;
  state.harmony = harmonies[Math.floor(Math.random() * harmonies.length)];
  state.hue = Math.round(hexToHue(seed));
  state.tint = ["match", "warm", "cool", "pure"][Math.floor(Math.random() * 4)];
  state.chromaScale = null;
  state.lRange = null;
  state.darkDefault = Math.random() < 0.35;
  state.mode = state.darkDefault ? "dark" : "light";
  state.fonts = { ...v.fonts };
  state.radiusStyle = v.radius;
  state.ratio = v.typeRatio;
  syncControls();
  await refreshPalette();
  renderLooks();

  // record this result in the session history (last 8, oldest drops off)
  const entry = {
    id: Date.now(),
    label: `${v.label} · hue ${state.hue}° · ${state.mode}`,
    snap: null,
  };
  entry.snap = snapshotState(entry.label, entry.id);
  shuffleHistory.push(entry);
  while (shuffleHistory.length > HIST_MAX) shuffleHistory.shift();
  activeHistId = entry.id;
  renderHistory();
};
document.querySelectorAll("#tintRow button").forEach((b) => {
  b.onclick = () => { state.tint = b.dataset.tint; syncControls(); refreshPalette(); };
});
document.querySelectorAll("#modeRow button").forEach((b) => {
  b.onclick = () => { state.mode = b.dataset.mode; renderPreview(); };
});
$("save").onclick = save;

init();
