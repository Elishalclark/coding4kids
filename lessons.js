// ── Offline fallback lessons (used only if the server is unreachable) ──
const LESSONS_SEED = [
  { id:'l1', emoji:'🖨️', level:'Ages 6+', xp:50, unit:1, title:'Say Hello with Print', blurb:'Make the computer talk!',
    steps:[{h:'What is print?',p:'The <code>print</code> command shows words on screen.'},{h:'Try it',code:'print("Hello, World!")',p:'Shows <strong>Hello, World!</strong>'}],
    quiz:{q:'Which line prints Hi?',opts:['print(Hi)','print("Hi")','Print "Hi"'],answer:1} },
];

let LESSONS = [], UNIT_NAMES = {}, WORLDS = {}, PASS = 70, ME = null;
let completed = new Set(), unitsPassed = new Set(), unitTests = {}, lessonsPerDay = -1, lessonsUsedToday = 0;
const LOCAL_KEY = 'c4k_lesson_progress';

function loggedIn() { return !!(typeof C4K !== 'undefined' && C4K.token()); }
function localCompleted() { try { return new Set(Object.keys(JSON.parse(localStorage.getItem(LOCAL_KEY)) || {})); } catch { return new Set(); } }
function saveLocal() { const o = {}; completed.forEach(id => o[id] = true); localStorage.setItem(LOCAL_KEY, JSON.stringify(o)); }

// ───────────────────────── load ─────────────────────────
async function load() {
  if (typeof C4K !== 'undefined') ME = await C4K.loadMe();
  // Lessons require an account - show the sign-in gate for logged-out visitors.
  if (typeof C4K !== 'undefined' && C4K.loginGate('Lessons')) return;
  document.getElementById('dashLink').style.display = (ME && ME.role === 'kid') ? '' : 'none';
  try {
    const ld = await (await fetch('/api/lessons')).json();
    LESSONS = (ld.lessons && ld.lessons.length) ? ld.lessons : LESSONS_SEED;
    UNIT_NAMES = ld.unitNames || {}; WORLDS = ld.worlds || {}; PASS = ld.passPercent || 70;
  } catch { LESSONS = LESSONS_SEED; }

  if (loggedIn()) {
    const pr = await C4K.api('/api/progress');
    if (pr.ok) {
      completed = new Set(pr.data.completed || []);
      unitsPassed = new Set((pr.data.unitsPassed || []));
      unitTests = pr.data.unitTests || {};
      lessonsPerDay = pr.data.lessonsPerDay !== undefined ? pr.data.lessonsPerDay : -1;
      lessonsUsedToday = pr.data.lessonsUsedToday || 0;
    }
  } else {
    completed = localCompleted(); lessonsPerDay = -1; lessonsUsedToday = 0;
  }
  render();
}

function unitOrder() { return [...new Set(LESSONS.map(l => l.unit || 1))].sort((a, b) => a - b); }
function lessonsIn(unit) { return LESSONS.filter(l => (l.unit || 1) === unit); }
function unitUnlocked(unit, order) {
  if (!loggedIn()) return true;            // offline: explore freely
  const idx = order.indexOf(unit);
  if (idx <= 0) return true;
  return unitsPassed.has(order[idx - 1]);  // previous unit's test must be passed
}
function limitReached() { return lessonsPerDay >= 0 && lessonsUsedToday >= lessonsPerDay; }
function totalXp() { return LESSONS.filter(l => completed.has(l.id)).reduce((s, l) => s + (l.xp || 0), 0); }
// Bite-sized: a friendly 5-10 minute estimate based on how many steps a lesson has.
function lessonMins(l) {
  const steps = (l && Array.isArray(l.steps)) ? l.steps.length : 3;
  return Math.max(5, Math.min(10, Math.round(steps * 1.5) + 3));
}

// ───────────────────────── render units ─────────────────────────
function render() {
  // COPPA: under-13 kids awaiting a parent's approval are fully locked out.
  if (C4K.consentLock(ME)) return;
  if (C4K.scheduleLock(ME)) return;
  // banner
  const level = unitsPassed.size + 1;
  document.getElementById('pbLevel').textContent = level;
  document.getElementById('pbDone').textContent = completed.size;
  document.getElementById('pbXp').textContent = totalXp();
  const pct = LESSONS.length ? Math.round(completed.size / LESSONS.length * 100) : 0;
  document.getElementById('pbBarPct').textContent = pct + '%';
  document.getElementById('pbFill').style.width = pct + '%';

  const order = unitOrder();
  const wrap = document.getElementById('unitsWrap');
  wrap.innerHTML = order.map((unit, i) => {
    const unlocked = unitUnlocked(unit, order);
    const ls = lessonsIn(unit);
    const allDone = ls.length > 0 && ls.every(l => completed.has(l.id));
    const passed = unitsPassed.has(unit);
    const world = WORLDS[unit] || { name: 'Unit ' + unit, emoji: '🗺️', color: 'var(--purple)', tagline: '', boss: { name: 'The Boss', emoji: '👾' } };
    const boss = world.boss || { name: 'The Boss', emoji: '👾' };

    const tiles = ls.map((l, n) => {
      const done = completed.has(l.id);
      const limitLock = !done && limitReached();
      const locked = !unlocked || limitLock;
      const reason = !unlocked ? '🔒 Pass the previous unit test first'
        : (limitLock ? `🌙 Daily limit reached - come back tomorrow!` : '');
      const click = !locked ? `onclick="openLesson('${l.id}')"`
        : (limitLock ? `onclick="openUpgrade()"` : '');
      return `<div class="lesson-tile ${done ? 'done' : ''} ${locked ? 'locked' : ''}" ${click}>
        <span class="corner">${done ? '✅' : (locked ? '🔒' : '')}</span>
        <div class="lesson-num">Lesson ${n + 1}</div>
        <h3>${l.emoji || ''} ${l.title}</h3>
        <p>${l.blurb || ''}</p>
        <div class="lesson-meta"><span class="lesson-time">⏱️ ~${lessonMins(l)} min</span><span class="lesson-xp">⚡ ${l.xp} XP</span></div>
        ${reason ? `<div class="lock-reason">${reason}</div>` : ''}
      </div>`;
    }).join('');

    // boss battle card (the unit test, themed)
    let test;
    const bossLine = `${boss.emoji} <strong>${boss.name}</strong>`;
    if (!unlocked) {
      test = `<div class="boss-card locked"><span class="boss-emoji">🔒</span><div class="utc-txt"><h4>Boss locked</h4><p>Defeat the previous world's boss to reach ${bossLine}.</p></div></div>`;
    } else if (!loggedIn()) {
      test = `<div class="boss-card"><span class="boss-emoji">${boss.emoji}</span><div class="utc-txt"><h4>Boss Battle: ${boss.name}</h4><p>Log in to battle the boss and level up!</p></div><a href="index.html" class="btn btn-outline">Log in</a></div>`;
    } else if (!allDone) {
      const left = ls.filter(l => !completed.has(l.id)).length;
      test = `<div class="boss-card"><span class="boss-emoji" style="opacity:.5;">${boss.emoji}</span><div class="utc-txt"><h4>Boss Battle: ${boss.name}</h4><p>Finish all ${ls.length} lessons to challenge the boss (${left} to go).</p></div></div>`;
    } else {
      const t = unitTests[unit] || {};
      const label = passed ? `Defeated! 🏆 best score ${t.bestScore || 0}%` : `Score ${PASS}% to defeat ${boss.name}!`;
      test = `<div class="boss-card ${passed ? 'beaten' : 'ready'}" style="--boss-color:${world.color};"><span class="boss-emoji">${passed ? '🏆' : boss.emoji}</span>
        <div class="utc-txt"><h4>⚔️ Boss Battle: ${boss.name}${passed ? ' - Defeated!' : ''}</h4><p>${label}</p></div>
        <button class="btn ${passed ? 'btn-outline' : 'btn-primary'}" onclick="openPledge(${unit})">${passed ? 'Rematch' : 'Battle!'}</button></div>`;
    }

    return `<section id="world-${unit}" class="unit world" style="--world-color:${world.color};scroll-margin-top:90px;">
      <div class="world-head">
        <span class="world-emoji">${world.emoji}</span>
        <div class="world-title">
          <h2>${world.name}</h2>
          <p>${world.tagline || ''}</p>
        </div>
        ${passed ? '<span class="world-badge done">✓ World Cleared</span>'
          : (unlocked ? '<span class="world-badge">In progress</span>' : '<span class="world-badge locked">🔒 Locked</span>')}
      </div>
      <div class="lesson-grid">${tiles}</div>
      ${test}
    </section>`;
  }).join('');
}

// ───────────────────────── interactive lesson viewer ─────────────────────────
let curLesson = null, screens = [], scr = 0, screenDone = [];

function buildScreens(l) {
  const s = [];
  (l.steps || []).forEach(step => s.push({ type: 'content', step }));
  // drag-and-drop: first multi-line code step becomes an "order the code" activity
  const codeStep = (l.steps || []).find(st => st.code && st.code.includes('\n'));
  if (codeStep) {
    const lines = codeStep.code.split('\n').filter(x => x.trim() !== '');
    if (lines.length >= 2 && lines.length <= 6) s.push({ type: 'drag', correct: lines });
  }
  if (l.quiz && l.quiz.q && l.quiz.opts) s.push({ type: 'quiz', quiz: l.quiz });
  return s;
}

function openLesson(id) {
  const l = LESSONS.find(x => x.id === id);
  if (!l) return;
  curLesson = l; screens = buildScreens(l); scr = 0; screenDone = screens.map(() => false);
  // content + (run not required); drag & quiz gate progress
  screens.forEach((s, i) => { if (s.type === 'content') screenDone[i] = true; });
  document.getElementById('lvEmoji').textContent = l.emoji || '🧩';
  document.getElementById('lvTitle').textContent = l.title;
  document.getElementById('lessonModal').classList.remove('hidden');
  renderScreen();
}
function closeLesson() { document.getElementById('lessonModal').classList.add('hidden'); curLesson = null; }

function renderDots() {
  document.getElementById('lvDots').innerHTML = screens.map((s, i) =>
    `<div class="lv-dot ${i === scr ? 'active' : ''} ${i < scr || screenDone[i] && i !== scr ? 'done' : ''}"></div>`).join('');
}

function renderScreen() {
  renderDots();
  const body = document.getElementById('lvBody');
  const s = screens[scr];
  const back = document.getElementById('lvBack'), next = document.getElementById('lvNext');
  back.style.visibility = scr === 0 ? 'hidden' : 'visible';

  if (s.type === 'content') {
    const st = s.step;
    let html = '<div class="lv-step">';
    if (st.h) html += `<h4>${st.h}</h4>`;
    if (st.p) html += `<p>${st.p}</p>`;
    if (st.code) {
      html += `<div class="lv-code">${st.code}</div>`;
      html += `<button class="btn btn-outline run-btn" onclick="runCode(${scr})">▶ Run this code</button><div id="runOut${scr}"></div>`;
    }
    if (st.tip) html += `<div class="lv-tip">${st.tip}</div>`;
    html += '</div>';
    body.innerHTML = html;
    next.disabled = false;
    next.textContent = 'Next →';
  }

  if (s.type === 'drag') {
    s.order = shuffle(s.correct.slice());
    body.innerHTML = `<div class="lv-step"><span class="activity-tag">🧲 Drag & Drop</span>
      <h4>Put the code in the right order</h4><p>Drag the lines so the program runs correctly.</p>
      <div class="drag-list" id="dragList"></div>
      <button class="btn btn-primary" onclick="checkDrag(${scr})">Check Order</button>
      <div class="feedback" id="dragFb"></div></div>`;
    renderDragList(s);
    next.disabled = !screenDone[scr];
    next.textContent = 'Next →';
  }

  if (s.type === 'quiz') {
    const q = s.quiz;
    body.innerHTML = `<div class="lv-step"><span class="activity-tag">🧠 Quick Check</span>
      <h4>${q.q}</h4><div id="mcqOpts">${q.opts.map((o, i) =>
        `<button class="mcq-opt" data-i="${i}" onclick="answerMcq(${scr},${i})">${o}</button>`).join('')}</div>
      <div class="feedback" id="mcqFb"></div></div>`;
    if (screenDone[scr]) { next.disabled = false; next.textContent = 'Finish 🎉'; }
    else { next.disabled = true; next.textContent = 'Finish 🎉'; }
  }
}

// run = visual demonstration + instant feedback
function runCode(i) {
  const code = screens[i].step.code || '';
  const prints = [...code.matchAll(/print\(\s*["']([^"']*)["']\s*\)/g)].map(m => m[1]);
  let out = prints.length ? prints.join('\n') : '✅ Code ran successfully!';
  document.getElementById('runOut' + i).innerHTML = `<div class="run-out">▶ Output:\n${out}</div>`;
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

function renderDragList(s) {
  const list = document.getElementById('dragList');
  list.innerHTML = s.order.map((line, i) => `<div class="drag-item" draggable="true" data-i="${i}"><span class="grip">⠿</span><span>${escapeHtml(line)}</span></div>`).join('');
  let dragFrom = null;
  list.querySelectorAll('.drag-item').forEach(el => {
    el.addEventListener('dragstart', e => { dragFrom = +el.dataset.i; el.classList.add('dragging'); });
    el.addEventListener('dragend', e => el.classList.remove('dragging'));
    el.addEventListener('dragover', e => e.preventDefault());
    el.addEventListener('drop', e => {
      e.preventDefault();
      const to = +el.dataset.i;
      if (dragFrom === null || dragFrom === to) return;
      const arr = s.order; const [m] = arr.splice(dragFrom, 1); arr.splice(to, 0, m);
      renderDragList(s);
    });
  });
}
function escapeHtml(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function checkDrag(i) {
  const s = screens[i];
  const ok = JSON.stringify(s.order) === JSON.stringify(s.correct);
  const fb = document.getElementById('dragFb');
  if (ok) {
    fb.textContent = '✅ Perfect order! Nice work!'; fb.style.color = 'var(--green)';
    screenDone[i] = true; document.getElementById('lvNext').disabled = false;
    document.querySelectorAll('#dragList .drag-item').forEach(e => e.classList.add('correct'));
  } else {
    const inPlace = s.order.filter((line, idx) => line === s.correct[idx]).length;
    // mark which lines are already correct so they can see what to fix
    document.querySelectorAll('#dragList .drag-item').forEach((e, idx) =>
      e.classList.toggle('correct', s.order[idx] === s.correct[idx]));
    fb.innerHTML = `❌ Not in order yet - <strong>${inPlace} of ${s.correct.length}</strong> lines are in the right spot (shown in green). ` +
      `💡 <strong>How to fix it:</strong> code runs top to bottom, so set things up (like making a variable) <em>before</em> you use them. Drag a line and press Check again.`;
    fb.style.color = '#f87171';
  }
}

function answerMcq(i, choice) {
  const q = screens[i].quiz;
  const opts = document.querySelectorAll('#mcqOpts .mcq-opt');
  const fb = document.getElementById('mcqFb');
  if (choice === q.answer) {
    opts.forEach(o => o.disabled = true);
    opts[choice].classList.add('correct');
    fb.textContent = '🎉 Correct! You finished the lesson!'; fb.style.color = 'var(--green)';
    screenDone[i] = true;
    const next = document.getElementById('lvNext');
    next.disabled = false; next.textContent = 'Finish 🎉';
    finishLessonSave();   // auto-save completion (no Mark Complete button)
  } else {
    screens[i]._wrong = (screens[i]._wrong || 0) + 1;
    opts[choice].classList.add('wrong');
    opts[choice].disabled = true;                    // can't pick the same wrong one again
    const fix = q.explain ? ` 💡 <strong>How to fix it:</strong> ${q.explain}` : '';
    if (screens[i]._wrong >= 2) {                     // after 2 tries, show the right one
      opts[q.answer].classList.add('correct');
      fb.innerHTML = `❌ Not quite.${fix} The right answer is highlighted green - tap it to continue. 💪`;
    } else {
      fb.innerHTML = `❌ Not quite.${fix} Read the hint and try again - you've got this! 💪`;
    }
    fb.style.color = '#f87171';
  }
}

let savedThisLesson = false;
async function finishLessonSave() {
  if (savedThisLesson || !curLesson) return;
  savedThisLesson = true;
  const fb = document.getElementById('mcqFb');
  if (loggedIn()) {
    const { ok, data } = await C4K.api('/api/progress', 'POST', { lessonId: curLesson.id });
    if (ok) {
      completed = new Set(data.completed);
      if (data.lessonsUsedToday !== undefined) lessonsUsedToday = data.lessonsUsedToday;
      if (data.tokensAwarded && fb) fb.textContent = `🎉 Lesson complete! 🪙 +${data.tokensAwarded} tokens earned!`;
    } else if (data.limitReached) {
      savedThisLesson = false;
      lessonsUsedToday = lessonsPerDay; // update local count so tiles show as locked
      closeLesson();
      openUpgrade();
    }
  } else {
    completed.add(curLesson.id); saveLocal();
  }
}

// ── Lesson-limit / upgrade popup (the only upgrade prompt in the app) ──
function openUpgrade() {
  const acts = document.getElementById('upgradeActions');
  document.getElementById('upgradeDone').classList.add('hidden');
  const limitTxt = lessonsPerDay > 0 ? `You've done ${lessonsPerDay} lesson${lessonsPerDay===1?'':'s'} today — that's your daily limit.` : "You've reached your daily lesson limit.";
  document.getElementById('upgradeSub').textContent = limitTxt + ' Upgrade for unlimited daily lessons, or come back tomorrow!';
  // show the pricing (this is the only place pricing appears)
  const pricing = document.getElementById('upgradePricing');
  if (pricing && typeof C4K !== 'undefined') pricing.innerHTML = C4K.pricingHTML({ buy: true });
  if (ME && ME.role === 'kid') {
    acts.classList.remove('hidden');
    acts.innerHTML = `<button class="btn btn-primary btn-lg btn-full" onclick="askParentUpgrade()">Ask my parent 👨‍👩‍👧</button>`;
  } else {
    acts.innerHTML = '';
  }
  document.getElementById('upgradeModal').classList.remove('hidden');
}
function closeUpgrade() { document.getElementById('upgradeModal').classList.add('hidden'); }
async function askParentUpgrade() {
  const { ok, data } = await C4K.api('/api/request-upgrade', 'POST', {});
  const done = document.getElementById('upgradeDone');
  document.getElementById('upgradeActions').innerHTML = '';
  done.classList.remove('hidden');
  done.textContent = ok
    ? (data.parentEmail ? `✅ We let your parent (${data.parentEmail}) know!` : '✅ Message sent to your parent!')
    : '⚠️ Could not send right now.';
}
document.getElementById('upgradeModal')?.addEventListener('click', e => { if (e.target.id === 'upgradeModal') closeUpgrade(); });

function lvPrev() { if (scr > 0) { scr--; renderScreen(); } }
function lvNext() {
  const s = screens[scr];
  if (s.type === 'drag' && !screenDone[scr]) return;
  if (s.type === 'quiz') {
    if (!screenDone[scr]) return;
    savedThisLesson = false; closeLesson(); render(); celebrate(curLessonTitleCache);
    return;
  }
  if (scr < screens.length - 1) { scr++; renderScreen(); }
}
let curLessonTitleCache = '';
function celebrate(t) { /* lightweight */ }

document.getElementById('lessonModal')?.addEventListener('click', e => { if (e.target.id === 'lessonModal') closeLesson(); });

// ───────────────────────── boss battle + pledge ─────────────────────────
let pendingUnit = null, testQuestions = [], pendingBoss = null;

function openPledge(unit) {
  if (!loggedIn()) { window.location.href = 'index.html'; return; }
  pendingUnit = unit;
  document.getElementById('pledgeCheck').checked = false;
  document.getElementById('pledgeStart').disabled = true;
  document.getElementById('pledgeModal').classList.remove('hidden');
}
function closePledge() { document.getElementById('pledgeModal').classList.add('hidden'); }

async function startTest() {
  closePledge();
  const res = await C4K.api('/api/test/' + pendingUnit);
  if (!res.ok) { alert('Could not load the test.'); return; }
  testQuestions = res.data.questions || [];
  pendingBoss = res.data.boss || (WORLDS[pendingUnit] && WORLDS[pendingUnit].boss) || { name: 'The Boss', emoji: '👾' };
  document.getElementById('testTitle').textContent = `⚔️ Boss Battle: ${pendingBoss.emoji} ${pendingBoss.name}`;
  document.getElementById('testNote').textContent = `Score ${res.data.passPercent}% to defeat the boss · ${testQuestions.length} questions`;
  document.getElementById('testSubmit').style.display = '';
  document.getElementById('testSubmit').textContent = '⚔️ Attack!';
  document.getElementById('testSubmit').onclick = submitTest;
  document.getElementById('testBody').innerHTML = testQuestions.map((q, i) =>
    `<div class="test-q"><div class="qn">${i + 1}. ${q.q}</div>${q.opts.map((o, j) =>
      `<label class="mcq-opt"><input type="radio" name="tq${i}" value="${j}" style="margin-right:10px;">${o}</label>`).join('')}</div>`).join('');
  document.getElementById('testModal').classList.remove('hidden');
}
function closeTest() { document.getElementById('testModal').classList.add('hidden'); }

async function submitTest() {
  const answers = testQuestions.map((q, i) => {
    const sel = document.querySelector(`input[name="tq${i}"]:checked`);
    return sel ? +sel.value : -1;
  });
  if (answers.includes(-1) && !confirm('You left some questions blank. Submit anyway?')) return;
  const { ok, data } = await C4K.api('/api/test/submit', 'POST', { unit: pendingUnit, answers });
  if (!ok) { alert(data.error || 'Could not submit.'); return; }
  unitsPassed = new Set(data.unitsPassed || []);
  // result screen
  document.getElementById('testNote').textContent = '';
  document.getElementById('testSubmit').style.display = 'none';
  const cls = data.passed ? 'pass' : 'fail';
  const boss = pendingBoss || { name: 'The Boss', emoji: '👾' };
  document.getElementById('testBody').innerHTML = `
    <div class="test-result ${cls}">
      <div style="font-size:3rem;">${data.passed ? '🏆' : boss.emoji}</div>
      <div class="big">${data.score}%</div>
      <h3 style="font-weight:900;margin:6px 0;">${data.passed ? `🎉 You defeated ${boss.name}!` : `💪 ${boss.name} is still standing!`}</h3>
      <p style="color:var(--text-dim);">You got ${data.correct} of ${data.total} right (need ${data.passPercent}%).</p>
      ${data.passed ? `<p style="color:var(--green);font-weight:800;margin-top:10px;">⬆️ Level up! You're now Level ${data.level}. The next world is unlocked! 🗺️</p>`
        : `<p style="color:var(--text-dim);font-size:0.85rem;margin-top:8px;">Review the lessons and rematch the boss - you can try as many times as you need.</p>`}
      <div style="margin-top:14px;display:flex;gap:6px;justify-content:center;flex-wrap:wrap;">
        ${data.results.map((r, i) => `<span title="Q${i + 1}" style="font-size:1.1rem;">${r ? '✅' : '❌'}</span>`).join('')}
      </div>
      ${(data.feedback || []).some(f => !f.ok) ? `
        <div style="margin-top:16px;text-align:left;background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;">
          <div style="font-weight:900;margin-bottom:8px;">🔧 How to fix the ones you missed:</div>
          ${data.feedback.map((f, i) => f.ok ? '' :
            `<div style="margin-bottom:10px;font-size:0.86rem;">
               <div style="font-weight:800;color:#f87171;">❌ Q${i + 1}: ${f.question}</div>
               <div style="color:var(--text);">💡 ${f.fix}</div>
               <div style="color:var(--text-faint);font-size:0.8rem;">Review: ${f.review}</div>
             </div>`).join('')}
        </div>` : ''}
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:center;">
        ${data.passed ? `<button class="btn btn-primary" onclick="closeTest();render();">Onward! 🗺️</button>`
          : `<button class="btn btn-outline" onclick="closeTest();render();">Review Lessons</button>
             <button class="btn btn-primary" onclick="openPledge(${pendingUnit})">⚔️ Rematch</button>`}
      </div>
    </div>`;
}
document.getElementById('testModal')?.addEventListener('click', e => { if (e.target.id === 'testModal') closeTest(); });

function showPolicy() { document.getElementById('policyModal').classList.remove('hidden'); }
document.getElementById('policyModal')?.addEventListener('click', e => { if (e.target.id === 'policyModal') e.currentTarget.classList.add('hidden'); });

load();
