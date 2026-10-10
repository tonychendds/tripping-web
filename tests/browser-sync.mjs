import fs from "node:fs";
import puppeteer from "/tmp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const chrome = "/usr/local/bin/google-chrome";
const site = "http://127.0.0.1:4173/tripping-web/";
const outDir = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(outDir, { recursive: true });

const email = `browser-${Date.now()}@example.com`;
const password = "correct-horse";
const tripName = `Osaka test ${Date.now().toString().slice(-4)}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function shot(page, name) {
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log("shot", path);
}

async function enterApp(page) {
  await page.goto(site, { waitUntil: "networkidle0" });
  const demo = await page.$("#continue-demo");
  if (demo) {
    await demo.click();
    await page.waitForSelector("#setup-done", { timeout: 10000 });
  }
  const setup = await page.$("#setup-done");
  if (setup) await setup.click();
  await page.waitForSelector("#open-settings", { timeout: 10000 });
}

async function openAccount(page) {
  await page.click("#open-settings");
  await page.waitForFunction(() => location.hash === "#/settings");
  await page.waitForSelector("#account-panel", { timeout: 10000 });
}

async function fillTrip(page) {
  await page.click("#add-trip");
  await page.waitForSelector("#trip-form-title", { timeout: 10000 });
  const set = async (label, value) => {
    const ok = await page.evaluate((label, value) => {
      const match = [...document.querySelectorAll(".fields label")].find((node) => node.querySelector("span")?.textContent === label);
      const input = match?.querySelector("input");
      if (!input) return false;
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, label, value);
    assert(ok, `missing field ${label}`);
  };
  await set("Name", tripName);
  await set("Destination city", "Osaka");
  await set("Country", "Japan");
  await set("Currency", "JPY");
  await set("Start date", "2026-12-01");
  await set("End date", "2026-12-08");
  const tz = await page.$(".tz-value");
  const tzText = tz ? await page.evaluate((node) => node.textContent, tz) : "";
  if (!tzText || tzText.includes("Choose")) {
    await tz.click();
    await page.type(".tz-search", "Asia/Tokyo");
    await page.keyboard.press("Enter");
  }
  await page.click("button.add-trip[type=submit]");
  try {
    await page.waitForFunction((name) => document.body.innerText.includes(name) && !document.getElementById("trip-form-title"), { timeout: 10000 }, tripName);
  } catch (error) {
    const detail = await page.evaluate(() => ({
      errors: document.querySelector(".form-errors")?.innerText || "",
      tz: document.querySelector(".tz-value")?.textContent || "",
      title: document.getElementById("trip-form-title")?.textContent || "",
    }));
    await shot(page, "04-trip-form-failed");
    throw new Error(`${error.message} ${JSON.stringify(detail)}`);
  }
}

async function accountToken(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("tripping-account");
    return raw ? JSON.parse(raw).token : "";
  });
}

async function serverBook(token) {
  const response = await fetch("http://127.0.0.1:8787/book", { headers: { authorization: `Bearer ${token}` } });
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
  await enterApp(page);
  await shot(page, "01-device-banner");
  const banner = await page.$eval("#device-banner", (node) => node.textContent);
  assert(banner.includes("only on this device"), banner);
  await openAccount(page);
  await page.type("#account-email", email);
  await page.type("#account-password", password);
  await shot(page, "02-create-account");
  await page.click("#create-account");
  await page.waitForSelector("#sign-out", { timeout: 15000 });
  await shot(page, "03-signed-in");
  await page.click("#open-itinerary");
  await fillTrip(page);
  const token = await accountToken(page);
  let book = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    book = await serverBook(token);
    if (book.book?.manual?.added?.some((trip) => trip.title === tripName)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert(book.book?.manual?.added?.some((trip) => trip.title === tripName), `server missing trip ${JSON.stringify(book)}`);
  await shot(page, "04-trip-added");

  await page.click("#open-deals");
  await page.waitForSelector("#deals-panel");
  const dealText = await page.$eval("#deals-panel", (node) => node.innerText);
  assert(dealText.includes(tripName), "deals missing upcoming trip");
  assert(dealText.includes("Track prices"), "missing price hint");
  const hrefs = await page.$$eval("#deals-panel a", (nodes) => nodes.map((node) => node.href));
  const google = hrefs.find((href) => href.includes("google.com/travel/flights") && decodeURIComponent(href).includes("Osaka"));
  const kayak = hrefs.find((href) => href.includes("kayak.com/flights?") && href.includes("Osaka") && href.includes("SMF"));
  const explore = hrefs.find((href) => href.includes("kayak.com/explore/") && href.includes("anywhere"));
  const sky = hrefs.find((href) => href.includes("skyscanner.com/transport/flights/") && href.toLowerCase().includes("osaka"));
  assert(google, `google links ${hrefs.filter((href) => href.includes("google")).join("\n")}`);
  assert(kayak, `kayak links ${hrefs.filter((href) => href.includes("kayak.com/flights")).join("\n")}`);
  assert(explore, "missing kayak explore");
  assert(sky, `sky links ${hrefs.filter((href) => href.includes("skyscanner")).join("\n")}`);
  await page.type("#deal-from", "SFO");
  await page.type("#deal-to", "HND");
  await page.$eval("#deal-depart", (node) => {
    node.value = "2026-12-01";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.$eval("#deal-return", (node) => {
    node.value = "2026-12-08";
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const searchHrefs = await page.$$eval("#deal-search-links a", (nodes) => nodes.map((node) => node.href));
  assert(searchHrefs.some((href) => decodeURIComponent(href).includes("SFO") && decodeURIComponent(href).includes("HND")), searchHrefs.join("\n"));
  await shot(page, "05-deals");

  const dealPage = await first.newPage();
  await dealPage.goto(google, { waitUntil: "domcontentloaded", timeout: 30000 });
  const googleUrl = dealPage.url();
  console.log("opened google", googleUrl);
  await dealPage.screenshot({ path: `${outDir}/06-google-flights.png` });
  await dealPage.goto(kayak, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("opened kayak", dealPage.url());
  await dealPage.screenshot({ path: `${outDir}/07-kayak.png` });
  await dealPage.goto(explore, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("opened explore", dealPage.url());
  await dealPage.screenshot({ path: `${outDir}/08-kayak-explore.png` });
  await dealPage.goto(sky, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("opened skyscanner", dealPage.url());
  await dealPage.screenshot({ path: `${outDir}/09-skyscanner.png` });

  const second = await browser.createBrowserContext();
  const other = await second.newPage();
  other.setDefaultTimeout(20000);
  await other.setViewport({ width: 1280, height: 900 });
  await enterApp(other);
  await openAccount(other);
  await other.type("#account-email", email);
  await other.type("#account-password", password);
  await other.click("#sign-in");
  await other.waitForFunction((name) => (localStorage.getItem("tripping-manual-v1") || "").includes(name), { timeout: 20000 }, tripName);
  await other.waitForSelector("#open-itinerary", { timeout: 20000 });
  await other.click("#open-itinerary");
  await other.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 10000 }, tripName);
  await shot(other, "10-second-profile");
  console.log("second profile sees", tripName);

  const third = await browser.createBrowserContext();
  const empty = await third.newPage();
  empty.setDefaultTimeout(20000);
  await empty.setViewport({ width: 390, height: 844 });
  await enterApp(empty);
  await openAccount(empty);
  await empty.type("#account-email", email);
  await empty.type("#account-password", password);
  const before = await serverBook(token);
  await empty.click("#create-account");
  await empty.waitForFunction(() => document.getElementById("account-status")?.textContent?.includes("already exists"), { timeout: 10000 });
  await shot(empty, "11-create-empty-refused");
  const afterCreate = await serverBook(token);
  assert(JSON.stringify(afterCreate.book.manual.added) === JSON.stringify(before.book.manual.added), "create account wiped trips");
  assert(afterCreate.revision === before.revision, `revision changed ${before.revision} -> ${afterCreate.revision}`);

  await other.click("#open-itinerary");
  await other.waitForSelector("button");
  const deleteButtons = await other.$$("xpath/.//button[normalize-space()='Delete trip']");
  assert(deleteButtons.length > 0, "no delete button");
  await deleteButtons[0].click();
  const confirm = await other.waitForSelector("xpath/.//button[normalize-space()='Delete']");
  await confirm.click();
  let removed = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    removed = await serverBook(token);
    const titles = removed.book?.manual?.added?.map((trip) => trip.title) || [];
    if (!titles.includes(tripName) && removed.book?.tombstones) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const titles = removed.book?.manual?.added?.map((trip) => trip.title) || [];
  assert(!titles.includes(tripName), `delete did not sync ${JSON.stringify(removed.book)}`);
  const tombId = Object.keys(removed.book.tombstones || [])[0];
  assert(tombId, "missing tombstone");
  await other.reload({ waitUntil: "networkidle0" });
  const stillThere = await other.evaluate((name) => document.body.innerText.includes(name), tripName);
  assert(!stillThere, "deleted trip came back after reload");
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelector("#open-settings") || document.querySelector("#sign-in") || document.querySelector("#setup-done"));
  if (await page.$("#continue-demo")) await page.click("#continue-demo");
  if (await page.$("#setup-done")) await page.click("#setup-done");
  await page.waitForSelector("#open-settings");
  const onFirst = await page.evaluate((name) => document.body.innerText.includes(name), tripName);
  if (onFirst) {
    await page.evaluate(() => localStorage.removeItem("tripping-book-revision"));
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("#open-settings");
  }
  const onFirstAfter = await page.evaluate((name) => document.body.innerText.includes(name), tripName);
  assert(!onFirstAfter, "first profile resurrected the deleted trip");
  await shot(page, "12-deleted-stays-gone");
  console.log("browser sync ok", email, tripName);
} finally {
  await browser.close();
}
