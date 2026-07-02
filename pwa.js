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

  // ── PWA install prompt ──
  // Show a friendly "Add to Home Screen" banner when the browser fires beforeinstallprompt.
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    // Don't show if dismissed recently (7 days)
    try { if (localStorage.getItem('c4k_pwa_dismissed') > Date.now() - 7 * 86400000) return; } catch(e2) {}
    setTimeout(showInstallBanner, 3000); // slight delay so page has settled
  });

  function showInstallBanner() {
    if (document.getElementById('c4kInstallBar')) return;
    var bar = document.createElement('div');
    bar.id = 'c4kInstallBar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9990;background:#1a1730;border-top:1px solid rgba(167,139,250,0.4);' +
      "padding:12px 16px;display:flex;align-items:center;gap:12px;font-family:'Nunito',sans-serif;box-shadow:0 -4px 20px rgba(0,0,0,0.4);";
    bar.innerHTML =
      '<span style="font-size:1.6rem;">🚀</span>' +
      '<div style="flex:1;"><div style="font-weight:900;color:#fff;font-size:0.95rem;">Add KidVibers to your home screen</div>' +
        '<div style="color:#a5a0c0;font-size:0.8rem;">Works like an app — fast, offline, no browser bar</div></div>' +
      '<button id="c4kInstallBtn" style="background:linear-gradient(135deg,#7c3aed,#db2777);color:#fff;border:none;border-radius:50px;padding:9px 18px;font-weight:900;cursor:pointer;font-size:0.85rem;white-space:nowrap;font-family:inherit;">Install</button>' +
      '<button id="c4kInstallX" style="background:none;border:none;color:#6f6890;cursor:pointer;font-size:1.2rem;padding:4px 8px;">✕</button>';
    document.body.appendChild(bar);
    document.getElementById('c4kInstallBtn').onclick = function () {
      if (deferredInstall) { deferredInstall.prompt(); deferredInstall.userChoice.then(function() { bar.remove(); }); }
      else {
        // iOS fallback: show instructions
        alert('To install on iPhone/iPad:\n1. Tap the Share button (box with arrow)\n2. Scroll down and tap "Add to Home Screen"\n3. Tap "Add" — done! 🎉');
        bar.remove();
      }
    };
    document.getElementById('c4kInstallX').onclick = function () {
      bar.remove();
      try { localStorage.setItem('c4k_pwa_dismissed', Date.now()); } catch(e2) {}
    };
  }

  // iOS: no beforeinstallprompt event — show banner on first visit if on Safari
  (function () {
    try {
      var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      var isSafari = /safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent);
      var isStandalone = window.navigator.standalone;
      var dismissed = localStorage.getItem('c4k_pwa_dismissed');
      if (isIOS && isSafari && !isStandalone && (!dismissed || dismissed < Date.now() - 7 * 86400000)) {
        setTimeout(showInstallBanner, 3000);
      }
    } catch(e2) {}
  })();
})();
