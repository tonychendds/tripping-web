import fs from "node:fs";
import puppeteer from "/tmp/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js";

const chrome = "/usr/local/bin/google-chrome";
const site = "http://127.0.0.1:4173/tripping-web/";
const syncUrl = "https://tripping-sync.tonychendds.workers.dev";
const outDir = "/opt/cursor/artifacts/screenshots";
fs.mkdirSync(outDir, { recursive: true });

const email = `tripping-agenttest-${Date.now()}@example.com`;
const password = "correct-horse";
console.log("account", email);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stop(code, city, name, localTime, timezone) {
  return { airportCode: code, airportName: name, city, localTime, timezone };
}

const kyoto = {
  id: "kyoto",
  title: "Kyoto restored",
  destination: "Kyoto, Japan",
  city: "Kyoto",
  country: "Japan",
  currency: "JPY",
  timezone: "Asia/Tokyo",
  startDate: "2026-12-10",
  endDate: "2026-12-18",
  items: [
    {
      id: "stay-kanra",
      type: "lodging",
      name: "Kanra Hotel",
      address: "Kyoto, Japan",
      checkIn: "2026-12-11T16:00:00+09:00",
      checkOut: "2026-12-18T11:00:00+09:00",
      timezone: "Asia/Tokyo",
    },
    {
      id: "flight-back",
      type: "flight",
      airline: "JL",
      flightNumber: "62",
      travelers: ["Alex"],
      departure: stop("KIX", "Kansai", "Osaka", "2026-12-18T18:00:00+09:00", "Asia/Tokyo"),
      arrival: stop("SMF", "Sacramento", "Sacramento", "2026-12-18T11:00:00-08:00", "America/Los_Angeles"),
    },
    {
      id: "flight-out",
      type: "flight",
      airline: "JL",
      flightNumber: "61",
      travelers: ["Alex"],
      departure: stop("SMF", "Sacramento", "Sacramento", "2026-12-10T10:00:00-08:00", "America/Los_Angeles"),
      arrival: stop("KIX", "Kansai", "Osaka", "2026-12-11T15:00:00+09:00", "Asia/Tokyo"),
    },
  ],
};

const dayHop = {
  id: "dayhop",
  title: "Day hop",
  destination: "Sacramento",
  city: "Sacramento",
  country: "United States",
  currency: "USD",
  timezone: "America/Los_Angeles",
  startDate: "2026-12-11",
  endDate: "2026-12-11",
  items: [],
};

function assertOk(response, body, label) {
  if (!response.ok) throw new Error(`${label} ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const registered = await fetch(`${syncUrl}/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://127.0.0.1:4173" },
  body: JSON.stringify({ email, password }),
});
const account = assertOk(registered, await registered.json(), "register");
const book = {
  version: 1,
  manual: { version: 1, added: [kyoto, dayHop], overrides: {}, hidden: [] },
  tombstones: {},
  updatedAt: { kyoto: 1, dayhop: 1 },
};
const saved = await fetch(`${syncUrl}/book`, {
  method: "PUT",
  headers: { "content-type": "application/json", authorization: `Bearer ${account.token}`, origin: "http://127.0.0.1:4173" },
  body: JSON.stringify({ baseRevision: 0, book }),
});
assertOk(saved, await saved.json(), "put book");

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  await page.setViewport({ width: 1280, height: 1400 });
  await page.evaluateOnNewDocument((url) => {
    localStorage.setItem("tripping-sync-url", url);
  }, syncUrl);
  await page.goto(site, { waitUntil: "networkidle0" });
  await page.waitForSelector("#gate-form");
  await page.type("#account-email", email);
  await page.type("#account-password", password);
  await page.click("#gate-sign-in");

  const deadline = Date.now() + 25000;
  let settled = false;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        setup: Boolean(document.getElementById("setup-done")),
        ready: Boolean(document.getElementById("open-settings")),
        gate: Boolean(document.getElementById("tripping-gate")),
        loaded: (localStorage.getItem("tripping-manual-v1") || "").includes("Kyoto restored"),
      }))
      .catch(() => null);
    if (!state) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    if (state.setup) {
      await page.click("#setup-done").catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
      continue;
    }
    if (state.ready && state.loaded && !state.gate) {
      settled = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!settled) {
    const dump = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => "no page");
    throw new Error(`did not settle\n${dump}`);
  }

  try {
  await page.waitForFunction(() => {
    const notes = [...document.querySelectorAll(".source-note")].map((node) => node.textContent || "");
    return (
      document.body.innerText.includes("Kyoto restored") &&
      notes.length >= 2 &&
      notes.every((note) => note.includes("Saved to your account.")) &&
      notes.every((note) => !note.includes("Saved on this device") && !note.includes("From the trip file"))
    );
  });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      body: document.body.innerText.slice(0, 2500),
      notes: [...document.querySelectorAll(".source-note")].map((node) => node.textContent),
      manual: localStorage.getItem("tripping-manual-v1"),
      session: localStorage.getItem("tripping-account"),
    })).catch(() => null);
    console.log(JSON.stringify(dump, null, 2));
    await page.screenshot({ path: "/opt/cursor/artifacts/screenshots/20-display-failed.png", fullPage: true }).catch(() => {});
    throw error;
  }
  const text = await page.evaluate(() => document.body.innerText);
  assert(!text.includes("Demo mode"), "demo wording still visible");
  assert(!text.includes("Sign in with Google"), "google sign-in wording still visible");
  assert(text.includes("Invites are not saved with your account."), text);

  const range = await page.$eval("#trip-dayhop .trip-range", (node) => node.textContent);
  assert(range === "Dec 11", range);
  assert(!text.includes("Dec 11–11"), text);
  assert(!text.includes("Jan 3–3"), text);

  const names = await page.$$eval("#trip-kyoto .timeline .name", (nodes) => nodes.map((node) => node.textContent));
  assert(JSON.stringify(names) === JSON.stringify(["JL 61", "Kanra Hotel", "JL 62"]), JSON.stringify(names));
  const whens = await page.$$eval("#trip-kyoto .timeline .when", (nodes) => nodes.map((node) => node.textContent));
  assert(whens.length === 3, JSON.stringify(whens));
  assert(/10:00/.test(whens[0]) && /3:00/.test(whens[0]) && whens[0].includes("→") && /\+1 day/.test(whens[0]), whens[0]);
  assert(/6:00/.test(whens[2]) && /11:00/.test(whens[2]) && whens[2].includes("→") && !/\+\d+ day/.test(whens[2]), whens[2]);
  await page.screenshot({ path: `${outDir}/20-server-trip-display.png`, fullPage: true });
  console.log("live display ok", email);
  console.log(whens.join("\n"));
} finally {
  await browser.close();
}
