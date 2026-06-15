// KidVibers - Cloudflare Worker backend (port of the Python server).
// Phase 2: foundation + accounts/login/sessions. Other endpoints are added in stages;
// any route not yet ported returns a friendly 503 so the static pages still load.

// ───────────────────────── constants (mirror server.py) ─────────────────────────
const TRIAL_DAYS = 3;
const COPPA_AGE = 13;
const STARTER_TOKENS = 40;
const ADMIN_ROLES = ["admin", "super_admin"];
const DISTRICT_PLANS = ["school", "district"];
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const DEFAULT_PLAN_SETTINGS = {
  free:   { ai: false, chatsPerDay: 0,   lessonLimit: 3 },
  trial:  { ai: false, chatsPerDay: 0,   lessonLimit: 5 },
  pro:    { ai: true,  chatsPerDay: 100, lessonLimit: -1 },
  family: { ai: true,  chatsPerDay: -1,  lessonLimit: -1 },
};
const TEACHER_PLANS = {
  teacher:  { label: "Teacher Plan",  price: 24,  students: 100 },
  school:   { label: "School Plan",   price: 136, students: 550 },
  district: { label: "District Plan", price: 150, students: -1 },
};
const NO_TEACHER_PLAN = { label: "No plan yet", price: 0, students: 0 };
const DEFAULT_AVATAR = { face: "face_kid", hat: null, accessory: null, clothing: null, companion: null, background: "bg_purple" };
const FREE_ITEMS = ["face_kid", "bg_purple"];

// ───────────────────────── small utils ─────────────────────────
function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function cleanName(s) { return (s || "").replace(/[<>]/g, "").trim(); }

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randHex(nbytes) {
  const b = new Uint8Array(nbytes); crypto.getRandomValues(b); return bytesToHex(b);
}
function randToken(nbytes) {
  const b = new Uint8Array(nbytes); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// PBKDF2-SHA256, hex salt, 32-byte key. Cloudflare Workers cap iterations at 100k
// (the Python server used 200k), so accounts created here use 100k. Existing accounts
// migrated from the Python DB will reset their password at cutover.
const PBKDF2_ITERS = 100000;
async function pbkdf2Hex(password, saltHex) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERS, hash: "SHA-256" }, km, 256);
  return bytesToHex(new Uint8Array(bits));
}
async function hashPassword(password, saltHex) {
  const salt = saltHex || randHex(16);
  return { hash: await pbkdf2Hex(password, salt), salt };
}
async function verifyPassword(password, saltHex, expected) {
  if (!saltHex || !expected) return false;
  const h = await pbkdf2Hex(password, saltHex);
  // constant-time-ish compare
  if (h.length !== expected.length) return false;
  let diff = 0; for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ───────────────────────── responses ─────────────────────────
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

// ───────────────────────── settings ─────────────────────────
async function getSetting(env, key, dflt) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  if (!row) return dflt;
  try { return JSON.parse(row.value); } catch { return dflt; }
}
async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, JSON.stringify(value)).run();
}
async function authEnabled(env, kind) {
  const v = await getSetting(env, kind + "_enabled", true);
  return !!v;
}
async function getPlanSettings(env) {
  return await getSetting(env, "plan_settings", DEFAULT_PLAN_SETTINGS);
}

// ───────────────────────── plan helpers ─────────────────────────
function trialDaysLeft(user) {
  if (user.plan !== "trial" || !user.trial_ends) return null;
  const ends = new Date(user.trial_ends.replace("Z", "Z"));
  if (isNaN(ends)) return 0;
  const ms = ends - new Date();
  if (ms <= 0) return 0;
  return Math.max(0, Math.ceil(ms / 86400000));
}
function effectivePlan(user) {
  if (user.plan === "trial") {
    const left = trialDaysLeft(user);
    if (left !== null && left <= 0) return "free";
  }
  return user.plan;
}
function planCfg(settings, plan) {
  return settings[plan] || { ai: false, chatsPerDay: 0, lessonLimit: -1 };
}
function teacherPlanCfg(plan) { return TEACHER_PLANS[plan] || NO_TEACHER_PLAN; }

async function unitsPassed(env, userId) {
  const r = await env.DB.prepare("SELECT unit FROM unit_tests WHERE user_id=? AND passed=1 ORDER BY unit").bind(userId).all();
  return (r.results || []).map((x) => x.unit);
}
async function chatsUsedToday(env, userId) {
  const row = await env.DB.prepare("SELECT count FROM chat_usage WHERE user_id=? AND day=?").bind(userId, todayStr()).first();
  return row ? row.count : 0;
}
async function lessonsDoneCount(env, userId) {
  const row = await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(userId).first();
  return row ? row.c : 0;
}
async function studentsInFamily(env, familyId) {
  if (familyId == null) return 0;
  const row = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE role='kid' AND family_id=?").bind(familyId).first();
  return row ? row.c : 0;
}
async function familyBranding(env, familyId) {
  if (familyId == null) return { brandName: null, brandLogo: null };
  const row = await env.DB.prepare("SELECT brand_name, brand_logo FROM users WHERE id=?").bind(familyId).first();
  if (!row) return { brandName: null, brandLogo: null };
  return { brandName: row.brand_name ?? null, brandLogo: row.brand_logo ?? null };
}
async function familyGroup(env, familyId) {
  if (familyId == null) return {};
  const row = await env.DB.prepare("SELECT role, plan, school, brand_name FROM users WHERE id=?").bind(familyId).first();
  if (!row || row.role !== "teacher") return {};
  const label = row.plan === "district" ? "District" : row.plan === "school" ? "School" : "Classroom";
  const name = row.brand_name || row.school || label;
  return { groupLabel: label, groupName: name };
}

// ───────────────────────── public user (faithful port) ─────────────────────────
async function publicUser(env, user) {
  if (!user) return null;
  const settings = await getPlanSettings(env);
  const eff = effectivePlan(user);
  const cfg = planCfg(settings, eff);
  const up = user.role === "kid" ? await unitsPassed(env, user.id) : [];
  let avatar, owned;
  try { avatar = JSON.parse(user.avatar || "null") || { ...DEFAULT_AVATAR }; } catch { avatar = { ...DEFAULT_AVATAR }; }
  try { owned = JSON.parse(user.owned_items || "null") || [...FREE_ITEMS]; } catch { owned = [...FREE_ITEMS]; }
  const cstatus = user.consent_status ?? "not_required";

  let teacher = {};
  if (user.role === "teacher") {
    const tp = teacherPlanCfg(user.plan);
    teacher = {
      teacherPlan: user.plan || "none", teacherPlanLabel: tp.label,
      studentLimit: tp.students, studentsUsed: await studentsInFamily(env, user.family_id),
      isDistrict: DISTRICT_PLANS.includes(user.plan),
      classCode: user.class_code ?? null,
      brandName: user.brand_name ?? null, brandLogo: user.brand_logo ?? null,
    };
  }
  const kidBrand = user.role === "kid" ? await familyBranding(env, user.family_id) : {};
  const kidGroup = user.role === "kid" ? await familyGroup(env, user.family_id) : {};

  return {
    id: user.id, role: user.role, name: user.name, username: user.username,
    plan: user.plan, effectivePlan: eff, trialDaysLeft: trialDaysLeft(user),
    ...teacher,
    hasAI: !!cfg.ai, chatsPerDay: cfg.chatsPerDay | 0, chatsUsedToday: await chatsUsedToday(env, user.id),
    lessonLimit: cfg.lessonLimit | 0, lessonsDone: await lessonsDoneCount(env, user.id),
    unitsPassed: up, level: up.length + 1,
    tokens: user.tokens ?? 0, avatar, ownedItems: owned,
    linkToken: user.link_token ?? null, parentEmail: user.parent_email ?? null,
    ageBand: user.age_band, ageYears: user.age_years ?? null, familyId: user.family_id,
    consentStatus: cstatus, consentMethod: user.consent_method ?? null,
    needsConsent: user.role === "kid" && cstatus === "pending",
    school: user.school ?? null,
    suspended: !!(user.suspended),
    hasBilling: !!(user.stripe_customer_id),
    quizDone: !!(user.quiz_done),
    quizLevel: user.quiz_level ?? null,
    recommendedPlan: user.quiz_plan ?? null,
    startUnit: user.start_unit ?? null,
    ...kidBrand,
    ...kidGroup,
  };
}

// ───────────────────────── sessions ─────────────────────────
function bearer(request) {
  const a = request.headers.get("Authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7).trim() : null;
}
async function userFromToken(env, token) {
  if (!token) return null;
  return await env.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?").bind(token).first();
}
async function createSession(env, userId) {
  const token = randToken(32);
  await env.DB.prepare("INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)").bind(token, userId, nowIso()).run();
  return token;
}

// ───────────────────────── login brute-force guard (best-effort, per isolate) ─────────────────────────
const loginFails = new Map();
function tooManyLogins(key) {
  const e = loginFails.get(key);
  return !!(e && e.count >= 8 && Date.now() - e.first < 15 * 60 * 1000);
}
function recordLoginFail(key) {
  let e = loginFails.get(key) || { count: 0, first: Date.now() };
  if (Date.now() - e.first > 15 * 60 * 1000) e = { count: 0, first: Date.now() };
  e.count++; loginFails.set(key, e);
}
function clearLoginFails(key) { loginFails.delete(key); }

function suspensionStatus(user) {
  if (!user.suspended) return [false, null];
  const until = user.suspend_until;
  if (until) {
    const ends = new Date(until.replace("Z", "Z"));
    if (!isNaN(ends) && new Date() >= ends) return [false, until];
  }
  return [true, until];
}

function validateCredentials(name, username, password) {
  if (!name || !username || !password) return "Name, username and password are required.";
  if (name.length > 60) return "Name is too long (max 60 characters).";
  if (!USERNAME_RE.test(username)) return "Username must be 3-20 letters, numbers or underscores.";
  if (password.length < 6) return "Password must be at least 6 characters.";
  if (password.length > 200) return "Password is too long.";
  return null;
}

// ───────────────────────── endpoints ─────────────────────────
async function apiMe(env, request) {
  const user = await userFromToken(env, bearer(request));
  if (!user) return json({ error: "not logged in" }, 401);
  return json({ user: await publicUser(env, user) });
}

async function apiLogin(env, request, data, allow) {
  const username = (data.username || "").trim();
  const password = data.password || "";
  const key = username.toLowerCase();
  if (tooManyLogins(key)) return json({ error: "Too many login attempts. Please wait a few minutes and try again." }, 429);
  const row = await env.DB.prepare("SELECT * FROM users WHERE username=?").bind(username).first();
  if (!row || !(await verifyPassword(password, row.salt, row.password_hash))) {
    recordLoginFail(key);
    return json({ error: "Wrong username or password." }, 401);
  }
  if (!allow.includes(row.role)) return json({ error: "Those credentials can't be used here." }, 403);
  if (!(await authEnabled(env, "logins")) && !ADMIN_ROLES.includes(row.role))
    return json({ error: "Logins are temporarily disabled. Please check back soon." }, 403);
  const [active, until] = suspensionStatus(row);
  if (!active && row.suspended) {
    await env.DB.prepare("UPDATE users SET suspended=0, suspend_reason=NULL, suspend_until=NULL WHERE id=?").bind(row.id).run();
  } else if (active) {
    clearLoginFails(key);
    let msg = "This account has been suspended by an administrator.";
    if (row.suspend_reason) msg += ` Reason: ${row.suspend_reason}`;
    msg += until ? ` It will be reinstated on ${until.slice(0, 16).replace("T", " ")} UTC.` : " Please contact kidvibers.help@outlook.com.";
    return json({ error: msg, suspended: true }, 403);
  }
  clearLoginFails(key);
  const token = await createSession(env, row.id);
  return json({ token, user: await publicUser(env, row) });
}

async function apiLogout(env, request) {
  const token = bearer(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run();
  return json({ ok: true });
}

async function createUser(env, opts) {
  const name = cleanName(opts.name);
  const school = opts.school ? cleanName(opts.school) : opts.school ?? null;
  const { hash, salt } = await hashPassword(opts.password);
  const linkToken = randToken(8);
  const avatar = JSON.stringify(DEFAULT_AVATAR);
  const owned = JSON.stringify(FREE_ITEMS);
  try {
    const res = await env.DB.prepare(
      "INSERT INTO users (role,name,username,password_hash,salt,parent_email,age_band,age_years,plan,trial_ends,family_id," +
      "tokens,avatar,owned_items,link_token,consent_status,consent_method,consent_by,consent_token,school,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      opts.role, name, opts.username, hash, salt, opts.email || "", opts.age || "", opts.age_years ?? null,
      opts.plan, opts.trial_ends ?? null, opts.family_id ?? null, STARTER_TOKENS, avatar, owned, linkToken,
      opts.consent_status || "not_required", opts.consent_method ?? null, opts.consent_by ?? null,
      opts.consent_token ?? null, school, nowIso()
    ).run();
    const uid = res.meta.last_row_id;
    const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
    return { uid, row };
  } catch (e) {
    if (String(e.message || e).includes("UNIQUE")) return { error: "That username is already taken.", status: 409 };
    throw e;
  }
}

async function apiSignup(env, request, data) {
  if (!(await authEnabled(env, "signups"))) return json({ error: "Sign-ups are temporarily disabled. Please check back soon." }, 403);
  const name = (data.name || "").trim();
  const username = (data.username || "").trim();
  const password = data.password || "";
  const email = (data.parentEmail || "").trim();
  const ageBand = (data.ageBand || "").trim();
  let ageYears = null;
  if (data.age !== undefined && data.age !== "" && data.age !== null) { const n = parseInt(data.age, 10); if (!isNaN(n)) ageYears = n; }
  const err = validateCredentials(name, username, password);
  if (err) return json({ error: err }, 400);
  const needsConsent = ageYears !== null && ageYears < COPPA_AGE;
  const consentToken = needsConsent ? randToken(10) : null;
  const consentStatus = needsConsent ? "pending" : "not_required";
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
  const r = await createUser(env, {
    role: "kid", name, username, password, email, age: ageBand, age_years: ageYears, plan: "trial",
    trial_ends: trialEnds, consent_status: consentStatus, consent_token: consentToken,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  const origin = new URL(request.url).origin;
  const inviteUrl = `${origin}/index.html?plink=${r.row.link_token}`;
  if (email) {
    const inviteBody = `${name} just joined KidVibers! Tap "Sign My Kid and Myself Up" to create your parent account and connect to ${name}: ${inviteUrl}`;
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)")
      .bind(email, "parent_invite", inviteBody, r.uid, r.row.link_token, nowIso()).run();
    if (needsConsent) {
      const consentUrl = `${origin}/index.html?consent=${consentToken}`;
      const consentBody = `Parental consent needed: ${name} (under 13) wants to use KidVibers. Please review and approve: ${consentUrl}`;
      await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)")
        .bind(email, "consent_request", consentBody, r.uid, consentToken, nowIso()).run();
    }
  }
  const token = await createSession(env, r.uid);
  return json({
    token, user: await publicUser(env, r.row),
    inviteToken: r.row.link_token, inviteUrl, parentEmail: email,
    needsConsent, consentToken,
  });
}

// ───────────────────────── router ─────────────────────────
const PORTED_503 = "This part of KidVibers is still moving to Cloudflare. Try again soon!";

async function handleApi(env, request, path) {
  const method = request.method;
  let data = {};
  if (method === "POST") { try { data = await request.json(); } catch { data = {}; } }

  // public GETs
  if (path === "/api/site-config" && method === "GET")
    return json({ signupsEnabled: await authEnabled(env, "signups"), loginsEnabled: await authEnabled(env, "logins"), stripeEnabled: !!env.STRIPE_SECRET_KEY });
  if (path === "/api/site-message" && method === "GET") {
    const m = await getSetting(env, "site_message", {});
    return json({ text: m.text || "", active: !!m.active });
  }
  if (path === "/api/me" && method === "GET") return apiMe(env, request);

  // auth POSTs
  if (path === "/api/signup" && method === "POST") return apiSignup(env, request, data);
  if (path === "/api/login" && method === "POST") return apiLogin(env, request, data, ["kid", "parent", "teacher", "admin", "super_admin"]);
  if (path === "/api/admin/login" && method === "POST") return apiLogin(env, request, data, ADMIN_ROLES);
  if (path === "/api/logout" && method === "POST") return apiLogout(env, request);

  // not yet ported
  return json({ error: PORTED_503 }, 503);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(env, request, url.pathname); }
      catch (e) { console.log("api error:", e && e.stack || e); return json({ error: "Something went wrong. Please try again." }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
