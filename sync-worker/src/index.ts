const PAGES_ORIGIN = "https://tonychendds.github.io";
const PBKDF2_ITERATIONS = 100_000;
const MAX_BODY_BYTES = 1_500_000;

interface Env {
  DB: D1Database;
}

interface D1Statement {
  bind(...values: Array<string | number | null>): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1Statement;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  password_salt: string;
}

interface BookRow {
  payload: string;
  revision: number;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return cors(request, new Response(null, { status: 204 }));
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/auth/register") return cors(request, await register(request, env));
      if (request.method === "POST" && url.pathname === "/auth/login") return cors(request, await login(request, env));
      if (request.method === "POST" && url.pathname === "/auth/logout") return cors(request, await logout(request, env));
      if (request.method === "GET" && url.pathname === "/auth/me") return cors(request, await me(request, env));
      if (request.method === "GET" && url.pathname === "/book") return cors(request, await readBook(request, env));
      if (request.method === "PUT" && url.pathname === "/book") return cors(request, await writeBook(request, env));
      return cors(request, json({ error: "Not found." }, 404));
    } catch {
      return cors(request, json({ error: "The sync server could not finish that request." }, 500));
    }
  },
};

export default worker;

function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === PAGES_ORIGIN) return origin;
  try {
    const url = new URL(origin);
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (local) return origin;
  } catch {
    return null;
  }
  return null;
}

function cors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const origin = allowedOrigin(request.headers.get("Origin"));
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function register(request: Request, env: Env): Promise<Response> {
  const credentials = await readCredentials(request);
  if (!credentials.ok) return json({ error: credentials.error }, 400);
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(credentials.email).first<{ id: string }>();
  if (existing) return json({ error: "An account with that email already exists." }, 409);
  const { hash, salt } = await hashPassword(credentials.password);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, credentials.email, hash, salt, Date.now())
    .run();
  const token = await createSession(env, id);
  return json({ token, email: credentials.email }, 201);
}

async function login(request: Request, env: Env): Promise<Response> {
  const credentials = await readCredentials(request);
  if (!credentials.ok) return json({ error: credentials.error }, 400);
  const user = await env.DB.prepare("SELECT id, email, password_hash, password_salt FROM users WHERE email = ?")
    .bind(credentials.email)
    .first<UserRow>();
  if (!user || !(await verifyPassword(credentials.password, user.password_salt, user.password_hash))) {
    return json({ error: "Email or password does not match." }, 401);
  }
  const token = await createSession(env, user.id);
  return json({ token, email: user.email });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const userId = await userIdFromRequest(request, env);
  if (!userId) return json({ error: "Sign in again." }, 401);
  const token = bearer(request);
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  }
  return json({ ok: true });
}

async function me(request: Request, env: Env): Promise<Response> {
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "Sign in again." }, 401);
  return json({ email: user.email });
}

async function readBook(request: Request, env: Env): Promise<Response> {
  const userId = await userIdFromRequest(request, env);
  if (!userId) return json({ error: "Sign in again." }, 401);
  const row = await env.DB.prepare("SELECT payload, revision FROM books WHERE user_id = ?").bind(userId).first<BookRow>();
  if (!row) return json({ revision: 0, book: null });
  try {
    return json({ revision: row.revision, book: JSON.parse(row.payload) });
  } catch {
    return json({ error: "The stored book could not be read." }, 500);
  }
}

async function writeBook(request: Request, env: Env): Promise<Response> {
  const userId = await userIdFromRequest(request, env);
  if (!userId) return json({ error: "Sign in again." }, 401);
  const parsed = await readBookBody(request);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const current = await env.DB.prepare("SELECT payload, revision FROM books WHERE user_id = ?").bind(userId).first<BookRow>();
  if (!current) {
    if (parsed.baseRevision !== 0) return json({ error: "The book changed on the server. Merge and try again.", revision: 0, book: null }, 409);
    await env.DB.prepare("INSERT INTO books (user_id, payload, revision, updated_at) VALUES (?, ?, 1, ?)")
      .bind(userId, JSON.stringify(parsed.book), Date.now())
      .run();
    return json({ revision: 1 });
  }
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(current.payload) as Record<string, unknown>;
  } catch {
    return json({ error: "The stored book could not be read." }, 500);
  }
  if (current.revision !== parsed.baseRevision) {
    return json({ error: "The book changed on the server. Merge and try again.", revision: current.revision, book: stored }, 409);
  }
  if (dropsTripsWithoutTombstones(stored, parsed.book)) {
    return json({
      error: "Refusing to drop trips that were not deleted.",
      revision: current.revision,
      book: stored,
    }, 409);
  }
  const result = await env.DB.prepare(
    "UPDATE books SET payload = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
  )
    .bind(JSON.stringify(parsed.book), Date.now(), userId, parsed.baseRevision)
    .run();
  if (changesOf(result) !== 1) {
    const again = await env.DB.prepare("SELECT payload, revision FROM books WHERE user_id = ?").bind(userId).first<BookRow>();
    let book: unknown = null;
    if (again) {
      try {
        book = JSON.parse(again.payload);
      } catch {
        book = null;
      }
    }
    return json({ error: "The book changed on the server. Merge and try again.", revision: again?.revision ?? 0, book }, 409);
  }
  return json({ revision: parsed.baseRevision + 1 });
}

function tripIds(book: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const manual = book.manual;
  if (!manual || typeof manual !== "object" || Array.isArray(manual)) return ids;
  const record = manual as Record<string, unknown>;
  if (Array.isArray(record.added)) {
    for (const trip of record.added) {
      if (trip && typeof trip === "object" && !Array.isArray(trip)) {
        const id = (trip as Record<string, unknown>).id;
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  }
  if (record.overrides && typeof record.overrides === "object" && !Array.isArray(record.overrides)) {
    for (const id of Object.keys(record.overrides as Record<string, unknown>)) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

function tombstoneIds(book: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const tombstones = book.tombstones;
  if (!tombstones || typeof tombstones !== "object" || Array.isArray(tombstones)) return ids;
  for (const [id, when] of Object.entries(tombstones as Record<string, unknown>)) {
    if (id && typeof when === "number" && Number.isFinite(when)) ids.add(id);
  }
  return ids;
}

function dropsTripsWithoutTombstones(existing: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const next = tripIds(incoming);
  const tombs = tombstoneIds(incoming);
  for (const id of tripIds(existing)) {
    if (!next.has(id) && !tombs.has(id)) return true;
  }
  return false;
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), userId, Date.now())
    .run();
  return token;
}

async function userIdFromRequest(request: Request, env: Env): Promise<string | null> {
  const token = bearer(request);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function userFromRequest(request: Request, env: Env): Promise<UserRow | null> {
  const userId = await userIdFromRequest(request, env);
  if (!userId) return null;
  return env.DB.prepare("SELECT id, email, password_hash, password_salt FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+([A-Fa-f0-9]{64})$/.exec(header);
  return match ? match[1] : null;
}

async function readCredentials(request: Request): Promise<{ ok: true; email: string; password: string } | { ok: false; error: string }> {
  const body = await readObject(request);
  if (!body.ok) return body;
  const email = typeof body.value.email === "string" ? body.value.email.trim().toLowerCase() : "";
  const password = typeof body.value.password === "string" ? body.value.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (password.length < 8 || password.length > 200) {
    return { ok: false, error: "Password must be 8 to 200 characters." };
  }
  return { ok: true, email, password };
}

async function readBookBody(
  request: Request,
): Promise<{ ok: true; baseRevision: number; book: Record<string, unknown> } | { ok: false; error: string }> {
  const body = await readObject(request);
  if (!body.ok) return body;
  const baseRevision = body.value.baseRevision;
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 0) {
    return { ok: false, error: "The book revision is missing." };
  }
  const book = body.value.book;
  if (!book || typeof book !== "object" || Array.isArray(book)) return { ok: false, error: "The book is missing." };
  const record = book as Record<string, unknown>;
  const manual = record.manual;
  if (!manual || typeof manual !== "object" || Array.isArray(manual)) return { ok: false, error: "The book is missing its trips." };
  const manualRecord = manual as Record<string, unknown>;
  if (!Array.isArray(manualRecord.added) || manualRecord.version !== 1) {
    return { ok: false, error: "The book is missing its trips." };
  }
  if (record.tombstones != null && (typeof record.tombstones !== "object" || Array.isArray(record.tombstones))) {
    return { ok: false, error: "Deleted trips were not readable." };
  }
  return { ok: true, baseRevision, book: record };
}

async function readObject(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return { ok: false, error: "That request is too large." };
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Expected a JSON object." };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Expected JSON." };
  }
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, saltBytes);
  return { hash: bytesToHex(hash), salt: bytesToHex(saltBytes) };
}

async function verifyPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  const salt = hexToBytes(saltHex);
  if (!salt) return false;
  const actual = bytesToHex(await pbkdf2(password, salt));
  return constantEqual(actual, hashHex);
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function constantEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function changesOf(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const meta = (result as { meta?: { changes?: number } }).meta;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}
