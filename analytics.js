// Product analytics + tag management, loaded on every page and disclosed in
// privacy.html / for-schools-privacy.html. To disable a provider, empty its ID below.
(function () {
  var CLARITY_ID = "xv92ouu30k";       // Microsoft Clarity (heatmaps + session insights)
  var GA_ID = "G-HZ95TLLKPL";          // Google Analytics 4 (aggregate usage)
  var GTM_ID = "GTM-5CJQ52WX";         // Google Tag Manager container

  var CONSENT_KEY = "c4k_analytics_consent";   // "granted" | "denied" | null (not asked yet)
  var stored = null;
  try { stored = localStorage.getItem(CONSENT_KEY); } catch (e) {}

  // Shared Google dataLayer + gtag shim (used by Consent Mode, GA, and GTM).
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // ── Consent Mode default — MUST run before any Google tag (GTM/GA) loads.
  // Analytics only: no advertising consent is requested or used on this child-directed
  // site. Storage starts denied; the banner below flips it once the visitor chooses. ──
  gtag("consent", "default", {
    analytics_storage: "denied",
    wait_for_update: 500
  });
  // Returning visitor who already accepted: grant straight away, before the tags load,
  // so their very first pageview of the session is measured.
  if (stored === "granted") {
    gtag("consent", "update", { analytics_storage: "granted" });
  }

  // ── Microsoft Clarity ──
  if (CLARITY_ID) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
    // Clarity has its own consent API — keep it in step with the choice above.
    try {
      window.clarity("consentv2", {
        ad_Storage: "denied",
        analytics_Storage: stored === "granted" ? "granted" : "denied"
      });
    } catch (e) {}
  }

  // ── Google Tag Manager (head loader; the <noscript> fallback lives after <body>) ──
  if (GTM_ID) {
    (function (w, d, s, l, i) {
      w[l] = w[l] || [];
      w[l].push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
      var f = d.getElementsByTagName(s)[0],
          j = d.createElement(s), dl = l != "dataLayer" ? "&l=" + l : "";
      j.async = true; j.src = "https://www.googletagmanager.com/gtm.js?id=" + i + dl;
      f.parentNode.insertBefore(j, f);
    })(window, document, "script", "dataLayer", GTM_ID);
  }

  // ── Google Analytics 4 ──
  // Analytics only: advertising personalization and Google Signals are disabled, so it
  // never builds advertising profiles of children. Note: if you configure this same GA4
  // property inside the GTM container above, remove this block to avoid double-counting.
  if (GA_ID) {
    var s = document.createElement("script");
    s.async = 1; s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.getElementsByTagName("script")[0].parentNode.insertBefore(s, null);
    gtag("js", new Date());
    gtag("config", GA_ID, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
  }

  // ── Cookie consent banner ──
  // Analytics storage stays denied until the visitor picks. The choice is remembered in
  // localStorage, so the banner is a one-time thing per browser.
  function recordChoice(granted) {
    try { localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied"); } catch (e) {}
    gtag("consent", "update", { analytics_storage: granted ? "granted" : "denied" });
    try {
      if (window.clarity) {
        window.clarity("consentv2", {
          ad_Storage: "denied",
          analytics_Storage: granted ? "granted" : "denied"
        });
      }
    } catch (e) {}
  }

  function showCookieBanner() {
    if (document.getElementById("c4kCookieBar")) return;
    var bar = document.createElement("div");
    bar.id = "c4kCookieBar";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Cookie choices");
    // z-index sits above the "What's New" overlay (9998) — a consent prompt the visitor
    // can't actually click is worse than no prompt at all.
    bar.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:10000;background:#1a1730;" +
      "border-top:1px solid rgba(167,139,250,0.4);padding:12px 16px;display:flex;align-items:center;" +
      "gap:12px;flex-wrap:wrap;font-family:'Nunito',system-ui,sans-serif;box-shadow:0 -4px 20px rgba(0,0,0,0.4);";
    bar.innerHTML =
      '<span style="font-size:1.5rem;">🍪</span>' +
      '<div style="flex:1;min-width:200px;">' +
        '<div style="font-weight:900;color:#fff;font-size:0.92rem;">Can we count visits?</div>' +
        '<div style="color:#a5a0c0;font-size:0.8rem;">It helps us see which lessons work and fix what\'s confusing. ' +
        'No ads, ever — and we never sell data. <a href="/privacy.html" style="color:#c4b5fd;font-weight:800;">Privacy</a></div>' +
      '</div>' +
      '<button id="c4kCookieNo" style="background:none;border:1px solid rgba(167,139,250,0.35);color:#bdb6d6;' +
        'border-radius:50px;padding:9px 16px;font-weight:800;cursor:pointer;font-size:0.85rem;font-family:inherit;">No thanks</button>' +
      '<button id="c4kCookieYes" style="background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;border:none;' +
        'border-radius:50px;padding:9px 18px;font-weight:900;cursor:pointer;font-size:0.85rem;font-family:inherit;">Sure 👍</button>';
    document.body.appendChild(bar);
    document.getElementById("c4kCookieYes").onclick = function () { recordChoice(true); bar.remove(); };
    document.getElementById("c4kCookieNo").onclick = function () { recordChoice(false); bar.remove(); };
  }

  if (stored !== "granted" && stored !== "denied") {
    if (document.body) showCookieBanner();
    else document.addEventListener("DOMContentLoaded", showCookieBanner);
  }
})();
