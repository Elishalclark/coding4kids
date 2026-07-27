// Product analytics, loaded on every page and disclosed in privacy.html /
// for-schools-privacy.html. To disable a provider site-wide, empty its ID below.
(function () {
  var CLARITY_ID = "xt6zo4j6wt";       // Microsoft Clarity (heatmaps + session insights)
  var GA_ID = "G-W1VS7WELXG";          // Google Analytics 4 (aggregate usage)

  // ── Microsoft Clarity ──
  if (CLARITY_ID) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_ID);
  }

  // ── Google Analytics 4 ──
  // Configured for analytics only: advertising personalization and Google Signals
  // are disabled, so it never builds advertising profiles of children. Google Consent
  // Mode v2 starts every storage type "denied" until consent is granted.
  if (GA_ID) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };

    // Consent Mode v2 default — MUST run before gtag.js loads. Everything starts denied;
    // call gtag('consent','update',{ analytics_storage:'granted', ... }) from a cookie
    // banner once the visitor agrees, to switch GA out of consent-denied (cookieless) mode.
    gtag("consent", "default", {
      ad_user_data: "denied",
      ad_personalization: "denied",
      ad_storage: "denied",
      analytics_storage: "denied",
      wait_for_update: 500
    });

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
