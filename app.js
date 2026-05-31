// Mobile nav
const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobileMenu');
hamburger.addEventListener('click', () => mobileMenu.classList.toggle('open'));

// Close mobile menu on link click
mobileMenu.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => mobileMenu.classList.remove('open'));
});

// ── Signup (real backend account) ──
async function handleSignup(e) {
  e.preventDefault();
  const success = document.getElementById('signupSuccess');
  const payload = {
    name: document.getElementById('suName').value.trim(),
    parentEmail: document.getElementById('suEmail').value.trim(),
    username: document.getElementById('suUsername').value.trim(),
    password: document.getElementById('suPassword').value,
    ageBand: document.getElementById('suAge').value
  };
  const { ok, data } = await C4K.signup(payload);
  success.classList.remove('hidden');
  if (ok) {
    success.style.background = 'rgba(255,255,255,0.2)';
    success.innerHTML = `🎉 Welcome, ${data.user.name}!`;
    document.getElementById('signupForm').reset();
    showInvite(data, payload.parentEmail);   // QR + parent email invite, then dashboard
  } else {
    success.style.background = 'rgba(239,68,68,0.25)';
    success.textContent = '⚠️ ' + (data.error || 'Could not create account.');
  }
  success.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Login modal (Kid / Admin / Super Admin) ──
let loginRole = 'kid';
const LOGIN_ROLE_UI = {
  kid:         { icon: '🔐',  title: 'Kid Log In',         sub: 'Welcome back, coder!',      btn: 'Log In',                foot: true },
  parent:      { icon: '👨‍👩‍👧', title: 'Parent Log In',      sub: 'Manage your family',        btn: 'Log In as Parent',      foot: false },
  admin:       { icon: '🛠️',  title: 'Admin Log In',       sub: 'Staff dashboard access',     btn: 'Log In as Admin',       foot: false },
  super_admin: { icon: '👑',  title: 'Super Admin Log In', sub: 'Full control panel access',  btn: 'Log In as Super Admin', foot: false }
};

function setLoginRole(role) {
  loginRole = role;
  document.querySelectorAll('.role-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.role === role));
  const ui = LOGIN_ROLE_UI[role];
  document.getElementById('loginIcon').textContent = ui.icon;
  document.getElementById('loginTitle').textContent = ui.title;
  document.getElementById('loginSubtitle').textContent = ui.sub;
  document.getElementById('loginSubmitBtn').textContent = ui.btn;
  document.getElementById('loginFootnote').style.display = ui.foot ? '' : 'none';
  document.getElementById('loginError').textContent = '';
}

function openLogin() {
  document.getElementById('loginModal').classList.remove('hidden');
  setLoginRole('kid');
  document.getElementById('loginUsername').focus();
}
function closeLogin() { document.getElementById('loginModal').classList.add('hidden'); }

async function handleLogin(e) {
  e.preventDefault();
  const u = document.getElementById('loginUsername').value.trim();
  const p = document.getElementById('loginPassword').value;
  const isAdmin = loginRole === 'admin' || loginRole === 'super_admin';
  const { ok, data } = isAdmin ? await C4K.adminLogin(u, p) : await C4K.login(u, p);
  if (!ok) {
    document.getElementById('loginError').textContent = '❌ ' + (data.error || 'Login failed.');
    return;
  }
  // Make sure the account matches the tab the user picked
  if (data.user.role !== loginRole) {
    const labels = { kid: 'a kid', parent: 'a parent', admin: 'an admin', super_admin: 'a super admin' };
    document.getElementById('loginError').textContent = `❌ Those credentials aren't for ${labels[loginRole]} account.`;
    await C4K.logout();
    return;
  }
  closeLogin();
  if (loginRole === 'parent') window.location.href = 'parent.html';
  else if (isAdmin) window.location.href = 'admin.html';
  else window.location.href = 'dashboard.html';   // kid → personalized dashboard
}

// ── Parent signup ──
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

// ── Parent invite (QR + email) shown after a kid signs up ──
function showInvite(data, parentEmail) {
  const url = data.inviteUrl || (location.origin + '/index.html?plink=' + data.inviteToken);
  document.getElementById('inviteQr').src =
    'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(url);
  document.getElementById('inviteEmail').textContent = parentEmail || 'your parent';
  document.getElementById('inviteKid').textContent = data.user.name;
  document.getElementById('inviteEmailBtn').href = url;
  document.getElementById('inviteModal').classList.remove('hidden');
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
      // Kids can't log out — only parents/admins get a Log Out button.
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
        "How many programmers does it take to change a light bulb? None — that's a hardware problem! 💡",
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
      alert("🔒 AI chatbots are a Pro feature. Your current plan doesn't include AI — upgrade to Pro to play!");
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
  await C4K.loadMe();

  // Parent invite link → open the parent signup connected to that child
  if (plink && !C4K.isLoggedIn()) {
    refreshAuthUI();
    openParentSignup(plink);
    return;
  }

  // Already logged in? Send them straight to their own space — but NOT if they
  // followed a deep link (e.g. #pricing for an upgrade) which they need to see.
  if (C4K.isLoggedIn() && !location.hash) {
    const r = C4K.user.role;
    if (r === 'kid') { location.href = 'dashboard.html'; return; }
    if (r === 'parent') { location.href = 'parent.html'; return; }
    if (r === 'admin' || r === 'super_admin') { location.href = 'admin.html'; return; }
  }
  refreshAuthUI();
  // The #pricing link (e.g. from a parent's upgrade message) opens the pricing popup.
  if (location.hash === '#pricing') openPricing();
})();
