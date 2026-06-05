// Adds PWA tags to any page and registers the service worker (so the site installs like an app).
(function () {
  function hasLink(rel, href) {
    return Array.prototype.some.call(document.querySelectorAll('link[rel="' + rel + '"]'),
      function (l) { return l.getAttribute('href') === href; });
  }
  function addLink(rel, href, attrs) {
    if (hasLink(rel, href)) return;
    var l = document.createElement('link'); l.rel = rel; l.href = href;
    if (attrs) for (var k in attrs) l.setAttribute(k, attrs[k]);
    document.head.appendChild(l);
  }
  function addMeta(name, content) {
    if (document.querySelector('meta[name="' + name + '"]')) return;
    var m = document.createElement('meta'); m.name = name; m.content = content;
    document.head.appendChild(m);
  }
  if (!document.querySelector('link[rel="manifest"]')) addLink('manifest', '/manifest.json');
  addLink('icon', '/favicon.svg', { type: 'image/svg+xml' });
  addLink('apple-touch-icon', '/apple-touch-icon.png');
  addMeta('theme-color', '#0c0a18');
  addMeta('apple-mobile-web-app-capable', 'yes');
  addMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  addMeta('apple-mobile-web-app-title', 'KidVibers');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }
})();
