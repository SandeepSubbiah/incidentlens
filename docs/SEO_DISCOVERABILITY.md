# IncidentLens public presentation and SEO checklist

**Scope:** These improvements make the repository and public-facing static pages more understandable and shareable. They do **not** make a local `http://localhost:5173` application appear in search engines. There is no verified public deployment domain in this repository, so do not invent a canonical URL or sitemap host.

## Already implemented in the showcase PR

- Unique, descriptive HTML titles and `meta name="description"` in the app and capabilities page.
- Open Graph and X/Twitter summary metadata, describing only demonstrated features.
- Static `public/capabilities.html` with actual headings and visible copy, so the main marketing content does not depend on executing JavaScript.
- A visible navigation link from the app to the capabilities page.
- Responsive mobile layout, accessible semantic headings and an honest measured-status section.
- Root README with discovery keywords, status links and evidence.

Google may generate snippets from visible page content instead of using the supplied meta description: https://developers.google.com/search/docs/appearance/snippet

## Before launching a publicly crawlable website

1. **Decide your public URL and hosting first.** The single-process app currently defaults to loopback. Do not expose the incident, source, audit, access or report APIs broadly without an explicit data-classification/security review; a crawler-control file is not access control.
2. Add an absolute `rel="canonical"` for the publicly hosted capabilities page, plus corresponding `og:url`, once a canonical URL is chosen. Avoid pointing these at localhost or a guessed domain.
3. Create a real screenshot or social preview image only after branding is approved; add `og:image` and `twitter:image` when an actual hosted image URL exists.
4. Generate a sitemap using that real host; configure `robots.txt` carefully if needed. Do not use `robots.txt` in place of authentication, and do not use it to choose canonical URLs. https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
5. Submit the public site in Search Console after verifying ownership. Indexing and ranking are never guaranteed.
6. Check structured data only if the information is genuinely present on the page and the schema fits. Do not use fabricated ratings, reviews, usage totals or exaggerated claims.
7. Run Lighthouse accessibility/performance audits on a real deployed URL; evaluate Core Web Vitals under representative usage rather than asserting improvements without measurement.

## GitHub repository About section — owner action

On https://github.com/SandeepSubbiah/incidentlens click the **About** gear.

Suggested description:

> Evidence-first AI incident response on Meta Muse: six-agent investigations, citation checks, governed fixes, self-repair and tested continuity prototypes.

Suggested topics (all lowercase, <=20 total):

`ai-agents`, `incident-response`, `llm`, `meta-muse`, `observability`, `devops`, `sre`, `kubernetes`, `spring-boot`, `ai-security`, `self-healing`, `typescript`

Add a homepage URL only after the public page is hosted. Topics help discovery on GitHub but cannot guarantee search rankings: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics

## Public-language guardrails

- **Correct:** "Real Muse diagnosed five author-written synthetic incidents in the one-run evaluation."
- **Incorrect:** "Proven 100% accurate" or "enterprise-ready for every outage."
- **Correct:** "Provider-neutral router is separately tested but not connected to live requests."
- **Incorrect:** "Zero-downtime production failover has been shipped."
- **Correct:** "Citational evidence is matched to recorded source text."
- **Incorrect:** "Every AI conclusion is factually proven."
- **Correct:** "A modeled Wonder outage triggered real Spark calls."
- **Incorrect:** "Meta went down and IncidentLens prevented all interruption."

Keep the public claims aligned with [FEATURE_STATUS.md](FEATURE_STATUS.md), the [live evaluation](EVALUATION_PROTOCOL.md) and [open security findings](SECURITY_ASSURANCE_FINDINGS.md).

## Submission-day release checks

- [ ] Root README and `/capabilities.html` match verified release evidence.
- [ ] GitHub Actions passed on the commit that would be merged.
- [ ] `npm start` and `npm run demo:offline` retain correct provenance labels.
- [ ] Demo video is recorded; no keys or confidential logs appear.
- [ ] The actual public video URL is included in the submission.
- [ ] Submission confirmation is saved before November 4, 2026, 9 PM ET.
