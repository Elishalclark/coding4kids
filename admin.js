// Shared admin logic for every admin-*.html page. Extracted from admin.html when the
// panel was split into one page per feature — 19 copies of 140KB of inline JS was never
// going to stay in sync. Every loader guards on element presence, because each page
// only contains its own panels.
// ── Admin Preview Mode: browse the WHOLE panel read-only, nothing gets changed ──
    // Wraps C4K.api so that while preview mode is on, every mutating (POST) call is
    // intercepted and answered with a fake "would have worked" response instead of actually
    // hitting the server — GET calls (loading data) still go through normally, so every panel
    // still shows real data, you just can't accidentally suspend/delete/change anything.
    let _adminPreviewMode = localStorage.getItem('c4k_admin_preview') === '1';
    const _realC4KApi = C4K.api.bind(C4K);
    // Never intercept these, even in Preview Mode: login/logout/2FA (breaking login would lock
    // you out entirely, including if preview mode was left on from a previous session), and
    // role-preview/impersonate (those are themselves safe, non-mutating "view as" tools).
    const _PREVIEW_BYPASS = ['/api/admin/login', '/api/login', '/api/logout', '/api/login/2fa',
      '/api/admin/preview', '/api/admin/impersonate'];
    C4K.api = async function (path, method, body) {
      const isMutating = method && method.toUpperCase() !== 'GET';
      const bypassed = _PREVIEW_BYPASS.some(p => path === p || path.startsWith(p + '?'));
      if (_adminPreviewMode && isMutating && !bypassed) {
        console.log('[Admin Preview Mode] blocked:', method, path, body);
        showPreviewToast(method + ' ' + path);
        return { ok: true, status: 200, data: { ok: true, preview: true, count: 0, changed: [], sent: 0 } };
      }
      return _realC4KApi(path, method, body);
    };
    function showPreviewToast(action) {
      let t = document.getElementById('previewToast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'previewToast';
        t.style.cssText = 'position:fixed;bottom:70px;right:20px;z-index:99999;background:#0f766e;color:#fff;font-family:inherit;font-weight:800;font-size:0.85rem;padding:10px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:320px;';
        document.body.appendChild(t);
      }
      t.textContent = '🔍 Preview Mode: blocked "' + action + '" — nothing was changed.';
      t.style.display = 'block';
      clearTimeout(t._hideTimer);
      t._hideTimer = setTimeout(() => { t.style.display = 'none'; }, 3000);
    }
    function toggleAdminPreview(cb) {
      _adminPreviewMode = cb.checked;
      localStorage.setItem('c4k_admin_preview', _adminPreviewMode ? '1' : '0');
      document.getElementById('previewBanner').style.display = _adminPreviewMode ? 'flex' : 'none';
    }

    // ── Live drop-in session (admin/super admin can host one too, e.g. for a pitch demo) ──
    function showSession(code, expiresAt) {
      document.getElementById('sessLive').style.display = '';
      setText('sessCode', code);
      document.getElementById('sessFlyer').href = 'card.html?code=' + encodeURIComponent(code);
      const b = document.getElementById('startSessBtn'); b.textContent = 'Session live'; b.disabled = true;
      if (expiresAt) { const h = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 3600000)); document.getElementById('sessExpiry').textContent = `Code works for about ${h} more hour${h===1?'':'s'}.`; }
    }
    async function startLiveSession() {
      const btn = document.getElementById('startSessBtn'); btn.disabled = true; btn.textContent = 'Starting…';
      const photoConsent = document.getElementById('photoConsentBox') ? document.getElementById('photoConsentBox').checked : false;
      const hours = parseFloat(document.getElementById('sessHours').value) || 8;
      const { ok, data } = await C4K.api('/api/session/start', 'POST', { photoConsent, hours });
      if (ok) { showSession(data.code, data.expiresAt); startSessFeed(); }
      else { btn.disabled = false; btn.textContent = 'Start a session'; alert(data.error || 'Could not start.'); }
    }
    let _sessLocked = false, _sessFeedTimer = null;
    async function newSessionCode() {
      if (!confirm('Make a new session code? The current code stops working (kids already in stay signed in).')) return;
      const hours = parseFloat(document.getElementById('sessHours').value) || 8;
      const { ok, data } = await C4K.api('/api/session/start', 'POST', { regen: true, hours });
      if (ok) { _sessLocked = false; setLockBtn(); showSession(data.code, data.expiresAt); }
      else alert(data.error || 'Could not change the code.');
    }
    async function extendSession() {
      const hours = parseFloat(document.getElementById('sessHours').value) || 8;
      const { ok, data } = await C4K.api('/api/session/extend', 'POST', { hours });
      if (ok) showSession(document.getElementById('sessCode').textContent, data.expiresAt);
      else alert(data.error || 'Could not extend — start a session first.');
    }
    async function saveLogoutPin() {
      const pin = document.getElementById('pinInput').value.trim();
      const msg = document.getElementById('pinMsg');
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Saving…';
      const { ok, data } = await C4K.api('/api/teacher/logout-pin', 'POST', { pin });
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = data.pinSet ? `✅ Session code set to "${pin}". Share it with kids.` : '✅ Session logout turned off.'; document.getElementById('pinInput').value=''; }
      else { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || 'Could not save.'; }
    }
    async function endAllSessions() {
      if (!confirm("End EVERY active Live Session right now, for every host on the platform? This can't be undone.")) return;
      const msg = document.getElementById('endAllMsg');
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Ending…';
      const { ok, data } = await C4K.api('/api/admin/end-all-sessions', 'POST', {});
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = data.ended ? `✅ Ended ${data.ended} session(s).` : '✅ No active sessions to end.'; }
      else { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || 'Could not end sessions.'; }
      loadActiveSessions();
    }
    async function loadActiveSessions() {
      const { ok, data } = await C4K.api('/api/admin/active-sessions');
      const rows = document.getElementById('activeSessionRows');
      if (!rows) return;
      if (!ok) { rows.innerHTML = '<tr><td colspan="6" style="color:var(--text-faint);">Could not load.</td></tr>'; return; }
      const list = data.sessions || [];
      rows.innerHTML = list.length ? list.map(s => {
        const mins = Math.max(0, Math.round((new Date(s.expiresAt) - Date.now()) / 60000));
        const hostTag = s.hostRole === 'admin' || s.hostRole === 'super_admin' ? '🛠️ ' : (s.hostRole === 'teacher' ? '🍎 ' : '');
        const kids = s.kids || [];
        // Who is actually in the room. The count alone told you a session was busy but not
        // who was in it, which is the thing you need when a parent or teacher asks.
        const kidList = kids.length
          ? kids.map(k => `<span style="display:inline-block;background:var(--surface-2);border:1px solid var(--border);border-radius:50px;padding:2px 10px;margin:2px 3px 2px 0;font-size:0.78rem;font-weight:800;">${C4K.esc(k.name || k.username)}${k.joinedAt ? ` <span style="color:var(--text-faint);font-weight:600;">${C4K.esc(k.joinedAt)}</span>` : ''}</span>`).join('')
          : '<span style="color:var(--text-faint);font-size:0.8rem;">nobody yet</span>';
        return `<tr>
          <td>${hostTag}${C4K.esc(s.hostName || 'Unknown')}${s.hostUsername ? ` <span style="color:var(--text-faint);font-size:0.78rem;">@${C4K.esc(s.hostUsername)}</span>` : ''}${s.sessionName ? `<div style="color:var(--text-faint);font-size:0.76rem;">${C4K.esc(s.sessionName)}</div>` : ''}</td>
          <td style="font-weight:900;letter-spacing:2px;">${C4K.esc(s.code)}</td>
          <td>${s.kidsPresent != null ? s.kidsPresent : s.joins}${s.joins > (s.kidsPresent || 0) ? ` <span style="color:var(--text-faint);font-size:0.76rem;">(${s.joins} joined)</span>` : ''}</td>
          <td>${s.locked ? '🔒 locked' : '—'}</td>
          <td style="color:var(--text-dim);">${mins < 60 ? `${mins} min left` : `${Math.round(mins/60)} hr left`}</td>
          <td><button class="mini-btn" style="color:#f87171;border-color:rgba(239,68,68,.4);" onclick="endOneSession('${C4K.esc(s.code)}')">End</button></td>
        </tr>
        <tr><td colspan="6" style="padding-top:0;border-top:none;">
          <div style="color:var(--text-faint);font-size:0.74rem;font-weight:800;margin-bottom:3px;">Kids in this session</div>${kidList}
        </td></tr>`;
      }).join('') : '<tr><td colspan="6" style="color:var(--text-faint);">No sessions are live right now.</td></tr>';
    }
    // Session history — kept client-side after one fetch so the search box filters instantly.
    let SESSION_HISTORY = [];
    // ── Outreach ──────────────────────────────────────────────────────────────
    // Templates are per organisation type because the pitch genuinely differs: a librarian
    // cares about running a session with no setup, a homeschool association cares about what
    // its member families get. {{ORG}} and {{NAME}} are filled in at send time.
    const OR_TEMPLATES = {
      homeschool: {
        label: '🏠 Homeschool org',
        subject: 'A free coding curriculum for your member families',
        body: `Hi {{NAME}},

I run KidVibers, a self-paced coding curriculum for ages 6-16. I'm writing because homeschool families have turned out to be who it fits best, and I wondered whether it might be useful to {{ORG}}'s members.

The reason it works at home is that the parent doesn't have to know how to code. Each lesson explains the concept, the child writes real code, and the platform checks the work — so nobody is waiting on a parent to unblock them. It also keeps per-child records and issues printable certificates, which helps for portfolio and reporting requirements.

There's a free tier and a free trial, so families can try it without committing to anything. No ads, no public gallery, no messaging between users, and a parent has to approve every child account before the child can use it.

If it seems useful, I'd be glad to put together whatever helps — a short write-up for your resource list, a printable one-pager on privacy and safety, or a group setup if any of your co-ops want to run coding together.

Happy to answer any questions.

Elisha Clark
KidVibers · kidvibers.com`
      },
      library: {
        label: '📚 Library',
        subject: 'A drop-in coding session you can run with no setup',
        body: `Hi {{NAME}},

I run KidVibers, a coding platform for kids 6-16, and I wanted to reach out because it's built to work for exactly the kind of drop-in session libraries run.

You can start a session and give out a code — children join and start coding straight away, with no account creation at the desk and no email addresses collected on the spot. It runs in the browser on the computers you already have, including older machines and Chromebooks, and there's nothing for IT to install or approve.

It's also safe to run with light supervision: no ads, no public gallery, no messaging between users at all.

There's a printable one-pager covering privacy, safety and data practices if that's useful for approvals or for parents asking at the desk. Free to use.

If you'd like, I can walk you through setting up a session — it takes about five minutes.

Elisha Clark
KidVibers · kidvibers.com`
      },
      coop: {
        label: '👨‍👩‍👧 Co-op',
        subject: 'Coding for your co-op, without anyone having to teach it',
        body: `Hi {{NAME}},

I run KidVibers, a self-paced coding curriculum for ages 6-16, and I think it might suit how {{ORG}} already works.

Mixed ages are usually the hard part of a co-op session. This decouples them: every child works on their own track at their own level, so a seven-year-old and a thirteen-year-old can sit at the same table doing completely different work. The room stays social; the difficulty stays individual.

The leader creates one join code, families enter it once, and you can see everyone's progress in one place. You don't need to know how to code to run it — the lessons teach, the platform checks the work.

Free tier and free trial, so there's no cost to trying it for a term.

Happy to set up a group for you if you'd like to test it with a few families first.

Elisha Clark
KidVibers · kidvibers.com`
      },
      afterschool: {
        label: '🌇 After-school',
        subject: 'A coding activity that survives rotating attendance',
        body: `Hi {{NAME}},

I run KidVibers, a coding platform for kids 6-16. I'm writing because after-school programs have a specific problem it happens to solve.

Attendance rotates, kids arrive at different times, and staff change week to week. Because every child is on their own self-paced track, none of that matters — they resume exactly where they left off, and there's no lesson plan to keep a group synchronised with. A new staff member can supervise competently on their first day with nothing to prepare.

Every lesson has a visible finish line, so a child with twenty minutes still completes something rather than stopping mid-task.

No ads, no public gallery, no messaging between children. Free tier available.

Glad to help you set it up if it looks like a fit.

Elisha Clark
KidVibers · kidvibers.com`
      },
      school: {
        label: '🏫 School / district',
        subject: 'Classroom coding with per-student progress and a DPA',
        body: `Hi {{NAME}},

I run KidVibers, a coding curriculum for ages 6-16 built for teachers with a room full of students at different levels.

You can add students in bulk from a CSV or hand out a class code, assign lessons with due dates, restrict logins to school hours, and download per-student progress reports. Each child works at their own level, so you're not teaching to the middle.

On the compliance side there's a schools privacy page covering what's collected and how it's used, plus data processing terms — I can send that over if procurement needs it.

Happy to arrange a walkthrough or set up a trial classroom.

Elisha Clark
KidVibers · kidvibers.com`
      },
    };

    let OR_LIST = [], OR_TYPE = 'homeschool', OR_EDIT_ID = null;

    function orRenderTabs() {
      const wrap = document.getElementById('orTplTabs');
      if (!wrap) return;
      wrap.innerHTML = Object.entries(OR_TEMPLATES).map(([k, t]) =>
        `<button class="mini-btn" data-tpl="${k}" onclick="orPickTemplate('${k}')" style="${k === OR_TYPE ? 'background:var(--purple);color:#fff;border-color:var(--purple);' : ''}">${C4K.esc(t.label)}</button>`
      ).join('');
    }
    function orPickTemplate(k) {
      if (!OR_TEMPLATES[k]) return;
      OR_TYPE = k;
      orResetTemplate();
      orRenderTabs();
    }
    function orResetTemplate() {
      const t = OR_TEMPLATES[OR_TYPE];
      const s = document.getElementById('orTplSubject'), b = document.getElementById('orTplBody');
      if (s) s.value = t.subject;
      if (b) b.value = t.body;
      const m = document.getElementById('orTplMsg'); if (m) m.textContent = '';
    }
    function orCopyTemplate() {
      const b = document.getElementById('orTplBody'), s = document.getElementById('orTplSubject');
      const m = document.getElementById('orTplMsg');
      if (!b || !s) return;
      navigator.clipboard.writeText(`Subject: ${s.value}\n\n${b.value}`).then(() => {
        if (m) { m.style.color = '#5ad17e'; m.textContent = 'Copied.'; }
      }).catch(() => { if (m) { m.style.color = '#ff8a8a'; m.textContent = 'Could not copy — select the text and copy manually.'; } });
    }

    async function loadOutreach() {
      const rows = document.getElementById('orRows');
      if (!rows) return;
      const { ok, data } = await C4K.api('/api/admin/outreach');
      if (!ok) { rows.innerHTML = '<tr><td colspan="6" style="color:var(--text-faint);">Could not load.</td></tr>'; return; }
      OR_LIST = data.orgs || [];
      renderOutreach();
    }

    function renderOutreach() {
      const rows = document.getElementById('orRows');
      if (!rows) return;
      const q = (document.getElementById('orSearch')?.value || '').trim().toLowerCase();
      const st = document.getElementById('orFilterStatus')?.value || '';
      const today = new Date().toISOString().slice(0, 10);

      const S = { new: ['Not contacted', '#f59e0b'], emailed: ['Emailed', '#60a5fa'], replied: ['Replied', '#5ad17e'],
                  meeting: ['Meeting', '#a78bfa'], partnered: ['Partnered', '#22c55e'], declined: ['Declined', '#8b84a8'] };
      const T = { homeschool: '🏠', coop: '👨‍👩‍👧', library: '📚', afterschool: '🌇', school: '🏫' };

      setText('orStatTotal', OR_LIST.length);
      ['new', 'emailed', 'replied', 'partnered'].forEach(k =>
        setText('orStat' + k.charAt(0).toUpperCase() + k.slice(1), OR_LIST.filter(o => o.status === k).length));
      setText('orStatDue', OR_LIST.filter(o => o.followUpAt && o.followUpAt <= today && o.status !== 'partnered' && o.status !== 'declined').length);

      const list = OR_LIST.filter(o => {
        if (st && o.status !== st) return false;
        if (!q) return true;
        return [o.orgName, o.contactName, o.contactEmail, o.region].some(v => (v || '').toLowerCase().includes(q));
      });
      if (!list.length) {
        rows.innerHTML = `<tr><td colspan="6" style="color:var(--text-faint);">${OR_LIST.length ? 'Nothing matches that.' : 'Nobody on the list yet — add your first organisation above.'}</td></tr>`;
        return;
      }
      rows.innerHTML = list.map(o => {
        const [label, colour] = S[o.status] || S.new;
        const due = o.followUpAt && o.followUpAt <= today && o.status !== 'partnered' && o.status !== 'declined';
        return `<tr>
          <td><strong>${T[o.orgType] || ''} ${C4K.esc(o.orgName)}</strong>
            ${o.region ? `<div style="color:var(--text-faint);font-size:0.76rem;">${C4K.esc(o.region)}</div>` : ''}
            ${o.website ? `<div><a href="${C4K.esc(o.website)}" target="_blank" rel="noopener" style="color:var(--purple);font-size:0.76rem;">website ↗</a></div>` : ''}</td>
          <td>${o.contactName ? C4K.esc(o.contactName) : '<span style="color:var(--text-faint);">—</span>'}
            ${o.contactEmail ? `<div style="font-size:0.76rem;"><a href="mailto:${C4K.esc(o.contactEmail)}" style="color:var(--purple);">${C4K.esc(o.contactEmail)}</a></div>` : ''}</td>
          <td><span class="pill" style="background:${colour}22;color:${colour};border:1px solid ${colour}55;">${label}</span></td>
          <td style="color:var(--text-dim);font-size:0.82rem;">${o.lastContactedAt ? C4K.esc(o.lastContactedAt.slice(0, 10)) : '—'}</td>
          <td style="font-size:0.82rem;${due ? 'color:#f59e0b;font-weight:900;' : 'color:var(--text-dim);'}">${o.followUpAt ? C4K.esc(o.followUpAt) + (due ? ' ⚠️' : '') : '—'}</td>
          <td style="white-space:nowrap;">
            ${o.contactEmail ? `<button class="mini-btn" onclick="orSend(${o.id})" title="Send the template above to this contact">✉️ Send</button>` : ''}
            <button class="mini-btn" onclick="orEdit(${o.id})">Edit</button>
            <button class="mini-btn" style="color:#f87171;border-color:rgba(239,68,68,.4);" onclick="orDelete(${o.id})">Delete</button>
          </td>
        </tr>${o.notes ? `<tr><td colspan="6" style="border-top:none;padding-top:0;color:var(--text-dim);font-size:0.8rem;">📝 ${C4K.esc(o.notes)}</td></tr>` : ''}`;
      }).join('');
    }

    function orClearForm() {
      OR_EDIT_ID = null;
      ['orName', 'orRegion', 'orContact', 'orEmail', 'orSite', 'orFollowUp', 'orNotes'].forEach(id => {
        const e = document.getElementById(id); if (e) e.value = '';
      });
      const b = document.getElementById('orSaveBtn'); if (b) b.textContent = 'Add to the list';
      const c = document.getElementById('orCancelBtn'); if (c) c.style.display = 'none';
      setText('orSaveMsg', '');
    }

    function orEdit(id) {
      const o = OR_LIST.find(x => x.id === id);
      if (!o) return;
      OR_EDIT_ID = id;
      const set = (i, v) => { const e = document.getElementById(i); if (e) e.value = v || ''; };
      set('orName', o.orgName); set('orRegion', o.region); set('orContact', o.contactName);
      set('orEmail', o.contactEmail); set('orSite', o.website); set('orFollowUp', o.followUpAt);
      set('orNotes', o.notes);
      const t = document.getElementById('orType'); if (t) t.value = o.orgType;
      const st = document.getElementById('orStatusEdit'); if (st) st.value = o.status;
      const b = document.getElementById('orSaveBtn'); if (b) b.textContent = 'Save changes';
      const c = document.getElementById('orCancelBtn'); if (c) c.style.display = '';
      document.getElementById('outreachAddPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function orSave() {
      const msg = document.getElementById('orSaveMsg');
      const val = id => (document.getElementById(id)?.value || '').trim();
      const payload = {
        id: OR_EDIT_ID, orgName: val('orName'), orgType: val('orType'), region: val('orRegion'),
        contactName: val('orContact'), contactEmail: val('orEmail'), website: val('orSite'),
        followUpAt: val('orFollowUp'), notes: val('orNotes'),
        status: OR_EDIT_ID ? (OR_LIST.find(o => o.id === OR_EDIT_ID)?.status || 'new') : 'new',
      };
      if (!payload.orgName) { if (msg) { msg.style.color = '#ff8a8a'; msg.textContent = 'Name the organisation first.'; } return; }
      const { ok, data } = await C4K.api('/api/admin/outreach/save', 'POST', payload);
      if (msg) {
        msg.style.color = ok ? '#5ad17e' : '#ff8a8a';
        msg.textContent = ok ? (OR_EDIT_ID ? 'Saved.' : 'Added.') : ((data && data.error) || 'Could not save.');
      }
      if (ok) { orClearForm(); loadOutreach(); }
    }

    // Adds ~20 verified statewide homeschool organisations. Safe to press twice — anything
    // already on the list is skipped by name.
    async function orSeed() {
      const msg = document.getElementById('orSaveMsg');
      if (!confirm('Add the starter list of statewide homeschool organisations?\n\nThey come with names and websites but no contacts — find a named person on each site before emailing.')) return;
      const { ok, data } = await C4K.api('/api/admin/outreach/seed', 'POST', {});
      if (msg) {
        msg.style.color = ok ? '#5ad17e' : '#ff8a8a';
        msg.textContent = ok
          ? `Added ${data.added}${data.skipped ? `, skipped ${data.skipped} already there` : ''}.`
          : ((data && data.error) || 'Could not load the starter list.');
      }
      if (ok) loadOutreach();
    }

    async function orDelete(id) {
      const o = OR_LIST.find(x => x.id === id);
      if (!confirm(`Remove ${o ? o.orgName : 'this organisation'} from the list?`)) return;
      const { ok } = await C4K.api('/api/admin/outreach/delete', 'POST', { id });
      if (ok) loadOutreach();
    }

    // Sends whatever is currently in the template box, with {{ORG}} and {{NAME}} filled in.
    async function orSend(id) {
      const o = OR_LIST.find(x => x.id === id);
      if (!o || !o.contactEmail) return;
      const subj = document.getElementById('orTplSubject')?.value || '';
      const raw = document.getElementById('orTplBody')?.value || '';
      if (!subj.trim() || !raw.trim()) { alert('Write a subject and message in the template panel first.'); return; }
      const fill = t => t.replace(/\{\{ORG\}\}/g, o.orgName || 'your organisation')
                        .replace(/\{\{NAME\}\}/g, (o.contactName || '').split(' ')[0] || 'there');
      const body = fill(raw);
      if (!confirm(`Send to ${o.contactName || o.orgName} <${o.contactEmail}>?\n\nSubject: ${fill(subj)}\n\nPreview:\n${body.slice(0, 220)}…`)) return;
      const { ok, data } = await C4K.api('/api/admin/outreach/send', 'POST', { id, subject: fill(subj), body });
      alert(ok ? `Sent to ${data.sentTo}.` : ((data && data.error) || 'Could not send.'));
      if (ok) loadOutreach();
    }

    async function loadSessionHistory() {
      const rows = document.getElementById('sessionHistoryRows');
      if (!rows) return;
      const { ok, data } = await C4K.api('/api/admin/session-history');
      if (!ok) { rows.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);">Could not load.</td></tr>'; return; }
      SESSION_HISTORY = data.sessions || [];
      renderSessionHistory();
    }
    function renderSessionHistory() {
      const rows = document.getElementById('sessionHistoryRows');
      if (!rows) return;
      const q = (document.getElementById('shSearch')?.value || '').trim().toLowerCase();
      const list = !q ? SESSION_HISTORY : SESSION_HISTORY.filter(s =>
        [s.hostName, s.hostUsername, s.code, s.sessionName].some(v => (v || '').toLowerCase().includes(q))
        || (s.kids || []).some(k => (k.name || k.username || '').toLowerCase().includes(q)));
      if (!list.length) {
        rows.innerHTML = `<tr><td colspan="5" style="color:var(--text-faint);">${SESSION_HISTORY.length ? 'Nothing matches that search.' : 'No finished sessions yet. They appear here once a session ends.'}</td></tr>`;
        return;
      }
      rows.innerHTML = list.map(s => {
        const hostTag = s.hostRole === 'admin' || s.hostRole === 'super_admin' ? '🛠️ ' : (s.hostRole === 'teacher' ? '🍎 ' : '');
        const kids = s.kids || [];
        const chips = kids.length
          ? kids.map(k => `<span style="display:inline-block;background:var(--surface-2);border:1px solid var(--border);border-radius:50px;padding:2px 10px;margin:2px 3px 2px 0;font-size:0.76rem;font-weight:800;">${C4K.esc(k.name || k.username)}</span>`).join('')
          : '<span style="color:var(--text-faint);font-size:0.78rem;">nobody joined</span>';
        const ended = (s.endedAt || '').replace('T', ' ').slice(0, 16);
        const why = s.endedBy === 'expired' ? 'timed out' : (s.endedBy === 'admin' ? 'ended by admin' : 'ended by host');
        return `<tr>
          <td style="white-space:nowrap;">${C4K.esc(ended)}<div style="color:var(--text-faint);font-size:0.74rem;">${why}</div></td>
          <td>${hostTag}${C4K.esc(s.hostName || 'Unknown')}${s.hostUsername ? ` <span style="color:var(--text-faint);font-size:0.78rem;">@${C4K.esc(s.hostUsername)}</span>` : ''}${s.sessionName ? `<div style="color:var(--text-faint);font-size:0.76rem;">${C4K.esc(s.sessionName)}</div>` : ''}</td>
          <td style="font-weight:900;letter-spacing:2px;">${C4K.esc(s.code)}</td>
          <td><strong>${s.kidCount}</strong><div style="margin-top:3px;">${chips}</div></td>
          <td style="color:var(--text-dim);white-space:nowrap;">${s.minutes != null ? (s.minutes < 60 ? s.minutes + ' min' : Math.round(s.minutes / 60) + ' hr') : '—'}</td>
        </tr>`;
      }).join('');
    }

    async function endOneSession(code) {
      if (!confirm(`End session ${code}? Kids in it will see the session-ended screen.`)) return;
      const { ok, data } = await C4K.api('/api/admin/end-session', 'POST', { code });
      if (ok) loadActiveSessions();
      else alert(data.error || 'Could not end that session.');
    }
    function setLockBtn() { const b = document.getElementById('sessLockBtn'); if (b) b.textContent = _sessLocked ? '🔓 Unlock joins' : '🔒 Lock joins'; }
    async function toggleLockSession() {
      if (!_sessLocked && !confirm('Lock joins now? Make sure every kid who wants in has already joined — nobody new will be able to after this.')) return;
      const { ok, data } = await C4K.api('/api/session/lock', 'POST', { locked: !_sessLocked });
      if (ok) { _sessLocked = data.locked; setLockBtn(); }
      else alert(data.error || 'Could not update.');
    }
    async function endLiveSession() {
      if (!confirm('End the live session? The join code will stop working.')) return;
      const { ok, data } = await C4K.api('/api/session/end', 'POST', {});
      document.getElementById('sessLive').style.display = 'none';
      const btn = document.getElementById('startSessBtn'); btn.disabled = false; btn.textContent = 'Start a session';
      if (_sessFeedTimer) { clearInterval(_sessFeedTimer); _sessFeedTimer = null; }
      if (ok && data.recap) showSessionRecap(data.recap);
    }
    function startSessFeed() {
      if (_sessFeedTimer) clearInterval(_sessFeedTimer);
      const load = async () => {
        const { ok, data } = await C4K.api('/api/session/feed');
        const el = document.getElementById('sessFeed'); if (!el) return;
        if (ok && data.feed && data.feed.length) {
          el.innerHTML = data.feed.map(f => `<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.12);">🎨 <strong>${C4K.esc(f.name||'?')}</strong> saved "${C4K.esc(f.title||'Untitled')}" · ${f.at}</div>`).join('');
        } else if (ok) { el.textContent = "Nobody's saved anything yet."; }
        const rEl = document.getElementById('sessRoster');
        const { ok: rOk, data: rData } = await C4K.api('/api/session/roster');
        if (rOk) _lastRoster = rData.roster || [];
        if (rEl && rOk && rData.roster && rData.roster.length) {
          rEl.innerHTML = rData.roster.map(k => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.12);">
              <span style="flex:1;">🙋 <strong>${C4K.esc(k.name||'?')}</strong> · joined ${k.joinedAt}</span>
              <button onclick="kickSessionGuest(${k.id},'${C4K.esc(k.name).replace(/'/g,"\\'")}')" style="background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.5);color:#fff;border-radius:6px;padding:2px 8px;font-size:0.72rem;font-weight:800;cursor:pointer;font-family:inherit;">Remove</button>
            </div>`).join('');
        } else if (rEl && rOk) { rEl.textContent = "No one's joined yet."; }
      };
      load();
      _sessFeedTimer = setInterval(load, 15000);
    }
    async function kickSessionGuest(kidId, name) {
      if (!confirm('Remove ' + name + ' from this session? They\'ll be signed out immediately.')) return;
      const { ok, data } = await C4K.api('/api/session/kick', 'POST', { kidId });
      if (!ok) alert('⚠️ ' + (data.error || 'Could not remove.'));
    }
    let _lastRoster = [];
    function exportRosterCSV() {
      if (!_lastRoster.length) { alert('No one has joined this session yet.'); return; }
      const rows = [['Nickname', 'Joined (local time)'], ..._lastRoster.map(k => [k.name || '', k.joinedAt || ''])];
      const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `kidvibers-session-roster-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
    }
    function showSessionRecap(r) {
      const mins = r.minutes ? (r.minutes >= 60 ? Math.floor(r.minutes/60)+'h '+(r.minutes%60)+'m' : r.minutes+' min') : '—';
      setText('recapWhen', new Date().toLocaleString());
      setText('recapJoins', r.joins || 0);
      setText('recapCreations', r.creations || 0);
      setText('recapMins', mins);
      document.getElementById('recapModal').style.display = 'flex';
      document.body.classList.add('recap-printing');
    }

    // ── Real super-admin auth via backend (auth.js / C4K) ──
    const ADMIN_ROLES = ['admin', 'super_admin'];

    async function showDashboard() {
      document.getElementById('loginWrap').style.display = 'none';
      document.getElementById('adminShell').classList.add('active');
      if (C4K.user && C4K.user.username) {
        setText('whoName', C4K.user.username);
        setText('whoName2', C4K.user.username);
      }
      const isSuper = C4K.user && C4K.user.role === 'super_admin';
      setText('panelLabel', isSuper ? '/ Super Admin Panel 👑' : '/ Admin Panel 🛠️');
      document.getElementById('previewToggle').checked = _adminPreviewMode;
      document.getElementById('previewBanner').style.display = _adminPreviewMode ? 'flex' : 'none';
      if (!(C4K.user && C4K.user.isPreview)) openWhatsNew();
      startStaffChat();
      await loadData();
    }
    // ── What's New — admin-only items (auth.js has the shared, audience-tagged list) ──
    function openWhatsNew(force) {
      C4K.showWhatsNew({ audience: 'admin', storageKey: 'c4k_wn_seen_admin', listId: 'wnList', versionId: 'wnVersion', popupId: 'whatsNew', force });
    }
    function closeWhatsNew() {
      C4K.closeWhatsNew({ storageKey: 'c4k_wn_seen_admin', popupId: 'whatsNew' });
    }

    // ── Sidebar navigation: scroll to a section and mark it active. All existing panels stay
    // exactly where they were on the page — this just makes it easy to jump straight to one. ──
    // Every admin page shares this script but only contains its own panels, so an element
    // that isn't on this page is normal, not an error. These make a missing target a no-op
    // instead of a TypeError that aborts the rest of init.
    function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
    function setHTML(id, v) { const e = document.getElementById(id); if (e) e.innerHTML = v; }

    // ── Pages ─────────────────────────────────────────────────────────────────
    // Each admin feature is its own file (admin.html, admin-live.html, admin-revenue.html…),
    // all sharing this script. The page announces itself with data-admin-page on the shell,
    // so the shared init below only runs the loaders whose panels are actually on this page.
    // Every loader also guards on element presence, so a stray call is a no-op rather than
    // a crash that takes the rest of the page down with it.
    const ADM_PAGES = [
      { slug: 'dashboard', file: 'admin.html',              label: '🏠 Dashboard' },
      { slug: 'live',      file: 'admin-live.html',         label: '🎟️ Live Sessions' },
      { slug: 'chat',      file: 'admin-chat.html',         label: '💬 Staff Chat' },
      { slug: 'create',    file: 'admin-create.html',       label: '➕ Create Account' },
      { slug: 'preview',   file: 'admin-preview.html',      label: '👁️ Preview Dashboards' },
      { slug: 'search',    file: 'admin-search.html',       label: '🔎 Find Any Account', super: true },
      { slug: 'overview',  file: 'admin-overview.html',     label: '📊 Overview & Growth', super: true },
      { slug: 'people',    file: 'admin-people.html',       label: '👥 People & Accounts', super: true },
      { slug: 'admins',    file: 'admin-admins.html',       label: '🛡️ Admin Accounts', super: true },
      { slug: 'staff',     file: 'admin-staff.html',        label: '🕵️ Staff Logins', super: true },
      { slug: 'safety',    file: 'admin-safety.html',       label: '🛡️ Safety & Consent', super: true },
      { slug: 'data',      file: 'admin-data.html',         label: '📄 Data Requests', super: true },
      { slug: 'security',  file: 'admin-security.html',     label: '🔐 Security', super: true },
      { slug: 'audit',     file: 'admin-audit.html',        label: '🕵️ Audit Log', super: true },
      { slug: 'flags',     file: 'admin-flags.html',        label: '🚩 Feature Flags', super: true },
      { slug: 'billing',   file: 'admin-billing.html',      label: '💳 Billing & Promos', super: true },
      { slug: 'revenue',   file: 'admin-revenue.html',      label: '💰 Revenue', super: true },
      { slug: 'comms',     file: 'admin-comms.html',        label: '📣 Communication', super: true },
      { slug: 'outreach',  file: 'admin-outreach.html',     label: '📣 Outreach', super: true },
      { slug: 'settings',  file: 'admin-settings.html',     label: '⚙️ Settings', super: true },
    ];
    function admCurrentPage() {
      const shell = document.getElementById('adminShell');
      const slug = shell && shell.dataset.adminPage;
      return ADM_PAGES.some(p => p.slug === slug) ? slug : 'dashboard';
    }
    function admMarkActiveLink() {
      const slug = admCurrentPage();
      document.querySelectorAll('.sb-link[data-page]').forEach(a => {
        a.classList.toggle('active', a.dataset.page === slug);
      });
    }
    // Kept so any leftover inline onclick="navTo(...)" still navigates instead of throwing.
    function navTo(slug, ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      const p = ADM_PAGES.find(x => x.slug === slug);
      location.href = p ? p.file : 'admin.html';
    }
    // Show a floating "back to top" button once the admin scrolls past the top bar.
    window.addEventListener('scroll', () => {
      const btn = document.getElementById('backToTopBtn');
      if (btn) btn.style.display = window.scrollY > 400 ? 'block' : 'none';
    }, { passive: true });
    // The top-bar search doubles as a shortcut into the real "Find Any Account" search below —
    // typing here jumps you there and keeps both boxes in sync, instead of being decorative.
    function topSearchSync(val) {
      const real = document.getElementById('kidSearch');
      if (!real) return;
      if (val && real.value !== val) { real.value = val; if (typeof searchKids === 'function') searchKids(); }
      if (val) document.getElementById('searchPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    let _chatTimer = null;
    function startStaffChat() {
      if (_chatTimer) clearInterval(_chatTimer);
      const load = async () => {
        const el = document.getElementById('chatFeed'); if (!el) return;
        const { ok, data } = await C4K.api('/api/admin/chat/list');
        if (!ok) { return; }
        const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        if (!data.messages || !data.messages.length) {
          el.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;">No messages yet — say hi! 👋</div>';
          return;
        }
        el.innerHTML = data.messages.map(m => `
          <div style="align-self:${m.mine ? 'flex-end' : 'flex-start'};max-width:80%;">
            <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:2px;${m.mine ? 'text-align:right;' : ''}">${C4K.esc(m.name || m.username)} · ${m.role === 'super_admin' ? '👑 ' : ''}${m.at}</div>
            <div style="background:${m.mine ? 'linear-gradient(135deg,#7c3aed,#db2777)' : 'var(--surface)'};color:${m.mine ? '#fff' : 'var(--text)'};border:1px solid var(--border);padding:8px 12px;border-radius:12px;font-size:0.88rem;white-space:pre-wrap;word-break:break-word;">${C4K.esc(m.body)}</div>
          </div>`).join('');
        if (wasAtBottom) el.scrollTop = el.scrollHeight;
      };
      load();
      _chatTimer = setInterval(load, 15000);
    }
    async function sendStaffChat() {
      const inp = document.getElementById('chatInput');
      const body = (inp.value || '').trim();
      if (!body) return;
      inp.value = '';
      inp.disabled = true;
      const { ok, data } = await C4K.api('/api/admin/chat/send', 'POST', { body });
      inp.disabled = false;
      inp.focus();
      if (!ok) { alert((data && data.error) || 'Could not send message.'); inp.value = body; return; }
      const el = document.getElementById('chatFeed');
      const { ok: lOk, data: lData } = await C4K.api('/api/admin/chat/list');
      if (lOk && el) {
        el.innerHTML = (lData.messages || []).map(m => `
          <div style="align-self:${m.mine ? 'flex-end' : 'flex-start'};max-width:80%;">
            <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:2px;${m.mine ? 'text-align:right;' : ''}">${C4K.esc(m.name || m.username)} · ${m.role === 'super_admin' ? '👑 ' : ''}${m.at}</div>
            <div style="background:${m.mine ? 'linear-gradient(135deg,#7c3aed,#db2777)' : 'var(--surface)'};color:${m.mine ? '#fff' : 'var(--text)'};border:1px solid var(--border);padding:8px 12px;border-radius:12px;font-size:0.88rem;white-space:pre-wrap;word-break:break-word;">${C4K.esc(m.body)}</div>
          </div>`).join('');
        el.scrollTop = el.scrollHeight;
      }
    }

    async function doLogin(e) {
      e.preventDefault();
      const u = document.getElementById('username').value.trim();
      const p = document.getElementById('password').value;
      const err = document.getElementById('loginError');
      const { ok, data } = await C4K.adminLogin(u, p);
      if (ok) { err.textContent = ''; showDashboard(); }
      else { err.textContent = '❌ ' + (data.error || 'Login failed.'); }
    }

    async function doLogout() { await C4K.logout(); location.reload(); }

    const isSuper = () => C4K.user && C4K.user.role === 'super_admin';

    // Confirms which database the panel is reading: green for the real production data,
    // a loud amber warning if it's pointed at the staging (test) database by mistake.
    function renderDbStatus(environment, kidCount) {
      const el = document.getElementById('dbStatus');
      if (!el) return;
      const kids = (kidCount ?? '?') + ' kid' + (kidCount === 1 ? '' : 's');
      if (environment === 'staging') {
        el.style.background = 'rgba(245,158,11,0.15)';
        el.style.border = '1px solid #f59e0b';
        el.style.color = '#fbbf24';
        el.textContent = '⚠️ Reading the STAGING test database (not your live kids) · ' + kids;
      } else {
        el.style.background = 'rgba(52,211,153,0.13)';
        el.style.border = '1px solid #34d399';
        el.style.color = '#34d399';
        el.textContent = '✓ Connected to production · ' + kids;
      }
      el.style.display = 'flex';
    }

    // Show a dashboard-level "couldn't load" banner instead of leaving boxes silently blank.
    function showDataError(msg) {
      const box = document.getElementById('dashError');
      if (!box) return;
      const em = document.getElementById('dashErrorMsg');
      if (em) em.textContent = ' ' + msg;
      box.style.display = '';
    }

    async function loadData() {
      const sup = isSuper();
      const dErr = document.getElementById('dashError');
      if (dErr) dErr.style.display = 'none';   // reset; re-shown only if something actually fails
      // toggle super-admin-only UI
      document.querySelectorAll('.super-only').forEach(el => el.style.display = sup ? '' : 'none');
      document.querySelectorAll('.super-only-col').forEach(el => el.style.display = sup ? '' : 'none');
      const createHintEl = document.getElementById('createHint');
      if (createHintEl) createHintEl.textContent = sup ? 'creates the account instantly' : 'sent to the super admin to approve';
      caRoleChanged();
      loadAdminNotices();
      if (sup) { loadNotifyHistory(); loadScheduled(); loadAutomations(); }

      // Hide the sidebar links this role can't reach. The super-only reveal above already
      // ran, so this only has to take care of the ones it left visible.
      ADM_PAGES.forEach(pg => {
        if (!pg.super) return;
        const link = document.querySelector(`.sb-link[data-page="${pg.slug}"]`);
        if (link && !sup) link.style.display = 'none';
      });
      // A non-super admin who lands on a super-only page gets sent to the dashboard rather
      // than an empty shell. The API enforces the real permission check on every call, so
      // this is a courtesy, not the security boundary.
      const cur = ADM_PAGES.find(x => x.slug === admCurrentPage());
      if (!sup && cur && cur.super) { location.replace('admin.html'); return; }
      admMarkActiveLink();

      // Only run the loaders whose panels exist on this page.
      const page = admCurrentPage();
      if (page === 'outreach') {
        if (typeof orRenderTabs === 'function') { orRenderTabs(); orResetTemplate(); }
        if (typeof loadOutreach === 'function') loadOutreach();
      }
      if (page === 'live') {
        if (typeof loadActiveSessions === 'function') loadActiveSessions();
        if (typeof loadSessionHistory === 'function') loadSessionHistory();
      }

      // Stat boxes — load in isolation so one failing API call can never blank the whole dashboard.
      try {
        const r = await C4K.api('/api/admin/stats');
        if (!r.ok) throw new Error((r.data && r.data.error) || ('the server returned ' + (r.status || 'no response')));
        const stats = r.data || {};
        setText('statKids', stats.totalKids ?? '-');
        setText('statLessons', stats.lessonsCompleted ?? '-');
        setText('statPro', stats.proKids ?? '-');
        setText('statTrial', stats.trialKids ?? '-');
        setText('statSessions', stats.sessionsStarted ?? '-');
        setText('statSessionsTrend', `${stats.sessionJoins ?? 0} kids joined lifetime`);
        setText('statSessionsActive', stats.sessionsActive ?? '-');
        renderDbStatus(stats.environment, stats.totalKids);
      } catch (e) {
        showDataError('The stat boxes failed to load (' + e.message + '). If you just deployed, give it a moment and tap Retry.');
      }

      // Individual kid/account detail (names, usernames, emails) is super-admin only — a plain
      // admin sees analytics/totals (already loaded above via /api/admin/stats) but never the
      // per-kid or per-account list. The backend enforces this too (not just hidden in the UI).
      if (sup) {
        const userRowsEl = document.getElementById('userRows');
        if (!userRowsEl) return;               // People page only
        const users = (await C4K.api('/api/admin/users')).data.users || [];
        const planClass = p => (p === 'pro' || p === 'family') ? 'pro' : (p === 'trial' ? 'trial' : 'free');
        const uHead = userRowsEl.closest('table');
        if (uHead) { const th = uHead.querySelector('thead th:last-child'); if (th) th.textContent = 'Change Plan'; }
        userRowsEl.innerHTML = users.length ? users.map(u =>
          `<tr>
             <td><strong>${C4K.esc(u.name)}</strong><br><span style="color:var(--text-faint);font-size:0.78rem;">@${C4K.esc(u.username)}</span>${u.parentEmail ? `<br><span style="color:var(--text-dim);font-size:0.74rem;">📧 ${C4K.esc(u.parentEmail)}</span>` : ''}</td>
             <td><span class="pill ${planClass(u.effectivePlan)}">${u.effectivePlan}</span></td>
             <td>${u.hasAI ? '🤖 yes' : '- no'}</td>
             <td>
               <select onchange="setPlan(${u.id}, this.value)" class="mini-btn" style="padding:5px 8px;">
                 <option ${u.plan==='free'?'selected':''}>free</option>
                 <option ${u.plan==='trial'?'selected':''}>trial</option>
                 <option ${u.plan==='pro'?'selected':''}>pro</option>
                 <option ${u.plan==='family'?'selected':''}>family</option>
               </select>
             </td>
           </tr>`).join('')
          : '<tr><td colspan="4" style="color:var(--text-faint);">No kid accounts yet - sign one up on the home page!</td></tr>';

        // every registered account, kept forever
        const accts = (await C4K.api('/api/admin/accounts')).data.accounts || [];
        const acctCountEl = document.getElementById('acctCount');
        if (acctCountEl) acctCountEl.textContent = `· ${accts.length} kept`;
        _allAccts = accts; _sup = sup;

        // Real account breakdown by type (computed from the live accounts list).
        const bd = { kid: 0, guest: 0, parent: 0, teacher: 0, school: 0, district: 0, admin: 0, super_admin: 0 };
        accts.forEach(a => {
          if (a.role === 'kid') { bd.kid++; }
          else if (a.role === 'teacher') { bd[(a.plan === 'district' ? 'district' : a.plan === 'school' ? 'school' : 'teacher')]++; }
          else if (bd[a.role] !== undefined) { bd[a.role]++; }
        });
        const bdDefs = [
          ['👦 Kids', bd.kid], ['👨‍👩‍👧 Parents', bd.parent], ['🍎 Teachers', bd.teacher],
          ['🏫 Schools', bd.school], ['🏛️ Districts', bd.district], ['🛠️ Admins', bd.admin + bd.super_admin],
        ];
        const bdTotal = accts.length || 1;
        const bdEl = document.getElementById('breakdownRows');
        if (bdEl) bdEl.innerHTML = bdDefs.map(([label, n]) =>
          `<tr><td><strong>${label}</strong></td><td style="font-weight:900;">${n}</td>
             <td style="width:110px;"><div style="height:7px;background:var(--surface-2);border-radius:50px;overflow:hidden;"><div style="height:100%;width:${Math.round(n / bdTotal * 100)}%;background:linear-gradient(90deg,#7c3aed,#db2777);"></div></div></td></tr>`).join('');
      } else {
        // Plain admin: no individual account data fetched or shown at all — pointing at the two
        // things that ARE available instead: aggregate Analytics, and the Preview Dashboards
        // tool (real-looking mock data, no actual account exposure).
        const usersTable = document.querySelector('#userRows');
        if (usersTable) usersTable.closest('.panel').innerHTML = '<h3>👥 Recent Members</h3><p style="color:var(--text-dim);font-size:0.9rem;">🔒 Individual member details are restricted to super admin. See <strong>📈 Analytics</strong> for aggregate numbers, or <strong>👁️ Preview Dashboards</strong> to see what an account looks like with realistic sample data.</p>';
        const acctPanel = document.querySelector('#acctRows');
        if (acctPanel) acctPanel.closest('.panel').innerHTML = '<h3>📋 All Registered Accounts</h3><p style="color:var(--text-dim);font-size:0.9rem;">🔒 The full account list is restricted to super admin. See <strong>📈 Analytics</strong> for aggregate numbers, or <strong>👁️ Preview Dashboards</strong> to see what an account looks like with realistic sample data.</p>';
      }
      loadAnalytics();   // available to both plain admin and super admin — aggregate data only
      loadActiveSessions();   // ditto — no individual kid data, just who's hosting + a headcount

      if (sup) {
        loadAuditLog();
        loadSecurityDashboard();
        loadDataRequests();
      }
      setText('acctActionHead', sup ? 'Actions' : '');
      renderAccountRows();

      // Lessons + plan settings: super admin reads the editable /api/admin/settings;
      // a plain admin just reads the public published list.
      if (sup) {
        const s = (await C4K.api('/api/admin/settings')).data;
        renderPlans(s.planSettings || {}, s.passPercent);
        renderLessons(s.lessons || [], true);
        loadConsent();
        loadAccountRequests();
        loadSiteMessage();
        loadToggles();
        loadInterest();
        loadChangeRequest();
        loadEmailEvents();
        loadQuiz();
        loadEmails();
        loadConsentGroups();
        const bulkBarEl = document.getElementById('bulkBar');
        if (bulkBarEl) bulkBarEl.style.display = 'flex';
        loadSchoolHealth();
        loadStaffLogins();
        loadCohortRetention();
        loadExpiryQueue();
        loadLessonReports();
        loadErrorLog();
        loadFeatureFlags();
        loadAdmins();
        loadPromoCodes();
        loadStripeCoupons();
        loadRevenue();
        loadAutoFlagConfig();
      } else {
        const ls = (await (await fetch('/api/lessons')).json()).lessons || [];
        renderLessons(ls, false);
      }
      // Visible to both admin and super_admin (matches backend's ADMIN_ROLES gate).
      loadOnlineNow();
      if (!_onlineNowTimer) _onlineNowTimer = setInterval(loadOnlineNow, 30000);
    }

    // ── Accounts table: search, sort, CSV export (power-user tools) ──
    let _allAccts = [], _sup = false, _sortKey = null, _sortDir = 1;
    const _roleTag = (r, plan) => r === 'parent' ? '👨‍👩‍👧 parent'
      : (r === 'admin' ? '🛠️ admin'
      : (r === 'super_admin' ? '👑 super admin'
      : (r === 'teacher' ? (plan === 'district' ? '🏛️ district' : plan === 'school' ? '🏫 school' : '🍎 teacher')
      : '👦 kid')));
    function sortAccounts(key) {
      if (_sortKey === key) _sortDir *= -1; else { _sortKey = key; _sortDir = 1; }
      ['name', 'username', 'role', 'plan', 'joined'].forEach(k => {
        const el = document.getElementById('sortIcon-' + k);
        if (el) el.textContent = (k === _sortKey) ? (_sortDir === 1 ? '▲' : '▼') : '';
      });
      renderAccountRows();
    }
    function renderAccountRows() {
      const q = (document.getElementById('acctSearch') ? document.getElementById('acctSearch').value : '').trim().toLowerCase();
      let list = _allAccts.filter(a => !q ||
        (a.name || '').toLowerCase().includes(q) || (a.username || '').toLowerCase().includes(q) ||
        (a.role || '').toLowerCase().includes(q) || (a.plan || '').toLowerCase().includes(q));
      if (_sortKey) {
        list = list.slice().sort((a, b) => {
          const av = (a[_sortKey] || '').toString().toLowerCase(), bv = (b[_sortKey] || '').toString().toLowerCase();
          return av < bv ? -_sortDir : av > bv ? _sortDir : 0;
        });
      }
      const sup = _sup;
      const acctRowsEl = document.getElementById('acctRows');
      if (!acctRowsEl) return;                 // accounts table isn't on this page
      acctRowsEl.innerHTML = list.length ? list.map((a, i) => {
        const nm = (a.name||'').replace(/'/g,"\\'").replace(/</g,'').replace(/>/g,'');
        const isDemo = (a.username || '').toLowerCase() === 'demo_kid1';   // never bulk-select the pitch demo account
        const suspTip = a.suspended ? (a.suspendUntil ? ('til ' + a.suspendUntil.slice(0,10)) : 'permanent') : '';
        const suspBadge = a.suspended ? ` <span title="${a.suspendReason ? C4K.esc(a.suspendReason) : ''}" style="font-size:0.66rem;font-weight:900;color:#f59e0b;border:1px solid rgba(245,158,11,.5);border-radius:50px;padding:1px 7px;">⏸️ SUSPENDED (${suspTip})</span>` : '';
        const demoBadge = isDemo ? ` <span title="Used for live pitch demos — protected from bulk actions" style="font-size:0.66rem;font-weight:900;color:#22d3ee;border:1px solid rgba(34,211,238,.5);border-radius:50px;padding:1px 7px;">🎭 DEMO</span>` : '';
        return `<tr${a.suspended ? ' style="opacity:.6;"' : ''}>
           <td class="super-only" style="display:none;"><input type="checkbox" class="bulkCb" data-id="${a.id}" ${(a.role === 'super_admin' || isDemo) ? 'disabled' : ''} onchange="updateBulkCount()" /></td>
           <td>${i + 1}</td>
           <td><strong>${C4K.esc(a.name)}</strong>${suspBadge}${demoBadge}${a.notes ? ` <span title="${C4K.esc(a.notes)}" style="cursor:help;">📝</span>` : ''}</td>
           <td><span style="color:var(--text-dim);">@${C4K.esc(a.username)}</span>${(sup && a.role === 'kid' && a.parentEmail) ? `<br><span style="color:var(--text-faint);font-size:0.72rem;">📧 ${C4K.esc(a.parentEmail)}</span>` : ''}</td>
           <td>${_roleTag(a.role, a.plan)}</td>
           <td><span class="pill ${(a.plan==='pro'||a.plan==='family')?'pro':(a.plan==='trial'?'trial':'free')}">${a.plan}</span></td>
           <td style="color:var(--text-dim);">${a.joined || '-'}</td>
           <td>${sup ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">
             <button class="mini-btn" onclick="impersonate(${a.id},'${a.role}')">Log in as</button>
             <button class="mini-btn" style="color:#60a5fa;border-color:rgba(96,165,250,.4);" onclick="setCreds(${a.id},'${nm}','${a.username}')">🔑 Login</button>
             <button class="mini-btn" onclick="sendNotice(${a.id},'${nm}')">📨 Notice</button>
             <button class="mini-btn" onclick="editNotes(${a.id},'${nm}','${(a.notes||'').replace(/'/g,"\\'").replace(/</g,'').replace(/>/g,'')}')">📝 Notes</button>
             ${(a.role === 'super_admin' || isDemo) ? '' : (a.suspended
               ? `<button class="mini-btn" style="color:#34d399;border-color:rgba(52,211,153,.4);" onclick="suspendUser(${a.id},'${nm}',false)">▶️ Unsuspend</button>`
               : `<button class="mini-btn" style="color:#f59e0b;border-color:rgba(245,158,11,.4);" onclick="suspendUser(${a.id},'${nm}',true)">⏸️ Suspend</button>`)}
             ${(a.role === 'super_admin' || isDemo) ? '' : `<button class="mini-btn" style="color:#f87171;border-color:rgba(239,68,68,.4);" onclick="deleteUser(${a.id},'${nm}')">🗑️ Delete</button>`}
           </div>` : ''}</td>
         </tr>`; }).join('')
        : '<tr><td colspan="7" style="color:var(--text-faint);">No accounts match.</td></tr>';
    }
    function exportAccountsCsv() {
      const rows = [['ID', 'Name', 'Username', 'Role', 'Plan', 'Joined', 'Suspended']];
      _allAccts.forEach(a => rows.push([a.id, a.name || '', a.username || '', a.role || '', a.plan || '', a.joined || '', a.suspended ? 'yes' : 'no']));
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-accounts-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    }

    // ── Bulk actions ──
    function toggleAllBulk(master) {
      document.querySelectorAll('.bulkCb').forEach(cb => { if (!cb.disabled) cb.checked = master.checked; });
      updateBulkCount();
    }
    function selectedBulkIds() {
      return Array.from(document.querySelectorAll('.bulkCb:checked')).map(cb => +cb.dataset.id);
    }
    function updateBulkCount() {
      setText('bulkCount', selectedBulkIds().length + ' selected');
    }
    async function bulkSuspend(suspend) {
      const ids = selectedBulkIds();
      if (!ids.length) return alert('Select at least one account first.');
      const reason = suspend ? (prompt('Reason for suspending these ' + ids.length + ' accounts?') || '') : '';
      if (suspend === null) return;
      if (!confirm((suspend ? 'Suspend' : 'Unsuspend') + ' ' + ids.length + ' accounts?')) return;
      const { ok, data } = await C4K.api('/api/admin/bulk-suspend', 'POST', { userIds: ids, suspended: suspend, reason });
      if (ok) { alert('✅ Updated ' + data.count + ' accounts.'); loadData(); } else alert(data.error || 'Could not update.');
    }
    async function bulkMessage() {
      const ids = selectedBulkIds();
      if (!ids.length) return alert('Select at least one account first.');
      const message = prompt('Message to send to ' + ids.length + ' accounts:');
      if (!message) return;
      const { ok, data } = await C4K.api('/api/admin/bulk-message', 'POST', { userIds: ids, message });
      if (ok) alert('✅ Sent to ' + data.count + ' accounts.'); else alert(data.error || 'Could not send.');
    }
    async function bulkExportSelected() {
      const ids = selectedBulkIds();
      if (!ids.length) return alert('Select at least one account first.');
      const res = await fetch('/api/admin/bulk-export', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + C4K.token() }, body: JSON.stringify({ userIds: ids }) });
      if (!res.ok) return alert('Could not export — try again.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-export-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    }

    // ── Global search: accounts + Vibe Studio projects + teacher class codes ──
    let _globalSearchTimer = null;
    function globalSearch() {
      clearTimeout(_globalSearchTimer);
      _globalSearchTimer = setTimeout(doGlobalSearch, 350);
    }
    async function doGlobalSearch() {
      const q = document.getElementById('kidSearch').value.trim();
      const wrap = document.getElementById('globalSearchExtra');
      if (!wrap) return;
      if (!q || q.length < 2) { wrap.innerHTML = ''; return; }
      const { ok, data } = await C4K.api('/api/admin/global-search?q=' + encodeURIComponent(q));
      if (!ok) return;
      const projects = data.projects || [], classCodes = data.classCodes || [];
      if (!projects.length && !classCodes.length) { wrap.innerHTML = ''; return; }
      let html = '';
      if (classCodes.length) {
        html += `<div style="font-size:0.72rem;font-weight:900;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">🔑 Matching class codes</div>` +
          classCodes.map(c => `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin-bottom:6px;font-size:0.85rem;">
            <strong>${C4K.esc(c.name)}</strong> (@${C4K.esc(c.username)}) — code <span style="color:var(--purple);font-weight:800;">${C4K.esc(c.class_code)}</span>${c.school ? ' · ' + C4K.esc(c.school) : ''}
          </div>`).join('');
      }
      if (projects.length) {
        html += `<div style="font-size:0.72rem;font-weight:900;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin:10px 0 6px;">🎨 Matching Vibe Studio projects</div>` +
          projects.map(p => `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin-bottom:6px;font-size:0.85rem;">
            <strong>${C4K.esc(p.title || 'Untitled')}</strong> by ${C4K.esc(p.author_name || p.username || '?')}${p.shared ? ' · 🌐 shared' : ''}
          </div>`).join('');
      }
      wrap.innerHTML = html;
    }

    // ── Revenue dashboard ──
    async function loadRevenue() {
      if (!document.getElementById('revChart')) return;   // Revenue page only
      const { ok, data } = await C4K.api('/api/admin/revenue');
      if (!ok) return;
      setText('revMrr', '$' + (data.currentMrr || 0));
      setText('revPro', (data.currentBreakdown && data.currentBreakdown.pro) || 0);
      setText('revFamily', (data.currentBreakdown && data.currentBreakdown.family) || 0);
      setText('revTeacher', (data.currentBreakdown && data.currentBreakdown.teacher) || 0);
      const hist = data.history || [];
      const chart = document.getElementById('revChart');
      if (!hist.length) { chart.innerHTML = '<div style="color:var(--text-faint);font-size:0.8rem;">No weekly snapshots yet — the first is taken next Monday.</div>'; return; }
      const max = Math.max(1, ...hist.map(h => h.mrr));
      chart.innerHTML = hist.map(h => `<div title="${h.at}: $${h.mrr}" style="flex:1;background:linear-gradient(180deg,#7c3aed,#db2777);border-radius:3px 3px 0 0;min-width:6px;height:${Math.max(4, Math.round((h.mrr / max) * 60))}px;"></div>`).join('');
    }
    async function cancelSubscription() {
      const userId = parseInt(document.getElementById('cancelSubUserId').value, 10);
      const confirmTxt = document.getElementById('cancelSubConfirm').value.trim();
      const refund = document.getElementById('cancelSubRefund').checked;
      const msg = document.getElementById('cancelSubMsg');
      if (!userId) { msg.style.color = '#f87171'; msg.textContent = 'Enter a user ID.'; return; }
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Cancelling…';
      const { ok, data } = await C4K.api('/api/admin/cancel-subscription', 'POST', { userId, confirm: confirmTxt, refund });
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = '✅ Subscription cancelled' + (data.refunded ? ' and latest invoice refunded.' : '.'); document.getElementById('cancelSubConfirm').value = ''; loadRevenue(); }
      else { msg.style.color = '#f87171'; msg.textContent = data.error || 'Could not cancel.'; }
    }

    // ── Online right now ──
    let _onlineNowTimer = null;
    async function loadOnlineNow() {
      const { ok, data } = await C4K.api('/api/admin/online-now');
      const el = document.getElementById('onlineNowBody');
      if (!el) return;
      if (!ok) return;
      if (!data.total) { el.innerHTML = 'Nobody active in the last 5 minutes.'; return; }
      const byRoleTxt = Object.entries(data.byRole || {}).map(([r, n]) => `${n} ${r}`).join(' · ');
      el.innerHTML = `<div style="font-weight:900;font-size:1.3rem;color:#4ade80;margin-bottom:4px;">${data.total} online</div>
        <div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:10px;">${C4K.esc(byRoleTxt)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${(data.users || []).slice(0, 30).map(u => `<span style="background:var(--surface-2);border:1px solid var(--border);border-radius:50px;padding:3px 10px;font-size:0.78rem;font-weight:700;">${C4K.esc(u.name || u.username)} <span style="color:var(--text-faint);">(${C4K.esc(u.role)})</span></span>`).join('')}</div>`;
    }

    // ── Feature flag scheduling ──
    async function scheduleFlag() {
      const flag = document.getElementById('schedFlagKey').value;
      const value = document.getElementById('schedFlagValue').value === 'true';
      const at = document.getElementById('schedFlagAt').value;
      const msg = document.getElementById('schedFlagMsg');
      if (!at) { msg.style.color = '#f87171'; msg.textContent = 'Pick a date/time.'; return; }
      const { ok, data } = await C4K.api('/api/admin/schedule-flag', 'POST', { flag, value, at: new Date(at).toISOString() });
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = '✅ Scheduled.'; renderScheduledFlags(data.scheduled); }
      else { msg.style.color = '#f87171'; msg.textContent = data.error || 'Could not schedule.'; }
    }
    function renderScheduledFlags(map) {
      const el = document.getElementById('schedFlagList');
      if (!el) return;
      const keys = Object.keys(map || {});
      if (!keys.length) { el.innerHTML = ''; return; }
      const labels = { vibeStudio: '🎨 Vibe Studio', liveSessions: '🎟️ Live Sessions', referrals: '🎁 Referrals' };
      el.innerHTML = '<strong>Pending:</strong> ' + keys.map(k => `${labels[k] || k} → ${map[k].value ? 'ON' : 'OFF'} at ${new Date(map[k].at).toLocaleString()}`).join(' · ');
    }

    // ── Compliance export by email ──
    async function runComplianceExport() {
      const email = document.getElementById('complianceEmail').value.trim();
      const msg = document.getElementById('complianceMsg');
      if (!email || !email.includes('@')) { msg.style.color = '#f87171'; msg.textContent = 'Enter a valid email.'; return; }
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Exporting…';
      const res = await fetch('/api/admin/compliance-export?email=' + encodeURIComponent(email), { headers: { Authorization: 'Bearer ' + C4K.token() } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); msg.style.color = '#f87171'; msg.textContent = d.error || 'Could not export.'; return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-compliance-' + new Date().toISOString().slice(0,10) + '.json'; a.click();
      msg.style.color = 'var(--green,#4ade80)'; msg.textContent = '✅ Downloaded.';
    }

    // ── Auto-flag rule config ──
    async function loadAutoFlagConfig() {
      if (!document.getElementById('autoFlagEnabled')) return;   // not on this page
      const { ok, data } = await C4K.api('/api/admin/autoflag-config');
      if (!ok || !data.config) return;
      document.getElementById('autoFlagEnabled').checked = !!data.config.enabled;
      document.getElementById('autoFlagThreshold').value = data.config.threshold;
      document.getElementById('autoFlagWindow').value = data.config.windowHours;
    }
    async function saveAutoFlagConfig() {
      const enabled = document.getElementById('autoFlagEnabled').checked;
      const threshold = parseInt(document.getElementById('autoFlagThreshold').value, 10) || 3;
      const windowHours = parseInt(document.getElementById('autoFlagWindow').value, 10) || 24;
      const msg = document.getElementById('autoFlagMsg');
      const { ok, data } = await C4K.api('/api/admin/autoflag-config', 'POST', { enabled, threshold, windowHours });
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = '✅ Saved.'; }
      else { msg.style.color = '#f87171'; msg.textContent = data.error || 'Could not save.'; }
    }
    async function editNotes(userId, name, current) {
      const notes = prompt('Notes for ' + name + ':', current || '');
      if (notes === null) return;
      await C4K.api('/api/admin/notes', 'POST', { userId, notes });
      loadData();
    }

    // ── Security dashboard ──
    async function loadSecurityDashboard() {
      const { ok, data } = await C4K.api('/api/admin/security-dashboard');
      const grid = document.getElementById('secDashGrid');
      if (!grid) return;
      if (!ok) { grid.innerHTML = '<div style="color:var(--text-faint);">Could not load.</div>'; return; }
      const stat = (n, label, warn) => `<div style="background:var(--surface-2);border-radius:10px;padding:12px;text-align:center;">
        <div style="font-size:1.5rem;font-weight:900;color:${warn && n > 0 ? '#f87171' : 'var(--purple)'};">${n}</div>
        <div style="font-size:0.7rem;color:var(--text-faint);font-weight:800;text-transform:uppercase;">${label}</div></div>`;
      grid.innerHTML = stat(data.openIncidents, 'Open Incidents', true)
        + stat(data.incidents24h, 'New (24h)', true)
        + stat(data.escalated, 'Escalated', true)
        + stat(data.suspended, 'Suspended Accts')
        + stat(data.openRequests, 'Open Data Requests');
    }
    async function loadRateLimits() {
      const rows = document.getElementById('rateLimitRows');
      if (!rows) return;
      rows.innerHTML = '<tr><td colspan="3" style="color:var(--text-faint);">Loading…</td></tr>';
      const { ok, data } = await C4K.api('/api/admin/rate-limits');
      const list = (ok && data.entries) || [];
      rows.innerHTML = list.length ? list.map(e => `<tr>
          <td style="font-family:monospace;font-size:0.82rem;">${C4K.esc(e.key)}</td>
          <td style="font-weight:800;">${e.count}</td>
          <td style="color:var(--text-dim);">${e.ageSeconds < 60 ? e.ageSeconds + 's' : Math.round(e.ageSeconds/60) + 'm'} ago</td>
        </tr>`).join('') : '<tr><td colspan="3" style="color:var(--text-faint);">Nothing active right now.</td></tr>';
    }
    async function runBackupCheck() {
      const msg = document.getElementById('backupCheckMsg');
      msg.textContent = 'Checking…';
      const { ok, data } = await C4K.api('/api/admin/backup-check');
      msg.textContent = ok ? `✅ DB reachable — ${data.userCount} users, ${data.responseMs}ms.` : '⚠️ Database did not respond normally.';
    }
    async function sendExecSummaryNow() {
      const msg = document.getElementById('execSummaryMsg');
      msg.textContent = 'Sending…';
      const { ok } = await C4K.api('/api/admin/exec-summary-now', 'POST', {});
      msg.textContent = ok ? '✅ Sent — check your email/Slack.' : '⚠️ Could not send.';
    }
    async function forceLogoutAll() {
      if (!confirm("Force EVERYONE on the platform to log back in right now — every kid, parent, teacher, and admin except you? Use this only for a real security concern.")) return;
      const msg = document.getElementById('forceLogoutMsg');
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Revoking…';
      const { ok, data } = await C4K.api('/api/admin/force-logout-all', 'POST', {});
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = `✅ Revoked ${data.revoked} session(s). Everyone else needs to log back in.`; }
      else { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || 'Could not do this.'; }
    }

    // ── Data export/deletion request tracker ──
    async function loadDataRequests() {
      const { ok, data } = await C4K.api('/api/admin/data-requests');
      const rows = document.getElementById('dataReqRows');
      if (!rows) return;
      const list = (ok && data.requests) || [];
      rows.innerHTML = list.length ? list.map(r => `<tr${r.done ? ' style="opacity:.5;"' : ''}>
          <td>${C4K.esc(r.who)}</td>
          <td>${r.kind === 'delete' ? '🗑️ Deletion' : '📤 Export'}</td>
          <td style="font-size:0.82rem;">${(r.due || '').slice(0,10)}</td>
          <td>${r.done ? '✅ Done' : '⏳ Open'}</td>
          <td>${r.done ? '' : `<button class="btn btn-outline" style="font-size:0.72rem;padding:4px 10px;" onclick="completeDataRequest('${r.id}')">Mark done</button>`}
              <button class="btn btn-outline" style="font-size:0.72rem;padding:4px 10px;color:#f87171;" onclick="removeDataRequest('${r.id}')">Remove</button></td>
        </tr>`).join('') : '<tr><td colspan="5" style="color:var(--text-faint);">No data requests logged.</td></tr>';
    }
    async function addDataRequest() {
      const who = document.getElementById('drWho').value.trim();
      const kind = document.getElementById('drKind').value;
      if (!who) return;
      await C4K.api('/api/admin/data-requests', 'POST', { action: 'add', who, kind, dueDays: 14 });
      document.getElementById('drWho').value = '';
      loadDataRequests();
    }
    async function completeDataRequest(id) { await C4K.api('/api/admin/data-requests', 'POST', { action: 'complete', id }); loadDataRequests(); }
    async function removeDataRequest(id) { await C4K.api('/api/admin/data-requests', 'POST', { action: 'remove', id }); loadDataRequests(); }

    // ── Maintenance banner + feature flags ──
    async function loadFeatureFlags() {
      if (!document.getElementById('flagVibe')) return;   // not on this page
      const { ok, data } = await C4K.api('/api/feature-flags');
      if (!ok) return;
      document.getElementById('flagVibe').checked = data.flags.vibeStudio !== false;
      document.getElementById('flagSessions').checked = data.flags.liveSessions !== false;
      document.getElementById('flagReferrals').checked = data.flags.referrals !== false;
    }
    async function saveFlags() {
      const out = document.getElementById('flagsMsgOut');
      out.textContent = 'Saving…';
      const { ok } = await C4K.api('/api/admin/feature-flags', 'POST', {
        vibeStudio: document.getElementById('flagVibe').checked,
        liveSessions: document.getElementById('flagSessions').checked,
        referrals: document.getElementById('flagReferrals').checked,
      });
      out.textContent = ok ? '✅ Saved.' : '⚠️ Could not save.';
    }

    // ── Reset the pitch-demo account ──
    async function resetDemoAccount() {
      if (!confirm('Reset the demo account? This clears extra projects, chat quota, and notices — but keeps its seeded lessons, boss wins, and tokens.')) return;
      const msg = document.getElementById('resetDemoMsg');
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Resetting…';
      const { ok, data } = await C4K.api('/api/admin/reset-demo', 'POST', {});
      if (ok) { msg.style.color = 'var(--green,#4ade80)'; msg.textContent = data.cleared && data.cleared.length ? `✅ Cleared: ${data.cleared.join(', ')}.` : '✅ Already clean — nothing to clear.'; }
      else { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || 'Could not reset.'; }
    }

    // ── Admin accounts (who else can get into this panel) ──
    async function loadAdmins() {
      const { ok, data } = await C4K.api('/api/admin/admins');
      const rows = document.getElementById('adminRows');
      if (!rows) return;
      if (!ok || !data.admins || !data.admins.length) { rows.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);">No admin accounts found.</td></tr>'; return; }
      rows.innerHTML = data.admins.map(a => `<tr>
          <td>${C4K.esc(a.name || '')}</td>
          <td>@${C4K.esc(a.username)}</td>
          <td>${a.role === 'super_admin' ? '👑 Super Admin' : '🛠️ Admin'}</td>
          <td>${a.suspended ? '⛔ Suspended' : '✅ Active'}</td>
          <td>${a.role === 'super_admin' ? '<span style="color:var(--text-faint);font-size:0.8rem;">—</span>' :
            `<button class="mini-btn" onclick="toggleAdminSuspend(${a.id}, '${C4K.esc(a.name || a.username).replace(/'/g, "\\'")}', ${!a.suspended})">${a.suspended ? 'Reinstate' : 'Suspend'}</button>`}</td>
        </tr>`).join('');
    }
    async function createAdmin() {
      const name = document.getElementById('newAdminName').value.trim();
      const username = document.getElementById('newAdminUser').value.trim();
      const password = document.getElementById('newAdminPass').value;
      const msg = document.getElementById('newAdminMsg');
      if (!username || !password) { msg.style.color = '#f87171'; msg.textContent = 'Enter a username and password.'; return; }
      if (!confirm(`Create a new admin account for @${username}? They'll have full admin-panel access (not super admin).`)) return;
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Creating…';
      const { ok, data } = await C4K.api('/api/admin/admins', 'POST', { name, username, password });
      if (ok) {
        msg.style.color = 'var(--green,#4ade80)'; msg.textContent = `✅ Created @${data.username}.`;
        document.getElementById('newAdminName').value = ''; document.getElementById('newAdminUser').value = ''; document.getElementById('newAdminPass').value = '';
        loadAdmins();
      } else { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || 'Could not create account.'; }
    }
    async function toggleAdminSuspend(userId, name, suspend) {
      const verb = suspend ? 'suspend' : 'reinstate';
      if (!confirm(`${suspend ? 'Suspend' : 'Reinstate'} ${name}'s admin account?`)) return;
      const { ok, data } = await C4K.api('/api/admin/suspend', 'POST', { userId, suspended: suspend, days: 0 });
      if (ok) loadAdmins();
      else alert(data.error || `Could not ${verb} account.`);
    }

    // ── School/district health ──
    async function loadSchoolHealth() {
      const { ok, data } = await C4K.api('/api/admin/school-health');
      const rows = document.getElementById('healthRows');
      if (!rows) return;
      const list = (ok && data.schools) || [];
      const dot = { green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪' };
      rows.innerHTML = list.length ? list.map(s => `<tr>
          <td><strong>${C4K.esc(s.name)}</strong> <span style="color:var(--text-faint);">@${C4K.esc(s.username)}</span></td>
          <td>${C4K.esc(s.plan)}</td>
          <td>${s.studentCount}</td>
          <td>${s.activeStudents} (${s.activePct}%)</td>
          <td>${dot[s.health] || ''} ${s.health}</td>
        </tr>`).join('') : '<tr><td colspan="5" style="color:var(--text-faint);">No paid school/district accounts yet.</td></tr>';
    }

    // ── Staff login activity (who's logging into teacher/admin/super_admin accounts, from where) ──
    // ── Admin action audit log (account delete/suspend/reinstate history) ──
    let _auditLog = [], _auSortKey = 'at', _auSortDir = -1;
    const auditActionTag = a => a === 'deleted' ? '🗑️ deleted' : (a === 'suspended' ? '⏸️ suspended' : (a === 'reinstated' ? '▶️ reinstated' : (a === 'impersonated' ? '🎭 impersonated' : a)));
    async function loadAuditLog() {
      const { ok, data } = await C4K.api('/api/admin/audit-log');
      if (!ok) return;
      _auditLog = data.log || [];
      renderAuditLog();
    }
    // A view reset, not a data wipe — clears the search box, action filter, and sort back to
    // default, then reloads fresh from the server. Nothing is deleted.
    async function resetAuditLog() {
      const search = document.getElementById('auditSearch'); if (search) search.value = '';
      const action = document.getElementById('auditAction'); if (action) action.value = '';
      _auSortKey = 'at'; _auSortDir = -1;
      ['at', 'username', 'action'].forEach(k => {
        const el = document.getElementById('auSortIcon-' + k);
        if (el) el.textContent = k === 'at' ? '▼' : '';
      });
      await loadAuditLog();
    }
    function sortAuditLog(key) {
      if (_auSortKey === key) _auSortDir *= -1; else { _auSortKey = key; _auSortDir = 1; }
      ['at', 'username', 'action'].forEach(k => {
        const el = document.getElementById('auSortIcon-' + k);
        if (el) el.textContent = (k === _auSortKey) ? (_auSortDir === 1 ? '▲' : '▼') : '';
      });
      renderAuditLog();
    }
    function renderAuditLog() {
      const rows = document.getElementById('auditRows');
      if (!rows) return;
      const q = (document.getElementById('auditSearch') ? document.getElementById('auditSearch').value : '').trim().toLowerCase();
      const action = document.getElementById('auditAction') ? document.getElementById('auditAction').value : '';
      let list = _auditLog.filter(r =>
        (!action || r.action === action) &&
        (!q || (r.username||'').toLowerCase().includes(q) || (r.by||'').toLowerCase().includes(q) || (r.detail||'').toLowerCase().includes(q)));
      if (_auSortKey) {
        list = list.slice().sort((a, b) => {
          const av = (a[_auSortKey] || '').toString().toLowerCase(), bv = (b[_auSortKey] || '').toString().toLowerCase();
          return av < bv ? -_auSortDir : av > bv ? _auSortDir : 0;
        });
      }
      setText('auditCount', `${list.length} of ${_auditLog.length} action${_auditLog.length===1?'':'s'}`);
      rows.innerHTML = list.length ? list.map(r => `<tr>
          <td style="white-space:nowrap;color:var(--text-faint);font-size:0.8rem;">${C4K.esc(r.at)}</td>
          <td>@${C4K.esc(r.username || '?')}</td>
          <td><strong>${auditActionTag(r.action)}</strong></td>
          <td style="font-size:0.82rem;color:var(--text-faint);">${C4K.esc(r.by || '')}</td>
          <td style="font-size:0.82rem;">${C4K.esc(r.detail || '')}</td>
        </tr>`).join('') : '<tr><td colspan="5" style="color:var(--text-faint);">No admin actions match.</td></tr>';
    }
    function exportAuditLogCsv() {
      const rows = [['When', 'Account', 'Action', 'By', 'Detail']];
      _auditLog.forEach(r => rows.push([r.at || '', r.username || '', r.action || '', r.by || '', r.detail || '']));
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-audit-log-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    }

    let _staffLogins = [], _slSortKey = 'at', _slSortDir = -1;
    async function loadStaffLogins() {
      const { ok, data } = await C4K.api('/api/admin/staff-logins');
      if (!ok) return;
      const list = data.logins || [];
      // Flag any login from an IP we haven't seen before FOR THAT PERSON, within this window —
      // the earliest entry per person is the baseline (nothing to compare it to yet).
      const seenByUser = new Map();
      const chrono = list.slice().sort((a, b) => a.at < b.at ? -1 : 1);   // oldest first, so "first seen" is really first
      for (const l of chrono) {
        const key = l.username;
        if (!seenByUser.has(key)) seenByUser.set(key, new Set());
        const ips = seenByUser.get(key);
        l.newIp = ips.size > 0 && !ips.has(l.ip);
        ips.add(l.ip);
      }
      _staffLogins = list;
      renderStaffLogins();
    }
    function sortStaffLogins(key) {
      if (_slSortKey === key) _slSortDir *= -1; else { _slSortKey = key; _slSortDir = 1; }
      ['name', 'ip', 'at'].forEach(k => {
        const el = document.getElementById('slSortIcon-' + k);
        if (el) el.textContent = (k === _slSortKey) ? (_slSortDir === 1 ? '▲' : '▼') : '';
      });
      renderStaffLogins();
    }
    // Grouped by role (Super Admin, then Admin, then Teacher) instead of one flat interleaved
    // list — a compromised admin login is a lot easier to spot sitting in its own 5-row section
    // than buried among 90 teacher logins sorted purely by time.
    const ROLE_ORDER = ['super_admin', 'admin', 'teacher'];
    const ROLE_SECTION = { super_admin: '👑 Super Admin', admin: '🛠️ Admin', teacher: '🍎 Teacher' };
    // Each role section is collapsible — click the header to expand/collapse. Starts open;
    // state persists across re-renders (search/sort/filter) until you toggle it again.
    let _slOpen = { super_admin: true, admin: true, teacher: true };
    function toggleStaffRoleGroup(role) {
      _slOpen[role] = !_slOpen[role];
      renderStaffLogins();
    }
    function renderStaffLogins() {
      const rows = document.getElementById('staffLoginRows');
      if (!rows) return;
      const q = (document.getElementById('staffLoginSearch') ? document.getElementById('staffLoginSearch').value : '').trim().toLowerCase();
      const roleFilter = document.getElementById('staffLoginRole') ? document.getElementById('staffLoginRole').value : '';
      const newOnly = document.getElementById('staffLoginNewOnly') ? document.getElementById('staffLoginNewOnly').checked : false;
      let list = _staffLogins.filter(l =>
        (!roleFilter || l.role === roleFilter) && (!newOnly || l.newIp) &&
        (!q || (l.name||'').toLowerCase().includes(q) || (l.username||'').toLowerCase().includes(q) || (l.ip||'').toLowerCase().includes(q)));
      setText('staffLoginCount', `${list.length} of ${_staffLogins.length} logins (most recent 100)`);
      let html = '';
      for (const role of ROLE_ORDER) {
        let group = list.filter(l => l.role === role);
        if (!group.length) continue;
        const open = !!_slOpen[role];
        html += `<tr style="background:var(--surface-2);cursor:pointer;" onclick="toggleStaffRoleGroup('${role}')">
          <td colspan="3" style="font-weight:900;padding-top:12px;">
            <span style="display:inline-block;transition:transform .15s;transform:rotate(${open ? '90deg' : '0deg'});margin-right:4px;">▶</span>
            ${ROLE_SECTION[role]} <span style="color:var(--text-faint);font-weight:700;font-size:0.78rem;">(${group.length})</span>
          </td></tr>`;
        if (!open) continue;
        if (_slSortKey) {
          group = group.slice().sort((a, b) => {
            const av = (a[_slSortKey] || '').toString().toLowerCase(), bv = (b[_slSortKey] || '').toString().toLowerCase();
            return av < bv ? -_slSortDir : av > bv ? _slSortDir : 0;
          });
        }
        html += group.map(l => `<tr${l.newIp ? ' style="background:rgba(245,158,11,0.08);"' : ''}>
          <td><strong>${C4K.esc(l.name || '')}</strong> <span style="color:var(--text-faint);">@${C4K.esc(l.username)}</span></td>
          <td style="font-family:monospace;font-size:0.82rem;">${C4K.esc(l.ip)}${l.newIp ? ' <span title="First time this IP has been seen for this person" style="color:#f59e0b;">⚠️ new</span>' : ''}</td>
          <td style="color:var(--text-dim);">${C4K.esc(l.at)}</td>
        </tr>`).join('');
      }
      rows.innerHTML = html || '<tr><td colspan="3" style="color:var(--text-faint);">No staff logins match.</td></tr>';
    }
    function exportStaffLoginsCsv() {
      const rows = [['Name', 'Username', 'Role', 'IP', 'When', 'New IP?']];
      _staffLogins.forEach(l => rows.push([l.name || '', l.username || '', l.role || '', l.ip || '', l.at || '', l.newIp ? 'yes' : '']));
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-staff-logins-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    }

    // ── Weekly cohort retention (signup week x weeks-since-signup activity %) ──
    async function loadCohortRetention() {
      const { ok, data } = await C4K.api('/api/admin/cohort-retention');
      const host = document.getElementById('cohortChart');
      if (!host) return;
      const cohorts = (ok && data.cohorts) || [];
      if (!cohorts.length) { host.innerHTML = '<div style="color:var(--text-faint);font-size:0.85rem;">Not enough signup history yet.</div>'; return; }
      const heat = pct => pct >= 60 ? '#15803d' : pct >= 35 ? '#a16207' : pct >= 15 ? '#7c3aed33' : 'var(--surface-2)';
      const heatTxt = pct => pct >= 35 ? '#fff' : 'var(--text-dim)';
      const maxCols = Math.max(...cohorts.map(c => c.retention.length));
      const header = ['Cohort', 'Kids', ...Array.from({length: maxCols}, (_, i) => `Wk ${i}`)];
      host.innerHTML = `<table class="admin-table"><thead><tr>${header.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>
        ${cohorts.map(c => `<tr>
          <td style="white-space:nowrap;">${C4K.esc(c.weekLabel)}</td>
          <td style="color:var(--text-dim);">${c.size}</td>
          ${Array.from({length: maxCols}, (_, i) => c.retention[i] == null ? '<td style="color:var(--text-faint);">—</td>' :
            `<td style="background:${heat(c.retention[i])};color:${heatTxt(c.retention[i])};font-weight:800;text-align:center;border-radius:6px;">${c.retention[i]}%</td>`).join('')}
        </tr>`).join('')}
      </tbody></table>`;
    }

    // ── Expiring trials & renewals ──
    async function loadExpiryQueue() {
      const { ok, data } = await C4K.api('/api/admin/expiry-queue');
      const rows = document.getElementById('expiryRows');
      if (!rows) return;
      if (!ok) { rows.innerHTML = '<tr><td colspan="4" style="color:var(--text-faint);">Could not load.</td></tr>'; return; }
      const items = [
        ...(data.trials || []).map(t => ({ name: t.name, type: 'Trial', date: t.ends, contact: t.email })),
        ...(data.renewals || []).map(r => ({ name: r.name, type: 'Renewal (' + r.plan + ')', date: r.renews, contact: r.email })),
      ].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      rows.innerHTML = items.length ? items.map(i => `<tr>
          <td>${C4K.esc(i.name)}</td><td>${C4K.esc(i.type)}</td><td>${C4K.esc(i.date)}</td><td>${C4K.esc(i.contact || '—')}</td>
        </tr>`).join('') : '<tr><td colspan="4" style="color:var(--text-faint);">Nothing expiring in the next 14 days.</td></tr>';
    }

    // ── Lesson content reports ──
    async function loadLessonReports() {
      const { ok, data } = await C4K.api('/api/admin/lesson-analytics');
      const rows = document.getElementById('lessonReportRows');
      if (!rows) return;
      const list = (ok && data.reports) || [];
      rows.innerHTML = list.length ? list.map(r => `<tr><td>${C4K.esc(r.lessonId)}</td><td>${r.count}</td></tr>`).join('')
        : '<tr><td colspan="2" style="color:var(--text-faint);">No lessons reported. 🎉</td></tr>';
    }

    // ── Error log ──
    async function loadErrorLog() {
      const { ok, data } = await C4K.api('/api/admin/error-log');
      const rows = document.getElementById('errorRows');
      if (!rows) return;
      const list = (ok && data.errors) || [];
      setText('errCount', list.length ? `(${list.length} recent)` : '');
      rows.innerHTML = list.length ? list.map(e => `<tr>
          <td style="white-space:nowrap;color:var(--text-faint);font-size:0.78rem;">${C4K.esc(e.at)}</td>
          <td style="font-size:0.8rem;">${C4K.esc(e.path)}</td>
          <td style="font-size:0.8rem;color:#f87171;">${C4K.esc(e.message)}</td>
        </tr>`).join('') : '<tr><td colspan="3" style="color:var(--text-faint);">No errors logged. 🎉</td></tr>';
    }

    // ── Full data export ──
    async function downloadFullExport() {
      const res = await fetch('/api/admin/export', { headers: { Authorization: 'Bearer ' + C4K.token() } });
      if (!res.ok) return alert('Could not export — try again.');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-export.json'; a.click();
    }

    // ── Promo codes ──
    async function loadPromoCodes() {
      const { ok, data } = await C4K.api('/api/admin/promo/list');
      const rows = document.getElementById('promoRows');
      if (!rows) return;
      const codes = (ok && data.codes) || {};
      const entries = Object.entries(codes);
      rows.innerHTML = entries.length ? entries.map(([code, p]) => `<tr>
          <td><strong>${C4K.esc(code)}</strong></td><td>${p.days}</td><td>${p.used || 0} / ${p.maxUses}</td><td style="color:var(--text-dim);">${C4K.esc(p.note || '')}</td>
        </tr>`).join('') : '<tr><td colspan="4" style="color:var(--text-faint);">No promo codes yet.</td></tr>';
    }
    async function createPromo() {
      const code = document.getElementById('promoCode').value.trim();
      const days = document.getElementById('promoDays').value;
      const maxUses = document.getElementById('promoMax').value;
      const note = document.getElementById('promoNote').value.trim();
      if (!code) return alert('Enter a code.');
      const { ok, data } = await C4K.api('/api/admin/promo/create', 'POST', { code, days, maxUses, note });
      if (ok) { document.getElementById('promoCode').value = ''; document.getElementById('promoNote').value = ''; loadPromoCodes(); }
      else alert(data.error || 'Could not create code.');
    }

    // ── Real Stripe discount codes ──
    async function loadStripeCoupons() {
      const { ok, data } = await C4K.api('/api/admin/stripe-coupon/list');
      const rows = document.getElementById('scRows');
      if (!rows) return;
      if (!ok) { rows.innerHTML = `<tr><td colspan="6" style="color:var(--text-faint);">${C4K.esc((data && data.error) || 'Stripe not connected on this environment.')}</td></tr>`; return; }
      const codes = data.codes || [];
      rows.innerHTML = codes.length ? codes.map(c => {
        const discount = c.percentOff ? c.percentOff + '% off' : (c.amountOff ? '$' + (c.amountOff / 100).toFixed(2) + ' off' : '—');
        return `<tr>
          <td><strong>${C4K.esc(c.code)}</strong></td>
          <td>${discount}</td>
          <td>${C4K.esc(c.duration || '')}</td>
          <td>${c.timesRedeemed || 0}${c.maxRedemptions ? ' / ' + c.maxRedemptions : ''}</td>
          <td>${c.active ? '✅ active' : '⏸️ inactive'}</td>
          <td>${c.active ? `<button class="mini-btn" onclick="deactivateStripeCoupon('${c.id}','${C4K.esc(c.code)}')">Deactivate</button>` : ''}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="6" style="color:var(--text-faint);">No Stripe codes yet.</td></tr>';
      window._scCodesById = {}; codes.forEach(c => window._scCodesById[c.code] = c);
    }
    async function createStripeCoupon() {
      const msg = document.getElementById('scMsg');
      const code = document.getElementById('scCode').value.trim();
      const percentOff = document.getElementById('scPercent').value;
      const amountOffCents = document.getElementById('scAmountCents').value;
      const duration = document.getElementById('scDuration').value;
      const durationMonths = document.getElementById('scDurationMonths').value;
      const maxRedemptions = document.getElementById('scMaxRedemptions').value;
      if (!code) { msg.style.color = '#f87171'; msg.textContent = 'Enter a code.'; return; }
      if (!percentOff && !amountOffCents) { msg.style.color = '#f87171'; msg.textContent = 'Set a % off or a $ off amount.'; return; }
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Creating in Stripe…';
      const { ok, data } = await C4K.api('/api/admin/stripe-coupon/create', 'POST', { code, percentOff, amountOffCents, duration, durationMonths, maxRedemptions });
      if (ok) {
        msg.style.color = 'var(--green,#4ade80)'; msg.textContent = `✅ Created ${data.code} — it's live at checkout right now.`;
        document.getElementById('scCode').value = ''; document.getElementById('scPercent').value = ''; document.getElementById('scAmountCents').value = '';
        loadStripeCoupons();
      } else { msg.style.color = '#f87171'; msg.textContent = data.error || 'Could not create.'; }
    }
    async function deactivateStripeCoupon(promoId, code) {
      if (!confirm('Deactivate ' + code + '? It will stop working at checkout immediately.')) return;
      const { ok, data } = await C4K.api('/api/admin/stripe-coupon/deactivate', 'POST', { promoId });
      if (ok) loadStripeCoupons(); else alert(data.error || 'Could not deactivate.');
    }

    async function sendBreachNotice() {
      const message = document.getElementById('breachMsg').value.trim();
      const confirmText = document.getElementById('breachConfirm').value;
      const out = document.getElementById('breachMsgOut');
      if (!confirm('This will email EVERY account holder. Are you absolutely sure?')) return;
      out.style.color = 'var(--text-dim)'; out.textContent = 'Sending…';
      const { ok, data } = await C4K.api('/api/admin/breach-notice', 'POST', { message, confirm: confirmText });
      out.style.color = ok ? 'var(--green,#4ade80)' : '#f87171';
      out.textContent = ok ? `✅ Sent to ${data.sent} account holders.` : (data.error || 'Could not send.');
    }

    // ── Create account (super admin: instant; admin: request) ──
    function caRoleChanged() {
      // Only present on admin-create.html. Every page shares this script, so a missing
      // element means "not my page", not an error.
      const roleEl = document.getElementById('caRole');
      const wrap = document.getElementById('caPlanWrap');
      if (!roleEl || !wrap) return;
      wrap.style.display = (roleEl.value === 'kid') ? '' : 'none';
    }
    async function createAccount() {
      const picked = document.getElementById('caRole').value;
      const name = document.getElementById('caName').value.trim();
      const username = document.getElementById('caUser').value.trim();
      const password = document.getElementById('caPass').value;
      const email = document.getElementById('caEmail').value.trim();
      // School & District are teacher accounts with the matching plan (they land in the
      // District/Library dashboard). Teacher = teacher plan. Kids use the plan dropdown.
      let role = picked, plan = '';
      if (picked === 'school' || picked === 'district') { role = 'teacher'; plan = picked; }
      else if (picked === 'teacher') { role = 'teacher'; plan = 'teacher'; }
      else if (picked === 'kid') { plan = document.getElementById('caPlan').value; }
      const msg = document.getElementById('caMsg');
      if (!name || !username || !password) { msg.style.color = '#f87171'; msg.textContent = 'Name, username and password are required.'; return; }
      const { ok, data } = await C4K.api('/api/admin/create-account', 'POST', { role, name, username, password, email, plan });
      if (ok) {
        const label = picked === 'district' ? 'district' : picked === 'school' ? 'school' : data.role;
        msg.style.color = 'var(--green, #5ad17e)';
        msg.textContent = data.created
          ? (data.welcomed
              ? `✅ Created ${label} account @${data.username}. 📧 A welcome email was sent so they can set their own password.`
              : `✅ Created ${label} account @${data.username}.` + (email ? ' (No welcome email — check the email address.)' : ' Give them the username & password you set.'))
          : `📨 Request sent - the super admin will approve @${data.username}.`;
        ['caName','caUser','caPass','caEmail'].forEach(id => document.getElementById(id).value = '');
        loadData();
      } else { msg.style.color = '#f87171'; msg.textContent = data.error || 'Could not create account.'; }
    }

    // ── Notices sent to THIS admin/super-admin account ──
    async function loadAdminNotices() {
      const { ok, data } = await C4K.api('/api/notices');
      const wrap = document.getElementById('adminNotices');
      if (!wrap) return;                       // not on this page
      if (!ok || !data.notices || !data.notices.length) { wrap.innerHTML = ''; return; }
      wrap.innerHTML = data.notices.map(n => `
        <div style="background:rgba(245,158,11,0.12);border:1px solid #f59e0b;border-radius:12px;padding:14px 16px;display:flex;gap:12px;align-items:flex-start;">
          <span style="font-size:1.2rem;">📨</span>
          <div style="flex:1;"><div style="font-weight:800;color:#fbbf24;">Notice from KidVibers</div>
            <div style="color:var(--text);font-size:0.9rem;line-height:1.5;">${C4K.esc(n.body)}</div>
            <div style="color:var(--text-faint);font-size:0.72rem;margin-top:4px;">${C4K.esc(n.at)}</div></div>
          <button onclick="dismissAdminNotice(${n.id}, this)" style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:1.1rem;">✕</button>
        </div>`).join('');
    }
    async function dismissAdminNotice(id, btn) {
      btn.closest('div[style]').remove();
      await C4K.api('/api/notices/dismiss', 'POST', { id });
    }

    // ── Login & sign-up toggles (super admin) ──
    function tgLabel(on) { return on ? '🟢 ON' : '🔴 OFF'; }
    async function loadToggles() {
      const { ok, data } = await C4K.api('/api/site-config');
      if (!ok) return;
      const _g_tgSignups = document.getElementById('tgSignups');
      if (_g_tgSignups) _g_tgSignups.checked = !!data.signupsEnabled;
      const _g_tgLogins = document.getElementById('tgLogins');
      if (_g_tgLogins) _g_tgLogins.checked = !!data.loginsEnabled;
      setText('tgSignupsState', tgLabel(data.signupsEnabled));
      setText('tgLoginsState', tgLabel(data.loginsEnabled));
    }
    async function saveToggles() {
      const signups = document.getElementById('tgSignups').checked;
      const logins = document.getElementById('tgLogins').checked;
      const { ok, data } = await C4K.api('/api/admin/toggles', 'POST', { signups, logins });
      const m = document.getElementById('tgMsg');
      if (ok) {
        setText('tgSignupsState', tgLabel(data.signupsEnabled));
        setText('tgLoginsState', tgLabel(data.loginsEnabled));
        m.style.color = 'var(--green,#5ad17e)'; m.textContent = '✅ Saved.';
        setTimeout(() => { if (m.textContent === '✅ Saved.') m.textContent = ''; }, 2500);
      } else { m.style.color = '#f87171'; m.textContent = data.error || 'Could not save.'; }
    }

    // ── Site announcement (super admin) ──
    async function loadSiteMessage() {
      const { ok, data } = await C4K.api('/api/site-message');
      if (!ok) return;
      const _g_siteMsgText = document.getElementById('siteMsgText');
      if (_g_siteMsgText) _g_siteMsgText.value = data.text || '';
      const _g_siteMsgActive = document.getElementById('siteMsgActive');
      if (_g_siteMsgActive) _g_siteMsgActive.checked = !!data.active;
    }
    async function saveSiteMessage() {
      const text = document.getElementById('siteMsgText').value.trim();
      const active = document.getElementById('siteMsgActive').checked;
      const { ok, data } = await C4K.api('/api/admin/site-message', 'POST', { text, active });
      const m = document.getElementById('siteMsgMsg');
      m.style.color = ok ? 'var(--green,#5ad17e)' : '#f87171';
      m.textContent = ok ? (data.active ? '✅ Saved - the banner is live on the site.' : '✅ Saved (banner is hidden).') : (data.error || 'Could not save.');
    }
    async function clearSiteMessage() {
      document.getElementById('siteMsgText').value = '';
      document.getElementById('siteMsgActive').checked = false;
      await saveSiteMessage();
    }

    // ── Account requests (super admin) ──
    async function loadAccountRequests() {
      const { ok, data } = await C4K.api('/api/admin/account-requests');
      if (!ok) return;
      const rows = data.requests || [];
      setText('acctReqCount', rows.length ? `· ${rows.length} pending` : '· none pending ✓');
      const _g_acctReqRows = document.getElementById('acctReqRows');
      if (_g_acctReqRows) _g_acctReqRows.innerHTML = rows.length ? rows.map(r => `
        <tr>
          <td>${C4K.esc(r.role)}</td>
          <td><strong>${C4K.esc(r.name)}</strong></td>
          <td>@${C4K.esc(r.username)}</td>
          <td style="color:var(--text-dim);">${C4K.esc(r.email || '-')}</td>
          <td>${C4K.esc(r.requestedBy || '?')}</td>
          <td style="color:var(--text-dim);">${C4K.esc(r.at)}</td>
          <td><div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="mini-btn" style="color:#34d399;border-color:rgba(52,211,153,.4);" onclick="resolveRequest(${r.id},'approve')">✅ Approve</button>
            <button class="mini-btn" style="color:#f87171;border-color:rgba(239,68,68,.4);" onclick="resolveRequest(${r.id},'decline')">✋ Decline</button>
          </div></td>
        </tr>`).join('')
        : '<tr><td colspan="7" style="color:var(--text-faint);">No account requests. 🎉</td></tr>';
    }
    async function resolveRequest(id, action) {
      if (!confirm(action === 'approve' ? 'Approve and create this account?' : 'Decline this request?')) return;
      const { ok, data } = await C4K.api('/api/admin/account-requests/resolve', 'POST', { id, action });
      if (ok) { alert(action === 'approve' ? `✅ Created @${data.username}.` : 'Request declined.'); loadData(); }
      else alert(data.error || 'Could not resolve.');
    }

    // ── Parental consent (super admin) ──
    // ── Consent: class/school groups ──
    let _groups = [];
    async function loadConsentGroups() {
      if (!document.getElementById('consentGroupRows')) return;   // Safety page only
      const { ok, data } = await C4K.api('/api/admin/consent-groups');
      if (!ok) return;
      _groups = data.groups || [];
      const btns = document.getElementById('consentGroupBtns');
      btns.innerHTML = _groups.length ? _groups.map((g, i) =>
        `<button class="mini-btn" onclick="showGroup(${i})" style="font-size:0.85rem;padding:8px 14px;">🏫 ${C4K.esc(g.name)} <span style="color:var(--purple);font-weight:900;">${g.classCode || ''}</span> · ${g.count}</button>`
      ).join('') : '<span style="color:var(--text-faint);font-size:0.85rem;">No classes/schools yet.</span>';
    }
    function showGroup(i) {
      const g = _groups[i];
      const wrap = document.getElementById('consentGroupStudents');
      if (!g) return;
      wrap.innerHTML = `
        <div style="font-weight:900;margin-bottom:8px;">🏫 ${C4K.esc(g.name)} — ${g.count} student${g.count===1?'':'s'} <span style="color:var(--text-faint);font-weight:700;font-size:0.8rem;">(code ${C4K.esc(g.classCode||'—')})</span></div>
        ${g.students.length ? `<table class="admin-table"><thead><tr><th>Student</th><th>Username</th><th>Age</th><th>Consent</th></tr></thead><tbody>${
          g.students.map(s => `<tr><td>${C4K.esc(s.name)}</td><td>@${C4K.esc(s.username)}</td><td>${s.ageYears ?? '—'}</td><td>${badge(s.consentStatus)}</td></tr>`).join('')
        }</tbody></table>` : '<div style="color:var(--text-faint);font-size:0.85rem;">No students in this class yet.</div>'}`;
    }

    async function loadConsent() {
      const { ok, data } = await C4K.api('/api/admin/consent');
      if (!ok) return;
      const kids = data.kids || [];
      const badge = s => s === 'granted' ? '<span class="pill pro">✅ granted</span>'
        : (s === 'pending' ? '<span class="pill trial">⏳ pending</span>' : '<span class="pill free">n/a (13+)</span>');
      // dropdown of kids needing consent (pending first)
      const sel = document.getElementById('consentKid');
      if (!sel) return;                        // Safety & Consent page only
      sel.innerHTML = kids.map(k => `<option value="${k.id}">${C4K.esc(k.name)} (@${C4K.esc(k.username)}${k.ageYears?', age '+k.ageYears:''})</option>`).join('') || '<option>No kids yet</option>';
      const consentRowsEl = document.getElementById('consentRows');
      if (consentRowsEl) consentRowsEl.innerHTML = kids.length ? kids.map(k =>
        `<tr>
           <td><strong>${C4K.esc(k.name)}</strong> <span style="color:var(--text-faint);font-size:0.78rem;">@${C4K.esc(k.username)}</span></td>
           <td>${k.ageYears || '-'}</td>
           <td>${badge(k.consentStatus)}</td>
           <td style="font-size:0.82rem;color:var(--text-dim);">${C4K.esc(k.consentMethod || '-')}${k.consentBy ? '<br><span style="color:var(--text-faint);font-size:0.75rem;">'+C4K.esc(k.consentBy)+'</span>' : ''}</td>
           <td>${k.consentStatus === 'granted'
              ? `<button class="mini-btn" style="color:#f87171;" onclick="revokeConsent(${k.id})">Revoke</button>`
              : `<button class="mini-btn" onclick="document.getElementById('consentKid').value=${k.id};document.getElementById('consentNote').focus();">Record ↑</button>`}</td>
         </tr>`).join('') : '<tr><td colspan="5" style="color:var(--text-faint);">No kid accounts yet.</td></tr>';
      _consentLog = data.log || [];
      _cSortKey = 'at'; _cSortDir = -1;   // newest first by default, matches how the backend returns it
      renderConsentLog();
    }
    // Bucket every method string we actually log into one of a few readable categories, so the
    // filter dropdown and badge colors stay meaningful even as new method strings get added.
    const CONSENT_GRANTED = new Set(['google_parent', 'signup_parent_email', 'verified_parent', 'verifiable_parent_confirm',
      'class_join', 'class_code', 'library_session_saved', 'parent_account', 'admin_recorded', 'signed_form', 'phone',
      'in_person', 'government_id', 'credit_card', 'email_plus', 'dpa_accepted']);
    const CONSENT_REVOKED = new Set(['revoked', 'suspended', 'deleted']);
    const CONSENT_ACCOUNT = new Set(['reinstated', 'admin_created', 'parent_created', 'concern_reported']);
    function consentBucket(method) {
      if (CONSENT_GRANTED.has(method)) return 'granted';
      if (CONSENT_REVOKED.has(method)) return 'revoked';
      if (CONSENT_ACCOUNT.has(method)) return 'account';
      return 'other';
    }
    function consentBadge(method) {
      const bucket = consentBucket(method);
      const style = bucket === 'granted' ? 'color:#4ade80;border-color:rgba(74,222,128,.4);'
        : bucket === 'revoked' ? 'color:#f87171;border-color:rgba(248,113,113,.4);'
        : bucket === 'account' ? 'color:#60a5fa;border-color:rgba(96,165,250,.4);'
        : 'color:var(--text-dim);border-color:var(--border);';
      return `<span class="pill" style="${style}font-size:0.72rem;">${C4K.esc(method)}</span>`;
    }
    let _consentLog = [], _cSortKey = 'at', _cSortDir = -1;
    function sortConsentLog(key) {
      if (_cSortKey === key) _cSortDir *= -1; else { _cSortKey = key; _cSortDir = 1; }
      ['at', 'child', 'method'].forEach(k => {
        const el = document.getElementById('cSortIcon-' + k);
        if (el) el.textContent = (k === _cSortKey) ? (_cSortDir === 1 ? '▲' : '▼') : '';
      });
      renderConsentLog();
    }
    function renderConsentLog() {
      const q = (document.getElementById('consentLogSearch') ? document.getElementById('consentLogSearch').value : '').trim().toLowerCase();
      const type = document.getElementById('consentLogType') ? document.getElementById('consentLogType').value : '';
      let list = _consentLog.filter(l =>
        (!type || consentBucket(l.method) === type) &&
        (!q || (l.child||'').toLowerCase().includes(q) || (l.method||'').toLowerCase().includes(q) ||
          (l.by||'').toLowerCase().includes(q) || (l.detail||'').toLowerCase().includes(q)));
      if (_cSortKey) {
        list = list.slice().sort((a, b) => {
          const av = (a[_cSortKey] || '').toString().toLowerCase(), bv = (b[_cSortKey] || '').toString().toLowerCase();
          return av < bv ? -_cSortDir : av > bv ? _cSortDir : 0;
        });
      }
      setText('consentLogCount', `${list.length} of ${_consentLog.length} event${_consentLog.length===1?'':'s'}`);
      document.getElementById('consentLog').innerHTML = list.length ? list.map(l =>
        `<tr><td style="color:var(--text-faint);font-size:0.78rem;white-space:nowrap;">${C4K.esc(l.at)}</td><td>${C4K.esc(l.child)}</td><td>${consentBadge(l.method)}</td><td style="font-size:0.8rem;">${C4K.esc(l.by || '')}</td><td style="font-size:0.8rem;color:var(--text-dim);">${C4K.esc(l.detail || '')}</td></tr>`
      ).join('') : '<tr><td colspan="5" style="color:var(--text-faint);">No consent events match.</td></tr>';
    }
    function exportConsentLogCsv() {
      const rows = [['When', 'Child', 'Method', 'By', 'Detail']];
      _consentLog.forEach(l => rows.push([l.at || '', l.child || '', l.method || '', l.by || '', l.detail || '']));
      const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'kidvibers-consent-log-' + new Date().toISOString().slice(0,10) + '.csv'; a.click();
    }

    async function recordConsent() {
      const kidId = +document.getElementById('consentKid').value;
      const method = document.getElementById('consentMethod').value;
      const note = document.getElementById('consentNote').value.trim();
      const { ok, data } = await C4K.api('/api/admin/consent', 'POST', { kidId, action: 'grant', method, note });
      const msg = document.getElementById('consentMsg');
      msg.style.color = ok ? 'var(--green)' : '#f87171';
      msg.textContent = ok ? '✅ Consent recorded.' : '⚠️ ' + (data.error || 'Failed.');
      if (ok) { document.getElementById('consentNote').value = ''; loadConsent(); }
    }

    async function revokeConsent(kidId) {
      const note = prompt("Revoke consent for this child? They'll be signed out and blocked until re-approved.\nOptional reason:");
      if (note === null) return;
      const { ok, data } = await C4K.api('/api/admin/consent', 'POST', { kidId, action: 'revoke', note });
      if (ok) loadConsent(); else alert(data.error || 'Failed.');
    }

    // ── Role preview ──
    async function previewRole(role) {
      const msg = document.getElementById('previewMsg');
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Opening ' + role + ' preview…';
      const { ok, data } = await C4K.api('/api/admin/preview', 'POST', { role });
      if (!ok) { msg.style.color = '#f87171'; msg.textContent = (data && data.error) || 'Could not start preview.'; return; }
      msg.textContent = '';
      C4K.startPreview(data.token, data.redirectUrl);
    }

    // ── Website change requests / approval (super admin) ──
    async function loadChangeRequest() {
      const { ok, data } = await C4K.api('/api/admin/site-edits/pending');
      if (!ok) return;
      const p = data.pending;
      const body = document.getElementById('changeReqBody');
      const count = document.getElementById('changeReqCount');
      if (!body || !count) return;             // Preview page only
      if (!p) {
        count.textContent = '· nothing waiting';
        body.innerHTML = '<p style="color:var(--text-faint);">No pending changes. 🎉 Everything live is approved.</p>';
        return;
      }
      count.textContent = '· 1 waiting for you';
      const s = p.summary || {};
      const parts = [];
      if (s.colors) parts.push(`${s.colors} color${s.colors > 1 ? 's' : ''}`);
      if (s.filters) parts.push(`${s.filters} filter${s.filters > 1 ? 's' : ''}`);
      if (s.texts) parts.push(`${s.texts} text edit${s.texts > 1 ? 's' : ''}`);
      if (s.blocks) parts.push(`${s.blocks} added block${s.blocks > 1 ? 's' : ''}`);
      const when = (p.submittedAt || '').slice(0, 16).replace('T', ' ');
      body.innerHTML =
        `<div style="background:var(--surface-2);border:1px solid var(--border-bright);border-radius:14px;padding:18px;">
           <div style="font-weight:800;margin-bottom:6px;">A change is waiting for your approval</div>
           <div style="color:var(--text-dim);font-size:0.9rem;margin-bottom:4px;">Changes: ${parts.length ? C4K.esc(parts.join(' · ')) : 'minor edits'}</div>
           <div style="color:var(--text-faint);font-size:0.8rem;margin-bottom:14px;">Submitted ${C4K.esc(when) || 'recently'}</div>
           <a href="${C4K.esc(p.stagingUrl || '#')}" target="_blank" rel="noopener" class="btn btn-outline" style="font-size:0.85rem;padding:8px 16px;margin-bottom:12px;display:inline-block;">👁️ Preview it on staging</a>
           <div style="display:flex;gap:10px;flex-wrap:wrap;">
             <button class="btn btn-primary" onclick="approveChange()" style="background:linear-gradient(135deg,#16a34a,#22c55e);">✅ Approve &amp; publish</button>
             <button class="btn btn-outline" onclick="denyChange()" style="color:#f87171;border-color:rgba(239,68,68,.4);">✕ Deny</button>
           </div>
           <div id="changeReqMsg" style="font-weight:700;font-size:0.85rem;margin-top:10px;min-height:1em;"></div>
         </div>`;
    }
    async function approveChange() {
      const m = document.getElementById('changeReqMsg'); m.style.color = 'var(--text-dim)'; m.textContent = 'Publishing…';
      const { ok, data } = await C4K.api('/api/admin/site-edits/approve', 'POST', {});
      if (ok) { m.style.color = 'var(--green,#5ad17e)'; m.textContent = '✅ Approved - it is now live!'; setTimeout(loadChangeRequest, 900); }
      else { m.style.color = '#f87171'; m.textContent = (data && data.error) || 'Could not approve.'; }
    }
    async function denyChange() {
      if (!confirm('Deny this change? It will be discarded and will NOT go live.')) return;
      const m = document.getElementById('changeReqMsg'); m.style.color = 'var(--text-dim)'; m.textContent = 'Denying…';
      const { ok, data } = await C4K.api('/api/admin/site-edits/deny', 'POST', {});
      if (ok) { m.style.color = 'var(--text-dim)'; m.textContent = 'Denied - the change was discarded.'; setTimeout(loadChangeRequest, 900); }
      else { m.style.color = '#f87171'; m.textContent = (data && data.error) || 'Could not deny.'; }
    }

    // ── Email events: bounces/complaints (Email Issues) + inbound mail (Inbox) ──
    async function loadEmailEvents() {
      if (!document.getElementById('emailClearAllBtn')) return;   // Communication page only
      // Inbound mail goes to your real inbox (Cloudflare forwarding), not Resend - keep that panel hidden.
      const inboxPanel = document.getElementById('inboxPanel');
      if (inboxPanel) inboxPanel.style.display = 'none';
      const { ok, data } = await C4K.api('/api/admin/email-events');
      if (!ok) return;
      const issues = (data.events || []).filter(e => e.direction === 'outbound');
      const labels = { bounced: '⛔ Bounced', complained: '🚩 Spam', delivery_delayed: '⏳ Delayed' };
      setText('emailIssuesCount', issues.length ? `· ${issues.length}` : '· all clear ✓');
      document.getElementById('emailClearAllBtn').style.display = issues.length ? '' : 'none';
      document.getElementById('emailIssuesRows').innerHTML = issues.length ? issues.map(e => {
        // Build the "which kid" detail block from matched accounts.
        let kidBlock = '';
        if (e.kids && e.kids.length) {
          kidBlock = '<tr><td colspan="6" style="background:var(--bg);padding:12px 14px;">' +
            '<div style="font-weight:800;font-size:0.82rem;margin-bottom:8px;">👦 This email was for ' + e.kids.length + ' account' + (e.kids.length>1?'s':'') + ':</div>' +
            e.kids.map(k =>
              '<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:0.85rem;line-height:1.7;">' +
                '<strong>' + C4K.esc(k.name) + '</strong> &nbsp; <span style="color:var(--text-faint);">(#' + k.id + ')</span><br>' +
                'Username: <code style="color:var(--purple);">@' + C4K.esc(k.username) + '</code><br>' +
                'Age: ' + (k.ageYears != null ? k.ageYears : '?') + ' &nbsp;·&nbsp; Joined: ' + C4K.esc(k.joined) + '<br>' +
                'Parent email: <span style="color:var(--text-dim);">' + C4K.esc(k.parentEmail || '(none)') + '</span><br>' +
                'Consent: ' + (k.consentStatus === 'granted' ? '<span style="color:var(--green,#5ad17e);">✅ granted</span>' : k.consentStatus === 'pending' ? '<span style="color:#f59e0b;">⏳ PENDING (stuck - parent never got the email)</span>' : C4K.esc(k.consentStatus)) +
                ' &nbsp; <button class="mini-btn" onclick="resetKidPw(' + k.id + ",'" + C4K.esc(k.username).replace(/'/g,"") + "')\">🔑 Reset password</button>" +
              '</div>'
            ).join('') + '</td></tr>';
        }
        return `<tr>
          <td>${labels[e.kind] || C4K.esc(e.kind)}</td>
          <td><a href="mailto:${C4K.esc(e.email)}" style="color:var(--purple);">${C4K.esc(e.email)}</a></td>
          <td style="color:var(--text-dim);">${C4K.esc(e.subject)}</td>
          <td style="color:var(--text-dim);max-width:240px;"><div style="white-space:pre-wrap;word-break:break-word;">${C4K.esc(e.body)}</div></td>
          <td style="color:var(--text-faint);">${C4K.esc(e.at)}</td>
          <td><button class="mini-btn" style="color:#f87171;border-color:rgba(239,68,68,.4);" onclick="deleteEmailIssue(${e.id})">🗑️</button></td>
        </tr>${kidBlock}`;
      }).join('')
        : '<tr><td colspan="6" style="color:var(--text-faint);">No bounced or flagged emails. 🎉</td></tr>';
    }
    async function resetKidPw(id, username) {
      const np = prompt('New password for @' + username + ' (min 6 chars):');
      if (!np) return;
      if (np.length < 6) { alert('Password must be at least 6 characters.'); return; }
      const { ok, data } = await C4K.api('/api/admin/reset-password', 'POST', { userId: id, password: np });
      alert(ok ? '✅ Password reset for @' + username + ' to: ' + np : (data && data.error) || 'Could not reset.');
    }
    async function deleteEmailIssue(id) {
      const { ok } = await C4K.api('/api/admin/email-events/delete', 'POST', { id });
      if (ok) loadEmailEvents();
    }
    async function clearAllEmailIssues() {
      if (!confirm('Delete all bounced/flagged emails from this list?')) return;
      const { ok } = await C4K.api('/api/admin/email-events/delete', 'POST', { all: true });
      if (ok) loadEmailEvents();
    }

    // ── Pro interest / waitlist (super admin) ──
    // ── Founder analytics (super admin) ──
    async function loadAnalytics() {
      // Dashboard only — bail before the API call so pages without the panel don't fetch.
      if (!document.getElementById('anChart')) return;
      const { ok, status, data } = await C4K.api('/api/admin/analytics');
      if (!ok) { showDataError('The Analytics panel failed to load (' + ((data && data.error) || ('server returned ' + (status || 'no response'))) + ').'); return; }
      setText('anNew', data.newThisWeek);
      setText('anActive', data.active7);
      setText('anConv', data.conversionPct + '%');
      setText('anParents', data.totalParents);
      setText('anCerts', data.certsEarned);
      setText('anGames', data.gamesPlayed);
      // advanced tiles
      setText('anMrr', '$' + (data.mrr || 0));
      setText('anRet', (data.retention30 || 0) + '%');
      setText('anStick', (data.stickiness || 0) + '%');
      setText('anRef', data.referrals || 0);
      setText('anAvg', data.avgLessons || 0);
      setText('anEmails', data.emailsCollected || 0);
      const days = data.signupsByDay || [];
      const max = Math.max(1, ...days.map(d => d.count));
      document.getElementById('anChart').innerHTML = days.map(d => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:3px;" title="${d.day}: ${d.count} signups">
          <div style="font-size:0.6rem;font-weight:800;color:var(--text-dim);">${d.count || ''}</div>
          <div style="width:100%;max-width:18px;height:${Math.round(d.count / max * 56)}px;min-height:${d.count?3:0}px;background:linear-gradient(180deg,#7c3aed,#db2777);border-radius:3px 3px 0 0;"></div>
          <div style="font-size:0.55rem;color:var(--text-faint);">${d.day.split('-')[1]}</div>
        </div>`).join('');
      // weekly chart
      const weeks = data.weeklySignups || [];
      const wmax = Math.max(1, ...weeks.map(w => w.count));
      document.getElementById('anWeekChart').innerHTML = weeks.map(w => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:3px;" title="${w.label}: ${w.count}">
          <div style="font-size:0.6rem;font-weight:800;color:var(--text-dim);">${w.count || ''}</div>
          <div style="width:100%;max-width:28px;height:${Math.round(w.count / wmax * 56)}px;min-height:${w.count?3:0}px;background:linear-gradient(180deg,#22d3ee,#0891b2);border-radius:3px 3px 0 0;"></div>
          <div style="font-size:0.55rem;color:var(--text-faint);">${w.label}</div>
        </div>`).join('');
      // top lessons
      const top = data.topLessons || [];
      const tmax = Math.max(1, ...top.map(t => t.count));
      document.getElementById('anTopLessons').innerHTML = top.length ? top.map(t => `
        <div style="display:flex;align-items:center;gap:10px;font-size:0.82rem;">
          <div style="flex:1;font-weight:700;">${C4K.esc(t.title)}</div>
          <div style="width:120px;height:8px;background:var(--surface);border-radius:50px;overflow:hidden;"><div style="height:100%;width:${Math.round(t.count/tmax*100)}%;background:linear-gradient(90deg,#7c3aed,#db2777);"></div></div>
          <div style="width:36px;text-align:right;font-weight:800;color:var(--text-dim);">${t.count}</div>
        </div>`).join('') : '<div style="color:var(--text-faint);font-size:0.85rem;">No lesson completions yet.</div>';
      // plan breakdown (previously computed by the backend but never shown)
      const pb = data.planBreakdown || {};
      const planEntries = Object.entries(pb).sort((a, b) => b[1] - a[1]);
      const pmax = Math.max(1, ...planEntries.map(([, n]) => n));
      const PLAN_COLOR = { free: '#64748b', trial: '#f59e0b', pro: '#7c3aed', family: '#db2777' };
      document.getElementById('anPlanChart').innerHTML = planEntries.length ? planEntries.map(([plan, n]) => `
        <div style="display:flex;align-items:center;gap:10px;font-size:0.82rem;">
          <div style="width:70px;font-weight:700;text-transform:capitalize;">${C4K.esc(plan)}</div>
          <div style="width:150px;height:8px;background:var(--surface);border-radius:50px;overflow:hidden;"><div style="height:100%;width:${Math.round(n/pmax*100)}%;background:${PLAN_COLOR[plan]||'#7c3aed'};"></div></div>
          <div style="width:36px;text-align:right;font-weight:800;color:var(--text-dim);">${n}</div>
        </div>`).join('') : '<div style="color:var(--text-faint);font-size:0.85rem;">No kids yet.</div>';
    }

    // ── Kid search (super admin) ──
    let _searchTimer = null;
    function searchKids() {
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(doSearchKids, 300);
    }
    async function doSearchKids() {
      const q = document.getElementById('kidSearch').value.trim();
      const wrap = document.getElementById('searchResults');
      if (!q) { wrap.innerHTML = ''; return; }
      const { ok, data } = await C4K.api('/api/admin/find-kid?q=' + encodeURIComponent(q));
      if (!ok) return;
      const kids = data.kids || [];
      if (!kids.length) { wrap.innerHTML = '<div style="color:var(--text-faint);font-size:0.85rem;">No matches.</div>'; return; }
      wrap.innerHTML = kids.map(k => `
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
            <strong style="font-size:1rem;">${C4K.esc(k.name)}</strong>
            <span style="color:var(--purple);font-weight:800;">@${C4K.esc(k.username)}</span>
            <span style="font-size:0.7rem;font-weight:900;padding:2px 8px;border-radius:50px;background:var(--surface);color:var(--text-dim);">${C4K.esc(k.role)}</span>
            ${k.suspended ? '<span style="font-size:0.7rem;font-weight:900;color:#f87171;">⏸️ suspended</span>' : ''}
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;font-size:0.8rem;color:var(--text-dim);">
            <div>📧 Parent: ${C4K.esc(k.parentEmail || '—')}</div>
            <div>📧 Kid: ${C4K.esc(k.kidEmail || '—')}</div>
            <div>🎂 Age: ${k.ageYears ?? '—'}</div>
            <div>💳 Plan: ${C4K.esc(k.plan)}</div>
            <div>✅ Consent: ${C4K.esc(k.consentStatus || '—')}</div>
            <div>🪙 Tokens: ${k.tokens ?? 0}</div>
            <div>📚 Lessons: ${k.lessonsDone}</div>
            <div>🏆 Worlds: ${k.worldsCleared}</div>
            <div>📅 Joined: ${C4K.esc(k.joined || '—')}</div>
            <div>⏱️ Last active: ${C4K.esc(k.lastActive || 'never')}</div>
            ${k.school ? `<div>🏫 ${C4K.esc(k.school)}</div>` : ''}
          </div>
        </div>`).join('');
    }

    // ── Mass email (super admin) ──
    let _emails = null;
    async function loadEmails() {
      const { ok, data } = await C4K.api('/api/admin/emails');
      if (!ok) return;
      _emails = data;
      setText('emCountParents', data.parentCount);
      setText('emCountKids', data.kidCount);
    }
    function toggleEmailList() {
      const w = document.getElementById('emListWrap');
      if (w.style.display === 'none') {
        w.style.display = '';
        const p = (_emails && _emails.parents) || [], k = (_emails && _emails.kids) || [];
        w.innerHTML =
          `<div style="font-weight:900;margin-bottom:6px;">👨‍👩‍👧 Parents (${p.length})</div>` +
          (p.map(e => `<div style="color:var(--text-dim);">${C4K.esc(e.email)} <span style="color:var(--text-faint);">— ${C4K.esc(e.name)}</span></div>`).join('') || '<div style="color:var(--text-faint);">none</div>') +
          `<div style="font-weight:900;margin:10px 0 6px;">🧒 Kids (${k.length})</div>` +
          (k.map(e => `<div style="color:var(--text-dim);">${C4K.esc(e.email)} <span style="color:var(--text-faint);">— ${C4K.esc(e.name)}</span></div>`).join('') || '<div style="color:var(--text-faint);">none</div>');
      } else { w.style.display = 'none'; }
    }
    async function sendMassEmail() {
      const msg = document.getElementById('emMsg');
      const audience = document.getElementById('emAudience').value;
      const subject = document.getElementById('emSubject').value.trim();
      const body = document.getElementById('emBody').value.trim();
      if (!subject || !body) { msg.style.color = '#f87171'; msg.textContent = 'Add a subject and message.'; return; }
      const label = audience === 'parents' ? 'all parents' : audience === 'kids' ? 'all kids' : 'EVERYONE';
      if (!confirm(`Send this email to ${label}? This sends real emails from support@kidvibers.com.`)) return;
      const btn = document.getElementById('emSendBtn'); btn.disabled = true;
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Sending… (this can take a moment)';
      const { ok, data } = await C4K.api('/api/admin/mass-email', 'POST', { audience, subject, body });
      btn.disabled = false;
      if (ok) { msg.style.color = 'var(--green,#5ad17e)'; msg.textContent = `✅ Sent to ${data.sent} of ${data.total}${data.failed ? ` (${data.failed} failed)` : ''}.`; document.getElementById('emSubject').value=''; document.getElementById('emBody').value=''; }
      else { msg.style.color = '#f87171'; msg.textContent = '⚠️ ' + (data.error || 'Could not send.'); }
    }

    // ── Notification Center (super admin): mass + personal notifications ──
    function ntAudienceChanged() {
      const a = document.getElementById('ntAudience').value;
      document.getElementById('ntRoleWrap').style.display = (a === 'role') ? '' : 'none';
      document.getElementById('ntUserWrap').style.display = (a === 'user') ? '' : 'none';
    }
    async function sendNotification() {
      const msg = document.getElementById('ntMsg');
      const audience = document.getElementById('ntAudience').value;
      const title = document.getElementById('ntTitle').value.trim();
      const body = document.getElementById('ntBody').value.trim();
      const email = document.getElementById('ntEmail').checked;
      const sendAtLocal = document.getElementById('ntSendAt').value;   // datetime-local, empty = now
      if (!body) { msg.style.color = '#f87171'; msg.textContent = 'Write a message first.'; return; }
      const payload = { audience, title, message: body, email };
      let label;
      if (audience === 'user') {
        const uid = parseInt(document.getElementById('ntUserId').value, 10);
        if (!uid) { msg.style.color = '#f87171'; msg.textContent = 'Enter the person’s user ID.'; return; }
        payload.userId = uid; label = `user #${uid}`;
      } else if (audience === 'role') {
        payload.role = document.getElementById('ntRole').value;
        label = 'all ' + payload.role + 's';
      } else if (audience === 'optedin') {
        label = 'everyone who accepted notifications';
      } else {
        label = 'EVERYONE';
      }
      const scheduling = !!sendAtLocal;
      if (scheduling) {
        const when = new Date(sendAtLocal);
        if (isNaN(when.getTime()) || when <= new Date()) {
          msg.style.color = '#f87171'; msg.textContent = 'Pick a time in the future.'; return;
        }
        payload.sendAt = when.toISOString();
      }
      const confirmMsg = scheduling
        ? `Schedule this for ${new Date(payload.sendAt).toLocaleString()}, to ${label}?`
        : `Send this notification to ${label} right now?`;
      if (!confirm(confirmMsg + (email ? ' It will also send real emails.' : ''))) return;
      const btn = document.getElementById('ntSendBtn'); btn.disabled = true;
      msg.style.color = 'var(--text-dim)'; msg.textContent = scheduling ? 'Scheduling…' : 'Sending…';
      const { ok, data } = await C4K.api(scheduling ? '/api/admin/notify/schedule' : '/api/admin/notify', 'POST', payload);
      btn.disabled = false;
      if (ok) {
        if (scheduling) {
          msg.style.color = 'var(--green,#5ad17e)';
          msg.textContent = `✅ Scheduled for ${new Date(payload.sendAt).toLocaleString()}.`;
          document.getElementById('ntSendAt').value = '';
          loadScheduled();
        } else {
          msg.style.color = 'var(--green,#5ad17e)';
          msg.textContent = `✅ Sent to ${data.recipients} ${data.recipients === 1 ? 'person' : 'people'}`
            + (data.emailed ? `, ${data.emailed} emailed` : '')
            + (data.pushed ? `, ${data.pushed} pushed` : '') + '.';
          loadNotifyHistory();
        }
        document.getElementById('ntTitle').value = '';
        document.getElementById('ntBody').value = '';
      } else {
        msg.style.color = '#f87171'; msg.textContent = '⚠️ ' + (data.error || 'Could not send.');
      }
    }
    async function loadScheduled() {
      const wrap = document.getElementById('ntScheduled');
      if (!wrap) return;
      const { ok, data } = await C4K.api('/api/admin/notify/scheduled');
      const pending = (ok && data.scheduled) ? data.scheduled.filter(s => s.status === 'pending') : [];
      if (!pending.length) { wrap.innerHTML = '<div style="color:var(--text-faint);font-size:0.82rem;">Nothing scheduled.</div>'; return; }
      const audienceLabel = s => s.audience === 'user' ? `🙋 ${s.audienceDetail}`
        : s.audience === 'role' ? `👥 ${s.audienceDetail}`
        : s.audience === 'optedin' ? '🔔 opted-in' : '🌍 everyone';
      wrap.innerHTML = pending.map(s => `
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;">
          <div style="flex:1;min-width:180px;">
            <div style="font-size:0.78rem;color:var(--text-faint);font-weight:800;">${audienceLabel(s)} · ${new Date(s.sendAt).toLocaleString()}</div>
            ${s.title ? `<div style="font-weight:900;margin-top:4px;">${C4K.esc(s.title)}</div>` : ''}
            <div style="color:var(--text-dim);font-size:0.85rem;margin-top:2px;white-space:pre-wrap;">${C4K.esc(s.body)}</div>
          </div>
          <button class="btn btn-outline" style="font-size:0.78rem;padding:6px 12px;color:#f87171;border-color:rgba(239,68,68,.4);" onclick="cancelScheduled(${s.id})">✕ Cancel</button>
        </div>`).join('');
    }
    async function cancelScheduled(id) {
      if (!confirm('Cancel this scheduled notification?')) return;
      await C4K.api('/api/admin/notify/schedule/cancel', 'POST', { id });
      loadScheduled();
    }
    async function loadNotifyHistory() {
      const wrap = document.getElementById('ntHistory');
      if (!wrap) return;
      const { ok, data } = await C4K.api('/api/admin/notify-history');
      if (!ok || !data.history || !data.history.length) { wrap.innerHTML = '<div style="color:var(--text-faint);font-size:0.82rem;">Nothing sent yet.</div>'; return; }
      const audienceLabel = h => h.audience === 'user' ? `🙋 ${h.audienceDetail || 'one person'}`
        : h.audience === 'role' ? `👥 ${h.audienceDetail || h.audience}`
        : h.audience === 'optedin' ? '🔔 opted-in'
        : '🌍 everyone';
      wrap.innerHTML = data.history.map(h => `
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:0.78rem;color:var(--text-faint);font-weight:800;">
            <span>${audienceLabel(h)} · ${h.recipients} recipient${h.recipients === 1 ? '' : 's'}${h.emailed ? ` · ${h.emailed} emailed` : ''}${h.pushed ? ` · ${h.pushed} pushed` : ''}</span>
            <span>${C4K.esc(h.sentBy)} · ${h.at}</span>
          </div>
          ${h.title ? `<div style="font-weight:900;margin-top:4px;">${C4K.esc(h.title)}</div>` : ''}
          <div style="color:var(--text-dim);font-size:0.85rem;margin-top:2px;white-space:pre-wrap;">${C4K.esc(h.body)}</div>
        </div>`).join('');
    }

    // ── Notification Automations (super admin) ──
    async function saveAutomation() {
      const msg = document.getElementById('amMsg');
      const name = document.getElementById('amName').value.trim();
      const body = document.getElementById('amBody').value.trim();
      if (!name || !body) { msg.style.color = '#f87171'; msg.textContent = 'Give it a name and a message.'; return; }
      const payload = {
        name, message: body,
        triggerType: document.getElementById('amTrigger').value,
        triggerDays: parseInt(document.getElementById('amDays').value, 10) || 7,
        audienceRole: document.getElementById('amRole').value,
        cooldownDays: parseInt(document.getElementById('amCooldown').value, 10) || 30,
        title: document.getElementById('amTitle').value.trim(),
        email: document.getElementById('amEmail').checked,
      };
      const btn = document.getElementById('amSaveBtn'); btn.disabled = true;
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Saving…';
      const { ok, data } = await C4K.api('/api/admin/automations/save', 'POST', payload);
      btn.disabled = false;
      if (ok) {
        msg.style.color = 'var(--green,#5ad17e)'; msg.textContent = '✅ Automation added.';
        document.getElementById('amName').value = '';
        document.getElementById('amTitle').value = '';
        document.getElementById('amBody').value = '';
        loadAutomations();
      } else {
        msg.style.color = '#f87171'; msg.textContent = '⚠️ ' + (data.error || 'Could not save.');
      }
    }
    async function loadAutomations() {
      const wrap = document.getElementById('amList');
      if (!wrap) return;
      const { ok, data } = await C4K.api('/api/admin/automations');
      if (!ok || !data.automations || !data.automations.length) { wrap.innerHTML = '<div style="color:var(--text-faint);font-size:0.82rem;">No automations set up yet.</div>'; return; }
      const triggerLabel = a => a.triggerType === 'trial_ending'
        ? `⏰ Trial ends within ${a.triggerDays} day${a.triggerDays === 1 ? '' : 's'}`
        : `😴 ${a.audienceRole} inactive ${a.triggerDays}+ day${a.triggerDays === 1 ? '' : 's'}`;
      wrap.innerHTML = data.automations.map(a => `
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;">
          <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start;">
            <div style="flex:1;min-width:180px;">
              <div style="font-weight:900;">${C4K.esc(a.name)} ${a.enabled ? '' : '<span style="color:var(--text-faint);font-weight:700;font-size:0.78rem;">(paused)</span>'}</div>
              <div style="font-size:0.78rem;color:var(--text-faint);font-weight:800;margin-top:2px;">${triggerLabel(a)} · repeats after ${a.cooldownDays}d cooldown${a.email ? ' · emails too' : ''}</div>
              ${a.title ? `<div style="font-weight:800;margin-top:6px;">${C4K.esc(a.title)}</div>` : ''}
              <div style="color:var(--text-dim);font-size:0.85rem;margin-top:2px;white-space:pre-wrap;">${C4K.esc(a.body)}</div>
              <div style="font-size:0.75rem;color:var(--text-faint);margin-top:4px;">${a.lastRunAt ? 'Last checked ' + a.lastRunAt.slice(0,16).replace('T',' ') : 'Not run yet'}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn btn-outline" style="font-size:0.78rem;padding:6px 12px;" onclick="toggleAutomation(${a.id}, ${!a.enabled}, this)">${a.enabled ? '⏸ Pause' : '▶️ Resume'}</button>
              <button class="btn btn-outline" style="font-size:0.78rem;padding:6px 12px;color:#f87171;border-color:rgba(239,68,68,.4);" onclick="deleteAutomation(${a.id})">🗑️ Delete</button>
            </div>
          </div>
        </div>`).join('');
    }
    async function toggleAutomation(id, enabled, btn) {
      if (btn) btn.disabled = true;
      await C4K.api('/api/admin/automations/toggle', 'POST', { id, enabled });
      loadAutomations();
    }
    async function deleteAutomation(id) {
      if (!confirm('Delete this automation? This cannot be undone.')) return;
      await C4K.api('/api/admin/automations/delete', 'POST', { id });
      loadAutomations();
    }

    // ── Signup quiz editor (super admin) ──
    let _quiz = [];
    async function loadQuiz() {
      const { ok, data } = await C4K.api('/api/admin/quiz');
      if (!ok) return;
      _quiz = data.quiz || [];
      renderQuizEditor();
    }
    function renderQuizEditor() {
      if (!document.getElementById('quizEditor')) return;   // Communication page only
      document.getElementById('quizEditor').innerHTML = _quiz.map((q, qi) => `
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:14px;">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
            <span style="font-weight:900;font-size:0.78rem;color:var(--text-faint);min-width:24px;">Q${qi+1}</span>
            <input class="le-in" style="flex:1;" value="${C4K.esc(q.q)}" oninput="_quiz[${qi}].q=this.value" placeholder="Question text" />
            <button class="mini-btn" style="color:#f87171;border-color:rgba(239,68,68,.4);" onclick="delQuizQuestion(${qi})">🗑️</button>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;padding-left:32px;">
            ${q.opts.map((o, oi) => `
              <div style="display:flex;gap:6px;align-items:center;">
                <span style="color:var(--text-faint);font-size:0.8rem;">${oi+1}.</span>
                <input class="le-in" style="flex:1;font-size:0.88rem;" value="${C4K.esc(o)}" oninput="_quiz[${qi}].opts[${oi}]=this.value" placeholder="Answer choice" />
                <button class="mini-btn" onclick="delQuizOpt(${qi},${oi})" ${q.opts.length<=2?'disabled style="opacity:.4;"':''}>✕</button>
              </div>`).join('')}
            <button class="mini-btn" style="align-self:flex-start;margin-top:2px;" onclick="addQuizOpt(${qi})">➕ Add choice</button>
          </div>
        </div>`).join('');
    }
    function addQuizQuestion() { _quiz.push({ q: 'New question?', opts: ['Choice 1', 'Choice 2'] }); renderQuizEditor(); }
    function delQuizQuestion(qi) { _quiz.splice(qi, 1); renderQuizEditor(); }
    function addQuizOpt(qi) { _quiz[qi].opts.push('New choice'); renderQuizEditor(); }
    function delQuizOpt(qi, oi) { if (_quiz[qi].opts.length > 2) { _quiz[qi].opts.splice(oi, 1); renderQuizEditor(); } }
    async function saveQuiz() {
      const msg = document.getElementById('quizMsg');
      msg.style.color = 'var(--text-dim)'; msg.textContent = 'Saving…';
      const { ok, data } = await C4K.api('/api/admin/quiz', 'POST', { quiz: _quiz });
      if (ok) { msg.style.color = 'var(--green,#5ad17e)'; msg.textContent = '✅ Quiz saved! New signups will see it.'; _quiz = data.quiz; renderQuizEditor(); }
      else { msg.style.color = '#f87171'; msg.textContent = '⚠️ ' + (data.error || 'Could not save.'); }
    }
    async function resetQuiz() {
      if (!confirm('Reset the signup quiz back to the default questions?')) return;
      const { ok, data } = await C4K.api('/api/admin/quiz', 'POST', { reset: true });
      if (ok) { _quiz = data.quiz; renderQuizEditor(); document.getElementById('quizMsg').style.color = 'var(--green,#5ad17e)'; document.getElementById('quizMsg').textContent = '✅ Reset to default.'; }
    }

    async function loadInterest() {
      const { ok, data } = await C4K.api('/api/admin/interest');
      if (!ok) return;
      const rows = data.interest || [];
      setText('interestCount', rows.length ? `· ${rows.length} interested` : '· none yet');
      const _g_interestRows = document.getElementById('interestRows');
      if (_g_interestRows) _g_interestRows.innerHTML = rows.length ? rows.map((r, i) =>
        `<tr>
          <td style="color:var(--text-faint);">${i + 1}</td>
          <td><a href="mailto:${C4K.esc(r.email)}" style="color:var(--purple);font-weight:700;">${C4K.esc(r.email)}</a></td>
          <td><span class="pill pro">${C4K.esc(r.plan || 'pro')}</span></td>
          <td style="color:var(--text-dim);">${C4K.esc(r.at || '')}</td>
        </tr>`).join('')
        : '<tr><td colspan="4" style="color:var(--text-faint);">No one on the waitlist yet.</td></tr>';
    }

    function renderLessons(lessons, sup) {
      const _lr = document.getElementById('lessonRows');
      if (!_lr) return;   // Lesson Manager panel removed from the admin UI
      _lr.innerHTML = lessons.map((l, i) =>
        `<tr>
           <td>${i + 1}</td>
           <td><strong>${l.emoji || ''} ${l.title}</strong></td>
           <td>U${l.unit || 1}</td>
           <td>${l.level || ''}</td>
           <td>⚡ ${l.xp}</td>
           <td><span class="pill ${l.published ? 'active' : 'free'}">${l.published ? 'published' : 'hidden'}</span></td>
           <td class="super-only-col" style="${sup ? '' : 'display:none;'}">${sup ? `
             <button class="mini-btn" onclick='openLessonEditor(${JSON.stringify(l)})'>Edit</button>
             <button class="mini-btn" onclick="deleteLesson('${l.id}')" style="color:#f87171;">Delete</button>` : ''}</td>
         </tr>`).join('');
    }

    function renderPlans(ps, passPercent) {
      if (!document.getElementById('planRows')) return;   // Settings page only
      const order = ['free', 'trial', 'pro', 'family'];
      document.getElementById('planRows').innerHTML = order.map(p => {
        const cfg = ps[p] || { ai: false, chatsPerDay: 0, lessonsPerDay: -1 };
        // The backend stores the daily lesson limit as lessonsPerDay (older data used lessonLimit).
        const lpd = cfg.lessonsPerDay != null ? cfg.lessonsPerDay : (cfg.lessonLimit != null ? cfg.lessonLimit : -1);
        return `<tr>
          <td><strong style="text-transform:capitalize;">${p}</strong></td>
          <td><input type="checkbox" class="plan-ai-toggle" data-plan="${p}" ${cfg.ai ? 'checked' : ''}></td>
          <td><input type="number" class="chat-limit-in chat-d" data-plan="${p}" value="${cfg.chatsPerDay}"></td>
          <td><input type="number" class="chat-limit-in lesson-d" data-plan="${p}" value="${lpd}"></td>
        </tr>`;
      }).join('');
      if (passPercent != null) document.getElementById('passPercentIn').value = passPercent;
    }

    async function savePlans() {
      const planSettings = {};
      ['free', 'trial', 'pro', 'family'].forEach(p => {
        const ai = document.querySelector(`.plan-ai-toggle[data-plan="${p}"]`).checked;
        const chatsPerDay = parseInt(document.querySelector(`.chat-d[data-plan="${p}"]`).value, 10) || 0;
        const lessonsPerDay = parseInt(document.querySelector(`.lesson-d[data-plan="${p}"]`).value, 10);
        planSettings[p] = { ai, chatsPerDay, lessonsPerDay: isNaN(lessonsPerDay) ? -1 : lessonsPerDay };
      });
      const passPercent = parseInt(document.getElementById('passPercentIn').value, 10) || 70;
      const { ok } = await C4K.api('/api/admin/settings', 'POST', { planSettings, passPercent });
      setText('planSaved', ok ? '✓ Saved!' : '✗ Error');
      setTimeout(() => document.getElementById('planSaved').textContent = '', 2500);
    }

    async function setPlan(userId, plan) {
      await C4K.api('/api/admin/set-plan', 'POST', { userId, plan });
      await loadData();
    }

    // Super admin → log in as a kid / parent / admin (with a way back)
    async function impersonate(userId, role) {
      const { ok, data } = await C4K.api('/api/admin/impersonate', 'POST', { userId });
      if (!ok) { alert(data.error || 'Could not log in as that user.'); return; }
      C4K.startImpersonation(data.token);   // backs up the super-admin session
      const dest = (role === 'parent' || role === 'teacher') ? 'parent.html' : (role === 'admin' ? 'admin.html' : 'dashboard.html');
      window.location.href = dest;
    }

    async function sendNotice(userId, name) {
      const message = prompt(`Send a notice to ${name}. They'll see it on their dashboard.\n\nYour message:`);
      if (!message) return;
      const { ok, data } = await C4K.api('/api/admin/notice', 'POST', { userId, message });
      alert(ok ? `✅ Notice sent to ${name}.` : (data.error || 'Could not send.'));
    }

    async function deleteUser(userId, name) {
      const reason = prompt(`Delete ${name}'s account and ALL their data? This cannot be undone.\n\nReason (kept on record / sent to the parent's email):`);
      if (reason === null) return;   // cancelled
      if (!confirm(`Permanently delete ${name}? This erases their progress and data.`)) return;
      const { ok, data } = await C4K.api('/api/admin/delete-user', 'POST', { userId, reason });
      if (ok) { alert(`🗑️ ${name} deleted.`); loadData(); } else alert(data.error || 'Could not delete.');
    }

    // ── Set username / password (any account) ──
    function setCreds(userId, name, username) {
      document.getElementById('credsId').value = userId;
      setText('credsWho', name + ' (@' + username + ')');
      document.getElementById('credsUser').value = '';
      document.getElementById('credsPass').value = '';
      document.getElementById('credsMyPass').value = '';
      setText('credsErr', '');
      document.getElementById('credsModal').classList.remove('hidden');
    }
    function closeCreds() { document.getElementById('credsModal').classList.add('hidden'); }
    async function confirmCreds() {
      const userId = +document.getElementById('credsId').value;
      const username = document.getElementById('credsUser').value.trim();
      const password = document.getElementById('credsPass').value;
      const myPassword = document.getElementById('credsMyPass').value;
      const err = document.getElementById('credsErr');
      if (!username && !password) { err.textContent = 'Enter a new username and/or password.'; return; }
      if (!myPassword) { err.textContent = 'Confirm your own password to continue.'; return; }
      const { ok, data } = await C4K.api('/api/admin/set-credentials', 'POST', { userId, username, password, myPassword });
      if (ok) {
        closeCreds();
        alert('✅ Login updated' + (data.changed && data.changed.length ? ' (' + data.changed.join(' + ') + ')' : '') + '.');
        loadData();
      } else err.textContent = data.error || 'Could not update.';
    }
    document.getElementById('credsModal')?.addEventListener('click', e => { if (e.target.id === 'credsModal') closeCreds(); });

    async function suspendUser(userId, name, suspend) {
      if (suspend) {  // open the modal so the super admin picks a duration
        document.getElementById('suspId').value = userId;
        setText('suspWho', name);
        document.getElementById('suspReason').value = '';
        document.getElementById('suspDays').value = '7';
        document.getElementById('suspendModal').classList.remove('hidden');
        return;
      }
      if (!confirm(`Reinstate ${name}'s account so they can log in again?`)) return;
      const { ok, data } = await C4K.api('/api/admin/suspend', 'POST', { userId, suspended: false });
      if (ok) { alert(`▶️ ${name} reinstated.`); loadData(); }
      else alert(data.error || 'Could not update.');
    }

    function closeSuspend() { document.getElementById('suspendModal').classList.add('hidden'); }

    async function confirmSuspend() {
      const userId = +document.getElementById('suspId').value;
      const name = document.getElementById('suspWho').textContent;
      const days = +document.getElementById('suspDays').value;
      const reason = document.getElementById('suspReason').value.trim();
      const { ok, data } = await C4K.api('/api/admin/suspend', 'POST', { userId, suspended: true, days, reason });
      if (ok) {
        closeSuspend();
        const when = data.until ? ('until ' + data.until.slice(0,16).replace('T',' ') + ' UTC') : 'permanently';
        alert(`⏸️ ${name} suspended ${when}.`);
        loadData();
      } else alert(data.error || 'Could not suspend.');
    }
    document.getElementById('suspendModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'suspendModal') closeSuspend();
    });

    // ── Lesson editor ──
    function openLessonEditor(lesson) {
      const l = lesson || { id: '', emoji: '📘', title: '', blurb: '', level: 'All ages', xp: 50, unit: 1, published: true };
      setText('leTitle', lesson ? 'Edit Lesson' : 'Add Lesson');
      document.getElementById('leId').value = l.id || '';
      document.getElementById('leEmoji').value = l.emoji || '📘';
      document.getElementById('leName').value = l.title || '';
      document.getElementById('leBlurb').value = l.blurb || '';
      document.getElementById('leLevel').value = l.level || '';
      document.getElementById('leXp').value = l.xp || 50;
      document.getElementById('leUnit').value = l.unit || 1;
      document.getElementById('lePublished').checked = l.published !== false;
      setText('leErr', '');
      document.getElementById('lessonEditor').classList.remove('hidden');
    }
    function closeLessonEditor() { document.getElementById('lessonEditor').classList.add('hidden'); }
    async function saveLesson() {
      const payload = {
        id: document.getElementById('leId').value,
        emoji: document.getElementById('leEmoji').value,
        title: document.getElementById('leName').value.trim(),
        blurb: document.getElementById('leBlurb').value.trim(),
        level: document.getElementById('leLevel').value.trim(),
        xp: parseInt(document.getElementById('leXp').value, 10) || 50,
        unit: parseInt(document.getElementById('leUnit').value, 10) || 1,
        published: document.getElementById('lePublished').checked
      };
      const { ok, data } = await C4K.api('/api/admin/lesson', 'POST', payload);
      if (ok) { closeLessonEditor(); await loadData(); }
      else setText('leErr', '❌ ' + (data.error || 'Could not save.'));
    }
    async function deleteLesson(id) {
      if (!confirm('Delete this lesson? Kids will no longer see it.')) return;
      await C4K.api('/api/admin/lesson/delete', 'POST', { id });
      await loadData();
    }
    document.getElementById('lessonEditor')?.addEventListener('click', (e) => {
      if (e.target.id === 'lessonEditor') closeLessonEditor();
    });

    // No separate admin login - everyone signs in on the main page. If an admin is already
    // logged in, show the dashboard; otherwise send them to the one login.
    (async () => {
      const me = await C4K.loadMe();
      if (me && ADMIN_ROLES.includes(me.role)) { showDashboard(); return; }
      if (me) { location.href = C4K.homeFor(me); return; }   // logged in as a non-admin → their own area
      location.href = 'index.html?login=1';                  // not logged in → main login
    })();
