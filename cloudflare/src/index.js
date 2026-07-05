// KidVibers - Cloudflare Worker backend (port of the Python server).
// Foundation + accounts + lessons. Other endpoints are added in stages;
// any route not yet ported returns a friendly 503 so the static pages still load.

import WORLDS from "./worlds.json";
import SHOP_ITEMS from "./shop.json";
const UNIT_NAMES = Object.fromEntries(Object.entries(WORLDS).map(([u, w]) => [u, `${w.emoji} ${w.name}`]));
const SHOP_BY_ID = Object.fromEntries(SHOP_ITEMS.map((i) => [i.id, i]));

// ───────────────────────── constants (mirror server.py) ─────────────────────────
const TRIAL_DAYS = 3;
const PRO_LAUNCH_SLOTS = 50;   // first 50 kids get 30 days of Pro free
const PRO_LAUNCH_DAYS = 30;
const COPPA_AGE = 13;
const STARTER_TOKENS = 40;
const TOKENS_PER_LESSON = 10;
const REFERRAL_BONUS = 50;      // tokens each kid gets when a referral signs up
const REFERRAL_FREE_DAYS = 7;   // + days of free Pro (AI + unlimited lessons) for both kids
const REFERRAL_MAX_REWARDED = 5; // a referrer earns rewards for at most this many sign-ups (anti-farming)
const PASS_PERCENT = 70;
const ADMIN_ROLES = ["admin", "super_admin"];
const DISTRICT_PLANS = ["school", "district"];
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const DEFAULT_PLAN_SETTINGS = {
  free:   { ai: false, chatsPerDay: 0,   lessonsPerDay: 3  },
  trial:  { ai: false, chatsPerDay: 0,   lessonsPerDay: 5  },
  pro:    { ai: true,  chatsPerDay: 100, lessonsPerDay: -1 },
  family: { ai: true,  chatsPerDay: -1,  lessonsPerDay: -1 },
};
const TEACHER_PLANS = {
  teacher:  { label: "Teacher Plan",  price: 24,  students: 100 },
  school:   { label: "School Plan",   price: 105, students: 550 },
  district: { label: "District Plan", price: 125, students: -1 },
};
const NO_TEACHER_PLAN = { label: "No plan yet", price: 0, students: 0 };
const SCHOOL_ADDON_PRICE = 25;   // a District can add extra schools at $25/mo each
const DEFAULT_AVATAR = { face: "face_kid", hat: null, accessory: null, clothing: null, companion: null, background: "bg_purple" };
const FREE_ITEMS = ["face_kid", "bg_purple"];

// ───────────────────────── small utils ─────────────────────────
function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
// Strip characters that could break out of an HTML tag or attribute (<, >, quotes, backtick, &).
// Names are shown in many places — some inside onclick="..." handlers — so neutralize at the source.
function cleanName(s) { return (s || "").replace(/[<>"'`&]/g, "").trim(); }
// Escape untrusted text before embedding it in email/notification HTML.
function escHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// ── Kid-safety content filter ──
// Anything a kid types that a teacher/parent might see (project titles, help notes) is
// screened for profanity/slurs and for personal info (phone/email/address) — kids shouldn't
// be posting where they live. Returns a friendly reason, or null if the text is fine.
const BAD_WORDS = [
  "fuck","shit","bitch","asshole","bastard","dick","piss","cunt","slut","whore","fag","faggot",
  "nigger","nigga","retard","rape","kys","dumbass","douche","penis","vagina","porn","nude","sex",
];
// Child-welfare watchlist: phrases that suggest self-harm, suicidal thoughts, abuse, or serious
// bullying. These are NOT blocked (a kid reaching out for help must get through) — instead they
// quietly alert the child's teacher/school + the KidVibers team so a grown-up can check in.
const WELFARE_PATTERNS = [
  /\bkill (myself|my self)\b/, /\bkms\b/, /\bwant to die\b/, /\bend it all\b/, /\bsuicid/, /\bself harm\b/,
  /\bcut(ting)? myself\b/, /\bhurt myself\b/, /\bno reason to live\b/, /\bhate my life\b/, /\bwish i was dead\b/,
  /\bbeing bullied\b/, /\bthey hit me\b/, /\bsomeone hurts me\b/, /\bhits me\b/, /\bscared to go home\b/,
];
function welfareFlag(text) {
  const low = (text || "").toString().toLowerCase();
  return WELFARE_PATTERNS.some((re) => re.test(low));
}
function contentIssue(text) {
  const t = (text || "").toString();
  const low = t.toLowerCase();
  const squashed = low.replace(/[^a-z]/g, "");
  for (const w of BAD_WORDS) { if (squashed.includes(w) || low.includes(w)) return "Let's keep it kind and clean. 🙂"; }
  if (/(\+?\d[\s().-]?){10,}/.test(t)) return "Please don't share phone numbers — keep personal info private. 🔒";
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t)) return "Please don't share email addresses — keep personal info private. 🔒";
  if (/\b\d{1,5}\s+[a-z].{0,20}\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd|court|ct)\b/i.test(low)) return "Please don't share your address — keep personal info private. 🔒";
  return null;
}

// Send a safety alert to the child's SCHOOL/TEACHER (the family owner) so the adult responsible
// for them in class is a real-time first responder — plus the KidVibers team. Stored as a notice
// on the teacher/district account (kind='safety'), which their dashboard surfaces.
async function alertSchool(env, kid, title, detail) {
  try {
    if (kid && kid.family_id != null) {
      const owner = await env.DB.prepare("SELECT id,role FROM users WHERE id=?").bind(kid.family_id).first();
      if (owner && owner.role === "teacher") {
        await env.DB.prepare("INSERT INTO notices (user_id,kind,body,created_at) VALUES (?,?,?,?)")
          .bind(owner.id, "safety", `🚩 SAFETY ALERT — ${kid.name} (@${kid.username}): ${title}${detail ? " — " + detail : ""}`, nowIso()).run();
      }
    }
    await notifyAdmin(env, `🚩 Safety alert: ${kid && kid.name}`, `🚩 *Safety alert*\n• Student: ${kid && kid.name} (@${kid && kid.username})\n• ${title}${detail ? `\n• Detail: ${detail}` : ""}`);
  } catch {}
}

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
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  // Safe CSP directives that don't restrict scripts/styles (so nothing breaks) but block
  // clickjacking, base-tag injection, plugins, and form-hijacking.
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  // Turn off device APIs the site never uses.
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
  "X-Permitted-Cross-Domain-Policies": "none",
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
  // A referral reward (or other promo) can temporarily grant Pro-level perks
  // (AI + unlimited lessons) on top of whatever plan the account is actually on.
  if (user.promo_pro_until && new Date(user.promo_pro_until) > new Date()) return "pro";
  if (user.plan === "trial") {
    const left = trialDaysLeft(user);
    if (left !== null && left <= 0) return "free";
  }
  return user.plan;
}
function promoDaysLeft(user) {
  if (!user.promo_pro_until) return 0;
  const ms = new Date(user.promo_pro_until) - new Date();
  return ms > 0 ? Math.ceil(ms / 86400000) : 0;
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
async function lessonsUsedToday(env, userId) {
  const row = await env.DB.prepare("SELECT count FROM lessons_daily WHERE user_id=? AND day=?").bind(userId, todayStr()).first();
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
  // Preview users: return synthetic public data without any DB lookups.
  if (user.isPreview) {
    const settings = await getPlanSettings(env);
    const eff = effectivePlan(user);
    const cfg = planCfg(settings, eff);
    const tp = user.role === "teacher" ? teacherPlanCfg(user.plan) : null;
    let av; try { av = JSON.parse(user.avatar || "null") || { ...DEFAULT_AVATAR }; } catch { av = { ...DEFAULT_AVATAR }; }
    let ow; try { ow = JSON.parse(user.owned_items || "null") || [...FREE_ITEMS]; } catch { ow = [...FREE_ITEMS]; }
    return {
      id: 0, role: user.role, name: user.name, username: user.username, isPreview: true, previewRole: user.previewRole,
      plan: user.plan, effectivePlan: eff, trialDaysLeft: null,
      hasAI: !!cfg.ai, chatsPerDay: cfg.chatsPerDay | 0, chatsUsedToday: 5,
      lessonsPerDay: -1, lessonsUsedToday: 4, lessonsDone: 12,
      unitsPassed: [1, 2], level: 3, tokens: 250, avatar: av, ownedItems: ow,
      parentEmail: user.parent_email || "", ageBand: user.age_band || "", ageYears: user.age_years ?? null,
      familyId: 1, consentStatus: "not_required", consentMethod: null, needsConsent: false,
      school: user.school || null, suspended: false, hasBilling: false, quizDone: true,
      quizLevel: "Adventurer", recommendedPlan: user.plan, startUnit: 1, linkToken: "preview",
      ...(tp ? { teacherPlan: user.plan, teacherPlanLabel: tp.label, studentLimit: tp.students,
        studentsUsed: user.plan === "district" ? 342 : user.plan === "school" ? 89 : 23,
        isDistrict: DISTRICT_PLANS.includes(user.plan), isFullDistrict: user.plan === "district",
        partOfDistrict: false, classCode: user.class_code || "DEMO12",
        brandName: user.brand_name || "Preview Organization", brandLogo: null } : {}),
    };
  }
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
      isFullDistrict: user.plan === "district",   // only true Districts can add schools
      partOfDistrict: user.district_id != null,
      classCode: user.class_code ?? null,
      brandName: user.brand_name ?? null, brandLogo: user.brand_logo ?? null,
      logoutPinSet: !!(await getLogoutPin(env, user.family_id)),
      retentionMonths: parseInt((await getSetting(env, `retention:${user.family_id}`, "0")), 10) || 0,
    };
  }
  const kidBrand = user.role === "kid" ? await familyBranding(env, user.family_id) : {};
  const kidGroup = user.role === "kid" ? await familyGroup(env, user.family_id) : {};
  // Can this kid self-logout on a shared device? Only if their teacher set a session PIN.
  const hasLogoutPin = user.role === "kid" ? !!(await getLogoutPin(env, user.family_id)) : false;

  // School schedule check: if the kid's teacher has hours set, enforce them.
  let scheduleLocked = false, scheduleMsg = "";
  if (user.role === "kid" && user.family_id) {
    const sched = await getTeacherSchedule(env, user.family_id);
    if (sched) {
      const check = scheduleAllows(sched);
      if (!check.allowed) { scheduleLocked = true; scheduleMsg = check.reason; }
    }
  }

  return {
    id: user.id, role: user.role, name: user.name, username: user.username,
    plan: user.plan, effectivePlan: eff, trialDaysLeft: trialDaysLeft(user),
    promoProDaysLeft: promoDaysLeft(user),
    ...teacher,
    hasAI: !!cfg.ai, chatsPerDay: cfg.chatsPerDay | 0, chatsUsedToday: await chatsUsedToday(env, user.id),
    lessonsPerDay: lessonLimitFor(await getPlanSettings(env), user),
    lessonsUsedToday: await lessonsUsedToday(env, user.id),
    lessonsDone: await lessonsDoneCount(env, user.id),
    unitsPassed: up, level: up.length + 1,
    tokens: user.tokens ?? 0, avatar, ownedItems: owned,
    linkToken: user.link_token ?? null, parentEmail: user.parent_email ?? null,
    ageBand: user.age_band, ageYears: user.age_years ?? null, familyId: user.family_id,
    consentStatus: cstatus, consentMethod: user.consent_method ?? null,
    needsConsent: user.role === "kid" && cstatus === "pending",
    scheduleLocked, scheduleMsg, hasLogoutPin,
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

// ── School schedule access control ───────────────────────────
// Returns {allowed, reason} based on the teacher/school/district schedule JSON.
function scheduleAllows(schedule) {
  if (!schedule || !schedule.enabled) return { allowed: true };
  const tz = schedule.timezone || "America/New_York";
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayNum = dayMap[parts.weekday] ?? 0;
    const cur = parseInt(parts.hour) * 60 + parseInt(parts.minute);
    const days = schedule.days ?? [1, 2, 3, 4, 5];
    if (!days.includes(dayNum)) {
      const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const allowedNames = days.map(d => dayNames[d]).join(", ");
      return { allowed: false, reason: `Not a school day. Access is available on: ${allowedNames}.` };
    }
    const [sh, sm] = (schedule.start || "00:00").split(":").map(Number);
    const [eh, em] = (schedule.end || "23:59").split(":").map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    if (cur < start) {
      return { allowed: false, reason: `School hasn't started yet. Access opens at ${schedule.start} (${tz}).` };
    }
    if (cur > end) {
      return { allowed: false, reason: `School hours are over. Access was until ${schedule.end} (${tz}).` };
    }
    return { allowed: true };
  } catch { return { allowed: true }; }
}

async function getTeacherSchedule(env, familyId) {
  if (!familyId) return null;
  const teacher = await env.DB.prepare("SELECT schedule FROM users WHERE id=? AND role='teacher'").bind(familyId).first();
  if (!teacher || !teacher.schedule) return null;
  try { return JSON.parse(teacher.schedule); } catch { return null; }
}

async function apiTeacherScheduleGet(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["teacher"].includes(u.role)) return json({ error: "Teachers only." }, 403);
  let schedule = null;
  try { schedule = u.schedule ? JSON.parse(u.schedule) : null; } catch {}
  return json({ schedule: schedule || { enabled: false, timezone: "America/New_York", days: [1,2,3,4,5], start: "08:00", end: "15:30" } });
}

async function apiTeacherScheduleSet(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["teacher"].includes(u.role)) return json({ error: "Teachers only." }, 403);
  const schedule = {
    enabled: !!data.enabled,
    timezone: (data.timezone || "America/New_York").trim(),
    days: Array.isArray(data.days) ? data.days.map(Number).filter(d => d >= 0 && d <= 6) : [1,2,3,4,5],
    start: (data.start || "08:00").trim(),
    end: (data.end || "15:30").trim(),
  };
  await env.DB.prepare("UPDATE users SET schedule=? WHERE id=?").bind(JSON.stringify(schedule), u.id).run();
  // Also apply to any school sub-accounts under a district teacher
  if (DISTRICT_PLANS.includes(u.plan)) {
    await env.DB.prepare("UPDATE users SET schedule=? WHERE district_id=? AND role='teacher'").bind(JSON.stringify(schedule), u.id).run();
  }
  return json({ ok: true, schedule });
}

// ───────────────────────── sessions ─────────────────────────
function bearer(request) {
  const a = request.headers.get("Authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7).trim() : null;
}
// Synthetic user objects used when the super admin previews a role (no real account needed).
function mockUserForRole(role) {
  const base = {
    id: 0, name: "Preview", username: "preview", role: "kid",
    plan: "pro", trial_ends: null, family_id: 0,
    tokens: 250, avatar: JSON.stringify({ face: "face_kid", hat: "hat_cap", background: "bg_purple" }),
    owned_items: JSON.stringify(["face_kid", "bg_purple", "hat_cap", "acc_glass"]),
    link_token: "preview", parent_email: "parent@preview.com",
    age_band: "9-11", age_years: 10, consent_status: "not_required",
    consent_method: null, consent_by: null, consent_token: null, consent_confirm_token: null,
    suspended: 0, class_code: "DEMO12", school: "Preview School",
    brand_name: "Preview District", brand_logo: null, district_id: null,
    quiz_done: 1, quiz_level: "Adventurer", quiz_plan: "pro", start_unit: 1,
    stripe_customer_id: null, stripe_subscription_id: null, launch_pro: 0,
    created_at: nowIso(), isPreview: true, previewRole: role,
  };
  if (role === "kid")      return { ...base, role: "kid", plan: "pro" };
  if (role === "parent")   return { ...base, role: "parent", plan: "family", name: "Preview Parent", username: "preview_parent", age_band: "", age_years: null, parent_email: "" };
  if (role === "teacher")  return { ...base, role: "teacher", plan: "teacher", name: "Preview Teacher", username: "preview_teacher", age_band: "", age_years: null, parent_email: "", district_id: null };
  if (role === "school")   return { ...base, role: "teacher", plan: "school",  name: "Preview School Admin", username: "preview_school", age_band: "", age_years: null, parent_email: "", district_id: null };
  if (role === "district") return { ...base, role: "teacher", plan: "district", name: "Preview District Admin", username: "preview_district", age_band: "", age_years: null, parent_email: "", district_id: null };
  return base;
}
const SESSION_MAX_DAYS = 90;   // tokens older than this stop working (kid just logs in again)

async function userFromToken(env, token) {
  if (!token) return null;
  // Check for a preview session first (super-admin role previews, no real account).
  const preview = await env.DB.prepare("SELECT role, expires_at FROM preview_sessions WHERE token=?").bind(token).first();
  if (preview) {
    if (preview.expires_at < nowIso()) { await env.DB.prepare("DELETE FROM preview_sessions WHERE token=?").bind(token).run(); return null; }
    return mockUserForRole(preview.role);
  }
  const cutoff = new Date(Date.now() - SESSION_MAX_DAYS * 86400000).toISOString();
  return await env.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.created_at >= ?").bind(token, cutoff).first();
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

// Make a unique, valid username from a display name (for Google sign-ups).
async function uniqueUsername(env, name) {
  let base = (name || "user").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || "user";
  if (base.length < 3) base = "user" + base;
  for (let i = 0; i < 30; i++) {
    const candidate = i === 0 ? base : (base.slice(0, 14) + Math.floor(Math.random() * 9000 + 1000));
    const taken = await env.DB.prepare("SELECT 1 FROM users WHERE username=?").bind(candidate).first();
    if (!taken) return candidate;
  }
  return "user" + randHex(4);
}

// Sign in / sign up with Google. Verifies the Google ID token, then finds or creates a
// PARENT account (grown-ups only - kids can't have Google accounts).
async function apiAuthGoogle(env, request, data) {
  const idToken = (data.credential || "").trim();
  if (!idToken) return json({ error: "Missing Google sign-in token." }, 400);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google sign-in isn't configured." }, 500);
  // Verify the token with Google.
  let tok;
  try {
    const resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
    if (!resp.ok) return json({ error: "Google sign-in failed. Please try again." }, 401);
    tok = await resp.json();
  } catch (e) { return json({ error: "Couldn't reach Google. Please try again." }, 502); }
  // The token MUST be issued for our app, from Google, and verified.
  if (tok.aud !== env.GOOGLE_CLIENT_ID) return json({ error: "This Google sign-in isn't for KidVibers." }, 401);
  if (!["accounts.google.com", "https://accounts.google.com"].includes(tok.iss)) return json({ error: "Invalid Google token." }, 401);
  if (tok.email_verified !== "true" && tok.email_verified !== true) return json({ error: "Your Google email isn't verified yet." }, 401);
  const sub = tok.sub, email = (tok.email || "").toLowerCase();
  const name = cleanName(tok.name || tok.given_name || "Parent");
  if (!sub || !email) return json({ error: "Google didn't return enough info." }, 401);
  // Find by Google id, then by email (link existing grown-up accounts).
  let row = await env.DB.prepare("SELECT * FROM users WHERE google_sub=?").bind(sub).first();
  if (!row) {
    row = await env.DB.prepare("SELECT * FROM users WHERE lower(parent_email)=? AND role IN ('parent','teacher','admin','super_admin')").bind(email).first();
    if (row) await env.DB.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(sub, row.id).run();
  }
  if (row) {
    // Returning Google user → log in.
    const [active] = suspensionStatus(row);
    if (active && row.suspended) return json({ error: "This account has been suspended." }, 403);
    const token = await createSession(env, row.id);
    return json({ token, user: await publicUser(env, row) });
  }
  // New → collect the child's details + the parent's confirmation, then make the account.
  const kidName = (data.kidName || "").trim();
  const username = (data.username || "").trim();
  const password = data.password || "";
  let ageYears = null;
  if (data.age !== undefined && data.age !== "" && data.age !== null) { const n = parseInt(data.age, 10); if (!isNaN(n)) ageYears = n; }
  const attest = data.attest === true || data.attest === "true";
  if (!kidName || !username || !password || ageYears === null || !attest) {
    // Ask the frontend to show the details form (prefill the parent's email from Google).
    return json({ needsDetails: true, parentName: name, email });
  }
  const err = validateCredentials(kidName, username, password);
  if (err) return json({ error: err }, 400);
  if (ageYears < 4 || ageYears > 18) return json({ error: "Please enter the child's age (between 4 and 18)." }, 400);
  // First 50 kids get 30 days of Pro free.
  const slotsUsed = await launchSlotsUsed(env);
  const getLaunchPro = slotsUsed < PRO_LAUNCH_SLOTS;
  const planDays = getLaunchPro ? PRO_LAUNCH_DAYS : TRIAL_DAYS;
  const trialEnds = new Date(Date.now() + planDays * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
  // The parent signed in with their own (Google-verified) email AND confirmed they're the
  // parent/guardian, so consent is GRANTED right away - the kid can play immediately.
  const r = await createUser(env, {
    role: "kid", name: kidName, username, password, email, age: "", age_years: ageYears,
    plan: getLaunchPro ? "pro" : "trial", trial_ends: trialEnds,
    consent_status: "granted", consent_method: "google_parent", consent_by: email,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  if (getLaunchPro) await env.DB.prepare("UPDATE users SET launch_pro=1 WHERE id=?").bind(r.uid).run();
  await env.DB.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(sub, r.uid).run();
  await logConsent(env, r.uid, username, "google_parent", email, "Parent signed in with Google and confirmed they are the parent/guardian (18+)");
  // Send the parent a confirmation/notice email.
  await sendEmail(env, email, `${kidName}'s KidVibers account is ready 🎉`,
    `<p>You set up <strong>${kidName}</strong>'s KidVibers account and confirmed you're the parent/guardian. They're all set to start coding!</p>
     <p>You can manage the account anytime - and if this wasn't you, reply to let us know.</p>`);
  const newRow = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(r.uid).first();
  const token = await createSession(env, r.uid);
  return json({ token, user: await publicUser(env, newRow), launchPro: getLaunchPro });
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
      "INSERT INTO users (role,name,username,password_hash,salt,parent_email,kid_email,age_band,age_years,plan,trial_ends,family_id," +
      "tokens,avatar,owned_items,link_token,consent_status,consent_method,consent_by,consent_token,school,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      opts.role, name, opts.username, hash, salt, opts.email || "", opts.kid_email ?? null, opts.age || "", opts.age_years ?? null,
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

async function launchSlotsUsed(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE role='kid' AND launch_pro=1").first();
  return (row && row.c) || 0;
}
async function apiLaunchSlots(env) {
  const used = await launchSlotsUsed(env);
  const remaining = Math.max(0, PRO_LAUNCH_SLOTS - used);
  return json({ total: PRO_LAUNCH_SLOTS, used, remaining, active: remaining > 0 });
}

async function apiSignup(env, request, data) {
  if (!(await authEnabled(env, "signups"))) return json({ error: "Sign-ups are temporarily disabled. Please check back soon." }, 403);
  // Throttle mass account creation: max 6 new accounts per IP per hour.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(`signup:${ip}`, 6, 3600)) return json({ error: "Too many sign-ups from here. Please try again later." }, 429);
  const name = (data.name || "").trim();
  const username = (data.username || "").trim();
  const password = data.password || "";
  const email = (data.parentEmail || "").trim();
  const kidEmail = (data.kidEmail || "").trim();
  const ageBand = (data.ageBand || "").trim();
  let ageYears = null;
  if (data.age !== undefined && data.age !== "" && data.age !== null) { const n = parseInt(data.age, 10); if (!isNaN(n)) ageYears = n; }
  const err = validateCredentials(name, username, password);
  if (err) return json({ error: err }, 400);
  // Age is REQUIRED and must be sensible. Without this, a child could be created with no age
  // (or a typo like 9999) and skip the under-13 parental-consent gate entirely.
  if (ageYears === null || ageYears < 4 || ageYears > 18)
    return json({ error: "Please enter the child's age (between 4 and 18)." }, 400);
  // If a parent email is given, it must look like a real email so consent/notices can be delivered.
  if (email && !/^\S+@\S+\.\S+$/.test(email))
    return json({ error: "Please enter a valid parent email address." }, 400);
  // A child's email is now required at signup.
  if (!kidEmail)
    return json({ error: "A child's email is required." }, 400);
  if (!/^\S+@\S+\.\S+$/.test(kidEmail))
    return json({ error: "Please enter a valid email address for the child." }, 400);
  // A parent email is still required so we can notify the parent and let them manage/withdraw.
  if (!email)
    return json({ error: "A parent's email is required so we can keep a parent in the loop." }, 400);
  // Consent happens in the BACKGROUND: the kid can play right away (no blocking wall), but we
  // record consent against the parent's email and email the parent so they can review or withdraw.
  // This keeps a COPPA audit trail without the friction of a hard gate.
  const needsConsent = false;
  const consentToken = randToken(10);  // still issued so a parent can manage from the email link
  const consentStatus = "granted";
  // Check if a launch Pro slot is available - first 50 kids get 30 days of Pro free.
  const slotsUsed = await launchSlotsUsed(env);
  const getLaunchPro = slotsUsed < PRO_LAUNCH_SLOTS;
  const planDays = getLaunchPro ? PRO_LAUNCH_DAYS : TRIAL_DAYS;
  const planName = getLaunchPro ? "pro" : "trial";
  const trialEnds = new Date(Date.now() + planDays * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
  const r = await createUser(env, {
    role: "kid", name, username, password, email, kid_email: kidEmail || null, age: ageBand, age_years: ageYears, plan: planName,
    trial_ends: trialEnds, consent_status: consentStatus, consent_method: "signup_parent_email",
    consent_by: email, consent_token: consentToken,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  if (getLaunchPro) await env.DB.prepare("UPDATE users SET launch_pro=1 WHERE id=?").bind(r.uid).run();
  // Apply a referral code if one was used (rewards both kids).
  await applyReferral(env, r.uid, (data.referralCode || data.ref || "").trim());
  // Record the consent for the audit trail.
  await logConsent(env, r.uid, username, "signup_parent_email", email, "Parent email provided at signup; parent notified and can review/withdraw");
  const origin = new URL(request.url).origin;
  const inviteUrl = `${origin}/index.html?plink=${r.row.link_token}`;
  if (email) {
    const inviteBody = `${name} just joined KidVibers! Tap "Sign My Kid and Myself Up" to create your parent account and connect to ${name}: ${inviteUrl}`;
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)")
      .bind(email, "parent_invite", inviteBody, r.uid, r.row.link_token, nowIso()).run();
    // Notify the parent in the background (no blocking gate). They can manage or withdraw anytime.
    const manageUrl = `${origin}/index.html?consent=${consentToken}`;
    const noticeBody = `${name} just started learning to code on KidVibers. You can connect, manage, or remove the account anytime: ${manageUrl}`;
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,link_token,created_at) VALUES (?,?,?,?,?,?)")
      .bind(email, "consent_notice", noticeBody, r.uid, consentToken, nowIso()).run();
    const verifyUrl = `${origin}/consent-verify.html?token=${consentToken}`;
    await sendEmail(env, email, `${name} just joined KidVibers — please approve 🚀`,
      `<p><strong>${name}</strong> just started learning to code on KidVibers - a safe, ad-free coding app for kids.</p>
       <p>You're listed as their parent/guardian. Please confirm you approve of ${name} using KidVibers (this is our verifiable parental consent under COPPA):</p>
       <p><a href="${verifyUrl}" style="display:inline-block;background:#22c55e;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:800;">✓ Verify &amp; Approve ${name}'s account</a></p>
       <p style="margin-top:14px;">Or <a href="${manageUrl}" style="color:#7c3aed;font-weight:700;">manage / remove the account</a> at any time.</p>
       <p style="color:#666;font-size:0.9rem;">If you didn't expect this, use the manage link to remove the account. No ads, no data selling - ever.</p>`);
  }
  const token = await createSession(env, r.uid);
  await notifyAdmin(env, `🧒 New kid signed up: ${name}`, `🧒 *New kid signed up!*\n• Name: ${name}\n• Username: @${username}\n• Age: ${ageYears}\n• Parent email: ${email || "none"}\n• Plan: ${planName}${getLaunchPro ? " (Launch Pro 🎉)" : ""}`);
  return json({
    token, user: await publicUser(env, r.row),
    inviteToken: r.row.link_token, inviteUrl, parentEmail: email,
    needsConsent, consentToken,
    launchPro: getLaunchPro, slotsRemaining: Math.max(0, PRO_LAUNCH_SLOTS - slotsUsed - 1),
  });
}

// ───────────────────────── lessons / progress / boss battles ─────────────────────────
function consentOk(user) {
  if (user.role !== "kid") return true;
  return ["granted", "not_required"].includes(user.consent_status ?? "not_required");
}
// Server-side school-hours enforcement. Returns a reason string if the kid is currently
// blocked by their teacher's schedule, else null. The client lock is convenience only;
// this is the real gate so a kid can't bypass it via direct API calls.
async function scheduleBlocks(env, user) {
  if (!user || user.role !== "kid" || !user.family_id) return null;
  const sched = await getTeacherSchedule(env, user.family_id);
  if (!sched) return null;
  const check = scheduleAllows(sched);
  return check.allowed ? null : (check.reason || "KidVibers isn't available right now (school hours).");
}
async function getPassPercent(env) {
  const v = await getSetting(env, "pass_percent", PASS_PERCENT);
  const n = parseInt(v, 10);
  return isNaN(n) ? PASS_PERCENT : n;
}
function lessonLimitFor(settings, user) {
  // lessonsPerDay replaces the old lifetime lessonLimit.
  // -1 means unlimited; otherwise it's the max new lessons per day.
  const cfg = planCfg(settings, effectivePlan(user));
  if (cfg.lessonsPerDay !== undefined) return cfg.lessonsPerDay;
  if (cfg.lessonLimit !== undefined) return cfg.lessonLimit;  // backwards compat
  return -1;
}
function lessonPublic(r) {
  let quiz = {}, steps = [];
  try { quiz = JSON.parse(r.quiz || "{}"); } catch {}
  try { steps = JSON.parse(r.steps || "[]"); } catch {}
  // ANTI-CHEAT: never ship the correct answer (or the explanation that reveals it) to the
  // client. Quiz answers are checked server-side via /api/quiz/answer, and boss battles are
  // graded in apiTestSubmit. The client only needs the question + options.
  const safeQuiz = quiz && quiz.q ? { q: quiz.q, opts: quiz.opts || quiz.options || [] } : {};
  return {
    id: r.id, position: r.position, emoji: r.emoji, title: r.title, blurb: r.blurb,
    level: r.level, xp: r.xp, published: !!r.published, unit: r.unit ?? 1, steps, quiz: safeQuiz,
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
  // Preview mode: return synthetic progress so all worlds are unlocked and lessons are playable.
  if (u.isPreview) {
    const settings = await getPlanSettings(env);
    const allLessons = (await env.DB.prepare("SELECT id FROM lessons WHERE published=1").all()).results || [];
    const allUnits = [...new Set(allLessons.map(l => l.unit).filter(Boolean))].sort((a,b)=>a-b);
    // Mark every lesson as completed and every unit as passed so nothing is locked.
    const previewCompleted = allLessons.map(l => l.id);
    const unitTestsPreview = {};
    allUnits.forEach(u => { unitTestsPreview[u] = { passed: true, bestScore: 100, attempts: 1 }; });
    return json({
      completed: previewCompleted,
      unitsPassed: allUnits,
      unitTests: unitTestsPreview,
      lessonsPerDay: -1,
      lessonsUsedToday: 0,
      lessonsDone: previewCompleted.length,
    });
  }
  const rows = (await env.DB.prepare("SELECT lesson_id FROM progress WHERE user_id=?").bind(u.id).all()).results || [];
  const tests = (await env.DB.prepare("SELECT unit,passed,best_score,attempts FROM unit_tests WHERE user_id=?").bind(u.id).all()).results || [];
  const settings = await getPlanSettings(env);
  const unitTests = {};
  for (const t of tests) unitTests[t.unit] = { passed: !!t.passed, bestScore: t.best_score, attempts: t.attempts };
  return json({
    completed: rows.map((x) => x.lesson_id),
    unitsPassed: await unitsPassed(env, u.id),
    unitTests,
    lessonsPerDay: lessonLimitFor(settings, u),
    lessonsUsedToday: await lessonsUsedToday(env, u.id),
    lessonsDone: rows.length,
  });
}

// Check a lesson-quiz answer server-side (answers are never shipped to the client).
// Returns whether the choice was right, plus the correct index + explanation so the UI
// can highlight it AFTER the kid has committed to an answer — same as the old UX.
async function apiQuizAnswer(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  // Light rate limit: generous for real lesson-taking, slows bulk answer-scraping.
  if (!u.isPreview && rateLimited(`quizans:${u.id}`, 120, 3600)) return json({ error: "Whoa, that's a lot of answers! Take a short break. 🙂" }, 429);
  const lessonId = (data.lessonId || "").trim();
  const choice = parseInt(data.choice, 10);
  if (!lessonId || isNaN(choice)) return json({ error: "lessonId and choice required" }, 400);
  const r = await env.DB.prepare("SELECT quiz FROM lessons WHERE id=? AND published=1").bind(lessonId).first();
  if (!r) return json({ error: "Unknown lesson." }, 404);
  let q = {}; try { q = JSON.parse(r.quiz || "{}"); } catch {}
  if (!q.q || !("answer" in q)) return json({ error: "No quiz for this lesson." }, 404);
  // Record that this kid genuinely went through the quiz (any answer counts as the attempt).
  // apiProgressPost requires this marker before accepting a completion — so progress can't
  // be farmed by POSTing /api/progress directly without ever opening the quiz.
  const correct = choice === q.answer;
  if (!u.isPreview) {
    await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(`quizok:${u.id}:${lessonId}`, nowIso()).run();
    // SERVER-SIDE fail tracking: the 3rd wrong answer on this lesson today burns one of the
    // day's lesson slots automatically. The client also reports 3 failed runs, but a kid who
    // blocks that call no longer escapes the cost — and burnFailSlot dedupes, so an honest
    // client reporting too never double-charges.
    if (!correct) {
      const failKey = `quizfail:${u.id}:${lessonId}:${todayStr()}`;
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(failKey).first();
      const fails = (parseInt(row && row.value, 10) || 0) + 1;
      await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(failKey, String(fails)).run();
      if (fails >= 3) await burnFailSlot(env, u, lessonId);
    }
  }
  return json({ correct, answer: q.answer, explain: q.explain || "" });
}

async function apiProgressPost(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  // Preview mode: simulate completion without touching the real DB.
  if (u.isPreview) {
    const allLessons = (await env.DB.prepare("SELECT id FROM lessons WHERE published=1").all()).results || [];
    const allUnits = [...new Set(allLessons.map(l => l.unit).filter(Boolean))].sort((a,b)=>a-b);
    return json({ completed: allLessons.map(l => l.id), unitsPassed: allUnits, tokensAwarded: 10, tokens: 260, lessonsUsedToday: 1 });
  }
  if (!consentOk(u)) return json({ error: "A parent must approve this account first.", consentRequired: true }, 403);
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
  const lessonId = (data.lessonId || "").trim();
  if (!lessonId) return json({ error: "lessonId required" }, 400);
  // Must be a REAL published lesson - otherwise kids could farm tokens and fake progress
  // by POSTing made-up lesson IDs.
  const realLesson = await env.DB.prepare("SELECT quiz FROM lessons WHERE id=? AND published=1").bind(lessonId).first();
  if (!realLesson) return json({ error: "Unknown lesson." }, 404);
  // Anti-farming: if the lesson has a quiz, the kid must have actually taken it (their
  // answer went through /api/quiz/answer, which is also rate-limited). Blocks scripted
  // completion-farming; honest kids always hit the quiz on the way through a lesson.
  let lq = {}; try { lq = JSON.parse(realLesson.quiz || "{}"); } catch {}
  if (lq.q && "answer" in lq) {
    const took = await env.DB.prepare("SELECT 1 FROM settings WHERE key=?").bind(`quizok:${u.id}:${lessonId}`).first();
    if (!took) return json({ error: "Finish the lesson quiz first! 🧠" }, 400);
  }
  const settings = await getPlanSettings(env);
  const already = await env.DB.prepare("SELECT 1 FROM progress WHERE user_id=? AND lesson_id=?").bind(u.id, lessonId).first();
  const limit = lessonLimitFor(settings, u);
  // Daily lesson limit: only count against the limit if this is a NEW lesson today.
  if (!already && limit >= 0) {
    const usedToday = await lessonsUsedToday(env, u.id);
    if (usedToday >= limit)
      return json({ error: `You've done ${limit} new lesson${limit === 1 ? '' : 's'} today! Come back tomorrow for more. 🌙`, limitReached: true }, 403);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO progress (user_id,lesson_id,completed_at) VALUES (?,?,?)").bind(u.id, lessonId, nowIso()).run();
  let awarded = 0;
  if (!already) {
    awarded = TOKENS_PER_LESSON;
    await env.DB.prepare("UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id=?").bind(awarded, u.id).run();
    // Track daily lesson usage.
    await env.DB.prepare("INSERT INTO lessons_daily (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1")
      .bind(u.id, todayStr()).run();
  }
  const rows = (await env.DB.prepare("SELECT lesson_id FROM progress WHERE user_id=?").bind(u.id).all()).results || [];
  const tok = (await env.DB.prepare("SELECT tokens FROM users WHERE id=?").bind(u.id).first()).tokens;
  return json({ completed: rows.map((x) => x.lesson_id), unitsPassed: await unitsPassed(env, u.id), tokensAwarded: awarded, tokens: tok, lessonsUsedToday: await lessonsUsedToday(env, u.id) });
}

// Failing a lesson quiz 3 times uses one of today's lesson slots (anti-farming),
// but does NOT mark the lesson complete — the kid still has to pass it.
// Burn one of today's lesson slots for a failed lesson. Deduped per lesson per day (the
// "-fail:" marker row), so the client call and the server's automatic trigger can never
// double-charge the same lesson.
async function burnFailSlot(env, u, lessonId) {
  const already = await env.DB.prepare("SELECT 1 FROM progress WHERE user_id=? AND lesson_id=?").bind(u.id, lessonId).first();
  if (already) return;   // no charge for lessons they've completed
  const key = `${todayStr()}-fail:${lessonId}`;
  const counted = await env.DB.prepare("SELECT 1 FROM lessons_daily WHERE user_id=? AND day=?").bind(u.id, key).first();
  if (!counted) {
    await env.DB.prepare("INSERT OR IGNORE INTO lessons_daily (user_id,day,count) VALUES (?,?,1)").bind(u.id, key).run();
    await env.DB.prepare("INSERT INTO lessons_daily (user_id,day,count) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1")
      .bind(u.id, todayStr()).run();
  }
}

async function apiCountAttempt(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (u.isPreview) return json({ ok: true, lessonsUsedToday: 0 });
  if (!consentOk(u)) return json({ error: "consent required" }, 403);
  const lessonId = (data.lessonId || "").trim();
  await burnFailSlot(env, u, lessonId);
  return json({ ok: true, lessonsUsedToday: await lessonsUsedToday(env, u.id) });
}

// Award tokens for playing the mini-games. Capped per game per day so kids can't farm.
async function apiGameScore(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  // Preview mode: simulate a token award without touching the real DB.
  if (u.isPreview) {
    const xp = Math.max(0, Math.min(50, parseInt(data.xp, 10) || 0));
    return json({ ok: true, tokensAwarded: xp, tokens: 250 + xp, alreadyPlayedToday: false });
  }
  if (!consentOk(u)) return json({ error: "A parent must approve this account first." }, 403);
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
  const game = (data.game || "").trim().slice(0, 30) || "game";
  const xp = Math.max(0, Math.min(50, parseInt(data.xp, 10) || 0)); // cap at 50 tokens
  // Only award once per game per day (anti-farming).
  const key = `game:${game}`;
  const already = await env.DB.prepare("SELECT 1 FROM lessons_daily WHERE user_id=? AND day=?").bind(u.id, `${todayStr()}-${key}`).first();
  let awarded = 0;
  if (!already && xp > 0) {
    awarded = xp;
    await env.DB.prepare("UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id=?").bind(awarded, u.id).run();
    await env.DB.prepare("INSERT OR IGNORE INTO lessons_daily (user_id,day,count) VALUES (?,?,1)").bind(u.id, `${todayStr()}-${key}`).run();
  }
  const tok = (await env.DB.prepare("SELECT tokens FROM users WHERE id=?").bind(u.id).first()).tokens;
  return json({ ok: true, tokensAwarded: awarded, tokens: tok, alreadyPlayedToday: !!already });
}

// Load a unit's boss-battle test: the questions only (answers NEVER leave the server —
// grading happens in apiTestSubmit, which walks the same lessons in the same order).
async function apiTestGet(env, request, unit) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!u.isPreview) {
    if (!consentOk(u)) return json({ error: "A parent must approve this account first.", consentRequired: true }, 403);
    const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403);
  }
  if (isNaN(unit)) return json({ error: "bad unit" }, 400);
  const rows = (await env.DB.prepare("SELECT * FROM lessons WHERE published=1 AND unit=? ORDER BY position, id").bind(unit).all()).results || [];
  const questions = [];
  for (const r of rows) {
    let q = {}; try { q = JSON.parse(r.quiz || "{}"); } catch {}
    if (q.q && "answer" in q) questions.push({ q: q.q, opts: q.options || q.opts || [] });
  }
  if (!questions.length) return json({ error: "No test available for this unit." }, 400);
  const world = WORLDS[unit] || {};
  return json({ questions, boss: world.boss || { name: "The Boss", emoji: "👾" }, passPercent: await getPassPercent(env), unit });
}

async function apiTestSubmit(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  // Preview mode: always return a perfect score without writing to DB.
  if (u.isPreview) {
    const unit = parseInt(data.unit, 10) || 1;
    const allUnits = (await env.DB.prepare("SELECT DISTINCT unit FROM lessons WHERE published=1").all()).results.map(r => r.unit).sort((a,b)=>a-b);
    return json({ score: 100, passed: true, correct: 5, total: 5, best: 100, attempts: 1, firstWin: false, unitsPassed: allUnits });
  }
  if (!consentOk(u)) return json({ error: "A parent must approve this account first.", consentRequired: true }, 403);
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
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
  // 🎉 First-time boss win → email the parent a celebration + progress + upgrade nudge.
  const firstWin = passedNow && !(existing && existing.passed);
  if (firstWin && u.parent_email) {
    try { await sendCertificateEmail(env, request, u, unit, best); } catch (e) {}
  }
  return json({
    score, correct, total, passed: passedNow, passPercent: passPct,
    results: feedback.map((f) => f.ok), feedback, unitsPassed: up, level: up.length + 1, attempts,
    firstWin,
  });
}

// Celebration email to a parent when their kid earns a certificate (beats a boss).
async function sendCertificateEmail(env, request, kid, unit, score) {
  const origin = new URL(request.url).origin;
  const world = WORLDS[unit] || {};
  const worldName = world.name ? `${world.emoji || "🏆"} ${world.name}` : `World ${unit}`;
  const done = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(kid.id).first()).c || 0;
  const worlds = (await env.DB.prepare("SELECT COUNT(*) c FROM unit_tests WHERE user_id=? AND passed=1").bind(kid.id).first()).c || 0;
  const isFree = !["pro", "family"].includes(kid.plan);
  const upgrade = isFree ? `
    <div style="background:#f3e8ff;border:1px solid #d8b4fe;border-radius:10px;padding:14px 16px;margin-top:18px;">
      <div style="font-weight:800;color:#6d28d9;">🚀 Unlock everything for ${kid.name}</div>
      <p style="margin:6px 0 10px;color:#444;font-size:0.92rem;">Upgrade to <strong>Pro</strong> for all 245 lessons, the AI buddy "Byte", boss battles, and certificates.</p>
      <a href="${origin}/checkout.html?plan=pro" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">See Pro →</a>
    </div>` : "";
  await sendEmail(env, kid.parent_email, `🎉 ${kid.name} earned a certificate on KidVibers!`,
    `<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:#222;">
      <div style="background:#7c3aed;color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;font-weight:800;font-size:1.2rem;">🚀 KidVibers</div>
      <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:24px;line-height:1.6;">
        <p style="font-size:1.05rem;"><strong>${kid.name}</strong> just conquered <strong>${worldName}</strong> with a score of <strong>${score}%</strong> and earned a certificate! 🏆</p>
        <div style="display:flex;gap:10px;margin:16px 0;">
          <div style="flex:1;background:#faf5ff;border-radius:10px;padding:12px;text-align:center;"><div style="font-size:1.4rem;font-weight:900;color:#7c3aed;">${done}</div><div style="font-size:0.78rem;color:#666;">lessons done</div></div>
          <div style="flex:1;background:#faf5ff;border-radius:10px;padding:12px;text-align:center;"><div style="font-size:1.4rem;font-weight:900;color:#7c3aed;">${worlds}</div><div style="font-size:0.78rem;color:#666;">worlds cleared</div></div>
        </div>
        <p style="color:#444;">Way to go, ${kid.name}! Keep the streak alive. 💜</p>
        ${upgrade}
        <p style="margin-top:20px;color:#888;font-size:0.85rem;">— The KidVibers Team · <a href="https://kidvibers.com" style="color:#7c3aed;">kidvibers.com</a></p>
      </div></div>`,
    "KidVibers <support@kidvibers.com>");
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

// ── Byte's brain: math solver + definitions + coding help + fun ──
// Kid-safe, runs instantly, no external API needed.
const BYTE_DEFS = {
  variable: "A <strong>variable</strong> is like a labeled box that stores a value 📦. Example: <code>score = 10</code> puts 10 in a box called <code>score</code>.",
  loop: "A <strong>loop</strong> repeats code so you don't have to write it over and over 🔄. Example: <code>for i in range(3): print('hi')</code> prints 'hi' three times.",
  function: "A <strong>function</strong> is a reusable mini-program 🛠️. You make one with <code>def hello():</code> and run it by writing <code>hello()</code>.",
  list: "A <strong>list</strong> holds many things in order 📋. Example: <code>fruits = ['apple', 'banana']</code>. Get the first one with <code>fruits[0]</code>.",
  dictionary: "A <strong>dictionary</strong> stores pairs of keys and values 🗂️. Example: <code>ages = {'Sam': 10}</code>. Look up Sam's age with <code>ages['Sam']</code>.",
  string: "A <strong>string</strong> is text inside quotes 🔤. Example: <code>name = 'Alex'</code>. You can join strings with <code>+</code>.",
  integer: "An <strong>integer</strong> is a whole number 🔢 like 5, 42, or -3 (no decimal point).",
  float: "A <strong>float</strong> is a number with a decimal point 🔢, like 3.14 or 0.5.",
  boolean: "A <strong>boolean</strong> is either <code>True</code> or <code>False</code> ✅❌ — like a light switch that's on or off.",
  print: "<strong>print()</strong> shows text on the screen 🖨️. Example: <code>print('Hello!')</code> displays Hello!",
  input: "<strong>input()</strong> asks the user a question and waits for them to type ⌨️. Example: <code>name = input('Your name? ')</code>.",
  algorithm: "An <strong>algorithm</strong> is a step-by-step set of instructions to solve a problem 🧭 — like a recipe for the computer!",
  bug: "A <strong>bug</strong> is a mistake in your code 🐛. Debugging means finding and fixing it. Every coder gets bugs — even the pros!",
  syntax: "<strong>Syntax</strong> is the grammar rules of code 📝. A tiny mistake like a missing <code>:</code> or <code>)</code> is a syntax error.",
  index: "An <strong>index</strong> is a position number in a list 📍. Lists start at 0, so <code>list[0]</code> is the first item.",
  condition: "A <strong>condition</strong> is a question that's True or False 🤔, like <code>score > 10</code>. It's used with <code>if</code> statements.",
  comment: "A <strong>comment</strong> is a note for humans that the computer ignores 💬. In Python you start it with <code>#</code>.",
  html: "<strong>HTML</strong> is the language that builds web pages 🌐. It uses tags like <code>&lt;h1&gt;</code> for headings.",
  css: "<strong>CSS</strong> makes websites look pretty 🎨 — it sets colors, fonts, and layouts.",
  python: "<strong>Python</strong> 🐍 is a friendly, popular coding language. It's great for beginners and used by pros at Google, Netflix, and NASA!",
  javascript: "<strong>JavaScript</strong> ⚡ makes websites interactive — buttons, games, animations. It runs right in your web browser.",
  recursion: "<strong>Recursion</strong> 🌀 is when a function calls itself to solve a smaller version of a problem. Powerful but tricky!",
};

function byteSolveMath(text) {
  let s = " " + text.toLowerCase() + " ";
  // word operators → symbols
  s = s.replace(/\bplus\b|\band\b|\badd(ed)?( to)?\b/g, "+")
       .replace(/\bminus\b|\bsubtract(ed)?( from)?\b|\btake away\b/g, "-")
       .replace(/\btimes\b|\bmultiplied by\b|\bmultiply\b/g, "*")
       .replace(/\bdivided by\b|\bdivide\b|\bover\b/g, "/")
       .replace(/\bto the power of\b|\bpower\b/g, "^")
       .replace(/\bsquared\b/g, "^2").replace(/\bcubed\b/g, "^3")
       .replace(/\bpercent of\b|% of\b/g, "%of%")
       .replace(/×/g, "*").replace(/÷/g, "/").replace(/\bx\b/g, "*");
  // percent of:  "20 %of% 50"  → 20/100*50
  const pm = s.match(/(-?\d+(?:\.\d+)?)\s*%of%\s*(-?\d+(?:\.\d+)?)/);
  if (pm) { const r = (parseFloat(pm[1]) / 100) * parseFloat(pm[2]); return { q: `${pm[1]}% of ${pm[2]}`, a: +r.toFixed(4) }; }
  // sqrt
  const sq = s.match(/(?:square root of|sqrt)\s*\(?\s*(-?\d+(?:\.\d+)?)/);
  if (sq) { const n = parseFloat(sq[1]); if (n < 0) return null; return { q: `√${n}`, a: +Math.sqrt(n).toFixed(4) }; }
  // keep only math chars
  const cleaned = s.replace(/[^0-9+\-*/^().]/g, "");
  // must contain at least one operator and two numbers-ish
  if (!/[+\-*/^]/.test(cleaned) || !/\d/.test(cleaned)) return null;
  if (!/\d[\s]*[+\-*/^]/.test(cleaned)) return null;
  try {
    let i = 0; const str = cleaned;
    const peek = () => str[i];
    function base() {
      if (peek() === "(") { i++; const v = expr(); if (peek() === ")") i++; return v; }
      if (peek() === "-") { i++; return -base(); }
      if (peek() === "+") { i++; return base(); }
      let start = i; while (i < str.length && /[0-9.]/.test(str[i])) i++;
      if (start === i) throw "bad";
      return parseFloat(str.slice(start, i));
    }
    function factor() { let v = base(); while (peek() === "^") { i++; v = Math.pow(v, factor()); } return v; }
    function term() { let v = factor(); while (peek() === "*" || peek() === "/") { const o = str[i++]; const f = factor(); v = o === "*" ? v * f : v / f; } return v; }
    function expr() { let v = term(); while (peek() === "+" || peek() === "-") { const o = str[i++]; const t = term(); v = o === "+" ? v + t : v - t; } return v; }
    const result = expr();
    if (i !== str.length || !isFinite(result)) return null;
    return { q: cleaned.replace(/\*/g, "×").replace(/\//g, "÷"), a: +result.toFixed(6) };
  } catch { return null; }
}

function byteReply(q) {
  const raw = (q || "").trim();
  q = raw.toLowerCase();
  if (!q) return "Ask me anything! 🤖 I can do math, explain coding words, help with bugs, and more!";

  // 1) Math
  const math = byteSolveMath(raw);
  if (math) return `🧮 <strong>${math.q} = ${math.a}</strong><br>Want me to explain how? Just ask!`;

  // 2) Definitions — "what is X", "define X", "what does X mean"
  const defMatch = q.match(/(?:what(?:'s| is| are)|define|meaning of|what does)\s+(?:an?\s+|the\s+)?([a-z ]+?)(?:\s+mean)?[?.!]*$/);
  if (defMatch) {
    const term = defMatch[1].trim().replace(/\bstatements?\b|\bin (python|code|coding)\b/g, "").trim();
    for (const key in BYTE_DEFS) { if (term === key || term === key + "s" || term.includes(key)) return BYTE_DEFS[key] + "<br>Want an example? Just ask! 😊"; }
  }
  // direct keyword definition (e.g. they just type "loops")
  for (const key in BYTE_DEFS) { if (new RegExp("\\b" + key + "s?\\b").test(q)) {
    if (/error|bug|broken|not work|fix/.test(q) && key !== "bug") continue;
    return BYTE_DEFS[key];
  } }

  // 3) Coding help
  if (/error|bug|broken|not work|won'?t run|fix my/.test(q))
    return "Every coder gets errors! 🐛 Here's how to squash them:<br>1️⃣ Read the <strong>last line</strong> of the error<br>2️⃣ Check for a missing <code>:</code> <code>)</code> or <code>\"</code><br>3️⃣ Make sure your spelling & indenting match<br>Paste the error and I'll help more!";
  if (/how do i|how to|how can i/.test(q))
    return "Great question! 💡 Break it into tiny steps: What do you want to happen first? Then next? Tell me the small steps and we'll code them one at a time. Try the Vibe Studio too — just describe what you want to build! 🎨";

  // 4) Spelling — "how do you spell X"
  const spell = q.match(/(?:how do you |how to )?spell\s+([a-z]+)/);
  if (spell) return `The word <strong>"${spell[1]}"</strong> is spelled: ${spell[1].toUpperCase().split("").join("-")} ✏️`;

  // 5) Fun & social
  if (/\b(hi|hello|hey|yo|sup)\b/.test(q)) return "Hey there, coder! 👋 I can solve math, explain coding words, help fix bugs, and more. What do you want to know?";
  if (/how are you|how'?s it going/.test(q)) return "I'm running great — 100% bug-free today! 🤖✨ How can I help you learn?";
  if (/thank/.test(q)) return "You're so welcome! 🌟 Keep up the awesome work — I'm always here to help!";
  if (/joke|funny|make me laugh/.test(q)) { const j = ["Why do coders prefer dark mode? Because light attracts bugs! 🐛", "Why was the math book sad? It had too many problems! 📖", "What's a computer's favorite snack? Microchips! 🍟", "Why did the function break up with the loop? It needed some space! 😂"]; return j[Math.floor(Math.random() * j.length)]; }
  if (/who (are|made) you|your name/.test(q)) return "I'm <strong>Byte</strong> 🤖 — your coding buddy on KidVibers! I help you learn to code, solve math, and answer questions. Made by a kid, for kids! 💜";
  if (/bored|what should i do|what can i do/.test(q)) return "Let's have fun! 🎉 Try:<br>📚 A new lesson<br>🎮 A coding game<br>🎨 Build something in the Vibe Studio<br>Or ask me a math or coding question!";

  // 6) Fallback
  return "Ooh, good question! 🤖 I can help with:<br>🧮 <strong>Math</strong> — try \"15 × 7\" or \"20% of 50\"<br>📖 <strong>Definitions</strong> — try \"what is a loop?\"<br>🐛 <strong>Bug help</strong> — paste your error<br>🎨 <strong>Building</strong> — head to the Vibe Studio!";
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
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
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
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
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
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
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
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
  const origin = new URL(request.url).origin;
  const body = `Your kid wants to upgrade. If you would like to upgrade their account, go to ${origin}/index.html#pricing. If this is a mistake, please ignore this message. Thank you and have a great day.`;
  if (u.parent_email)
    await env.DB.prepare("INSERT INTO messages (to_email,kind,body,child_id,created_at) VALUES (?,?,?,?,?)")
      .bind(u.parent_email, "upgrade_request", body, u.id, nowIso()).run();
  return json({ ok: true, parentEmail: u.parent_email, message: body });
}

// Kid-facing safety button: "Something's wrong?" — lets a kid flag a problem (bug, someone
// being mean, something they saw, or anything else) without needing a parent nearby.
// Notifies the parent/guardian by email AND the KidVibers team, same-session, no waiting.
const HELP_REASONS = {
  bug: "Something isn't working right",
  mean: "Someone was mean to me",
  scary: "I saw something that scared or confused me",
  other: "Something else",
};
async function apiKidHelp(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Kids only." }, 403);
  if (rateLimited(`kidhelp:${u.id}`, 3, 3600)) return json({ error: "You've already sent a few — a grown-up has been told. Try again later if it's still happening." }, 429);
  const reasonKey = (data.reason || "other").trim();
  const reasonText = HELP_REASONS[reasonKey] || HELP_REASONS.other;
  const note = (data.message || "").toString().slice(0, 500).trim();
  if (u.parent_email) {
    await sendEmail(env, u.parent_email, `🆘 ${u.name} used the "Something's wrong?" button on KidVibers`,
      `<p><strong>${u.name}</strong> just used the help button on KidVibers.</p>
       <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 16px;"><strong>Reason:</strong> ${reasonText}${note ? `<br><strong>Message:</strong> ${escHtml(note)}` : ""}</p>
       <p>It's a good idea to check in with them. No action was taken automatically — this is just to let you know right away.</p>`);
  }
  await notifyAdmin(env, `🆘 Kid help button: ${u.name} (@${u.username})`,
    `🆘 *Kid used the "Something's wrong?" button*\n• Kid: ${u.name} (@${u.username})\n• Reason: ${reasonText}${note ? `\n• Message: ${note}` : ""}\n• Parent notified: ${u.parent_email ? "yes" : "no parent email on file"}`);
  // Alert the teacher/school too — in a classroom they're the first responder. Escalate hard
  // if the note trips the welfare watchlist (self-harm / abuse / serious bullying).
  const welfare = welfareFlag(note) || reasonKey === "scary" || reasonKey === "mean";
  await alertSchool(env, u, welfare ? "used the safety button — may need urgent attention" : "used the \"Something's wrong?\" button", `${reasonText}${note ? " — \"" + note.slice(0, 120) + "\"" : ""}`);
  return json({ ok: true, parentNotified: !!u.parent_email });
}

// Parent/teacher "nudge" — sends an encouragement push notification to a kid right now.
async function apiParentNudge(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role)) return json({ error: "forbidden" }, 403);
  const kidId = data.kidId | 0;
  const kid = await env.DB.prepare("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?").bind(kidId, u.family_id).first();
  if (!kid) return json({ error: "Not your student/kid." }, 403);
  if (rateLimited(`nudge:${u.id}:${kidId}`, 5, 3600)) return json({ error: "Too many nudges sent — give it a little while." }, 429);
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return json({ error: "Push notifications aren't set up yet.", noPush: true }, 400);
  const subs = (await env.DB.prepare("SELECT endpoint,p256dh,auth,user_id FROM push_subs WHERE user_id=?").bind(kidId).all()).results || [];
  if (!subs.length) return json({ error: `${kid.name} hasn't turned on notifications, so we can't nudge them right now.`, noPush: true }, 400);
  let sent = 0;
  for (const s of subs) {
    try {
      const res = await sendWebPush(env, s);
      if (res === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(s.endpoint).run();
      else if (res === true) sent++;
    } catch {}
  }
  return json({ ok: sent > 0, sent });
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

// ───────────────────────── private projects (Vibe Studio) ─────────────────────────
// Projects are private to the child's own account. There is no public gallery,
// sharing, likes, or comments feature — kids only save their own work.
const PROJECT_MAX = 50, CODE_MAX = 20000, TITLE_MAX = 60;
// simple in-memory rate limiter (best-effort per isolate)
const rlMap = new Map();
function rateLimited(key, max, windowSec) {
  const now = Date.now(); let e = rlMap.get(key);
  if (!e || now - e.first > windowSec * 1000) { e = { count: 0, first: now }; }
  e.count++; rlMap.set(key, e);
  return e.count > max;
}
function firstName(u) { return cleanName((u.name || u.username || "").split(" ")[0]) || "A coder"; }

async function apiProjectSave(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  if (!consentOk(u)) return json({ error: "A parent needs to approve this account first." }, 403);
  { const _sb = await scheduleBlocks(env, u); if (_sb) return json({ error: _sb, scheduleLocked: true }, 403); }
  // Welfare check first (a cry for help must be caught even if the text is also "blocked").
  if (welfareFlag(data.title)) await alertSchool(env, u, "typed something concerning in Vibe Studio", (data.title || "").toString().slice(0, 120));
  { const _ci = contentIssue(data.title); if (_ci) {
      // Repeated attempts at bad content get flagged to the teacher (a pattern worth noticing).
      const fk = `badtries:${u.id}:${todayStr()}`;
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(fk).first();
      const n = (parseInt(row && row.value, 10) || 0) + 1;
      await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(fk, String(n)).run();
      if (n === 4) await alertSchool(env, u, "repeatedly tried to post inappropriate content today", "content was blocked each time");
      return json({ error: _ci }, 400);
  } }
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

// List the logged-in user's own private projects (Vibe Studio "My projects").
async function apiProjectsMine(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const rows = (await env.DB.prepare("SELECT id,title,code,updated_at FROM projects WHERE user_id=? ORDER BY updated_at DESC").bind(u.id).all()).results || [];
  return json({ projects: rows.map((r) => ({ id: r.id, title: r.title, code: r.code, updatedAt: (r.updated_at || "").slice(0, 16).replace("T", " ") })) });
}

// Delete one of your OWN projects (needed so kids aren't stuck at the project cap).
async function apiProjectDeleteOwn(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const row = await env.DB.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").bind(data.id, u.id).first();
  if (!row) return json({ error: "Project not found" }, 404);
  await env.DB.prepare("DELETE FROM projects WHERE id=?").bind(data.id).run();
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
// The default signup placement quiz. Super admin can edit it; it's stored in settings.
// The first 6 questions map (by position) to the recommendation logic:
//   [age, experience, interest, practice, ai-helper, who] — keep that order for smart recommendations.
const DEFAULT_QUIZ = [
  { q: "🎂 How old are you?", opts: ["6 to 8", "9 to 11", "12 to 14", "15 or older"] },
  { q: "💡 Have you coded before?", opts: ["Never tried it", "A little (Scratch/blocks)", "Some Python or similar", "Yes, I build things"] },
  { q: "🚀 What do you most want to make?", opts: ["🎮 Games", "🌐 Websites", "🎨 Art & stories", "🤖 Smart AI stuff"] },
  { q: "⏰ How much will you practice?", opts: ["Here and there", "About 15 min most days", "I want to go deep daily"] },
  { q: "🤝 Want an AI buddy to explain things & give hints?", opts: ["Yes please!", "Maybe later", "I like figuring it out myself"] },
  { q: "👨‍👩‍👧 Is it just you, or will siblings learn too?", opts: ["Just me", "Me + my brothers/sisters"] },
];

async function getQuiz(env) {
  const saved = await getSetting(env, "signup_quiz", null);
  if (Array.isArray(saved) && saved.length) return saved;
  return DEFAULT_QUIZ;
}

// All collected emails in one place (super admin), grouped by parents vs kids.
async function adminEmails(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare(
    "SELECT id,name,username,role,parent_email,kid_email FROM users ORDER BY id DESC"
  ).all()).results || [];
  const parents = [], kids = [];
  const seenP = new Set(), seenK = new Set();
  for (const r of rows) {
    if (r.role === "kid") {
      if (r.kid_email && !seenK.has(r.kid_email.toLowerCase())) { seenK.add(r.kid_email.toLowerCase()); kids.push({ email: r.kid_email, name: r.name, username: r.username }); }
      if (r.parent_email && !seenP.has(r.parent_email.toLowerCase())) { seenP.add(r.parent_email.toLowerCase()); parents.push({ email: r.parent_email, name: r.name + " (parent)", username: r.username }); }
    } else {
      // parent/teacher/admin accounts: their own email lives in parent_email
      if (r.parent_email && !seenP.has(r.parent_email.toLowerCase())) { seenP.add(r.parent_email.toLowerCase()); parents.push({ email: r.parent_email, name: r.name, username: r.username }); }
    }
  }
  return json({ parents, kids, parentCount: parents.length, kidCount: kids.length });
}

// Send a mass email to all parents, all kids, or everyone (super admin only).
async function adminMassEmail(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const subject = (data.subject || "").trim().slice(0, 200);
  const body = (data.body || "").trim().slice(0, 5000);
  const audience = (data.audience || "").trim(); // 'parents' | 'kids' | 'everyone'
  if (!subject || !body) return json({ error: "Subject and message are required." }, 400);
  if (!["parents", "kids", "everyone"].includes(audience)) return json({ error: "Pick who to send to." }, 400);

  // Gather unique recipient emails for the chosen audience.
  const rows = (await env.DB.prepare("SELECT role,parent_email,kid_email FROM users").all()).results || [];
  const set = new Set();
  for (const r of rows) {
    if ((audience === "parents" || audience === "everyone") && r.parent_email) set.add(r.parent_email.trim().toLowerCase());
    if ((audience === "kids" || audience === "everyone") && r.role === "kid" && r.kid_email) set.add(r.kid_email.trim().toLowerCase());
  }
  const recipients = [...set].filter(e => /^\S+@\S+\.\S+$/.test(e));
  if (!recipients.length) return json({ error: "No email addresses found for that group yet." }, 400);

  // Wrap the message in a simple branded template.
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
    <div style="background:#7c3aed;color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;font-weight:800;font-size:1.2rem;">🚀 KidVibers</div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:24px;color:#222;line-height:1.6;">
      ${body.replace(/\n/g, "<br>")}
      <p style="margin-top:24px;color:#888;font-size:0.85rem;">— The KidVibers Team · <a href="https://kidvibers.com" style="color:#7c3aed;">kidvibers.com</a></p>
    </div></div>`;

  let sent = 0, failed = 0;
  for (const to of recipients) {
    const ok = await sendEmail(env, to, subject, html, "KidVibers <support@kidvibers.com>");
    if (ok) sent++; else failed++;
  }
  await sendSlack(env, `📣 *Mass email sent*\n• To: ${audience} (${recipients.length})\n• Subject: ${subject}\n• Sent: ${sent}, Failed: ${failed}`);
  return json({ ok: true, sent, failed, total: recipients.length });
}

async function apiQuizConfig(env) {
  return json({ quiz: await getQuiz(env) });
}

// ── Referrals: each kid has a code; new kids who use it earn both kids tokens ──
async function ensureReferralCode(env, user) {
  if (user.referral_code) return user.referral_code;
  // Short, friendly, unique-ish code.
  let code;
  for (let i = 0; i < 10; i++) {
    code = "KV" + Math.random().toString(36).slice(2, 7).toUpperCase();
    const taken = await env.DB.prepare("SELECT 1 FROM users WHERE referral_code=?").bind(code).first();
    if (!taken) break;
  }
  await env.DB.prepare("UPDATE users SET referral_code=? WHERE id=?").bind(code, user.id).run();
  return code;
}

async function apiReferral(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Kids only." }, 403);
  const code = await ensureReferralCode(env, u);
  const count = (await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE referred_by=?").bind(u.id).first()).c || 0;
  const origin = new URL(request.url).origin;
  return json({ code, count, bonus: REFERRAL_BONUS, freeDays: REFERRAL_FREE_DAYS, link: `${origin}/index.html?ref=${code}` });
}

// Apply a referral after a new kid signs up (called from apiSignup).
// Both kids get REFERRAL_BONUS tokens AND 7 days of free Pro (AI + unlimited lessons) —
// stacks on top of any free days they already have, so referring more friends = more free days.
async function applyReferral(env, newKidId, refCode) {
  if (!refCode) return;
  const referrer = await env.DB.prepare("SELECT id, referral_count FROM users WHERE referral_code=? AND role='kid'").bind(refCode.trim().toUpperCase()).first();
  if (!referrer || referrer.id === newKidId) return;
  await env.DB.prepare("UPDATE users SET referred_by=? WHERE id=?").bind(referrer.id, newKidId).run();
  // The NEW kid always gets their welcome reward. The REFERRER earns rewards for at most
  // REFERRAL_MAX_REWARDED sign-ups — after that, invites still count but don't pay out
  // (stops farming free Pro by mass-creating fake accounts).
  const referrerRewarded = (referrer.referral_count || 0) < REFERRAL_MAX_REWARDED;
  const rewardIds = referrerRewarded ? [referrer.id, newKidId] : [newKidId];
  const ph = rewardIds.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id IN (${ph})`).bind(REFERRAL_BONUS, ...rewardIds).run();
  for (const id of rewardIds) {
    const row = await env.DB.prepare("SELECT promo_pro_until FROM users WHERE id=?").bind(id).first();
    const base = (row && row.promo_pro_until && new Date(row.promo_pro_until) > new Date()) ? new Date(row.promo_pro_until) : new Date();
    const until = new Date(base.getTime() + REFERRAL_FREE_DAYS * 86400000).toISOString();
    await env.DB.prepare("UPDATE users SET promo_pro_until=? WHERE id=?").bind(until, id).run();
  }
  await env.DB.prepare("UPDATE users SET referral_count = COALESCE(referral_count,0) + 1 WHERE id=?").bind(referrer.id).run();
}

async function adminGetQuiz(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  return json({ quiz: await getQuiz(env), isDefault: !(await getSetting(env, "signup_quiz", null)) });
}

async function adminSetQuiz(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  if (data.reset) { await setSetting(env, "signup_quiz", null); return json({ ok: true, quiz: DEFAULT_QUIZ, isDefault: true }); }
  const quiz = Array.isArray(data.quiz) ? data.quiz : null;
  if (!quiz || !quiz.length) return json({ error: "The quiz needs at least one question." }, 400);
  // Sanitize: each question must have text and at least 2 options.
  const clean = [];
  for (const item of quiz) {
    const q = (item.q || "").toString().trim().slice(0, 200);
    const opts = (Array.isArray(item.opts) ? item.opts : []).map(o => (o || "").toString().trim().slice(0, 100)).filter(Boolean);
    if (!q || opts.length < 2) return json({ error: "Every question needs text and at least 2 answer choices." }, 400);
    clean.push({ q, opts });
  }
  if (clean.length > 12) return json({ error: "Max 12 questions." }, 400);
  await setSetting(env, "signup_quiz", clean);
  return json({ ok: true, quiz: clean, isDefault: false });
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
  const r = await createUser(env, { role: "parent", name, username, password, email, age: "", plan: "free", trial_ends: null });
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
  await notifyAdmin(env, `👨‍👩‍👧 New parent: ${name}`, `👨‍👩‍👧 *New parent signed up!*\n• Name: ${name}\n• Username: @${username}\n• Email: ${email || "none"}${linked ? `\n• Linked to kid: ${linked}` : ""}`);
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
  await notifyAdmin(env, `🏫 New teacher/library: ${name}`, `🏫 *New teacher/library signed up!*\n• Name: ${name}\n• Username: @${username}\n• School/Org: ${school}\n• Email: ${email || "none"}`);
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
  // Parents: 1 kid free. More kids require the paid Family plan (up to 4).
  const paidFamily = u.role === "parent" && u.plan === "family" && !!u.stripe_subscription_id;
  if (isTeacher) {
    const cfg = teacherPlanCfg(u.plan), limit = cfg.students;
    if (limit !== -1 && (await studentsInFamily(env, u.family_id)) >= limit) {
      const msg = limit === 0 ? "Choose a Teacher, School or District plan to add students." : `Your ${cfg.label} allows ${limit} students. Upgrade for more.`;
      return json({ error: msg, limitReached: true }, 403);
    }
  } else {
    const kidsSoFar = await studentsInFamily(env, u.family_id);
    if (!paidFamily && kidsSoFar >= 1) {
      return json({ error: "You can add 1 kid for free. Upgrade to the Family plan to add up to 4 kids and unlock AI for everyone!", limitReached: true, upgradeRequired: true }, 403);
    }
    if (paidFamily && kidsSoFar >= 4) {
      return json({ error: "The Family plan supports up to 4 kids.", limitReached: true }, 403);
    }
  }
  const method = isTeacher ? "school" : "parent_account";
  const grantedBy = isTeacher ? `${u.school} (teacher: ${u.username})` : (u.parent_email || u.username);

  // District accounts can assign a student directly to a specific school.
  let assignFamilyId = u.family_id;
  if (isTeacher && DISTRICT_PLANS.includes(u.plan) && data.schoolId) {
    const school = await env.DB.prepare("SELECT id,family_id FROM users WHERE id=? AND district_id=? AND role='teacher'").bind(data.schoolId, u.id).first();
    if (school) assignFamilyId = school.family_id || school.id;
  }

  // Teachers' students & paid-family kids get "family" (AI on); a parent's free kid gets "free".
  const kidPlan = isTeacher || paidFamily ? "family" : "free";
  const r = await createUser(env, {
    role: "kid", name, username, password, email: u.parent_email || "", age, plan: kidPlan, trial_ends: null,
    family_id: assignFamilyId, consent_status: "granted", consent_method: method, consent_by: grantedBy,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  await logConsent(env, r.uid, username, method, grantedBy, isTeacher ? "School/classroom consent" : "Parent created the account");
  return json({ token: null, user: await publicUser(env, r.row) });
}

// Bulk roster upload: TEACHERS/SCHOOLS only (parents can't bulk-add kids past their plan limit).
async function apiUploadRoster(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher or school can upload a roster." }, 403);
  const students = Array.isArray(data.students) ? data.students : [];
  if (!students.length) return json({ error: "No students provided." }, 400);
  if (students.length > 200) return json({ error: "Max 200 students per upload." }, 400);
  // Respect the teacher/school student limit for the plan.
  const cfg = teacherPlanCfg(u.plan), limit = cfg.students;
  if (limit !== -1) {
    const current = await studentsInFamily(env, u.family_id);
    if (current + students.length > limit) {
      return json({ error: `Your plan allows ${limit} students (${current} used). This upload of ${students.length} would exceed it.`, limitReached: true }, 403);
    }
  }

  const isTeacher = u.role === "teacher";
  const method = isTeacher ? "school" : "parent_account";
  const grantedBy = isTeacher ? `${u.school || "school"} (teacher: ${u.username})` : u.username;

  const created = [];
  const errors = [];

  for (const s of students) {
    let name = cleanName(s.name || "").slice(0, 60);
    if (!name) { errors.push("Skipped a row with no name."); continue; }

    // Auto-generate username if missing: first name + random 4 digits
    let username = (s.username || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!username || username.length < 3) {
      const base = name.split(" ")[0].toLowerCase().replace(/[^a-z]/g, "").slice(0, 10) || "student";
      username = base + Math.floor(1000 + Math.random() * 9000);
    }
    // Check duplicate — append digits until unique
    let finalUser = username;
    for (let attempt = 0; attempt < 10; attempt++) {
      const dup = await env.DB.prepare("SELECT 1 FROM users WHERE username=?").bind(finalUser).first();
      if (!dup) break;
      finalUser = username + Math.floor(100 + Math.random() * 900);
    }

    // Auto-generate password if missing
    const pw = (s.password || "").trim() || Math.random().toString(36).slice(2, 10);
    if (pw.length < 6) { errors.push(`Password too short for ${name}.`); continue; }

    const r = await createUser(env, {
      role: "kid", name, username: finalUser, password: pw,
      email: u.parent_email || "", age: s.ageBand || "", plan: "family", trial_ends: null,
      family_id: u.family_id, consent_status: "granted", consent_method: method, consent_by: grantedBy,
    });
    if (r.error) { errors.push(`${name}: ${r.error}`); continue; }
    await logConsent(env, r.uid, finalUser, method, grantedBy, "Roster upload");
    created.push({ name, username: finalUser, password: pw });
  }
  return json({ ok: true, created, errors, total: students.length });
}

// All students across all schools in the district (for the roster view).
// ── Teacher assignments ──────────────────────────────────────────────────
async function apiCreateAssignment(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only teachers can assign lessons." }, 403);
  const title = cleanName(data.title || "").slice(0, 100) || "Assignment";
  const unit = data.unit ? parseInt(data.unit, 10) : null;
  const lessonIds = Array.isArray(data.lessonIds) ? JSON.stringify(data.lessonIds.slice(0, 50)) : null;
  const dueDate = (data.dueDate || "").slice(0, 20) || null;
  await env.DB.prepare("INSERT INTO assignments (family_id,teacher_id,title,unit,lesson_ids,due_date,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(u.family_id, u.id, title, unit, lessonIds, dueDate, nowIso()).run();
  return json({ ok: true });
}
async function apiListAssignments(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  // Kids see assignments for their family; teachers see ones they created
  const rows = u.role === "teacher"
    ? (await env.DB.prepare("SELECT * FROM assignments WHERE teacher_id=? ORDER BY created_at DESC LIMIT 50").bind(u.id).all()).results
    : (await env.DB.prepare("SELECT * FROM assignments WHERE family_id=? ORDER BY created_at DESC LIMIT 20").bind(u.family_id).all()).results;
  return json({ assignments: (rows || []).map(a => ({
    id: a.id, title: a.title, unit: a.unit,
    lessonIds: a.lesson_ids ? JSON.parse(a.lesson_ids) : [],
    dueDate: a.due_date, createdAt: a.created_at,
  })) });
}
async function apiDeleteAssignment(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "forbidden" }, 403);
  await env.DB.prepare("DELETE FROM assignments WHERE id=? AND teacher_id=?").bind(data.id, u.id).run();
  return json({ ok: true });
}

// Assignment completion tracking: for each of a teacher's assignments, how many of their
// students have completed it. "Complete" = passed the unit's boss (if the assignment targets
// a unit) or did at least one of the listed lessons; otherwise counts kids who cleared the unit.
async function apiAssignmentProgress(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "forbidden" }, 403);
  const fams = await managedFamilyIds(env, u);
  const ph = fams.map(() => "?").join(",");
  const kids = (await env.DB.prepare(`SELECT id,name,username FROM users WHERE role='kid' AND family_id IN (${ph})`).bind(...fams).all()).results || [];
  const assigns = (await env.DB.prepare("SELECT * FROM assignments WHERE teacher_id=? ORDER BY created_at DESC LIMIT 50").bind(u.id).all()).results || [];
  const out = [];
  for (const a of assigns) {
    const lessonIds = a.lesson_ids ? (() => { try { return JSON.parse(a.lesson_ids); } catch { return []; } })() : [];
    const done = [];
    for (const k of kids) {
      let complete = false;
      if (a.unit) {
        const passed = await env.DB.prepare("SELECT 1 FROM unit_tests WHERE user_id=? AND unit=? AND passed=1").bind(k.id, a.unit).first();
        complete = !!passed;
      } else if (lessonIds.length) {
        const lp = lessonIds.map(() => "?").join(",");
        const c = (await env.DB.prepare(`SELECT COUNT(*) c FROM progress WHERE user_id=? AND lesson_id IN (${lp})`).bind(k.id, ...lessonIds).first()).c || 0;
        complete = c >= lessonIds.length;
      }
      if (complete) done.push(k.name);
    }
    out.push({ id: a.id, title: a.title, unit: a.unit, dueDate: a.due_date, total: kids.length, doneCount: done.length, done });
  }
  return json({ assignments: out, totalStudents: kids.length });
}

// Class announcement: a teacher/school/district posts one message that lands as a notice on
// EVERY one of their students' dashboards at once.
async function apiTeacherAnnounce(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher/school/district can post announcements." }, 403);
  const msg = (data.message || "").toString().trim().slice(0, 500);
  if (!msg) return json({ error: "Write a message first." }, 400);
  if (rateLimited(`announce:${u.id}`, 10, 3600)) return json({ error: "You've posted a lot of announcements — take a short break." }, 429);
  const fams = await managedFamilyIds(env, u);
  const ph = fams.map(() => "?").join(",");
  const kids = (await env.DB.prepare(`SELECT id FROM users WHERE role='kid' AND family_id IN (${ph})`).bind(...fams).all()).results || [];
  const now = nowIso();
  const from = u.brand_name || u.school || "your teacher";
  for (const k of kids) {
    await env.DB.prepare("INSERT INTO notices (user_id,kind,body,created_at) VALUES (?,?,?,?)")
      .bind(k.id, "announcement", `📣 From ${from}: ${msg}`, now).run();
  }
  return json({ ok: true, sent: kids.length });
}

// A teacher/school flags a concern about one of their students to the KidVibers safety team,
// creating a record. Documents the concern (behavior / safety worry) with a reason + notes.
async function apiTeacherConcern(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher/school/district can do this." }, 403);
  const kid = await managedKid(env, u, data.kidId | 0);
  if (!kid) return json({ error: "That student isn't in your school." }, 403);
  const reason = cleanName(data.reason || "").slice(0, 100) || "Concern";
  const notes = (data.notes || "").toString().trim().slice(0, 800);
  if (rateLimited(`concern:${u.id}`, 20, 3600)) return json({ error: "Too many reports at once — take a short break." }, 429);
  const org = u.brand_name || u.school || u.username;
  // Keep a record for the KidVibers team and log it against the student's consent/history trail.
  await notifyAdmin(env, `🏫 Teacher concern: ${kid.name}`,
    `🏫 *A teacher reported a concern about a student*\n• School: ${org}\n• Student: ${kid.name} (@${kid.username})\n• Reason: ${reason}${notes ? `\n• Notes: ${notes}` : ""}`);
  await logConsent(env, kid.id, kid.username, "concern_reported", `teacher (${u.username})`, `${reason}${notes ? ": " + notes : ""}`);
  return json({ ok: true });
}

// ── Session logout PIN (shared-device / library sessions) ──────────────────
// Kids normally can't sign themselves out (a guardian controls that). But on a shared
// library/lab computer, the librarian wants kids to be able to end their own session so the
// next kid can log in — WITHOUT letting a kid freely log out or mess with others. So a
// teacher/school/district sets a "session logout PIN"; a kid must enter it to sign out.
async function apiSetLogoutPin(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher/school/district can set this." }, 403);
  const pin = (data.pin || "").toString().trim();
  if (pin && !/^[A-Za-z0-9]{3,12}$/.test(pin)) return json({ error: "PIN must be 3-12 letters or numbers." }, 400);
  const key = `logoutpin:${u.family_id}`;
  if (!pin) { await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run(); return json({ ok: true, pinSet: false }); }
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, pin).run();
  return json({ ok: true, pinSet: true });
}
// Data-retention setting: a school can auto-delete students who've been inactive for N months
// (0 = keep forever, the default). Kept conservative — only touches genuinely inactive accounts.
async function apiSetRetention(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a school/district can set this." }, 403);
  const months = Math.max(0, Math.min(60, parseInt(data.months, 10) || 0));
  const key = `retention:${u.family_id}`;
  if (!months) { await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run(); return json({ ok: true, months: 0 }); }
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, String(months)).run();
  return json({ ok: true, months });
}
async function getLogoutPin(env, familyId) {
  if (familyId == null) return null;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`logoutpin:${familyId}`).first();
  return row && row.value ? row.value : null;
}
// A kid signs themselves out by entering the library/class logout PIN.
async function apiKidSessionLogout(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Kids only." }, 403);
  const pin = await getLogoutPin(env, u.family_id);
  if (!pin) return json({ error: "Your teacher hasn't turned on session logout.", noPin: true }, 403);
  if (rateLimited(`kidlogout:${u.id}`, 8, 600)) return json({ error: "Too many tries — ask a grown-up for help." }, 429);
  if ((data.pin || "").toString().trim() !== pin) return json({ error: "That's not the right session PIN. Ask your teacher/librarian." }, 403);
  await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(bearer(request)).run();
  return json({ ok: true });
}

// ── Live drop-in sessions (library / classroom kiosk) ──────────────────────
// A teacher/school/district clicks "Start a session" to get a short code. Kids go to the
// homepage, tap "Join a session", enter the code, and pick a display name — they get a
// TEMPORARY guest account (no password, joins the teacher's group, school-consented) so they
// can code right away with no sign-up. Guest accounts are auto-cleaned by the daily cron.
const SESSION_HOURS = 8;              // a session code stays joinable for this long
function sessionCode() { let c = ""; const b = new Uint8Array(6); crypto.getRandomValues(b); for (let i = 0; i < 6; i++) c += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; return c; }
// Lifetime counters kept in the settings table (key `stat:<name>`), for the admin panel.
async function bumpStat(env, name) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`stat:${name}`).first();
    const n = (parseInt(row && row.value, 10) || 0) + 1;
    await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(`stat:${name}`, String(n)).run();
  } catch {}
}
async function getStat(env, name) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`stat:${name}`).first();
  return parseInt(row && row.value, 10) || 0;
}

async function apiStartSession(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher, school, or district can start a session." }, 403);
  const regen = data && data.regen;
  const prev = await getSetting(env, `activesession:${u.id}`, null);
  if (regen && prev && prev.code) {
    // Change the code: retire the old one so it stops working, then make a fresh one below.
    await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(`session:${prev.code}`).run();
  } else if (prev && prev.code) {
    // Reuse the teacher's still-valid session (so refreshing shows the same code).
    const s = await getSetting(env, `session:${prev.code}`, null);
    if (s && s.expires > Date.now()) return json({ ok: true, code: prev.code, expiresAt: new Date(s.expires).toISOString(), reused: true });
  }
  let code; for (let i = 0; i < 40; i++) { code = sessionCode(); if (!(await getSetting(env, `session:${code}`, null))) break; }
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  await setSetting(env, `session:${code}`, { teacherId: u.id, familyId: u.family_id, name: u.brand_name || u.school || "Coding Session", expires });
  await setSetting(env, `activesession:${u.id}`, { code });
  await bumpStat(env, "sessions_started");   // lifetime counter for the admin panel
  return json({ ok: true, code, expiresAt: new Date(expires).toISOString() });
}

async function apiEndSession(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "forbidden" }, 403);
  const prev = await getSetting(env, `activesession:${u.id}`, null);
  if (prev && prev.code) await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(`session:${prev.code}`).run();
  await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(`activesession:${u.id}`).run();
  return json({ ok: true });
}

// Lock / unlock a session: locked = the code still works for kids already in, but no NEW joins
// (stops a stranger who got the code from wandering in mid-program).
async function apiLockSession(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "forbidden" }, 403);
  const prev = await getSetting(env, `activesession:${u.id}`, null);
  if (!prev || !prev.code) return json({ error: "No active session." }, 400);
  const s = await getSetting(env, `session:${prev.code}`, null);
  if (!s) return json({ error: "No active session." }, 400);
  s.locked = !!data.locked;
  await setSetting(env, `session:${prev.code}`, s);
  return json({ ok: true, locked: s.locked });
}

async function apiJoinSession(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(`joinsession:${ip}`, 20, 3600)) return json({ error: "Too many tries — please wait a bit." }, 429);
  const code = (data.code || "").toString().trim().toUpperCase();
  const chosen = (data.name || data.username || "").toString().trim();
  const info = await getSetting(env, `session:${code}`, null);
  if (!info || info.expires < Date.now()) return json({ error: "That session code isn't active. Ask your teacher or librarian for the current code." }, 404);
  if (info.locked) return json({ error: "This session is locked — no new joins right now. Ask your teacher." }, 403);
  if (!/^[A-Za-z0-9 _.-]{2,20}$/.test(chosen)) return json({ error: "Pick a name using 2-20 letters or numbers." }, 400);
  { const ci = contentIssue(chosen); if (ci) return json({ error: ci }, 400); }
  // Respect the group's seat cap so a session can't blow past the plan limit.
  const owner = await env.DB.prepare("SELECT plan FROM users WHERE id=?").bind(info.teacherId).first();
  if (owner) { const cfg = teacherPlanCfg(owner.plan); if (cfg.students !== -1 && (await studentsInFamily(env, info.familyId)) >= cfg.students) return json({ error: "This session is full — ask your teacher." }, 403); }
  // Build a unique username (guests never log in again, so it just needs to be unique).
  let base = chosen.replace(/[^A-Za-z0-9_]/g, "") || "coder"; if (base.length < 3) base = base + "coder";
  let uname = base.slice(0, 16);
  for (let i = 0; i < 8; i++) { if (!(await env.DB.prepare("SELECT 1 FROM users WHERE username=?").bind(uname).first())) break; uname = (base.slice(0, 12) + randToken(3).replace(/[^A-Za-z0-9]/g, "")).slice(0, 20); }
  const r = await createUser(env, {
    role: "kid", name: chosen.slice(0, 20), username: uname, password: randToken(12),
    email: "", age: "", plan: "family", trial_ends: null, family_id: info.familyId,
    consent_status: "granted", consent_method: "library_session", consent_by: `Session by ${info.name}`,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  // Mark as a session guest for auto-cleanup.
  await setSetting(env, `sessionguest:${r.uid}`, { code, expires: info.expires });
  await bumpStat(env, "session_joins");   // lifetime counter for the admin panel
  const token = await createSession(env, r.uid);
  return json({ ok: true, token, user: await publicUser(env, r.row), displayName: chosen });
}

// Daily login reward: a small token bonus, once per calendar day, just for showing up.
const DAILY_REWARD = 15;
async function apiDailyReward(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Kids only." }, 403);
  if (u.isPreview) return json({ claimed: false, alreadyToday: false, reward: DAILY_REWARD, tokens: 250 });
  const key = `daily:${u.id}:${todayStr()}`;
  const existing = await env.DB.prepare("SELECT 1 FROM settings WHERE key=?").bind(key).first();
  if (existing) {
    const tok = (await env.DB.prepare("SELECT tokens FROM users WHERE id=?").bind(u.id).first()).tokens ?? 0;
    return json({ claimed: false, alreadyToday: true, reward: DAILY_REWARD, tokens: tok });
  }
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)").bind(key, nowIso()).run();
  await env.DB.prepare("UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id=?").bind(DAILY_REWARD, u.id).run();
  const tok = (await env.DB.prepare("SELECT tokens FROM users WHERE id=?").bind(u.id).first()).tokens ?? 0;
  return json({ claimed: true, alreadyToday: false, reward: DAILY_REWARD, tokens: tok });
}

// Class leaderboard for a KID: ranks only the kids in their own class/family this week —
// friendlier and safer than a global board. First names only.
async function apiMyLeaderboard(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ leaderboard: [] });
  if (u.family_id == null) return json({ leaderboard: [] });
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = (await env.DB.prepare(
    "SELECT u.id, u.name, COALESCE(SUM(l.xp),0) AS week_xp, COUNT(p.lesson_id) AS week_lessons " +
    "FROM users u LEFT JOIN progress p ON p.user_id=u.id AND p.completed_at>=? " +
    "LEFT JOIN lessons l ON l.id=p.lesson_id " +
    "WHERE u.role='kid' AND u.family_id=? GROUP BY u.id ORDER BY week_xp DESC, week_lessons DESC LIMIT 20"
  ).bind(since, u.family_id).all()).results || [];
  return json({ leaderboard: rows.map((r, i) => ({ rank: i + 1, name: (r.name || "").split(" ")[0], xp: r.week_xp || 0, lessons: r.week_lessons || 0, me: r.id === u.id })), me: u.id });
}

// "Recommend KidVibers to my library/school" — a warm B2B lead. Emails the KidVibers team.
async function apiRecommend(env, request, data) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(`recommend:${ip}`, 5, 3600)) return json({ error: "Too many requests — please try again later." }, 429);
  const org = cleanName(data.org || "").slice(0, 150);
  const contact = (data.contact || "").toString().trim().slice(0, 200);
  const from = cleanName(data.fromName || "").slice(0, 100);
  const note = (data.note || "").toString().trim().slice(0, 500);
  if (!org) return json({ error: "Please tell us the library or school name." }, 400);
  await notifyAdmin(env, `📚 Library recommendation: ${org}`,
    `📚 *Someone recommended KidVibers to their library/school!*\n• Organization: ${org}\n• Their contact info: ${contact || "(not given)"}\n• From: ${from || "a parent"}\n• Note: ${note || "(none)"}`);
  await sendEmail(env, "support@kidvibers.com", `Library lead: ${org}`,
    `<p><strong>${escHtml(from) || "A parent"}</strong> recommended KidVibers to <strong>${escHtml(org)}</strong>.</p><p>Contact/where to reach them: ${escHtml(contact) || "(not given)"}</p><p>Note: ${escHtml(note) || "(none)"}</p>`);
  return json({ ok: true });
}

// ── Parent screen-time limit (minutes per day) ──────────────────────────────
async function apiSetScreenLimit(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role)) return json({ error: "Only a parent or teacher can set this." }, 403);
  const mins = Math.max(0, Math.min(600, parseInt(data.minutes, 10) || 0)); // 0 = no limit
  await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?")
    .bind(`screenlimit:${u.family_id}`, String(mins), String(mins)).run();
  return json({ ok: true, minutes: mins });
}
async function apiGetScreenLimit(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "not logged in" }, 401);
  const fid = u.family_id;
  const row = fid != null ? await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`screenlimit:${fid}`).first() : null;
  return json({ minutes: row ? parseInt(row.value, 10) : 0 });
}

// Public kid report card — safe stats only, looked up by a DEDICATED card_token
// (never the link_token, which is used for parent-invite linking).
async function apiKidCard(env, token) {
  if (!token || token.length < 6) return json({ error: "Card not found." }, 404);
  const k = await env.DB.prepare("SELECT id,name,role FROM users WHERE card_token=? AND role='kid'").bind(token).first();
  if (!k) return json({ error: "Card not found." }, 404);
  const done = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(k.id).first()).c || 0;
  const worlds = (await env.DB.prepare("SELECT COUNT(*) c FROM unit_tests WHERE user_id=? AND passed=1").bind(k.id).first()).c || 0;
  const xpRow = await env.DB.prepare("SELECT COALESCE(SUM(l.xp),0) xp FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=?").bind(k.id).first();
  const xp = xpRow ? xpRow.xp : 0;
  const level = Math.floor(xp / 200) + 1;
  return json({ name: k.name, xp, level, lessonsDone: done, worldsCleared: worlds });
}

// Email a certificate to the parent on demand (share button).
async function apiEmailCertificate(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "Only kids can share certificates." }, 403);
  if (!u.parent_email) return json({ error: "No parent email on file — ask a grown-up to add one in Settings." }, 400);
  const unit = parseInt(data.unit, 10);
  const passed = await env.DB.prepare("SELECT best_score FROM unit_tests WHERE user_id=? AND unit=? AND passed=1").bind(u.id, unit).first();
  if (!passed) return json({ error: "You haven't earned that certificate yet." }, 400);
  await sendCertificateEmail(env, request, u, unit, passed.best_score || 100);
  return json({ ok: true, sentTo: u.parent_email });
}

// Bulk-email every student's best-earned certificate to their parent in one click —
// handy for a teacher/school wrapping up a session or semester.
async function apiTeacherBulkCertificates(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["parent", "teacher"].includes(u.role)) return json({ error: "forbidden" }, 403);
  if (rateLimited(`bulkcert:${u.id}`, 1, 3600)) return json({ error: "Already sent recently — try again in a bit." }, 429);
  let familyIds = [u.family_id];
  if (u.role === "teacher" && DISTRICT_PLANS.includes(u.plan)) {
    const schools = (await env.DB.prepare("SELECT family_id,id FROM users WHERE district_id=? AND role='teacher'").bind(u.id).all()).results || [];
    familyIds = [u.family_id, ...schools.map(s => s.family_id || s.id)];
  }
  const uniq = [...new Set(familyIds)];
  const ph = uniq.map(() => "?").join(",");
  const kids = (await env.DB.prepare(`SELECT * FROM users WHERE role='kid' AND family_id IN (${ph})`).bind(...uniq).all()).results || [];
  let sent = 0, skipped = 0;
  for (const kid of kids) {
    if (!kid.parent_email) { skipped++; continue; }
    const best = await env.DB.prepare("SELECT unit,best_score FROM unit_tests WHERE user_id=? AND passed=1 ORDER BY unit DESC LIMIT 1").bind(kid.id).first();
    if (!best) { skipped++; continue; }
    await sendCertificateEmail(env, request, kid, best.unit, best.best_score || 100);
    sent++;
  }
  return json({ ok: true, sent, skipped });
}

async function apiDistrictRoster(env, request) {
  const d = await fullDistrict(env, request);
  if (!d) return json({ error: "District accounts only." }, 403);
  // Get all school family_ids in this district
  const schools = (await env.DB.prepare("SELECT id,school,family_id FROM users WHERE district_id=? AND role='teacher'").bind(d.id).all()).results || [];
  const schoolMap = {}; // familyId → school name
  schools.forEach(s => { schoolMap[s.family_id || s.id] = s.school || "Unknown School"; });
  // Also include the district's own students (family_id = district.family_id)
  schoolMap[d.family_id] = null; // null = "District level"
  const allFamilyIds = [d.family_id, ...schools.map(s => s.family_id || s.id)];
  const uniqueIds = [...new Set(allFamilyIds)];
  const ph = uniqueIds.map(() => "?").join(",");
  const kids = (await env.DB.prepare(`SELECT id,name,username,suspended,family_id FROM users WHERE role='kid' AND family_id IN (${ph}) ORDER BY family_id,id`).bind(...uniqueIds).all()).results || [];
  return json({
    kids: kids.map(k => ({
      id: k.id, name: k.name, username: k.username, suspended: !!k.suspended,
      familyId: k.family_id, schoolName: schoolMap[k.family_id] || null,
    })),
    schools: schools.map(s => ({ id: s.id, name: s.school || "School", familyId: s.family_id || s.id })),
    total: kids.length,
    limit: teacherPlanCfg(d.plan).students,
  });
}

// District can reassign an existing student to a different school.
async function apiDistrictAssignSchool(env, request, data) {
  const d = await fullDistrict(env, request);
  if (!d) return json({ error: "District accounts only." }, 403);
  const school = await env.DB.prepare("SELECT id,family_id,school FROM users WHERE id=? AND district_id=? AND role='teacher'").bind(data.schoolId, d.id).first();
  if (!school) return json({ error: "That school isn't in your district." }, 404);
  // The set of family_ids that belong to THIS district: the district itself + every school under it.
  const schoolRows = (await env.DB.prepare("SELECT id,family_id FROM users WHERE district_id=? AND role='teacher'").bind(d.id).all()).results || [];
  const ownFamilyIds = new Set([d.family_id, ...schoolRows.map(s => s.family_id || s.id)]);
  const kid = await env.DB.prepare("SELECT id,name,username,family_id FROM users WHERE id=? AND role='kid'").bind(data.kidId).first();
  if (!kid) return json({ error: "Student not found." }, 404);
  // IDOR guard: the kid must already belong to this district. No grabbing other orgs' students.
  if (!ownFamilyIds.has(kid.family_id)) return json({ error: "That student isn't in your district." }, 403);
  const targetFamily = school.family_id || school.id;
  await env.DB.prepare("UPDATE users SET family_id=? WHERE id=?").bind(targetFamily, kid.id).run();
  return json({ ok: true, school: school.school || "School", student: kid.name });
}

async function apiParentFamily(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["parent", "teacher", "super_admin"].includes(u.role)) return json({ error: "forbidden" }, 403);
  const kids = (await env.DB.prepare("SELECT * FROM users WHERE role='kid' AND family_id=? ORDER BY id").bind(u.family_id).all()).results || [];
  const kidsPub = []; for (const k of kids) kidsPub.push(await publicUser(env, k));
  return json({ parent: await publicUser(env, u), kids: kidsPub });
}

// Rich per-student progress for teachers/parents: lessons done, worlds cleared,
// avg boss score, last active, XP. Powers both the progress table and leaderboard.
async function apiTeacherProgress(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !["parent", "teacher", "super_admin"].includes(u.role)) return json({ error: "forbidden" }, 403);
  // For a full district, include students across all its schools; else just this family.
  let familyIds = [u.family_id];
  if (u.role === "teacher" && DISTRICT_PLANS.includes(u.plan)) {
    const schools = (await env.DB.prepare("SELECT family_id,id FROM users WHERE district_id=? AND role='teacher'").bind(u.id).all()).results || [];
    familyIds = [u.family_id, ...schools.map(s => s.family_id || s.id)];
  }
  const uniq = [...new Set(familyIds)];
  const ph = uniq.map(() => "?").join(",");
  const kids = (await env.DB.prepare(`SELECT id,name,username,tokens,created_at,suspended FROM users WHERE role='kid' AND family_id IN (${ph}) ORDER BY id`).bind(...uniq).all()).results || [];

  const out = [];
  const totalLessons = (await env.DB.prepare("SELECT COUNT(*) c FROM lessons WHERE published=1").first()).c || 1;
  for (const k of kids) {
    const done = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(k.id).first()).c || 0;
    const last = (await env.DB.prepare("SELECT MAX(completed_at) m FROM progress WHERE user_id=?").bind(k.id).first()).m;
    const passedRows = (await env.DB.prepare("SELECT unit,best_score FROM unit_tests WHERE user_id=? AND passed=1").bind(k.id).all()).results || [];
    const worldsCleared = passedRows.length;
    const avgScore = passedRows.length ? Math.round(passedRows.reduce((a, r) => a + (r.best_score || 0), 0) / passedRows.length) : 0;
    // XP = total xp of completed lessons
    const xpRow = await env.DB.prepare("SELECT COALESCE(SUM(l.xp),0) xp FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=?").bind(k.id).first();
    out.push({
      id: k.id, name: k.name, username: k.username,
      lessonsDone: done, totalLessons,
      percent: Math.round(done / totalLessons * 100),
      worldsCleared, avgScore, xp: xpRow.xp || 0,
      level: worldsCleared + 1, tokens: k.tokens || 0,
      lastActive: last ? last.slice(0, 10) : null,
      lastActiveAt: last || null,
      online: last ? (Date.now() - new Date(last).getTime()) < 15 * 60000 : false,
      suspended: !!k.suspended,
    });
  }
  // Leaderboard order: by XP desc, then lessons done
  const leaderboard = [...out].sort((a, b) => b.xp - a.xp || b.lessonsDone - a.lessonsDone);
  return json({ students: out, leaderboard, totalLessons });
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
  // managedKid lets a district export a student from any of its schools (FERPA / records requests).
  const kid = await managedKid(env, u, kidId);
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

// Bulk roster actions for teachers/schools/districts: apply one action to many students at
// once (suspend / unsuspend / sign-out / delete). Every kid is checked against the caller's
// managed families, so you can only touch your own students.
async function apiBulkStudents(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher") return json({ error: "Only a teacher/school/district can do this." }, 403);
  const action = (data.action || "").trim();
  if (!["suspend", "unsuspend", "signout", "delete"].includes(action)) return json({ error: "Unknown action." }, 400);
  const ids = Array.isArray(data.kidIds) ? data.kidIds.slice(0, 500) : [];
  if (!ids.length) return json({ error: "No students selected." }, 400);
  const reason = (data.reason || "").toString().trim().slice(0, 200);
  let done = 0;
  for (const id of ids) {
    const kid = await managedKid(env, u, id);
    if (!kid) continue;
    if (action === "suspend") {
      await env.DB.prepare("UPDATE users SET suspended=1, suspend_reason=?, suspend_until=NULL WHERE id=?").bind(reason || `Suspended by ${u.school || "your school"}`, kid.id).run();
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();
    } else if (action === "unsuspend") {
      await env.DB.prepare("UPDATE users SET suspended=0, suspend_reason=NULL, suspend_until=NULL WHERE id=?").bind(kid.id).run();
    } else if (action === "signout") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();
    } else if (action === "delete") {
      for (const sql of ["DELETE FROM progress WHERE user_id=?","DELETE FROM unit_tests WHERE user_id=?","DELETE FROM sessions WHERE user_id=?","DELETE FROM chat_usage WHERE user_id=?","DELETE FROM messages WHERE child_id=?","DELETE FROM notices WHERE user_id=?","DELETE FROM users WHERE id=?"])
        await env.DB.prepare(sql).bind(kid.id).run();
    }
    done++;
  }
  return json({ ok: true, count: done, action });
}

async function apiParentDeleteKid(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role) || u.family_id == null) return json({ error: "Only a parent or teacher can do this." }, 403);
  const kid = await managedKid(env, u, data.kidId);
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

// The set of family_ids a guardian may manage. For a full District that's the district's own
// family PLUS every school under it (the district roster shows all those students, so the
// manage actions must reach them too). Everyone else: just their own family.
async function managedFamilyIds(env, u) {
  const ids = new Set([u.family_id]);
  if (u.role === "teacher" && u.plan === "district") {
    const schools = (await env.DB.prepare("SELECT id,family_id FROM users WHERE district_id=? AND role='teacher'").bind(u.id).all()).results || [];
    for (const s of schools) ids.add(s.family_id || s.id);
  }
  return [...ids];
}
// Fetch a kid only if they belong to one of the guardian's managed families.
async function managedKid(env, u, kidId) {
  const fams = await managedFamilyIds(env, u);
  const ph = fams.map(() => "?").join(",");
  return await env.DB.prepare(`SELECT * FROM users WHERE id=? AND role='kid' AND family_id IN (${ph})`).bind(kidId, ...fams).first();
}

// Only a true District plan (not a single School) can add and manage child schools.
async function fullDistrict(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "teacher" || u.plan !== "district" || u.family_id == null) return null;
  return u;
}

async function apiDistrictSchools(env, request) {
  const d = await fullDistrict(env, request);
  if (!d) return json({ error: "Only a District account can manage schools." }, 403);
  const rows = (await env.DB.prepare("SELECT id,name,school,username,class_code FROM users WHERE role='teacher' AND district_id=? ORDER BY id").bind(d.id).all()).results || [];
  const schools = [];
  for (const s of rows) {
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM users WHERE role='kid' AND family_id=?").bind(s.id).first()).c;
    schools.push({ id: s.id, name: s.school || s.name, admin: s.username, classCode: s.class_code, students: cnt });
  }
  return json({ schools, pricePer: SCHOOL_ADDON_PRICE, monthlyTotal: schools.length * SCHOOL_ADDON_PRICE, notCharged: true });
}

async function apiDistrictAddSchool(env, request, data) {
  const d = await fullDistrict(env, request);
  if (!d) return json({ error: "Only a District account can add schools." }, 403);
  const schoolName = (data.schoolName || "").trim().slice(0, 80) || "New School";
  const username = (data.username || "").trim();
  const password = data.password || "";
  // The "admin name" defaults to the school name; credentials are validated like any account.
  const err = validateCredentials(schoolName, username, password);
  if (err) return json({ error: err }, 400);
  const r = await createUser(env, {
    role: "teacher", name: schoolName, username, password, email: d.parent_email || "",
    age: "", plan: "school", trial_ends: null, school: schoolName,
  });
  if (r.error) return json({ error: r.error }, r.status || 400);
  // Link the new school to this district, give it its own group + class code, inherit branding.
  await env.DB.prepare("UPDATE users SET family_id=?, class_code=?, district_id=?, brand_name=?, brand_logo=? WHERE id=?")
    .bind(r.uid, await genClassCode(env), d.id, d.brand_name ?? null, d.brand_logo ?? null, r.uid).run();
  const row = await env.DB.prepare("SELECT id,school,username,class_code FROM users WHERE id=?").bind(r.uid).first();
  return json({ ok: true, notCharged: true, pricePer: SCHOOL_ADDON_PRICE,
    school: { id: row.id, name: row.school, admin: row.username, classCode: row.class_code, students: 0 } });
}

async function apiDistrictRemoveSchool(env, request, data) {
  const d = await fullDistrict(env, request);
  if (!d) return json({ error: "Only a District account can remove schools." }, 403);
  const school = await env.DB.prepare("SELECT id,school FROM users WHERE id=? AND role='teacher' AND district_id=?").bind(data.schoolId, d.id).first();
  if (!school) return json({ error: "That school isn't in your district." }, 404);
  // Remove the school's students, then the school account itself.
  const kids = (await env.DB.prepare("SELECT id FROM users WHERE role='kid' AND family_id=?").bind(school.id).all()).results || [];
  for (const k of kids) {
    for (const sql of ["DELETE FROM progress WHERE user_id=?", "DELETE FROM unit_tests WHERE user_id=?", "DELETE FROM sessions WHERE user_id=?", "DELETE FROM chat_usage WHERE user_id=?", "DELETE FROM users WHERE id=?"])
      await env.DB.prepare(sql).bind(k.id).run();
  }
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(school.id).run();
  await env.DB.prepare("DELETE FROM users WHERE id=?").bind(school.id).run();
  return json({ ok: true, name: school.school, removedStudents: kids.length });
}

async function apiSchoolBranding(env, request, data) {
  const owner = await districtOwner(env, request);
  if (!owner) return json({ error: "Only a School or District account can change branding." }, 403);
  // A school created under a district inherits the district's branding and can't change it.
  if (owner.district_id != null) return json({ error: "Your district manages branding for all its schools." }, 403);
  const brandName = (data.brandName || "").trim().slice(0, 80);
  const brandLogo = (data.brandLogo || "").trim().slice(0, 500);
  if (brandLogo && !/^https:\/\//.test(brandLogo)) return json({ error: "Logo must be a secure https:// image link." }, 400);
  await env.DB.prepare("UPDATE users SET brand_name=?, brand_logo=? WHERE id=?").bind(brandName || null, brandLogo || null, owner.id).run();
  return json({ ok: true, brandName: brandName || null, brandLogo: brandLogo || null });
}

async function apiSchoolSuspend(env, request, data) {
  const owner = await districtOwner(env, request);
  if (!owner) return json({ error: "Only a School or District account can do this." }, 403);
  const kid = await managedKid(env, owner, data.kidId);
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

// Account settings: a grown-up changes their OWN username/email. Kids can't (a parent must).
async function apiAccountUpdate(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "Please log in." }, 401);
  if (u.role === "kid") return json({ error: "Ask a parent or guardian to change your username or email." }, 403);
  const changed = [];
  const newUser = (data.username || "").trim();
  const newEmail = (data.email || "").trim();
  if (newUser && newUser !== u.username) {
    if (!USERNAME_RE.test(newUser)) return json({ error: "Username must be 3-20 letters, numbers or underscores." }, 400);
    const dup = await env.DB.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").bind(newUser, u.id).first();
    if (dup) return json({ error: "That username is already taken." }, 409);
    await env.DB.prepare("UPDATE users SET username=? WHERE id=?").bind(newUser, u.id).run();
    changed.push("username");
  }
  if (newEmail && newEmail.toLowerCase() !== (u.parent_email || "").toLowerCase()) {
    if (!/^\S+@\S+\.\S+$/.test(newEmail)) return json({ error: "Enter a valid email address." }, 400);
    await env.DB.prepare("UPDATE users SET parent_email=? WHERE id=?").bind(newEmail, u.id).run();
    changed.push("email");
  }
  if (!changed.length) return json({ error: "Nothing changed." }, 400);
  const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(u.id).first();
  return json({ ok: true, changed, user: await publicUser(env, row) });
}

// A parent/teacher changes a KID's username/email (this is the "with a parent's permission" path).
async function apiParentUpdateKid(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u || !GUARDIAN_ROLES.includes(u.role) || u.family_id == null) return json({ error: "Only a parent or teacher can do this." }, 403);
  const kid = await env.DB.prepare("SELECT * FROM users WHERE id=? AND role='kid' AND family_id=?").bind(data.kidId, u.family_id).first();
  if (!kid) return json({ error: "That kid isn't in your family." }, 403);
  const changed = [];
  const newUser = (data.username || "").trim();
  const newEmail = (data.email || "").trim();
  if (newUser && newUser !== kid.username) {
    if (!USERNAME_RE.test(newUser)) return json({ error: "Username must be 3-20 letters, numbers or underscores." }, 400);
    const dup = await env.DB.prepare("SELECT 1 FROM users WHERE username=? AND id<>?").bind(newUser, kid.id).first();
    if (dup) return json({ error: "That username is already taken." }, 409);
    await env.DB.prepare("UPDATE users SET username=? WHERE id=?").bind(newUser, kid.id).run();
    changed.push("username");
  }
  if (newEmail && newEmail.toLowerCase() !== (kid.parent_email || "").toLowerCase()) {
    if (!/^\S+@\S+\.\S+$/.test(newEmail)) return json({ error: "Enter a valid parent email." }, 400);
    await env.DB.prepare("UPDATE users SET parent_email=? WHERE id=?").bind(newEmail, kid.id).run();
    changed.push("email");
  }
  // Parent can set a new password for their kid (kids have no self-serve reset by design).
  const newPass = data.password || "";
  if (newPass) {
    if (newPass.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const { hash, salt } = await hashPassword(newPass);
    await env.DB.prepare("UPDATE users SET password_hash=?, salt=? WHERE id=?").bind(hash, salt, kid.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(kid.id).run();  // sign out old devices
    changed.push("password");
  }
  if (!changed.length) return json({ error: "Nothing changed." }, 400);
  return json({ ok: true, changed });
}

async function apiSchoolCredentials(env, request, data) {
  const owner = await districtOwner(env, request);
  if (!owner) return json({ error: "Only a School or District account can do this." }, 403);
  const kid = await managedKid(env, owner, data.kidId);
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
    // Live drop-in sessions: lifetime started, lifetime kids joined, and how many are live now.
    sessionsStarted: await getStat(env, "sessions_started"),
    sessionJoins: await getStat(env, "session_joins"),
    sessionsActive: await c("SELECT COUNT(*) c FROM settings WHERE key LIKE 'session:%'"),
    // Which database the panel is reading. STAGING_USER is only set in the staging env,
    // so the admin panel can show a clear "production vs staging" badge.
    environment: env.STAGING_USER ? "staging" : "production",
  });
}
// Founder analytics: growth, activity, and conversion (super admin).
async function adminAnalytics(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const c = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first()).c;

  const totalKids = await c("SELECT COUNT(*) c FROM users WHERE role='kid'");
  const totalParents = await c("SELECT COUNT(*) c FROM users WHERE role IN ('parent','teacher')");
  const proKids = await c("SELECT COUNT(*) c FROM users WHERE role='kid' AND plan IN ('pro','family')");
  const freeKids = await c("SELECT COUNT(*) c FROM users WHERE role='kid' AND plan NOT IN ('pro','family')");
  const paying = await c("SELECT COUNT(*) c FROM users WHERE stripe_subscription_id IS NOT NULL");

  // Active kids = completed a lesson in the last 7 days
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const active7 = await c("SELECT COUNT(DISTINCT user_id) c FROM progress WHERE completed_at >= ?", since7);
  const active30 = await c("SELECT COUNT(DISTINCT user_id) c FROM progress WHERE completed_at >= ?", since30);

  // Signups per day for the last 14 days
  const rows = (await env.DB.prepare(
    "SELECT substr(created_at,1,10) d, COUNT(*) c FROM users WHERE role='kid' AND created_at >= ? GROUP BY d ORDER BY d"
  ).bind(since30).all()).results || [];
  const byDay = {};
  rows.forEach(r => { byDay[r.d] = r.c; });
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ day: d.slice(5), count: byDay[d] || 0 });
  }

  // Lessons completed total + certificates earned (worlds passed)
  const lessonsCompleted = await c("SELECT COUNT(*) c FROM progress");
  const certsEarned = await c("SELECT COUNT(*) c FROM unit_tests WHERE passed=1");
  const gamesPlayed = await c("SELECT COUNT(*) c FROM lessons_daily WHERE day LIKE '%-game:%'");

  const convPct = totalKids ? Math.round((proKids / totalKids) * 100) : 0;

  // ── Advanced metrics ──
  // Plan breakdown (kids by plan)
  const planRows = (await env.DB.prepare("SELECT plan, COUNT(*) c FROM users WHERE role='kid' GROUP BY plan").all()).results || [];
  const planBreakdown = {}; planRows.forEach(r => { planBreakdown[r.plan || "free"] = r.c; });

  // Estimated MRR from active paid subscriptions (Stripe-linked), by plan price.
  const PRICE = { pro: 9, family: 15, teacher: 24, school: 105, district: 125 };
  const subRows = (await env.DB.prepare("SELECT plan, COUNT(*) c FROM users WHERE stripe_subscription_id IS NOT NULL GROUP BY plan").all()).results || [];
  let mrr = 0; subRows.forEach(r => { mrr += (PRICE[r.plan] || 0) * r.c; });

  // Retention: % of kids active in last 30 days; stickiness = active7/active30
  const retention30 = totalKids ? Math.round((active30 / totalKids) * 100) : 0;
  const stickiness = active30 ? Math.round((active7 / active30) * 100) : 0;

  // Referrals & engagement
  const referrals = await c("SELECT COUNT(*) c FROM users WHERE referred_by IS NOT NULL");
  const avgLessons = totalKids ? Math.round((lessonsCompleted / totalKids) * 10) / 10 : 0;
  const emailsCollected = await c("SELECT COUNT(*) c FROM users WHERE (parent_email IS NOT NULL AND parent_email!='') OR (kid_email IS NOT NULL AND kid_email!='')");
  const schools = await c("SELECT COUNT(*) c FROM users WHERE role='teacher'");

  // New kids per week, last 6 weeks
  const weeks = [];
  for (let w = 5; w >= 0; w--) {
    const start = new Date(Date.now() - (w + 1) * 7 * 86400000).toISOString();
    const end = new Date(Date.now() - w * 7 * 86400000).toISOString();
    const ct = await c("SELECT COUNT(*) c FROM users WHERE role='kid' AND created_at >= ? AND created_at < ?", start, end);
    weeks.push({ label: w === 0 ? "this wk" : `${w}w ago`, count: ct });
  }

  // Most-completed lessons (top 5)
  const topLessons = (await env.DB.prepare(
    "SELECT l.title, l.emoji, COUNT(*) c FROM progress p JOIN lessons l ON l.id=p.lesson_id GROUP BY p.lesson_id ORDER BY c DESC LIMIT 5"
  ).all()).results || [];

  return json({
    totalKids, totalParents, proKids, freeKids, paying,
    active7, active30, conversionPct: convPct,
    lessonsCompleted, certsEarned, gamesPlayed,
    signupsByDay: days,
    newThisWeek: days.slice(7).reduce((a, d) => a + d.count, 0),
    // advanced
    mrr, retention30, stickiness, referrals, avgLessons, emailsCollected, schools,
    planBreakdown, weeklySignups: weeks,
    topLessons: topLessons.map(l => ({ title: `${l.emoji || ""} ${l.title}`, count: l.c })),
  });
}

// Super-admin search: look up a kid by username (partial) and return full info.
async function adminFindKid(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const q = (new URL(request.url).searchParams.get("q") || "").trim();
  if (!q) return json({ kids: [] });
  const rows = (await env.DB.prepare(
    "SELECT id,name,username,role,plan,parent_email,kid_email,age_years,family_id,consent_status,consent_method,tokens,created_at,suspended,school " +
    "FROM users WHERE username LIKE ? OR name LIKE ? ORDER BY (role='kid') DESC, id DESC LIMIT 25"
  ).bind(`%${q}%`, `%${q}%`).all()).results || [];
  const out = [];
  for (const r of rows) {
    const lessons = r.role === "kid" ? (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(r.id).first()).c || 0 : 0;
    const worlds = r.role === "kid" ? (await env.DB.prepare("SELECT COUNT(*) c FROM unit_tests WHERE user_id=? AND passed=1").bind(r.id).first()).c || 0 : 0;
    const last = r.role === "kid" ? (await env.DB.prepare("SELECT MAX(completed_at) m FROM progress WHERE user_id=?").bind(r.id).first()).m : null;
    out.push({
      id: r.id, name: r.name, username: r.username, role: r.role, plan: r.plan,
      parentEmail: r.parent_email, kidEmail: r.kid_email, ageYears: r.age_years,
      consentStatus: r.consent_status, consentMethod: r.consent_method, tokens: r.tokens,
      joined: (r.created_at || "").slice(0, 10), suspended: !!r.suspended, school: r.school,
      lessonsDone: lessons, worldsCleared: worlds, lastActive: last ? last.slice(0, 10) : null,
    });
  }
  return json({ kids: out });
}

// Class/school groups for the consent panel: one entry per teacher with its students.
async function adminConsentGroups(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const teachers = (await env.DB.prepare("SELECT id,name,school,class_code,family_id,plan FROM users WHERE role='teacher' ORDER BY id").all()).results || [];
  const groups = [];
  for (const t of teachers) {
    const fam = t.family_id || t.id;
    const kids = (await env.DB.prepare("SELECT id,name,username,age_years,consent_status FROM users WHERE role='kid' AND family_id=? ORDER BY name").bind(fam).all()).results || [];
    groups.push({
      id: t.id, name: t.school || t.name, classCode: t.class_code, plan: t.plan,
      students: kids.map(k => ({ id: k.id, name: k.name, username: k.username, ageYears: k.age_years, consentStatus: k.consent_status || "not_required" })),
      count: kids.length,
    });
  }
  return json({ groups });
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
  // Super admin gets the FULL quiz (answer + explain) for editing — unlike the public list.
  const full = rows.map((r) => {
    const pub = lessonPublic(r);
    try { pub.quiz = JSON.parse(r.quiz || "{}"); } catch { pub.quiz = {}; }
    return pub;
  });
  return json({ planSettings: await getPlanSettings(env), passPercent: await getPassPercent(env), unitNames: UNIT_NAMES, worlds: WORLDS, lessons: full });
}
async function adminAccountRequests(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT id,role,name,username,email,plan,requested_by,created_at FROM account_requests WHERE status='pending' ORDER BY id DESC").all()).results || [];
  return json({ requests: rows.map((r) => ({ id: r.id, role: r.role, name: r.name, username: r.username, email: r.email, plan: r.plan, requestedBy: r.requested_by, at: (r.created_at || "").slice(0, 16).replace("T", " ") })) });
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
// Role preview: super admin can see any dashboard view without a real account.
// Creates a short-lived (2hr) preview session with synthetic user data.
async function apiAdminPreview(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const VALID_ROLES = ["kid", "parent", "teacher", "school", "district"];
  const role = (data.role || "").trim().toLowerCase();
  if (!VALID_ROLES.includes(role)) return json({ error: "Invalid role. Choose: " + VALID_ROLES.join(", ") }, 400);
  // Clean up expired previews for tidiness.
  await env.DB.prepare("DELETE FROM preview_sessions WHERE expires_at < ?").bind(nowIso()).run();
  const token = randToken(32);
  const expiresAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  await env.DB.prepare("INSERT INTO preview_sessions (token, role, expires_at) VALUES (?,?,?)").bind(token, role, expiresAt).run();
  const redirects = { kid: "dashboard.html", parent: "parent.html", teacher: "parent.html", school: "district.html", district: "district.html" };
  return json({ ok: true, token, role, redirectUrl: redirects[role], expiresAt });
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
    const lpd = p.lessonsPerDay !== undefined ? p.lessonsPerDay : p.lessonLimit;
    clean[plan] = { ai: !!p.ai, chatsPerDay: parseInt(p.chatsPerDay, 10) || 0, lessonsPerDay: lpd === undefined ? -1 : (parseInt(lpd, 10) || 0) };
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

// ───────────────────────── email (Resend) ─────────────────────────
// `from` is optional - pass it to send from a specific address (e.g. password@kidvibers.com
// for reset emails). Everything else sends from support@kidvibers.com.
// ── Slack notifications ──────────────────────────────────────
async function sendSlack(env, text) {
  if (!env.SLACK_WEBHOOK) return;
  try {
    await fetch(env.SLACK_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (_) {}
}

// Operational alerts (new signups, reports) go to the owner's email instead of Slack.
// Markdown-ish text in -> simple HTML out.
async function notifyAdmin(env, subject, text) {
  const to = env.ADMIN_EMAIL || "support@kidvibers.com";
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;color:#222;line-height:1.6;">
    <div style="background:#7c3aed;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:800;">🚀 KidVibers — Admin Alert</div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 10px 10px;padding:18px 20px;">
      ${text.replace(/\*(.+?)\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}
    </div></div>`;
  await sendEmail(env, to, subject, html, "KidVibers <support@kidvibers.com>");
}

const EMAIL_FOOTER = `
<div style="margin-top:40px;padding-top:24px;border-top:2px solid #ede9fe;">
  <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;">
    <tr>
      <td style="padding-bottom:10px;">
        <span style="font-size:22px;font-weight:900;color:#7c3aed;letter-spacing:-0.5px;">🚀 Kid<strong>Vibers</strong></span>
      </td>
    </tr>
    <tr>
      <td style="font-size:13px;color:#6b7280;line-height:1.7;">
        <strong style="color:#374151;">Made by a kid, for kids ❤️</strong><br/>
        The fun, fast way to learn coding — 242+ lessons, games &amp; real projects.<br/><br/>
        📧 <a href="mailto:support@kidvibers.com" style="color:#7c3aed;text-decoration:none;">support@kidvibers.com</a>
        &nbsp;·&nbsp;
        🌐 <a href="https://kidvibers.com" style="color:#7c3aed;text-decoration:none;">kidvibers.com</a>
        &nbsp;·&nbsp;
        🛡️ <a href="https://kidvibers.com/trust.html" style="color:#7c3aed;text-decoration:none;">Trust &amp; Safety</a>
        &nbsp;·&nbsp;
        📄 <a href="https://kidvibers.com/privacy.html" style="color:#7c3aed;text-decoration:none;">Privacy Policy</a>
      </td>
    </tr>
    <tr>
      <td style="padding-top:12px;font-size:11px;color:#9ca3af;">
        © 2026 KidVibers.com · Owner: Elisha Clark<br/>
        You're receiving this because you or your child has a KidVibers account.
        <a href="https://kidvibers.com" style="color:#9ca3af;">Unsubscribe</a>
      </td>
    </tr>
  </table>
</div>`;

async function sendEmail(env, to, subject, html, from) {
  if (!to || !env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: from || env.EMAIL_FROM || "KidVibers <support@kidvibers.com>",
        to: [to], subject,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;max-width:600px;margin:0 auto;padding:24px 20px;">${html}${EMAIL_FOOTER}</div>`,
        reply_to: env.REPLY_TO || "support@kidvibers.com",
      }),
    });
    return res.ok;
  } catch (e) { console.log("email failed:", e); return false; }
}
const FROM_PASSWORD = "KidVibers <password@kidvibers.com>";

// ───────────────────────── Stripe ─────────────────────────
function stripeEnabled(env) { return !!env.STRIPE_SECRET_KEY; }
function stripePrices(env, interval) {
  if (interval === "year") {
    return { pro: env.STRIPE_PRICE_PRO_ANNUAL, family: env.STRIPE_PRICE_FAMILY_ANNUAL, teacher: env.STRIPE_PRICE_TEACHER_ANNUAL, school: env.STRIPE_PRICE_SCHOOL_ANNUAL, district: env.STRIPE_PRICE_DISTRICT_ANNUAL };
  }
  return { pro: env.STRIPE_PRICE_PRO, family: env.STRIPE_PRICE_FAMILY, teacher: env.STRIPE_PRICE_TEACHER, school: env.STRIPE_PRICE_SCHOOL, district: env.STRIPE_PRICE_DISTRICT };
}
// Annual price = 12 × monthly (no discount, per owner's choice)
const ANNUAL_PRICE = { pro: 108, family: 180, teacher: 288, school: 1260, district: 1500 };
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
  // Billing isn't live, so DON'T change the plan - visiting checkout must never grant a free upgrade.
  return json({ ok: true, plan, user: await publicUser(env, u), notCharged: true });
}

async function apiCheckoutSession(env, request, data) {
  const u = await userFromToken(env, bearer(request));
  if (!u) return json({ error: "Please log in to upgrade." }, 401);
  const plan = (data.plan || "").trim();
  const interval = data.interval === "year" ? "year" : "month";
  if (!["pro", "family", "teacher", "school", "district"].includes(plan)) return json({ error: "Unknown plan." }, 400);
  if (!stripePlanRoleOk(plan, u.role)) return json({ error: "This account type can't purchase that plan." }, 403);
  const price = stripePrices(env, interval)[plan];
  if (!stripeEnabled(env) || !price) return json({ simulated: true });
  const base = siteUrl(env, request);
  const params = {
    mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": 1,
    success_url: `${base}/checkout.html?status=success&plan=${plan}`, cancel_url: `${base}/checkout.html?plan=${plan}&status=cancel`,
    client_reference_id: String(u.id), "metadata[user_id]": String(u.id), "metadata[plan]": plan, "metadata[interval]": interval, allow_promotion_codes: "true",
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
    const meta = obj.metadata || {};
    const plan = meta.plan;
    // ── Gift purchase: no buyer account; upgrade the recipient by email (or invite them). ──
    if (meta.gift === "1" && plan) {
      const rEmail = (obj.customer_details && obj.customer_details.email) || obj.customer_email || "";
      const sender = meta.senderName || "someone";
      if (rEmail) {
        const acct = await env.DB.prepare("SELECT * FROM users WHERE parent_email=? AND role IN ('parent','kid') ORDER BY role='parent' DESC LIMIT 1").bind(rEmail).first();
        if (acct) {
          await env.DB.prepare("UPDATE users SET plan=?, stripe_customer_id=?, stripe_subscription_id=? WHERE id=?").bind(plan, obj.customer ?? null, obj.subscription ?? null, acct.id).run();
          await sendEmail(env, rEmail, `🎁 ${sender} gifted you KidVibers ${plan === "family" ? "Family" : "Pro"}!`,
            `<p><strong>${sender}</strong> gifted you the KidVibers <strong>${plan}</strong> plan — it's now active on your account! 🎉</p><p><a href="https://kidvibers.com/dashboard.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Open KidVibers →</a></p>`);
        } else {
          // No account yet — invite them to sign up; a human can apply the plan.
          await sendEmail(env, rEmail, `🎁 ${sender} gifted you KidVibers ${plan === "family" ? "Family" : "Pro"}!`,
            `<p><strong>${sender}</strong> just gifted you a KidVibers <strong>${plan}</strong> subscription! 🎉</p>
             <p>Create your free account and we'll apply your gift:</p>
             <p><a href="https://kidvibers.com/index.html#signup" style="display:inline-block;background:#7c3aed;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Get started →</a></p>
             <p style="color:#666;font-size:0.85rem;">Use this email (${rEmail}) when you sign up so we can match your gift. Questions? support@kidvibers.com</p>`);
          await notifyAdmin(env, `🎁 Gift needs manual apply: ${rEmail}`, `🎁 *Gift purchased for someone without an account*\n• Recipient: ${rEmail}\n• Plan: ${plan}\n• From: ${sender}\n• Apply the ${plan} plan once they sign up.`);
        }
      }
      return json({ received: true });
    }
    // ── Normal self-purchase ──
    const uid = obj.client_reference_id || meta.user_id;
    if (uid && plan) {
      const row = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
      if (row) {
        const interval = meta.interval === "year" ? "year" : "month";
        const renewsAt = new Date(Date.now() + (interval === "year" ? 365 : 30) * 86400000).toISOString();
        await env.DB.prepare("UPDATE users SET plan=?, stripe_customer_id=?, stripe_subscription_id=?, plan_interval=?, plan_renews_at=? WHERE id=?")
          .bind(plan, obj.customer ?? null, obj.subscription ?? null, interval, renewsAt, uid).run();
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

// ───────────────────────── Resend webhook (bounces + inbound mail) ─────────────────────────
// Verify Svix signature (how Resend signs webhooks) so only Resend can post events.
async function resendSigOk(env, body, headers) {
  const secret = env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;                       // fail closed until the signing secret is set
  const id = headers.get("svix-id"), ts = headers.get("svix-timestamp"), sig = headers.get("svix-signature");
  if (!id || !ts || !sig) return false;
  const tsNum = parseInt(ts, 10);
  if (!tsNum || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;  // 5-min replay guard
  const keyB64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes; try { keyBytes = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0)); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sig.split(" ").some((p) => (p.split(",")[1] || "") === expected);
}

async function apiResendWebhook(env, rawBody, headers) {
  if (!(await resendSigOk(env, rawBody, headers))) return json({ error: "bad signature" }, 401);
  let ev; try { ev = JSON.parse(rawBody); } catch { return json({ error: "bad payload" }, 400); }
  const t = ev.type || "", d = ev.data || {};
  const subject = String(d.subject || "").slice(0, 200);
  const now = nowIso();
  if (t === "email.bounced" || t === "email.complained" || t === "email.delivery_delayed") {
    const kind = t.split(".")[1];   // bounced | complained | delivery_delayed
    const to = (Array.isArray(d.to) ? d.to.join(", ") : (d.to || "")).slice(0, 160);
    const reason = (d.bounce && (d.bounce.message || d.bounce.subType || d.bounce.type))
      || (kind === "complained" ? "Recipient marked it as spam" : "Delivery problem");
    // Saved to email_events - it shows up in the admin's "📭 Email Issues" panel.
    await env.DB.prepare("INSERT INTO email_events (direction,kind,peer_email,subject,body,created_at) VALUES ('outbound',?,?,?,?,?)")
      .bind(kind, to, subject, String(reason).slice(0, 300), now).run();
  } else if (t === "email.received") {
    const from = String(d.from || (d.envelope && d.envelope.from) || "").slice(0, 160);
    const text = String(d.text || d.html || "").slice(0, 4000);
    await env.DB.prepare("INSERT INTO email_events (direction,kind,peer_email,subject,body,created_at) VALUES ('inbound','received',?,?,?,?)")
      .bind(from, subject, text, now).run();
  }
  return json({ received: true });
}

async function apiAdminEmailEvents(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT id,direction,kind,peer_email,subject,body,created_at FROM email_events ORDER BY id DESC LIMIT 200").all()).results || [];
  const events = [];
  for (const r of rows) {
    const ev = {
      id: r.id, direction: r.direction, kind: r.kind, email: r.peer_email || "",
      subject: r.subject || "", body: (r.body || "").slice(0, 600),
      at: (r.created_at || "").slice(0, 16).replace("T", " "),
      kids: [],
    };
    // For a bounced/failed email, find which kid account(s) it was for (matched by parent email).
    if (r.direction === "outbound" && r.peer_email) {
      const emails = r.peer_email.split(",").map((e) => e.trim()).filter(Boolean);
      for (const em of emails) {
        const kids = (await env.DB.prepare(
          "SELECT id,name,username,age_years,parent_email,consent_status,created_at,family_id FROM users WHERE role='kid' AND lower(parent_email)=lower(?) ORDER BY id DESC LIMIT 10"
        ).bind(em).all()).results || [];
        for (const k of kids) ev.kids.push({
          id: k.id, name: k.name, username: k.username, ageYears: k.age_years,
          parentEmail: k.parent_email, consentStatus: k.consent_status || "not_required",
          joined: (k.created_at || "").slice(0, 10),
        });
      }
    }
    events.push(ev);
  }
  return json({ events });
}

// Super admin can reset any non-super-admin account's password.
async function apiAdminResetPassword(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const target = await env.DB.prepare("SELECT id, role FROM users WHERE id=?").bind(data && data.userId).first();
  if (!target) return json({ error: "User not found." }, 404);
  if (target.role === "super_admin") return json({ error: "Can't reset a super admin here." }, 403);
  const pw = (data && data.password) || "";
  if (pw.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
  const { hash, salt } = await hashPassword(pw);
  await env.DB.prepare("UPDATE users SET password_hash=?, salt=? WHERE id=?").bind(hash, salt, target.id).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(target.id).run();
  return json({ ok: true });
}

async function apiAdminEmailEventDelete(env, request, data) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  if (data && data.all) {
    await env.DB.prepare("DELETE FROM email_events WHERE direction='outbound'").run();
    return json({ ok: true, cleared: true });
  }
  if (!data || data.id == null) return json({ error: "id required" }, 400);
  await env.DB.prepare("DELETE FROM email_events WHERE id=?").bind(data.id).run();
  return json({ ok: true });
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
      `<p>Hi ${cleanName(row.name || "")}, we got a request to reset your KidVibers password.</p><p><a href="${url}">Click here to choose a new password</a> (expires in 2 hours).</p>`,
      FROM_PASSWORD);
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
  // Parent identity verification: full legal name + last 4 of a payment card + a sworn
  // attestation. We NEVER charge the card and only ever keep the last 4 digits (no PCI scope).
  // This raises the bar so a child can't simply self-approve from their own email.
  // Strip any HTML/markup so a name can never carry a script payload into the admin panel.
  const parentName = (data.parentName || "").replace(/[<>"'`&]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const cardLast4 = (data.cardLast4 || "").trim();
  const attest = data.attest === true || data.attest === "true";
  if (parentName.length < 2 || !/[a-zA-Z]/.test(parentName)) return json({ error: "Please enter the parent or guardian's full legal name (letters only)." }, 400);
  if (!/^\d{4}$/.test(cardLast4)) return json({ error: "Please enter the last 4 digits of your payment card." }, 400);
  if (!attest) return json({ error: "Please confirm you are the parent or legal guardian and over 18." }, 400);
  await grantConsent(env, kid.id, "verified_parent", parentName);
  await logConsent(env, kid.id, kid.username, "verified_parent", parentName,
    `Parent verified ID: name + card ending ${cardLast4}; attested parent/guardian, 18+ (card never charged)`);
  return json({ ok: true, childName: kid.name });
}
// On-device approval: a logged-in pending kid gets (or creates) their consent token so a
// parent standing next to them can approve immediately - no email required.
async function apiConsentSelf(env, request) {
  const u = await userFromToken(env, bearer(request));
  if (!u || u.role !== "kid") return json({ error: "forbidden" }, 403);
  if (consentOk(u)) return json({ error: "This account is already approved." }, 400);
  let tok = u.consent_token;
  if (!tok) { tok = randToken(10); await env.DB.prepare("UPDATE users SET consent_token=? WHERE id=?").bind(tok, u.id).run(); }
  return json({ ok: true, token: tok, childName: u.name });
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
  // Editing is ONLY allowed on the staging site (where the password gate already authorized
  // the visitor). The live site is read-only - no one, not even a super admin, edits it
  // directly; changes reach production only through staging's "Publish".
  if (env.STAGING_USER) return null;
  return json({ error: "The live site can't be edited directly - make changes on staging and Publish." }, 403);
}
async function apiSiteEditsGet(env) {
  const e = await getSetting(env, "site_edits", { texts: {}, blocks: {}, filters: {} });
  // canEdit is true ONLY on staging - so the editor toolbar never appears on the live site.
  // Colors are locked: never serve any saved color override, so the KidVibers brand colors
  // always stay original everywhere (even for browsers running an older cached editor.js).
  return new Response(JSON.stringify({ colors: {}, texts: e.texts || {}, blocks: e.blocks || {}, filters: e.filters || {}, canEdit: !!env.STAGING_USER }),
    { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS } });
}
async function apiSiteEditsSave(env, request, data) {
  const err = await editAuth(env, request); if (err) return err;
  // Colors are intentionally dropped — the brand colors can't be changed.
  const clean = { texts: (data && data.texts) || {}, blocks: (data && data.blocks) || {}, filters: (data && data.filters) || {} };
  if (JSON.stringify(clean).length > 4_000_000) return json({ error: "Too much content/images to save - try smaller or fewer images." }, 413);
  await setSetting(env, "site_edits", clean);
  return json({ ok: true });
}
async function apiAdminInterest(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const rows = (await env.DB.prepare("SELECT to_email, body, created_at FROM messages WHERE kind='plan_interest' ORDER BY id DESC LIMIT 500").all()).results || [];
  return json({ interest: rows.map((r) => ({ email: r.to_email, plan: r.body, at: (r.created_at || "").slice(0, 16).replace("T", " ") })) });
}
async function apiNotifyInterest(env, request, data) {
  const email = (data.email || "").trim().slice(0, 120);
  if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
  if (rateLimited(`notify:${email.toLowerCase()}`, 5, 3600)) return json({ ok: true });
  const plan = (data.plan || "").trim().slice(0, 40) || "pro";
  await env.DB.prepare("INSERT INTO messages (to_email,kind,body,created_at) VALUES (?,?,?,?)")
    .bind(email, "plan_interest", plan, nowIso()).run();
  return json({ ok: true });
}

// Count what changed, so the super admin can see a quick summary of the request.
function editsSummary(e) {
  e = e || {};
  let blocks = 0;
  for (const pg in (e.blocks || {})) blocks += (e.blocks[pg] || []).length;
  let texts = 0;
  for (const pg in (e.texts || {})) texts += Object.keys(e.texts[pg] || {}).length;
  return { colors: Object.keys(e.colors || {}).length, filters: Object.keys(e.filters || {}).length, texts, blocks };
}

// Staging: submit the current staged edits to the super admin for approval (does NOT go live).
async function apiSiteEditsSubmit(env, request) {
  const err = await editAuth(env, request); if (err) return err;
  if (!env.DB_PROD) return json({ error: "Submitting is only available from the staging site." }, 400);
  const edits = await getSetting(env, "site_edits", { colors: {}, texts: {}, blocks: {}, filters: {} });
  const pending = { edits, submittedAt: nowIso(), summary: editsSummary(edits) };
  await env.DB_PROD.prepare("INSERT INTO settings (key,value) VALUES ('pending_site_edits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(pending)).run();
  return json({ ok: true });
}

// Live admin (super admin): see the pending website-change request, if any.
async function apiPendingGet(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const p = await getSetting(env, "pending_site_edits", null);
  if (!p) return json({ pending: null });
  return json({ pending: { submittedAt: p.submittedAt || "", summary: p.summary || editsSummary(p.edits), stagingUrl: "https://kidvibers-staging.elishalclark.workers.dev/" } });
}

// Live admin (super admin): APPROVE -> the change goes live. DENY -> the request is discarded.
async function apiPendingApprove(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  const p = await getSetting(env, "pending_site_edits", null);
  if (!p) return json({ error: "There's no pending change to approve." }, 404);
  await setSetting(env, "site_edits", p.edits || {});
  await env.DB.prepare("DELETE FROM settings WHERE key='pending_site_edits'").run();
  return json({ ok: true });
}
async function apiPendingDeny(env, request) {
  const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
  await env.DB.prepare("DELETE FROM settings WHERE key='pending_site_edits'").run();
  return json({ ok: true });
}

// ───────────────────────── router ─────────────────────────

async function handleApi(env, request, path) {
  const method = request.method;
  let data = {};
  if (method === "POST") { try { data = await request.json(); } catch { data = {}; } }

  // public GETs
  if (path === "/api/launch-slots" && method === "GET") return apiLaunchSlots(env);
  if (path === "/api/site-config" && method === "GET")
    return json({ signupsEnabled: await authEnabled(env, "signups"), loginsEnabled: await authEnabled(env, "logins"), stripeEnabled: !!env.STRIPE_SECRET_KEY, vapidPublicKey: env.VAPID_PUBLIC_KEY || null });

  // ── Push notification subscription ──
  if (path === "/api/push/subscribe" && method === "POST") {
    const u = await userFromToken(env, bearer(request));
    if (!u) return json({ error: "not logged in" }, 401);
    const sub = data.subscription || {};
    if (!sub.endpoint) return json({ error: "bad subscription" }, 400);
    const keys = sub.keys || {};
    await env.DB.prepare("INSERT INTO push_subs (user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=?, p256dh=?, auth=?")
      .bind(u.id, sub.endpoint, keys.p256dh || "", keys.auth || "", nowIso(), u.id, keys.p256dh || "", keys.auth || "").run();
    return json({ ok: true });
  }
  if (path === "/api/push/unsubscribe" && method === "POST") {
    const u = await userFromToken(env, bearer(request));
    if (!u) return json({ error: "not logged in" }, 401);
    if (data.endpoint) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=? AND user_id=?").bind(data.endpoint, u.id).run();
    return json({ ok: true });
  }
  if (path === "/api/site-message" && method === "GET") {
    const m = await getSetting(env, "site_message", {});
    return json({ text: m.text || "", active: !!m.active });
  }
  if (path === "/api/site-edits" && method === "GET") return apiSiteEditsGet(env);
  if (path === "/api/notify-interest" && method === "POST") return apiNotifyInterest(env, request, data);
  if (path === "/api/admin/site-edits" && method === "POST") return apiSiteEditsSave(env, request, data);
  if (path === "/api/admin/site-edits/submit" && method === "POST") return apiSiteEditsSubmit(env, request);
  if (path === "/api/admin/site-edits/pending" && method === "GET") return apiPendingGet(env, request);
  if (path === "/api/admin/site-edits/approve" && method === "POST") return apiPendingApprove(env, request);
  if (path === "/api/admin/site-edits/deny" && method === "POST") return apiPendingDeny(env, request);
  if (path === "/api/admin/interest" && method === "GET") return apiAdminInterest(env, request);
  if (path === "/api/admin/email-events" && method === "GET") return apiAdminEmailEvents(env, request);
  if (path === "/api/admin/email-events/delete" && method === "POST") return apiAdminEmailEventDelete(env, request, data);
  if (path === "/api/admin/reset-password" && method === "POST") return apiAdminResetPassword(env, request, data);
  if (path === "/api/me" && method === "GET") return apiMe(env, request);
  if (path === "/api/lessons" && method === "GET") return apiLessons(env);
  if (path === "/api/progress" && method === "GET") return apiProgressGet(env, request);
  if (path === "/api/notices" && method === "GET") return apiNotices(env, request);
  if (path === "/api/shop" && method === "GET") return apiShop(env, request);
  if (path === "/api/parent/family" && method === "GET") return apiParentFamily(env, request);
  if (path === "/api/teacher/progress" && method === "GET") return apiTeacherProgress(env, request);
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
  // admin GETs
  if (path === "/api/admin/users" && method === "GET") return adminUsers(env, request);
  if (path === "/api/admin/accounts" && method === "GET") return adminAccounts(env, request);
  if (path === "/api/admin/stats" && method === "GET") return adminStats(env, request);
  if (path === "/api/admin/analytics" && method === "GET") return adminAnalytics(env, request);
  if (path === "/api/admin/find-kid" && method === "GET") return adminFindKid(env, request);
  if (path === "/api/admin/consent-groups" && method === "GET") return adminConsentGroups(env, request);
  if (path === "/api/admin/consent" && method === "GET") return adminConsentGet(env, request);
  if (path === "/api/admin/settings" && method === "GET") return adminSettingsGet(env, request);
  if (path === "/api/admin/account-requests" && method === "GET") return adminAccountRequests(env, request);

  // auth POSTs
  if (path === "/api/signup" && method === "POST") return apiSignup(env, request, data);
  if (path === "/api/parent/signup" && method === "POST") return apiParentSignup(env, request, data);
  if (path === "/api/teacher/signup" && method === "POST") return apiTeacherSignup(env, request, data);
  if (path === "/api/auth/google" && method === "POST") return apiAuthGoogle(env, request, data);
  if (path === "/api/login" && method === "POST") return apiLogin(env, request, data, ["kid", "parent", "teacher", "admin", "super_admin"]);
  if (path === "/api/admin/login" && method === "POST") return apiLogin(env, request, data, ADMIN_ROLES);
  if (path === "/api/logout" && method === "POST") return apiLogout(env, request);
  if (path === "/api/forgot-password" && method === "POST") return apiForgotPassword(env, request, data);
  if (path === "/api/reset-password" && method === "POST") return apiResetPassword(env, request, data);

  // billing + consent flows
  if (path === "/api/checkout" && method === "POST") return apiCheckout(env, request, data);
  if (path === "/api/checkout/session" && method === "POST") return apiCheckoutSession(env, request, data);
  if (path === "/api/consent/self" && method === "POST") return apiConsentSelf(env, request);
  if (path === "/api/consent/start" && method === "POST") return apiConsentStart(env, request, data);
  if (path === "/api/consent/confirm" && method === "POST") return apiConsentConfirm(env, request, data);
  if (path === "/api/consent/resend" && method === "POST") return apiConsentResend(env, request, data);

  // parent / teacher / district
  if (path === "/api/parent/add-kid" && method === "POST") return apiParentAddKid(env, request, data);
  if (path === "/api/teacher/upload-roster" && method === "POST") return apiUploadRoster(env, request, data);
  if (path === "/api/assignments" && method === "GET") return apiListAssignments(env, request);
  if (path === "/api/assignments/create" && method === "POST") return apiCreateAssignment(env, request, data);
  if (path === "/api/assignments/delete" && method === "POST") return apiDeleteAssignment(env, request, data);
  if (path === "/api/assignments/progress" && method === "GET") return apiAssignmentProgress(env, request);
  if (path === "/api/teacher/announce" && method === "POST") return apiTeacherAnnounce(env, request, data);
  if (path === "/api/teacher/concern" && method === "POST") return apiTeacherConcern(env, request, data);
  if (path === "/api/teacher/logout-pin" && method === "POST") return apiSetLogoutPin(env, request, data);
  if (path === "/api/teacher/retention" && method === "POST") return apiSetRetention(env, request, data);
  if (path === "/api/session/start" && method === "POST") return apiStartSession(env, request, data);
  if (path === "/api/session/end" && method === "POST") return apiEndSession(env, request);
  if (path === "/api/session/lock" && method === "POST") return apiLockSession(env, request, data);
  if (path === "/api/session/join" && method === "POST") return apiJoinSession(env, request, data);
  if (path === "/api/teacher/bulk" && method === "POST") return apiBulkStudents(env, request, data);
  if (path === "/api/kid/session-logout" && method === "POST") return apiKidSessionLogout(env, request, data);
  if (path === "/api/daily-reward" && method === "POST") return apiDailyReward(env, request);
  if (path === "/api/my-leaderboard" && method === "GET") return apiMyLeaderboard(env, request);
  if (path === "/api/recommend" && method === "POST") return apiRecommend(env, request, data);
  if (path === "/api/screen-limit" && method === "GET") return apiGetScreenLimit(env, request);
  if (path === "/api/screen-limit" && method === "POST") return apiSetScreenLimit(env, request, data);
  if (path === "/api/certificate/email" && method === "POST") return apiEmailCertificate(env, request, data);
  if (path.startsWith("/api/kidcard/") && method === "GET") return apiKidCard(env, decodeURIComponent(path.slice("/api/kidcard/".length)));
  if (path === "/api/my-card-token" && method === "GET") {
    const u = await userFromToken(env, bearer(request));
    if (!u || u.role !== "kid") return json({ error: "forbidden" }, 403);
    let tok = u.card_token;
    if (!tok) { tok = randToken(12); await env.DB.prepare("UPDATE users SET card_token=? WHERE id=?").bind(tok, u.id).run(); }
    return json({ cardToken: tok });
  }
  if (path === "/api/teacher/certificates/email-all" && method === "POST") return apiTeacherBulkCertificates(env, request);
  if (path === "/api/kid/help" && method === "POST") return apiKidHelp(env, request, data);
  if (path === "/api/parent/nudge" && method === "POST") return apiParentNudge(env, request, data);
  if (path === "/api/parent/signout-kid" && method === "POST") return apiParentSignoutKid(env, request, data);
  if (path === "/api/parent/delete-kid" && method === "POST") return apiParentDeleteKid(env, request, data);
  if (path === "/api/account/update" && method === "POST") return apiAccountUpdate(env, request, data);
  if (path === "/api/parent/update-kid" && method === "POST") return apiParentUpdateKid(env, request, data);
  if (path === "/api/district/schools" && method === "GET") return apiDistrictSchools(env, request);
  if (path === "/api/district/add-school" && method === "POST") return apiDistrictAddSchool(env, request, data);
  if (path === "/api/district/assign-school" && method === "POST") return apiDistrictAssignSchool(env, request, data);
  if (path === "/api/district/roster" && method === "GET") return apiDistrictRoster(env, request);
  if (path === "/api/district/remove-school" && method === "POST") return apiDistrictRemoveSchool(env, request, data);
  if (path === "/api/school/branding" && method === "POST") return apiSchoolBranding(env, request, data);
  if (path === "/api/school/student/suspend" && method === "POST") return apiSchoolSuspend(env, request, data);
  if (path === "/api/school/student/credentials" && method === "POST") return apiSchoolCredentials(env, request, data);
  if (path === "/api/teacher/new-code" && method === "POST") return apiTeacherNewCode(env, request);
  if (path === "/api/teacher/schedule" && method === "GET") return apiTeacherScheduleGet(env, request);
  if (path === "/api/teacher/schedule" && method === "POST") return apiTeacherScheduleSet(env, request, data);
  if (path === "/api/quiz/submit" && method === "POST") return apiQuizSubmit(env, request, data);
  if (path === "/api/quiz/config" && method === "GET") return apiQuizConfig(env);
  if (path === "/api/referral" && method === "GET") return apiReferral(env, request);
  if (path === "/api/admin/quiz" && method === "GET") return adminGetQuiz(env, request);
  if (path === "/api/admin/quiz" && method === "POST") return adminSetQuiz(env, request, data);
  if (path === "/api/admin/emails" && method === "GET") return adminEmails(env, request);
  if (path === "/api/admin/mass-email" && method === "POST") return adminMassEmail(env, request, data);

  // lessons / progress
  if (path === "/api/progress" && method === "POST") return apiProgressPost(env, request, data);
  if (path === "/api/lesson/count-attempt" && method === "POST") return apiCountAttempt(env, request, data);
  if (path === "/api/game/score" && method === "POST") return apiGameScore(env, request, data);
  if (path === "/api/test/submit" && method === "POST") return apiTestSubmit(env, request, data);
  if (path.startsWith("/api/test/") && method === "GET") return apiTestGet(env, request, parseInt(path.split("/").pop(), 10));
  if (path === "/api/quiz/answer" && method === "POST") return apiQuizAnswer(env, request, data);
  if (path === "/api/notices/dismiss" && method === "POST") return apiDismissNotice(env, request, data);

  // kid dashboard: shop / avatar / AI / upgrade / class join
  if (path === "/api/shop/buy" && method === "POST") return apiShopBuy(env, request, data);
  if (path === "/api/avatar" && method === "POST") return apiSaveAvatar(env, request, data);
  if (path === "/api/ai" && method === "POST") return apiAi(env, request, data);
  if (path === "/api/request-upgrade" && method === "POST") return apiRequestUpgrade(env, request);
  if (path === "/api/class/join" && method === "POST") return apiClassJoin(env, request, data);

  // gallery / projects / comments
  if (path === "/api/projects/save" && method === "POST") return apiProjectSave(env, request, data);
  if (path === "/api/projects/mine" && method === "GET") return apiProjectsMine(env, request);
  if (path === "/api/projects/delete" && method === "POST") return apiProjectDeleteOwn(env, request, data);

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
  if (path === "/api/admin/preview" && method === "POST") return apiAdminPreview(env, request, data);
  if (path === "/api/admin/impersonate" && method === "POST") return adminImpersonate(env, request, data);
  if (path === "/api/admin/settings" && method === "POST") return adminSaveSettings(env, request, data);
  if (path === "/api/admin/lesson" && method === "POST") return adminSaveLesson(env, request, data);
  if (path === "/api/admin/lesson/delete" && method === "POST") return adminDeleteLesson(env, request, data);

  if (path === "/api/contact" && method === "POST") {
    const cname = (data.name || "").trim().slice(0, 100);
    const cemail = (data.email || "").trim().slice(0, 200);
    const cmsg = (data.message || "").trim().slice(0, 2000);
    if (!cname || !cemail || !cmsg) return json({ error: "Name, email and message are required." }, 400);
    await notifyAdmin(env, `📬 Contact form: ${cname}`, `📬 *New contact form message!*\n• From: ${cname} (${cemail})\n• Message: ${cmsg}`);
    await sendEmail(env, "support@kidvibers.com", `Contact form: ${cname}`,
      `<p><strong>From:</strong> ${escHtml(cname)} (${escHtml(cemail)})</p><p><strong>Message:</strong></p><p>${escHtml(cmsg).replace(/\n/g,"<br>")}</p>`);
    return json({ ok: true });
  }

  // ── Leaderboard (top 10 by XP this week — logged-in users only) ──
  if (path === "/api/leaderboard" && method === "GET") {
    const viewer = await userFromToken(env, bearer(request));
    if (!viewer) return json({ leaderboard: [] });   // don't expose kids' names to anonymous visitors
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const rows = (await env.DB.prepare(
      "SELECT u.id, u.name, u.username, " +
      "COALESCE(SUM(l.xp),0) AS week_xp, COUNT(p.lesson_id) AS week_lessons " +
      "FROM users u " +
      "JOIN progress p ON p.user_id = u.id AND p.completed_at >= ? " +
      "JOIN lessons l ON l.id = p.lesson_id " +
      "WHERE u.role='kid' " +
      "GROUP BY u.id ORDER BY week_xp DESC LIMIT 10"
    ).bind(since).all()).results || [];
    return json({ leaderboard: rows, since });
  }

  // ── Report a lesson (content flag) — logged-in only, rate-limited ──
  if (path === "/api/report-lesson" && method === "POST") {
    const u = await userFromToken(env, bearer(request));
    if (!u) return json({ error: "Please log in to report." }, 401);
    if (rateLimited(`report-lesson:${u.id}`, 5, 3600)) return json({ ok: true });  // max 5/hr, silently drop extras
    const lessonId = (data.lessonId || "").trim().slice(0, 50);
    const reason = (data.reason || "").trim().slice(0, 500) || "No reason given";
    await notifyAdmin(env, `🚩 Lesson flagged: ${lessonId}`,
      `🚩 *Lesson content report*\nLesson: ${lessonId}\nFrom: @${u.username} (${u.role})\nReason: ${reason}`);
    return json({ ok: true });
  }

  // ── Gift Pro checkout ──
  if (path === "/api/gift/checkout" && method === "POST") {
    if (!stripeEnabled(env)) return json({ error: "Payments not configured." }, 503);
    const recipientEmail = (data.recipientEmail || "").trim().slice(0, 200);
    const senderName = cleanName(data.senderName || "A friend");
    const plan = ["pro","family"].includes(data.plan) ? data.plan : "pro";
    const priceId = stripePrices(env)[plan];
    if (!priceId) return json({ error: "Plan not available." }, 400);
    const origin = siteUrl(env, request);
    // Stripe's API is form-encoded — use bracket notation, not JSON strings.
    const params = {
      mode: "subscription",
      "line_items[0][price]": priceId, "line_items[0][quantity]": "1",
      success_url: `${origin}/gift.html?status=success&plan=${plan}`,
      cancel_url:  `${origin}/gift.html?status=cancel`,
      "metadata[gift]": "1", "metadata[plan]": plan, "metadata[senderName]": senderName,
    };
    if (recipientEmail) params.customer_email = recipientEmail;
    try {
      const session = await stripeRequest(env, "/checkout/sessions", params);
      if (!session || !session.url) return json({ error: "Could not create checkout session." }, 500);
      return json({ url: session.url });
    } catch (e) { console.log("gift checkout error:", e); return json({ error: "Could not start gift checkout." }, 502); }
  }

  // ── Parent weekly digest (manual trigger / test) ──
  if (path === "/api/admin/send-weekly-digest" && method === "POST") {
    const { err } = await requireRole(env, request, ["super_admin"]); if (err) return err;
    const sent = await runWeeklyDigest(env);
    return json({ ok: true, sent });
  }

  // ── Verifiable parental consent (COPPA) — parent clicks the email link ──
  if (path === "/api/consent/verify" && method === "POST") {
    const token = (data.token || "").trim();
    if (!token) return json({ error: "Missing token." }, 400);
    const kid = await env.DB.prepare("SELECT id,name,consent_by FROM users WHERE consent_token=? AND role='kid'").bind(token).first();
    if (!kid) return json({ error: "This approval link is invalid or has expired." }, 404);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    await env.DB.prepare("UPDATE users SET consent_status='granted', consent_method='verifiable_parent_confirm', consent_at=? WHERE id=?")
      .bind(nowIso(), kid.id).run();
    await logConsent(env, kid.id, kid.name, "verifiable_parent_confirm", kid.consent_by || "parent", `Parent confirmed via email link (IP ${ip})`);
    await notifyAdmin(env, `✅ Consent verified: ${kid.name}`, `✅ *Parent verified consent*\n• Kid: ${kid.name}\n• By: ${kid.consent_by || "parent"}\n• IP: ${ip}`);
    return json({ ok: true, name: kid.name });
  }

  // ── Weekly challenge claim (bonus tokens, once per week) ──
  if (path === "/api/challenge/claim" && method === "POST") {
    const u = await userFromToken(env, bearer(request));
    if (!u || u.role !== "kid") return json({ error: "Only kids can claim challenges." }, 403);
    if (u.isPreview) return json({ ok: true, tokens: 250, awarded: 0, alreadyClaimed: true });
    // week id = Monday's date, sent by client but recomputed for safety
    const now = new Date();
    const day = (now.getUTCDay() + 6) % 7;
    now.setUTCDate(now.getUTCDate() - day);
    const week = now.toISOString().slice(0, 10);
    const claimKey = `challenge:${u.id}:${week}`;
    const existing = await env.DB.prepare("SELECT 1 FROM settings WHERE key=?").bind(claimKey).first();
    if (existing) return json({ ok: true, alreadyClaimed: true });
    // Verify the kid actually completed 5+ lessons this week (anti-cheat).
    const since = week + "T00:00:00Z";
    const doneThisWeek = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=? AND completed_at>=?").bind(u.id, since).first()).c || 0;
    if (doneThisWeek < 5) return json({ error: `Complete 5 lessons this week first — you've done ${doneThisWeek}.`, need: 5, done: doneThisWeek }, 400);
    const BONUS = 200;
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)").bind(claimKey, nowIso()).run();
    await env.DB.prepare("UPDATE users SET tokens = COALESCE(tokens,0) + ? WHERE id=?").bind(BONUS, u.id).run();
    const tok = (await env.DB.prepare("SELECT tokens FROM users WHERE id=?").bind(u.id).first()).tokens;
    return json({ ok: true, awarded: BONUS, tokens: tok });
  }

  // ── School/district quote request (lead capture) ──
  if (path === "/api/school-quote" && method === "POST") {
    const qip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (rateLimited(`quote:${qip}`, 5, 3600)) return json({ error: "Too many requests — please try again later." }, 429);
    const name = cleanName(data.name || "").slice(0, 100);
    const email = (data.email || "").trim().slice(0, 200);
    const org = cleanName(data.org || "").slice(0, 150);
    const students = (data.students || "").toString().slice(0, 20);
    const role = cleanName(data.role || "").slice(0, 60);
    const msg = (data.message || "").trim().slice(0, 1500);
    if (!name || !email || !org) return json({ error: "Name, email and organization are required." }, 400);
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email." }, 400);
    await notifyAdmin(env, `🏫 School quote request: ${org}`,
      `🏫 *New school/district quote request!*\n• Contact: ${name} (${role || "?"})\n• Org: ${org}\n• Students: ${students || "?"}\n• Email: ${email}\n• Message: ${msg || "(none)"}`);
    await sendEmail(env, "support@kidvibers.com", `School quote: ${org}`,
      `<p><strong>${name}</strong> (${role}) from <strong>${org}</strong> wants a quote.</p>
       <p>Students: ${escHtml(students)}<br>Email: ${escHtml(email)}</p><p>Message:</p><p>${escHtml(msg).replace(/\n/g, "<br>")}</p>`);
    // Confirmation to the requester
    await sendEmail(env, email, "We got your KidVibers request 🚀",
      `<p>Hi ${name},</p><p>Thanks for your interest in KidVibers for <strong>${org}</strong>! We received your request and will get back to you within 1 business day with a quote and next steps.</p><p>— Elisha, KidVibers</p>`);
    return json({ ok: true });
  }

  // Unknown API route or method.
  return json({ error: "Not found." }, 404);
}

// Daily re-engagement: email parents of kids who haven't coded in a while.
async function runReengagement(env) {
  const now = Date.now();
  const since14 = new Date(now - 14 * 86400000).toISOString();
  const since7 = new Date(now - 7 * 86400000).toISOString();
  const nudgeCutoff = new Date(now - 14 * 86400000).toISOString(); // don't nudge more than once / 14 days
  // Kids: consent granted, have a parent email, last lesson between 7 and 30 days ago, not recently nudged.
  const kids = (await env.DB.prepare(
    "SELECT u.id,u.name,u.parent_email,u.plan, (SELECT MAX(completed_at) FROM progress WHERE user_id=u.id) AS last_active " +
    "FROM users u WHERE u.role='kid' AND u.consent_status='granted' AND u.parent_email IS NOT NULL AND u.parent_email != '' " +
    "AND (u.last_nudge IS NULL OR u.last_nudge < ?)"
  ).bind(nudgeCutoff).all()).results || [];
  let sent = 0;
  for (const k of kids) {
    if (!k.last_active) continue;                 // never started — skip (welcome flow covers them)
    if (k.last_active >= since7) continue;         // active in last 7 days — leave them alone
    if (k.last_active < new Date(now - 30 * 86400000).toISOString()) continue; // gone >30 days — skip
    const ok = await sendEmail(env, k.parent_email, `We miss ${k.name}! 👋 Ready for the next world?`,
      `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#222;line-height:1.6;">
        <div style="background:#7c3aed;color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;font-weight:800;font-size:1.2rem;">🚀 KidVibers</div>
        <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
          <p style="font-size:1.05rem;">Hi! <strong>${k.name}</strong> hasn't coded on KidVibers in a little while — there's a whole new world waiting. 🗺️</p>
          <p style="color:#444;">Just 10 minutes keeps their streak alive and their skills growing.</p>
          <p><a href="https://kidvibers.com/dashboard.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;">Jump back in →</a></p>
          <p style="margin-top:20px;color:#888;font-size:0.85rem;">— The KidVibers Team · <a href="https://kidvibers.com" style="color:#7c3aed;">kidvibers.com</a><br>Don't want these? Just reply and we'll stop.</p>
        </div></div>`,
      "KidVibers <support@kidvibers.com>");
    if (ok) { sent++; await env.DB.prepare("UPDATE users SET last_nudge=? WHERE id=?").bind(nowIso(), k.id).run(); }
  }
  if (sent) await sendSlack(env, `📨 Re-engagement run: nudged ${sent} parent(s).`);
  return sent;
}

// Weekly parent digest: every Monday, send parents a summary of their kid's week.
async function runWeeklyDigest(env) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const parents = (await env.DB.prepare(
    "SELECT u.id, u.name, u.username, u.parent_email, u.family_id FROM users u " +
    "WHERE u.role='parent' AND u.parent_email IS NOT NULL AND u.parent_email != ''"
  ).all()).results || [];
  let sent = 0;
  for (const p of parents) {
    const kids = (await env.DB.prepare("SELECT * FROM users WHERE role='kid' AND family_id=?").bind(p.family_id).all()).results || [];
    if (!kids.length) continue;
    let anyActive = false;
    let kidsHtml = "";
    for (const k of kids) {
      const lessonsThisWeek = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=? AND completed_at>=?").bind(k.id, since).first()).c || 0;
      const totalLessons = (await env.DB.prepare("SELECT COUNT(*) c FROM progress WHERE user_id=?").bind(k.id).first()).c || 0;
      const worldsCleared = (await env.DB.prepare("SELECT COUNT(*) c FROM unit_tests WHERE user_id=? AND passed=1").bind(k.id).first()).c || 0;
      const xpRow = await env.DB.prepare("SELECT COALESCE(SUM(l.xp),0) xp FROM progress p JOIN lessons l ON l.id=p.lesson_id WHERE p.user_id=?").bind(k.id).first();
      const xp = xpRow ? xpRow.xp : 0;
      if (lessonsThisWeek > 0) anyActive = true;
      // Highlight: worlds conquered THIS week (a real milestone worth celebrating in the email).
      const wonThisWeek = (await env.DB.prepare("SELECT unit FROM unit_tests WHERE user_id=? AND passed=1 AND updated_at>=? ORDER BY unit").bind(k.id, since).all()).results || [];
      const wonNames = wonThisWeek.map(w => { const wd = WORLDS[w.unit] || {}; return `${wd.emoji || "🏆"} ${wd.name || ("World " + w.unit)}`; });
      const highlight = wonNames.length
        ? `<div style="background:linear-gradient(135deg,#f3e8ff,#fce7f3);border:1px solid #e9d5ff;border-radius:10px;padding:11px 14px;margin:10px 0 4px;font-weight:800;color:#6d28d9;">🎉 Conquered ${wonNames.length === 1 ? "a new world" : wonNames.length + " new worlds"} this week: ${wonNames.join(", ")}!</div>`
        : (lessonsThisWeek === 0 ? `<div style="color:#999;font-size:0.86rem;margin:8px 0 4px;">😴 Quiet week — a little nudge from you goes a long way!</div>` : "");
      kidsHtml += `<div style="background:#f9f7ff;border:1px solid #ede9fe;border-radius:12px;padding:16px 20px;margin-bottom:12px;">
        <div style="font-weight:900;font-size:1.05rem;color:#6d28d9;">${k.name}</div>
        ${highlight}
        <table style="width:100%;margin-top:8px;">
          <tr><td style="color:#555;font-size:0.9rem;">📚 Lessons this week</td><td style="font-weight:800;text-align:right;">${lessonsThisWeek}</td></tr>
          <tr><td style="color:#555;font-size:0.9rem;">🏆 Total lessons done</td><td style="font-weight:800;text-align:right;">${totalLessons}</td></tr>
          <tr><td style="color:#555;font-size:0.9rem;">🌍 Worlds cleared</td><td style="font-weight:800;text-align:right;">${worldsCleared}</td></tr>
          <tr><td style="color:#555;font-size:0.9rem;">⚡ Total XP</td><td style="font-weight:800;text-align:right;">${xp}</td></tr>
        </table>
      </div>`;
    }
    if (!anyActive) continue; // only send if at least one kid coded this week
    const subject = kids.length === 1 ? `${kids[0].name}'s KidVibers week in review 📊` : `Your kids' KidVibers week in review 📊`;
    const ok = await sendEmail(env, p.parent_email, subject,
      `<p style="font-size:1.05rem;">Hi <strong>${p.name}</strong>! Here's what happened on KidVibers this week:</p>
       ${kidsHtml}
       <p><a href="https://kidvibers.com/parent.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:700;">View full progress →</a></p>
       <p style="color:#888;font-size:0.85rem;margin-top:16px;">Keep encouraging them — every lesson counts! 🚀</p>`);
    if (ok) sent++;
  }
  return sent;
}

// Annual-plan renewal reminder — emails the account holder ~7 days before their yearly
// subscription renews, so nobody is surprised by the charge. Only fires once per renewal
// (guarded by only sending when renews_at is 6-7 days out, cron runs daily).
async function runRenewalReminders(env) {
  try {
    const lo = new Date(Date.now() + 6 * 86400000).toISOString();
    const hi = new Date(Date.now() + 7 * 86400000).toISOString();
    const rows = (await env.DB.prepare(
      "SELECT id,name,parent_email,plan,plan_renews_at FROM users WHERE plan_interval='year' AND plan_renews_at IS NOT NULL AND plan_renews_at BETWEEN ? AND ? AND stripe_subscription_id IS NOT NULL"
    ).bind(lo, hi).all()).results || [];
    let sent = 0;
    for (const r of rows) {
      if (!r.parent_email) continue;
      const when = (r.plan_renews_at || "").slice(0, 10);
      const ok = await sendEmail(env, r.parent_email, `Your KidVibers ${r.plan} plan renews soon`,
        `<p>Hi <strong>${r.name}</strong>! Just a heads up — your annual <strong>${r.plan}</strong> plan renews on <strong>${when}</strong>.</p>
         <p>No action needed if you'd like to keep it. To make changes, visit your account settings.</p>
         <p style="color:#888;font-size:0.85rem;margin-top:16px;">Questions? Reply to this email or reach us at support@kidvibers.com</p>`);
      if (ok) sent++;
    }
    return sent;
  } catch { return 0; }
}

// Daily push reminder to kids who opted in and haven't coded today.
// Fully guarded — a no-op (and never throws) unless VAPID keys are configured.
async function runPushReminders(env) {
  try {
    if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return 0;
    const subs = (await env.DB.prepare("SELECT ps.endpoint, ps.p256dh, ps.auth, ps.user_id FROM push_subs ps").all()).results || [];
    let sent = 0;
    for (const s of subs) {
      try {
        // Skip if the kid already did a lesson today
        const usedToday = await lessonsUsedToday(env, s.user_id);
        if (usedToday > 0) continue;
        const res = await sendWebPush(env, s);
        if (res === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(s.endpoint).run();
        else if (res === true) sent++;
      } catch {}
    }
    return sent;
  } catch { return 0; }
}

// Minimal VAPID web push (payloadless "tickle" — the SW shows the default reminder).
async function sendWebPush(env, sub) {
  try {
    const url = new URL(sub.endpoint);
    const aud = url.origin;
    const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const enc = new TextEncoder();
    const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const payload = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: "mailto:support@kidvibers.com" })));
    const unsigned = `${header}.${payload}`;
    // Import the private key (PKCS8 base64url in VAPID_PRIVATE_KEY)
    const pkcs8 = Uint8Array.from(atob(env.VAPID_PRIVATE_KEY.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
    const jwt = `${unsigned}.${b64u(sig)}`;
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: { TTL: "86400", Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}` },
    });
    if (res.status === 404 || res.status === 410) return 410;
    return res.ok;
  } catch { return false; }
}

export default {
  async scheduled(event, env, ctx) {
    const now = new Date();
    // Run weekly digest on Mondays (day 1), re-engagement every day.
    if (now.getUTCDay() === 1) ctx.waitUntil(runWeeklyDigest(env));
    ctx.waitUntil(runReengagement(env));
    ctx.waitUntil(runPushReminders(env));
    ctx.waitUntil(runRenewalReminders(env));
    // Housekeeping: drop expired session rows (userFromToken already rejects them).
    ctx.waitUntil((async () => {
      try {
        const cutoff = new Date(Date.now() - SESSION_MAX_DAYS * 86400000).toISOString();
        await env.DB.prepare("DELETE FROM sessions WHERE created_at < ?").bind(cutoff).run();
      } catch {}
    })());
    // Housekeeping: purge short-lived bookkeeping keys from the settings table so it
    // doesn't grow forever. quizok markers only matter between quiz + completion (keep 7d);
    // quizfail counters are day-scoped (keep 2d); challenge claims are week-scoped (keep 90d).
    ctx.waitUntil((async () => {
      try {
        const d = (days) => new Date(Date.now() - days * 86400000).toISOString();
        await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'quizok:%' AND value < ?").bind(d(7)).run();
        await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'quizfail:%' AND substr(key,-10) < ?").bind(d(2).slice(0, 10)).run();
        await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'challenge:%' AND substr(key,-10) < ?").bind(d(90).slice(0, 10)).run();
        await env.DB.prepare("DELETE FROM lessons_daily WHERE day LIKE '%-fail:%' AND substr(day,1,10) < ?").bind(d(7).slice(0, 10)).run();
        // School-set data retention: delete students inactive longer than the school's chosen
        // window (last completed lesson, or account age if they never started).
        const retRows = (await env.DB.prepare("SELECT key,value FROM settings WHERE key LIKE 'retention:%'").all()).results || [];
        for (const r of retRows) {
          const months = parseInt(r.value, 10) || 0; if (!months) continue;
          const famId = parseInt(r.key.split(":")[1], 10); if (!famId) continue;
          const cutoff = new Date(Date.now() - months * 30 * 86400000).toISOString();
          const kids = (await env.DB.prepare(
            "SELECT id FROM users WHERE role='kid' AND family_id=? AND COALESCE((SELECT MAX(completed_at) FROM progress WHERE user_id=users.id), created_at) < ?"
          ).bind(famId, cutoff).all()).results || [];
          for (const k of kids) {
            for (const sql of ["DELETE FROM progress WHERE user_id=?","DELETE FROM unit_tests WHERE user_id=?","DELETE FROM sessions WHERE user_id=?","DELETE FROM chat_usage WHERE user_id=?","DELETE FROM notices WHERE user_id=?","DELETE FROM users WHERE id=?"])
              await env.DB.prepare(sql).bind(k.id).run();
          }
        }
        // Clean up finished library-session guest accounts (and their data + markers).
        const guestCutoff = new Date(Date.now() - 24 * 3600000).toISOString();  // grace period after session ends
        const guests = (await env.DB.prepare("SELECT id FROM users WHERE role='kid' AND consent_method='library_session' AND created_at < ?").bind(guestCutoff).all()).results || [];
        for (const g of guests) {
          for (const sql of ["DELETE FROM progress WHERE user_id=?","DELETE FROM unit_tests WHERE user_id=?","DELETE FROM sessions WHERE user_id=?","DELETE FROM chat_usage WHERE user_id=?","DELETE FROM notices WHERE user_id=?","DELETE FROM settings WHERE key=?","DELETE FROM users WHERE id=?"])
            await env.DB.prepare(sql).bind(sql.includes("settings") ? `sessionguest:${g.id}` : g.id).run();
        }
      } catch {}
    })());
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Canonical host: send www.kidvibers.com -> kidvibers.com (301). All canonical tags,
    // the sitemap, and robots.txt use the bare apex, so this avoids duplicate-content for SEO.
    if (url.hostname === "www.kidvibers.com") {
      url.hostname = "kidvibers.com";
      return Response.redirect(url.toString(), 301);
    }

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
    // Resend webhook (bounces, complaints, inbound mail) - needs the RAW body for signature checking.
    if (url.pathname === "/api/events" && request.method === "POST") {
      try { return await apiResendWebhook(env, await request.text(), request.headers); }
      catch (e) { console.log("resend webhook error:", e && e.stack || e); return json({ error: "error" }, 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(env, request, url.pathname); }
      catch (e) {
        console.log("api error:", e && e.stack || e);
        // Error monitoring: email the admin about unhandled 500s (max 5/hr so a hot bug
        // can't email-storm; the alert includes the route + stack to fix it fast).
        if (!rateLimited("err-alert", 5, 3600)) {
          ctx.waitUntil(notifyAdmin(env, `🔥 API error: ${url.pathname}`,
            `🔥 *Unhandled API error*\n• Route: ${request.method} ${url.pathname}\n• Error: ${(e && e.message) || e}\n• Stack: ${((e && e.stack) || "").slice(0, 800)}`).catch(() => {}));
        }
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }
    // Static pages: serve from assets, but add our security headers so EVERY response
    // (HTML included) carries anti-clickjacking, no-sniff, referrer, and HSTS protection.
    const assetRes = await env.ASSETS.fetch(request);
    const out = new Response(assetRes.body, assetRes);
    for (const k in SECURITY_HEADERS) out.headers.set(k, SECURITY_HEADERS[k]);
    // Never let the browser cache HTML pages, so a normal refresh always loads the
    // latest version (no private tab / hard-refresh needed). Versioned CSS/JS (?v=NN)
    // keep their own caching since their URL changes whenever they change.
    if ((out.headers.get("content-type") || "").includes("text/html")) {
      out.headers.set("Cache-Control", "no-store, must-revalidate");
    }
    return out;
  },
};
