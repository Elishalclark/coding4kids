// ── Guided "See a Live Demo" site tour ──────────────────────────────────────
// A lightweight, dependency-free spotlight tour that walks a visitor across
// several real pages of the (demo-logged-in) app, highlighting one element
// per step with a tooltip card. State lives in sessionStorage so it survives
// the full-page navigations between dashboard/lessons/playground/games.
(function () {
  const STORAGE_KEY = 'c4k_tour_step';

  // Each step names the page it belongs to (matched against the current
  // pathname's filename) and a CSS selector to spotlight. Steps are visited
  // in array order; when there are no more steps for the current page, the
  // tour navigates to the next step's page.
  const STEPS = [
    { page: 'dashboard.html', selector: '#dHi', title: '👋 Welcome to your dashboard!', text: "This is what every kid sees when they log in — their streak, level, and what to do next, all in one place." },
    { page: 'dashboard.html', selector: '.stat-grid', title: '⚡ Progress that feels like a game', text: 'Level, XP, streaks, and lessons done — kids can see themselves leveling up every single day.' },
    { page: 'lessons.html', selector: '#progressBanner, #unitsWrap', title: '📚 Real lessons, bite-sized', text: 'Short, structured lessons teach real coding concepts — variables, loops, logic — building world by world.' },
    { page: 'playground.html', selector: '#editorPanel, #chatMsgs', title: '🎨 Vibe Studio', text: 'Kids describe what they want to build and watch it come to life — no syntax required to get started.' },
    { page: 'games.html', selector: '.games-grid', title: '🎮 Game Arcade', text: 'A whole arcade of coding games — fast, fun practice that doesn’t feel like homework.' },
    { page: 'games.html', selector: null, title: '🚀 That’s KidVibers!', text: 'Ready to let your own kids (or students) try it? Starting is free — no credit card needed.', final: true },
  ];

  function pageName() {
    const p = location.pathname.split('/').pop() || 'index.html';
    return p;
  }

  function currentStepIndex() {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw == null ? -1 : parseInt(raw, 10);
  }

  function findEl(selector) {
    if (!selector) return null;
    for (const sel of selector.split(',')) {
      const el = document.querySelector(sel.trim());
      if (el) return el;
    }
    return null;
  }

  function removeOverlay() {
    const ex = document.getElementById('tourOverlay');
    if (ex) ex.remove();
  }

  function render(idx) {
    removeOverlay();
    const step = STEPS[idx];
    if (!step) { sessionStorage.removeItem(STORAGE_KEY); return; }

    const wrap = document.createElement('div');
    wrap.id = 'tourOverlay';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none;';

    const target = findEl(step.selector);
    let spot = null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      spot = document.createElement('div');
      const r = target.getBoundingClientRect();
      spot.style.cssText = `position:fixed;left:${r.left - 8}px;top:${r.top - 8}px;width:${r.width + 16}px;height:${r.height + 16}px;
        border-radius:14px;box-shadow:0 0 0 9999px rgba(10,6,20,0.72);border:2px solid #a78bfa;pointer-events:none;transition:all 0.25s ease;`;
      wrap.appendChild(spot);
    } else {
      const dim = document.createElement('div');
      dim.style.cssText = 'position:fixed;inset:0;background:rgba(10,6,20,0.72);pointer-events:none;';
      wrap.appendChild(dim);
    }

    const card = document.createElement('div');
    card.style.cssText = `pointer-events:auto;position:fixed;left:50%;bottom:32px;transform:translateX(-50%);max-width:420px;width:calc(100% - 40px);
      background:var(--surface,#1a1030);color:var(--text,#fff);border:1px solid var(--border-bright,#7c3aed);border-radius:16px;
      padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,0.5);font-family:inherit;`;
    const dots = STEPS.map((_, i) => `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;background:${i === idx ? '#a78bfa' : 'rgba(255,255,255,0.25)'};"></span>`).join('');
    card.innerHTML = `
      <div style="margin-bottom:8px;">${dots}</div>
      <h3 style="margin:0 0 6px;font-size:1.1rem;font-weight:900;">${step.title}</h3>
      <p style="margin:0 0 14px;font-size:0.92rem;line-height:1.55;color:var(--text-dim,#c9bfe0);">${step.text}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        ${step.final
          ? `<button id="tourSkip" style="background:none;border:none;color:var(--text-dim,#c9bfe0);font-weight:700;cursor:pointer;font-family:inherit;">Close</button>
             <a href="index.html?startTour=1" id="tourFinish" style="text-decoration:none;background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;font-weight:800;padding:9px 18px;border-radius:10px;">Start for free 🚀</a>`
          : `<button id="tourSkip" style="background:none;border:none;color:var(--text-dim,#c9bfe0);font-weight:700;cursor:pointer;font-family:inherit;">Skip tour</button>
             <button id="tourNext" style="background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;border:none;font-weight:800;padding:9px 18px;border-radius:10px;cursor:pointer;font-family:inherit;">Next →</button>`
        }
      </div>`;
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    const skipBtn = document.getElementById('tourSkip');
    if (skipBtn) skipBtn.onclick = () => { sessionStorage.removeItem(STORAGE_KEY); removeOverlay(); };
    const nextBtn = document.getElementById('tourNext');
    if (nextBtn) nextBtn.onclick = () => advance(idx);
    const finishBtn = document.getElementById('tourFinish');
    if (finishBtn) finishBtn.onclick = () => { sessionStorage.removeItem(STORAGE_KEY); };
  }

  function advance(idx) {
    const next = idx + 1;
    if (next >= STEPS.length) { sessionStorage.removeItem(STORAGE_KEY); removeOverlay(); return; }
    sessionStorage.setItem(STORAGE_KEY, String(next));
    if (STEPS[next].page === pageName()) {
      render(next);
    } else {
      location.href = STEPS[next].page;
    }
  }

  window.startTour = function () {
    sessionStorage.setItem(STORAGE_KEY, '0');
    if (STEPS[0].page === pageName()) render(0);
    else location.href = STEPS[0].page;
  };

  document.addEventListener('DOMContentLoaded', () => {
    const idx = currentStepIndex();
    if (idx < 0) return;
    // Find the first step on this page starting at (or after) the saved index.
    let i = idx;
    while (i < STEPS.length && STEPS[i].page !== pageName()) i++;
    if (i >= STEPS.length) { sessionStorage.removeItem(STORAGE_KEY); return; }
    sessionStorage.setItem(STORAGE_KEY, String(i));
    setTimeout(() => render(i), 350); // let the page's own render finish first
  });
})();
