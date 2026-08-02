// Product analytics + tag management, loaded on every page and disclosed in
// privacy.html / for-schools-privacy.html. To disable a provider, empty its ID below.
(function () {
  var CLARITY_ID = "xv92ouu30k";       // Microsoft Clarity (heatmaps + session insights)
  var GA_ID = "G-W1VS7WELXG";          // Google Analytics 4 (aggregate usage)
  var GTM_ID = "GTM-5CJQ52WX";         // Google Tag Manager container

  // Shared Google dataLayer + gtag shim (used by Consent Mode, GA, and GTM).
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // ── Consent Mode default — MUST run before any Google tag (GTM/GA) loads.
  // Analytics only: no advertising consent is requested or used on this child-directed
  // site. analytics_storage starts denied; call gtag('consent','update',{
  // analytics_storage:'granted' }) from a cookie banner once the visitor agrees. ──
  gtag("consent", "default", {
    analytics_storage: "denied",
    wait_for_update: 500
  });

  // ── Microsoft Clarity ──
  if (CLARITY_ID) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
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
})();
