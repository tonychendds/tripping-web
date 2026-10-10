import fs from "node:fs";
import puppeteer from "/tmp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const chrome = "/usr/local/bin/google-chrome";
const site = "http://127.0.0.1:4173/tripping-web/";
const syncUrl = "https://tripping-sync.tonychendds.workers.dev";
const outDir = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(outDir, { recursive: true });

const email = `tripping-agenttest-${Date.now()}@example.com`;
const password = "correct-horse";
const tripName = `Kyoto test ${Date.now().toString().slice(-4)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function shot(page, name) {
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("shot", path);
}

async function prepare(page) {
  await page.evaluateOnNewDocument((url) => {
    localStorage.setItem("tripping-sync-url", url);
  }, syncUrl);
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

async function fillTrip(page) {
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
  await set("Name", tripName);
  await set("Destination city", "Kyoto");
  await set("Country", "Japan");
  await set("Currency", "JPY");
  await set("Start date", "2026-11-02");
  await set("End date", "2026-11-08");
  const tzText = await page.$eval(".tz-value", (node) => node.textContent).catch(() => "");
  if (!tzText || tzText.includes("Choose")) {
    await page.click(".tz-value");
    await page.type(".tz-search", "Asia/Tokyo");
    await page.keyboard.press("Enter");
  }
  await page.click("button.add-trip[type=submit]");
  await page.waitForFunction((name) => document.body.innerText.includes(name) && !document.getElementById("trip-form-title"), { timeout: 10000 }, tripName);
}

async function serverBook(token) {
  const response = await fetch(`${syncUrl}/book`, { headers: { authorization: `Bearer ${token}` } });
  return response.json();
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const first = await browser.createBrowserContext();
  const page = await first.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1280, height: 900 });
  await prepare(page);
  await page.goto(site, { waitUntil: "networkidle0" });
  await page.waitForSelector("#tripping-gate");
  const splash = await page.$eval("#tripping-gate", (node) => node.innerText);
  assert(splash.includes("Sign in"), splash);
  assert(splash.includes("Create account"), splash);
  assert(splash.includes("Continue without an account"), splash);
  assert(!splash.includes("Google"), splash);
  const googleVisible = await page.evaluate(() => {
    const button = document.querySelector(".google-button");
    if (!button) return false;
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  });
  assert(!googleVisible, "Google sign-in button is visible");
  await shot(page, "13-email-splash");

  await page.click("#continue-without-account");
  await settle(page);
  await page.click("#add-trip");
  await page.waitForFunction(() => document.querySelector("#trip-form-title")?.parentElement?.querySelector(".eyebrow")?.textContent === "On this device");
  const signedOutDialog = await page.evaluate(() => {
    const eyebrow = document.querySelector("#trip-form-title")?.parentElement?.querySelector(".eyebrow")?.textContent || "";
    const notes = [...document.querySelectorAll(".editor .trip-notes")].map((node) => node.textContent).join(" ");
    return { eyebrow, notes };
  });
  assert(signedOutDialog.eyebrow === "On this device", JSON.stringify(signedOutDialog));
  assert(signedOutDialog.notes.includes("Saved in this browser"), JSON.stringify(signedOutDialog));
  assert(!signedOutDialog.notes.includes("Saved to your account"), JSON.stringify(signedOutDialog));
  await shot(page, "14-device-wording");
  await page.keyboard.press("Escape");

  const second = await browser.createBrowserContext();
  const creator = await second.newPage();
  creator.setDefaultTimeout(20000);
  await creator.setViewport({ width: 1280, height: 900 });
  await prepare(creator);
  await creator.goto(site, { waitUntil: "networkidle0" });
  await creator.waitForSelector("#gate-form");
  await creator.type("#account-email", email);
  await creator.type("#account-password", password);
  await creator.click("#gate-create-account");
  await settle(creator);
  await creator.click("#add-trip");
  await creator.waitForFunction(() => document.querySelector("#trip-form-title")?.parentElement?.querySelector(".eyebrow")?.textContent === "Your account");
  const signedInDialog = await creator.evaluate(() => {
    const eyebrow = document.querySelector("#trip-form-title")?.parentElement?.querySelector(".eyebrow")?.textContent || "";
    const notes = [...document.querySelectorAll(".editor .trip-notes")].map((node) => node.textContent).join(" ");
    return { eyebrow, notes };
  });
  assert(signedInDialog.eyebrow === "Your account", JSON.stringify(signedInDialog));
  assert(signedInDialog.notes.includes("Saved to your account"), JSON.stringify(signedInDialog));
  assert(!signedInDialog.notes.includes("Saved in this browser"), JSON.stringify(signedInDialog));
  await shot(creator, "15-account-dialog");
  await fillTrip(creator);
  await creator.waitForFunction(() => document.body.innerText.includes("Saved to your account."), { timeout: 10000 });
  const card = await creator.evaluate((name) => {
    const trip = [...document.querySelectorAll("article, section, li, .trip, .itinerary")].find((node) => node.innerText?.includes(name));
    return document.body.innerText.includes("Saved to your account.") && !document.body.innerText.includes("Saved on this device.");
  }, tripName);
  assert(card, "signed-in trip card still says saved on this device");
  await shot(creator, "16-saved-to-account");
  const token = await creator.evaluate(() => JSON.parse(localStorage.getItem("tripping-account") || "null")?.token || "");
  assert(token, "missing session token");
  let book = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    book = await serverBook(token);
    if (book.book?.manual?.added?.some((trip) => trip.title === tripName)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert(book.book?.manual?.added?.some((trip) => trip.title === tripName), `live server missing trip ${JSON.stringify(book)}`);

  const third = await browser.createBrowserContext();
  const other = await third.newPage();
  other.setDefaultTimeout(20000);
  await other.setViewport({ width: 390, height: 844 });
  await prepare(other);
  await other.goto(site, { waitUntil: "networkidle0" });
  await other.waitForSelector("#gate-form");
  await other.type("#account-email", email);
  await other.type("#account-password", password);
  await other.click("#gate-sign-in");
  await other.waitForFunction((name) => (localStorage.getItem("tripping-manual-v1") || "").includes(name), { timeout: 20000 }, tripName);
  await settle(other);
  if (other.url().includes("#/settings") || (await other.$("#account-panel"))) await other.click("#open-itinerary");
  await other.waitForFunction((name) => document.body.innerText.includes(name) && document.body.innerText.includes("Saved to your account."), { timeout: 10000 }, tripName);
  await shot(other, "17-second-browser");

  const empty = await (await browser.createBrowserContext()).newPage();
  empty.setDefaultTimeout(20000);
  await empty.setViewport({ width: 390, height: 844 });
  await prepare(empty);
  await empty.goto(site, { waitUntil: "networkidle0" });
  await empty.waitForSelector("#gate-form");
  await empty.type("#account-email", email);
  await empty.type("#account-password", password);
  const before = await serverBook(token);
  await empty.click("#gate-create-account");
  await empty.waitForFunction(() => document.getElementById("account-status")?.textContent?.includes("already exists"), { timeout: 10000 });
  const after = await serverBook(token);
  assert(JSON.stringify(after.book.manual.added) === JSON.stringify(before.book.manual.added), "create account wiped trips");
  assert(after.revision === before.revision, `revision changed ${before.revision} -> ${after.revision}`);
  await shot(empty, "18-empty-create-refused");

  await other.click("#open-settings");
  await other.waitForSelector("#sign-out");
  await other.click("#sign-out");
  await other.click("#open-itinerary");
  await other.waitForFunction(
    (name) => document.body.innerText.includes(name) && document.body.innerText.includes("Saved on this device.") && !document.body.innerText.includes("Saved to your account."),
    { timeout: 10000 },
    tripName,
  );
  await shot(other, "19-signed-out-card");

  await other.click("#open-settings");
  await other.waitForSelector("#account-email");
  await other.type("#account-email", email);
  await other.type("#account-password", password);
  await other.click("#sign-in");
  await other.waitForSelector("#sign-out", { timeout: 15000 });
  await other.click("#open-itinerary");
  await other.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 10000 }, tripName);
  const deleteButtons = await other.$$("xpath/.//button[normalize-space()='Delete trip']");
  assert(deleteButtons.length > 0, "no delete button");
  await deleteButtons[0].click();
  const confirm = await other.waitForSelector("xpath/.//button[normalize-space()='Delete']");
  await confirm.click();
  let removed = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    removed = await serverBook(token);
    const titles = removed.book?.manual?.added?.map((trip) => trip.title) || [];
    if (!titles.includes(tripName)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const titles = removed.book?.manual?.added?.map((trip) => trip.title) || [];
  assert(!titles.includes(tripName), `delete did not sync ${JSON.stringify(removed?.book)}`);
  console.log("live ui ok", email, tripName);
} finally {
  await browser.close();
}
