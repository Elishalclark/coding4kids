// ── Shared front-end auth + API helper (used by every page) ──
const C4K = {
  TOKEN_KEY: 'c4k_token',
  user: null,

  token() { return localStorage.getItem(this.TOKEN_KEY); },
  setToken(t) { t ? localStorage.setItem(this.TOKEN_KEY, t) : localStorage.removeItem(this.TOKEN_KEY); },

  async api(path, method = 'GET', body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    try {
      const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let data = {};
      try { data = await res.json(); } catch {}
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      // Network/offline error - do NOT treat as logged out.
      return { ok: false, status: 0, data: {}, networkError: true };
    }
  },

  async loadMe() {
    if (!this.token()) { this.user = null; return null; }
    const res = await this.api('/api/me');
    if (res.ok) { this.user = res.data.user; }
    else if (res.status === 401) { this.user = null; this.setToken(null); }  // only a real 401 logs you out
    // transient errors (network/500): keep the token, keep prior user
    return this.user;
  },

  async signup(payload) {
    const { ok, data } = await this.api('/api/signup', 'POST', payload);
    if (ok) { this.setToken(data.token); this.user = data.user; }
    return { ok, data };
  },

  async login(username, password) {
    const { ok, data } = await this.api('/api/login', 'POST', { username, password });
    if (ok) { this.setToken(data.token); this.user = data.user; }
    return { ok, data };
  },

  async parentSignup(payload) {
    const { ok, data } = await this.api('/api/parent/signup', 'POST', payload);
    if (ok) { this.setToken(data.token); this.user = data.user; }
    return { ok, data };
  },

  async teacherSignup(payload) {
    const { ok, data } = await this.api('/api/teacher/signup', 'POST', payload);
    if (ok) { this.setToken(data.token); this.user = data.user; }
    return { ok, data };
  },

  async adminLogin(username, password) {
    const { ok, data } = await this.api('/api/admin/login', 'POST', { username, password });
    if (ok) { this.setToken(data.token); this.user = data.user; }
    return { ok, data };
  },

  async logout() {
    await this.api('/api/logout', 'POST');
    this.setToken(null);
    this.user = null;
  },

  hasAI() { return !!(this.user && this.user.hasAI); },
  isLoggedIn() { return !!this.user; },

  // Require sign-in to use a feature (Lessons / Playground / Gallery). Shows a full-screen
  // gate for logged-out visitors and returns true (so the caller can stop). Returns false
  // when the user is logged in. Call after loadMe().
  loginGate(feature) {
    if (this.user) return false;
    if (document.getElementById('c4kGate')) return true;
    const f = this.esc(feature || 'this');
    const ov = document.createElement('div');
    ov.id = 'c4kGate';
    ov.setAttribute('style', 'position:fixed;inset:0;z-index:2147483646;background:rgba(8,6,18,0.97);' +
      'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;' +
      "font-family:'Nunito',system-ui,sans-serif;");
    ov.innerHTML =
      '<div style="max-width:460px;width:100%;text-align:center;background:#171327;border:1px solid #3a2f63;' +
      'border-radius:22px;padding:40px 30px;color:#eee;box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
        '<div style="font-size:3.4rem;">🔒</div>' +
        '<h1 style="font-size:1.5rem;font-weight:900;margin:12px 0;color:#fff;">Log in to use ' + f + '</h1>' +
        '<p style="color:#bdb6d6;line-height:1.6;margin-bottom:22px;">Create a free account or log in to start coding on KidVibers! 🚀</p>' +
        '<a href="index.html?login=1" style="display:block;text-decoration:none;margin-bottom:10px;padding:13px;border-radius:12px;' +
          'background:linear-gradient(135deg,#7c5cff,#b14cff);color:#fff;font-weight:900;font-size:1rem;">Log In →</a>' +
        '<a href="index.html#signup" style="display:block;text-decoration:none;margin-bottom:16px;padding:13px;border-radius:12px;' +
          'border:1px solid #3a2f63;color:#cdb8ff;font-weight:800;">Create a Free Account</a>' +
        '<a href="index.html" style="color:#8b83b0;font-size:0.85rem;text-decoration:none;">← Back to home</a>' +
      '</div>';
    document.body.appendChild(ov);
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return true;
  },

  // Where a given user's "home" dashboard lives.
  homeFor(user) {
    user = user || this.user || {};
    if (user.role === 'admin' || user.role === 'super_admin') return 'admin.html';
    if (user.role === 'teacher') return user.isDistrict ? 'district.html' : 'parent.html';
    if (user.role === 'parent') return 'parent.html';
    return 'dashboard.html';
  },

  // Escape text before putting it in innerHTML (prevents stored XSS via names, etc.)
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // ── Super-admin impersonation ("log in as") ──
  SUPER_BACKUP: 'c4k_super_token',
  startImpersonation(targetToken) {
    const cur = this.token();
    if (cur) localStorage.setItem(this.SUPER_BACKUP, cur);  // remember the super-admin session
    this.setToken(targetToken);
  },
  isImpersonating() { return !!localStorage.getItem(this.SUPER_BACKUP); },
  async endImpersonation() {
    const sup = localStorage.getItem(this.SUPER_BACKUP);
    if (sup) { this.setToken(sup); localStorage.removeItem(this.SUPER_BACKUP); }
    window.location.href = 'admin.html';
  },

  // ── COPPA: fully lock a kid's account until a parent approves it ──
  // Returns true (and shows a blocking full-screen overlay) when the account is waiting for consent.
  consentLock(me) {
    me = me || this.user;
    if (!me || me.role !== 'kid' || !me.needsConsent) return false;
    if (document.getElementById('c4kLock')) return true;
    const ov = document.createElement('div');
    ov.id = 'c4kLock';
    ov.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;background:rgba(8,6,18,0.97);' +
      'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;' +
      "font-family:'Nunito',system-ui,sans-serif;");
    const email = me.parentEmail || '';
    ov.innerHTML =
      '<div style="max-width:540px;width:100%;text-align:center;background:#171327;border:1px solid #3a2f63;' +
      'border-radius:22px;padding:40px 30px;color:#eee;box-shadow:0 20px 60px rgba(0,0,0,.5);">' +
        '<div style="font-size:3.4rem;">🔒</div>' +
        '<h1 style="font-size:1.5rem;font-weight:900;margin:12px 0;color:#fff;">Hi ' + this.esc(me.name) + '! Your account is locked</h1>' +
        '<p style="color:#bdb6d6;line-height:1.6;">A parent or guardian has to <strong>approve your account</strong> before you can play, ' +
        'do lessons, use the playground, or anything else. Nothing works until then - to keep you safe! 🛡️</p>' +
        '<div style="background:#0f0c1e;border:1px solid #2c2450;border-radius:14px;padding:16px;margin:18px 0;text-align:left;">' +
          '<label style="font-size:0.82rem;font-weight:800;color:#9b93c4;">Parent / guardian email</label>' +
          '<input id="c4kLockEmail" type="email" value="' + this.esc(email) + '" placeholder="grownup@email.com" ' +
            'style="width:100%;margin-top:6px;padding:11px 13px;border-radius:10px;border:1px solid #3a2f63;' +
            'background:#08060f;color:#fff;font-family:inherit;font-weight:700;box-sizing:border-box;" />' +
          '<button id="c4kLockSend" style="width:100%;margin-top:10px;padding:12px;border:none;border-radius:10px;' +
            'background:linear-gradient(135deg,#7c5cff,#b14cff);color:#fff;font-weight:900;font-size:0.95rem;cursor:pointer;">' +
            '📨 Send approval email to my parent</button>' +
          '<p id="c4kLockMsg" style="font-size:0.82rem;margin:8px 0 0;color:#7ee0a0;min-height:1em;"></p>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;color:#6f6890;font-size:0.74rem;font-weight:800;margin:6px 0 14px;">' +
          '<span style="flex:1;height:1px;background:#2c2450;"></span>OR<span style="flex:1;height:1px;background:#2c2450;"></span></div>' +
        '<div style="background:#0f0c1e;border:1px solid #2c2450;border-radius:14px;padding:16px;margin-bottom:18px;text-align:left;">' +
          '<label style="font-size:0.82rem;font-weight:800;color:#9b93c4;">🏫 Have a class code from your teacher?</label>' +
          '<div style="display:flex;gap:8px;margin-top:6px;">' +
            '<input id="c4kLockCode" maxlength="8" placeholder="CODE" ' +
              'style="flex:1;text-transform:uppercase;letter-spacing:2px;font-weight:900;padding:11px 13px;border-radius:10px;border:1px solid #3a2f63;background:#08060f;color:#fff;font-family:inherit;box-sizing:border-box;" />' +
            '<button id="c4kLockJoin" style="padding:11px 16px;border:none;border-radius:10px;background:linear-gradient(135deg,#7c5cff,#b14cff);color:#fff;font-weight:900;cursor:pointer;">Join</button>' +
          '</div>' +
          '<p id="c4kLockCodeMsg" style="font-size:0.82rem;margin:8px 0 0;color:#7ee0a0;min-height:1em;"></p>' +
        '</div>' +
        '<button id="c4kLockRefresh" style="background:none;border:1px solid #3a2f63;color:#bdb6d6;font-weight:800;' +
          'padding:9px 16px;border-radius:50px;cursor:pointer;">✅ My parent approved - check again</button>' +
        '<p style="color:#6f6890;font-size:0.78rem;margin-top:16px;">Need help? Email ' +
          '<a href="mailto:kidvibers.help@outlook.com" style="color:#9b8cff;">kidvibers.help@outlook.com</a></p>' +
      '</div>';
    document.body.appendChild(ov);
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    const msg = ov.querySelector('#c4kLockMsg');
    ov.querySelector('#c4kLockSend').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const pe = ov.querySelector('#c4kLockEmail').value.trim();
      const { ok, data } = await this.api('/api/consent/resend', 'POST', { parentEmail: pe });
      msg.style.color = ok ? '#7ee0a0' : '#ff8a8a';
      msg.textContent = ok ? ('Sent! We emailed ' + (data.parentEmail || 'your parent') + '. Ask them to tap the approval link.')
                           : (data.error || 'Could not send. Check the email address.');
      btn.disabled = false;
    };
    // A teacher code joins the kid to a classroom, which grants school consent and unlocks them.
    const codeMsg = ov.querySelector('#c4kLockCodeMsg');
    ov.querySelector('#c4kLockJoin').onclick = async (e) => {
      const btn = e.currentTarget;
      const code = (ov.querySelector('#c4kLockCode').value || '').trim().toUpperCase();
      if (!code) { codeMsg.style.color = '#ff8a8a'; codeMsg.textContent = 'Enter your class code.'; return; }
      btn.disabled = true;
      const { ok, data } = await this.api('/api/class/join', 'POST', { code });
      codeMsg.style.color = ok ? '#7ee0a0' : '#ff8a8a';
      if (ok) {
        codeMsg.textContent = '✅ Joined ' + (data.groupName || 'the classroom') + '! Unlocking...';
        setTimeout(() => location.reload(), 900);
      } else {
        codeMsg.textContent = data.error || 'Could not join. Check the code.';
        btn.disabled = false;
      }
    };
    ov.querySelector('#c4kLockRefresh').onclick = () => location.reload();
    return true;
  },

  // ── Avatar catalog (mirrors the server shop) for rendering anywhere ──
  SHOP: [
    { id:'face_kid',name:'Classic',cat:'face',emoji:'🧒',price:0 },
    { id:'face_cool',name:'Cool Kid',cat:'face',emoji:'😎',price:15 },
    { id:'face_star',name:'Star Eyes',cat:'face',emoji:'🤩',price:25 },
    { id:'face_robot',name:'Robot',cat:'face',emoji:'🤖',price:30 },
    { id:'face_alien',name:'Alien',cat:'face',emoji:'👽',price:30 },
    { id:'hat_cap',name:'Cap',cat:'hat',emoji:'🧢',price:20 },
    { id:'hat_top',name:'Top Hat',cat:'hat',emoji:'🎩',price:40 },
    { id:'hat_grad',name:'Grad Cap',cat:'hat',emoji:'🎓',price:50 },
    { id:'hat_crown',name:'Crown',cat:'hat',emoji:'👑',price:90 },
    { id:'hat_party',name:'Party Hat',cat:'hat',emoji:'🥳',price:35 },
    { id:'acc_glass',name:'Glasses',cat:'accessory',emoji:'👓',price:20 },
    { id:'acc_shades',name:'Cool Shades',cat:'accessory',emoji:'🕶️',price:35 },
    { id:'acc_bow',name:'Bow',cat:'accessory',emoji:'🎀',price:25 },
    { id:'acc_medal',name:'Medal',cat:'accessory',emoji:'🏅',price:45 },
    { id:'cloth_tee',name:'T-Shirt',cat:'clothing',emoji:'👕',price:15 },
    { id:'cloth_hood',name:'Hoodie',cat:'clothing',emoji:'🧥',price:40 },
    { id:'cloth_lab',name:'Lab Coat',cat:'clothing',emoji:'🥼',price:55 },
    { id:'pet_cat',name:'Cat Buddy',cat:'companion',emoji:'🐱',price:70 },
    { id:'pet_dog',name:'Dog Buddy',cat:'companion',emoji:'🐶',price:70 },
    { id:'pet_bot',name:'Robot Pal',cat:'companion',emoji:'🤖',price:100 },
    { id:'bg_purple',name:'Purple',cat:'background',color:'#7c3aed',price:0 },
    { id:'bg_blue',name:'Ocean',cat:'background',color:'#0ea5e9',price:20 },
    { id:'bg_green',name:'Jungle',cat:'background',color:'#10b981',price:20 },
    { id:'bg_pink',name:'Bubblegum',cat:'background',color:'#ec4899',price:25 },
    { id:'bg_gold',name:'Gold',cat:'background',color:'#f59e0b',price:60 },
  ],
  shopItem(id) { return this.SHOP.find(i => i.id === id); },

  // Pricing is never shown inline - only inside a popup (lesson-limit or the #pricing link).
  pricingPlans: [
    { id: 'free', name: 'Free', price: '$0', tag: '', features: ['A few starter lessons', 'Badges, streaks & tokens', 'Avatar shop', '- No AI buddy'] },
    { id: 'pro', name: 'Pro', price: '$9', tag: 'Most Popular', features: ['All lessons & worlds', '🤖 AI buddy (Byte)', 'Boss battles', 'Certificates'] },
    { id: 'family', name: 'Family', price: '$15', tag: '', features: ['Everything in Pro', 'Up to 4 kids', 'Family dashboard', 'Priority support'] },
  ],
  // opts.buy = true → show a "Get [plan]" button that goes to the checkout page
  pricingHTML(opts) {
    const buy = opts && opts.buy;
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;">' +
      this.pricingPlans.map(p => `
        <div style="background:var(--surface-2);border:1px solid ${p.tag ? 'var(--border-bright)' : 'var(--border)'};border-radius:14px;padding:16px;position:relative;display:flex;flex-direction:column;">
          ${p.tag ? `<div style="position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,var(--purple-mid),var(--pink));color:#fff;font-size:0.62rem;font-weight:900;padding:3px 10px;border-radius:50px;white-space:nowrap;">${p.tag}</div>` : ''}
          <div style="font-weight:900;color:var(--purple);text-transform:uppercase;font-size:0.78rem;letter-spacing:0.05em;">${p.name}</div>
          <div style="font-size:1.6rem;font-weight:900;margin:2px 0 8px;">${p.price}<span style="font-size:0.7rem;color:var(--text-dim);font-weight:700;">/mo</span></div>
          <ul style="list-style:none;display:flex;flex-direction:column;gap:5px;margin:0 0 12px;padding:0;flex:1;">
            ${p.features.map(f => `<li style="font-size:0.78rem;color:var(--text-dim);">${f.startsWith('-') ? f : '✓ ' + f}</li>`).join('')}
          </ul>
          ${buy && p.id !== 'free' ? `<a href="checkout.html?plan=${p.id}" class="btn ${p.tag ? 'btn-primary' : 'btn-outline'}" style="font-size:0.82rem;padding:8px;text-align:center;">Get ${p.name}</a>` : ''}
        </div>`).join('') + '</div>';
  },

  // Returns HTML for a layered avatar given an avatar config object.
  renderAvatar(av, size = 80) {
    av = av || { face: 'face_kid', background: 'bg_purple' };
    const bg = this.shopItem(av.background) || this.shopItem('bg_purple');
    const face = this.shopItem(av.face) || this.shopItem('face_kid');
    const hat = av.hat && this.shopItem(av.hat);
    const acc = av.accessory && this.shopItem(av.accessory);
    const cloth = av.clothing && this.shopItem(av.clothing);
    const pet = av.companion && this.shopItem(av.companion);
    const fs = Math.round(size * 0.5);
    let h = `<div class="c4k-avatar" style="position:relative;width:${size}px;height:${size}px;border-radius:50%;background:${bg ? bg.color : '#7c3aed'};display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;">`;
    h += `<span style="font-size:${fs}px;line-height:1;">${face ? face.emoji : '🧒'}</span>`;
    if (cloth) h += `<span style="position:absolute;bottom:-2px;font-size:${Math.round(size*0.34)}px;">${cloth.emoji}</span>`;
    if (hat) h += `<span style="position:absolute;top:-2px;font-size:${Math.round(size*0.36)}px;">${hat.emoji}</span>`;
    if (acc) h += `<span style="position:absolute;font-size:${Math.round(size*0.3)}px;">${acc.emoji}</span>`;
    if (pet) h += `<span style="position:absolute;bottom:0;right:0;font-size:${Math.round(size*0.26)}px;">${pet.emoji}</span>`;
    h += `</div>`;
    return h;
  }
};

// Floating "Return to Super Admin" banner - appears on any page while impersonating.
(function () {
  function mount() {
    if (!C4K.isImpersonating() || document.getElementById('c4kImpersonateBar')) return;
    const bar = document.createElement('div');
    bar.id = 'c4kImpersonateBar';
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:999;background:linear-gradient(135deg,#6d28d9,#db2777);' +
      'color:#fff;font-family:Nunito,sans-serif;font-weight:800;font-size:0.9rem;padding:10px 16px;display:flex;' +
      'align-items:center;justify-content:center;gap:14px;box-shadow:0 -4px 20px rgba(0,0,0,0.4);';
    bar.innerHTML = '👑 You are viewing as another user (super-admin preview).' +
      '<button style="background:#fff;color:#6d28d9;border:none;border-radius:50px;padding:7px 16px;font-weight:900;cursor:pointer;font-family:Nunito,sans-serif;">Return to Super Admin</button>';
    bar.querySelector('button').onclick = () => C4K.endImpersonation();
    document.body.appendChild(bar);
    document.body.style.paddingBottom = '52px';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

// Site-wide announcement banner - shown to everyone when the super admin sets one.
(function () {
  async function mount() {
    if (document.getElementById('c4kSiteBanner')) return;
    let data;
    try { const r = await fetch('/api/site-message'); data = await r.json(); } catch { return; }
    if (!data || !data.active || !data.text) return;
    const dismissedKey = 'c4k_sitemsg_' + btoa(unescape(encodeURIComponent(data.text))).slice(0, 24);
    if (sessionStorage.getItem(dismissedKey)) return;   // don't nag after dismiss this session
    const bar = document.createElement('div');
    bar.id = 'c4kSiteBanner';
    bar.style.cssText = 'position:relative;z-index:120;background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;' +
      'font-family:Nunito,sans-serif;font-weight:800;font-size:0.92rem;padding:11px 44px 11px 16px;text-align:center;line-height:1.4;';
    bar.innerHTML = '📢 ' + C4K.esc(data.text) +
      '<button aria-label="Dismiss" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.25);' +
      'border:none;color:#fff;width:26px;height:26px;border-radius:50%;font-weight:900;cursor:pointer;font-family:Nunito,sans-serif;">✕</button>';
    bar.querySelector('button').onclick = () => { bar.remove(); sessionStorage.setItem(dismissedKey, '1'); };
    document.body.insertBefore(bar, document.body.firstChild);   // top of the page, above the nav
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
