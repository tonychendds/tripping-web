export const PRODUCTION_SYNC_URL = "https://tripping-sync.tonychendds.workers.dev";
export const MANUAL_KEY = "tripping-manual-v1";
export const SESSION_KEY = "tripping-account";
export const REVISION_KEY = "tripping-book-revision";
export const META_KEY = "tripping-sync-meta";
export const ORIGIN_KEY = "tripping-deal-origin";
export const DEFAULT_ORIGIN = "SMF";
export const ORIGIN_PRESETS = ["SMF", "SFO"];

const PRICE_HINT =
  "On the Google Flights page, turn on Track prices (the bell or the Track prices switch). Google emails you when the fare changes. Tripping only opens the search. It does not call a paid fare API.";

export function syncBaseUrl() {
  if (typeof localStorage !== "undefined") {
    const override = localStorage.getItem("tripping-sync-url");
    if (override && /^https?:\/\//.test(override)) return override.replace(/\/$/, "");
  }
  if (typeof location !== "undefined") {
    const host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return "http://127.0.0.1:8787";
  }
  return PRODUCTION_SYNC_URL;
}

export function emptyManual() {
  return { version: 1, added: [], overrides: {}, hidden: [] };
}

export function emptyMeta(owner = null) {
  return { owner, tombstones: {}, updatedAt: {}, serialized: {} };
}

export function normalizeManual(value) {
  const manual = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const added = Array.isArray(manual.added) ? manual.added.filter((trip) => trip && typeof trip.id === "string" && trip.id) : [];
  const overrides = {};
  if (manual.overrides && typeof manual.overrides === "object" && !Array.isArray(manual.overrides)) {
    for (const [id, trip] of Object.entries(manual.overrides)) {
      if (id && trip && typeof trip === "object") overrides[id] = trip;
    }
  }
  const hidden = Array.isArray(manual.hidden) ? manual.hidden.filter((id) => typeof id === "string" && id) : [];
  return { version: 1, added, overrides, hidden };
}

export function listTrips(manual) {
  const normalized = normalizeManual(manual);
  const hidden = new Set(normalized.hidden);
  const byId = new Map();
  for (const trip of normalized.added) {
    if (!hidden.has(trip.id)) byId.set(trip.id, trip);
  }
  for (const [id, trip] of Object.entries(normalized.overrides)) {
    if (!hidden.has(id) && !byId.has(id)) byId.set(id, trip);
  }
  return [...byId.values()];
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stampMap(value) {
  const stamps = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return stamps;
  for (const [id, when] of Object.entries(value)) {
    if (typeof id === "string" && id && typeof when === "number" && Number.isFinite(when)) stamps[id] = when;
  }
  return stamps;
}

export function mergeStamps(left, right) {
  const merged = { ...stampMap(left) };
  for (const [id, when] of Object.entries(stampMap(right))) {
    if (merged[id] == null || when > merged[id]) merged[id] = when;
  }
  return merged;
}

export function observeManual(manual, meta, now) {
  const normalized = normalizeManual(manual);
  const next = {
    owner: meta?.owner ?? null,
    tombstones: stampMap(meta?.tombstones),
    updatedAt: stampMap(meta?.updatedAt),
    serialized: meta?.serialized && typeof meta.serialized === "object" ? { ...meta.serialized } : {},
  };
  const seen = new Set();
  for (const trip of [...normalized.added, ...Object.values(normalized.overrides)]) {
    if (!trip?.id) continue;
    seen.add(trip.id);
    const serialized = stableStringify(trip);
    if (next.serialized[trip.id] !== serialized) {
      next.updatedAt[trip.id] = now;
      next.serialized[trip.id] = serialized;
    }
  }
  for (const id of Object.keys(next.serialized)) {
    if (seen.has(id)) continue;
    if (next.tombstones[id] == null) next.tombstones[id] = now;
    delete next.serialized[id];
  }
  return { manual: normalized, meta: next };
}

export function bookFrom(manual, meta) {
  return {
    version: 1,
    manual: normalizeManual(manual),
    tombstones: stampMap(meta?.tombstones),
    updatedAt: stampMap(meta?.updatedAt),
  };
}

export function isVacant(book) {
  if (!book) return true;
  const manual = normalizeManual(book.manual);
  return manual.added.length === 0 && Object.keys(manual.overrides).length === 0 && Object.keys(stampMap(book.tombstones)).length === 0;
}

export function sameBook(left, right) {
  return stableStringify(compareShape(left)) === stableStringify(compareShape(right));
}

function compareShape(book) {
  const manual = normalizeManual(book?.manual);
  return {
    added: [...manual.added].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    overrides: manual.overrides,
    hidden: [...manual.hidden].sort(),
    tombstones: stampMap(book?.tombstones),
  };
}

export function mergeBooks(local, remote) {
  const left = local?.manual ? local : bookFrom(emptyManual(), emptyMeta());
  const right = remote?.manual ? remote : bookFrom(emptyManual(), emptyMeta());
  const tombstones = mergeStamps(left.tombstones, right.tombstones);
  const updatedAt = mergeStamps(left.updatedAt, right.updatedAt);
  const localManual = normalizeManual(left.manual);
  const remoteManual = normalizeManual(right.manual);
  const localAdded = new Set(localManual.added.map((trip) => trip.id));
  const remoteAdded = new Set(remoteManual.added.map((trip) => trip.id));
  const trips = new Map();
  for (const trip of [...localManual.added, ...Object.values(localManual.overrides)]) trips.set(trip.id, { trip, side: "local" });
  for (const trip of [...remoteManual.added, ...Object.values(remoteManual.overrides)]) {
    const existing = trips.get(trip.id);
    if (!existing) trips.set(trip.id, { trip, side: "remote" });
    else {
      const localAt = left.updatedAt?.[trip.id] ?? 0;
      const remoteAt = right.updatedAt?.[trip.id] ?? 0;
      if (remoteAt > localAt) trips.set(trip.id, { trip, side: "remote" });
    }
  }
  const added = [];
  const overrides = {};
  for (const [id, entry] of trips) {
    const at = updatedAt[id] ?? 0;
    if (tombstones[id] != null && tombstones[id] >= at) continue;
    const inAdded = localAdded.has(id) || remoteAdded.has(id);
    if (inAdded) added.push(entry.trip);
    else overrides[id] = entry.trip;
  }
  const hidden = [...new Set([...localManual.hidden, ...remoteManual.hidden])].filter((id) => {
    const at = updatedAt[id] ?? 0;
    return !(tombstones[id] != null && tombstones[id] >= at && !added.some((trip) => trip.id === id));
  });
  return { version: 1, manual: { version: 1, added, overrides, hidden }, tombstones, updatedAt };
}

export function planSync(local, remote) {
  const revision = remote && typeof remote.revision === "number" ? remote.revision : 0;
  const remoteBook = remote?.book ?? null;
  if (!remoteBook || revision === 0) {
    if (isVacant(local)) return { action: "noop", book: local, baseRevision: 0, upload: false, apply: false };
    return { action: "upload", book: local, baseRevision: 0, upload: true, apply: false };
  }
  if (isVacant(local)) {
    return { action: "apply", book: remoteBook, baseRevision: revision, upload: false, apply: !sameBook(local, remoteBook) };
  }
  const merged = mergeBooks(local, remoteBook);
  const upload = !sameBook(merged, remoteBook);
  const apply = !sameBook(merged, local);
  if (!upload && !apply) return { action: "noop", book: local, baseRevision: revision, upload: false, apply: false };
  return { action: "sync", book: merged, baseRevision: revision, upload, apply };
}

function placeToken(value) {
  const trimmed = String(value || "").trim();
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return trimmed.replace(/\s+/g, "");
}

function compactDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.replaceAll("-", "") : "";
}

export function googleFlightsUrl({ from, to, depart, ret }) {
  const origin = placeToken(from || DEFAULT_ORIGIN);
  const destination = String(to || "").trim();
  let query;
  if (!destination) query = depart ? `Flights from ${origin} on ${depart}` : `Flights from ${origin}`;
  else if (depart && ret) query = `Flights from ${origin} to ${destination} on ${depart} through ${ret}`;
  else if (depart) query = `One way flights from ${origin} to ${destination} on ${depart}`;
  else query = `Flights from ${origin} to ${destination}`;
  return `https://www.google.com/travel/flights?hl=en&curr=USD&q=${encodeURIComponent(query)}`;
}

export function kayakExploreUrl({ from, depart, ret }) {
  const origin = placeToken(from || DEFAULT_ORIGIN);
  let path = `${origin}-anywhere`;
  if (depart && ret) path += `/${depart}/${ret}`;
  else if (depart) path += `/${depart}`;
  return `https://www.kayak.com/explore/${path}`;
}

export function kayakFlightsUrl({ from, to, depart, ret }) {
  const destination = String(to || "").trim();
  if (!destination) return kayakExploreUrl({ from, depart, ret });
  const params = new URLSearchParams();
  params.set("origin", placeToken(from || DEFAULT_ORIGIN));
  params.set("destination", /^[A-Za-z]{3}$/.test(destination) ? destination.toUpperCase() : destination);
  if (depart) params.set("depart_date", depart);
  if (depart && ret) params.set("return_date", ret);
  params.set("sort", "bestflight_a");
  return `https://www.kayak.com/flights?${params.toString()}`;
}

export function skyscannerUrl({ from, to, depart, ret }) {
  const origin = placeToken(from || DEFAULT_ORIGIN).toLowerCase();
  const destination = (to ? placeToken(to) : "anywhere").toLowerCase();
  const start = compactDate(depart);
  const end = compactDate(ret);
  let path = `${origin}/${destination}/`;
  if (start && end) path += `${start}/${end}/`;
  else if (start) path += `${start}/`;
  return `https://www.skyscanner.com/transport/flights/${path}`;
}

export function priceTrackingHint() {
  return PRICE_HINT;
}

export function tripSearch(trip, origin) {
  const flights = Array.isArray(trip.items)
    ? trip.items.filter((item) => item && item.type === "flight" && item.bookingStatus !== "cancelled")
    : [];
  flights.sort((a, b) => String(a.departure?.localTime || "").localeCompare(String(b.departure?.localTime || "")));
  const first = flights[0];
  const fromCode = String(first?.departure?.airportCode || "").trim();
  const toCode = String(first?.arrival?.airportCode || "").trim();
  const depart = String(first?.departure?.localTime || trip.startDate || "").slice(0, 10);
  const end = String(trip.endDate || "").slice(0, 10);
  return {
    from: /^[A-Za-z]{3}$/.test(fromCode) ? fromCode.toUpperCase() : origin || DEFAULT_ORIGIN,
    to: /^[A-Za-z]{3}$/.test(toCode) ? toCode.toUpperCase() : trip.city || trip.destination || trip.title || "",
    depart: /^\d{4}-\d{2}-\d{2}$/.test(depart) ? depart : "",
    ret: /^\d{4}-\d{2}-\d{2}$/.test(end) && end !== depart.slice(0, 10) ? end : "",
    label: trip.title || trip.city || "Trip",
  };
}

export function upcomingTrips(manual, today) {
  return listTrips(manual).filter((trip) => {
    const end = trip.endDate || trip.startDate || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return true;
    return end >= today;
  });
}

function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined" && typeof localStorage !== "undefined";
}

function startApp() {
  const originalSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    originalSet(key, value);
    if (applying) return;
    if (key === MANUAL_KEY) scheduleSync();
    if (key === MANUAL_KEY || key === ORIGIN_KEY) renderDeals();
  };

  sessionStorage.removeItem("tripping-sync-reload");
  const host = document.createElement("div");
  host.id = "tripping-chrome";
  document.body.prepend(host);
  const style = document.createElement("style");
  style.textContent = chromeCss();
  document.head.appendChild(style);
  renderChrome();
  const root = document.getElementById("root");
  if (root) {
    const observer = new MutationObserver(() => renderChrome());
    observer.observe(root, { childList: true, subtree: true });
  }
  window.addEventListener("hashchange", () => {
    if (location.hash === "#/deals") currentView = "deals";
    else if (location.hash === "" || location.hash === "#" || location.hash === "#/settings" || location.hash === "#/review") currentView = "itinerary";
    renderChrome();
  });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest("#account-settings") : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      currentView = "itinerary";
      if (location.hash !== "#/settings") location.hash = "#/settings";
      renderChrome();
      document.getElementById("account-email")?.focus();
    },
    true,
  );
  if (readSession()) void syncNow();
}

function chromeCss() {
  return `
    #tripping-chrome { width: min(1080px, calc(100% - 32px)); margin: 0 auto; }
    #tripping-chrome[hidden] { display: none !important; }
    .device-banner { border: 1px solid #a56b1f; background: color-mix(in srgb, #c4842a 18%, var(--card, #fff)); color: var(--ink, #12202c); border-radius: 14px; margin: 12px 0 0; padding: 12px 14px; font-size: 1rem; }
    .device-banner strong { font-weight: 700; }
    .sync-tabs { display: flex; gap: 8px; margin: 12px 0 0; }
    .sync-tabs button { border: 1px solid var(--line, #d5e2e8); background: var(--card, #fff); color: var(--ink, #12202c); border-radius: 999px; min-height: 44px; padding: 0 16px; font: inherit; font-weight: 650; }
    .sync-tabs button[aria-selected="true"] { background: var(--ink, #12202c); color: var(--bg, #f3f7f8); border-color: var(--ink, #12202c); }
    .account-panel, .deals-panel { border: 1px solid var(--line, #d5e2e8); background: var(--card, #fff); color: var(--ink, #12202c); border-radius: 18px; margin-top: 12px; padding: 16px; display: grid; gap: 12px; }
    .account-panel h2, .deals-panel h2, .deal-card h3 { font-family: var(--serif, Georgia, serif); font-weight: 560; letter-spacing: -0.03em; margin: 0; }
    .account-panel h2, .deals-panel h2 { font-size: 1.7rem; }
    .account-grid, .deal-search { display: grid; gap: 10px; }
    .account-grid label, .deal-search label { display: grid; gap: 6px; }
    .account-grid span, .deal-search span, .deal-kicker { color: var(--muted, #4d6270); letter-spacing: .08em; text-transform: uppercase; font-size: .78rem; font-weight: 650; }
    .account-panel input, .deals-panel input { border: 1px solid var(--line, #d5e2e8); background: var(--bg, #f3f7f8); color: inherit; font: inherit; border-radius: 12px; min-height: 48px; padding: 8px 12px; }
    .account-actions, .deal-links, .origin-presets { display: flex; flex-wrap: wrap; gap: 8px; }
    .account-actions button, .deal-links a, .origin-presets button { border: 1px solid var(--line, #d5e2e8); background: var(--card, #fff); color: var(--ink, #12202c); border-radius: 999px; min-height: 44px; padding: 0 14px; font: inherit; font-weight: 650; text-decoration: none; display: inline-flex; align-items: center; }
    .account-actions button.primary, .deal-links a.primary { background: var(--accent, #0c5e88); color: var(--on-accent, #f7fbfc); border: 0; }
    .origin-presets button[aria-pressed="true"] { background: var(--ink, #12202c); color: var(--bg, #f3f7f8); }
    .sync-status { color: var(--muted, #4d6270); margin: 0; }
    .sync-status.is-error { color: var(--ink, #12202c); background: color-mix(in srgb, #9a3412 18%, var(--card, #fff)); border-radius: 12px; padding: 10px 12px; }
    .deal-card { border-top: 1px solid var(--line, #d5e2e8); padding-top: 12px; display: grid; gap: 8px; }
    .deal-hint { color: var(--muted, #4d6270); margin: 0; max-width: 68ch; }
    body.deals-mode #root { display: none; }
    button svg, button img, .google-button svg, .icon-tool svg, .kind-icon svg, .module-icon svg { pointer-events: none; }
    @media (width >= 720px) { .account-grid, .deal-search { grid-template-columns: 1fr 1fr; } .deal-search .wide { grid-column: 1 / -1; } }
  `;
}

function appReady() {
  return Boolean(document.querySelector(".wrap, #settings"));
}

function renderChrome() {
  const host = document.getElementById("tripping-chrome");
  if (!host) return;
  const ready = appReady();
  host.hidden = !ready;
  if (!ready) return;
  const session = readSession();
  const settings = location.hash === "#/settings" || location.hash === "#/review";
  const deals = !settings && (currentView === "deals" || location.hash === "#/deals");
  document.body.classList.toggle("deals-mode", deals);
  const signature = `${ready}|${session?.email || ""}|${settings}|${deals}|${readOrigin()}|${listTrips(readManual())
    .map((trip) => trip.id)
    .join(",")}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  const focusId = document.activeElement?.id;
  const accountEmail = document.getElementById("account-email")?.value;
  const accountPassword = document.getElementById("account-password")?.value;
  host.replaceChildren();
  if (!session) {
    const banner = document.createElement("p");
    banner.className = "device-banner";
    banner.id = "device-banner";
    banner.setAttribute("role", "status");
    const strong = document.createElement("strong");
    strong.textContent = "Not signed in. ";
    banner.append(strong, "Trips are only on this device. Open Settings and use Account to sign in, or create an account, so they stay with your email.");
    host.append(banner);
  }
  const tabs = document.createElement("div");
  tabs.className = "sync-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.append(tabButton("Itinerary", !deals, () => showItinerary()), tabButton("Deals", deals, () => showDeals()));
  host.append(tabs);
  if (settings) host.append(accountPanel(session, accountEmail, accountPassword));
  if (deals) host.append(dealsPanel());
  if (focusId) document.getElementById(focusId)?.focus();
}

let currentView = typeof location !== "undefined" && location.hash === "#/deals" ? "deals" : "itinerary";
function showItinerary() {
  currentView = "itinerary";
  if (location.hash === "#/deals" || location.hash === "#/settings" || location.hash === "#/review") location.hash = "";
  else renderChrome();
}
function showDeals() {
  currentView = "deals";
  if (location.hash !== "#/deals") location.hash = "#/deals";
  renderChrome();
}

function tabButton(label, selected, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tool";
  button.textContent = label;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", selected ? "true" : "false");
  button.id = label === "Deals" ? "open-deals" : "open-itinerary";
  button.addEventListener("click", onClick);
  return button;
}

function accountPanel(session, emailValue, passwordValue) {
  const panel = document.createElement("section");
  panel.className = "account-panel";
  panel.id = "account-panel";
  const title = document.createElement("h2");
  title.textContent = "Account";
  panel.append(title);
  const status = document.createElement("p");
  status.className = "sync-status";
  status.id = "account-status";
  const flash = sessionStorage.getItem("tripping-sync-flash");
  if (flash) {
    status.textContent = flash;
    sessionStorage.removeItem("tripping-sync-flash");
  }
  panel.append(status);
  if (session) {
    const who = document.createElement("p");
    who.textContent = `Signed in as ${session.email}. Trips on this device sync to that email.`;
    const actions = document.createElement("div");
    actions.className = "account-actions";
    const signOut = document.createElement("button");
    signOut.type = "button";
    signOut.id = "sign-out";
    signOut.textContent = "Sign out";
    signOut.addEventListener("click", () => void signOutAccount());
    actions.append(signOut);
    panel.append(who, actions);
    return panel;
  }
  const form = document.createElement("form");
  form.className = "account-grid";
  form.id = "account-form";
  form.append(
    field("Email", "account-email", "email", emailValue || "", "email"),
    field("Password", "account-password", "password", passwordValue || "", "current-password"),
  );
  const actions = document.createElement("div");
  actions.className = "account-actions";
  const signIn = document.createElement("button");
  signIn.type = "submit";
  signIn.className = "primary";
  signIn.id = "sign-in";
  signIn.textContent = "Sign in";
  const create = document.createElement("button");
  create.type = "button";
  create.id = "create-account";
  create.textContent = "Create account";
  actions.append(signIn, create);
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAuth("login");
  });
  create.addEventListener("click", () => void submitAuth("register"));
  panel.append(form);
  return panel;
}

function field(label, id, type, value, auto) {
  const wrap = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.value = value;
  input.autocomplete = auto;
  input.required = true;
  wrap.append(span, input);
  return wrap;
}

function dealsPanel() {
  const panel = document.createElement("section");
  panel.className = "deals-panel";
  panel.id = "deals-panel";
  const title = document.createElement("h2");
  title.textContent = "Flight deals";
  const lead = document.createElement("p");
  lead.className = "deal-hint";
  lead.textContent = "Free search links only. Nothing here checks a fare. Default origin is SMF, with SFO as the other Sacramento-area airport. Change it if you are leaving from somewhere else.";
  panel.append(title, lead, originControl(), searchCard());
  const today = new Date().toISOString().slice(0, 10);
  const trips = upcomingTrips(readManual(), today);
  const origin = readOrigin();
  if (trips.length === 0) {
    const empty = document.createElement("p");
    empty.className = "deal-hint";
    empty.textContent = "No upcoming trips yet. Add one, or use the search above.";
    panel.append(empty);
  }
  for (const trip of trips) panel.append(dealCard(trip.title || trip.city || "Trip", tripSearch(trip, origin)));
  const explore = document.createElement("div");
  explore.className = "deal-card";
  const exploreTitle = document.createElement("h3");
  exploreTitle.textContent = "Flexible destinations";
  const exploreCopy = document.createElement("p");
  exploreCopy.className = "deal-hint";
  exploreCopy.textContent = "Kayak Explore opens a map of anywhere you can fly from your origin, without a destination.";
  explore.append(exploreTitle, exploreCopy, linkRow({ from: origin, to: "", depart: "", ret: "" }, { explore: true }));
  panel.append(explore);
  return panel;
}

function originControl() {
  const wrap = document.createElement("div");
  const label = document.createElement("p");
  label.className = "deal-kicker";
  label.textContent = "Home airport";
  const presets = document.createElement("div");
  presets.className = "origin-presets";
  const current = readOrigin();
  for (const code of ORIGIN_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = code;
    button.setAttribute("aria-pressed", current === code ? "true" : "false");
    button.addEventListener("click", () => {
      localStorage.setItem(ORIGIN_KEY, code);
      renderDeals();
    });
    presets.append(button);
  }
  const custom = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = "Or another airport";
  const input = document.createElement("input");
  input.id = "deal-origin";
  input.value = current;
  input.maxLength = 32;
  input.autocomplete = "off";
  input.addEventListener("change", () => {
    const next = input.value.trim().toUpperCase();
    if (next) localStorage.setItem(ORIGIN_KEY, next);
    renderDeals();
  });
  custom.append(span, input);
  wrap.append(label, presets, custom);
  return wrap;
}

function searchCard() {
  const card = document.createElement("form");
  card.className = "deal-search";
  card.id = "deal-search";
  const origin = readOrigin();
  card.append(
    searchField("From", "deal-from", origin),
    searchField("To", "deal-to", ""),
    searchField("Depart", "deal-depart", "", "date"),
    searchField("Return", "deal-return", "", "date"),
  );
  const links = document.createElement("div");
  links.className = "deal-links wide";
  links.id = "deal-search-links";
  card.append(links);
  const hint = document.createElement("p");
  hint.className = "deal-hint wide";
  hint.id = "deal-price-hint";
  hint.textContent = priceTrackingHint();
  card.append(hint);
  const refresh = () => {
    links.replaceChildren();
    const query = {
      from: card.querySelector("#deal-from")?.value || origin,
      to: card.querySelector("#deal-to")?.value || "",
      depart: card.querySelector("#deal-depart")?.value || "",
      ret: card.querySelector("#deal-return")?.value || "",
    };
    appendLinks(links, query);
  };
  card.addEventListener("input", refresh);
  refresh();
  card.addEventListener("submit", (event) => event.preventDefault());
  return card;
}

function searchField(label, id, value, type = "text") {
  const wrap = document.createElement("label");
  wrap.className = id === "deal-from" || id === "deal-to" ? "" : "";
  const span = document.createElement("span");
  span.textContent = label;
  const input = document.createElement("input");
  input.id = id;
  input.type = type;
  input.value = value;
  wrap.append(span, input);
  return wrap;
}

function dealCard(title, query) {
  const card = document.createElement("article");
  card.className = "deal-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const route = document.createElement("p");
  route.className = "deal-hint";
  const when = [query.depart, query.ret].filter(Boolean).join(" → ");
  route.textContent = `${query.from} to ${query.to || "anywhere"}${when ? ` · ${when}` : ""}`;
  card.append(heading, route, linkRow(query, { explore: true }));
  return card;
}

function linkRow(query, options = {}) {
  const row = document.createElement("div");
  row.className = "deal-links";
  const google = googleFlightsUrl(query);
  appendAnchor(row, "Google Flights", google, "primary");
  appendAnchor(row, "Track prices on Google Flights", google);
  appendAnchor(row, query.to ? "Kayak" : "Kayak Explore", query.to ? kayakFlightsUrl(query) : kayakExploreUrl(query));
  if (options.explore && query.to) appendAnchor(row, "Kayak Explore", kayakExploreUrl(query));
  appendAnchor(row, "Skyscanner", skyscannerUrl(query));
  return row;
}

function appendLinks(row, query) {
  linkRow(query, { explore: true }).childNodes.forEach((node) => row.append(node));
}

function appendAnchor(row, label, href, className) {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  if (className) link.className = className;
  row.append(link);
}

function renderDeals() {
  if (document.getElementById("deals-panel")) renderChrome();
}

function readOrigin() {
  const stored = localStorage.getItem(ORIGIN_KEY);
  const value = (stored || DEFAULT_ORIGIN).trim().toUpperCase();
  return value || DEFAULT_ORIGIN;
}

function readManual() {
  try {
    return normalizeManual(JSON.parse(localStorage.getItem(MANUAL_KEY) || "null"));
  } catch {
    return emptyManual();
  }
}

function readMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem(META_KEY) || "null");
    if (!raw || typeof raw !== "object") return emptyMeta();
    return {
      owner: typeof raw.owner === "string" ? raw.owner : null,
      tombstones: stampMap(raw.tombstones),
      updatedAt: stampMap(raw.updatedAt),
      serialized: raw.serialized && typeof raw.serialized === "object" ? raw.serialized : {},
    };
  } catch {
    return emptyMeta();
  }
}

function writeMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function readSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!raw || typeof raw.token !== "string" || !/^[A-Fa-f0-9]{64}$/.test(raw.token) || typeof raw.email !== "string") return null;
    return { token: raw.token, email: raw.email };
  } catch {
    return null;
  }
}

function writeSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function readRevision(email) {
  try {
    const raw = JSON.parse(localStorage.getItem(REVISION_KEY) || "null");
    if (raw && raw.email === email && Number.isInteger(raw.revision) && raw.revision >= 0) return raw.revision;
  } catch {
    /* keep zero */
  }
  return 0;
}

function writeRevision(email, revision) {
  localStorage.setItem(REVISION_KEY, JSON.stringify({ email, revision }));
}

function metaFor(email) {
  const meta = readMeta();
  if (meta.owner === email) return meta;
  if (meta.owner == null) {
    const kept = { ...meta, owner: email };
    writeMeta(kept);
    return kept;
  }
  const fresh = emptyMeta(email);
  writeMeta(fresh);
  return fresh;
}

function setStatus(text, isError = false) {
  const status = document.getElementById("account-status");
  if (!status) {
    if (text) sessionStorage.setItem("tripping-sync-flash", text);
    return;
  }
  status.textContent = text;
  status.classList.toggle("is-error", isError);
}

function scheduleSync() {
  if (!readSession()) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), 500);
}

let running = false;
let rerun = false;
let timer = 0;
let applying = false;

async function syncNow() {
  const session = readSession();
  if (!session) return;
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    do {
      rerun = false;
      await syncOnce(session);
    } while (rerun && readSession());
  } finally {
    running = false;
  }
}

async function syncOnce(session) {
  const observed = observeManual(readManual(), metaFor(session.email), Date.now());
  writeMeta(observed.meta);
  const local = bookFrom(observed.manual, observed.meta);
  const remote = await fetchBook(session.token);
  if (remote.status === 401) {
    clearSession();
    setStatus("Sign in again. Trips on this device were kept.", true);
    renderChrome();
    return;
  }
  if (!remote.ok) {
    setStatus(remote.error || "Sync didn't finish. Trips are still on this device.", true);
    return;
  }
  let plan = planSync(local, remote);
  if (plan.action === "noop") {
    writeRevision(session.email, remote.revision);
    setStatus(sessionStorage.getItem("tripping-sync-flash") || "Saved to your account.");
    return;
  }
  if (!plan.upload) {
    const changed = applyLocal(plan.book, session.email);
    writeRevision(session.email, remote.revision);
    setStatus("Trips from your account are on this device.");
    if (changed) reloadForRemote();
    return;
  }
  if (isVacant(plan.book)) {
    if (remote.book && !isVacant(remote.book)) {
      const changed = applyLocal(remote.book, session.email);
      writeRevision(session.email, remote.revision);
      if (changed) reloadForRemote();
    }
    return;
  }
  let saved = await putBook(session.token, plan.baseRevision, plan.book);
  if (!saved.ok && saved.status === 409 && saved.book) {
    const merged = mergeBooks(plan.book, saved.book);
    const changed = applyLocal(isVacant(merged) && !isVacant(saved.book) ? saved.book : merged, session.email);
    if (isVacant(merged) && !isVacant(saved.book)) {
      writeRevision(session.email, saved.revision || remote.revision);
      setStatus("Kept the trips already stored for this account.");
      if (changed) reloadForRemote();
      return;
    }
    saved = await putBook(session.token, saved.revision ?? remote.revision, merged);
    if (saved.ok && changed) {
      writeRevision(session.email, saved.revision);
      reloadForRemote();
      return;
    }
  }
  if (!saved.ok) {
    setStatus(saved.error || "Sync didn't finish. Trips are still on this device.", true);
    return;
  }
  writeRevision(session.email, saved.revision);
  if (plan.apply) {
    const changed = applyLocal(plan.book, session.email);
    if (changed) {
      reloadForRemote();
      return;
    }
  }
  setStatus("Saved to your account.");
}

function applyLocal(book, email) {
  const manual = normalizeManual(book.manual);
  const next = JSON.stringify(manual);
  const previous = localStorage.getItem(MANUAL_KEY);
  const changed = previous !== next;
  applying = true;
  try {
    localStorage.setItem(MANUAL_KEY, next);
    const meta = metaFor(email);
    meta.tombstones = stampMap(book.tombstones);
    meta.updatedAt = stampMap(book.updatedAt);
    meta.serialized = {};
    for (const trip of [...manual.added, ...Object.values(manual.overrides)]) {
      meta.serialized[trip.id] = stableStringify(trip);
    }
    writeMeta(meta);
  } finally {
    applying = false;
  }
  return changed;
}

function reloadForRemote() {
  if (sessionStorage.getItem("tripping-sync-reload") === "1") return;
  sessionStorage.setItem("tripping-sync-reload", "1");
  sessionStorage.setItem("tripping-sync-flash", "Trips from your account are on this device.");
  location.reload();
}

async function submitAuth(kind) {
  const email = document.getElementById("account-email")?.value.trim().toLowerCase() || "";
  const password = document.getElementById("account-password")?.value || "";
  const path = kind === "register" ? "/auth/register" : "/auth/login";
  setStatus(kind === "register" ? "Creating the account…" : "Signing in…");
  const result = await postJson(path, { email, password });
  if (!result.ok) {
    const exists = result.status === 409 && kind === "register";
    setStatus(
      exists
        ? "An account with that email already exists. Sign in instead. Nothing on the server was changed."
        : result.error || "The account request did not finish.",
      true,
    );
    return;
  }
  writeSession({ token: result.token, email: result.email });
  writeRevision(result.email, 0);
  setStatus("Signed in. Syncing trips…");
  renderChrome();
  await syncNow();
  renderChrome();
}

async function signOutAccount() {
  const session = readSession();
  clearSession();
  if (session) await postJson("/auth/logout", {}, session.token).catch(() => {});
  setStatus("Signed out. Trips stay on this device until you sign in again.");
  renderChrome();
}

async function fetchBook(token) {
  const result = await requestJson("/book", { method: "GET", token });
  if (!result.ok) return result;
  const revision = Number.isInteger(result.body?.revision) ? result.body.revision : 0;
  const book = result.body?.book ?? null;
  if (book != null && (typeof book !== "object" || Array.isArray(book))) {
    return { ok: false, status: result.status, error: "Sync returned an unreadable book." };
  }
  return { ok: true, status: result.status, revision, book };
}

async function putBook(token, baseRevision, book) {
  if (isVacant(book)) return { ok: true, status: 200, revision: baseRevision, skippedEmpty: true };
  const result = await requestJson("/book", { method: "PUT", token, body: { baseRevision, book } });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      revision: Number.isInteger(result.body?.revision) ? result.body.revision : undefined,
      book: result.body?.book && typeof result.body.book === "object" ? result.body.book : null,
    };
  }
  const revision = result.body?.revision;
  if (!Number.isInteger(revision)) return { ok: false, status: result.status, error: "Sync did not confirm the save." };
  return { ok: true, status: result.status, revision };
}

async function postJson(path, body, token) {
  const result = await requestJson(path, { method: "POST", body, token });
  if (!result.ok) return result;
  if (path === "/auth/logout") return { ok: true, status: result.status };
  if (typeof result.body?.token !== "string" || typeof result.body?.email !== "string") {
    return { ok: false, status: result.status, error: "Sync returned an unreadable sign-in." };
  }
  return { ok: true, status: result.status, token: result.body.token, email: result.body.email };
}

async function requestJson(path, options) {
  const headers = { accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(`${syncBaseUrl()}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    return { ok: false, status: 0, error: "Could not reach the sync server. This device was not changed." };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body.error === "string" ? body.error : "Sync could not finish. This device was not changed.";
    return { ok: false, status: response.status, error, body };
  }
  return { ok: true, status: response.status, body };
}

if (isBrowser()) startApp();
