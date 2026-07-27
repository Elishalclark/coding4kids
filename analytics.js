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
  // are disabled, so it never builds advertising profiles of children.
  if (GA_ID) {
    var s = document.createElement("script");
    s.async = 1; s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.getElementsByTagName("script")[0].parentNode.insertBefore(s, null);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    gtag("js", new Date());
    gtag("config", GA_ID, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
  }
})();
