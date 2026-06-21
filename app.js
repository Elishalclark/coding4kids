// Mobile nav
const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger.addEventListener('click', () => mobileMenu.classList.toggle('open'));

// Close mobile menu on link click
mobileMenu.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => mobileMenu.classList.remove('open'));
});

// ── Signup (real backend account) ──
// Load launch-offer slot count and show the banner if spots remain.
async function loadLaunchBanner() {
  try {
    const r = await fetch('/api/launch-slots'); if (!r.ok) return;
    const d = await r.json();
    const banner = document.getElementById('launchBanner');
    const sub = document.getElementById('signupSubtitle');
    if (!banner) return;
    if (d.active && d.remaining > 0) {
      document.getElementById('launchSlotsLeft').textContent = d.remaining;
      banner.style.display = '';
      if (sub) sub.innerHTML = 'Sign up now to claim your <strong>free 30-day Pro</strong> — AI buddy, all lessons, boss battles. No credit card.';
    }
  } catch(e) {}
}
if (document.getElementById('launchBanner')) loadLaunchBanner();

async function handleSignup(e) {
  e.preventDefault();
  const success = document.getElementById('signupSuccess');
  const payload = {
    name: document.getElementById('suName').value.trim(),
    parentEmail: document.getElementById('suEmail').value.trim(),
    username: document.getElementById('suUsername').value.trim(),
    password: document.getElementById('suPassword').value,
    age: document.getElementById('suAgeYears').value
  };
  const { ok, data } = await C4K.signup(payload);
  success.classList.remove('hidden');
  if (ok) {
    success.style.background = data.launchPro ? 'rgba(22,163,74,0.35)' : 'rgba(255,255,255,0.2)';
    success.innerHTML = data.launchPro
      ? `🎉 You got it, ${C4K.esc(data.user.name)}! <strong>30 days of Pro free</strong> — unlocked! ${data.slotsRemaining} spots left for others.`
      : `🎉 Welcome, ${C4K.esc(data.user.name)}!`;
    document.getElementById('signupForm').reset();
    // Refresh the banner slot count
    loadLaunchBanner();
    startQuiz(data, payload.parentEmail);
  } else {
    success.style.background = 'rgba(239,68,68,0.25)';
    success.textContent = '⚠️ ' + (data.error || "Can't reach the server right now - please try again in a moment.");
  }
  success.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Sign in with Google (parents & teachers) ──
const GOOGLE_CLIENT_ID = '87477869793-p2hdd1f1uiotun36bs67amhnil7apk87.apps.googleusercontent.com';
let googleInited = false;
function initGoogle() {
  if (googleInited || typeof google === 'undefined' || !google.accounts || !google.accounts.id) return;
  googleInited = true;
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleSignIn });
}
function renderGoogleBtn() {
  initGoogle();
  const el = document.getElementById('googleBtn');
  if (!el || !googleInited) { setTimeout(renderGoogleBtn, 400); return; }   // wait for the GIS library to load
  el.innerHTML = '';
  google.accounts.id.renderButton(el, { theme: 'filled_blue', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
}
async function onGoogleSignIn(response) {
  const err = document.getElementById('loginError');
  if (err) { err.style.color = '#bdb6d6'; err.textContent = 'Signing in with Google…'; }
  const { ok, data } = await C4K.api('/api/auth/google', 'POST', { credential: response.credential });
  if (!ok) { if (err) { err.style.color = '#f87171'; err.textContent = '❌ ' + (data.error || 'Google sign-in failed.'); } return; }
  C4K.setToken(data.token); C4K.user = data.user;
  closeLogin();
  window.location.href = C4K.homeFor(data.user);
}

// ── Login modal (one login for everyone - role is detected from the account) ──
function openLogin() {
  document.getElementById('loginModal').classList.remove('hidden');
  document.getElementById('loginError').textContent = '';
  renderGoogleBtn();
  if (window.__siteConfig && window.__siteConfig.loginsEnabled === false) {
    document.getElementById('loginError').textContent = '⏸️ Logins are temporarily paused - please check back soon. (Admins can still sign in.)';
  }
  document.getElementById('loginUsername').focus();
}
function closeLogin() { document.getElementById('loginModal').classList.add('hidden'); closeForgot(); }

// ── Forgot password (parents & teachers) ──
function openForgot() {
  document.querySelector('#loginModal form').style.display = 'none';
  document.getElementById('forgotLine').style.display = 'none';
  document.getElementById('loginFootnote').style.display = 'none';
  document.getElementById('forgotBox').style.display = '';
  document.getElementById('forgotMsg').textContent = '';
  document.getElementById('forgotWho').focus();
}
function closeForgot() {
  const box = document.getElementById('forgotBox'); if (!box) return;
  box.style.display = 'none';
  document.querySelector('#loginModal form').style.display = '';
  document.getElementById('forgotLine').style.display = '';
  document.getElementById('loginFootnote').style.display = '';
}
async function submitForgot() {
  const who = document.getElementById('forgotWho').value.trim();
  const msg = document.getElementById('forgotMsg');
  if (!who) { msg.style.color = '#f87171'; msg.textContent = 'Enter your username or email.'; return; }
  document.getElementById('forgotBtn').disabled = true;
  const { data } = await C4K.api('/api/forgot-password', 'POST', { usernameOrEmail: who });
  msg.style.color = 'var(--green, #5ad17e)';
  msg.textContent = (data && data.message) || "If an account matches, we've emailed a reset link. Check your inbox (and spam).";
  document.getElementById('forgotBtn').disabled = false;
}

async function handleLogin(e) {
  e.preventDefault();
  const u = document.getElementById('loginUsername').value.trim();
  const p = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginSubmitBtn');
  if (btn) { btn.disabled = true; }
  // One login for everyone - the server figures out the role from the account.
  const { ok, data } = await C4K.login(u, p);
  if (btn) { btn.disabled = false; }
  if (!ok) {
    document.getElementById('loginError').textContent = '❌ ' + (data.error || "Can't reach the server - try again in a moment.");
    return;
  }
  closeLogin();
  // Send them to the right place based on their actual account type.
  window.location.href = C4K.homeFor(data.user);
}

// ── Parent signup ──
// ── Parental consent (COPPA) ──
function closeConsent() { document.getElementById('consentModal').classList.add('hidden'); location.hash = ''; }

async function openConsent(token) {
  const body = document.getElementById('consentBody');
  document.getElementById('consentModal').classList.remove('hidden');
  const { ok, data } = await C4K.api('/api/consent/' + token);
  if (!ok) { body.innerHTML = `<p style="color:#f87171;">${data.error || 'This consent link is invalid or already used.'}</p>`; return; }
  body.innerHTML = `
    <p style="color:var(--text-dim);font-size:0.92rem;line-height:1.6;">
      <strong>${data.childName}</strong> (age ${data.ageYears || 'under 13'}) wants to use KidVibers.
      As a parent/guardian, please review and approve.</p>
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px 0;font-size:0.85rem;color:var(--text-dim);">
      We collect only: a first name, username, age, your email, and learning progress.
      No ads, no selling data, no private messaging. You can review or delete this data anytime.</div>
    <label style="display:flex;gap:10px;align-items:flex-start;font-size:0.9rem;font-weight:700;margin-bottom:14px;">
      <input type="checkbox" id="consentAgree" onchange="document.getElementById('consentGo').disabled=!this.checked" style="margin-top:3px;">
      I am ${data.childName}'s parent or legal guardian and I consent to the collection described above.</label>
    <button class="btn btn-primary btn-lg btn-full" id="consentGo" disabled onclick="consentStep1('${token}')">Give consent</button>`;
}

async function consentStep1(token) {
  const { ok, data } = await C4K.api('/api/consent/start', 'POST', { token });
  const body = document.getElementById('consentBody');
  if (!ok) { body.innerHTML = `<p style="color:#f87171;">${data.error || 'Could not start.'}</p>`; return; }
  renderConsentIdForm(data.confirmToken, data.childName || 'your child');
}

// Step 2 - verifiable parental consent: confirm the parent's identity (name + card last-4 +
// a sworn attestation). We never charge the card; only the last 4 digits are kept.
function renderConsentIdForm(token, childName) {
  const body = document.getElementById('consentBody');
  body.innerHTML = `
    <div style="text-align:center;margin-bottom:8px;"><div style="font-size:2.2rem;">🛡️</div>
      <h3 style="font-weight:900;margin:6px 0;">Verify you're the parent</h3></div>
    <p style="color:var(--text-dim);font-size:0.88rem;line-height:1.55;margin-bottom:14px;">
      To approve <strong>${childName}</strong>, please confirm your identity. We <strong>never charge your card</strong> -
      we only keep the last 4 digits to verify a grown-up is approving.</p>
    <label style="display:block;font-weight:800;font-size:0.82rem;margin-bottom:4px;">Parent/guardian full legal name</label>
    <input id="cName" class="form-input" placeholder="e.g. Alex Johnson" style="width:100%;box-sizing:border-box;margin-bottom:12px;" oninput="consentValid()">
    <label style="display:block;font-weight:800;font-size:0.82rem;margin-bottom:4px;">Last 4 digits of your payment card</label>
    <input id="cCard" class="form-input" inputmode="numeric" maxlength="4" placeholder="1234" style="width:100%;box-sizing:border-box;margin-bottom:12px;" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,4);consentValid()">
    <label style="display:flex;gap:10px;align-items:flex-start;font-size:0.88rem;font-weight:700;margin-bottom:14px;">
      <input type="checkbox" id="cAttest" onchange="consentValid()" style="margin-top:3px;">
      I am ${childName}'s parent or legal guardian, I am over 18, and I consent to this account.</label>
    <button class="btn btn-primary btn-lg btn-full" id="cGo" disabled onclick="consentConfirm('${token}')">Verify &amp; approve</button>
    <div id="cMsg" style="color:#f87171;font-size:0.82rem;font-weight:700;margin-top:8px;min-height:1em;text-align:center;"></div>`;
}

function consentValid() {
  const name = (document.getElementById('cName').value || '').trim();
  const card = (document.getElementById('cCard').value || '').trim();
  const attest = document.getElementById('cAttest').checked;
  document.getElementById('cGo').disabled = !(name.length >= 2 && /^\d{4}$/.test(card) && attest);
}

async function consentConfirm(token) {
  const body = document.getElementById('consentBody');
  const msg = document.getElementById('cMsg');
  const payload = {
    token,
    parentName: (document.getElementById('cName') || {}).value || '',
    cardLast4: (document.getElementById('cCard') || {}).value || '',
    attest: !!(document.getElementById('cAttest') || {}).checked,
  };
  if (msg) msg.textContent = '';
  const { ok, data } = await C4K.api('/api/consent/confirm', 'POST', payload);
  if (!ok) { if (msg) msg.textContent = data.error || 'Could not confirm.'; return; }
  body.innerHTML = `<div style="text-align:center;"><div style="font-size:2.6rem;">✅</div>
       <h3 style="font-weight:900;margin:8px 0;">Consent confirmed!</h3>
       <p style="color:var(--text-dim);">${data.childName} can now use KidVibers. Thank you! 🎉</p>
       <button class="btn btn-primary" style="margin-top:14px;" onclick="closeConsent()">Done</button></div>`;
}

// ── Pricing popup (the only place pricing appears) ──
function openPricing() {
  const body = document.getElementById('pricingBody');
  if (body) body.innerHTML = C4K.pricingHTML({ buy: true });
  document.getElementById('pricingModal').classList.remove('hidden');
}
function closePricing() { document.getElementById('pricingModal').classList.add('hidden'); }
document.getElementById('pricingModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'pricingModal') closePricing();
});

// ── Placement quiz (after a kid signs up) ──
// IMPORTANT: option order must match recommend_from_quiz() in server.py.
const QUIZ_QUESTIONS = [
  { q: '🎂 How old are you?', opts: ['6 to 8', '9 to 11', '12 to 14', '15 or older'] },
  { q: '💡 Have you coded before?', opts: ['Never tried it', 'A little (Scratch/blocks)', 'Some Python or similar', 'Yes, I build things'] },
  { q: '🚀 What do you most want to make?', opts: ['🎮 Games', '🌐 Websites', '🎨 Art & stories', '🤖 Smart AI stuff'] },
  { q: '⏰ How much will you practice?', opts: ['Here and there', 'About 15 min most days', 'I want to go deep daily'] },
  { q: '🤝 Want an AI buddy to explain things & give hints?', opts: ['Yes please!', 'Maybe later', 'I like figuring it out myself'] },
  { q: '👨‍👩‍👧 Is it just you, or will siblings learn too?', opts: ['Just me', 'Me + my brothers/sisters'] },
];
let quizState = null;

function startQuiz(data, parentEmail) {
  quizState = { data, parentEmail, i: 0, answers: [] };
  document.getElementById('quizModal').classList.remove('hidden');
  renderQuiz();
}

function renderQuiz() {
  const total = QUIZ_QUESTIONS.length;
  const i = quizState.i;
  document.getElementById('quizBar').style.width = Math.round((i / total) * 100) + '%';
  const Q = QUIZ_QUESTIONS[i];
  const body = document.getElementById('quizBody');
  body.innerHTML =
    `<div style="font-size:0.78rem;font-weight:800;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">Question ${i + 1} of ${total}</div>` +
    `<h3 style="font-size:1.15rem;font-weight:900;margin-bottom:16px;">${C4K.esc(Q.q)}</h3>` +
    `<div style="display:flex;flex-direction:column;gap:10px;">` +
    Q.opts.map((o, idx) =>
      `<button class="btn btn-outline" style="justify-content:flex-start;text-align:left;font-weight:800;padding:13px 16px;" onclick="answerQuiz(${idx})">${C4K.esc(o)}</button>`
    ).join('') + `</div>`;
}

async function answerQuiz(idx) {
  quizState.answers.push(idx);
  quizState.i++;
  if (quizState.i < QUIZ_QUESTIONS.length) { renderQuiz(); return; }
  // Finished - score it on the server (also saves the result to the account).
  document.getElementById('quizBar').style.width = '100%';
  document.getElementById('quizBody').innerHTML =
    '<div style="text-align:center;padding:24px 0;"><div style="font-size:2.4rem;">🧮</div>' +
    '<p style="color:var(--text-dim);margin-top:8px;">Finding your perfect path...</p></div>';
  const { ok, data } = await C4K.api('/api/quiz/submit', 'POST', { answers: quizState.answers });
  if (!ok) { skipQuiz(); return; }   // never block signup if scoring hiccups
  showQuizResult(data.recommendation);
}

function showQuizResult(rec) {
  const body = document.getElementById('quizBody');
  body.innerHTML =
    `<div style="text-align:center;">` +
      `<div style="font-size:2.8rem;">🎉</div>` +
      `<h3 style="font-size:1.35rem;font-weight:900;margin:6px 0;">${C4K.esc(rec.title)}</h3>` +
      `<p style="color:var(--text-dim);line-height:1.55;margin-bottom:14px;">${C4K.esc(rec.blurb)}</p>` +
      `<div style="background:var(--surface-2);border:1px solid var(--border-bright);border-radius:14px;padding:16px;text-align:left;margin-bottom:8px;">` +
        `<div style="font-size:0.72rem;font-weight:800;color:var(--text-faint);text-transform:uppercase;">Best plan for you</div>` +
        `<div style="font-size:1.3rem;font-weight:900;color:var(--purple);margin:2px 0 6px;">${C4K.esc(rec.planLabel)} Plan</div>` +
        `<p style="font-size:0.86rem;color:var(--text-dim);line-height:1.5;">${C4K.esc(rec.planBlurb)}</p>` +
      `</div>` +
      `<div style="font-size:0.85rem;color:var(--text-dim);margin:10px 0 16px;">🧭 Starting world: <strong>${C4K.esc(rec.startWorld)}</strong>` +
        (rec.bonusWorld ? `<br>🎁 Bonus track: <strong>${C4K.esc(rec.bonusWorld)}</strong>` : '') + `</div>` +
      `<div style="display:flex;flex-direction:column;gap:8px;">` +
        (rec.plan !== 'free'
          ? `<button class="btn btn-primary btn-full" onclick="quizSeePlans()">See the ${C4K.esc(rec.planLabel)} plan</button>`
          : '') +
        `<button class="btn ${rec.plan === 'free' ? 'btn-primary' : 'btn-outline'} btn-full" onclick="finishQuiz()">Start learning free →</button>` +
      `</div>` +
    `</div>`;
}

function quizSeePlans() { finishQuiz(); setTimeout(openPricing, 350); }
function skipQuiz() { showQuizResult({ title: "You're all set!", blurb: 'We saved your spot - jump in whenever you like.', planLabel: 'Free', planBlurb: PLAN_FALLBACK, plan: 'free', startWorld: 'Greenwood Basics', bonusWorld: '' }); }
const PLAN_FALLBACK = 'Start free with starter lessons, badges and the avatar shop. Upgrade any time.';
function finishQuiz() {
  document.getElementById('quizModal').classList.add('hidden');
  showInvite(quizState.data, quizState.parentEmail);   // continue to the parent-consent invite
}

// ── Parent invite (QR + on-device approval) shown after a kid signs up ──
let pendingConsentToken = null;
function showInvite(data, parentEmail) {
  const url = data.inviteUrl || (location.origin + '/index.html?plink=' + data.inviteToken);
  document.getElementById('inviteQr').src =
    'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(url);
  document.getElementById('inviteEmail').textContent = parentEmail || 'your parent';
  document.getElementById('inviteKid').textContent = data.user.name;
  document.getElementById('inviteEmailBtn').href = url;
  // Under-13: offer immediate on-device parent approval (works even if no email is sent).
  pendingConsentToken = data.consentToken || null;
  const block = document.getElementById('inviteApproveBlock');
  if (block) block.style.display = (data.needsConsent && pendingConsentToken) ? '' : 'none';
  document.getElementById('inviteModal').classList.remove('hidden');
}
function approveOnDevice() {
  if (!pendingConsentToken) return;
  document.getElementById('inviteModal').classList.add('hidden');
  openConsent(pendingConsentToken);
}
function finishInvite() { window.location.href = 'dashboard.html'; }

let parentLinkToken = null;
async function openParentSignup(linkToken) {
  parentLinkToken = (typeof linkToken === 'string') ? linkToken : null;
  document.getElementById('parentModal').classList.remove('hidden');
  document.getElementById('parentError').textContent = '';
  const note = document.getElementById('parentLinkNote');
  if (note) {
    if (parentLinkToken) {
      note.classList.remove('hidden');
      note.textContent = 'Connecting to your child…';
      const r = await C4K.api('/api/invite/' + parentLinkToken);
      note.innerHTML = r.ok ? `🔗 You'll be connected to <strong>${r.data.childName}</strong>'s account.` : '';
    } else { note.classList.add('hidden'); note.textContent = ''; }
  }
  document.getElementById('pName').focus();
}
function closeParentSignup() { document.getElementById('parentModal').classList.add('hidden'); }
async function handleParentSignup(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('pName').value.trim(),
    email: document.getElementById('pEmail').value.trim(),
    username: document.getElementById('pUsername').value.trim(),
    password: document.getElementById('pPassword').value,
    linkToken: parentLinkToken || undefined
  };
  const { ok, data } = await C4K.parentSignup(payload);
  if (ok) { closeParentSignup(); window.location.href = 'parent.html'; }
  else document.getElementById('parentError').textContent = '❌ ' + (data.error || 'Could not create account.');
}
document.getElementById('parentModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'parentModal') closeParentSignup();
});

// ── Teacher (classroom) signup ──
function openTeacherSignup() {
  document.getElementById('teacherModal').classList.remove('hidden');
  document.getElementById('teacherError').textContent = '';
  document.getElementById('tName').focus();
}
function closeTeacherSignup() { document.getElementById('teacherModal').classList.add('hidden'); }
async function handleTeacherSignup(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('tName').value.trim(),
    school: document.getElementById('tSchool').value.trim(),
    email: document.getElementById('tEmail').value.trim(),
    username: document.getElementById('tUsername').value.trim(),
    password: document.getElementById('tPassword').value
  };
  const { ok, data } = await C4K.teacherSignup(payload);
  if (ok) { closeTeacherSignup(); window.location.href = 'parent.html'; }
  else document.getElementById('teacherError').textContent = '❌ ' + (data.error || 'Could not create classroom.');
}
document.getElementById('teacherModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'teacherModal') closeTeacherSignup();
});

// ── School signup (pay before you can add students) ──
const SCHOOL_PLAN_INFO = {
  school:   { label: 'School Plan',   price: '$136/mo', cap: 'up to 550 students' },
  district: { label: 'District Plan', price: '$150/mo', cap: 'unlimited students' },
};
function setSchoolPlan(plan) {
  if (!SCHOOL_PLAN_INFO[plan]) plan = 'school';
  document.getElementById('scPlan').value = plan;
  document.querySelectorAll('#schoolModal .plan-pick').forEach(b => {
    const on = b.dataset.plan === plan;
    b.classList.toggle('active', on);
    b.style.borderColor = on ? 'var(--purple, #7c3aed)' : 'var(--border)';
    b.style.boxShadow = on ? '0 0 0 2px var(--purple, #7c3aed) inset' : 'none';
  });
  const info = SCHOOL_PLAN_INFO[plan];
  const note = document.getElementById('schoolPlanNote');
  if (note) note.innerHTML = `💳 Next step is payment - your <strong>${info.label}</strong> (${info.price}, ${info.cap}) activates after checkout, then you can manage students.`;
}
function openSchoolSignup(plan) {
  document.getElementById('schoolModal').classList.remove('hidden');
  document.getElementById('schoolError').textContent = '';
  setSchoolPlan(plan || 'school');
  document.getElementById('scSchool').focus();
}
function closeSchoolSignup() { document.getElementById('schoolModal').classList.add('hidden'); }
async function handleSchoolSignup(e) {
  e.preventDefault();
  const plan = document.getElementById('scPlan').value || 'school';
  const payload = {
    name: document.getElementById('scName').value.trim(),
    school: document.getElementById('scSchool').value.trim(),
    email: document.getElementById('scEmail').value.trim(),
    username: document.getElementById('scUsername').value.trim(),
    password: document.getElementById('scPassword').value
  };
  // Create the (teacher-type) school account, then go straight to payment for the chosen plan.
  const { ok, data } = await C4K.teacherSignup(payload);
  if (ok) { closeSchoolSignup(); window.location.href = 'checkout.html?plan=' + plan; }
  else document.getElementById('schoolError').textContent = '❌ ' + (data.error || 'Could not create school account.');
}
document.getElementById('schoolModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'schoolModal') closeSchoolSignup();
});
async function doLogout() { await C4K.logout(); refreshAuthUI(); }
document.getElementById('loginModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'loginModal') closeLogin();
});

// ── Auth-aware UI (nav chip + AI gating) ──
function refreshAuthUI() {
  const cta = document.getElementById('navCta');
  const u = C4K.user;
  if (cta) {
    if (u) {
      const plan = u.effectivePlan;
      const trial = u.plan === 'trial' && u.trialDaysLeft != null ? ` · ${u.trialDaysLeft}d left` : '';
      const home = u.role === 'parent' ? 'parent.html' : (u.role === 'kid' ? 'dashboard.html' : 'admin.html');
      cta.classList.add('nav-account');
      // Kids can't log out - only parents/admins get a Log Out button.
      const logoutBtn = u.role === 'kid' ? '' : `<a href="#" class="btn btn-ghost" onclick="doLogout();return false;">Log Out</a>`;
      cta.innerHTML =
        `<a href="${home}" class="nav-chip" title="My dashboard" style="text-decoration:none;color:inherit;"><span class="av">${(u.name||'?')[0].toUpperCase()}</span>${u.name}` +
        `<span class="plan-tag ${plan}">${plan}${trial}</span></a>` + logoutBtn;
    } else {
      cta.classList.remove('nav-account');
      cta.innerHTML =
        `<a href="#" class="btn btn-ghost" onclick="openLogin();return false;">Log In</a>` +
        `<a href="#signup" class="btn btn-primary">Start Free</a>`;
    }
  }
  // AI gating
  const ai = C4K.hasAI();
  const lock = document.getElementById('aiLock');
  if (lock) lock.classList.toggle('hidden', ai);
  const botGrid = document.querySelector('.bot-grid');
  if (botGrid) botGrid.classList.toggle('locked', !ai);
  const lockMsg = document.getElementById('aiLockMsg');
  if (lockMsg && !ai) {
    lockMsg.innerHTML = u
      ? `Hi ${u.name}! Your <strong>${u.effectivePlan}</strong> plan doesn't include AI. Upgrade to <strong>Pro</strong> to chat with Byte and the bots.`
      : `Byte and the AI chatbots are unlocked on the <strong>Pro</strong> plan. Free and trial accounts don't include AI. Log in or upgrade to use them.`;
  }
}

// Animate XP bar on scroll
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.width = entry.target.dataset.width;
    }
  });
}, { threshold: 0.3 });

document.querySelectorAll('.xp-fill').forEach(bar => {
  const w = bar.style.width;
  bar.dataset.width = w;
  bar.style.width = '0%';
  observer.observe(bar);
});

// Scroll-in animations
const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      fadeObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .step, .project-card, .testimonial-card, .pricing-card').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(24px)';
  el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
  fadeObserver.observe(el);
});

document.addEventListener('animationend', () => {}, { once: true });

// Apply visible class
const style = document.createElement('style');
style.textContent = '.visible { opacity: 1 !important; transform: translateY(0) !important; }';
document.head.appendChild(style);

// Typewriter for output text
const outputText = document.getElementById('outputText');
if (outputText) {
  const texts = ['Hello, World! 🎉', 'I am a coder! 🚀', 'Python is fun! 🐍', 'Keep building! ⚡'];
  let i = 0;
  setInterval(() => {
    outputText.style.opacity = '0';
    setTimeout(() => {
      i = (i + 1) % texts.length;
      outputText.textContent = texts[i];
      outputText.style.opacity = '1';
      outputText.style.transition = 'opacity 0.4s';
    }, 300);
  }, 2500);
}

function addMsg(container, text, who) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (who === 'user' ? 'msg-user' : 'msg-ai');
  if (who === 'user') {
    wrap.textContent = text;
  } else {
    wrap.innerHTML = '<span class="msg-avatar">' + (container.dataset.emoji || '🤖') + '</span><div class="msg-bubble">' + text + '</div>';
  }
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

// Byte talks to the server, which enforces AI gating (Pro only)
async function sendToByte() {
  const input = document.getElementById('byteInput');
  const box = document.getElementById('byteMessages');
  const text = input.value.trim();
  if (!text) return;
  addMsg(box, text, 'user');
  input.value = '';
  const { ok, data } = await C4K.api('/api/ai', 'POST', { message: text });
  if (ok) {
    addMsg(box, data.reply, 'ai');
  } else if (data.locked) {
    addMsg(box, (data.error || 'AI is locked.') + ' <a href="#pricing" style="color:#c4b5fd;">See plans →</a>', 'ai');
  } else {
    addMsg(box, "Hmm, I couldn't reach my brain. Try again! 🤖", 'ai');
  }
}

// ── PRE-MADE CHATBOTS ──
const BOTS = {
  joke: {
    name: 'Giggle Bot', emoji: '😂',
    intro: "Hi! I tell jokes! 😄 Type 'joke' for a fresh one!",
    reply: (q) => {
      const jokes = [
        "Why do programmers prefer dark mode? Because light attracts bugs! 🐛",
        "Why was the JavaScript developer sad? Because they didn't know how to null their feelings! 😢",
        "How many programmers does it take to change a light bulb? None - that's a hardware problem! 💡",
        "Why did the coder go broke? Because they used up all their cache! 💰",
        "What's a computer's favorite snack? Microchips! 🍟"
      ];
      return jokes[Math.floor(Math.random() * jokes.length)];
    }
  },
  math: {
    name: 'Math Buddy', emoji: '🔢',
    intro: "Hi! Give me a math problem like '12 + 8' or '6 * 7' and I'll solve it! ✏️",
    reply: (q) => {
      const m = q.match(/(-?\d+\.?\d*)\s*([\+\-\*\/x×])\s*(-?\d+\.?\d*)/);
      if (!m) return "Try typing something like <code>12 + 8</code> or <code>9 * 4</code>! 🔢";
      const a = parseFloat(m[1]), b = parseFloat(m[3]); let op = m[2], r;
      if (op === '+') r = a + b;
      else if (op === '-') r = a - b;
      else if (op === '/') r = b === 0 ? 'undefined (can\'t divide by zero!)' : (a / b);
      else r = a * b;
      return "That equals <strong>" + r + "</strong>! 🎉 Want another one?";
    }
  },
  story: {
    name: 'Story Spark', emoji: '📖',
    intro: "Hi! Tell me a hero's name and a place, like 'Luna in space' and I'll write a story! ✨",
    reply: (q) => {
      const words = q.replace(/\bin\b/gi, '|').split('|');
      const hero = (words[0] || 'a brave coder').trim() || 'a brave coder';
      const place = (words[1] || 'a magic forest').trim() || 'a magic forest';
      return "Once upon a time, <strong>" + hero + "</strong> arrived in <strong>" + place + "</strong>. 🌟 Suddenly a glowing puzzle appeared! Using clever code and a brave heart, " + hero + " solved it and unlocked a secret treasure. The end! 📖 Want another story?";
    }
  },
  quiz: {
    name: 'Quiz Master', emoji: '🧠',
    intro: "Welcome to the coding quiz! 🧠 Type 'start' to begin!",
    reply: function(q) {
      const qs = [
        { q: "What symbol ends a Python if-statement line? (type the symbol)", a: [":"] },
        { q: "What keyword repeats code? (loop word)", a: ["for", "while", "loop"] },
        { q: "What stores a value? (one word)", a: ["variable", "var"] }
      ];
      if (/start|next|yes/.test(q) || this._i === undefined) {
        this._i = (this._i === undefined) ? 0 : (this._i + 1) % qs.length;
        this._cur = qs[this._i];
        return "Question: " + this._cur.q;
      }
      if (this._cur && this._cur.a.some(a => q.includes(a))) {
        return "✅ Correct! Awesome! Type 'next' for another question! 🎉";
      }
      return "❌ Not quite! The answer was <strong>" + (this._cur ? this._cur.a[0] : '?') + "</strong>. Type 'next' to keep going! 💪";
    }
  }
};

let activeBot = null;
function openBot(key) {
  if (!C4K.hasAI()) {
    if (C4K.isLoggedIn()) {
      alert("🔒 AI chatbots are a Pro feature. Your current plan doesn't include AI - upgrade to Pro to play!");
    } else {
      openLogin();
    }
    return;
  }
  activeBot = BOTS[key];
  if (!activeBot) return;
  document.getElementById('botModalEmoji').textContent = activeBot.emoji;
  document.getElementById('botModalName').textContent = activeBot.name;
  const box = document.getElementById('botModalMessages');
  box.dataset.emoji = activeBot.emoji;
  box.innerHTML = '';
  addMsg(box, activeBot.intro, 'ai');
  document.getElementById('botModal').classList.remove('hidden');
  document.getElementById('botModalInput').focus();
}
function closeBot() {
  document.getElementById('botModal').classList.add('hidden');
  activeBot = null;
}
function sendToBot() {
  if (!activeBot) return;
  const input = document.getElementById('botModalInput');
  const box = document.getElementById('botModalMessages');
  const text = input.value.trim();
  if (!text) return;
  addMsg(box, text, 'user');
  input.value = '';
  setTimeout(() => addMsg(box, activeBot.reply(text), 'ai'), 400);
}
document.getElementById('botModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'botModal') closeBot();
});

// Nav highlight on scroll
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a');
window.addEventListener('scroll', () => {
  let current = '';
  sections.forEach(section => {
    if (window.scrollY >= section.offsetTop - 120) current = section.id;
  });
  navLinks.forEach(link => {
    link.style.color = link.getAttribute('href') === `#${current}` ? 'var(--purple)' : '';
  });
}, { passive: true });

// ── Boot ──
(async () => {
  const params = new URLSearchParams(location.search);
  const plink = params.get('plink');
  const consent = params.get('consent');
  const cc = params.get('consentconfirm');
  await C4K.loadMe();

  // Parental consent links (COPPA) - open the consent flow regardless of who's logged in.
  if (consent) { refreshAuthUI(); openConsent(consent); return; }
  if (cc) { refreshAuthUI(); document.getElementById('consentModal').classList.remove('hidden'); renderConsentIdForm(cc, 'your child'); return; }

  // Parent invite link → open the parent signup connected to that child
  if (plink && !C4K.isLoggedIn()) {
    refreshAuthUI();
    openParentSignup(plink);
    return;
  }

  // ?login=1 (e.g. from the "Log in to use Lessons" gate) → open the login modal
  if (params.get('login') && !C4K.isLoggedIn()) {
    refreshAuthUI();
    openLogin();
    return;
  }

  // Already logged in? Send them straight to their own space - but NOT if they
  // followed a deep link (e.g. #pricing for an upgrade) which they need to see.
  if (C4K.isLoggedIn() && !location.hash) {
    if (C4K.user.role !== 'admin' && C4K.user.role !== 'super_admin') {
      location.href = C4K.homeFor(C4K.user); return;
    }
    location.href = 'admin.html'; return;
  }
  refreshAuthUI();
  // The #pricing link (e.g. from a parent's upgrade message) opens the pricing popup.
  if (location.hash === '#pricing') openPricing();
})();

// Reflect the super admin's login/sign-up switches on the home page.
window.__siteConfig = { signupsEnabled: true, loginsEnabled: true };
(async function siteConfigInit() {
  try { const { data } = await C4K.api('/api/site-config'); if (data) window.__siteConfig = data; } catch {}
  if (window.__siteConfig.signupsEnabled === false) {
    const form = document.getElementById('signupForm');
    if (form && !document.getElementById('signupPausedNote')) {
      const btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = true; btn.textContent = 'Sign-ups paused ⏸️'; }
      const n = document.createElement('p');
      n.id = 'signupPausedNote'; n.className = 'signup-fine';
      n.style.cssText = 'color:#fbbf24;font-weight:800;';
      n.textContent = '⏸️ New sign-ups are temporarily paused - please check back soon!';
      form.parentNode.insertBefore(n, form);
    }
  }
})();

// Share KidVibers - native share sheet on phones, copy-link fallback on desktop.
async function shareSite() {
  const url = 'https://kidvibers.com';
  const shareData = { title: 'KidVibers', text: 'Learn to code like a game - made by a kid, for kids! 🚀', url };
  if (navigator.share) {
    try { await navigator.share(shareData); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); alert('🔗 Link copied! Share kidvibers.com with your friends.'); }
  catch { window.prompt('Copy this link to share KidVibers:', url); }
}
