# Google Search Console - Setup (free Google search traffic)

Search Console tells Google your site exists, gets your pages indexed faster,
and shows you what people search to find you. It's free.

Your site is already SEO-ready:
- Sitemap (live): https://kidvibers.com/sitemap.xml
- Robots file (live): https://kidvibers.com/robots.txt

You just need to verify you own the site, then submit the sitemap.

---

## Step 1 - Add your site (2 minutes, you do this)

1. Go to https://search.google.com/search-console and sign in with a Google
   account (a parent's is fine).
2. Click "Add property".
3. Choose the "URL prefix" box (the right-hand one) and enter:
   https://kidvibers.com
4. Click Continue. Google shows verification options.

## Step 2 - Verify ownership (I can finish this for you)

Pick the "HTML file" method - it's the easiest one I can complete:

1. Google gives you a file to download, named something like
   `google1a2b3c4d5e.html`.
2. Either:
   - Paste me the file's NAME and the line of text inside it, and I'll create it
     on the site for you, OR
   - Tell me you used the "HTML tag" method and paste the
     `<meta name="google-site-verification" content="..." />` tag, and I'll add
     it to the homepage, OR
   - If you used the "Domain" method instead, paste the TXT record value and I'll
     add it to Cloudflare DNS.
3. Click "Verify" in Search Console. Done.

(Any of the three works - whichever Google shows you first, just send me the
value and I'll put it in place.)

## Step 3 - Submit your sitemap (you do this, after verifying)

1. In Search Console, open "Sitemaps" (left menu).
2. In the "Add a new sitemap" box, type:  sitemap.xml
3. Click Submit. It should say "Success".

That's it. Google will start indexing your pages over the next few days.

---

## After it's set up - what to check weekly

- "Performance" tab: which search terms bring people in (great content ideas).
- "Pages" / "Indexing": confirm your pages are getting indexed.
- Use "URL Inspection" (top search bar) on any new page and click
  "Request indexing" to get it crawled faster.

## Bonus (optional, also free)
- Add Bing Webmaster Tools (bing.com/webmasters) - you can import directly from
  Google Search Console in one click, and it covers Bing + DuckDuckGo.
