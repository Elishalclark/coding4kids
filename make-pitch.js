const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_16x9";
pres.author = "Elisha Clark";
pres.title = "KidVibers Sales Pitch";

// ── Brand colors ──────────────────────────────────────────────
const BG       = "0f0820";   // deep dark purple
const BG2      = "1a0a2e";   // slightly lighter purple
const PURPLE   = "7c3aed";
const PINK     = "db2777";
const PURPLE_L = "a78bfa";
const PINK_L   = "f472b6";
const WHITE    = "FFFFFF";
const DIM      = "c4b5fd";   // muted lavender
const GOLD     = "fbbf24";
const GREEN    = "34d399";
const CARD_BG  = "1e1040";   // card background
const CARD_BD  = "3b1f6e";   // card border (unused in pptxgenjs shapes directly)

const makeShadow = () => ({ type: "outer", color: "000000", blur: 8, offset: 3, angle: 45, opacity: 0.35 });

// Helper: gradient-feel slide background (deep purple to slightly lighter)
function bgSlide() {
  const slide = pres.addSlide();
  slide.background = { color: BG };
  return slide;
}

// Helper: rounded card
function card(slide, x, y, w, h, fillColor, shadow) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h,
    fill: { color: fillColor || CARD_BG },
    line: { color: "3b1f6e", width: 1 },
    rectRadius: 0.12,
    shadow: shadow !== false ? makeShadow() : undefined,
  });
}

// Helper: section title bar (just text, no stripe)
function slideTitle(slide, text, y) {
  slide.addText(text, {
    x: 0.45, y: y !== undefined ? y : 0.28,
    w: 9.1, h: 0.65,
    fontSize: 30, bold: true, color: WHITE, fontFace: "Calibri",
    margin: 0,
  });
}

// Helper: small accent label
function label(slide, text, x, y, w, color) {
  slide.addText(text, {
    x, y, w: w || 2, h: 0.3,
    fontSize: 10, bold: true, color: color || PURPLE_L,
    fontFace: "Calibri", charSpacing: 2, margin: 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 1 — TITLE
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();

  // Big rocket emoji circle
  card(s, 3.8, 0.35, 2.4, 2.0, "1e0a40");
  s.addText("🚀", { x: 3.8, y: 0.35, w: 2.4, h: 2.0, fontSize: 72, align: "center", valign: "middle", margin: 0 });

  // Title
  s.addText("KidVibers", {
    x: 0.5, y: 2.42, w: 9, h: 1.1,
    fontSize: 64, bold: true, color: WHITE, fontFace: "Calibri", align: "center", margin: 0,
  });

  // Pink subtitle
  s.addText("The Duolingo of coding — built for kids", {
    x: 0.5, y: 3.52, w: 9, h: 0.55,
    fontSize: 22, color: PINK_L, fontFace: "Calibri", align: "center", margin: 0,
  });

  // Tagline pills row
  const pills = ["152 lessons", "16 worlds", "1 AI buddy", "100% ad-free"];
  const pw = 2.0, gap = 0.15, startX = (10 - (pw * 4 + gap * 3)) / 2;
  pills.forEach((p, i) => {
    const x = startX + i * (pw + gap);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y: 4.22, w: pw, h: 0.42,
      fill: { color: PURPLE }, line: { color: PURPLE_L, width: 1 }, rectRadius: 0.21,
    });
    s.addText(p, { x, y: 4.22, w: pw, h: 0.42, fontSize: 12, bold: true, color: WHITE, fontFace: "Calibri", align: "center", valign: "middle", margin: 0 });
  });

  // Website
  s.addText("kidvibers.com", {
    x: 0.5, y: 4.9, w: 9, h: 0.35,
    fontSize: 14, color: DIM, fontFace: "Calibri", align: "center", italic: true, margin: 0,
  });

  s.addNotes("Hi everyone, I'm Elisha Clark, the founder of KidVibers. I built this platform because I wanted a way for kids to learn coding that actually feels fun — not like homework. Today I want to show you what we've built and how it could help kids in Arlington.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 2 — THE PROBLEM
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "The Problem with Coding for Kids");

  // Big stat callout (center, subtle card)
  card(s, 2.5, 0.98, 5.0, 0.9, "2d0a50");
  s.addText('"Most kids quit coding apps within 2 weeks"', {
    x: 2.5, y: 0.98, w: 5.0, h: 0.9,
    fontSize: 15, bold: true, color: GOLD, fontFace: "Calibri", align: "center", valign: "middle", italic: true, margin: 0,
  });

  // Left column problems
  const leftProbs = [
    "Lessons feel boring or too school-like",
    "Coding concepts are confusing and overwhelming",
    "Apps move too fast or too slow",
  ];
  const rightProbs = [
    "Too much reading, not enough doing",
    "Kids lose motivation fast",
    "Popular apps cost $100+/yr or hide content behind paywalls",
  ];

  card(s, 0.3, 2.0, 4.5, 2.85, CARD_BG);
  card(s, 5.2, 2.0, 4.5, 2.85, CARD_BG);

  s.addText("😩 Why kids give up", { x: 0.3, y: 2.05, w: 4.5, h: 0.38, fontSize: 13, bold: true, color: PINK_L, fontFace: "Calibri", align: "center", margin: 0 });
  s.addText("💸 The money problem", { x: 5.2, y: 2.05, w: 4.5, h: 0.38, fontSize: 13, bold: true, color: PINK_L, fontFace: "Calibri", align: "center", margin: 0 });

  s.addText(leftProbs.map(t => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } })).concat([{ text: "" }]), {
    x: 0.55, y: 2.48, w: 4.2, h: 2.28, fontSize: 13, color: DIM, fontFace: "Calibri", margin: 0,
  });
  s.addText(rightProbs.map(t => ({ text: t, options: { bullet: true, breakLine: true, paraSpaceAfter: 8 } })).concat([{ text: "" }]), {
    x: 5.45, y: 2.48, w: 4.2, h: 2.28, fontSize: 13, color: DIM, fontFace: "Calibri", margin: 0,
  });

  s.addNotes("Most coding apps for kids have the same core issues: they're either too boring, too expensive, or not engaging enough. Kids lose interest fast when they can't see progress or feel like they're just doing more schoolwork.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 3 — WHAT KIDS ACTUALLY WANT
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "What Kids Actually Want");

  const items = [
    { emoji: "🎮", title: "Games", desc: "Not textbooks or videos — kids want to play and create" },
    { emoji: "🏆", title: "Rewards", desc: "XP, badges, streaks — they keep coming back for more" },
    { emoji: "🎨", title: "Creativity", desc: "Build real things fast and show them off" },
    { emoji: "⚡", title: "Quick progress", desc: "Feel accomplished every single session" },
    { emoji: "🤝", title: "Beginner-friendly", desc: "No jargon, no confusion — just clarity and fun" },
  ];

  const cw = 1.8, ch = 3.5, gap = 0.1, startX = (10 - (cw * 5 + gap * 4)) / 2;

  items.forEach((item, i) => {
    const x = startX + i * (cw + gap);
    card(s, x, 1.05, cw, ch, CARD_BG);
    s.addText(item.emoji, { x, y: 1.2, w: cw, h: 0.9, fontSize: 40, align: "center", margin: 0 });
    s.addText(item.title, { x, y: 2.2, w: cw, h: 0.45, fontSize: 13, bold: true, color: WHITE, fontFace: "Calibri", align: "center", margin: 0 });
    s.addText(item.desc, { x: x + 0.08, y: 2.7, w: cw - 0.16, h: 1.75, fontSize: 11, color: DIM, fontFace: "Calibri", align: "center", margin: 0 });
  });

  s.addNotes("When we talk to kids about what they want, it's consistent: they want it to feel like a game, they want to earn rewards, and they want to build cool stuff fast. KidVibers is designed from the ground up around exactly these things.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 4 — INTRODUCING KIDVIBERS
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "Introducing KidVibers");

  // Hero tagline
  s.addText("Coding that feels like a game — because it is", {
    x: 0.5, y: 0.95, w: 9, h: 0.65,
    fontSize: 22, bold: true, color: PURPLE_L, fontFace: "Calibri", align: "center", italic: true, margin: 0,
  });

  const features = [
    { emoji: "📚", text: "152 interactive lessons across 16 themed worlds" },
    { emoji: "🎮", text: "Boss battles, XP, streaks, tokens & avatar shop" },
    { emoji: "🤖", text: 'AI buddy "Byte" — gives hints, not answers' },
    { emoji: "🛡️", text: "100% ad-free · No toxic chat · Mandatory parent consent" },
  ];

  const fw = 4.5, fh = 1.05, fgap = 0.12;
  const positions = [
    [0.25, 1.72], [5.25, 1.72],
    [0.25, 2.88], [5.25, 2.88],
  ];

  features.forEach((f, i) => {
    const [x, y] = positions[i];
    card(s, x, y, fw, fh, CARD_BG);
    s.addText(f.emoji, { x: x + 0.1, y, w: 0.8, h: fh, fontSize: 26, valign: "middle", margin: 0 });
    s.addText(f.text, { x: x + 0.92, y: y + 0.1, w: fw - 1.05, h: fh - 0.2, fontSize: 13, color: WHITE, fontFace: "Calibri", valign: "middle", margin: 0 });
  });

  // Bottom website
  card(s, 2.5, 4.1, 5.0, 0.62, "1e0a40");
  s.addText("🌐  kidvibers.com", {
    x: 2.5, y: 4.1, w: 5.0, h: 0.62,
    fontSize: 16, bold: true, color: PURPLE_L, fontFace: "Calibri", align: "center", valign: "middle", margin: 0,
  });

  s.addNotes("KidVibers has 152 real lessons across 16 themed worlds. Kids earn XP, collect tokens, beat boss battles, and build real projects. There's an AI buddy named Byte who gives hints — not answers — so kids actually learn. And there are zero ads, ever.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 5 — HOW IT WORKS
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "How KidVibers Works");

  const steps = [
    { emoji: "🌱", num: "01", title: "START", bullets: ["Pick your world", "Complete bite-sized lessons", "Run real code instantly"] },
    { emoji: "⚡", num: "02", title: "LEVEL UP", bullets: ["Earn XP & tokens", "Beat boss battles", "Unlock new worlds"] },
    { emoji: "🏗️", num: "03", title: "BUILD", bullets: ["Make games & websites", "Build AI chatbots", "Create animations"] },
  ];

  const sw = 2.9, sh = 3.4, sgap = 0.35, startX = (10 - sw * 3 - sgap * 2) / 2;

  steps.forEach((step, i) => {
    const x = startX + i * (sw + sgap);

    // Arrow between cards
    if (i > 0) {
      s.addText("→", { x: x - sgap - 0.02, y: 1.85, w: sgap + 0.04, h: 0.5, fontSize: 22, color: PURPLE_L, fontFace: "Calibri", align: "center", margin: 0 });
    }

    card(s, x, 1.05, sw, sh, CARD_BG);

    // Number badge
    s.addShape(pres.shapes.OVAL, { x: x + sw / 2 - 0.3, y: 1.1, w: 0.6, h: 0.6, fill: { color: PURPLE }, line: { color: PURPLE_L, width: 1 } });
    s.addText(step.num, { x: x + sw / 2 - 0.3, y: 1.1, w: 0.6, h: 0.6, fontSize: 11, bold: true, color: WHITE, fontFace: "Calibri", align: "center", valign: "middle", margin: 0 });

    s.addText(step.emoji, { x, y: 1.75, w: sw, h: 0.75, fontSize: 34, align: "center", margin: 0 });
    s.addText(step.title, { x, y: 2.52, w: sw, h: 0.42, fontSize: 14, bold: true, color: PINK_L, fontFace: "Calibri", align: "center", charSpacing: 2, margin: 0 });
    s.addText(step.bullets.map((b, bi) => ({ text: b, options: { bullet: true, breakLine: bi < step.bullets.length - 1, paraSpaceAfter: 6 } })), {
      x: x + 0.15, y: 2.98, w: sw - 0.3, h: 1.35, fontSize: 12, color: DIM, fontFace: "Calibri", margin: 0,
    });
  });

  // Bottom note
  s.addText("Kids learn Python AND JavaScript — two real, in-demand languages", {
    x: 0.5, y: 4.62, w: 9, h: 0.38,
    fontSize: 12, color: GOLD, fontFace: "Calibri", align: "center", italic: true, bold: true, margin: 0,
  });

  s.addNotes("The learning loop is simple: start a world, do short lessons with real code, earn XP and tokens, then beat the boss battle at the end of the world to unlock the next one. Along the way, kids build real things in the Playground.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 6 — 16 WORLDS
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "16 Themed Worlds to Explore");

  const worlds = [
    "🌱 Greenwood Basics", "🌊 Builder's Bay",
    "🚀 Cosmic Code Station", "🏰 Algorithm Castle",
    "🎮 Game Arcade", "🌐 Web Wizard Woods",
    "⚡ JavaScript Junction", "🤖 AI Island",
    "🔢 Math Mountain", "🏆 Master's Summit",
    "🛠️ Function Forge", "🥋 Data Structures Dojo",
    "🪐 Object Orbit", "⛰️ Pro Coder Peak",
    "🔆 Spark Lab", "🏔️ Capstone Quests",
  ];

  // 4 columns x 4 rows grid
  const cols = 4, rows = 4;
  const cw = 2.2, ch = 0.7, hgap = 0.12, vgap = 0.1;
  const gridW = cols * cw + (cols - 1) * hgap;
  const startX = (10 - gridW) / 2;
  const startY = 1.05;

  worlds.forEach((w, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = startX + col * (cw + hgap);
    const y = startY + row * (ch + vgap);
    // Alternate purple/pink tint
    const fill = (row + col) % 2 === 0 ? CARD_BG : "1a0838";
    card(s, x, y, cw, ch, fill, false);
    s.addText(w, { x: x + 0.08, y, w: cw - 0.12, h: ch, fontSize: 11.5, bold: true, color: WHITE, fontFace: "Calibri", valign: "middle", margin: 0 });
  });

  // Boss battle note
  card(s, 0.5, 4.95, 9.0, 0.45, "2d0a50", false);
  s.addText("⚔️  Every world ends with a boss battle — kids prove what they learned before leveling up", {
    x: 0.5, y: 4.95, w: 9.0, h: 0.45,
    fontSize: 12, bold: true, color: GOLD, fontFace: "Calibri", align: "center", valign: "middle", margin: 0,
  });

  s.addNotes("152 lessons spread across 16 worlds — that's months of content. Kids start with the basics and work all the way up to object-oriented programming, data structures, and even AI concepts. Each world has a theme and a boss battle at the end.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 7 — COMPETITIVE ANALYSIS
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "How We Compare");

  const headers = ["App", "Age fit", "Game-like", "Real code", "AI buddy", "Ad-free", "Price"];
  const rows = [
    ["KidVibers ✓", "6–16", "★★★★★", "Python + JS", "✓ Byte", "✓ Always", "Free to start"],
    ["Scratch", "8–16", "★★★", "Blocks only", "✗", "✓", "Free"],
    ["Mimo", "14+", "★★★", "Yes", "✗", "✗", "$9.99/mo"],
    ["Tynker", "7–18", "★★★★", "Limited", "✗", "✗", "$15/mo"],
    ["Sololearn", "14+", "★★", "Yes", "✗", "✗", "$6.99/mo"],
  ];

  const colWidths = [1.75, 0.85, 1.1, 1.15, 1.0, 0.95, 1.2];
  const tableData = [
    headers.map((h, ci) => ({
      text: h,
      options: { bold: true, color: WHITE, fill: { color: PURPLE }, fontSize: 11, fontFace: "Calibri", align: "center" },
    })),
    ...rows.map((row, ri) => row.map((cell, ci) => ({
      text: cell,
      options: {
        bold: ri === 0,
        color: ri === 0 ? WHITE : (cell === "✗" ? "f87171" : (cell.startsWith("✓") || cell.startsWith("★★★★★") ? GREEN : (ri === 0 ? WHITE : DIM))),
        fill: { color: ri === 0 ? "2d0a50" : (ri % 2 === 0 ? CARD_BG : "16082a") },
        fontSize: ri === 0 ? 12 : 11,
        fontFace: "Calibri",
        align: "center",
      },
    }))),
  ];

  s.addTable(tableData, {
    x: 0.25, y: 1.05, w: 9.5, h: 3.5,
    colW: colWidths,
    border: { pt: 0.5, color: "3b1f6e" },
    rowH: [0.52, 0.62, 0.52, 0.52, 0.52, 0.52],
  });

  card(s, 0.5, 4.72, 9.0, 0.62, "2d0a50", false);
  s.addText('🎯  Market gap: "A Duolingo-style coding app for ages 6–16." KidVibers fills it.', {
    x: 0.5, y: 4.72, w: 9.0, h: 0.62,
    fontSize: 13, bold: true, color: GOLD, fontFace: "Calibri", align: "center", valign: "middle", italic: true, margin: 0,
  });

  s.addNotes("No other app combines real programming languages, a full game loop with XP and boss battles, a built-in AI buddy, AND stays ad-free and safe for kids ages 6-16. KidVibers is the only app that hits all of these.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 8 — BUILT FOR LIBRARIES & SCHOOLS
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "Perfect for Libraries & Schools");

  const libItems = [
    { emoji: "🏫", text: "Class code system — kids join in seconds" },
    { emoji: "👀", text: "Teacher dashboard — see every student's progress" },
    { emoji: "🔒", text: "Safe by design — no ads, no DMs, no toxic chat" },
    { emoji: "📋", text: "Mandatory parental consent for every student" },
    { emoji: "🎓", text: "152 lessons = months of programming content" },
  ];
  const stuItems = [
    { emoji: "🆓", text: "Free to start — no credit card needed" },
    { emoji: "⭐", text: "First students get 30 days of Pro free" },
    { emoji: "📱", text: "Works on any device — phone, tablet, laptop" },
    { emoji: "🐍", text: "Real Python & JavaScript — college-ready skills" },
    { emoji: "🏆", text: "Certificates when they complete worlds" },
  ];

  const colW = 4.45, startY = 1.1, itemH = 0.56;

  // Column headers
  s.addText("For Libraries & Teachers", { x: 0.25, y: startY, w: colW, h: 0.4, fontSize: 13, bold: true, color: PURPLE_L, fontFace: "Calibri", align: "center", margin: 0 });
  s.addText("For Students", { x: 5.3, y: startY, w: colW, h: 0.4, fontSize: 13, bold: true, color: PINK_L, fontFace: "Calibri", align: "center", margin: 0 });

  libItems.forEach((item, i) => {
    const y = startY + 0.45 + i * itemH;
    card(s, 0.25, y, colW, itemH - 0.06, CARD_BG, false);
    s.addText(item.emoji, { x: 0.3, y, w: 0.55, h: itemH - 0.06, fontSize: 18, valign: "middle", margin: 0 });
    s.addText(item.text, { x: 0.88, y: y + 0.04, w: colW - 0.72, h: itemH - 0.15, fontSize: 12, color: WHITE, fontFace: "Calibri", valign: "middle", margin: 0 });
  });

  stuItems.forEach((item, i) => {
    const y = startY + 0.45 + i * itemH;
    card(s, 5.3, y, colW, itemH - 0.06, CARD_BG, false);
    s.addText(item.emoji, { x: 5.35, y, w: 0.55, h: itemH - 0.06, fontSize: 18, valign: "middle", margin: 0 });
    s.addText(item.text, { x: 5.93, y: y + 0.04, w: colW - 0.72, h: itemH - 0.15, fontSize: 12, color: WHITE, fontFace: "Calibri", valign: "middle", margin: 0 });
  });

  // CTA bottom
  card(s, 0.5, 4.93, 9.0, 0.45, "2d0a50", false);
  s.addText("✨  Demo accounts ready — try it right now at kidvibers.com", {
    x: 0.5, y: 4.93, w: 9.0, h: 0.45,
    fontSize: 12, bold: true, color: GOLD, fontFace: "Calibri", align: "center", valign: "middle", margin: 0,
  });

  s.addNotes("For libraries specifically, KidVibers works great as a drop-in coding program. Kids get a class code to join, you can track progress from a teacher dashboard, and every kid needs parental consent before they can access anything.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 9 — SAFETY & TRUST
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "Safety First — Always");

  const pillars = [
    { emoji: "🛡️", title: "COPPA-minded", desc: "Parental consent required for EVERY kid before they can play — not just under-13" },
    { emoji: "🚫", title: "Zero ads. Ever.", desc: "No behavioral tracking, no data selling, no advertising. Period." },
    { emoji: "💬", title: "No private messaging", desc: "All community interaction happens in the open and is moderated by our team" },
    { emoji: "🔒", title: "Enterprise security", desc: "HTTPS everywhere, hashed passwords, rate limiting, strict Content Security Policy" },
  ];

  const pw = 4.45, ph = 2.0, hgap = 0.1, vgap = 0.15;
  const positions = [[0.25, 1.08], [5.3, 1.08], [0.25, 3.12], [5.3, 3.12]];

  pillars.forEach((p, i) => {
    const [x, y] = positions[i];
    card(s, x, y, pw, ph, CARD_BG);
    s.addText(p.emoji, { x: x + 0.15, y: y + 0.2, w: 0.75, h: 0.75, fontSize: 32, margin: 0 });
    s.addText(p.title, { x: x + 0.9, y: y + 0.2, w: pw - 1.05, h: 0.45, fontSize: 14, bold: true, color: WHITE, fontFace: "Calibri", valign: "middle", margin: 0 });
    s.addText(p.desc, { x: x + 0.15, y: y + 0.72, w: pw - 0.3, h: 1.15, fontSize: 12, color: DIM, fontFace: "Calibri", margin: 0 });
  });

  s.addNotes("Safety is non-negotiable. Every single kid account requires a parent or guardian to approve it before the child can do anything. There are no ads, ever. And there's no private messaging between users — everything is public and moderated. Full details at kidvibers.com/trust");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 10 — PRICING
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "Simple, Honest Pricing");

  const plans = [
    {
      name: "FREE", price: "$0", period: "forever",
      color: "22c55e", lightColor: "86efac",
      items: ["Starter lessons", "Playground", "Community gallery", "Avatar customization"],
    },
    {
      name: "PRO", price: "$4.99", period: "/month",
      color: PURPLE, lightColor: PURPLE_L,
      items: ["Everything in Free", "All 152 lessons", "AI buddy Byte", "Unlimited daily lessons", "Boss battles & certificates"],
      highlight: true,
    },
    {
      name: "LIBRARY / SCHOOL", price: "Custom", period: "",
      color: "0891b2", lightColor: "67e8f9",
      items: ["Bulk student seats", "Teacher dashboard", "District branding", "Onboarding support"],
    },
  ];

  const pw = 2.9, ph = 3.55, pgap = 0.18, startX = (10 - pw * 3 - pgap * 2) / 2;

  plans.forEach((plan, i) => {
    const x = startX + i * (pw + pgap);
    const y = 1.0;

    // Card — highlight PRO with brighter border
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
      x, y, w: pw, h: ph,
      fill: { color: plan.highlight ? "1e0a40" : CARD_BG },
      line: { color: plan.color, width: plan.highlight ? 2 : 1 },
      rectRadius: 0.14,
      shadow: makeShadow(),
    });

    // Plan name
    s.addText(plan.name, { x, y: y + 0.15, w: pw, h: 0.4, fontSize: 13, bold: true, color: plan.lightColor, fontFace: "Calibri", align: "center", charSpacing: 1, margin: 0 });

    // Price
    s.addText(plan.price, { x, y: y + 0.55, w: pw, h: 0.7, fontSize: 34, bold: true, color: WHITE, fontFace: "Calibri", align: "center", margin: 0 });
    if (plan.period) s.addText(plan.period, { x, y: y + 1.22, w: pw, h: 0.28, fontSize: 12, color: DIM, fontFace: "Calibri", align: "center", margin: 0 });

    // Divider line
    s.addShape(pres.shapes.LINE, { x: x + 0.2, y: y + 1.55, w: pw - 0.4, h: 0, line: { color: plan.color, width: 1 } });

    // Feature list
    s.addText(plan.items.map((t, ti) => ({ text: t, options: { bullet: true, breakLine: ti < plan.items.length - 1, paraSpaceAfter: 5 } })), {
      x: x + 0.15, y: y + 1.65, w: pw - 0.3, h: 1.75, fontSize: 11, color: DIM, fontFace: "Calibri", margin: 0,
    });
  });

  // Launch offer callout
  card(s, 0.4, 4.62, 9.2, 0.58, "2d0a50", false);
  s.addText("🎁  Launch offer: First 100 students get 30 days of Pro FREE  ·  Paid plans not yet charging — everyone gets Pro free while we finish setup", {
    x: 0.4, y: 4.62, w: 9.2, h: 0.58,
    fontSize: 11, bold: true, color: GOLD, fontFace: "Calibri", align: "center", valign: "middle", margin: 0,
  });

  s.addNotes("Pricing is straightforward. Free forever for starters, $4.99/month for Pro which unlocks everything. For libraries and schools we do custom bulk pricing. Right now, paid plans aren't actually charging yet — so everyone gets Pro features for free while we finish setup.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 11 — DEMO TIME
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();
  slideTitle(s, "Let's Try It Live 🚀");

  const steps = [
    { n: "1", text: "Open your browser and go to", highlight: "kidvibers.com" },
    { n: "2", text: "Kid demo login →  username:", highlight: "demokid", after: "  /  password:", after2: "kidvibers1" },
    { n: "3", text: "Library demo →  username:", highlight: "arlington", after: "  /  password:", after2: "library1" },
  ];

  steps.forEach((step, i) => {
    const y = 1.2 + i * 1.1;
    // Number circle
    s.addShape(pres.shapes.OVAL, { x: 0.3, y: y + 0.1, w: 0.6, h: 0.6, fill: { color: PURPLE }, line: { color: PURPLE_L, width: 1 } });
    s.addText(step.n, { x: 0.3, y: y + 0.1, w: 0.6, h: 0.6, fontSize: 16, bold: true, color: WHITE, fontFace: "Calibri", align: "center", valign: "middle", margin: 0 });

    card(s, 1.1, y, 8.6, 0.8, CARD_BG, false);

    if (step.highlight && !step.after) {
      // Simple: text + URL
      s.addText([
        { text: step.text + "  ", options: { color: DIM, fontSize: 15 } },
        { text: step.highlight, options: { color: PURPLE_L, bold: true, fontSize: 15 } },
      ], { x: 1.2, y: y + 0.08, w: 8.4, h: 0.65, fontFace: "Calibri", valign: "middle", margin: 0 });
    } else if (step.after) {
      s.addText([
        { text: step.text, options: { color: DIM, fontSize: 13 } },
        { text: " " + step.highlight, options: { color: GREEN, bold: true, fontSize: 13 } },
        { text: step.after, options: { color: DIM, fontSize: 13 } },
        { text: " " + step.after2, options: { color: GOLD, bold: true, fontSize: 13 } },
      ], { x: 1.2, y: y + 0.08, w: 8.4, h: 0.65, fontFace: "Calibri", valign: "middle", margin: 0 });
    }
  });

  // CTA
  card(s, 0.5, 3.68, 9.0, 0.68, "1e0a40");
  s.addText("See a real lesson  ·  Try the Playground  ·  Explore the dashboard", {
    x: 0.5, y: 3.68, w: 9.0, h: 0.68,
    fontSize: 15, bold: true, color: PURPLE_L, fontFace: "Calibri", align: "center", valign: "middle", italic: true, margin: 0,
  });

  s.addText("152 lessons ready right now — no setup, no download, works on any device", {
    x: 0.5, y: 4.5, w: 9.0, h: 0.38,
    fontSize: 12, color: DIM, fontFace: "Calibri", align: "center", italic: true, margin: 0,
  });

  s.addNotes("Now let's see it live. Go to kidvibers.com. Log in as demokid / kidvibers1 to see the full kid experience — lessons, the playground, boss battles, avatar. Then log in as arlington / library1 to see the teacher/library dashboard.");
}

// ═══════════════════════════════════════════════════════════════
// SLIDE 12 — THE ASK / CLOSING
// ═══════════════════════════════════════════════════════════════
{
  const s = bgSlide();

  // Rocket hero top
  s.addText("🚀", { x: 4.25, y: 0.15, w: 1.5, h: 1.1, fontSize: 52, align: "center", margin: 0 });

  s.addText("Let's Bring Coding to Arlington Kids", {
    x: 0.4, y: 1.22, w: 9.2, h: 0.72,
    fontSize: 30, bold: true, color: WHITE, fontFace: "Calibri", align: "center", margin: 0,
  });

  // Three ask items
  const asks = [
    { emoji: "🤝", text: "Partner with Arlington Public Library to offer KidVibers to members" },
    { emoji: "🆓", text: "Pilot program: free Pro access for library card holders" },
    { emoji: "💡", text: "Share feedback to help us build the best kids coding platform" },
  ];

  asks.forEach((ask, i) => {
    const y = 2.08 + i * 0.64;
    card(s, 0.5, y, 9.0, 0.55, CARD_BG, false);
    s.addText(ask.emoji, { x: 0.6, y, w: 0.6, h: 0.55, fontSize: 20, valign: "middle", margin: 0 });
    s.addText(ask.text, { x: 1.25, y: y + 0.06, w: 8.1, h: 0.44, fontSize: 13, color: WHITE, fontFace: "Calibri", valign: "middle", margin: 0 });
  });

  // Contact
  card(s, 1.2, 4.05, 7.6, 0.95, "1e0a40");
  s.addText([
    { text: "Elisha Clark — Founder, KidVibers\n", options: { bold: true, fontSize: 13, color: WHITE } },
    { text: "📧 support@kidvibers.com   ·   🌐 kidvibers.com", options: { fontSize: 12, color: PURPLE_L } },
  ], { x: 1.2, y: 4.05, w: 7.6, h: 0.95, fontFace: "Calibri", align: "center", valign: "middle", margin: 0 });

  // Closing line
  s.addText('"Every kid deserves to learn to code. Let\'s make that happen — together."', {
    x: 0.4, y: 5.08, w: 9.2, h: 0.42,
    fontSize: 13, bold: true, color: PINK_L, fontFace: "Calibri", align: "center", italic: true, margin: 0,
  });

  s.addNotes("My ask is simple: let's partner to bring coding to Arlington kids. We can offer free Pro access to library card holders as a pilot program. I'm here to make this work, and I'd love your feedback to keep making KidVibers better. Thank you.");
}

// ── Write & rezip ─────────────────────────────────────────────
const outPath = "/Users/elishaclark/coding4kids.com/KidVibers-Pitch.pptx";
pres.writeFile({ fileName: outPath }).then(() => {
  console.log("✅ Written:", outPath);
}).catch(e => { console.error("Error:", e); process.exit(1); });
