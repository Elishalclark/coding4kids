// KidVibers - Cloudflare Worker backend (port of the Python server).
// Foundation + accounts + lessons. Other endpoints are added in stages;
// any route not yet ported returns a friendly 503 so the static pages still load.

import WORLDS from "./worlds.json";
import SHOP_ITEMS from "./shop.json";
const UNIT_NAMES = Object.fromEntries(Object.entries(WORLDS).map(([u, w]) => [u, `${w.emoji} ${w.name}`]));
const SHOP_BY_ID = Object.fromEntries(SHOP_ITEMS.map((i) => [i.id, i]));

// ───────────────────────── constants (mirror server.py) ─────────────────────────
const TRIAL_DAYS = 3;
const COPPA_AGE = 13;
const STARTER_TOKENS = 40;
const TOKENS_PER_LESSON = 10;
const PASS_PERCENT = 70;
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
async function sha256hex(s) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
function parseCookies(str) {
  const out = {};
  (str || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function stagingPasswordPage(msg) {
  const err = msg ? `<p style="color:#ff8a8a;font-size:0.82rem;margin-top:10px;">${msg}</p>` : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>KidVibers Staging</title></head>` +
    `<body style="font-family:system-ui,'Nunito',sans-serif;background:#0c0a18;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">` +
    `<form method="POST" action="/__unlock" style="background:#171327;border:1px solid #3a2f63;border-radius:18px;padding:34px 30px;width:300px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);">` +
    `<div style="font-size:2.6rem;">🔒</div><h1 style="font-size:1.2rem;font-weight:900;margin:8px 0;">KidVibers Staging</h1>` +
    `<p style="color:#bdb6d6;font-size:0.85rem;margin-bottom:6px;">Private preview - enter the password.</p>` +
    `<input name="pw" type="password" autofocus placeholder="Password" style="width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #3a2f63;background:#08060f;color:#fff;font-weight:700;margin:10px 0;">` +
    `<button style="width:100%;padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#7c5cff,#b14cff);color:#fff;font-weight:900;cursor:pointer;">Unlock →</button>${err}</form></body></html>`,
    { status: msg ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
async function stagingGate(env, request) {
  const url = new URL(request.url);
  const expected = await sha256hex("kidvibers-stg-v1:" + (env.STAGING_PASS || ""));
  if (url.pathname === "/__unlock" && request.method === "POST") {
    let pw = "";
    try { pw = (await request.formData()).get("pw") || ""; } catch (e) {}
    if (pw === (env.STAGING_PASS || "")) {
      return new Response("", { status: 302, headers: { Location: "/", "Set-Cookie": `stg_ok=${expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800` } });
    }
    return stagingPasswordPage("Wrong password - try again.");
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  if (cookies.stg_ok === expected) return null;   // already unlocked
  return stagingPasswordPage();
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

// ───────────────────────── lessons / progress / boss battles ─────────────────────────
function consentOk(user) {
  if (user.role !== "kid") return true;
  return ["granted", "not_required"].includes(user.consent_status ?? "not_required");
}
async function getPassPercent(env) {
  const v = await getSetting(env, "pass_percent", PASS_PERCENT);
  const n = parseInt(v, 10);
  return isNaN(n) ? PASS_PERCENT : n;
}
function lessonLimitFor(settings, user) {
  return planCfg(settings, effectivePlan(user)).lessonLimit | 0;
}
function lessonPublic(r) {
  let quiz = {}, steps = [];
  try { quiz = JSON.parse(r.quiz || "{}"); } catch {}
  try { steps = JSON.parse(r.steps || "[]"); } catch {}
  return {
    id: r.id, position: r.position, emoji: r.emoji, title: r.title, blurb: r.blurb,
    level: r.level, xp: r.xp, published: !!r.published, unit: r.unit ?? 1, steps, quiz,
  };
}

async function apiLessons(env) {
  const r = await env.DB.prepare("SELECT * FROM lessons WHERE published=1 ORDER BY position, id").all();
  return json({
    lessons: (r.results || []).map(lessonPublic),
    unitNames: UNIT_NAMES, worlds: WORLDS, passPercent: await getPassPercent(env),
  });
}

async function apiProgressGet(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const rows = (await env.DB.prepare("SELECT lesson_id FROM progress WHERE user_id=?").bind(u.id).all()).results || [];
  const tests = (await env.DB.prepare("SELECT unit,passed,best_score,attempts FROM unit_tests WHERE user_id=?").bind(u.id).all()).results || [];
  const settings = await getPlanSettings(env);
  const unitTests = {};
  for (const t of tests) unitTests[t.unit] = { passed: !!t.passed, bestScore: t.best_score, attempts: t.attempts };
  return json({
    completed: rows.map((x) => x.lesson_id),
    unitsPassed: await unitsPassed(env, u.id),
    unitTests, lessonLimit: lessonLimitFor(settings, u), lessonsDone: rows.length,
  });
}

async function apiProgressPost(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent must approve this account first.", consentRequired: true }, 403);
  const lessonId = (data.lessonId || "").trim();
  if (!lessonId) return json({ error: "lessonId required" }, 400);
  const settings = await getPlanSettings(env);
  const already = await env.DB.prepare("SELECT 1 FROM progress WHERE user_id=? AND lesson_id=?").bind(u.id, lessonId).first();
  const done = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(u.id).first()).c;
  const limit = lessonLimitFor(settings, u);
  if (!already && limit >= 0 && done >= limit)
    return json({ error: `Your ${effectivePlan(u)} plan allows ${limit} lessons. Upgrade to unlock more!`, limitReached: true }, 403);
  await env.DB.prepare("INSERT OR IGNORE INTO progress (user_id,lesson_id,completed_at) VALUES (?,?,?)").bind(u.id, lessonId, nowIso()).run();
  let awarded = 0;
  if (!already) {
    awarded = TOKENS_PER_LESSON;
    await env.DB.prepare("UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id=?").bind(awarded, u.id).run();
  }
  const rows = (await env.DB.prepare("SELECT lesson_id FROM progress WHERE user_id=?").bind(u.id).all()).results || [];
  const tok = (await env.DB.prepare("SELECT tokens FROM users WHERE id=?").bind(u.id).first()).tokens;
  return json({ completed: rows.map((x) => x.lesson_id), unitsPassed: await unitsPassed(env, u.id), tokensAwarded: awarded, tokens: tok });
}

async function apiTestSubmit(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent must approve this account first.", consentRequired: true }, 403);
  const unit = parseInt(data.unit, 10);
  if (isNaN(unit)) return json({ error: "bad unit" }, 400);
  const answers = data.answers || [];
  const rows = (await env.DB.prepare("SELECT * FROM lessons WHERE published=1 AND unit=? ORDER BY position, id").bind(unit).all()).results || [];
  const graded = [];
  for (const r of rows) {
    let q = {}; try { q = JSON.parse(r.quiz || "{}"); } catch {}
    if (q.q && "answer" in q) graded.push([r, q]);
  }
  const total = graded.length;
  if (total === 0) return json({ error: "No test available for this unit." }, 400);
  let correct = 0;
  graded.forEach(([r, q], i) => { if (i < answers.length && answers[i] === q.answer) correct++; });
  const score = Math.round((correct / total) * 100);
  const passPct = await getPassPercent(env);
  const passedNow = score >= passPct;
  const existing = await env.DB.prepare("SELECT passed,best_score,attempts FROM unit_tests WHERE user_id=? AND unit=?").bind(u.id, unit).first();
  const everPassed = passedNow || (existing && existing.passed) ? 1 : 0;
  const best = existing ? Math.max(score, existing.best_score) : score;
  const attempts = existing ? existing.attempts + 1 : 1;
  await env.DB.prepare(
    "INSERT INTO unit_tests (user_id,unit,passed,best_score,attempts,updated_at) VALUES (?,?,?,?,?,?) " +
    "ON CONFLICT(user_id,unit) DO UPDATE SET passed=?, best_score=?, attempts=?, updated_at=?"
  ).bind(u.id, unit, everPassed, best, attempts, nowIso(), everPassed, best, attempts, nowIso()).run();
  const feedback = graded.map(([r, q], i) => {
    const ok = i < answers.length && answers[i] === q.answer;
    const fb = { ok, question: q.q };
    if (!ok) { fb.fix = q.explain || "Review the lesson and try this question again."; fb.review = `${r.emoji} ${r.title}`; }
    return fb;
  });
  const up = await unitsPassed(env, u.id);
  return json({
    score, correct, total, passed: passedNow, passPercent: passPct,
    results: feedback.map((f) => f.ok), feedback, unitsPassed: up, level: up.length + 1, attempts,
  });
}

async function apiNotices(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const rows = (await env.DB.prepare("SELECT id,kind,body,created_at FROM notices WHERE user_id=? ORDER BY id DESC").bind(u.id).all()).results || [];
  return json({ notices: rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, at: (r.created_at || "").slice(0, 16).replace("T", " ") })) });
}

async function apiDismissNotice(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  await env.DB.prepare("DELETE FROM notices WHERE id=? AND user_id=?").bind(data.id, u.id).run();
  return json({ ok: true });
}

// ───────────────────────── avatar shop / Byte AI / upgrade / class join ─────────────────────────
async function logConsent(env, childId, childUsername, method, grantedBy, detail = "") {
  await env.DB.prepare("INSERT INTO consent_log (child_id,child_username,method,granted_by,detail,created_at) VALUES (?,?,?,?,?,?)")
    .bind(childId, childUsername, method, grantedBy, detail, nowIso()).run();
}

function byteReply(q) {
  q = (q || "").toLowerCase();
  if (/variable/.test(q)) return "A variable is like a labeled box that stores a value! 📦 Example: <code>score = 10</code> puts 10 in a box called <code>score</code>.";
  if (/loop|repeat/.test(q)) return "A loop repeats code so you don't have to write it 100 times! 🔄 Try: <code>for i in range(3):<br>&nbsp;&nbsp;print('hi')</code>";
  if (/\bif\b|condition/.test(q)) return "An <code>if</code> statement makes choices! 🤔 <code>if score > 10:<br>&nbsp;&nbsp;print('You win!')</code> - don't forget the colon!";
  if (/function/.test(q)) return "A function is a reusable mini-program! 🛠️ <code>def hello():<br>&nbsp;&nbsp;print('Hi!')</code> - call it with <code>hello()</code>.";
  if (/error|bug|broken|not work/.test(q)) return "Every coder gets errors! 🐛 Read the last line, check for a missing <code>:</code> or <code>)</code>, and try again. You've got this!";
  if (/python|javascript|language/.test(q)) return "Great question! 🐍 Python is super beginner-friendly. You start with blocks, then move to real Python on KidVibers!";
  if (/\b(hi|hello|hey)\b/.test(q)) return "Hey there, coder! 👋 What do you want to learn today? Loops, variables, functions - just ask!";
  if (/thank/.test(q)) return "You're so welcome! 🌟 Keep up the awesome coding - I'm always here to help!";
  return "Ooh, good question! 🤖 I'm best at coding basics - try asking about <code>variables</code>, <code>loops</code>, <code>if statements</code>, or <code>functions</code>!";
}

async function apiShop(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const pu = await publicUser(env, u);
  return json({ items: SHOP_ITEMS, owned: pu.ownedItems, avatar: pu.avatar, tokens: pu.tokens });
}

async function apiShopBuy(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  const itemId = (data.itemId || "").trim();
  const item = SHOP_BY_ID[itemId];
  if (!item) return json({ error: "Unknown item" }, 400);
  const pu = await publicUser(env, u);
  if (pu.ownedItems.includes(itemId)) return json({ error: "You already own this!" }, 400);
  const price = item.price || 0;
  if (pu.tokens < price) return json({ error: `Not enough tokens - you need ${price} 🪙` }, 400);
  const owned = [...pu.ownedItems, itemId];
  await env.DB.prepare("UPDATE users SET tokens = tokens - ?, owned_items=? WHERE id=?").bind(price, JSON.stringify(owned), u.id).run();
  return json({ ok: true, tokens: pu.tokens - price, owned });
}

async function apiSaveAvatar(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  const av = data.avatar || {};
  const pu = await publicUser(env, u);
  const owned = new Set(pu.ownedItems);
  const clean = { ...DEFAULT_AVATAR };
  for (const slot of ["face", "hat", "accessory", "clothing", "companion", "background"]) {
    const val = av[slot];
    if (val == null) { if (slot !== "face" && slot !== "background") clean[slot] = null; }
    else if (owned.has(val) && (SHOP_BY_ID[val] || {}).cat === slot) clean[slot] = val;
  }
  await env.DB.prepare("UPDATE users SET avatar=? WHERE id=?").bind(JSON.stringify(clean), u.id).run();
  return json({ ok: true, avatar: clean });
}

async function apiAi(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "Log in to use the AI buddy.", locked: true }, 401);
  if (!consentOk(u)) return json({ error: "A parent must approve this account first.", consentRequired: true, locked: true }, 403);
  const settings = await getPlanSettings(env);
  const cfg = planCfg(settings, effectivePlan(u));
  if (!cfg.ai) return json({ error: "AI features are a Pro perk. Upgrade to unlock Byte!", locked: true }, 403);
  const limit = cfg.chatsPerDay | 0;
  const used = await chatsUsedToday(env, u.id);
  if (limit >= 0 && used >= limit) return json({ error: `You've used all ${limit} AI chats for today. Come back tomorrow! 🌙`, limitReached: true }, 429);
  await env.DB.prepare("INSERT INTO chat_usage (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count = count + 1")
    .bind(u.id, todayStr()).run();
  const remaining = limit >= 0 ? limit - used - 1 : null;
  return json({ reply: byteReply((data.message || "").trim()), remaining });
}

async function apiRequestUpgrade(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Only a kid can ask a parent to upgrade." }, 403);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  const origin = new URL(request.url).origin;
  const body = `Your kid wants to upgrade. If you would like to upgrade their account, go to ${origin}/index.html#pricing. If this is a mistake, please ignore this message. Thank you and have a great day.`;
  if (u.parent_email)
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)")
      .bind(u.parent_email, "upgrade_request", body, u.id, nowIso()).run();
  return json({ ok: true, parentEmail: u.parent_email, message: body });
}

async function apiClassJoin(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Only a kid account can join a classroom." }, 403);
  const code = (data.code || "").trim().toUpperCase().replace(/ /g, "");
  if (!code) return json({ error: "Enter your class code." }, 400);
  const teacher = await env.DB.prepare("SELECT * FROM users WHERE role='teacher' AND class_code=?").bind(code).first();
  if (!teacher) return json({ error: "That class code wasn't found. Double-check it with your teacher." }, 404);
  const cfg = teacherPlanCfg(teacher.plan);
  const used = (await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE role='kid' AND family_id=?").bind(teacher.family_id).first()).c;
  if (cfg.students !== -1 && used >= cfg.students) return json({ error: "That classroom is full. Ask your teacher for help." }, 403);
  const grantedBy = `${teacher.school || teacher.username} (code ${code})`;
  await env.DB.prepare("UPDATE users SET family_id=?, plan='family', consent_status='granted', consent_method='class_code', consent_by=?, consent_at=? WHERE id=?")
    .bind(teacher.family_id, grantedBy, nowIso(), u.id).run();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
  await logConsent(env, u.id, u.username, "class_join", grantedBy, `Joined classroom via code ${code}`);
  const grp = await familyGroup(env, teacher.family_id);
  return json({ ok: true, user: await publicUser(env, row), groupName: grp.groupName || (teacher.school || "the classroom"), groupLabel: grp.groupLabel || "Classroom" });
}

// ───────────────────────── gallery / projects / comments ─────────────────────────
const PROJECT_MAX = 50, CODE_MAX = 20000, TITLE_MAX = 60, COMMENT_MAX = 500;
const BAD_WORDS = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "piss", "cunt", "slut",
  "whore", "fag", "faggot", "nigger", "nigga", "retard", "rape", "kill yourself",
  "kys", "stupid idiot", "loser", "hate you", "dumbass", "douche", "crap",
  "penis", "vagina", "sex", "porn", "nude",
];
function containsBadWords(text) {
  const low = (text || "").toLowerCase();
  const squashed = low.replace(/@/g, "a").replace(/\$/g, "s").replace(/!/g, "i")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/[^a-z]/g, "");
  for (const w of BAD_WORDS) { if (w.replace(/ /g, "") && squashed.includes(w.replace(/ /g, ""))) return true; if (low.includes(w)) return true; }
  return false;
}
// simple in-memory rate limiter (best-effort per isolate)
const rlMap = new Map();
function rateLimited(key, max, windowSec) {
  const now = Date.now(); let e = rlMap.get(key);
  if (!e || now - e.first > windowSec * 1000) { e = { count: 0, first: now }; }
  e.count++; rlMap.set(key, e);
  return e.count > max;
}
function firstName(u) { return cleanName((u.name || u.username || "").split(" ")[0]) || "A coder"; }
function projectPublic(r, withCode = false, liked = null) {
  const out = { id: r.id, title: r.title, author: r.author_name, shared: !!r.shared, likes: r.likes ?? 0, updatedAt: (r.updated_at || "").slice(0, 16).replace("T", " ") };
  if (withCode) out.code = r.code;
  if (liked !== null) out.liked = liked;
  return out;
}

async function apiGallery(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const rows = (await env.DB.prepare(
    "SELECT p.*, (SELECT COUNT(*) FROM project_likes WHERE project_id=p.id) likes, " +
    "(SELECT COUNT(*) FROM project_likes WHERE project_id=p.id AND user_id=?) mine " +
    "FROM projects p WHERE p.shared=1 ORDER BY likes DESC, p.updated_at DESC LIMIT 200").bind(u.id).all()).results || [];
  return json({ canModerate: u.role === "super_admin", projects: rows.map((r) => projectPublic(r, true, !!r.mine)) });
}

async function apiProjectGet(env, request, pid) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const r = await env.DB.prepare("SELECT p.*, (SELECT COUNT(*) FROM project_likes WHERE project_id=p.id) likes FROM projects p WHERE p.id=?").bind(pid).first();
  if (!r) return json({ error: "Project not found" }, 404);
  if (!r.shared && r.user_id !== u.id && u.role !== "super_admin") return json({ error: "This project is private." }, 403);
  return json({ project: projectPublic(r, true) });
}

async function apiCommentsGet(env, request, pid) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const proj = await env.DB.prepare("SELECT user_id, shared FROM projects WHERE id=?").bind(pid).first();
  if (!proj || (!proj.shared && proj.user_id !== u.id && u.role !== "super_admin")) return json({ error: "Project not found" }, 404);
  const rows = (await env.DB.prepare("SELECT * FROM comments WHERE project_id=? ORDER BY id").bind(pid).all()).results || [];
  const isMod = u.role === "super_admin", ownsProject = proj.user_id === u.id;
  return json({ comments: rows.map((c) => ({
    id: c.id, author: c.author_name, body: c.body, at: (c.created_at || "").slice(0, 16).replace("T", " "),
    reported: isMod ? !!c.reported : false, canDelete: isMod || ownsProject || c.user_id === u.id,
  })) });
}

async function apiProjectSave(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  const title = cleanName(data.title || "").slice(0, TITLE_MAX) || "Untitled project";
  const code = (data.code || "").slice(0, CODE_MAX);
  let pid = data.id;
  const author = firstName(u);
  if (pid) {
    const row = await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!row) return json({ error: "Project not found" }, 404);
    await env.DB.prepare("UPDATE projects SET title=?, code=?, updated_at=? WHERE id=?").bind(title, code, nowIso(), pid).run();
  } else {
    const count = (await env.DB.prepare("SELECT COUNT(*) c FROM projects WHERE user_id=?").bind(u.id).first()).c;
    if (count >= PROJECT_MAX) return json({ error: `You can keep up to ${PROJECT_MAX} projects. Delete one to save a new one.` }, 400);
    const res = await env.DB.prepare("INSERT INTO projects (user_id,author_name,title,code,shared,created_at,updated_at) VALUES (?,?,?,?,0,?,?)")
      .bind(u.id, author, title, code, nowIso(), nowIso()).run();
    pid = res.meta.last_row_id;
  }
  return json({ ok: true, id: pid });
}

async function apiProjectShare(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  const shared = data.shared ? 1 : 0;
  const row = await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(data.id, u.id).first();
  if (!row) return json({ error: "Project not found" }, 404);
  await env.DB.prepare("UPDATE projects SET shared=?, updated_at=? WHERE id=?").bind(shared, nowIso(), data.id).run();
  return json({ ok: true, shared: !!shared });
}

async function apiProjectDelete(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const row = u.role === "super_admin"
    ? await env.DB.prepare("SELECT id FROM projects WHERE id=?").bind(data.id).first()
    : await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(data.id, u.id).first();
  if (!row) return json({ error: "Project not found" }, 404);
  await env.DB.prepare("DELETE FROM projects WHERE id=?").bind(data.id).run();
  await env.DB.prepare("DELETE FROM project_likes WHERE project_id=?").bind(data.id).run();
  return json({ ok: true });
}

async function apiProjectLike(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const proj = await env.DB.prepare("SELECT shared FROM projects WHERE id=?").bind(data.id).first();
  if (!proj || !proj.shared) return json({ error: "Project not found" }, 404);
  const existing = await env.DB.prepare("SELECT 1 FROM project_likes WHERE user_id=? AND project_id=?").bind(u.id, data.id).first();
  let liked;
  if (existing) { await env.DB.prepare("DELETE FROM project_likes WHERE user_id=? AND project_id=?").bind(u.id, data.id).run(); liked = false; }
  else { await env.DB.prepare("INSERT INTO project_likes (user_id,project_id) VALUES (?,?)").bind(u.id, data.id).run(); liked = true; }
  const likes = (await env.DB.prepare("SELECT COUNT(*) c FROM project_likes WHERE project_id=?").bind(data.id).first()).c;
  return json({ ok: true, liked, likes });
}

async function apiCommentAdd(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  if (rateLimited(`comment:${u.id}`, 6, 60)) return json({ error: "Whoa, slow down a sec! Try again in a moment. 🙂" }, 429);
  const body = cleanName(data.body || "").slice(0, COMMENT_MAX);
  if (!body) return json({ error: "Write something first!" }, 400);
  if (containsBadWords(body)) return json({ error: "Please keep comments kind and clean. That message wasn't posted." }, 400);
  const proj = await env.DB.prepare("SELECT shared FROM projects WHERE id=?").bind(data.projectId).first();
  if (!proj || !proj.shared) return json({ error: "Project not found" }, 404);
  await env.DB.prepare("INSERT INTO comments (project_id,user_id,author_name,body,reported,created_at) VALUES (?,?,?,?,0,?)")
    .bind(data.projectId, u.id, firstName(u), body, nowIso()).run();
  return json({ ok: true });
}

async function apiCommentDelete(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const c = await env.DB.prepare("SELECT c.*, p.user_id AS owner FROM comments c JOIN projects p ON p.id=c.project_id WHERE c.id=?").bind(data.id).first();
  if (!c) return json({ error: "Comment not found" }, 404);
  if (!(u.role === "super_admin" || c.user_id === u.id || c.owner === u.id)) return json({ error: "forbidden" }, 403);
  await env.DB.prepare("DELETE FROM comments WHERE id=?").bind(data.id).run();
  return json({ ok: true });
}

async function apiCommentReport(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const c = await env.DB.prepare("SELECT id FROM comments WHERE id=?").bind(data.id).first();
  if (!c) return json({ error: "Comment not found" }, 404);
  await env.DB.prepare("UPDATE comments SET reported=reported+1 WHERE id=?").bind(data.id).run();
  return json({ ok: true });
}

async function apiProjectTakedown(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  const reason = cleanName(data.reason || "").slice(0, 500);
  const proj = await env.DB.prepare("SELECT id,shared FROM projects WHERE id=?").bind(data.projectId).first();
  if (!proj || !proj.shared) return json({ error: "Project not found" }, 404);
  const dup = await env.DB.prepare("SELECT id FROM takedowns WHERE project_id=? AND requester_id=? AND status='pending'").bind(data.projectId, u.id).first();
  if (dup) return json({ ok: true, already: true });
  await env.DB.prepare("INSERT INTO takedowns (project_id,requester_id,requester_name,reason,status,created_at) VALUES (?,?,?,?,'pending',?)")
    .bind(data.projectId, u.id, firstName(u), reason, nowIso()).run();
  return json({ ok: true });
}

// ───────────────────────── parent / teacher / district ─────────────────────────
const GUARDIAN_ROLES = ["parent", "teacher"];
const PLAN_LABEL = { free: "Free", pro: "Pro", family: "Family" };
const PLAN_BLURB = {
  free: "Start free with starter lessons, badges and the avatar shop. Upgrade any time.",
  pro: "Pro unlocks every lesson plus Byte, your AI coding buddy, for hints and explanations.",
  family: "The Family plan covers up to 4 kids with AI included, so everyone learns together.",
};
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function genClassCode(env) {
  for (let tries = 0; tries < 50; tries++) {
    let code = ""; const b = new Uint8Array(6); crypto.getRandomValues(b);
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
    const exists = await env.DB.prepare("SELECT 1 FROM users WHERE class_code=?").bind(code).first();
    if (!exists) return code;
  }
  return "C" + randToken(4).slice(0, 5).toUpperCase();
}
async function grantConsent(env, kidId, method, grantedBy) {
  await env.DB.prepare("UPDATE users SET consent_status='granted', consent_method=?, consent_by=?, consent_at=?, consent_token=NULL, consent_confirm_token=NULL WHERE id=?")
    .bind(method, grantedBy, nowIso(), kidId).run();
}
function recommendFromQuiz(a) {
  const [age, exp, interest, practice, helper, who] = [...a, 0, 0, 0, 0, 0, 0].slice(0, 6);
  let level, startUnit;
  if (exp >= 2 && age >= 2) { level = "Pro Coder"; startUnit = 11; }
  else if (exp === 0 || age === 0) { level = "Beginner"; startUnit = 1; }
  else { level = "Builder"; startUnit = { 0: 5, 1: 6, 3: 8 }[interest] ?? 2; }
  const bonusUnit = level === "Beginner" ? 15 : 16;
  let plan;
  if (who === 1) plan = "family";
  else if (helper === 0 || exp >= 2 || practice === 2) plan = "pro";
  else plan = "free";
  const interestWord = { 0: "games", 1: "websites", 2: "art & stories", 3: "smart AI" }[interest] || "code";
  const startWorld = UNIT_NAMES[startUnit] || "Greenwood Basics";
  return {
    level, plan, planLabel: PLAN_LABEL[plan], planBlurb: PLAN_BLURB[plan],
    startUnit, startWorld, bonusUnit, bonusWorld: UNIT_NAMES[bonusUnit] || "",
    title: `You're a ${level}!`,
    blurb: `Based on your answers, we'll start you in ${startWorld} and line up ${interestWord} projects you'll love.`,
  };
}

async function apiParentSignup(env, request, data) {
  if (!(await authEnabled(env, "signups"))) return json({ error: "Sign-ups are temporarily disabled. Please check back soon." }, 403);
  const name = (data.name || "").trim(), username = (data.username || "").trim(), password = data.password || "";
  const email = (data.email || data.parentEmail || "").trim();
  const err = validateCredentials(name, username, password);
  if (err) return json({ error: err }, 400);
  const linkToken = (data.linkToken || "").trim();
  const r = await createUser(env, { role: "parent", name, username, password, email, age: "", plan: "family", trial_ends: null });
  if (r.error) return json({ error: r.error }, r.status || 400);
  await env.DB.prepare("UPDATE users SET family_id=? WHERE id=?").bind(r.uid, r.uid).run();
  let linked = null;
  if (linkToken) {
    const kid = await env.DB.prepare("SELECT id,name,username FROM users WHERE link_token=? AND role='kid'").bind(linkToken).first();
    if (kid) {
      await env.DB.prepare("UPDATE users SET family_id=?, parent_email=? WHERE id=?").bind(r.uid, email, kid.id).run();
      await grantConsent(env, kid.id, "parent_account", email);
      await logConsent(env, kid.id, kid.username, "parent_account", email, "Parent linked the child's account");
      linked = kid.name;
    }
  }
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(r.uid).first();
  if (email) {
    const first = name.split(" ")[0] || "there";
    const welcome = `Hi ${cleanName(first)}, welcome to KidVibers! 🎉 Your Family account is ready.${linked ? ` You're now connected to ${cleanName(linked)}'s account.` : ""} From your Family Dashboard you can add kids, see their progress, approve accounts, and sign them in or out anytime.`;
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,created_at) VALUES (?,?,?,?)").bind(email, "welcome", welcome, nowIso()).run();
  }
  const token = await createSession(env, r.uid);
  return json({ token, user: await publicUser(env, row), linkedChild: linked });
}

async function apiTeacherSignup(env, request, data) {
  if (!(await authEnabled(env, "signups"))) return json({ error: "Sign-ups are temporarily disabled. Please check back soon." }, 403);
  const name = (data.name || "").trim(), username = (data.username || "").trim(), password = data.password || "";
  const school = (data.school || "").trim() || "My Classroom", email = (data.email || "").trim();
  const err = validateCredentials(name, username, password);
  if (err) return json({ error: err }, 400);
  const r = await createUser(env, { role: "teacher", name, username, password, email, age: "", plan: "none", trial_ends: null, school });
  if (r.error) return json({ error: r.error }, r.status || 400);
  await env.DB.prepare("UPDATE users SET family_id=?, class_code=? WHERE id=?").bind(r.uid, await genClassCode(env), r.uid).run();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(r.uid).first();
  const token = await createSession(env, r.uid);
  return json({ token, user: await publicUser(env, row) });
}

async function apiParentAddKid(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role)) return json({ error: "Only a parent or teacher can add kids." }, 403);
  const name = (data.name || "").trim(), username = (data.username || "").trim(), password = data.password || "";
  const age = (data.ageBand || "").trim();
  const err = validateCredentials(name, username, password);
  if (err) return json({ error: err }, 400);
  const isTeacher = u.role === "teacher";
  if (isTeacher) {
    const cfg = teacherPlanCfg(u.plan), limit = cfg.students;
    if (limit !== -1 && (await studentsInFamily(env, u.family_id)) >= limit) {
      const msg = limit === 0 ? "Choose a Teacher, School or District plan to add students." : `Your ${cfg.label} allows ${limit} students. Upgrade for more.`;
      return json({ error: msg, limitReached: true }, 403);
    }
  }
  const method = isTeacher ? "school" : "parent_account";
  const grantedBy = isTeacher ? `${u.school} (teacher: ${u.username})` : (u.parent_email || u.username);
  const r = await createUser(env, {
    role: "kid", name, username, password, email: u.parent_email || "", age, plan: "family", trial_ends: null,
    family_id: u.family_id, consent_status: "granted", consent_method: method, consent_by: grantedBy,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  await logConsent(env, r.uid, username, method, grantedBy, isTeacher ? "School/classroom consent" : "Parent created the account");
  return json({ token: null, user: await publicUser(env, r.row) });
}

async function apiParentFamily(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["parent", "teacher", "super_admin"].includes(u.role)) return json({ error: "forbidden" }, 403);
  const kids = (await env.DB.prepare("SELECT * FROM users WHERE role='kid' AND family_id=? ORDER BY id").bind(u.family_id).all()).results || [];
  const kidsPub = []; for (const k of kids) kidsPub.push(await publicUser(env, k));
  return json({ parent: await publicUser(env, u), kids: kidsPub });
}

async function apiParentMessages(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["parent", "teacher", "super_admin"].includes(u.role)) return json({ error: "forbidden" }, 403);
  const rows = (await env.DB.prepare("SELECT * FROM messages WHERE to_email=? ORDER BY id DESC LIMIT 50").bind(u.parent_email || "").all()).results || [];
  return json({ messages: rows.map((r) => ({ kind: r.kind, body: r.body, createdAt: r.created_at })) });
}

async function apiParentKidData(env, request, kidId) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role)) return json({ error: "forbidden" }, 403);
  const kid = await env.DB.prepare("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?").bind(kidId, u.family_id).first();
  if (!kid) return json({ error: "Not your family's kid." }, 403);
  const prog = ((await env.DB.prepare("SELECT lesson_id FROM progress WHERE user_id=?").bind(kidId).all()).results || []).map((r) => r.lesson_id);
  const tests = (await env.DB.prepare("SELECT unit,passed,best_score,attempts FROM unit_tests WHERE user_id=?").bind(kidId).all()).results || [];
  return json({ profile: {
    name: kid.name, username: kid.username, ageYears: kid.age_years, parentEmail: kid.parent_email, plan: kid.plan,
    tokens: kid.tokens ?? 0, consentStatus: kid.consent_status, consentMethod: kid.consent_method,
    consentBy: kid.consent_by, consentAt: kid.consent_at, createdAt: kid.created_at,
  }, lessonsCompleted: prog, unitTests: tests });
}

async function apiConsentLookup(env, token) {
  const kid = await env.DB.prepare("SELECT id,name,age_years,parent_email FROM users WHERE consent_token=? AND role='kid'").bind(token).first();
  if (!kid) return json({ error: "This consent link is invalid or already used." }, 404);
  return json({ childName: kid.name, ageYears: kid.age_years, parentEmail: kid.parent_email });
}

async function apiParentSignoutKid(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role) || u.family_id == null) return json({ error: "Only a parent or teacher can do this." }, 403);
  const kid = await env.DB.prepare("SELECT id,name FROM users WHERE id=? AND role='kid' AND family_id=?").bind(data.kidId, u.family_id).first();
  if (!kid) return json({ error: "That kid isn't in your family." }, 403);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();
  return json({ ok: true, name: kid.name });
}

async function apiParentDeleteKid(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role) || u.family_id == null) return json({ error: "Only a parent or teacher can do this." }, 403);
  const kid = await env.DB.prepare("SELECT id,name,username FROM users WHERE id=? AND role='kid' AND family_id=?").bind(data.kidId, u.family_id).first();
  if (!kid) return json({ error: "That kid isn't in your family." }, 403);
  for (const sql of ["DELETE FROM progress WHERE user_id=?", "DELETE FROM unit_tests WHERE user_id=?", "DELETE FROM sessions WHERE user_id=?",
    "DELETE FROM chat_usage WHERE user_id=?", "DELETE FROM messages WHERE child_id=?", "DELETE FROM users WHERE id=?"])
    await env.DB.prepare(sql).bind(kid.id).run();
  await logConsent(env, kid.id, kid.name, "deleted", u.username, "Guardian deleted the child's account & data");
  return json({ ok: true, name: kid.name });
}

async function districtOwner(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher" || u.family_id == null || !DISTRICT_PLANS.includes(u.plan)) return null;
  return u;
}

async function apiSchoolBranding(env, request, data) {
  const owner = await districtOwner(env, request);
  if (!owner) return json({ error: "Only a School or District account can change branding." }, 403);
  const brandName = (data.brandName || "").trim().slice(0, 80);
  const brandLogo = (data.brandLogo || "").trim().slice(0, 500);
  if (brandLogo && !/^https:\/\//.test(brandLogo)) return json({ error: "Logo must be a secure https:// image link." }, 400);
  await env.DB.prepare("UPDATE users SET brand_name=?, brand_logo=? WHERE id=?").bind(brandName || null, brandLogo || null, owner.id).run();
  return json({ ok: true, brandName: brandName || null, brandLogo: brandLogo || null });
}

async function apiSchoolSuspend(env, request, data) {
  const owner = await districtOwner(env, request);
  if (!owner) return json({ error: "Only a School or District account can do this." }, 403);
  const kid = await env.DB.prepare("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?").bind(data.kidId, owner.family_id).first();
  if (!kid) return json({ error: "That student isn't in your school." }, 403);
  const suspend = !!data.suspended;
  const reason = (data.reason || "").trim().slice(0, 200);
  let until = null;
  if (suspend) {
    const days = parseFloat(data.days) || 0;
    if (days > 0) until = new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
    await env.DB.prepare("UPDATE users SET suspended=1, suspend_reason=?, suspend_until=? WHERE id=?")
      .bind(reason || `Suspended by ${owner.school || "your school"}`, until, kid.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();
  } else {
    await env.DB.prepare("UPDATE users SET suspended=0, suspend_reason=NULL, suspend_until=NULL WHERE id=?").bind(kid.id).run();
  }
  await logConsent(env, kid.id, kid.username, suspend ? "suspended" : "reinstated", `school owner (${owner.username})`, reason);
  return json({ ok: true, name: kid.name, suspended: suspend, until });
}

async function apiSchoolCredentials(env, request, data) {
  const owner = await districtOwner(env, request);
  if (!owner) return json({ error: "Only a School or District account can do this." }, 403);
  const kid = await env.DB.prepare("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?").bind(data.kidId, owner.family_id).first();
  if (!kid) return json({ error: "That student isn't in your school." }, 403);
  const newUser = (data.username || "").trim(), newPass = data.password || "";
  if (!newUser && !newPass) return json({ error: "Enter a new username and/or password." }, 400);
  const changed = [];
  if (newUser && newUser !== kid.username) {
    if (!USERNAME_RE.test(newUser)) return json({ error: "Username must be 3-20 letters, numbers or underscores." }, 400);
    const dup = await env.DB.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").bind(newUser, kid.id).first();
    if (dup) return json({ error: "That username is already taken." }, 409);
    await env.DB.prepare("UPDATE users SET username=? WHERE id=?").bind(newUser, kid.id).run();
    changed.push("username");
  }
  if (newPass) {
    if (newPass.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const { hash, salt } = await hashPassword(newPass);
    await env.DB.prepare("UPDATE users SET password_hash=?, salt=? WHERE id=?").bind(hash, salt, kid.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();
    changed.push("password");
  }
  return json({ ok: true, changed, username: changed.includes("username") ? newUser : kid.username });
}

async function apiTeacherNewCode(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher account has a class code." }, 403);
  const code = await genClassCode(env);
  await env.DB.prepare("UPDATE users SET class_code=? WHERE id=?").bind(code, u.id).run();
  return json({ ok: true, classCode: code });
}

async function apiQuizSubmit(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Only a kid account can take the placement quiz." }, 403);
  const answers = data.answers;
  if (!Array.isArray(answers) || answers.length < 6) return json({ error: "Please answer all the questions." }, 400);
  const a = answers.slice(0, 6).map((x) => Math.max(0, parseInt(x, 10) || 0));
  const rec = recommendFromQuiz(a);
  await env.DB.prepare("UPDATE users SET quiz_done=1, quiz_level=?, quiz_plan=?, start_unit=? WHERE id=?")
    .bind(rec.level, rec.plan, rec.startUnit, u.id).run();
  return json({ ok: true, recommendation: rec });
}

// ───────────────────────── admin dashboard ─────────────────────────
const DEFAULT_PLAN_BY_ROLE = { teacher: "teacher", parent: "family", admin: "pro", super_admin: "pro" };

async function provisionAccount(env, role, name, username, pwhash, salt, email = "", plan = null) {
  name = cleanName(name);
  if (!plan) plan = DEFAULT_PLAN_BY_ROLE[role] || "trial";
  const linkToken = randToken(8);
  try {
    const res = await env.DB.prepare(
      "INSERT INTO users (role,name,username,password_hash,salt,parent_email,plan,tokens,avatar,owned_items,link_token,consent_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(role, name, username, pwhash, salt, email, plan, STARTER_TOKENS, JSON.stringify(DEFAULT_AVATAR), JSON.stringify(FREE_ITEMS), linkToken, "not_required", nowIso()).run();
    const uid = res.meta.last_row_id;
    if (role === "teacher") await env.DB.prepare("UPDATE users SET family_id=?, class_code=? WHERE id=?").bind(uid, await genClassCode(env), uid).run();
    else if (role === "parent") await env.DB.prepare("UPDATE users SET family_id=? WHERE id=?").bind(uid, uid).run();
    return uid;
  } catch (e) { if (String(e.message || e).includes("UNIQUE")) return null; throw e; }
}
async function requireRole(env, request, roles) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !roles.includes(u.role)) return { err: json({ error: "forbidden" }, 403) };
  return { u };
}

async function adminUsers(env, request) {
  const { u, err } = await requireRole(env, request, ADMIN_ROLES); if (err) return err;
  const rows = (await env.DB.prepare("SELECT * FROM users WHERE role='kid' ORDER BY id DESC").all()).results || [];
  const out = []; for (const r of rows) out.push({ ...(await publicUser(env, r)), createdAt: r.created_at, parentEmail: r.parent_email });
  return json({ users: out });
}
async function adminAccounts(env, request) {
  const { u, err } = await requireRole(env, request, ADMIN_ROLES); if (err) return err;
  const roles = u.role === "super_admin" ? ["kid", "parent", "teacher", "admin", "super_admin"] : ["kid", "parent", "teacher"];
  const ph = roles.map(() => "?").join(",");
  const rows = (await env.DB.prepare(`SELECT id,name,username,role,plan,parent_email,family_id,created_at,suspended,suspend_reason,suspend_until FROM users WHERE role IN (${ph}) ORDER BY id`).bind(...roles).all()).results || [];
  return json({ accounts: rows.map((r) => ({
    id: r.id, name: r.name, username: r.username, role: r.role, plan: r.plan, parentEmail: r.parent_email,
    familyId: r.family_id, joined: (r.created_at || "").slice(0, 10), suspended: suspensionStatus(r)[0],
    suspendReason: r.suspend_reason ?? null, suspendUntil: r.suspend_until ?? null,
  })) });
}
async function adminStats(env, request) {
  const { err } = await requireRole(env, request, ADMIN_ROLES); if (err) return err;
  const c = async (sql) => (await env.DB.prepare(sql).first()).c;
  return json({
    totalKids: await c("SELECT COUNT(*) c FROM users WHERE role='kid'"),
    proKids: await c("SELECT COUNT(*) c FROM users WHERE role='kid' AND plan IN ('pro','family')"),
    trialKids: await c("SELECT COUNT(*) c FROM users WHERE role='kid' AND plan='trial'"),
    parents: await c("SELECT COUNT(*) c FROM users WHERE role='parent'"),
    lessonsCompleted: await c("SELECT COUNT(*) c FROM progress"),
  });
}
async function adminConsentGet(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const kids = (await env.DB.prepare("SELECT id,name,username,age_years,parent_email,consent_status,consent_method,consent_by,consent_at FROM users WHERE role='kid' ORDER BY id DESC").all()).results || [];
  const log = (await env.DB.prepare("SELECT child_username,method,granted_by,detail,created_at FROM consent_log ORDER BY id DESC LIMIT 100").all()).results || [];
  return json({
    kids: kids.map((k) => ({ id: k.id, name: k.name, username: k.username, ageYears: k.age_years, parentEmail: k.parent_email, consentStatus: k.consent_status || "not_required", consentMethod: k.consent_method, consentBy: k.consent_by, consentAt: k.consent_at })),
    log: log.map((r) => ({ child: r.child_username, method: r.method, by: r.granted_by, detail: r.detail, at: (r.created_at || "").slice(0, 16).replace("T", " ") })),
  });
}
async function adminSettingsGet(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT * FROM lessons ORDER BY position, id").all()).results || [];
  return json({ planSettings: await getPlanSettings(env), passPercent: await getPassPercent(env), unitNames: UNIT_NAMES, worlds: WORLDS, lessons: rows.map(lessonPublic) });
}
async function adminReportedComments(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT c.*, p.title AS project_title, us.username AS author_username, us.id AS author_id FROM comments c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN users us ON us.id=c.user_id WHERE c.reported > 0 ORDER BY c.reported DESC, c.id DESC").all()).results || [];
  return json({ comments: rows.map((r) => ({ id: r.id, body: r.body, author: r.author_name, authorUsername: r.author_username ?? null, authorId: r.author_id ?? null, projectId: r.project_id, projectTitle: r.project_title || "(deleted project)", reports: r.reported, at: (r.created_at || "").slice(0, 16).replace("T", " ") })) });
}
async function adminTakedowns(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT t.*, p.title AS project_title, p.author_name AS project_author, p.shared AS project_shared FROM takedowns t LEFT JOIN projects p ON p.id=t.project_id WHERE t.status='pending' ORDER BY t.id DESC").all()).results || [];
  return json({ takedowns: rows.map((r) => ({ id: r.id, projectId: r.project_id, projectTitle: r.project_title || "(deleted project)", projectAuthor: r.project_author ?? null, projectShared: !!r.project_shared, requester: r.requester_name, reason: r.reason, at: (r.created_at || "").slice(0, 16).replace("T", " ") })) });
}
async function adminAccountRequests(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT id,role,name,username,email,plan,requested_by,created_at FROM account_requests WHERE status='pending' ORDER BY id DESC").all()).results || [];
  return json({ requests: rows.map((r) => ({ id: r.id, role: r.role, name: r.name, username: r.username, email: r.email, plan: r.plan, requestedBy: r.requested_by, at: (r.created_at || "").slice(0, 16).replace("T", " ") })) });
}
async function apiProjectsMine(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const rows = (await env.DB.prepare("SELECT p.*, (SELECT COUNT(*) FROM project_likes WHERE project_id=p.id) likes FROM projects p WHERE p.user_id=? ORDER BY p.updated_at DESC").bind(u.id).all()).results || [];
  return json({ projects: rows.map((r) => projectPublic(r, true)) });
}

async function adminSetPlan(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  if (!["free", "trial", "pro", "family"].includes((data.plan || "").trim())) return json({ error: "bad plan" }, 400);
  await env.DB.prepare("UPDATE users SET plan=? WHERE id=? AND role='kid'").bind(data.plan, data.userId).run();
  return json({ ok: true });
}
async function adminConsentPost(env, request, data) {
  const { u, err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const kid = await env.DB.prepare("SELECT id,username,parent_email FROM users WHERE id=? AND role='kid'").bind(data.kidId).first();
  if (!kid) return json({ error: "Kid not found." }, 404);
  const note = (data.note || "").trim(), action = (data.action || "").trim();
  if (action === "grant") {
    const method = (data.method || "admin_recorded").trim();
    const grantedBy = note || kid.parent_email || `super admin (${u.username})`;
    await grantConsent(env, kid.id, method, grantedBy);
    await logConsent(env, kid.id, kid.username, method, grantedBy, `Recorded by super admin ${u.username}` + (note ? `: ${note}` : ""));
    return json({ ok: true });
  } else if (action === "revoke") {
    await env.DB.prepare("UPDATE users SET consent_status='pending', consent_method=NULL, consent_by=NULL, consent_at=NULL, consent_token=? WHERE id=?").bind(randToken(10), kid.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();
    await logConsent(env, kid.id, kid.username, "revoked", `super admin (${u.username})`, note || "Consent revoked");
    return json({ ok: true });
  }
  return json({ error: "action must be grant or revoke" }, 400);
}
async function adminNotice(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const msg = (data.message || "").trim();
  if (!msg) return json({ error: "Notice message is required." }, 400);
  const target = await env.DB.prepare("SELECT id,parent_email FROM users WHERE id=?").bind(data.userId).first();
  if (!target) return json({ error: "User not found." }, 404);
  await env.DB.prepare("INSERT INTO notices (user_id,kind,body,created_at) VALUES (?,?,?,?)").bind(target.id, data.kind || "notice", msg, nowIso()).run();
  return json({ ok: true });
}
async function adminDeleteUser(env, request, data) {
  const { u, err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const reason = (data.reason || "").trim();
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(data.userId).first();
  if (!target) return json({ error: "User not found." }, 404);
  if (target.role === "super_admin") return json({ error: "The super-admin account can't be deleted." }, 403);
  if (target.parent_email) {
    const body = `Notice: the KidVibers account '${target.name}' (@${target.username}) has been deleted by an administrator.` + (reason ? ` Reason: ${reason}` : "");
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)").bind(target.parent_email, "account_deleted", body, target.id, nowIso()).run();
  }
  for (const sql of ["DELETE FROM progress WHERE user_id=?", "DELETE FROM unit_tests WHERE user_id=?", "DELETE FROM sessions WHERE user_id=?", "DELETE FROM chat_usage WHERE user_id=?", "DELETE FROM notices WHERE user_id=?", "DELETE FROM users WHERE id=?"])
    await env.DB.prepare(sql).bind(target.id).run();
  await logConsent(env, target.id, target.username, "deleted", `super admin (${u.username})`, reason || "Account deleted");
  return json({ ok: true, name: target.name });
}
async function adminSuspend(env, request, data) {
  const { u, err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(data.userId).first();
  if (!target) return json({ error: "User not found." }, 404);
  if (target.role === "super_admin") return json({ error: "The super-admin account can't be suspended." }, 403);
  const suspend = !!data.suspended, reason = (data.reason || "").trim();
  let until = null;
  if (suspend) {
    const days = parseFloat(data.days) || 0;
    if (days > 0) until = new Date(Date.now() + days * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
    await env.DB.prepare("UPDATE users SET suspended=1, suspend_reason=?, suspend_until=? WHERE id=?").bind(reason, until, target.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target.id).run();
  } else {
    await env.DB.prepare("UPDATE users SET suspended=0, suspend_reason=NULL, suspend_until=NULL WHERE id=?").bind(target.id).run();
  }
  await logConsent(env, target.id, target.username, suspend ? "suspended" : "reinstated", `super admin (${u.username})`, reason);
  return json({ ok: true, name: target.name, suspended: suspend, until });
}
async function adminSetCredentials(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(data.userId).first();
  if (!target) return json({ error: "Account not found." }, 404);
  const newUser = (data.username || "").trim(), newPass = data.password || "";
  if (!newUser && !newPass) return json({ error: "Enter a new username and/or password." }, 400);
  const changed = [];
  if (newUser && newUser !== target.username) {
    if (!USERNAME_RE.test(newUser)) return json({ error: "Username must be 3-20 letters, numbers or underscores." }, 400);
    const dup = await env.DB.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").bind(newUser, target.id).first();
    if (dup) return json({ error: "That username is already taken." }, 409);
    await env.DB.prepare("UPDATE users SET username=? WHERE id=?").bind(newUser, target.id).run();
    changed.push("username");
  }
  if (newPass) {
    if (newPass.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const { hash, salt } = await hashPassword(newPass);
    await env.DB.prepare("UPDATE users SET password_hash=?, salt=? WHERE id=?").bind(hash, salt, target.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target.id).run();
    changed.push("password");
  }
  return json({ ok: true, changed, username: changed.includes("username") ? newUser : target.username });
}
async function adminToggles(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  if ("signups" in data) await setSetting(env, "signups_enabled", !!data.signups);
  if ("logins" in data) await setSetting(env, "logins_enabled", !!data.logins);
  return json({ ok: true, signupsEnabled: await authEnabled(env, "signups"), loginsEnabled: await authEnabled(env, "logins") });
}
async function adminSiteMessage(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const text = cleanName(data.text || "").slice(0, 300);
  const active = !!data.active && !!text;
  await setSetting(env, "site_message", { text, active });
  return json({ ok: true, active });
}
async function adminCreateAccount(env, request, data) {
  const { u, err } = await requireRole(env, request, ADMIN_ROLES); if (err) return err;
  const role = (data.role || "").trim(), name = (data.name || "").trim(), username = (data.username || "").trim();
  const password = data.password || "", email = (data.email || "").trim(), plan = (data.plan || "").trim() || null;
  if (!["kid", "parent", "teacher", "admin"].includes(role)) return json({ error: "Pick a valid account type." }, 400);
  const verr = validateCredentials(name, username, password); if (verr) return json({ error: verr }, 400);
  const taken = (await env.DB.prepare("SELECT 1 FROM users WHERE username=?").bind(username).first()) ||
    (await env.DB.prepare("SELECT 1 FROM account_requests WHERE username=? AND status='pending'").bind(username).first());
  if (taken) return json({ error: "That username is already taken or pending." }, 409);
  const { hash, salt } = await hashPassword(password);
  if (u.role === "super_admin") {
    const uid = await provisionAccount(env, role, name, username, hash, salt, email, plan);
    if (!uid) return json({ error: "That username is already taken." }, 409);
    return json({ ok: true, created: true, role, username });
  }
  await env.DB.prepare("INSERT INTO account_requests (role,name,username,password_hash,salt,email,plan,requested_by,status,created_at) VALUES (?,?,?,?,?,?,?,?,'pending',?)")
    .bind(role, cleanName(name), username, hash, salt, email, plan, u.username, nowIso()).run();
  return json({ ok: true, pending: true, role, username });
}
async function adminResolveRequest(env, request, data) {
  const { u, err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const action = (data.action || "").trim();
  if (!["approve", "decline"].includes(action)) return json({ error: "bad action" }, 400);
  const r = await env.DB.prepare("SELECT * FROM account_requests WHERE id=?").bind(data.id).first();
  if (!r || r.status !== "pending") return json({ error: "Request not found or already handled." }, 404);
  const setStatus = (st) => env.DB.prepare("UPDATE account_requests SET status=?, resolved_at=?, resolved_by=? WHERE id=?").bind(st, nowIso(), u.username, r.id).run();
  if (action === "approve") {
    const taken = await env.DB.prepare("SELECT 1 FROM users WHERE username=?").bind(r.username).first();
    if (taken) { await setStatus("declined"); return json({ error: "Username is now taken; request declined." }, 409); }
    const uid = await provisionAccount(env, r.role, r.name, r.username, r.password_hash, r.salt, r.email || "", r.plan);
    if (!uid) { await setStatus("declined"); return json({ error: "Could not create (username taken). Request declined." }, 409); }
    await setStatus("approved");
    return json({ ok: true, status: "approved", username: r.username });
  }
  await setStatus("declined");
  return json({ ok: true, status: "declined" });
}
async function adminImpersonate(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const target = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(data.userId).first();
  if (!target) return json({ error: "User not found" }, 404);
  if (target.role === "super_admin") return json({ error: "Cannot impersonate another super admin." }, 403);
  const token = await createSession(env, target.id);
  return json({ token, user: await publicUser(env, target) });
}
async function adminSaveSettings(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const ps = data.planSettings;
  if (typeof ps !== "object" || !ps) return json({ error: "planSettings required" }, 400);
  const clean = {};
  for (const plan of ["free", "trial", "pro", "family"]) {
    const p = ps[plan] || {};
    clean[plan] = { ai: !!p.ai, chatsPerDay: parseInt(p.chatsPerDay, 10) || 0, lessonLimit: p.lessonLimit === undefined ? -1 : (parseInt(p.lessonLimit, 10) || 0) };
  }
  await setSetting(env, "plan_settings", clean);
  if ("passPercent" in data) await setSetting(env, "pass_percent", Math.max(1, Math.min(100, parseInt(data.passPercent, 10) || PASS_PERCENT)));
  return json({ ok: true, planSettings: clean, passPercent: await getPassPercent(env) });
}
async function adminSaveLesson(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const lid = (data.id || "").trim(), title = (data.title || "").trim();
  if (!title) return json({ error: "Title is required." }, 400);
  const emoji = (data.emoji || "📘").trim(), blurb = (data.blurb || "").trim(), level = (data.level || "All ages").trim();
  const xp = parseInt(data.xp, 10) || 50, published = data.published === false ? 0 : 1, unit = parseInt(data.unit, 10) || 1;
  const existing = lid ? await env.DB.prepare("SELECT id FROM lessons WHERE id=?").bind(lid).first() : null;
  if (existing) {
    await env.DB.prepare("UPDATE lessons SET emoji=?,title=?,blurb=?,level=?,xp=?,published=?,unit=? WHERE id=?").bind(emoji, title, blurb, level, xp, published, unit, lid).run();
  } else {
    const newId = lid || ("l" + randHex(4));
    const maxpos = (await env.DB.prepare("SELECT COALESCE(MAX(position),-1)+1 p FROM lessons").first()).p;
    const dq = { q: "Did you understand this lesson?", opts: ["Yes!", "Mostly", "Need to review"], answer: 0 };
    await env.DB.prepare("INSERT INTO lessons (id,position,emoji,title,blurb,level,xp,published,steps,quiz,unit) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(newId, maxpos, emoji, title, blurb, level, xp, published, JSON.stringify([{ h: title, p: blurb }]), JSON.stringify(dq), unit).run();
  }
  return json({ ok: true });
}
async function adminDeleteLesson(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  await env.DB.prepare("DELETE FROM lessons WHERE id=?").bind((data.id || "").trim()).run();
  return json({ ok: true });
}
async function adminCommentDismiss(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const c = await env.DB.prepare("SELECT id FROM comments WHERE id=?").bind(data.id).first();
  if (!c) return json({ error: "Comment not found" }, 404);
  await env.DB.prepare("UPDATE comments SET reported=0 WHERE id=?").bind(data.id).run();
  return json({ ok: true });
}
async function adminTakedownResolve(env, request, data) {
  const { u, err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const action = (data.action || "").trim();
  if (!["approve", "deny"].includes(action)) return json({ error: "bad action" }, 400);
  const t = await env.DB.prepare("SELECT * FROM takedowns WHERE id=?").bind(data.id).first();
  if (!t) return json({ error: "Request not found" }, 404);
  if (t.status !== "pending") return json({ error: "Already resolved." }, 400);
  if (action === "approve") {
    await env.DB.prepare("UPDATE projects SET shared=0 WHERE id=?").bind(t.project_id).run();
    await env.DB.prepare("UPDATE takedowns SET status='approved', resolved_at=?, resolved_by=? WHERE project_id=? AND status='pending'").bind(nowIso(), u.username, t.project_id).run();
    return json({ ok: true, status: "approved" });
  }
  await env.DB.prepare("UPDATE takedowns SET status='denied', resolved_at=?, resolved_by=? WHERE id=?").bind(nowIso(), u.username, data.id).run();
  return json({ ok: true, status: "denied" });
}

// ───────────────────────── email (Resend) ─────────────────────────
async function sendEmail(env, to, subject, html) {
  if (!to || !env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "KidVibers <noreply@kidvibers.com>",
        to: [to], subject,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222">${html}</div>`,
        reply_to: env.REPLY_TO || "kidvibers.help@outlook.com",
      }),
    });
    return res.ok;
  } catch (e) { console.log("email failed:", e); return false; }
}

// ───────────────────────── Stripe ─────────────────────────
function stripeEnabled(env) { return !!env.STRIPE_SECRET_KEY; }
function stripePrices(env) {
  return { pro: env.STRIPE_PRICE_PRO, family: env.STRIPE_PRICE_FAMILY, teacher: env.STRIPE_PRICE_TEACHER, school: env.STRIPE_PRICE_SCHOOL, district: env.STRIPE_PRICE_DISTRICT };
}
function siteUrl(env, request) { return (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, ""); }
function stripePlanRoleOk(plan, role) {
  if (["teacher", "school", "district"].includes(plan)) return ["teacher", "super_admin"].includes(role);
  if (["pro", "family"].includes(plan)) return ["kid", "parent", "super_admin"].includes(role);
  return false;
}
async function stripeRequest(env, path, params) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error((j.error && j.error.message) || "Stripe error");
  return j;
}
async function stripeVerifySig(env, payload, sigHeader) {
  if (!env.STRIPE_WEBHOOK_SECRET || !sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  if (!parts.t || !parts.v1) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${payload}`));
  if (bytesToHex(new Uint8Array(sig)) !== parts.v1) return false;
  return Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) < 300;
}

async function apiCheckout(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "Please log in to upgrade." }, 401);
  const plan = (data.plan || "").trim();
  if (!stripePlanRoleOk(plan, u.role)) {
    if (!["pro", "family", "teacher", "school", "district"].includes(plan)) return json({ error: "Unknown plan." }, 400);
    return json({ error: "This account type can't purchase that plan." }, 403);
  }
  await env.DB.prepare("UPDATE users SET plan=? WHERE id=?").bind(plan, u.id).run();
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
  if (u.parent_email) await sendEmail(env, u.parent_email, "About your KidVibers plan",
    "<p>Thanks for your interest in upgrading! <strong>You have not been charged.</strong></p><p>We're currently not accepting new paid plans yet - we'll have that solved soon.</p>");
  return json({ ok: true, plan, user: await publicUser(env, row), notCharged: true });
}

async function apiCheckoutSession(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "Please log in to upgrade." }, 401);
  const plan = (data.plan || "").trim();
  if (!["pro", "family", "teacher", "school", "district"].includes(plan)) return json({ error: "Unknown plan." }, 400);
  if (!stripePlanRoleOk(plan, u.role)) return json({ error: "This account type can't purchase that plan." }, 403);
  const price = stripePrices(env)[plan];
  if (!stripeEnabled(env) || !price) return json({ simulated: true });
  const base = siteUrl(env, request);
  const params = {
    mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": 1,
    success_url: `${base}/checkout.html?status=success&plan=${plan}`, cancel_url: `${base}/checkout.html?plan=${plan}&status=cancel`,
    client_reference_id: String(u.id), "metadata[user_id]": String(u.id), "metadata[plan]": plan, allow_promotion_codes: "true",
  };
  if (u.parent_email) params.customer_email = u.parent_email;
  try { const session = await stripeRequest(env, "/checkout/sessions", params); return json({ url: session.url }); }
  catch (e) { console.log("stripe session error:", e); return json({ error: "Could not start checkout. Please try again." }, 502); }
}

async function apiStripeWebhook(env, rawBody, sigHeader) {
  if (!(await stripeVerifySig(env, rawBody, sigHeader))) return json({ error: "bad signature" }, 400);
  let event; try { event = JSON.parse(rawBody); } catch { return json({ error: "bad payload" }, 400); }
  const obj = (event.data && event.data.object) || {};
  if (event.type === "checkout.session.completed") {
    const uid = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
    const plan = obj.metadata && obj.metadata.plan;
    if (uid && plan) {
      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
      if (row) {
        await env.DB.prepare("UPDATE users SET plan=?, stripe_customer_id=?, stripe_subscription_id=? WHERE id=?").bind(plan, obj.customer ?? null, obj.subscription ?? null, uid).run();
        if (row.parent_email) await sendEmail(env, row.parent_email, "Your KidVibers plan is active 🎉", `<p>Thanks for subscribing! Your <strong>${plan}</strong> plan is now active.</p>`);
      }
    }
  } else if (event.type === "customer.subscription.deleted") {
    if (obj.id) {
      const row = await env.DB.prepare("SELECT * FROM users WHERE stripe_subscription_id=?").bind(obj.id).first();
      if (row) await env.DB.prepare("UPDATE users SET plan=?, stripe_subscription_id=NULL WHERE id=?").bind(["kid", "parent"].includes(row.role) ? "free" : "none", row.id).run();
    }
  }
  return json({ received: true });
}

async function apiBillingPortal(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "Please log in." }, 401);
  if (!stripeEnabled(env) || !u.stripe_customer_id) return json({ error: "No billing account to manage yet." }, 400);
  try { const session = await stripeRequest(env, "/billing_portal/sessions", { customer: u.stripe_customer_id, return_url: `${siteUrl(env, request)}/dashboard.html` }); return json({ url: session.url }); }
  catch (e) { console.log("stripe portal error:", e); return json({ error: "Could not open billing. Please try again." }, 502); }
}

// ───────────────────────── consent + password reset ─────────────────────────
async function apiForgotPassword(env, request, data) {
  const who = (data.usernameOrEmail || "").trim();
  const generic = json({ ok: true, message: "If an account matches, we've emailed a reset link." });
  if (!who || rateLimited(`forgot:${who.toLowerCase()}`, 3, 600)) return generic;
  const row = await env.DB.prepare("SELECT * FROM users WHERE (username=? OR parent_email=?) AND role IN ('parent','teacher') LIMIT 1").bind(who, who).first();
  if (row && row.parent_email) {
    const token = randToken(24);
    const expires = new Date(Date.now() + 2 * 3600000).toISOString().replace(/\.\d+Z$/, "Z");
    await env.DB.prepare("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?").bind(token, expires, row.id).run();
    const url = `${siteUrl(env, request)}/reset.html?token=${token}`;
    await sendEmail(env, row.parent_email, "Reset your KidVibers password",
      `<p>Hi ${cleanName(row.name || "")}, we got a request to reset your KidVibers password.</p><p><a href="${url}">Click here to choose a new password</a> (expires in 2 hours).</p>`);
  }
  return generic;
}
async function apiResetPassword(env, request, data) {
  const token = (data.token || "").trim(), password = data.password || "";
  if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
  const row = await env.DB.prepare("SELECT * FROM users WHERE reset_token=?").bind(token).first();
  if (!row) return json({ error: "This reset link is invalid or already used." }, 400);
  const exp = row.reset_expires;
  if (!exp || new Date() >= new Date(exp.replace("Z", "Z"))) return json({ error: "This reset link has expired. Please request a new one." }, 400);
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare("UPDATE users SET password_hash=?, salt=?, reset_token=NULL, reset_expires=NULL WHERE id=?").bind(hash, salt, row.id).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(row.id).run();
  return json({ ok: true });
}

async function apiConsentStart(env, request, data) {
  const tok = (data.token || "").trim();
  const kid = await env.DB.prepare("SELECT id,name,parent_email FROM users WHERE consent_token=? AND role='kid'").bind(tok).first();
  if (!kid) return json({ error: "Invalid or used consent link." }, 404);
  const confirm = randToken(10);
  await env.DB.prepare("UPDATE users SET consent_confirm_token=? WHERE id=?").bind(confirm, kid.id).run();
  if (kid.parent_email) {
    const confirmUrl = `${siteUrl(env, request)}/index.html?consentconfirm=${confirm}`;
    await sendEmail(env, kid.parent_email, `Confirm consent for ${kid.name}`, `One more step to approve ${kid.name}. <a href="${confirmUrl}">Confirm consent →</a>`);
  }
  return json({ ok: true, confirmToken: confirm, childName: kid.name });
}
async function apiConsentConfirm(env, request, data) {
  const tok = (data.token || "").trim();
  const kid = await env.DB.prepare("SELECT id,name,username,parent_email FROM users WHERE consent_confirm_token=? AND role='kid'").bind(tok).first();
  if (!kid) return json({ error: "Invalid or used confirmation link." }, 404);
  await grantConsent(env, kid.id, "email_plus", kid.parent_email || "parent");
  await logConsent(env, kid.id, kid.username, "email_plus", kid.parent_email || "parent", "Parent gave verifiable consent (email-plus)");
  return json({ ok: true, childName: kid.name });
}
async function apiConsentResend(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "forbidden" }, 403);
  if (consentOk(u)) return json({ error: "This account is already approved." }, 400);
  const newEmail = (data.parentEmail || "").trim();
  if (newEmail) await env.DB.prepare("UPDATE users SET parent_email=? WHERE id=?").bind(newEmail, u.id).run();
  let tok = u.consent_token;
  if (!tok) { tok = randToken(10); await env.DB.prepare("UPDATE users SET consent_token=? WHERE id=?").bind(tok, u.id).run(); }
  const kid = await env.DB.prepare("SELECT name, parent_email FROM users WHERE id=?").bind(u.id).first();
  if (!kid.parent_email) return json({ error: "Please enter a parent's email address." }, 400);
  const consentUrl = `${siteUrl(env, request)}/index.html?consent=${tok}`;
  await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)")
    .bind(kid.parent_email, "consent_request", `Parental consent needed for ${kid.name}: ${consentUrl}`, u.id, tok, nowIso()).run();
  await sendEmail(env, kid.parent_email, `Approve ${kid.name}'s KidVibers account`, `${kid.name} (under 13) wants to use KidVibers. <a href="${consentUrl}">Review &amp; approve →</a>`);
  return json({ ok: true, parentEmail: kid.parent_email });
}

// ───────────────────────── visual editor (text + color edits) ─────────────────────────
// On staging (STAGING_USER set) the password gate already authorized the visitor, so
// editing is open - no admin login needed. On production, editing requires super admin.
async function editAuth(env, request) {
  if (env.STAGING_USER) return null;             // staging: gate already verified
  const { err } = await requireRole(env, request, ["super_admin"]);
  return err || null;
}
async function apiSiteEditsGet(env) {
  const e = await getSetting(env, "site_edits", { colors: {}, texts: {}, blocks: {} });
  return json({ colors: e.colors || {}, texts: e.texts || {}, blocks: e.blocks || {}, canEdit: !!env.STAGING_USER });
}
async function apiSiteEditsSave(env, request, data) {
  const err = await editAuth(env, request); if (err) return err;
  const clean = { colors: (data && data.colors) || {}, texts: (data && data.texts) || {}, blocks: (data && data.blocks) || {} };
  const size = JSON.stringify(clean).length;
  if (size > 4_000_000) return json({ error: "Too much content/images to save - try smaller or fewer images." }, 413);
  await setSetting(env, "site_edits", clean);
  return json({ ok: true });
}
async function apiSiteEditsPublish(env, request) {
  const err = await editAuth(env, request); if (err) return err;
  if (!env.DB_PROD) return json({ error: "Publish is only available from the staging site." }, 400);
  const edits = await getSetting(env, "site_edits", { colors: {}, texts: {}, blocks: {} });
  await env.DB_PROD.prepare("INSERT INTO settings (key,value) VALUES ('site_edits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(edits)).run();
  return json({ ok: true });
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
  if (path === "/api/site-edits" && method === "GET") return apiSiteEditsGet(env);
  if (path === "/api/admin/site-edits" && method === "POST") return apiSiteEditsSave(env, request, data);
  if (path === "/api/admin/site-edits/publish" && method === "POST") return apiSiteEditsPublish(env, request);
  if (path === "/api/me" && method === "GET") return apiMe(env, request);
  if (path === "/api/lessons" && method === "GET") return apiLessons(env);
  if (path === "/api/progress" && method === "GET") return apiProgressGet(env, request);
  if (path === "/api/notices" && method === "GET") return apiNotices(env, request);
  if (path === "/api/shop" && method === "GET") return apiShop(env, request);
  if (path === "/api/gallery" && method === "GET") return apiGallery(env, request);
  if (path.startsWith("/api/project/") && method === "GET") {
    const pid = parseInt(path.split("/").pop(), 10);
    return isNaN(pid) ? json({ error: "bad id" }, 400) : apiProjectGet(env, request, pid);
  }
  if (path.startsWith("/api/comments/") && method === "GET") {
    const pid = parseInt(path.split("/").pop(), 10);
    return isNaN(pid) ? json({ error: "bad id" }, 400) : apiCommentsGet(env, request, pid);
  }
  if (path === "/api/parent/family" && method === "GET") return apiParentFamily(env, request);
  if (path === "/api/parent/messages" && method === "GET") return apiParentMessages(env, request);
  if (path.startsWith("/api/parent/kid-data/") && method === "GET") {
    const kid = parseInt(path.split("/").pop(), 10);
    return isNaN(kid) ? json({ error: "bad id" }, 400) : apiParentKidData(env, request, kid);
  }
  if (path.startsWith("/api/consent/") && method === "GET") return apiConsentLookup(env, path.split("/").pop());
  if (path.startsWith("/api/invite/") && method === "GET") {
    const kid = await env.DB.prepare("SELECT name, username FROM users WHERE link_token=? AND role='kid'").bind(path.split("/").pop()).first();
    return kid ? json({ childName: kid.name, childUsername: kid.username }) : json({ error: "Invite not found" }, 404);
  }
  if (path === "/api/billing/portal" && method === "POST") return apiBillingPortal(env, request);
  if (path === "/api/projects/mine" && method === "GET") return apiProjectsMine(env, request);
  // admin GETs
  if (path === "/api/admin/users" && method === "GET") return adminUsers(env, request);
  if (path === "/api/admin/accounts" && method === "GET") return adminAccounts(env, request);
  if (path === "/api/admin/stats" && method === "GET") return adminStats(env, request);
  if (path === "/api/admin/consent" && method === "GET") return adminConsentGet(env, request);
  if (path === "/api/admin/settings" && method === "GET") return adminSettingsGet(env, request);
  if (path === "/api/admin/reported-comments" && method === "GET") return adminReportedComments(env, request);
  if (path === "/api/admin/takedowns" && method === "GET") return adminTakedowns(env, request);
  if (path === "/api/admin/account-requests" && method === "GET") return adminAccountRequests(env, request);

  // auth POSTs
  if (path === "/api/signup" && method === "POST") return apiSignup(env, request, data);
  if (path === "/api/parent/signup" && method === "POST") return apiParentSignup(env, request, data);
  if (path === "/api/teacher/signup" && method === "POST") return apiTeacherSignup(env, request, data);
  if (path === "/api/login" && method === "POST") return apiLogin(env, request, data, ["kid", "parent", "teacher", "admin", "super_admin"]);
  if (path === "/api/admin/login" && method === "POST") return apiLogin(env, request, data, ADMIN_ROLES);
  if (path === "/api/logout" && method === "POST") return apiLogout(env, request);
  if (path === "/api/forgot-password" && method === "POST") return apiForgotPassword(env, request, data);
  if (path === "/api/reset-password" && method === "POST") return apiResetPassword(env, request, data);

  // billing + consent flows
  if (path === "/api/checkout" && method === "POST") return apiCheckout(env, request, data);
  if (path === "/api/checkout/session" && method === "POST") return apiCheckoutSession(env, request, data);
  if (path === "/api/consent/start" && method === "POST") return apiConsentStart(env, request, data);
  if (path === "/api/consent/confirm" && method === "POST") return apiConsentConfirm(env, request, data);
  if (path === "/api/consent/resend" && method === "POST") return apiConsentResend(env, request, data);

  // parent / teacher / district
  if (path === "/api/parent/add-kid" && method === "POST") return apiParentAddKid(env, request, data);
  if (path === "/api/parent/signout-kid" && method === "POST") return apiParentSignoutKid(env, request, data);
  if (path === "/api/parent/delete-kid" && method === "POST") return apiParentDeleteKid(env, request, data);
  if (path === "/api/school/branding" && method === "POST") return apiSchoolBranding(env, request, data);
  if (path === "/api/school/student/suspend" && method === "POST") return apiSchoolSuspend(env, request, data);
  if (path === "/api/school/student/credentials" && method === "POST") return apiSchoolCredentials(env, request, data);
  if (path === "/api/teacher/new-code" && method === "POST") return apiTeacherNewCode(env, request);
  if (path === "/api/quiz/submit" && method === "POST") return apiQuizSubmit(env, request, data);

  // lessons / progress
  if (path === "/api/progress" && method === "POST") return apiProgressPost(env, request, data);
  if (path === "/api/test/submit" && method === "POST") return apiTestSubmit(env, request, data);
  if (path === "/api/notices/dismiss" && method === "POST") return apiDismissNotice(env, request, data);

  // kid dashboard: shop / avatar / AI / upgrade / class join
  if (path === "/api/shop/buy" && method === "POST") return apiShopBuy(env, request, data);
  if (path === "/api/avatar" && method === "POST") return apiSaveAvatar(env, request, data);
  if (path === "/api/ai" && method === "POST") return apiAi(env, request, data);
  if (path === "/api/request-upgrade" && method === "POST") return apiRequestUpgrade(env, request);
  if (path === "/api/class/join" && method === "POST") return apiClassJoin(env, request, data);

  // gallery / projects / comments
  if (path === "/api/projects/save" && method === "POST") return apiProjectSave(env, request, data);
  if (path === "/api/projects/share" && method === "POST") return apiProjectShare(env, request, data);
  if (path === "/api/projects/delete" && method === "POST") return apiProjectDelete(env, request, data);
  if (path === "/api/projects/like" && method === "POST") return apiProjectLike(env, request, data);
  if (path === "/api/projects/takedown" && method === "POST") return apiProjectTakedown(env, request, data);
  if (path === "/api/comments/add" && method === "POST") return apiCommentAdd(env, request, data);
  if (path === "/api/comments/delete" && method === "POST") return apiCommentDelete(env, request, data);
  if (path === "/api/comments/report" && method === "POST") return apiCommentReport(env, request, data);

  // admin POSTs
  if (path === "/api/admin/set-plan" && method === "POST") return adminSetPlan(env, request, data);
  if (path === "/api/admin/consent" && method === "POST") return adminConsentPost(env, request, data);
  if (path === "/api/admin/notice" && method === "POST") return adminNotice(env, request, data);
  if (path === "/api/admin/delete-user" && method === "POST") return adminDeleteUser(env, request, data);
  if (path === "/api/admin/suspend" && method === "POST") return adminSuspend(env, request, data);
  if (path === "/api/admin/set-credentials" && method === "POST") return adminSetCredentials(env, request, data);
  if (path === "/api/admin/create-account" && method === "POST") return adminCreateAccount(env, request, data);
  if (path === "/api/admin/account-requests/resolve" && method === "POST") return adminResolveRequest(env, request, data);
  if (path === "/api/admin/site-message" && method === "POST") return adminSiteMessage(env, request, data);
  if (path === "/api/admin/toggles" && method === "POST") return adminToggles(env, request, data);
  if (path === "/api/admin/impersonate" && method === "POST") return adminImpersonate(env, request, data);
  if (path === "/api/admin/settings" && method === "POST") return adminSaveSettings(env, request, data);
  if (path === "/api/admin/lesson" && method === "POST") return adminSaveLesson(env, request, data);
  if (path === "/api/admin/lesson/delete" && method === "POST") return adminDeleteLesson(env, request, data);
  if (path === "/api/admin/comment-dismiss" && method === "POST") return adminCommentDismiss(env, request, data);
  if (path === "/api/admin/takedown-resolve" && method === "POST") return adminTakedownResolve(env, request, data);

  // not yet ported
  return json({ error: PORTED_503 }, 503);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Staging gate: when STAGING_USER is set (only on the staging deploy), the whole site
    // is behind a password. Uses a cookie (not the Authorization header) so it doesn't clash
    // with the app's login tokens. Production has no gate.
    if (env.STAGING_USER) {
      const gated = await stagingGate(env, request);
      if (gated) return gated;
    }

    // Stripe webhook needs the RAW body for signature verification - read it here.
    if (url.pathname === "/api/stripe/webhook" && request.method === "POST") {
      try { return await apiStripeWebhook(env, await request.text(), request.headers.get("Stripe-Signature") || ""); }
      catch (e) { console.log("webhook error:", e && e.stack || e); return json({ error: "error" }, 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(env, request, url.pathname); }
      catch (e) { console.log("api error:", e && e.stack || e); return json({ error: "Something went wrong. Please try again." }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
