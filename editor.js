// KidVibers visual editor.
// - For EVERYONE: applies published color + text edits on page load.
// - For a logged-in SUPER ADMIN: shows an "Edit Site" button to change text & colors,
//   Save (to staging) and Publish (to the live site). Only active where the
//   /api/site-edits endpoint exists (the Cloudflare version); does nothing elsewhere.
(function () {
  const PAGE = (location.pathname.replace(/\/+$/, "") || "/index.html");
  const COLOR_VARS = [
    { v: "--purple", label: "Primary" },
    { v: "--pink", label: "Accent" },
    { v: "--bg", label: "Background" },
    { v: "--surface", label: "Cards" },
    { v: "--text", label: "Text" },
    { v: "--yellow", label: "Highlight" },
  ];
  let edits = { colors: {}, texts: {} };
  let editing = false;

  function token() { return localStorage.getItem("c4k_token"); }
  function api(path, method, body) {
    const h = { "Content-Type": "application/json" };
    const t = token(); if (t) h.Authorization = "Bearer " + t;
    return fetch(path, { method: method || "GET", headers: h, body: body ? JSON.stringify(body) : undefined });
  }
  function esc(s) { return String(s == null ? "" : s); }

  // Deterministic list of editable text elements (leaf text only, outside nav/modals).
  function editableEls() {
    const sel = "h1,h2,h3,h4,p,li,.btn,button,.section-tag,.hero-badge,.stat-label,.stat-num";
    return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function (el) {
      return !el.closest("nav,#editToolbar,#editPanel,#editFab,#c4kGate,#c4kLock,.modal-overlay,script,style") &&
        el.children.length === 0 && (el.textContent || "").trim().length > 0;
    });
  }
  function applyColors(colors) {
    for (const k in (colors || {})) document.documentElement.style.setProperty(k, colors[k]);
  }
  function applyTexts(texts) {
    const map = (texts || {})[PAGE]; if (!map) return;
    const els = editableEls();
    for (const i in map) if (els[i]) els[i].textContent = map[i];
  }

  async function init() {
    let r; try { r = await api("/api/site-edits"); } catch (e) { return; }
    if (!r.ok) return;  // endpoint not present (e.g. the Mac site) -> editor stays off
    try { edits = await r.json(); } catch (e) { edits = { colors: {}, texts: {} }; }
    edits.colors = edits.colors || {}; edits.texts = edits.texts || {};
    applyColors(edits.colors);
    applyTexts(edits.texts);
    if (token()) {
      try { const me = await (await api("/api/me")).json(); if (me && me.user && me.user.role === "super_admin") mountFab(); } catch (e) {}
    }
  }

  function mountFab() {
    if (document.getElementById("editFab")) return;
    const fab = document.createElement("button");
    fab.id = "editFab";
    fab.textContent = "✏️ Edit Site";
    fab.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483000;background:linear-gradient(135deg,#7c3aed,#db2777);" +
      "color:#fff;border:none;border-radius:50px;padding:12px 20px;font-weight:900;font-family:Nunito,system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.5);";
    fab.onclick = enterEdit;
    document.body.appendChild(fab);
  }

  function enterEdit() {
    if (editing) return; editing = true;
    document.getElementById("editFab").style.display = "none";
    editableEls().forEach(function (el, i) {
      el.dataset.eidx = i;
      el.setAttribute("contenteditable", "true");
      el.style.outline = "1px dashed rgba(167,139,250,0.6)";
      el.style.outlineOffset = "2px";
      el.addEventListener("input", onTextEdit);
    });
    mountPanel();
  }
  function onTextEdit(e) {
    const el = e.currentTarget;
    edits.texts[PAGE] = edits.texts[PAGE] || {};
    edits.texts[PAGE][el.dataset.eidx] = el.textContent;
  }
  function exitEdit() {
    editing = false;
    editableEls().forEach(function (el) { el.removeAttribute("contenteditable"); el.style.outline = ""; el.removeEventListener("input", onTextEdit); });
    const p = document.getElementById("editPanel"); if (p) p.remove();
    const f = document.getElementById("editFab"); if (f) f.style.display = "";
  }

  function toHex(c) {
    c = (c || "").trim();
    if (/^#([0-9a-f]{6})$/i.test(c)) return c;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(",").map(function (x) { return parseInt(x, 10); }); return "#" + p.slice(0, 3).map(function (x) { return (x || 0).toString(16).padStart(2, "0"); }).join(""); }
    return "#7c3aed";
  }

  function mountPanel() {
    const p = document.createElement("div");
    p.id = "editPanel";
    p.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483001;background:#171327;border:1px solid #3a2f63;" +
      "border-radius:16px;padding:16px;width:250px;max-height:80vh;overflow:auto;color:#eee;font-family:Nunito,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);";
    p.innerHTML =
      '<div style="font-weight:900;margin-bottom:4px;">✏️ Editing this page</div>' +
      '<div style="font-size:0.76rem;color:#bdb6d6;margin-bottom:12px;">Click any text to change the words.</div>' +
      '<div style="font-weight:800;font-size:0.8rem;margin-bottom:6px;">🎨 Colors</div>' +
      '<div id="editColors" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;"></div>' +
      '<button id="edSave" style="width:100%;padding:10px;border:none;border-radius:10px;background:#7c3aed;color:#fff;font-weight:900;cursor:pointer;margin-bottom:6px;">💾 Save to staging</button>' +
      '<button id="edPublish" style="width:100%;padding:10px;border:none;border-radius:10px;background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;font-weight:900;cursor:pointer;margin-bottom:6px;">🚀 Publish to live</button>' +
      '<button id="edExit" style="width:100%;padding:8px;border:1px solid #3a2f63;border-radius:10px;background:none;color:#bdb6d6;font-weight:800;cursor:pointer;">Done</button>' +
      '<div id="edMsg" style="font-size:0.76rem;margin-top:8px;min-height:14px;text-align:center;"></div>';
    document.body.appendChild(p);
    const cc = p.querySelector("#editColors");
    COLOR_VARS.forEach(function (c) {
      const cur = edits.colors[c.v] || getComputedStyle(document.documentElement).getPropertyValue(c.v);
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;font-size:0.8rem;cursor:pointer;";
      row.appendChild(Object.assign(document.createElement("span"), { textContent: c.label }));
      const inp = document.createElement("input");
      inp.type = "color"; inp.value = toHex(cur);
      inp.style.cssText = "width:40px;height:26px;border:none;background:none;cursor:pointer;";
      inp.oninput = function () { document.documentElement.style.setProperty(c.v, inp.value); edits.colors[c.v] = inp.value; };
      row.appendChild(inp); cc.appendChild(row);
    });
    p.querySelector("#edExit").onclick = exitEdit;
    p.querySelector("#edSave").onclick = function () { save(false); };
    p.querySelector("#edPublish").onclick = function () { save(true); };
  }

  async function save(publish) {
    const msg = document.getElementById("edMsg");
    msg.style.color = "#bdb6d6"; msg.textContent = "Saving…";
    const r = await api("/api/admin/site-edits", "POST", edits);
    if (!r.ok) { msg.style.color = "#ff8a8a"; msg.textContent = "Save failed - log in as super admin first."; return; }
    if (!publish) { msg.style.color = "#7ee0a0"; msg.textContent = "💾 Saved to staging!"; return; }
    const pr = await api("/api/admin/site-edits/publish", "POST", {});
    const pd = await pr.json().catch(function () { return {}; });
    msg.style.color = pr.ok ? "#7ee0a0" : "#ff8a8a";
    msg.textContent = pr.ok ? "🚀 Published to the live site!" : (pd.error || "Publish failed");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
