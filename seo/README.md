# Generated landing pages

`python3 seo/build.py` regenerates everything under `/p/` and rewrites `sitemap.xml`.
Run it after editing anything in `seo/content/`, and commit the generated output —
`cloudflare/deploy.sh` copies `p/` into the deploy bundle but does not build it.

```
answers     16   /p/answers/<slug>.html            parent & teacher questions
audiences   24   /p/for/<slug>.html                6 audiences x 4 age bands
locations  207   /p/coding-for-kids/<slug>.html    US cities
lessons      0   /p/learn/<slug>.html              one per published lesson (see below)
indexes      3   /p/<family>/                      hub page per family
```

## Adding the lesson pages

This is the strongest family and it is not built yet, because the curriculum lives in
the production D1 database rather than in the repo. Export it once and re-run the build:

```sh
cd cloudflare
npx wrangler d1 execute kidvibers --remote --json \
  --command="SELECT id,title,blurb,level,unit,steps FROM lessons WHERE published=1 ORDER BY position,id" \
  | python3 -c "import sys,json; json.dump(json.load(sys.stdin)[0]['results'], open('../seo/content/lessons.json','w'), indent=1)"
cd .. && python3 seo/build.py
```

That adds ~293 pages, each with genuinely unique teaching content. `content/lessons.json`
is gitignored — it is a build input, and the database is the source of truth.

## An honest note on the city pages

The 207 city pages are the weakest thing here, and it is worth being clear why rather
than discovering it from a traffic graph later.

They contain no invented local facts — no fake partnerships, no made-up class listings,
no imaginary library tie-ins. That was deliberate: a fabricated local claim on a
children's education site is far worse than a thin page. But it also means the only
thing that varies between them is the place name, which is close to the definition of a
doorway page under Google's scaled-content-abuse policy. The risk is not that these
pages fail to rank; it is that a large block of near-identical pages can drag the
*whole domain* down.

They are set to `priority 0.4` in the sitemap to signal their relative importance.

If you want to keep them, the fix is to give them something real:

- **Per-state homeschool requirements.** Genuinely varies, genuinely useful, and it maps
  to a real search intent. ~50 pages instead of 207, each actually different.
- **Real local partnerships.** If a library or co-op in a city actually uses KidVibers,
  that city's page becomes legitimate immediately.
- **Local pricing, events, or sessions** — anything true and specific.

If none of those are available, deleting `content/locations.json` and re-running the
build removes all 207 pages and their sitemap entries cleanly. The answers, audience and
lesson pages carry no such risk: every one of them says something different.

## Before this helps

- **Merge PR #23.** It fixes the `page.html` canonical bug, which currently tells Google
  every `?p=` section is a duplicate of the homepage.
- **Resubmit the sitemap** in Search Console after deploying.
- **Give it time.** New pages typically take weeks to be crawled and longer to rank.
