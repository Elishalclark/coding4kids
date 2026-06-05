# KidVibers

A Duolingo-style coding app for kids — dark themed, with a real Python backend.

## Running it

No installs needed (pure Python standard library):

```bash
python3 server.py
```

Then open **http://localhost:3000**. The backend serves the website *and* the API on the same port.

To use a different port: `PORT=8080 python3 server.py`

## Deploying to Render

This repo includes `Dockerfile` and `render.yaml`, so deploying is mostly clicks:

1. **Push to GitHub** — create a repo and push this folder (already a git repo):
   ```bash
   git remote add origin https://github.com/<you>/coding4kids.git
   git push -u origin main
   ```
2. **Create the service on Render** — go to [render.com](https://render.com) → **New ▸ Blueprint** → connect your repo. Render reads `render.yaml` and creates a Docker web service with a 1 GB persistent disk mounted at `/data`.
3. **Set admin credentials** — in the service's **Environment** tab set `SUPER_ADMIN_USER`, `SUPER_ADMIN_PASS`, `ADMIN_USER`, `ADMIN_PASS` to strong values. (If you skip this, a strong random super-admin password is generated on first boot and printed once in the **Logs** tab.)
4. **Deploy.** Render gives you an HTTPS URL like `https://coding4kids.onrender.com`. Point your `coding4kids.com` domain at it under **Settings ▸ Custom Domains**.

Notes:
- The **Starter plan ($7/mo)** is required for the persistent disk — accounts, progress and the admin config live in `/data`. The free tier wipes the disk on each deploy.
- `DATA_DIR` controls where `data.db` + `admin_config.json` are stored (set to `/data` by the blueprint).
- `admin_config.json` and `data.db` are git-ignored and never committed.

### Email (real sending via Resend)
- Set env var **`RESEND_API_KEY`** (from [resend.com](https://resend.com), free tier) to actually send parent invites, consent links, upgrade requests, deletion notices, and admin notices. Optionally set **`EMAIL_FROM`** (default `KidVibers <kidvibers.help@outlook.com>`). Note: Resend requires a **verified sending domain**, so a plain Gmail address won't pass as the `from` for outbound mail — set `EMAIL_FROM` to an address on a domain you've verified in Resend if/when you enable real sending. The single public **contact** address shown across the site is `kidvibers.help@outlook.com`.
- Without the key, those messages are still stored/shown in-app (nothing breaks) — they just don't email out.

### Code Playground & Project Gallery
- `playground.html` runs real Python in the browser via **Skulpt** (CDN). No server execution, so it's safe.
- Logged-in kids can **💾 Save** projects to their account (up to 50) and **📤 Share to gallery**.
- `gallery.html` lists every shared project — kids can **Run** them in-browser, **❤️ Like** favorites, and **✏️ Remix** (opens the code in the Playground to save their own copy).
- **Safe by design:** no free-text comments (likes only), display names show **first name only**, titles/code are sanitized, and the **super admin can remove any project** (a 🗑️ Remove button appears in the gallery for them). Saving/sharing requires the COPPA consent gate to be cleared.

### Before real users (especially children)
- Payments are **simulated** — wire up Stripe before charging.
- Login is **rate-limited** (8 fails / 10 min → temporary 429) and display names are **HTML-sanitized** (anti-XSS). Still get your COPPA/privacy practices legally reviewed.

## Accounts & roles

The **Log In** button (home page) has four tabs — **👦 Kid**, **👨‍👩‍👧 Parent**, **🛠️ Admin**, **👑 Super**.
Each routes to the right place: Kid stays on the site, Parent → family dashboard, Admin/Super → admin dashboard.

| Role | How to get in | Access |
|------|---------------|--------|
| **Kid** | Sign up on the home page | Lessons, profile, AI *if on Pro/Family* |
| **Parent** | Home page → "Create a Family account" | Family dashboard: sees **only their own** plan + kids; can add kids (kids inherit Family AI) |
| **Admin** | Log In → Admin tab | View dashboard, stats, all users — **read-only** |
| **Super admin** | Log In → Super tab | Everything: change plans, edit **plan AI + daily chat limits**, manage **lessons** |

### Parents & families
Anyone can create a **Family (parent) account** from the home page. A parent:
- is on the Family plan automatically,
- adds kids from their **Family Dashboard** (`parent.html`) — each kid joins the family and **inherits Family AI**,
- can see **only** their own family — never other families or global stats.

### Super admin controls
The Super Admin dashboard adds two control panels (hidden from plain admins):
- **Plan Permissions & Limits** — per plan: toggle AI, set **AI chats-per-day**, and set **lessons allowed** (`-1` = unlimited). Plus a global **unit-test passing score** (%). All enforced live (`/api/ai` → `429` at chat cap; `/api/progress` → `403` at lesson cap).
- **Lesson Manager** — edit a lesson's emoji/title/blurb/level/XP/**unit**, show/hide (publish), add or delete lessons. The lessons page reads this live.

### Lessons, units & tests (the learning engine)
- **Sticky sessions** — you stay logged in across reloads/restarts; only the **Log Out** button (or a real auth failure) logs you out.
- **Interactive lessons** — step-by-step viewer with **Run** (visual output), **drag-and-drop** "order the code", and a **multiple-choice check** with instant feedback. There is **no Mark Complete button** — a lesson auto-completes only after the kid finishes the activities and answers correctly. Progress autosaves to the server in real time.
- **Worlds, bosses & mastery progression** — lessons are grouped into themed **Worlds** (🌱 Greenwood Basics → boss 🐛 Buggle; 🌊 Builder's Bay → boss 🦑 Krakode; 🚀 Cosmic Code Station → boss 👾 Glitchoid; 🏰 Algorithm Castle → boss 🐉 Recursor the Dragon). After finishing a world's lessons, the kid faces its **Boss Battle** (the unit test). Scoring ≥ the configurable pass mark **defeats the boss**, **levels them up**, and **unlocks the next world**. Locked worlds can't be skipped; bosses can be re-fought, and failed attempts show per-question feedback. Worlds live in `WORLDS` in `server.py`; super admins assign lessons to a world via the lesson editor's **Unit** field.
- **No-Cheat Policy** — a mandatory pledge (no sharing answers, no exploiting bugs, no extra accounts, no unauthorized tools) must be accepted before every test, with stated consequences (warning → test invalidation → account review → temporary suspension). Test answer keys are never sent to the browser — grading is server-side.
- **Plan lesson limits** — Free/Trial can do a limited number of lessons (super-admin configurable; default Free 3, Trial 5); Pro/Family unlimited. Locked lessons show an upgrade prompt.

### Tokens, avatars & the shop
- **Tokens** — every account starts with 40 🪙 and earns +10 per newly completed lesson (server-awarded).
- **Avatar shop** (dashboard → *Open Avatar Shop*) — spend tokens on **faces, hats, accessories, clothing, companions, and backgrounds**. Owned items can be equipped/removed; the look saves to the server and renders everywhere (dashboard hero, etc.). Avatars are layered emoji on a colored circle.

### Pricing is not advertised
- No "Pricing" nav link and no in-app upgrade CTAs. The pricing section still exists at `index.html#pricing` (reachable via the parent's upgrade link) but isn't promoted.
- The **only** upgrade prompt a kid sees is a popup when they hit their lesson limit: *"You can learn more with Pro or a Family Plan."*
- A kid choosing **Ask my parent** sends the parent this exact message: *"Your kid wants to upgrade. If you would like to upgrade their account, go to http://localhost:3000/index.html#pricing. If this is a mistake, please ignore this message. Thank you and have a great day."* It appears in the parent's **Messages** inbox on their dashboard.

### Parent invite & secure linking
- When a kid signs up, the app shows an **Invite Your Parent** screen with a **QR code** and a simulated email containing a **"Sign My Kid and Myself Up"** button. Both point to `index.html?plink=<token>` (a unique per-child link token).
- A parent who follows that link signs up; the server **connects that child to the new parent's family** and **links the parent's email to the child's account**. (No SMTP here, so the "email" is stored and shown in-app; swap in a real mail provider for production.)

### Stay logged in & go straight to your space
- Sessions persist until you press **Log Out**. When a logged-in user opens the site root, they're sent straight to their own area (kid → dashboard, parent → family, admin → panel) instead of the landing page — unless they followed a deep link like `#pricing`.

### Responsive & accessible
- Mobile-first layouts, fluid grids, and full-screen-friendly modals work on phones, tablets, laptops and desktops. Icon-only controls have aria-labels.

### Admin credentials (private)
Both admin accounts live in **`admin_config.json`** (auto-created/auto-filled on first run):
- `super_admin_username` / `super_admin_password` — full control
- `admin_username` / `admin_password` — read-only staff access
- Edit any of them, then **restart the server** — credentials re-sync on boot.
- **Keep this file private.** It is never served to the browser (the server blocks it), and so are `data.db` and `server.py`.

## Plans & AI gating (enforced on the server)

| Plan | AI features (Byte + Chatbot Lab) | Notes |
|------|----------------------------------|-------|
| **Trial** | ❌ No AI | 3 days, given automatically at signup |
| **Free** | ❌ No AI | What a trial becomes when it expires |
| **Pro** | ✅ AI unlocked | $9/mo |
| **Family** | ✅ AI unlocked | $15/mo, up to 4 kids |

AI is gated **server-side** (`/api/ai` returns 403 for non-Pro), not just hidden in the UI.
The super admin can upgrade/downgrade any kid from the dashboard.

## Files

- `server.py` — backend: auth, sessions, SQLite, families, plan/chat-limit settings, lessons, AI gating, static serving
- `auth.js` — shared front-end auth/API helper (`C4K`)
- `index.html` / `app.js` — landing page, signup, login (4 role tabs), parent signup, AI sections
- `lessons.html` / `lessons.js` — lessons page (loads live lessons from the server; offline fallback baked in)
- `parent.html` — family dashboard (parent: plan + kids + add-kid)
- `admin.html` — admin / super-admin login + dashboard (plans, chat limits, lesson manager)
- `styles.css` — dark theme
- `admin_config.json` — **private** admin + super-admin credentials (auto-created/auto-filled)
- `data.db` — SQLite database (auto-created; delete it to reset all accounts, lessons & settings)

## Security notes (for production)
This is a solid prototype. Before going live you'd want: HTTPS, rate limiting on login,
real payment integration to actually set Pro/Family, and email verification. Passwords are
already hashed (PBKDF2-SHA256 + per-user salt) and AI access is enforced server-side.
