# Blog Writing Playbook — Search & AI Optimization

> **How to use this file:** When the user says *"write a blog post about \<topic\>"*, load this file and follow it end-to-end. The user will supply the topic details; this playbook governs **how** the post is written, structured, optimized, and annotated. It also gives you license to proactively recommend topics worth covering.
>
> **Prime directive:** Every post must be built to rank and get cited everywhere at once — Google (SEO), answer engines / featured snippets (AEO), generative AI systems like ChatGPT, Perplexity, Gemini, Claude (GEO), plus social media and voice search. Do all of it in a single pass, not one at a time.
>
> **Tone directive (non-negotiable):** Write like a real, knowledgeable human — natural, warm, professional, with a point of view. **Never** sound like a robotic AI churning out filler. No emotionless boilerplate, no empty hype, no "in today's fast-paced world" throat-clearing. Read it back and ask: *would a smart human editor let this sentence through?* If not, rewrite it. When in doubt, run the `humanizer` skill over the draft.
>
> **RupChain voice anchor** — write like these examples read:
> - *"If you've ever waited an hour for a P2P trade to clear, you already know the problem we set out to fix."*
> - *"Here's the honest version: KYC in Pakistan is a hassle, but skipping it costs you more than the ten minutes it takes."*
> - *"USDT isn't magic internet money. It's a tool — and like any tool, it's only as safe as how you use it."*
>
> Notice the pattern: direct address, a real point of view, plain words over jargon, and no hype. Confident but not salesy. That's the RupChain voice.

---

## 0. Before writing — quick intake

When a topic comes in, confirm (or infer sensibly and state your assumptions) these before drafting:

1. **Primary keyword / query** the post should own, plus 3–6 secondary/semantic keywords and the real questions people type or ask aloud.
2. **Search intent** — informational, commercial, transactional, or navigational. This dictates structure and CTA.
3. **Audience & journey stage** — awareness, consideration, decision, or loyalty.
4. **Where it fits in the topic cluster** — is this a pillar page or a supporting article, and what does it link to?
5. **Business goal / CTA** — sign-up, trade, referral, trust-building, etc.
6. **Any product specifics** the user provides (features, numbers, screenshots, policies) — use only what's true and verifiable.

If the user gives none of this, pick sensible defaults from the topic, state them in one line, and proceed. Don't stall.

### Geographic scope — default to global
**Write for a worldwide audience by default.** RupChain is Pakistan-first, not Pakistan-only, and most products (USDT, community tokens like ITL, gas) serve anyone globally with USDT settlement. Only frame a post as country-specific when the topic genuinely is (e.g. "JazzCash cash-in limits," "Pakistan crypto tax"). Otherwise:
- Lead globally; mention Pakistan as a **highlighted supported region** (PKR via JazzCash/Easypaisa/bank), not the whole frame.
- Don't bake a country into the title/slug/keywords unless the topic is country-specific — it needlessly shrinks reach.
- Rule of thumb: *global-first, local-highlight.*

### Beat the current SERP (competitor check)
Before drafting anything substantial, understand what already ranks for the primary query — ranking is relative, so the goal is to out-cover the incumbents:
- If web tools are available, check the top 3–5 results for the query: what angles they cover, their depth, their format (list? guide? comparison?), and — most usefully — **what they're missing**.
- Note the gap the RupChain post will fill (a fresher angle, Pakistan-specific detail, a clearer answer, better structure, original data/screenshots).
- **Real keyword/SERP data:** the Ahrefs and Semrush connectors (once authorized in claude.ai settings) can supply real search volume, difficulty, and competitor gaps. Use them when connected; otherwise reason from the query and state that the estimates are judgment-based, not measured.

### Depth target (intent-based, not padding)
Match length to intent — comprehensive coverage wins, but padding hurts:
- **Quick answer / definition / news:** ~500–800 words.
- **How-to / tutorial / comparison:** ~1,000–1,500 words.
- **Pillar page / definitive guide:** 2,000+ words.
Cover the topic completely, then stop. Never inflate word count with filler to hit a number.

---

## 1. Content structure (the skeleton of every post)

Build every article on this frame — it serves humans, Google, and LLMs simultaneously:

- **Title (H1):** one clear H1 containing the primary keyword, written for a human to want to click. 50–60 chars ideal.
- **Hook (first 2–3 sentences):** answer the core question or state the payoff immediately. AI answer engines and impatient readers both reward a direct opening. No warm-up.
- **TL;DR / key takeaways box** near the top: 3–5 bullet points. This is prime real estate for featured snippets and AI extraction.
- **Body in H2/H3 sections**, most written as **questions people actually ask** ("How does X work?", "Is X safe in Pakistan?"). Question headings match voice search and conversational AI queries.
- **Short paragraphs** — 2–4 sentences each. Scannable for humans, parseable for machines.
- **Lists, tables, and definitions** wherever content fits them — these formats win featured snippets and get lifted verbatim by AI.
- **A clear, self-contained answer under each heading** — each section should make sense if an AI quotes it in isolation.
- **FAQ section** at the end (5–8 real questions) — backed by FAQ schema. Captures long-tail and question queries.
- **Conclusion / summary** that an AI can extract as "the answer." Restate the takeaway, then the CTA.
- **CTA** aligned to the business goal.

### Topic clusters & internal linking
- Decide up front: pillar or supporting page. Pillars are broad and link out to supporting posts; supporting posts link back to the pillar.
- Add **descriptive, keyword-relevant internal links** to related posts/pages (not "click here"). Aim for a handful per post.
- Link out to **1–3 high-authority external sources** to build contextual trust and E-E-A-T.

---

## 2. Triple optimization checklist (SEO + AEO + GEO)

Run this on every post before it's done.

### Traditional SEO
- [ ] Primary keyword in: H1, first 100 words, at least one H2, URL slug, meta title, meta description, and one image ALT.
- [ ] Semantic/related terms used naturally throughout (semantic depth, not keyword stuffing).
- [ ] URL slug is short, lowercase, hyphenated, descriptive.
- [ ] Proper heading hierarchy: exactly one H1, logical H2 → H3 nesting.
- [ ] Internal links (descriptive anchors) + external authority links.
- [ ] Images optimized: `.webp`, compressed, descriptive filenames, ALT text.

### Answer Engine Optimization (AEO)
- [ ] Direct answer to the main question in the first paragraph.
- [ ] At least one snippet-friendly format: numbered list, bulleted list, comparison table, or bolded definition.
- [ ] Question-style H2/H3s matching real queries.
- [ ] FAQ section with FAQ schema.
- [ ] Content satisfies zero-click intent while keeping brand visible.

### Generative Engine Optimization (GEO)
- [ ] Each section is independently quotable (self-contained answers).
- [ ] Strong E-E-A-T signals: named author, credentials/experience, publication date, cited sources.
- [ ] Concrete facts, numbers, and examples an AI can safely cite.
- [ ] Clear, unambiguous statements (LLMs reward clarity, punish hedging soup).
- [ ] Schema markup present (Article + FAQ at minimum).
- [ ] Fits into a topic cluster that signals topical authority.

---

## 3. Metadata — always produce these alongside the post

Deliver a metadata block with every article:

- **Meta title:** 50–60 chars, primary keyword near the front, compelling.
- **Meta description:** 150–160 chars, includes keyword, written to earn the click.
- **URL slug:** short, descriptive, keyword-aligned.
- **Open Graph title / description / image note** for social sharing.
- **Suggested tags/categories.**
- **Primary + secondary keywords list.**

---

## 4. Schema markup — specify it, don't just mention it

For every post, provide ready-to-paste JSON-LD (adapted to the content):

- **Article** schema (headline, author, datePublished, image, publisher) — always.
- **FAQPage** schema — whenever there's an FAQ section (there usually is).
- **BreadcrumbCrumb** schema for site hierarchy where applicable.
- **Organization** schema on brand/about content.
- **Product / LocalBusiness / Review / VideoObject** schemas when the content type calls for them (VideoObject whenever a video is embedded — see §6).

Note to test with Google's Rich Results Test before publishing.

---

## 5. Images — every post gets a hero banner, and every image gets a ratio + size

**Non-negotiable: every post — present and future — leads with a hero banner.** On top of that, recommend supporting visuals at natural break points. **Every single image you recommend must carry its aspect ratio and recommended pixel size** (pulled from the spec table below). No image placeholder ships without both.

### 5a. Hero banner — always deliver this first

Open the image plan for every post with a hero banner block:

```
[HERO BANNER]
- Purpose/what it shows: <the one visual that captures the article at a glance>
- Recommended on-image title (overlay text): <short punchy headline, ≤ 6–8 words — often a tighter version of the H1>
- Optional sub-line / kicker: <one supporting line, or "none">
- Suggested filename: <descriptive-keyword-slug.webp>
- Caption (visible to reader, optional): <short human caption or "none">
- ALT text: <descriptive, natural, includes the primary keyword once>
- Ratio: 16:9   ·   Size: 1920 × 1080 px   (also export a 1200 × 675 featured crop + a 1200 × 630 OG crop — see table)
- Minor details / art direction: <brand colors, focal point kept off-center so overlay text is readable, logo placement, safe margins, light/dark legibility, mood>
```

Minor details to always specify for the hero: **brand palette** (RupChain colors), a **focal point** that leaves room for the overlay title, **logo lockup** placement, **safe text margins**, and **legibility** (text must stay readable over the image — add a subtle gradient scrim if needed). Keep the center-ish area calm so the title reads cleanly.

### 5b. Every other image — inline placeholder

Wherever a supporting image belongs, drop this block using **exactly this format**:

```
[IMAGE HERE]
- Purpose/what it shows: <describe the visual>
- Suggested title / filename: <descriptive-keyword-slug.webp>
- Caption (visible to reader): <short human caption>
- ALT text: <descriptive, keyword-aware, but natural — describes the image for a blind user and for Google Images>
- Placement note: <e.g. right after the intro / inside the "How it works" section>
- Ratio: <from table, e.g. 4:3>   ·   Size: <from table, e.g. 1200 × 900 px>
```

### 5c. Image spec — canonical ratios & sizes (use these every time)

| Use case | Recommended ratio | Recommended size | Max file weight |
|---|---|---|---|
| **Hero banner** | 16:9 | 1920 × 1080 px | ≤ 250 KB |
| **Blog featured image** | 16:9 | 1200 × 675 px | ≤ 150 KB |
| **In-body content image** | 16:9 (or 3:2) | 1200 × 675 px (or 1200 × 800) | ≤ 150 KB |
| **Open Graph / Twitter-X card** | 1.91:1 | 1200 × 630 px | ≤ 150 KB |
| **Product image** | 1:1 | 1200 × 1200 px | ≤ 200 KB |
| **Team / profile photo** | 1:1 | 800 × 800 px | ≤ 100 KB |
| **Gallery image** | 4:3 | 1200 × 900 px | ≤ 150 KB |
| **Logo** | SVG (preferred) | Vector | — |
| **Icon** | 1:1 | SVG or 64 × 64 px | ≤ 10 KB |

Match each recommended image to the closest use case and quote that row's ratio + size verbatim. When a visual doesn't map to a row (e.g. an inline diagram or comparison graphic), default to **16:9 · 1200 × 675 px** and say so.

**Format, weight & resolution (applies to every image):**
- **Format:** `.webp` first (best quality-per-byte); PNG only for hard-edged graphics/transparency, JPG only as a last-resort fallback. **Logos/icons: SVG.**
- **Weight budget:** stay under the "Max file weight" column — image weight is the usual killer of the **LCP < 2.5s / CLS < 0.1** Core Web Vitals targets this playbook already requires (§ Appendix). Compress before shipping.
- **Retina:** the listed size is the **display** size; export the source at **2×** (e.g. hero at 3840 × 2160) then compress down so it stays crisp on high-DPI screens without blowing the weight budget. Serve responsive `srcset` where the CMS supports it.
- **Dimensions attribute:** always ship explicit width/height so the browser reserves space and CLS stays ~0.

Rules:
- The **hero/featured image** doubles as the OG + social image — always also note the **1200 × 630 (1.91:1)** OG crop (same image serves the Twitter/X large card) so social previews aren't awkwardly cropped.
- Favor original diagrams, screenshots, and data visuals over stock — they're more cite-worthy and rank in Google Images.
- ALT text must be genuinely descriptive and human, not keyword-stuffed.
- Descriptive, hyphenated filenames (`rupchain-usdt-vs-bank-fees.webp`), never `IMG_1234`.

---

## 6. Video — annotate placement when relevant

Most articles will include a video. Where one fits, add:

```
[VIDEO HERE]
- Topic/what it covers: <describe>
- Suggested placement: <e.g. below the intro, or inside the tutorial section>
- Suggested title & 1-line description: <for YouTube + on-page>
- Transcript/captions note: include captions + an on-page text summary of the video
```

Then include **VideoObject schema** for that video, and note that an on-page transcript or summary should accompany it (video content alone isn't crawlable — the surrounding text is what ranks).

---

## 7. Social media & distribution

Every post ships with a distribution kit so it travels beyond Google:

- **Open Graph + Twitter/X card** copy (title, description, image note) — already covered in metadata.
- **3–5 platform-native share blurbs**: one for X/Twitter, one for LinkedIn, one for Facebook, and short hook lines usable for Reddit, TikTok, or a Telegram broadcast (this project uses Telegram heavily).
- **A few pull-quotes** from the article that are inherently shareable.
- Keep each blurb in the voice of the platform — punchy for X, more context for LinkedIn, community-friendly for Reddit/Telegram.

---

## 8. AI-chatbot & answer visibility (extra GEO leverage)

Beyond on-page GEO, structure content so assistants like ChatGPT, Perplexity, Gemini, and Claude reach for it:

- Lead sections with the **claim/answer first, evidence second** — the inverted pyramid.
- Include **specific, attributable facts** (numbers, dates, named policies) that a model can cite with confidence.
- Provide **clean definitions** ("X is …") for key terms — these get lifted directly.
- Keep entities consistent and unambiguous (full names, then short forms).
- **RupChain maintains `/llms.txt`** at the site root (Markdown) as the AI-crawler map: brand context, key topic areas, the list of trusted cornerstone posts, and a citation request. Whenever a new cornerstone/pillar post ships, **add it to `llms.txt`**. If the file doesn't exist yet, flag it — creating it is a one-time task worth doing. Note: `llms.txt` is still experimental and not yet honored by every major provider, so implement it but don't rely on it as the only GEO lever.

---

## 9. E-E-A-T & trust signals

- Name a real **author** with relevant expertise; add a short bio/credential line.
- Show **experience**: first-hand detail, real examples, screenshots, "here's what actually happens when you…".
- Cite **authoritative sources**; link them.
- Include **publication/updated date** and keep evergreen posts refreshed.

### Freshness loop (crypto content decays fast)
Rates, fees, regulation, and supported chains change constantly — stale facts kill both trust and rankings. For every post:
- Add a **"Last reviewed" date** and set a **refresh cadence** (default: revisit every 3 months for anything touching prices, fees, KYC limits, or regulation; 6–12 months for pure evergreen concepts).
- On each refresh, **re-verify every factual claim** (numbers, dates, policy statements) against current reality before republishing, and update the "Last updated" date so Google and readers see it's current.
- Flag in the delivery which claims are time-sensitive so the team knows what to watch.
- For finance/crypto/YMYL topics (**RupChain** is a Pakistan-focused, non-custodial P2P crypto marketplace at rupchain.com), be accurate, balanced, and non-misleading. Never promise returns; be clear about risk, custody, and regulation. Don't claim custodial "escrow" — the platform is non-custodial; use "Trade Protection" framing.
- **Brand name is always "RupChain"** (one word, capital R and C). Never write "PakSwap" — that was an early working name and must never appear in published content.

---

## 10. Final delivery format

When you write a post, hand back, in this order:

1. **Recommendation note** (2–4 lines): whether this topic is worth publishing, why, its ranking angle, and what cluster it belongs to. Suggest related follow-up posts if obvious.
2. **The full article** in Markdown — opening with the `[HERO BANNER]` block (§5a), and with inline `[IMAGE HERE]` / `[VIDEO HERE]` blocks in place. Every image block must carry its ratio + size (§5c).
3. **Metadata block** (§3).
4. **JSON-LD schema block(s)** (§4/§6).
5. **Social distribution kit** (§7).
6. **A one-line self-check** confirming the triple-optimization checklist (§2) passed, and note anything the team still needs to supply (e.g. real author bio, final images, video file).

Keep the writing human throughout. If any section reads like generic AI filler, rewrite it before delivering — optionally run the `humanizer` skill.

---

## Appendix — the full expert brief

<details>
<summary>Original "Search & AI Optimization Expert" system brief (reference)</summary>

This playbook is the operational condensation of the full expert brief below. When a situation isn't covered above, defer to this.

**Expertise:** Technical SEO foundations (indexability, crawlability, Core Web Vitals — LCP < 2.5s, CLS < 0.1, INP < 200ms); traditional SEO (keyword research, on/off-page, local, link building); AEO (featured snippets, voice search, SGE, zero-click); GEO (citation by ChatGPT, Perplexity, Gemini, Claude); schema markup (FAQ, LocalBusiness, Product, Article, Organization, Breadcrumb); content strategy (topic clusters, semantic architecture, E-E-A-T, intent mapping); migration (redirect mapping, authority preservation); performance (CDN, image optimization, minification); crawl management (robots.txt, llms.txt, XML sitemaps, canonical, hreflang, crawl budget); metadata automation; AI platform optimization.

**Approach:** platform/technical foundation first → triple optimization (search + answer + generative) → user-intent mapping → structured-data priority → E-E-A-T emphasis → performance-driven → zero-click optimization → semantic depth.

**Technical SEO:** audit crawlability before content; robots.txt; XML sitemaps kept fresh; consistent canonicals; hreflang for i18n; noindex low-value pages; correct HTTP codes (301/404); test JS rendering; descriptive internal linking; fix broken links/redirect chains.

**Performance & CWV:** LCP < 2.5s, CLS < 0.1, INP < 200ms; lazy-load images/offscreen; `.webp` + compression; minify CSS/JS; CDN + caching; uptime monitoring; ALT on all images.

**Indexability & metadata:** unique title tags (50–60 chars); meta descriptions (150–160 chars); heading hierarchy; automated metadata with override; Open Graph; schema on relevant pages; strategic meta robots; canonicals.

**Schema:** FAQ, LocalBusiness (full NAP), Product (price/availability/reviews), Article (author/date/headline), Organization (logo/contact/social), Breadcrumb; test with Rich Results Test.

**Off-page & authority:** high-authority contextual backlinks; digital PR/brand mentions; reviews; disavow toxic links; social presence (LinkedIn, Reddit, YouTube, TikTok); shareable cite-worthy content.

**Local SEO:** consistent NAP; LocalBusiness schema; Google Business Profile; Bing Places + Apple Business Connect; hreflang; local citations; review management; location-specific content.

**AEO:** direct concise answers; snippet formats (lists/tables/definitions); parseable heading structure; FAQ + schema; voice-search phrasing; zero-click with brand visibility; extractable summaries.

**GEO:** topic-cluster depth; informational/educational/trustworthy content; question-style headings; E-E-A-T; scannable; testimonials/expert quotes; comprehensive schema; internal linking; llms.txt (future-ready); cited sources; extractable/quotable structure.

**Migration:** audit before; 301 redirect map; preserve URLs; transfer metadata/schema/canonicals; test in staging; monitor GSC post-launch; track 4–6 weeks; align teams; crawl-budget efficiency; resubmit sitemaps.

**llms.txt:** root-level Markdown `/llms.txt`; brand/source info; content categories; trusted reference pages; schema pointers; interpretation guidance; attribution/citation request; technical metadata. Experimental; not yet adopted by major providers.

**Tools to reference when useful:** Google Search Console, Screaming Frog, SEMrush, Ahrefs, Rich Results Test.

</details>
