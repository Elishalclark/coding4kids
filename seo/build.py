#!/usr/bin/env python3
"""Generate KidVibers landing pages + sitemap.xml.

Run from the repo root:  python3 seo/build.py

Four page families, all written into /p/ so they stay clearly separated from the
hand-built pages at the repo root:

  /p/answers/<slug>.html    parent & teacher questions        (content/answers.json)
  /p/for/<slug>.html        audience x age band               (content/audiences.json)
  /p/learn/<slug>.html      one page per published lesson     (content/lessons.json)
  /p/coding-for-kids/<slug>.html   city pages                 (content/locations.json)

content/lessons.json is NOT in the repo, because the curriculum lives in the
production D1 database rather than in code. Export it with:

  cd cloudflare && npx wrangler d1 execute kidvibers --remote --json \\
    --command="SELECT id,title,blurb,level,unit,steps FROM lessons WHERE published=1 ORDER BY position,id" \\
    | python3 -c "import sys,json; json.dump(json.load(sys.stdin)[0]['results'], open('../seo/content/lessons.json','w'), indent=1)"

Without that file the lesson pages are simply skipped and everything else still
builds, so the script is safe to run on a fresh clone.
"""
import html
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "seo", "content")
OUT = os.path.join(ROOT, "p")
SITE = "https://kidvibers.com"

# Bumped by cloudflare/deploy.sh along with every other asset URL.
ASSET_V = "219"


def load(name):
    path = os.path.join(CONTENT, name)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def esc(s):
    return html.escape(str(s or ""), quote=True)


def shell(*, title, desc, canonical, depth, body, breadcrumbs=None, extra_head=""):
    """One page. `depth` is how many directories deep the file sits, so relative
    asset links resolve without needing a <base> tag."""
    up = "../" * depth
    crumb_ld = ""
    if breadcrumbs:
        items = [{
            "@type": "ListItem", "position": i + 1, "name": n,
            "item": SITE + u,
        } for i, (n, u) in enumerate(breadcrumbs)]
        crumb_ld = (
            '\n  <script type="application/ld+json">'
            + json.dumps({"@context": "https://schema.org",
                          "@type": "BreadcrumbList", "itemListElement": items})
            + "</script>"
        )
    crumb_html = ""
    if breadcrumbs:
        parts = " › ".join(
            f'<a href="{up}{u.lstrip("/")}">{esc(n)}</a>' if i < len(breadcrumbs) - 1
            else f"<span>{esc(n)}</span>"
            for i, (n, u) in enumerate(breadcrumbs)
        )
        crumb_html = f'<nav class="lp-crumb" aria-label="Breadcrumb">{parts}</nav>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}" />
  <link rel="canonical" href="{esc(canonical)}" />
  <link rel="icon" href="{up}favicon.svg" type="image/svg+xml" />
  <meta property="og:title" content="{esc(title)}" />
  <meta property="og:description" content="{esc(desc)}" />
  <meta property="og:image" content="{SITE}/icon-512.png" />
  <meta property="og:type" content="article" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="{up}styles.css?v={ASSET_V}" />
  <style>
    .lp {{ max-width: 760px; margin: 0 auto; padding: 0 18px 80px; }}
    .lp-crumb {{ font-size: .82rem; color: var(--text-faint); padding: 18px 0 0; }}
    .lp-crumb a {{ color: var(--text-dim); font-weight: 700; }}
    .lp-hero {{ padding: 26px 0 18px; }}
    .lp-hero h1 {{ font-size: 2rem; font-weight: 900; line-height: 1.2; }}
    .lp-hero .lead {{ color: var(--text-dim); font-size: 1.08rem; line-height: 1.6; margin-top: 12px; }}
    .lp-sec {{ background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 22px 24px; margin-bottom: 16px; }}
    .lp-sec h2 {{ font-size: 1.15rem; font-weight: 900; margin-bottom: 8px; color: var(--purple); }}
    .lp-sec p {{ line-height: 1.75; color: var(--text-dim); }}
    .lp-sec code {{ background: var(--surface-2); padding: 2px 6px; border-radius: 5px; font-size: .92em; }}
    .lp-cta {{ background: var(--surface-2); border: 1px solid var(--border-bright); border-radius: 16px; padding: 26px; text-align: center; margin: 26px 0; }}
    .lp-cta p {{ color: var(--text-dim); line-height: 1.65; margin-bottom: 16px; }}
    .lp-rel {{ margin-top: 26px; }}
    .lp-rel h2 {{ font-size: 1rem; font-weight: 900; margin-bottom: 10px; }}
    .lp-rel ul {{ list-style: none; padding: 0; display: grid; gap: 8px; }}
    .lp-rel a {{ color: var(--purple); font-weight: 700; font-size: .92rem; }}
    @media (max-width: 600px) {{ .lp-hero h1 {{ font-size: 1.6rem; }} }}
  </style>{crumb_ld}{extra_head}
  <script src="{up}analytics.js?v={ASSET_V}"></script>
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-HZ95TLLKPL"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){{dataLayer.push(arguments);}}
    gtag('js', new Date());

    // The options are not optional: privacy.html promises Google Signals and ad
    // personalization are off. Keep them in step with that page.
    gtag('config', 'G-HZ95TLLKPL', {{
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    }});
  </script>
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-5CJQ52WX"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->
  <nav class="nav">
    <div class="legal-nav">
      <a href="{up}index.html" class="logo"><span class="logo-icon">🚀</span><span>Kid<strong>Vibers</strong></span></a>
      <a href="{up}index.html" class="btn btn-ghost" style="margin-left:auto;">← Home</a>
    </div>
  </nav>
  <main class="lp">
    {crumb_html}
{body}
  </main>
  <footer class="footer"><div class="footer-bottom" style="padding-top:30px;">
    <p>© 2026 KidVibers.com<br>Owner: Elisha Clark</p></div></footer>
  <script src="{up}pwa.js?v={ASSET_V}" defer></script>
</body>
</html>
"""


def cta(text, up):
    return f"""    <div class="lp-cta">
      <p>{esc(text)}</p>
      <a href="{up}index.html#signup" class="btn btn-primary btn-lg">Start free →</a>
    </div>"""


def related(links, up, heading="Related"):
    if not links:
        return ""
    items = "".join(
        f'<li><a href="{up}{u.lstrip("/")}">{esc(n)}</a></li>' for n, u in links
    )
    return f'    <div class="lp-rel"><h2>{esc(heading)}</h2><ul>{items}</ul></div>'


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


# ─────────────────────────────── answers ───────────────────────────────
def build_answers(urls):
    data = load("answers.json") or []
    up = "../../"
    for i, a in enumerate(data):
        # Link to neighbours so every page is reachable and nothing is orphaned.
        sibs = [data[(i + k) % len(data)] for k in (1, 2, 3)] if len(data) > 3 else []
        body = [
            '    <div class="lp-hero">',
            f'      <h1>{esc(a["title"])}</h1>',
            f'      <p class="lead">{a["intro"]}</p>',
            "    </div>",
        ]
        for s in a["sections"]:
            body.append(f'    <div class="lp-sec"><h2>{esc(s["h"])}</h2><p>{s["p"]}</p></div>')
        body.append(cta(a["cta"], up))
        body.append(related(
            [(s["title"], f'/p/answers/{s["slug"]}.html') for s in sibs], up,
            "More questions parents ask"))
        # FAQ structured data: this page genuinely is a question and an answer.
        faq = {
            "@context": "https://schema.org", "@type": "FAQPage",
            "mainEntity": [{
                "@type": "Question", "name": a["title"],
                "acceptedAnswer": {"@type": "Answer", "text": re.sub(r"<[^>]+>", "", a["intro"])},
            }],
        }
        url = f"/p/answers/{a['slug']}.html"
        write(os.path.join(OUT, "answers", a["slug"] + ".html"), shell(
            title=a["title"] + " | KidVibers",
            desc=a["desc"], canonical=SITE + url, depth=2,
            body="\n".join(body),
            breadcrumbs=[("Home", "/"), ("Answers", "/p/answers/"), (a["title"], url)],
            extra_head='\n  <script type="application/ld+json">' + json.dumps(faq) + "</script>",
        ))
        urls.append((url, "0.7"))
    return len(data)


# ─────────────────────────────── audiences ───────────────────────────────
def build_audiences(urls):
    data = load("audiences.json") or {}
    auds, bands = data.get("audiences", []), data.get("ageBands", [])
    up = "../../"
    n = 0
    for a in auds:
        for b in bands:
            slug = f'{a["slug"]}-{b["slug"]}'
            title = f'{a["h1"]} ({b["label"]})'
            body = [
                '    <div class="lp-hero">',
                f'      <h1>{esc(title)}</h1>',
                f'      <p class="lead">{esc(a["lead"])}</p>',
                "    </div>",
                f'    <div class="lp-sec"><h2>What {esc(b["label"])} looks like</h2>'
                f'<p>{esc(b["note"])} Most children this age are working through '
                f'{esc(b["worlds"])}.</p></div>',
            ]
            for h, p in a["points"]:
                body.append(f'    <div class="lp-sec"><h2>{esc(h)}</h2><p>{esc(p)}</p></div>')
            body.append(cta(
                f'KidVibers covers ages 6-16 across 293 lessons and 25 worlds. '
                f'There is a free tier and a free trial.', up))
            sibs = [(f'{a["h1"]} ({x["label"]})', f'/p/for/{a["slug"]}-{x["slug"]}.html')
                    for x in bands if x["slug"] != b["slug"]]
            others = [(o["h1"], f'/p/for/{o["slug"]}-{b["slug"]}.html')
                      for o in auds if o["slug"] != a["slug"]][:3]
            body.append(related(sibs, up, "Other age groups"))
            body.append(related(others, up, "Other settings"))
            url = f"/p/for/{slug}.html"
            write(os.path.join(OUT, "for", slug + ".html"), shell(
                title=title + " | KidVibers", desc=a["desc"],
                canonical=SITE + url, depth=2, body="\n".join(body),
                breadcrumbs=[("Home", "/"), ("Who it's for", "/p/for/"), (title, url)],
            ))
            urls.append((url, "0.7"))
            n += 1
    return n


# ─────────────────────────────── lessons ───────────────────────────────
def build_lessons(urls):
    data = load("lessons.json")
    if not data:
        return 0
    up = "../../"
    def sl(t):
        return re.sub(r"[^a-z0-9]+", "-", (t or "").lower()).strip("-") or "lesson"
    seen, n = set(), 0
    for i, l in enumerate(data):
        slug = sl(l.get("title"))
        while slug in seen:
            slug += "-2"
        seen.add(slug)
        steps = l.get("steps")
        if isinstance(steps, str):
            try:
                steps = json.loads(steps)
            except (ValueError, TypeError):
                steps = []
        steps = steps or []
        title = l.get("title") or "Lesson"
        body = [
            '    <div class="lp-hero">',
            f'      <h1>{esc(title)}</h1>',
            f'      <p class="lead">{esc(l.get("blurb"))}</p>',
            "    </div>",
        ]
        for s in steps:
            h = esc(s.get("h") or "")
            p = s.get("p") or ""            # lesson copy is authored, not user input
            c = s.get("code")
            block = f'<p>{p}</p>'
            if c:
                block += f'<pre style="background:var(--surface-2);padding:12px;border-radius:10px;overflow-x:auto;"><code>{esc(c)}</code></pre>'
            body.append(f'    <div class="lp-sec"><h2>{h}</h2>{block}</div>')
        body.append(cta(
            f'"{title}" is one of 293 lessons on KidVibers. Start free and pick up from here.', up))
        sibs = []
        for k in (1, 2, 3):
            if len(data) > k:
                o = data[(i + k) % len(data)]
                sibs.append((o.get("title") or "Lesson", f'/p/learn/{sl(o.get("title"))}.html'))
        body.append(related(sibs, up, "Next lessons"))
        url = f"/p/learn/{slug}.html"
        write(os.path.join(OUT, "learn", slug + ".html"), shell(
            title=f"{title} - free coding lesson for kids | KidVibers",
            desc=(l.get("blurb") or title)[:155],
            canonical=SITE + url, depth=2, body="\n".join(body),
            breadcrumbs=[("Home", "/"), ("Lessons", "/p/learn/"), (title, url)],
        ))
        urls.append((url, "0.6"))
        n += 1
    return n


# ─────────────────────────────── locations ───────────────────────────────
def build_locations(urls):
    """City pages.

    Deliberately contain NO invented local facts - no fake partnerships, no made-up
    library names, no fabricated class listings. Everything stated is true of
    KidVibers everywhere; only the place name varies. That keeps them honest, but
    it is also exactly why they are the thinnest family here: see seo/README.md.
    """
    data = load("locations.json") or []
    up = "../../"
    for i, c in enumerate(data):
        city, st = c["city"], c["state"]
        place = f"{city}, {st}"
        title = f"Coding for kids in {place}"
        body = [
            '    <div class="lp-hero">',
            f'      <h1>{esc(title)}</h1>',
            f'      <p class="lead">KidVibers is an online coding platform for children aged 6-16. '
            f'Families in {esc(place)} can use it from home, at any time - there is no class to '
            f'travel to and no schedule to fit around.</p>',
            "    </div>",
            '    <div class="lp-sec"><h2>Learn from home, on your own schedule</h2>'
            f'<p>Everything runs in the browser, so children in {esc(place)} work through the same '
            '293 lessons at their own pace rather than at a fixed class time. That suits families '
            'juggling school, homeschool co-ops and after-school activities.</p></div>',
            '    <div class="lp-sec"><h2>No coding knowledge needed at home</h2>'
            '<p>Each lesson explains its own concept and the platform checks the work, so a parent '
            'does not need to know how to code. A built-in helper gives hints when a child is '
            'stuck, so progress does not stall.</p></div>',
            '    <div class="lp-sec"><h2>Safe by design</h2>'
            '<p>No ads. No public gallery. No messaging between users. A parent has to approve '
            "every child account before the child can use anything, and you can review or delete "
            "your child's data at any time.</p></div>",
            '    <div class="lp-sec"><h2>What children actually learn</h2>'
            '<p>The curriculum runs across 25 worlds, from first commands and loops through typed '
            'Python, HTML, CSS and JavaScript, up to data structures. Kids earn printable '
            'certificates as they go - useful for homeschool portfolios.</p></div>',
        ]
        body.append(cta(
            f"Free to start from anywhere, including {place}.", up))
        sibs = []
        for k in (1, 2, 3, 4):
            if len(data) > k:
                o = data[(i + k) % len(data)]
                sibs.append((f'{o["city"]}, {o["state"]}',
                             f'/p/coding-for-kids/{o["slug"]}.html'))
        body.append(related(sibs, up, "Nearby pages"))
        body.append(related([
            ("Coding for homeschoolers", "/p/for/homeschool-ages-9-11.html"),
            ("What age should kids start coding?", "/p/answers/what-age-should-kids-start-coding.html"),
        ], up, "Popular guides"))
        url = f'/p/coding-for-kids/{c["slug"]}.html'
        write(os.path.join(OUT, "coding-for-kids", c["slug"] + ".html"), shell(
            title=title + " | KidVibers",
            desc=f"Online coding lessons for kids aged 6-16 in {place}. Self-paced, ad-free, "
                 f"parent-approved. Free tier and free trial.",
            canonical=SITE + url, depth=2, body="\n".join(body),
            breadcrumbs=[("Home", "/"), ("Locations", "/p/coding-for-kids/"), (place, url)],
        ))
        urls.append((url, "0.4"))
    return len(data)


# ─────────────────────────────── index pages ───────────────────────────────
def build_indexes(urls):
    """A hub per family. Without these the generated pages are orphans - nothing on
    the site links to them, and a sitemap alone is a weak discovery signal."""
    up = "../"
    specs = [
        ("answers", "Coding questions parents ask", "answers.json", None,
         lambda d: [(a["title"], f'/p/answers/{a["slug"]}.html') for a in d]),
        ("for", "Who KidVibers is for", "audiences.json", None,
         lambda d: [(f'{a["h1"]} ({b["label"]})', f'/p/for/{a["slug"]}-{b["slug"]}.html')
                    for a in d["audiences"] for b in d["ageBands"]]),
        ("coding-for-kids", "Coding for kids by city", "locations.json", None,
         lambda d: [(f'{c["city"]}, {c["state"]}', f'/p/coding-for-kids/{c["slug"]}.html')
                    for c in d]),
        ("learn", "Free coding lessons for kids", "lessons.json", None,
         lambda d: [(l.get("title") or "Lesson",
                     "/p/learn/" + (re.sub(r"[^a-z0-9]+", "-", (l.get("title") or "").lower()).strip("-") or "lesson") + ".html")
                    for l in d]),
    ]
    made = 0
    for slug, heading, src, _, fn in specs:
        d = load(src)
        if not d:
            continue
        links = fn(d)
        items = "".join(f'<li><a href="{up}{u.lstrip("/")}">{esc(n)}</a></li>' for n, u in links)
        body = (f'    <div class="lp-hero"><h1>{esc(heading)}</h1>'
                f'<p class="lead">{len(links)} pages.</p></div>'
                f'    <div class="lp-sec"><ul style="list-style:none;padding:0;display:grid;'
                f'gap:8px;">{items}</ul></div>')
        url = f"/p/{slug}/"
        write(os.path.join(OUT, slug, "index.html"), shell(
            title=heading + " | KidVibers",
            desc=heading + " on KidVibers - free, ad-free coding for ages 6-16.",
            canonical=SITE + url, depth=2, body=body,
            breadcrumbs=[("Home", "/"), (heading, url)],
        ))
        urls.append((url, "0.8"))
        made += 1
    return made


# ─────────────────────────────── sitemap ───────────────────────────────
def build_sitemap(generated):
    """Rebuild sitemap.xml: the existing hand-maintained root pages, plus everything
    generated here. Root pages are re-derived from the current file listing so a
    deleted page can't linger in the sitemap."""
    existing = []
    src = os.path.join(ROOT, "sitemap.xml")
    if os.path.isfile(src):
        with open(src, encoding="utf-8") as f:
            for m in re.finditer(r"<loc>([^<]+)</loc>", f.read()):
                path = m.group(1).replace(SITE, "") or "/"
                if path.startswith("/p/"):
                    continue                      # regenerated below
                fs = os.path.join(ROOT, path.lstrip("/"))
                if path == "/" or os.path.isfile(fs):
                    existing.append((path, "1.0" if path == "/" else "0.8"))
    seen, rows = set(), []
    for path, pri in existing + generated:
        if path in seen:
            continue
        seen.add(path)
        rows.append(f"  <url><loc>{SITE}{path}</loc><priority>{pri}</priority></url>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           + "\n".join(rows) + "\n</urlset>\n")
    with open(os.path.join(ROOT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(xml)
    return len(rows), len(existing)


def main():
    urls = []
    n_ans = build_answers(urls)
    n_aud = build_audiences(urls)
    n_les = build_lessons(urls)
    n_loc = build_locations(urls)
    n_idx = build_indexes(urls)
    total, kept = build_sitemap(urls)
    print(f"  answers   {n_ans:>4}")
    print(f"  audiences {n_aud:>4}")
    print(f"  lessons   {n_les:>4}" + ("   (skipped - no content/lessons.json)" if not n_les else ""))
    print(f"  locations {n_loc:>4}")
    print(f"  indexes   {n_idx:>4}")
    print(f"  ─────────────")
    print(f"  generated {len(urls):>4} pages")
    print(f"  sitemap   {total:>4} urls ({kept} existing root pages kept)")
    if not n_les:
        print("\n  To add lesson pages, export the curriculum - see the header of this file.")


if __name__ == "__main__":
    sys.exit(main())
