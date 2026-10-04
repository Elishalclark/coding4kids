// ───────────────────────── My Day ─────────────────────────
// A standalone bell-schedule / days-off dashboard. Fully separate from KidVibers:
// no accounts, no login, no shared data with the `users` table. A "class" is just
// a name + a recovery key (shown once, hashed like a password) that lets its owner
// come back and edit the schedule. Students never need the recovery key - only the
// short weekly code the owner shares, which only grants read-only viewing and
// rotates every Monday so it doesn't work forever once shared around.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
function bytesToHex(b) { return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
function randHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return bytesToHex(b); }
function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }

const PBKDF2_ITERS = 100000;
async function pbkdf2Hex(secret, saltHex) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERS, hash: "SHA-256" }, km, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function hashSecret(secret) { const salt = randHex(16); return { hash: await pbkdf2Hex(secret, salt), salt }; }
async function verifySecret(secret, saltHex, expected) {
  if (!saltHex || !expected) return false;
  const h = await pbkdf2Hex(secret, saltHex);
  if (h.length !== expected.length) return false;
  let diff = 0; for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I - easy to read aloud
// 4 digits, easy to read aloud and type on a phone keypad - these are low-stakes,
// view-only codes (not a password), so the smaller 10,000-combo space is fine.
function genWeeklyCode() {
  const b = new Uint32Array(1); crypto.getRandomValues(b);
  return String(b[0] % 10000).padStart(4, "0");
}
function genRecoveryKey() {
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let s = ""; const b = new Uint8Array(4); crypto.getRandomValues(b);
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
    groups.push(s);
  }
  return groups.join("-");
}
function weekKeyFor(d) {
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday.toISOString().slice(0, 10);
}

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS myday_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_salt TEXT NOT NULL,
      weekly_code TEXT,
      weekly_code_week TEXT,
      data_json TEXT,
      tour_done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_myday_weekly_code ON myday_classes (weekly_code, weekly_code_week)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS myday_ratelimit (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start TEXT NOT NULL
    )`),
  ]);
  // SQLite has no ADD COLUMN IF NOT EXISTS - already-deployed tables (created before this
  // column existed) get it added here; the "duplicate column" failure on every run after
  // the first is expected and ignored.
  try { await env.DB.prepare("ALTER TABLE myday_classes ADD COLUMN tour_done INTEGER NOT NULL DEFAULT 0").run(); } catch {}
}

async function rateLimited(env, key, max, windowSec) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, window_start FROM myday_ratelimit WHERE key=?").bind(key).first();
  if (!row || now - new Date(row.window_start).getTime() > windowSec * 1000) {
    await env.DB.prepare("INSERT INTO myday_ratelimit (key,count,window_start) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1, window_start=excluded.window_start")
      .bind(key, new Date(now).toISOString()).run();
    return false;
  }
  if (row.count >= max) return true;
  await env.DB.prepare("UPDATE myday_ratelimit SET count=count+1 WHERE key=?").bind(key).run();
  return false;
}

async function genUniqueWeeklyCode(env, week) {
  for (let tries = 0; tries < 50; tries++) {
    const code = genWeeklyCode();
    const exists = await env.DB.prepare("SELECT 1 FROM myday_classes WHERE weekly_code=? AND weekly_code_week=?").bind(code, week).first();
    if (!exists) return code;
  }
  return genWeeklyCode() + randHex(1).toUpperCase();
}

async function apiCreateClass(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, `myday:create:${ip}`, 8, 3600))
    return json({ error: "Too many classes created from here recently. Try again later." }, 429);
  const name = (data.name || "").trim().slice(0, 80);
  if (!name) return json({ error: "Give your class a name." }, 400);
  const key = genRecoveryKey();
  const { hash, salt } = await hashSecret(key);
  const r = await env.DB.prepare("INSERT INTO myday_classes (name,key_hash,key_salt,created_at) VALUES (?,?,?,?)")
    .bind(name, hash, salt, nowIso()).run();
  return json({ ok: true, id: r.meta.last_row_id, recoveryKey: key });
}

// Recovery keys are hashed, so there's no direct lookup column - the key is the only
// credential the owner has to remember, so we scan and check each hash. Fine at this
// scale (a personal/small-school tool, not a multi-tenant SaaS with thousands of rows).
async function findClassForKey(env, key) {
  if (!key) return null;
  const rows = (await env.DB.prepare("SELECT * FROM myday_classes").all()).results || [];
  for (const row of rows) {
    if (await verifySecret(key, row.key_salt, row.key_hash)) return row;
  }
  return null;
}

async function apiManageGet(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, `myday:auth:${ip}`, 20, 600))
    return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const row = await findClassForKey(env, data.key);
  if (!row) return json({ error: "That recovery key wasn't found." }, 401);
  let parsed = null; if (row.data_json) { try { parsed = JSON.parse(row.data_json); } catch {} }
  return json({ ok: true, name: row.name, data: parsed, weeklyCode: row.weekly_code, weeklyCodeWeek: row.weekly_code_week, tourDone: !!row.tour_done });
}

async function apiManageSave(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, `myday:auth:${ip}`, 20, 600))
    return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const row = await findClassForKey(env, data.key);
  if (!row) return json({ error: "That recovery key wasn't found." }, 401);
  const payload = JSON.stringify(data.data || {});
  if (payload.length > 40000) return json({ error: "That's too much to save - trim it down a bit." }, 400);
  await env.DB.prepare("UPDATE myday_classes SET data_json=? WHERE id=?").bind(payload, row.id).run();
  return json({ ok: true });
}

// Marks the mandatory first-time tour as seen, so it only ever blocks the owner once per
// class - never shown to students (they never have the recovery key to call this).
async function apiManageTourDone(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, `myday:auth:${ip}`, 20, 600))
    return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const row = await findClassForKey(env, data.key);
  if (!row) return json({ error: "That recovery key wasn't found." }, 401);
  await env.DB.prepare("UPDATE myday_classes SET tour_done=1 WHERE id=?").bind(row.id).run();
  return json({ ok: true });
}

async function apiManageCode(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, `myday:auth:${ip}`, 20, 600))
    return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const row = await findClassForKey(env, data.key);
  if (!row) return json({ error: "That recovery key wasn't found." }, 401);
  const wk = weekKeyFor(new Date());
  if (row.weekly_code_week !== wk || !row.weekly_code) {
    const code = await genUniqueWeeklyCode(env, wk);
    await env.DB.prepare("UPDATE myday_classes SET weekly_code=?, weekly_code_week=? WHERE id=?").bind(code, wk, row.id).run();
    return json({ ok: true, weeklyCode: code, week: wk });
  }
  return json({ ok: true, weeklyCode: row.weekly_code, week: wk });
}

async function apiView(env, request) {
  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, `myday:view:${ip}`, 30, 600))
    return json({ error: "Too many attempts. Wait a few minutes." }, 429);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase().replace(/ /g, "");
  if (!code) return json({ error: "Enter this week's code." }, 400);
  const wk = weekKeyFor(new Date());
  const row = await env.DB.prepare("SELECT * FROM myday_classes WHERE weekly_code=? AND weekly_code_week=?").bind(code, wk).first();
  if (!row) return json({ error: "That code is wrong or expired - ask for this week's code." }, 404);
  let parsed = null; if (row.data_json) { try { parsed = JSON.parse(row.data_json); } catch {} }
  return json({ ok: true, name: row.name, data: parsed });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      await ensureSchema(env);
      const method = request.method;
      let data = {};
      if (method === "POST") { try { data = await request.json(); } catch { data = {}; } }
      try {
        if (path === "/api/myday/classes" && method === "POST") return await apiCreateClass(env, request, data);
        if (path === "/api/myday/manage/get" && method === "POST") return await apiManageGet(env, request, data);
        if (path === "/api/myday/manage/save" && method === "POST") return await apiManageSave(env, request, data);
        if (path === "/api/myday/manage/code" && method === "POST") return await apiManageCode(env, request, data);
        if (path === "/api/myday/manage/tour-done" && method === "POST") return await apiManageTourDone(env, request, data);
        if (path === "/api/myday/view" && method === "GET") return await apiView(env, request);
        return json({ error: "Not found." }, 404);
      } catch (e) {
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
