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
  if (path === "/api/lessons" && method === "GET") return apiLessons(env);
  if (path === "/api/progress" && method === "GET") return apiProgressGet(env, request);
  if (path === "/api/notices" && method === "GET") return apiNotices(env, request);
  if (path === "/api/shop" && method === "GET") return apiShop(env, request);

  // auth POSTs
  if (path === "/api/signup" && method === "POST") return apiSignup(env, request, data);
  if (path === "/api/login" && method === "POST") return apiLogin(env, request, data, ["kid", "parent", "teacher", "admin", "super_admin"]);
  if (path === "/api/admin/login" && method === "POST") return apiLogin(env, request, data, ADMIN_ROLES);
  if (path === "/api/logout" && method === "POST") return apiLogout(env, request);

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
