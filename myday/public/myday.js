// Shared logic between dash.html (read-only student view) and manage.html (owner's editor +
// live preview). Pure date/schedule math plus DOM rendering into a fixed set of element IDs -
// both pages include the same markup block (see the <template id="myday-view"> in each page).
const MyDay = (() => {
  const ENGINES = {
    google:    q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
    youtube:   q => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
    wikipedia: q => 'https://en.wikipedia.org/w/index.php?search=' + encodeURIComponent(q),
  };
  let curEngine = 'google';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function isWeekday(d) { const w = d.getDay(); return w >= 1 && w <= 5; }
  function timeToMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM'; let h12 = h % 12; if (h12 === 0) h12 = 12;
    return `${h12}:${pad2(m)} ${ap}`;
  }
  function nthWeekday(year, month, weekday, n) {
    let d = new Date(year, month, 1), count = 0;
    while (true) { if (d.getDay() === weekday) { count++; if (count === n) return d; } d = addDays(d, 1); }
  }
  function lastWeekday(year, month, weekday) {
    let d = new Date(year, month + 1, 0);
    while (d.getDay() !== weekday) d = addDays(d, -1);
    return d;
  }
  function defaultDaysOff(schoolYearStartYear) {
    const Y = schoolYearStartYear;
    const items = [];
    const add = (d, label, d2) => items.push({ start: toISO(d), end: toISO(d2 || d), label });
    add(nthWeekday(Y, 8, 1, 1), 'Labor Day');
    add(nthWeekday(Y, 9, 1, 2), 'Columbus Day');
    add(new Date(Y, 10, 11), 'Veterans Day');
    const thx = nthWeekday(Y, 10, 4, 4);
    add(addDays(thx, -1), 'Thanksgiving Break', addDays(thx, 1));
    add(new Date(Y, 11, 23), 'Winter Break', new Date(Y + 1, 0, 2));
    add(nthWeekday(Y + 1, 0, 1, 3), 'Dr. Martin Luther King Jr. Day');
    add(nthWeekday(Y + 1, 1, 1, 3), "Presidents' Day");
    const spring = nthWeekday(Y + 1, 2, 1, 2);
    add(spring, 'Spring Break', addDays(spring, 4));
    add(lastWeekday(Y + 1, 4, 1), 'Memorial Day');
    add(nthWeekday(Y + 1, 5, 5, 1), 'School Year Ends (edit me!)');
    return items.sort((a, b) => a.start.localeCompare(b.start));
  }
  // Builds a day's period list from a flat sequence of [label,minutes] blocks, inserting a
  // 4-minute passing period between every one - the real structure both A Day and B Day
  // share: 2 electives at the start (45 min), then 5 core classes (90 min) with lunch right
  // after the first one. "Split" Friday is the same sequence with every block at 45 min.
  function buildDaySequence(startTime, blocks, dayLabel) {
    const periods = [];
    let cur = timeToMin(startTime);
    const addMin = (t, m) => { const h = Math.floor((t + m) / 60), mi = (t + m) % 60; return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`; };
    blocks.forEach((b, i) => {
      const end = addMin(cur, b.minutes);
      periods.push({ tag: b.tag || '', label: b.label, start: addMin(cur, 0), end, days: dayLabel });
      cur = timeToMin(end);
      if (i < blocks.length - 1) cur += 4;   // 4-minute passing period between classes
    });
    return periods;
  }
  function defaultTemplate() {
    const today = new Date();
    const Y = today.getMonth() >= 6 ? today.getFullYear() : today.getFullYear() - 1;
    const regularBlocks = [
      { label: 'Elective 1', minutes: 45 },
      { label: 'Elective 2', minutes: 45 },
      { label: 'Math', minutes: 90 },
      { label: 'Lunch', minutes: 30, tag: 'LUNCH' },
      { label: 'Social Studies', minutes: 90 },
      { label: 'Science', minutes: 90 },
      { label: 'Reading', minutes: 90 },
      { label: 'Design Time', minutes: 90 },
    ];
    const splitBlocks = regularBlocks.map(b => b.tag === 'LUNCH' ? b : { ...b, minutes: 45 });
    const regular = buildDaySequence('08:45', regularBlocks, 'A Day,B Day');
    const split = buildDaySequence('08:45', splitBlocks, 'Split');
    return {
      portal: { label: 'Student Portal', sub: 'Opens in a new tab', url: '' },
      hours: { start: '08:45', end: regular[regular.length - 1].end },
      year: { start: `${Y}-08-11`, weeks: 36, periodLabel: '' },
      rotation: {
        mode: 'weekday',
        weekdayMap: { 1: 'A Day', 2: 'B Day', 3: 'A Day', 4: 'B Day', 5: 'Split' },
        cycle: ['A Day', 'B Day'], anchorDate: `${Y}-08-11`, overrides: {},
      },
      periods: [...regular, ...split],
      daysOff: defaultDaysOff(Y),
    };
  }
  function isDaysOff(dateStr, daysOff) { return (daysOff || []).some(d => dateStr >= d.start && dateStr <= d.end); }
  function dayTypeFor(dateStr, data) {
    if (isDaysOff(dateStr, data.daysOff)) return null;
    const d = parseISO(dateStr);
    if (!isWeekday(d)) return null;
    if (data.rotation.overrides && data.rotation.overrides[dateStr]) return data.rotation.overrides[dateStr];
    // Fixed mode: the day of the week alone decides the type (Mon is always "A Day", etc.) -
    // it never drifts, unlike a counting cycle.
    if (data.rotation.mode === 'weekday') {
      const map = data.rotation.weekdayMap || {};
      return map[d.getDay()] ?? null;
    }
    const cycle = (data.rotation.cycle && data.rotation.cycle.length) ? data.rotation.cycle : ['Day'];
    const anchor = parseISO(data.rotation.anchorDate || data.year.start);
    let count = 0, cur = new Date(anchor);
    if (toISO(anchor) === dateStr) return cycle[0];
    if (anchor < d) {
      while (toISO(cur) !== dateStr) { cur = addDays(cur, 1); if (isWeekday(cur) && !isDaysOff(toISO(cur), data.daysOff)) count++; }
    } else {
      while (toISO(cur) !== dateStr) { cur = addDays(cur, -1); if (isWeekday(cur) && !isDaysOff(toISO(cur), data.daysOff)) count--; }
    }
    const idx = ((count % cycle.length) + cycle.length) % cycle.length;
    return cycle[idx];
  }
  // A period's `days` field is "all", a single label ("B Day"), or a comma-separated list
  // ("A Day,B Day") for a class that meets on more than one day type with the same slot.
  function periodAppliesTo(p, type) {
    if (p.days === 'all') return true;
    return p.days.split(',').map(s => s.trim()).includes(type);
  }
  function periodsForDate(dateStr, data) {
    const type = dayTypeFor(dateStr, data);
    if (type === null) return { type: null, periods: [] };
    const list = (data.periods || []).filter(p => periodAppliesTo(p, type))
      .slice().sort((a, b) => timeToMin(a.start) - timeToMin(b.start));
    return { type, periods: list };
  }
  function bellStatus(now, periods) {
    const curMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i], s = timeToMin(p.start), e = timeToMin(p.end);
      if (curMin >= s && curMin < e) {
        const next = periods[i + 1] || null;
        return { current: p, secsLeft: Math.max(0, Math.round((e - curMin) * 60)), next,
          nextInSecs: next ? Math.max(0, Math.round((timeToMin(next.start) - curMin) * 60)) : null };
      }
    }
    const next = periods.find(p => timeToMin(p.start) > curMin) || null;
    return { current: null, secsLeft: null, next,
      nextInSecs: next ? Math.max(0, Math.round((timeToMin(next.start) - curMin) * 60)) : null };
  }
  // Different day types can run different lengths (a "Split" Friday ends much earlier than
  // a full A/B day), so the progress bar's start/end come from today's own first and last
  // period rather than one fixed hours.start/end - data.hours is only a fallback for a day
  // with no periods defined at all.
  function hoursForPeriods(periods, fallback) {
    if (!periods.length) return fallback;
    return { start: periods[0].start, end: periods[periods.length - 1].end };
  }
  function schoolDayProgress(now, hours) {
    const s = timeToMin(hours.start), e = timeToMin(hours.end);
    const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    if (cur <= s) return 0; if (cur >= e) return 100;
    return Math.round(((cur - s) / (e - s)) * 1000) / 10;
  }
  function schoolDayNumber(dateStr, data) {
    const start = parseISO(data.year.start), target = parseISO(dateStr);
    if (target < start) return 0;
    let n = 0, cur = new Date(start);
    while (true) {
      if (isWeekday(cur) && !isDaysOff(toISO(cur), data.daysOff)) n++;
      if (toISO(cur) === dateStr) break;
      cur = addDays(cur, 1);
      if (cur - target > 365 * 86400000) break;
    }
    return n;
  }
  function weekNumber(dateStr, data) {
    const diff = Math.floor((parseISO(dateStr) - parseISO(data.year.start)) / 86400000);
    return Math.max(1, Math.floor(diff / 7) + 1);
  }
  function relTime(dateStr, todayStr) {
    const diffDays = Math.round((parseISO(dateStr) - parseISO(todayStr)) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';
    if (diffDays > 0) return diffDays < 14 ? `in ${diffDays} days` : diffDays < 60 ? `in ${Math.round(diffDays / 7)} wks` : `in ${Math.round(diffDays / 30)} mo`;
    const ad = Math.abs(diffDays);
    return ad < 14 ? `${ad} days ago` : ad < 60 ? `${Math.round(ad / 7)} wks ago` : `${Math.round(ad / 30)} mo ago`;
  }
  function fmtDateRange(start, end) {
    const o = { month: 'short', day: 'numeric' };
    const s = parseISO(start).toLocaleDateString('en-US', o);
    if (start === end) return s;
    const e = parseISO(end).toLocaleDateString('en-US', o);
    return `${s} - ${e}`;
  }

  let DATA = null, lastRenderedDate = null, showCustomizeBtn = false;

  function renderClock() {
    if (!DATA) return;
    const now = new Date();
    let h = now.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; let h12 = h % 12; if (h12 === 0) h12 = 12;
    document.getElementById('clockTime').textContent = `${h12}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    document.getElementById('clockAmPm').textContent = ap;

    const todayStr = toISO(now);
    if (todayStr !== lastRenderedDate) { renderStatic(); lastRenderedDate = todayStr; }

    const { periods } = periodsForDate(todayStr, DATA);
    const pct = schoolDayProgress(now, hoursForPeriods(periods, DATA.hours));
    document.getElementById('progFill').style.width = pct + '%';
    document.getElementById('progPct').textContent = pct + '%';

    const st = bellStatus(now, periods);
    const fmtCountdown = secs => secs == null ? '—:—' : `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
    if (st.current) {
      document.getElementById('bellNowLabel').textContent = `${st.current.label} ends in`;
      document.getElementById('bellCountdown').textContent = fmtCountdown(st.secsLeft);
      document.getElementById('bellNextLabel').textContent = st.next ? `${st.next.label} starts in ${fmtCountdown(st.nextInSecs)}` : 'Last period of the day';
    } else if (st.next) {
      document.getElementById('bellNowLabel').textContent = `${st.next.label} starts in`;
      document.getElementById('bellCountdown').textContent = fmtCountdown(st.nextInSecs);
      document.getElementById('bellNextLabel').textContent = '';
    } else {
      document.getElementById('bellNowLabel').textContent = periods.length ? 'School is out for the day' : 'No school today';
      document.getElementById('bellCountdown').textContent = '🎉';
      document.getElementById('bellNextLabel').textContent = '';
    }
    document.querySelectorAll('#todayPeriods .sc-period-row').forEach(row => {
      const isNow = st.current && row.dataset.label === st.current.label && row.dataset.start === st.current.start;
      row.classList.toggle('now', !!isNow);
      const pill = row.querySelector('.sc-now-pill');
      if (pill) pill.remove();
      if (isNow) { const span = document.createElement('span'); span.className = 'sc-now-pill'; span.textContent = 'NOW'; row.appendChild(span); }
    });
  }

  function renderStatic() {
    const now = new Date(), todayStr = toISO(now);
    document.getElementById('dateLine').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const type = dayTypeFor(todayStr, DATA);
    document.getElementById('dayTypeBadge').textContent = type || 'No School';
    const wk = weekNumber(todayStr, DATA);
    document.getElementById('periodLabelBadge').textContent = DATA.year.periodLabel ? DATA.year.periodLabel + ` · Week ${wk} of ${DATA.year.weeks}` : `Week ${wk} of ${DATA.year.weeks}`;

    const { periods } = periodsForDate(todayStr, DATA);
    const todayHours = hoursForPeriods(periods, DATA.hours);
    document.getElementById('progStart').textContent = fmtTime(todayHours.start);
    document.getElementById('progEnd').textContent = fmtTime(todayHours.end);

    const dayNum = schoolDayNumber(todayStr, DATA);
    document.getElementById('dayOfYearLbl').textContent = periods.length ? `Day ${dayNum} of ${DATA.year.weeks * 5}` : '';
    const tp = document.getElementById('todayPeriods');
    tp.innerHTML = periods.length ? periods.map(p => `
      <div class="sc-period-row" data-label="${esc(p.label)}" data-start="${p.start}">
        <span class="ptime">${fmtTime(p.start)} - ${fmtTime(p.end)}</span>
        <span class="ptag">${esc(p.tag || '')}</span>
        <span class="plabel">${esc(p.label)}</span>
      </div>`).join('') : `<p style="color:var(--text-dim);font-size:0.85rem;">No school today - enjoy the day off! 🎉</p>`;

    document.getElementById('portalLabel').textContent = DATA.portal.label || 'Student Portal';
    document.getElementById('portalSub').textContent = DATA.portal.sub || 'Opens in a new tab';
    document.getElementById('portalBtn').href = DATA.portal.url || '#';

    const tabs = document.getElementById('searchTabs');
    tabs.innerHTML = Object.keys(ENGINES).map(k =>
      `<button class="sc-tab ${k === curEngine ? 'active' : ''}" onclick="MyDay.setEngine('${k}')">${k[0].toUpperCase() + k.slice(1)}</button>`).join('');
    document.getElementById('qsInput').placeholder = 'Search ' + (curEngine[0].toUpperCase() + curEngine.slice(1));

    const dow = now.getDay();
    const monday = addDays(now, dow === 0 ? -6 : 1 - dow);
    const week = document.getElementById('weekStrip');
    week.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const d = addDays(monday, i), ds = toISO(d);
      const t = dayTypeFor(ds, DATA);
      const div = document.createElement('div');
      div.className = 'sc-week-day' + (ds === todayStr ? ' today' : '');
      div.innerHTML = `<div class="wd"><span>${d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</span><span>${d.getDate()}</span></div>
        <div class="wt ${t ? '' : 'off'}">${t || 'No School'}</div>`;
      week.appendChild(div);
    }

    const sorted = (DATA.daysOff || []).slice().sort((a, b) => a.start.localeCompare(b.start));
    const upcoming = sorted.filter(d => d.end >= todayStr);
    const past = sorted.filter(d => d.end < todayStr).slice(-6).reverse();
    const card = (d, isPast) => `<div class="sc-off-item ${isPast ? 'past' : ''}">
        <div class="od"><span>${fmtDateRange(d.start, d.end)}</span><span class="orel">${relTime(isPast ? d.end : d.start, todayStr)}</span></div>
        <div class="olbl">${esc(d.label)}</div></div>`;
    document.getElementById('offUpcoming').innerHTML = upcoming.length ? upcoming.map(d => card(d, false)).join('') : `<p style="color:var(--text-dim);font-size:0.82rem;">Nothing coming up.</p>`;
    document.getElementById('offPast').innerHTML = past.length ? past.map(d => card(d, true)).join('') : `<p style="color:var(--text-dim);font-size:0.82rem;">None yet.</p>`;

    const fab = document.getElementById('customizeFab');
    if (fab) fab.style.display = showCustomizeBtn ? '' : 'none';
  }

  function setEngine(k) { curEngine = k; renderStatic(); }
  function runSearch() {
    const q = document.getElementById('qsInput').value.trim();
    if (!q) return;
    const url = ENGINES[curEngine](q);
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }

  function start(data, opts) {
    DATA = data;
    showCustomizeBtn = !!(opts && opts.showCustomize);
    lastRenderedDate = null;
    renderClock();
    clearInterval(start._t);
    start._t = setInterval(renderClock, 1000);
  }
  function setData(data) { DATA = data; lastRenderedDate = null; renderClock(); }
  function getData() { return DATA; }

  return {
    esc, toISO, parseISO, defaultTemplate, defaultDaysOff,
    start, setData, getData, setEngine, runSearch,
  };
})();
