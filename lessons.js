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
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${passed ? `<a class="btn btn-primary" href="certificate.html?unit=${unit}">🏆 Certificate</a>` : ''}
          <button class="btn ${passed ? 'btn-outline' : 'btn-primary'}" onclick="openPledge(${unit})">${passed ? 'Rematch' : 'Battle!'}</button>
        </div></div>`;
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

// ── Bonus question bank — extra questions generated per lesson topic ──────
const BONUS_BANK = [
  { tag:'print', q:'What does <code>print("Hi")</code> do?', opts:['Shows Hi on screen','Stores Hi in a variable','Deletes Hi','Nothing'], answer:0, explain:'print() displays text on the screen.' },
  { tag:'variable', q:'What is a variable?', opts:['A bug in code','A box that stores a value','A type of loop','A Python keyword'], answer:1, explain:'Variables store values like numbers or text.' },
  { tag:'variable', q:'Which creates a variable called <code>age</code> with value 12?', opts:['12 = age','age == 12','age = 12','var age 12'], answer:2, explain:'In Python, = assigns a value to a name.' },
  { tag:'loop', q:'How many times does <code>for i in range(5):</code> loop?', opts:['4','5','6','range'], answer:1, explain:'range(5) gives 0,1,2,3,4 — that\'s 5 times.' },
  { tag:'loop', q:'What keyword starts a loop in Python?', opts:['repeat','loop','for','while-start'], answer:2, explain:'for and while are both loop keywords in Python.' },
  { tag:'if', q:'What does an <code>if</code> statement do?', opts:['Loops forever','Makes a choice','Prints text','Stores a value'], answer:1, explain:'if checks a condition and runs code only if it\'s True.' },
  { tag:'if', q:'Which symbol means "is equal to" in Python?', opts:['=','===','==','!='], answer:2, explain:'== checks equality. = assigns a value.' },
  { tag:'function', q:'What keyword defines a function in Python?', opts:['func','function','define','def'], answer:3, explain:'def is short for define. Example: def hello():' },
  { tag:'function', q:'How do you run (call) a function called <code>greet</code>?', opts:['def greet()','run greet','greet()','call greet'], answer:2, explain:'You call a function by writing its name with ().' },
  { tag:'list', q:'How do you get the first item from <code>items = [10, 20, 30]</code>?', opts:['items[1]','items[0]','items.first','items(0)'], answer:1, explain:'Lists start at index 0, so items[0] is the first item.' },
  { tag:'string', q:'Which is a valid string in Python?', opts:['hello','123','\'hello\'','#hello'], answer:2, explain:'Strings are text inside quotes: \'hello\' or "hello".' },
  { tag:'string', q:'What does <code>len("code")</code> return?', opts:['3','4','5','code'], answer:1, explain:'len() counts characters. c-o-d-e = 4 characters.' },
  { tag:'math', q:'What does <code>10 % 3</code> return in Python?', opts:['3','1','0','3.3'], answer:1, explain:'% is the remainder (modulo). 10 ÷ 3 = 3 remainder 1.' },
  { tag:'math', q:'What is <code>2 ** 3</code> in Python?', opts:['6','8','9','23'], answer:1, explain:'** means "to the power of". 2³ = 2×2×2 = 8.' },
  { tag:'bool', q:'Which of these is a boolean?', opts:['"True"','1','True','true'], answer:2, explain:'Booleans are True or False with a capital letter in Python.' },
  { tag:'input', q:'What does <code>input()</code> do?', opts:['Prints text','Asks the user to type something','Creates a variable','Loops through a list'], answer:1, explain:'input() pauses and waits for the user to type.' },
  { tag:'error', q:'What type of error is a missing <code>:</code> after <code>if x > 5</code>?', opts:['NameError','SyntaxError','ValueError','TypeError'], answer:1, explain:'Missing colons and wrong indentation cause SyntaxError.' },
  { tag:'indent', q:'In Python, how do you indent code inside an if statement?', opts:['With a tab or 4 spaces','With curly braces {}','With a colon :','With parentheses ()'], answer:0, explain:'Python uses indentation (spaces/tabs) to group code.' },
  { tag:'comment', q:'How do you write a comment in Python?', opts:['// comment','/* comment */','# comment','-- comment'], answer:2, explain:'Python comments start with # and the computer ignores them.' },
  { tag:'type', q:'What type is the value <code>3.14</code>?', opts:['int','string','float','bool'], answer:2, explain:'Numbers with a decimal point are floats in Python.' },
];

function extraQuestionsFor(lesson) {
  const text = ((lesson.title || '') + ' ' + (lesson.steps || []).map(s => (s.h || '') + ' ' + (s.p || '')).join(' ')).toLowerCase();
  const scored = BONUS_BANK.map(q => ({ q, score: text.includes(q.tag) ? 2 : 1 }));
  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
  return scored.map(x => x.q);
}

function buildQuizSet(lesson) {
  const qs = [];
  // Always use the lesson's own question first. The server no longer ships the answer
  // (anti-cheat) — tag it with the lessonId so grading goes through /api/quiz/answer.
  if (lesson.quiz && lesson.quiz.q) qs.push(Object.assign({}, lesson.quiz, { lessonId: lesson.id }));
  // Also use quizzes array if present (future-proof)
  if (Array.isArray(lesson.quizzes)) lesson.quizzes.forEach(q => { if (!qs.find(x => x.q === q.q)) qs.push(q); });
  // Pad to 5 with bonus questions, avoiding duplicates
  const extras = extraQuestionsFor(lesson);
  for (const e of extras) {
    if (qs.length >= 5) break;
    if (!qs.find(x => x.q === e.q)) qs.push(e);
  }
  return shuffle(qs.slice(0, 5));
}

// ── Prompt Lab: rotating prompting SKILLS kids practice (not answers) ──────
const PROMPT_SKILLS = [
  {
    name: 'Be Specific',
    emoji: '🎯',
    teach: 'Don\'t just say "explain this." Tell the AI <strong>exactly</strong> what you want, how much, and who it\'s for.',
    weak: 'tell me about this',
    checks: [
      { test: p => p.split(/\s+/).length >= 6, ok: 'Nice length — enough detail!', tip: 'Add more detail. What exactly do you want to know?' },
      { test: p => /\d|example|list|step|simple|short/i.test(p), ok: 'You asked for something specific!', tip: 'Add a specific ask — like "give 2 examples" or "keep it short".' },
    ],
  },
  {
    name: 'Give a Role',
    emoji: '🎭',
    teach: 'Start with <strong>"Act as a…"</strong> to make the AI answer like an expert. Example: "Act as a friendly teacher."',
    weak: 'how does this work',
    checks: [
      { test: p => /act as|pretend|you are|imagine you/i.test(p), ok: 'Great — you gave the AI a role!', tip: 'Try starting with "Act as a…" to give the AI a role.' },
      { test: p => p.split(/\s+/).length >= 6, ok: 'Good detail!', tip: 'Add what you actually want after the role.' },
    ],
  },
  {
    name: 'Give Context',
    emoji: '🗂️',
    teach: 'The AI can\'t read your mind. Tell it <strong>what you already know</strong> and <strong>what you\'re stuck on</strong>.',
    weak: 'help me',
    checks: [
      { test: p => /i (am|know|tried|want|need|understand)|my |already|stuck|beginner/i.test(p), ok: 'You gave the AI context about you!', tip: 'Add context — like "I already know X" or "I\'m stuck on Y".' },
      { test: p => p.split(/\s+/).length >= 7, ok: 'Nice and detailed!', tip: 'A bit more detail helps the AI understand.' },
    ],
  },
  {
    name: 'Ask for Examples',
    emoji: '📋',
    teach: 'Ask the AI to <strong>show</strong> you, not just tell you. Examples make ideas click. Say "give me 3 examples."',
    weak: 'what is this',
    checks: [
      { test: p => /example|show me|for instance|like|such as/i.test(p), ok: 'You asked for examples — smart!', tip: 'Add "give me examples" or "show me" to your prompt.' },
      { test: p => /\d/.test(p), ok: 'You asked for a specific number!', tip: 'Try asking for a specific number, like "3 examples".' },
    ],
  },
  {
    name: 'Set the Format',
    emoji: '📐',
    teach: 'Tell the AI <strong>how you want the answer</strong>: a list, steps, a table, or "in 3 sentences."',
    weak: 'explain everything',
    checks: [
      { test: p => /list|step|table|bullet|sentence|paragraph|short|3|numbered/i.test(p), ok: 'You set a format — perfect!', tip: 'Add a format, like "as a list" or "in 3 steps".' },
      { test: p => p.split(/\s+/).length >= 6, ok: 'Good detail!', tip: 'Say more about what you want.' },
    ],
  },
  {
    name: 'Iterate & Improve',
    emoji: '🔄',
    teach: 'If the first answer isn\'t right, <strong>tell the AI what to fix</strong>: "make it simpler" or "add more detail."',
    weak: 'thats wrong',
    checks: [
      { test: p => /make it|simpler|shorter|longer|add|change|instead|more|less|focus/i.test(p), ok: 'You gave clear feedback to improve it!', tip: 'Tell the AI HOW to change it: "make it simpler" or "add examples".' },
      { test: p => p.split(/\s+/).length >= 4, ok: 'Clear direction!', tip: 'Be clearer about what to change.' },
    ],
  },
];

// Pick a skill to practice — rotates so kids learn all of them over time
function pickPromptSkill(lesson) {
  const seed = (lesson.id || '').replace(/\D/g, '') || (lesson.title || '').length;
  return PROMPT_SKILLS[parseInt(seed, 10) % PROMPT_SKILLS.length];
}

function buildScreens(l) {
  const s = [];
  (l.steps || []).forEach(step => s.push({ type: 'content', step }));
  // drag-and-drop: first multi-line code step becomes an "order the code" activity
  const codeStep = (l.steps || []).find(st => st.code && st.code.includes('\n'));
  if (codeStep) {
    const lines = codeStep.code.split('\n').filter(x => x.trim() !== '');
    if (lines.length >= 2 && lines.length <= 6) s.push({ type: 'drag', correct: lines });
  }
  // 🤖 Prompt Lab — kids WRITE their own prompt and get feedback on it
  s.push({ type: 'prompt_lab', skill: pickPromptSkill(l), topic: l.title, done: false });
  // 5-question quiz set instead of single question
  if (l.quiz || (l.quizzes && l.quizzes.length)) {
    s.push({ type: 'quiz_set', questions: buildQuizSet(l), qi: 0, correct: 0, done: false, attempts: 0 });
  }
  return s;
}

function openLesson(id) {
  const l = LESSONS.find(x => x.id === id);
  if (!l) return;
  curLesson = l; screens = buildScreens(l); scr = 0; screenDone = screens.map(() => false);
  savedThisLesson = false;
  // content auto-completes; drag + quiz_set require interaction
  screens.forEach((s, i) => { if (s.type === 'content') screenDone[i] = true; });
  document.getElementById('lvEmoji').textContent = l.emoji || '🧩';
  document.getElementById('lvTitle').textContent = l.title;
  document.getElementById('lessonModal').classList.remove('hidden');
  renderScreen();
}
function closeLesson() { document.getElementById('lessonModal').classList.add('hidden'); curLesson = null; }

async function reportLesson() {
  if (!curLesson) return;
  const reason = prompt('What\'s wrong with this lesson? (optional)') ?? '';
  const { ok } = await C4K.api('/api/report-lesson', 'POST', { lessonId: curLesson.id, reason });
  if (ok) {
    const btn = document.getElementById('reportLessonBtn');
    if (btn) { btn.textContent = '✅ Reported'; btn.disabled = true; }
  }
}

function renderDots() {
  document.getElementById('lvDots').innerHTML = screens.map((s, i) =>
    `<div class="lv-dot ${i === scr ? 'active' : ''} ${i < scr || screenDone[i] && i !== scr ? 'done' : ''}"></div>`).join('');
}

function renderScreen() {
  renderDots();
  const body = document.getElementById('lvBody');
  const s = screens[scr];
  const back = document.getElementById('lvBack'), next = document.getElementById('lvNext');

  // ── No going back during quiz — can't peek at answers ──
  if (s.type === 'quiz_set') {
    back.style.visibility = 'hidden';
    next.style.display = 'none';
  } else {
    back.style.visibility = scr === 0 ? 'hidden' : 'visible';
    next.style.display = '';
  }

  if (s.type === 'content') {
    const st = s.step;
    let html = '<div class="lv-step">';
    if (st.h) html += `<h4>${st.h}</h4>`;
    if (st.p) html += `<p>${st.p}</p>`;
    if (st.code) {
      // Vibe: syntax-highlight keywords in code
      const highlighted = escapeHtml(st.code)
        .replace(/\b(def|for|if|else|elif|while|return|import|from|in|not|and|or|True|False|None|class|try|except|with|as|pass|break|continue|lambda|yield)\b/g,
          '<span style="color:#c084fc;font-weight:700;">$1</span>')
        .replace(/\b(print|input|len|range|int|str|float|list|dict|type|append|split|join)\b(?=\s*\()/g,
          '<span style="color:#67e8f9;">$1</span>')
        .replace(/(["'])([^"']*)\1/g, '<span style="color:#86efac;">$1$2$1</span>')
        .replace(/(#[^\n]*)/g, '<span style="color:#6b7280;font-style:italic;">$1</span>');
      html += `<div class="lv-code" style="line-height:1.7;">${highlighted}</div>`;
      html += `<button class="btn btn-outline run-btn" onclick="runCode(${scr})">▶ Run this code</button><div id="runOut${scr}"></div>`;
    }
    if (st.tip) html += `<div class="lv-tip">💡 ${st.tip}</div>`;
    html += '</div>';
    body.innerHTML = html;
    next.disabled = false;
    next.textContent = 'Next →';
  }

  if (s.type === 'drag') {
    if (!s._shuffled) { s.order = shuffle(s.correct.slice()); s._shuffled = true; }
    body.innerHTML = `<div class="lv-step">
      <span class="activity-tag">🧲 Drag & Drop</span>
      <h4>Put the code in the right order</h4>
      <p style="color:var(--text-dim);margin-bottom:12px;">Drag the lines so the program runs top to bottom correctly.</p>
      <div class="drag-list" id="dragList"></div>
      <button class="btn btn-primary" onclick="checkDrag(${scr})">✅ Check Order</button>
      <div class="feedback" id="dragFb"></div></div>`;
    renderDragList(s);
    next.disabled = !screenDone[scr];
    next.textContent = 'Next →';
  }

  if (s.type === 'prompt_lab') {
    back.style.visibility = 'visible';
    next.style.display = '';
    next.textContent = 'Next →';
    next.disabled = !s.done;   // must try a prompt before moving on
    const sk = s.skill;
    body.innerHTML = `<div class="lv-step">
      <span class="activity-tag" style="background:rgba(6,182,212,0.15);color:#22d3ee;">🤖 Prompt Lab · Skill: ${sk.emoji} ${sk.name}</span>
      <h4 style="margin:10px 0 8px;">Learn to talk to AI</h4>
      <div style="background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.3);border-radius:12px;padding:14px 16px;margin-bottom:14px;">
        <div style="font-weight:900;color:#22d3ee;margin-bottom:4px;">${sk.emoji} Skill: ${sk.name}</div>
        <div style="color:var(--text);font-size:0.9rem;line-height:1.6;">${sk.teach}</div>
      </div>
      <p style="color:var(--text-dim);font-size:0.88rem;margin-bottom:8px;">
        👉 Now <strong>you</strong> try it. Write a prompt to ask an AI about <strong>"${escapeHtml(s.topic)}"</strong> using this skill:
      </p>
      <textarea id="promptInput" rows="3" placeholder="Write your own prompt here…"
        style="width:100%;box-sizing:border-box;background:#0a0618;border:1px solid var(--border);border-radius:12px;padding:12px 14px;color:var(--text);font-family:inherit;font-size:0.92rem;line-height:1.5;resize:vertical;"
        oninput="document.getElementById('checkPromptBtn').disabled = this.value.trim().length < 3;">${escapeHtml(s._draft || '')}</textarea>
      <button class="btn btn-primary" id="checkPromptBtn" style="margin-top:10px;" onclick="checkPrompt()" disabled>✨ Check my prompt</button>
      <div id="promptFeedback" style="margin-top:14px;"></div>
    </div>`;
  }

  if (s.type === 'quiz_set') {
    renderQuizSet(s);
  }
}

function checkPrompt() {
  const s = screens[scr];
  const input = document.getElementById('promptInput');
  const p = (input.value || '').trim();
  s._draft = p;
  const fb = document.getElementById('promptFeedback');
  const sk = s.skill;

  // Grade the prompt against the skill's checks
  const results = sk.checks.map(c => ({ passed: c.test(p), ok: c.ok, tip: c.tip }));
  const passedCount = results.filter(r => r.passed).length;
  const strong = passedCount === results.length;

  let html = `<div style="background:${strong ? 'rgba(52,211,153,0.1)' : 'rgba(251,191,36,0.1)'};border:1px solid ${strong ? 'var(--green)' : '#fbbf24'};border-radius:12px;padding:14px 16px;">`;
  html += `<div style="font-weight:900;color:${strong ? 'var(--green)' : '#fbbf24'};margin-bottom:8px;">${strong ? '🌟 Great prompt!' : '💪 Good start — make it stronger:'}</div>`;
  html += '<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px;">';
  results.forEach(r => {
    html += `<li style="font-size:0.86rem;color:var(--text);display:flex;gap:8px;">
      <span>${r.passed ? '✅' : '💡'}</span><span>${r.passed ? r.ok : r.tip}</span></li>`;
  });
  html += '</ul>';
  if (!strong) html += `<div style="margin-top:10px;font-size:0.82rem;color:var(--text-dim);">Try editing your prompt above and check again — or move on, you\'ve got the idea! 👍</div>`;
  html += '</div>';
  fb.innerHTML = html;

  // Any attempt unlocks Next (we're teaching, not gating)
  s.done = true;
  screenDone[scr] = true;
  document.getElementById('lvNext').disabled = false;
}

// ── 5-question quiz set with 80% pass ──────────────────────────────────────
function renderQuizSet(s) {
  const body = document.getElementById('lvBody');
  if (s.done) {
    // Show results
    const pct = Math.round((s.correct / s.questions.length) * 100);
    const passed = pct >= 80;
    // Failing 3 times uses up one of today's lessons — but the lesson is NOT complete.
    const usedUp = !passed && (s.attempts || 0) >= 3;
    if (usedUp && !s._counted) { s._counted = true; countFailedLesson(); }
    body.innerHTML = `<div class="lv-step" style="text-align:center;">
      <div style="font-size:3rem;margin-bottom:10px;">${passed ? '🎉' : (usedUp ? '📚' : '😤')}</div>
      <h4 style="font-size:1.4rem;margin-bottom:6px;">${passed ? 'You passed!' : (usedUp ? 'Keep practicing!' : 'So close!')}</h4>
      <div style="font-size:2.5rem;font-weight:900;color:${passed ? 'var(--green)' : '#f87171'};margin:10px 0;">${s.correct}/${s.questions.length}</div>
      <div style="color:var(--text-dim);margin-bottom:20px;">${pct}% — need 80% to pass</div>
      ${passed
        ? `<div class="feedback" id="mcqFb" style="color:var(--green);font-weight:800;">✅ Lesson complete!</div>`
        : (usedUp
          ? `<div style="background:rgba(245,158,11,0.12);border:1px solid #f59e0b;border-radius:12px;padding:14px 16px;margin-bottom:14px;color:#fbbf24;font-weight:800;font-size:0.9rem;">📚 That used one of today's lessons — but you still need to pass it to complete it!</div>
             <button class="btn btn-primary btn-lg" onclick="retryQuiz()">🔄 Try again</button>
             <p style="color:var(--text-dim);font-size:0.82rem;margin-top:10px;">Review the lesson, then pass the quiz to finish it. 💪</p>`
          : `<button class="btn btn-primary btn-lg" onclick="retryQuiz()">🔄 Try again</button>
             <p style="color:var(--text-dim);font-size:0.82rem;margin-top:10px;">Try ${3 - (s.attempts || 0)} more time${3 - (s.attempts || 0) === 1 ? '' : 's'} before it counts as a lesson. You've got this! 💪</p>`)}
    </div>`;
    if (passed) {
      screenDone[scr] = true;
      document.getElementById('lvNext').style.display = '';
      document.getElementById('lvNext').disabled = false;
      document.getElementById('lvNext').textContent = 'Finish 🎉';
      if (window.C4K) C4K.sound.win();
      finishLessonSave();
    }
    return;
  }

  const qi = s.qi;
  const q = s.questions[qi];
  const progress = `${qi + 1} of ${s.questions.length}`;
  const pips = s.questions.map((_, i) =>
    `<div style="flex:1;height:5px;border-radius:50px;background:${i < qi ? 'var(--green)' : i === qi ? 'var(--purple-mid)' : 'var(--border)'};"></div>`
  ).join('');

  body.innerHTML = `<div class="lv-step">
    <div style="display:flex;gap:4px;margin-bottom:14px;">${pips}</div>
    <div style="display:flex;justify-content:space-between;margin-bottom:10px;">
      <span class="activity-tag">🧠 Question ${progress}</span>
      <span style="font-size:0.75rem;color:var(--text-faint);font-weight:700;">${s.correct} correct so far</span>
    </div>
    <h4 style="margin-bottom:16px;line-height:1.5;">${q.q}</h4>
    <div id="quizOpts" style="display:flex;flex-direction:column;gap:10px;">
      ${shuffle(q.opts.map((o, i) => ({ o, i }))).map(({ o, i }) =>
        `<button class="mcq-opt" data-ans="${i}" onclick="answerQuizSet(${i})">${o}</button>`
      ).join('')}
    </div>
    <div id="quizFb" style="margin-top:12px;font-weight:800;min-height:1.2em;"></div>
  </div>`;
}

async function answerQuizSet(choice) {
  const s = screens[scr];
  const q = s.questions[s.qi];
  const opts = document.querySelectorAll('#quizOpts .mcq-opt');
  const fb = document.getElementById('quizFb');

  // Disable all buttons immediately — can't go back
  opts.forEach(btn => btn.disabled = true);

  // Lesson questions are graded on the SERVER (the answer never reaches the browser
  // until after you've committed to a choice). Bonus-bank questions grade locally.
  let correct, answerIdx = q.answer, explain = q.explain;
  if (answerIdx === undefined && q.lessonId) {
    fb.style.color = 'var(--text-dim)'; fb.textContent = '🤔 Checking…';
    const { ok, data } = await C4K.api('/api/quiz/answer', 'POST', { lessonId: q.lessonId, choice });
    if (!ok) {  // network hiccup: don't count it — let them tap again
      fb.style.color = '#f87171';
      fb.textContent = (data && data.error) || '⚠️ Could not check — tap your answer again.';
      opts.forEach(btn => btn.disabled = false);
      return;
    }
    correct = data.correct; answerIdx = data.answer; explain = data.explain;
  } else {
    correct = choice === answerIdx;
  }

  opts.forEach(btn => { if (+btn.dataset.ans === answerIdx) btn.classList.add('correct'); });
  if (!correct) opts.forEach(btn => { if (+btn.dataset.ans === choice) btn.classList.add('wrong'); });

  if (correct) {
    s.correct++;
    fb.innerHTML = `✅ Correct! ${explain ? '<span style="color:var(--text-dim);font-weight:700;">' + explain + '</span>' : ''}`;
    fb.style.color = 'var(--green)';
    if (window.C4K) C4K.sound.correct();
  } else {
    fb.innerHTML = `❌ Not quite. ${explain ? '<span style="color:var(--text-dim);font-weight:700;">' + explain + '</span>' : 'Keep going!'}`;
    fb.style.color = '#f87171';
    if (window.C4K) C4K.sound.wrong();
  }

  // Auto-advance after 1.4 seconds
  setTimeout(() => {
    s.qi++;
    if (s.qi >= s.questions.length) {
      s.done = true;
      // Count a failed run toward the 3-try limit.
      const pct = (s.correct / s.questions.length) * 100;
      if (pct < 80) s.attempts = (s.attempts || 0) + 1;
    }
    renderQuizSet(s);
  }, 1400);
}

function retryQuiz() {
  const s = screens[scr];
  s.qi = 0; s.correct = 0; s.done = false;
  s.questions = buildQuizSet(curLesson); // fresh shuffle (attempts count preserved)
  renderQuizSet(s);
}

// Failing 3 times uses one of today's lessons (server-side), but does NOT complete it.
async function countFailedLesson() {
  bumpDailyGoal();
  if (loggedIn() && curLesson) {
    const { ok, data } = await C4K.api('/api/lesson/count-attempt', 'POST', { lessonId: curLesson.id });
    if (ok && data.lessonsUsedToday !== undefined) lessonsUsedToday = data.lessonsUsedToday;
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

// Legacy single-question handler (kept for any old quiz type still in memory)
async function answerMcq(i, choice) {
  const q = screens[i].quiz;
  if (!q) return;
  const opts = document.querySelectorAll('#mcqOpts .mcq-opt');
  const fb = document.getElementById('mcqFb');
  opts.forEach(o => o.disabled = true);
  let correct, answerIdx = q.answer;
  if (answerIdx === undefined && curLesson) {  // answers live server-side now
    const { ok, data } = await C4K.api('/api/quiz/answer', 'POST', { lessonId: curLesson.id, choice });
    if (!ok) { fb.textContent = '⚠️ Could not check — tap your answer again.'; fb.style.color = '#f87171'; opts.forEach(o => o.disabled = false); return; }
    correct = data.correct; answerIdx = data.answer;
  } else {
    correct = choice === answerIdx;
  }
  opts[choice].classList.add(correct ? 'correct' : 'wrong');
  if (correct) {
    fb.textContent = '🎉 Correct!'; fb.style.color = 'var(--green)';
    screenDone[i] = true;
    document.getElementById('lvNext').disabled = false;
    document.getElementById('lvNext').textContent = 'Finish 🎉';
    finishLessonSave();
  } else {
    if (answerIdx !== undefined && opts[answerIdx]) opts[answerIdx].classList.add('correct');
    fb.textContent = '❌ Not quite — but you can still finish!'; fb.style.color = '#f87171';
    screenDone[i] = true;
    document.getElementById('lvNext').disabled = false;
    document.getElementById('lvNext').textContent = 'Finish 🎉';
  }
}

let savedThisLesson = false;
function isoWeekKey() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;               // Mon=0
  d.setDate(d.getDate() - day);                   // back to Monday
  return d.toISOString().slice(0, 10);            // Monday's date = week id
}
function bumpDailyGoal() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let d = JSON.parse(localStorage.getItem('c4k_lessons_today') || '{}');
    d = { date: today, count: (d.date === today ? (d.count || 0) : 0) + 1 };
    localStorage.setItem('c4k_lessons_today', JSON.stringify(d));
    // Weekly challenge counter
    const wk = isoWeekKey();
    let w = JSON.parse(localStorage.getItem('c4k_week_lessons') || '{}');
    w = { week: wk, count: (w.week === wk ? (w.count || 0) : 0) + 1 };
    localStorage.setItem('c4k_week_lessons', JSON.stringify(w));
  } catch {}
}

async function finishLessonSave() {
  if (savedThisLesson || !curLesson) return;
  savedThisLesson = true;
  bumpDailyGoal();
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

function lvPrev() {
  // Never go back during a quiz
  if (screens[scr] && screens[scr].type === 'quiz_set') return;
  if (scr > 0) { scr--; renderScreen(); }
}
function lvNext() {
  const s = screens[scr];
  if (s.type === 'drag' && !screenDone[scr]) return;
  if (s.type === 'prompt_lab' && !screenDone[scr]) return;
  if (s.type === 'quiz_set') {
    // Only reachable after passing (Next button shown on pass screen)
    if (!screenDone[scr]) return;
    savedThisLesson = false; closeLesson(); render(); celebrate(curLessonTitleCache);
    return;
  }
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
      <div style="margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        ${data.passed ? `<a class="btn btn-outline" href="certificate.html?unit=${pendingUnit}">🏆 Get Certificate</a>
             <button class="btn btn-primary" onclick="closeTest();render();">Onward! 🗺️</button>`
          : `<button class="btn btn-outline" onclick="closeTest();render();">Review Lessons</button>
             <button class="btn btn-primary" onclick="openPledge(${pendingUnit})">⚔️ Rematch</button>`}
      </div>
    </div>`;
}
document.getElementById('testModal')?.addEventListener('click', e => { if (e.target.id === 'testModal') closeTest(); });

function showPolicy() { document.getElementById('policyModal').classList.remove('hidden'); }
document.getElementById('policyModal')?.addEventListener('click', e => { if (e.target.id === 'policyModal') e.currentTarget.classList.add('hidden'); });

load();
