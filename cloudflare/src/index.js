// KidVibers - Cloudflare Worker
// Phase 1: serves the static site from Cloudflare. The API is ported in stages;
// until an endpoint is migrated it returns a friendly 503 so the page still loads.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "This part of KidVibers is moving to Cloudflare and isn't ready yet. Try again soon!" },
        { status: 503 }
      );
    }

    // Everything else is a static page/asset (index.html, styles.css, app.js, images, ...).
    return env.ASSETS.fetch(request);
  },
};
