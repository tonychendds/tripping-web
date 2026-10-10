import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  bookFrom,
  emptyManual,
  emptyMeta,
  googleFlightsUrl,
  isVacant,
  kayakExploreUrl,
  kayakFlightsUrl,
  mergeBooks,
  observeManual,
  planSync,
  priceTrackingHint,
  skyscannerUrl,
  tripSearch,
  upcomingTrips,
  accountFacingText,
  shareFacingText,
  SHARE_INTRO,
  SHARE_SIGNED_IN,
  SHARE_SIGNED_OUT,
  ACCOUNT_CARD,
  ACCOUNT_EYEBROW,
  ACCOUNT_FORM,
  DEVICE_CARD,
  DEVICE_EYEBROW,
  DEVICE_FORM,
} from "../assets/sync.js";

function trip(id, title, extra = {}) {
  return { id, title, city: extra.city || title, country: "Japan", startDate: "2026-12-01", endDate: "2026-12-08", items: [], ...extra };
}

test("an empty device does not upload over a server book", () => {
  const remote = bookFrom({ ...emptyManual(), added: [trip("osaka", "Osaka")] }, { ...emptyMeta(), updatedAt: { osaka: 10 } });
  const local = bookFrom(emptyManual(), emptyMeta());
  const plan = planSync(local, { revision: 4, book: remote });
  assert.equal(plan.upload, false);
  assert.equal(plan.action, "apply");
  assert.equal(plan.book.manual.added[0].id, "osaka");
  assert.equal(isVacant(local), true);
});

test("a brand-new account does not upload an empty book", () => {
  const local = bookFrom(emptyManual(), emptyMeta());
  const plan = planSync(local, { revision: 0, book: null });
  assert.equal(plan.action, "noop");
  assert.equal(plan.upload, false);
});

test("local trips upload when the server book is empty", () => {
  const local = bookFrom({ ...emptyManual(), added: [trip("kyoto", "Kyoto")] }, { ...emptyMeta(), updatedAt: { kyoto: 5 } });
  const plan = planSync(local, { revision: 0, book: null });
  assert.equal(plan.action, "upload");
  assert.equal(plan.book.manual.added[0].title, "Kyoto");
});

test("sign-in keeps both local and server trips", () => {
  const local = bookFrom({ ...emptyManual(), added: [trip("kyoto", "Kyoto")] }, { ...emptyMeta(), updatedAt: { kyoto: 5 } });
  const remote = bookFrom({ ...emptyManual(), added: [trip("osaka", "Osaka")] }, { ...emptyMeta(), updatedAt: { osaka: 8 } });
  const plan = planSync(local, { revision: 2, book: remote });
  const ids = plan.book.manual.added.map((item) => item.id).sort();
  assert.deepEqual(ids, ["kyoto", "osaka"]);
  assert.equal(plan.upload, true);
});

test("a deleted trip stays deleted after the other device syncs", () => {
  const kept = trip("kyoto", "Kyoto");
  const gone = trip("osaka", "Osaka");
  let meta = emptyMeta("a@example.com");
  let manual = { ...emptyManual(), added: [kept, gone] };
  ({ meta } = observeManual(manual, meta, 100));
  manual = { ...emptyManual(), added: [kept] };
  ({ meta } = observeManual(manual, meta, 200));
  assert.equal(meta.tombstones.osaka, 200);
  const local = bookFrom(manual, meta);
  const remote = bookFrom({ ...emptyManual(), added: [kept, gone] }, { ...emptyMeta(), updatedAt: { kyoto: 100, osaka: 100 } });
  const merged = mergeBooks(local, remote);
  assert.deepEqual(merged.manual.added.map((item) => item.id), ["kyoto"]);
  const again = mergeBooks(remote, merged);
  assert.deepEqual(again.manual.added.map((item) => item.id), ["kyoto"]);
});

test("a newer edit wins over an older tombstone", () => {
  const local = bookFrom(emptyManual(), { ...emptyMeta(), tombstones: { osaka: 50 } });
  const remote = bookFrom({ ...emptyManual(), added: [trip("osaka", "Osaka night")] }, { ...emptyMeta(), updatedAt: { osaka: 80 } });
  const merged = mergeBooks(local, remote);
  assert.equal(merged.manual.added[0].title, "Osaka night");
});

test("deal links are prefilled and Kayak Explore is used for anywhere", () => {
  const query = { from: "SMF", to: "HND", depart: "2026-12-01", ret: "2026-12-08" };
  const google = googleFlightsUrl(query);
  assert.match(google, /^https:\/\/www\.google\.com\/travel\/flights\?/);
  assert.match(decodeURIComponent(google), /SMF/);
  assert.match(decodeURIComponent(google), /HND/);
  assert.match(decodeURIComponent(google), /2026-12-01/);
  assert.match(decodeURIComponent(google), /2026-12-08/);
  assert.equal(
    kayakFlightsUrl(query),
    "https://www.kayak.com/flights?origin=SMF&destination=HND&depart_date=2026-12-01&return_date=2026-12-08&sort=bestflight_a",
  );
  assert.equal(skyscannerUrl(query), "https://www.skyscanner.com/transport/flights/smf/hnd/20261201/20261208/");
  assert.equal(kayakExploreUrl({ from: "SFO", depart: "2026-12-01", ret: "2026-12-08" }), "https://www.kayak.com/explore/SFO-anywhere/2026-12-01/2026-12-08");
  assert.match(priceTrackingHint(), /Track prices/);
  assert.equal(googleFlightsUrl({ from: "", to: "Tokyo", depart: "2026-12-01", ret: "" }), googleFlightsUrl({ from: "SMF", to: "Tokyo", depart: "2026-12-01", ret: "" }));
});

test("upcoming trips use the flight airports when they exist", () => {
  const manual = {
    ...emptyManual(),
    added: [
      trip("past", "Past", { startDate: "2020-01-01", endDate: "2020-01-02" }),
      {
        ...trip("next", "Tokyo"),
        items: [
          {
            type: "flight",
            bookingStatus: "confirmed",
            departure: { airportCode: "smf", localTime: "2026-12-01T08:00" },
            arrival: { airportCode: "hnd", localTime: "2026-12-02T12:00" },
          },
        ],
      },
    ],
  };
  const upcoming = upcomingTrips(manual, "2026-10-10");
  assert.deepEqual(upcoming.map((item) => item.id), ["next"]);
  const search = tripSearch(upcoming[0], "SFO");
  assert.equal(search.from, "SMF");
  assert.equal(search.to, "HND");
  assert.equal(search.depart, "2026-12-01");
  assert.equal(search.ret, "2026-12-08");
});

test("signed-in copy names the account and signed-out copy stays on the device", () => {
  assert.equal(accountFacingText(true, DEVICE_CARD, "card"), ACCOUNT_CARD);
  assert.equal(accountFacingText(false, ACCOUNT_CARD, "card"), DEVICE_CARD);
  assert.equal(accountFacingText(true, DEVICE_EYEBROW, "eyebrow"), ACCOUNT_EYEBROW);
  assert.equal(accountFacingText(false, ACCOUNT_EYEBROW, "eyebrow"), DEVICE_EYEBROW);
  assert.equal(accountFacingText(true, DEVICE_FORM, "form"), ACCOUNT_FORM);
  assert.equal(accountFacingText(false, ACCOUNT_FORM, "form"), DEVICE_FORM);
  assert.equal(accountFacingText(true, "Saved on this device. The file copy is unchanged.", "card"), ACCOUNT_CARD);
  assert.equal(accountFacingText(true, "From the trip file.", "card"), ACCOUNT_CARD);
  assert.equal(accountFacingText(false, "From the trip file.", "card"), "From the trip file.");
  assert.equal(accountFacingText(true, "Edit on this device", "card"), "Edit on this device");
  assert.equal(
    shareFacingText(true, "Demo mode keeps this list on this device. Sign in and the invite is stored for their account."),
    SHARE_SIGNED_IN,
  );
  assert.equal(
    shareFacingText(false, "Demo mode keeps this list on this device. Sign in and the invite is stored for their account."),
    SHARE_SIGNED_OUT,
  );
  assert.equal(
    shareFacingText(
      true,
      "Invite a spouse or a kid by email. A viewer can check the packing list. An editor can change the itinerary. They sign in with Google to open the trip.",
    ),
    SHARE_INTRO,
  );
  assert.doesNotMatch(SHARE_SIGNED_IN + SHARE_SIGNED_OUT + SHARE_INTRO, /Demo mode|Sign in with Google/);
  const client = fs.readFileSync(new URL("../assets/sync.js", import.meta.url), "utf8");
  assert.match(client, /Continue without an account/);
  assert.doesNotMatch(client, /Sign in with Google/);
});

test("the public seed and service worker stay safe", () => {
  const bundle = fs.readFileSync(new URL("../assets/index-m7Home27.js", import.meta.url), "utf8");
  assert.match(bundle, /exampleData:!1,note:`This public page does not include a personal itinerary\.[^`]*`\},trips:\[\]/);
  const worker = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(worker, /tripping-shell-v13/);
  assert.doesNotMatch(worker, /client\.navigate/);
  const toml = fs.readFileSync(new URL("../sync-worker/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /database_id = "00000000-0000-0000-0000-000000000000"/);
  assert.match(toml, /database_name = "tripping-sync"/);
  assert.doesNotMatch(fs.readFileSync(new URL("../sync-worker/src/index.ts", import.meta.url), "utf8"), /sk-|api[_-]?key|secret/i);
});
