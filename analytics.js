// Microsoft Clarity — privacy-first product analytics (heatmaps + session insights).
// Loaded on every page. Disclosed in privacy.html and for-schools-privacy.html.
// To disable site-wide, empty CLARITY_ID below (or delete this file's reference).
(function () {
  var CLARITY_ID = "xt6zo4j6wt";
  if (!CLARITY_ID) return;
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, "clarity", "script", CLARITY_ID);
})();
