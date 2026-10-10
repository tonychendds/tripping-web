const base = process.env.SYNC_URL || "http://127.0.0.1:8787";
const origin = "http://127.0.0.1:4173";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(path, options = {}) {
  const headers = { origin, accept: "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, allow: response.headers.get("access-control-allow-origin") };
}

function book(ids, tombstones = {}) {
  return {
    version: 1,
    manual: {
      version: 1,
      added: ids.map((id) => ({ id, title: id, city: id, country: "Japan", startDate: "2026-12-01", endDate: "2026-12-08", items: [] })),
      overrides: {},
      hidden: [],
    },
    tombstones,
    updatedAt: Object.fromEntries(ids.map((id) => [id, 10])),
  };
}

const email = `trip-${Date.now()}@example.com`;
const password = "correct-horse";
const created = await call("/auth/register", { method: "POST", body: { email, password } });
assert(created.status === 201, `register ${created.status} ${JSON.stringify(created.body)}`);
assert(created.allow === origin, `cors ${created.allow}`);
assert(created.body.token && created.body.email === email, "register payload");

const pages = await fetch(`${base}/auth/me`, { headers: { origin: "https://tonychendds.github.io", authorization: `Bearer ${created.body.token}` } });
assert(pages.headers.get("access-control-allow-origin") === "https://tonychendds.github.io", "pages cors");
const stranger = await fetch(`${base}/auth/me`, { headers: { origin: "https://evil.example", authorization: `Bearer ${created.body.token}` } });
assert(stranger.headers.get("access-control-allow-origin") == null, "stranger cors blocked");

const emptyPut = await call("/book", { method: "PUT", token: created.body.token, body: { baseRevision: 0, book: book([]) } });
assert(emptyPut.status === 200, `empty first put ${emptyPut.status}`);
const wiped = await call("/book", {
  method: "PUT",
  token: created.body.token,
  body: { baseRevision: 0, book: book(["should-not-stick"]) },
});
assert(wiped.status === 409, `stale revision ${wiped.status}`);

const saved = await call("/book", { method: "PUT", token: created.body.token, body: { baseRevision: emptyPut.body.revision, book: book(["osaka"]) } });
assert(saved.status === 200 && saved.body.revision === emptyPut.body.revision + 1, `save ${JSON.stringify(saved.body)}`);

const wipe = await call("/book", {
  method: "PUT",
  token: created.body.token,
  body: { baseRevision: saved.body.revision, book: book([]) },
});
assert(wipe.status === 409, `empty wipe ${wipe.status} ${JSON.stringify(wipe.body)}`);
assert(wipe.body.book.manual.added[0].id === "osaka", "wipe kept osaka");

const deleted = await call("/book", {
  method: "PUT",
  token: created.body.token,
  body: { baseRevision: saved.body.revision, book: book([], { osaka: Date.now() }) },
});
assert(deleted.status === 200, `tombstone delete ${deleted.status} ${JSON.stringify(deleted.body)}`);
const after = await call("/book", { token: created.body.token });
assert(after.body.book.manual.added.length === 0, "trip removed");
assert(after.body.book.tombstones.osaka, "tombstone stored");

const again = await call("/auth/register", { method: "POST", body: { email, password } });
assert(again.status === 409, `duplicate register ${again.status}`);
const login = await call("/auth/login", { method: "POST", body: { email, password } });
assert(login.status === 200 && login.body.token, "login");
const me = await call("/auth/me", { token: login.body.token });
assert(me.body.email === email, "me");
const loggedOut = await call("/auth/logout", { method: "POST", token: login.body.token });
assert(loggedOut.status === 200, "logout");
const dead = await call("/book", { token: login.body.token });
assert(dead.status === 401, "logged out token");

console.log("worker api ok", email);
