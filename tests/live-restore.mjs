import assert from "node:assert/strict";
import fs from "node:fs";
import puppeteer from "/tmp/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const chrome = "/usr/local/bin/google-chrome";
const site = process.env.TRIPPING_SITE || "http://127.0.0.1:4173/tripping-web/";
const syncUrl = "https://tripping-sync.tonychendds.workers.dev";
const outDir = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(outDir, { recursive: true });

const stamp = Date.now();
const restoreEmail = `tripping-agenttest-${stamp}@example.com`;
const halfEmail = `tripping-agenttest-${stamp}-half@example.com`;
const password = "correct-horse";

async function shot(page, name) {
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("shot", path);
}

async function prepare(page) {
  const puts = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/book")) puts.push(request.url());
  });
  page.puts = puts;
  await page.evaluateOnNewDocument((url) => {
    localStorage.setItem("tripping-sync-url", url);
  }, syncUrl);
}

async function resetPuts(page) {
  page.puts.length = 0;
}

async function freshCaches(page) {
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    if (regs) await Promise.all(regs.map((reg) => reg.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }).catch(() => {});
}

async function settle(page) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        setup: Boolean(document.getElementById("setup-done")),
        ready: Boolean(document.getElementById("open-settings")),
        gate: Boolean(document.getElementById("tripping-gate")),
        status: document.getElementById("account-status")?.textContent || "",
      }))
      .catch(() => null);
    if (!state) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (/already exists|did not finish|not finish|Could not reach/.test(state.status)) throw new Error(state.status);
    if (state.setup) {
      await page.click("#setup-done");
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    if (state.ready && !state.gate) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("app did not leave the splash");
}

async function openHome(page) {
  await page.goto(site, { waitUntil: "networkidle0" });
  await freshCaches(page);
  await page.reload({ waitUntil: "networkidle0" });
  const skip = await page.$("#continue-without-account");
  if (skip) await skip.click();
  await settle(page);
  if (page.url().includes("#/settings")) {
    await page.click("#open-itinerary");
    await page.waitForFunction(() => !location.hash.includes("settings"));
  }
}

async function addTrip(page, name, city, start, end) {
  if (!(await page.$("#trip-form-title"))) {
    await page.click("#add-trip");
    await page.waitForSelector("#trip-form-title", { timeout: 10000 });
  }
  const set = async (label, value) => {
    const ok = await page.evaluate((label, value) => {
      const match = [...document.querySelectorAll(".fields label")].find((node) => node.querySelector("span")?.textContent === label);
      const input = match?.querySelector("input");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, label, value);
    assert(ok, `missing field ${label}`);
  };
  await set("Name", name);
  await set("Destination city", city);
  await set("Country", "Japan");
  await set("Currency", "JPY");
  await set("Start date", start);
  await set("End date", end);
  const tzText = await page.$eval(".tz-value", (node) => node.textContent).catch(() => "");
  if (!tzText || tzText.includes("Choose")) {
    await page.click(".tz-value");
    await page.type(".tz-search", "Asia/Tokyo");
    await page.keyboard.press("Enter");
  }
  await page.click("button.add-trip[type=submit]");
  await page.waitForFunction((title) => document.body.innerText.includes(title) && !document.getElementById("trip-form-title"), { timeout: 10000 }, name);
}

async function serverBook(token) {
  const response = await fetch(`${syncUrl}/book`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function tokenOf(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("tripping-account") || "null")?.token || "");
}

async function waitForServerTitles(token, titles) {
  let book = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    book = await serverBook(token);
    const have = book.book?.manual?.added?.map((trip) => trip.title) || [];
    if (titles.every((title) => have.includes(title))) return book;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`server missing titles ${titles.join(", ")} ${JSON.stringify(book)}`);
}

async function register(page, email) {
  await page.goto(site, { waitUntil: "networkidle0" });
  await freshCaches(page);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("#gate-form");
  await page.type("#account-email", email);
  await page.type("#account-password", password);
  await page.click("#gate-create-account");
  await settle(page);
}

function tripId(manual, title) {
  return manual?.added?.find((trip) => trip.title === title)?.id || "";
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const restoreContext = await browser.createBrowserContext();
  const creator = await restoreContext.newPage();
  creator.setDefaultTimeout(20000);
  await creator.setViewport({ width: 390, height: 844 });
  await prepare(creator);
  await register(creator, restoreEmail);
  const first = `Kyoto ${stamp.toString().slice(-4)}`;
  const second = `Osaka ${stamp.toString().slice(-4)}`;
  await addTrip(creator, first, "Kyoto", "2026-11-02", "2026-11-08");
  await addTrip(creator, second, "Osaka", "2026-12-01", "2026-12-08");
  const token = await tokenOf(creator);
  assert(token, "missing restore token");
  const seeded = await waitForServerTitles(token, [first, second]);
  const seededRevision = seeded.revision;
  const seededTitles = seeded.book.manual.added.map((trip) => trip.title).sort();
  console.log("seeded restore", restoreEmail, seededRevision, seededTitles);

  await creator.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  const client = await creator.createCDPSession();
  await client.send("Storage.clearDataForOrigin", { origin: new URL(site).origin, storageTypes: "all" });
  await creator.reload({ waitUntil: "networkidle0" });
  const skip = await creator.$("#continue-without-account");
  if (skip) await skip.click();
  await settle(creator);
  if (creator.url().includes("#/settings")) await creator.click("#open-itinerary");
  await creator.waitForSelector("#restore-card", { timeout: 10000 });
  const card = await creator.evaluate(() => {
    const restore = document.getElementById("restore-card");
    const hero = document.querySelector("#main .hero");
    const heroText = hero?.innerText || "";
    const beforeHero = Boolean(restore && hero && (restore.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING));
    return {
      text: restore?.innerText || "",
      href: document.getElementById("restore-sign-in")?.getAttribute("href") || "",
      beforeHero,
      heroText,
      signedIn: Boolean(localStorage.getItem("tripping-account")),
    };
  });
  assert(card.text.includes("Sign in to restore your trips"), JSON.stringify(card));
  assert(card.beforeHero, JSON.stringify(card));
  assert(card.heroText.includes("No upcoming trips"), JSON.stringify(card));
  assert(!card.signedIn, "cleared device still signed in");
  await shot(creator, "20-restore-card");

  resetPuts(creator);
  await creator.click("#restore-sign-in");
  await creator.waitForSelector("#account-form");
  const storage = await creator.$eval("#storage-persist", (node) => node.textContent || "");
  assert(/Storage: (persistent|not persistent)/.test(storage), storage);
  await shot(creator, "21-storage-persist");
  await creator.type("#account-email", restoreEmail);
  await creator.type("#account-password", password);
  await creator.click("#sign-in");
  await creator.waitForFunction((title) => (localStorage.getItem("tripping-manual-v1") || "").includes(title), { timeout: 20000 }, first);
  await settle(creator);
  if (creator.url().includes("#/settings") || (await creator.$("#account-panel"))) await creator.click("#open-itinerary");
  await creator.waitForFunction((a, b) => document.body.innerText.includes(a) && document.body.innerText.includes(b), { timeout: 10000 }, first, second);
  const restored = await serverBook(token);
  assert(restored.revision === seededRevision, `empty sign-in uploaded ${seededRevision} -> ${restored.revision}`);
  assert.deepEqual(restored.book.manual.added.map((trip) => trip.title).sort(), seededTitles);
  assert(creator.puts.length === 0, `empty sign-in issued PUT ${creator.puts.length}`);
  await shot(creator, "22-trips-restored");
  console.log("restore ok", restoreEmail, "puts", creator.puts.length, "storage", storage);

  const halfContext = await browser.createBrowserContext();
  const half = await halfContext.newPage();
  half.setDefaultTimeout(20000);
  await half.setViewport({ width: 1280, height: 900 });
  await prepare(half);
  await register(half, halfEmail);
  const names = ["Kyoto", "Osaka", "Tokyo", "Nara"].map((city) => `${city} ${stamp.toString().slice(-4)}`);
  await addTrip(half, names[0], "Kyoto", "2026-11-02", "2026-11-08");
  const manual = await half.evaluate(() => JSON.parse(localStorage.getItem("tripping-manual-v1") || "null"));
  const prototype = manual.added.find((trip) => trip.title === names[0]);
  assert(prototype, "missing prototype trip");
  const clones = names.slice(1).map((title, index) => ({
    ...prototype,
    id: `${prototype.id}-copy-${index + 1}`,
    title,
    city: title.split(" ")[0],
    startDate: `2026-12-${String(index + 2).padStart(2, "0")}`,
    endDate: `2026-12-${String(index + 6).padStart(2, "0")}`,
  }));
  await half.evaluate((added) => {
    const current = JSON.parse(localStorage.getItem("tripping-manual-v1") || "null");
    current.added = added;
    localStorage.setItem("tripping-manual-v1", JSON.stringify(current));
  }, [prototype, ...clones]);
  await half.reload({ waitUntil: "networkidle0" });
  await settle(half);
  const halfToken = await tokenOf(half);
  const serverHalf = await waitForServerTitles(halfToken, names);
  const halfRevision = serverHalf.revision;
  console.log("seeded half", halfEmail, halfRevision, names);

  const chooserContext = await browser.createBrowserContext();
  const chooser = await chooserContext.newPage();
  chooser.setDefaultTimeout(20000);
  await chooser.setViewport({ width: 1280, height: 900 });
  await prepare(chooser);
  await openHome(chooser);
  const localName = `Sapporo ${stamp.toString().slice(-4)}`;
  await addTrip(chooser, localName, "Sapporo", "2026-11-10", "2026-11-12");
  await chooser.click("#open-settings");
  await chooser.waitForSelector("#account-form");
  resetPuts(chooser);
  await chooser.type("#account-email", halfEmail);
  await chooser.type("#account-password", password);
  await chooser.click("#sign-in");
  await chooser.waitForSelector("#book-choice", { timeout: 15000 });
  const choice = await chooser.evaluate(() => ({
    text: document.getElementById("book-choice")?.innerText || "",
    focused: document.activeElement?.id || "",
    serverType: document.getElementById("keep-server")?.getAttribute("type") || "",
  }));
  assert(choice.text.includes("Keep server"), JSON.stringify(choice));
  assert(choice.text.includes("Keep this device"), JSON.stringify(choice));
  assert(choice.text.includes("1 trip"), JSON.stringify(choice));
  assert(choice.text.includes("4 trips"), JSON.stringify(choice));
  assert(choice.focused === "keep-server", JSON.stringify(choice));
  assert(choice.serverType === "submit", JSON.stringify(choice));
  await shot(chooser, "23-keep-server-prompt");
  await chooser.click("#keep-server");
  await chooser.waitForFunction((title) => (localStorage.getItem("tripping-manual-v1") || "").includes(title), { timeout: 20000 }, names[0]);
  await settle(chooser);
  if (chooser.url().includes("#/settings") || (await chooser.$("#account-panel"))) await chooser.click("#open-itinerary");
  await chooser.waitForFunction((title) => document.body.innerText.includes(title) && !document.body.innerText.includes("Sapporo"), { timeout: 10000 }, names[3]);
  const keptServer = await serverBook(halfToken);
  assert(keptServer.revision === halfRevision, `keep server uploaded ${halfRevision} -> ${keptServer.revision}`);
  assert.deepEqual(keptServer.book.manual.added.map((trip) => trip.title).sort(), [...names].sort());
  assert(!keptServer.book.manual.added.some((trip) => trip.title === localName), "local trip overwrote the server");
  assert(chooser.puts.length === 0, `keep server issued PUT ${chooser.puts.length}`);
  await shot(chooser, "24-kept-server");
  console.log("keep server ok", halfEmail);

  const deviceContext = await browser.createBrowserContext();
  const device = await deviceContext.newPage();
  device.setDefaultTimeout(20000);
  await device.setViewport({ width: 1280, height: 900 });
  await prepare(device);
  await openHome(device);
  const deviceName = `Hiroshima ${stamp.toString().slice(-4)}`;
  await addTrip(device, deviceName, "Hiroshima", "2026-11-20", "2026-11-22");
  await device.click("#open-settings");
  await device.waitForSelector("#account-form");
  resetPuts(device);
  await device.type("#account-email", halfEmail);
  await device.type("#account-password", password);
  await device.click("#sign-in");
  await device.waitForSelector("#keep-device", { timeout: 15000 });
  await device.click("#keep-device");
  await device.waitForFunction(() => document.body.innerText.includes("Saved this device over the trips in your account."), { timeout: 20000 });
  const replaced = await serverBook(halfToken);
  const replacedTitles = replaced.book.manual.added.map((trip) => trip.title);
  assert(replaced.revision > halfRevision, `keep device did not upload ${halfRevision} -> ${replaced.revision}`);
  assert.deepEqual(replacedTitles, [deviceName]);
  assert(replaced.book.tombstones && Object.keys(replaced.book.tombstones).length >= 4, JSON.stringify(replaced.book.tombstones));
  assert(device.puts.length === 1, `keep device puts ${device.puts.length}`);
  await shot(device, "25-kept-device");
  console.log("keep device ok", halfEmail, replaced.revision, replacedTitles);
  console.log("ACCOUNTS", restoreEmail, halfEmail);
} finally {
  await browser.close();
}
