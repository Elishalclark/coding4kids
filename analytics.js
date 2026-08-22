// Tag management, loaded on every page and disclosed in privacy.html /
// for-schools-privacy.html. To disable a provider, empty its ID below.
(function () {
  var GTM_ID = "GTM-5CJQ52WX";         // Google Tag Manager container
  // Google Analytics (G-HZ95TLLKPL) is not loaded here — its standard snippet is inline in
  // every page's <head>, right after this file loads. Google's tag detector reads the raw
  // page HTML and does not execute JavaScript, so a tag injected from here is invisible to
  // it. Loading it here too would call gtag('config', ...) twice and double-count pageviews.
  //
  // Microsoft Clarity was removed: no session recording on a children's site.

  // Shared Google dataLayer + gtag shim (used by Consent Mode, GA, and GTM).
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // ── Consent Mode default — MUST run before any Google tag (GTM/GA) loads. ──
  // There is no cookie banner. Analytics storage is granted so plain visit counting works;
  // every advertising signal is denied explicitly, because Consent Mode treats any type you
  // DON'T declare as granted, and privacy.html promises no advertising cookies and no ad
  // personalization. Denying them here is what makes that promise true at runtime.
  gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied"
  });

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
})();
