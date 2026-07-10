'use strict';

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const axios      = require('axios');
const cheerio    = require('cheerio');
const { Pool }  = require('pg');
require('dotenv').config();

// Dev DB doesn't support SSL; prod (Replit deployment) requires it
const pool = new Pool(
  process.env.REPLIT_DEPLOYMENT ? { ssl: { rejectUnauthorized: false } } : {}
);

// ─────────────────────────────────────────────────────────────
// Schema bootstrap — idempotent, safe to re-run on every start
// ─────────────────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS screening_runs (
    id            SERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    company_count INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS screened_companies (
    id                  SERIAL PRIMARY KEY,
    run_id              INTEGER REFERENCES screening_runs(id) ON DELETE CASCADE,
    company_name        TEXT,
    screened_at         TIMESTAMPTZ DEFAULT NOW(),
    status              TEXT,
    excluded_at         TEXT,
    excluded_reason     TEXT,
    inconclusive_reason TEXT,
    result_json         JSONB
  );
  CREATE INDEX IF NOT EXISTS idx_sc_run_id ON screened_companies(run_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_run_company ON screened_companies(run_id, company_name);
  CREATE TABLE IF NOT EXISTS screened_assets (
    id              SERIAL PRIMARY KEY,
    company_id      INTEGER REFERENCES screened_companies(id) ON DELETE CASCADE,
    asset_name      TEXT,
    modality        TEXT,
    pathway         TEXT,
    indication      TEXT,
    is_platform     BOOLEAN DEFAULT false,
    screen_decision TEXT,
    excluded_layer  TEXT,
    excluded_reason TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_sa_company_id ON screened_assets(company_id);
`).catch(e => console.error('[db init]', e.message));

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

/**
 * For a single asset, determine whether it screens in or out and which
 * layer caused the exclusion. Checks layers 1-4 (from Claude) then
 * layer5 (direct-competitor, computed from BEONE_PIPELINE).
 */
function assetScreenDecision(asset) {
  for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
    if (asset[layer] && asset[layer].status === 'fail') {
      return { decision: 'screen_out', layer, reason: asset[layer].reason || '' };
    }
  }
  if (asset.layer5 && asset.layer5.status === 'fail') {
    return { decision: 'screen_out', layer: 'layer5', reason: asset.layer5.reason || '' };
  }
  if (asset.overallStatus === 'excluded') {
    // Catch-all: Claude marked it excluded but no individual layer logged a fail
    return { decision: 'screen_out', layer: null, reason: '' };
  }
  return { decision: 'screen_in', layer: null, reason: '' };
}

/**
 * Insert one screened_companies row (with RETURNING id) then, for each
 * asset that Claude returned, insert a screened_assets row.
 *
 * Company-level exclusions (pre-filter / layer1 / layer4) often have no
 * assets in the result — in that case the assets loop is a no-op and the
 * company-level excluded_at column captures the reason.
 */
async function saveCompanyToDb(runId, result) {
  try {
    const companyRow = await pool.query(
      `INSERT INTO screened_companies
         (run_id, company_name, screened_at, status, excluded_at, excluded_reason, inconclusive_reason, result_json)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7)
       ON CONFLICT (run_id, company_name) DO UPDATE SET
         screened_at         = NOW(),
         status              = EXCLUDED.status,
         excluded_at         = EXCLUDED.excluded_at,
         excluded_reason     = EXCLUDED.excluded_reason,
         inconclusive_reason = EXCLUDED.inconclusive_reason,
         result_json         = EXCLUDED.result_json
       RETURNING id`,
      [
        runId,
        result.name,
        result.status,
        result.excludedAt        || null,
        result.excludedReason    || null,
        result.inconclusiveReason|| null,
        result,
      ]
    );
    const companyId = companyRow.rows[0].id;

    // Clear old assets before re-inserting (handles re-screen replacing original)
    await pool.query('DELETE FROM screened_assets WHERE company_id = $1', [companyId]);

    for (const asset of result.assets || []) {
      const { decision, layer, reason } = assetScreenDecision(asset);
      await pool.query(
        `INSERT INTO screened_assets
           (company_id, asset_name, modality, pathway, indication, is_platform,
            screen_decision, excluded_layer, excluded_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          companyId,
          asset.name        || null,
          asset.modality    || null,
          (asset.targets || []).join(', ') || null,
          asset.indication  || null,
          asset.isPlatform  || false,
          decision,
          layer,
          reason            || null,
        ]
      );
    }
  } catch (e) {
    console.error('[db save]', e.message);
  }
}

const crypto = require('crypto');

const app  = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// ─────────────────────────────────────────────────────────────
// Passkey auth — simple token-in-cookie gate
// ─────────────────────────────────────────────────────────────

const AUTH_TOKENS = new Set();   // in-memory; wiped on restart (forces re-login)

function requireAuth(req, res, next) {
  const passkey = process.env.SITE_PASSKEY;
  if (!passkey) return next();  // no passkey configured → open access
  const token = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith('beo_auth='));
  const val = token ? token.slice('beo_auth='.length) : null;
  if (val && AUTH_TOKENS.has(val)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// POST /api/auth/login  { passkey }  → sets cookie
app.post('/api/auth/login', (req, res) => {
  const passkey = process.env.SITE_PASSKEY;
  if (!passkey) return res.json({ ok: true });      // no gate configured
  if (!req.body.passkey || req.body.passkey !== passkey) {
    return res.status(401).json({ error: 'Incorrect passkey' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  AUTH_TOKENS.add(token);
  // 7-day session
  res.setHeader('Set-Cookie',
    `beo_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 7}`
  );
  res.json({ ok: true });
});

// GET /api/auth/check — returns 200 if authed, 401 if not
app.get('/api/auth/check', requireAuth, (_req, res) => res.json({ ok: true }));

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith('beo_auth='));
  if (token) AUTH_TOKENS.delete(token.slice('beo_auth='.length));
  res.setHeader('Set-Cookie', 'beo_auth=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Static files served only after auth check (except login assets)
app.use((req, res, next) => {
  const passkey = process.env.SITE_PASSKEY;
  if (!passkey) return next();
  // Always allow the login page itself and its assets
  const open = ['/login.html', '/css/style.css', '/api/auth/login', '/api/auth/check', '/images/'];
  if (open.some(p => req.path === p || req.path.startsWith(p))) return next();
  // Check cookie
  const token = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith('beo_auth='));
  const val = token ? token.slice('beo_auth='.length) : null;
  if (val && AUTH_TOKENS.has(val)) return next();
  // Redirect HTML navigations to login page; block API calls
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.redirect('/login.html');
  }
  res.status(401).json({ error: 'Unauthorized' });
});

app.use(express.static(__dirname));

// ─────────────────────────────────────────────────────────────
// Tools available to Claude during screening
// ─────────────────────────────────────────────────────────────

const TOOLS = [
  // Native, server-side — Anthropic runs the search on its own infrastructure.
  // Resolved automatically; never hits our tool_use branch below. Using the
  // older 20250305 version deliberately — 20260209 supports dynamic filtering,
  // which requires tracking a code-execution container_id across turns; we
  // don't thread that through our loop, so it 400s once filtering kicks in.
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  {
    name: 'fetch_webpage',
    description: 'Fetch and read the text content of a specific webpage URL — the company website, its pipeline/news pages, or a known structured URL (ClinicalTrials.gov API, SEC EDGAR). For a SEC filing URL you already fetched once, you can re-fetch the SAME url with a different "section" to jump elsewhere in the document instead of re-reading from the start.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
        section: {
          type: 'string',
          enum: ['item1', 'item7', 'item2'],
          description: 'SEC filings only: which section to jump to — item1 = Business (default), item7 = MD&A (rights/manufacturing fallback), item2 = Properties (own-facility check). Ignored for non-SEC URLs.'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'lookup_sec_filing',
    description: 'Given a US stock ticker symbol found on the company\'s own website, look up their exact CIK and return the direct URL to their most recent 10-K/20-F filing. Only call this with a ticker you actually found stated on the website — do not guess one.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'US stock ticker symbol, e.g. "CPRX"' }
      },
      required: ['ticker']
    }
  }
];

// Delta scan — fetch_webpage only. No web_search: re-fetch the specific URLs
// consulted in the original screen rather than running new searches.
const DELTA_TOOLS = [
  TOOLS.find(t => t.name === 'fetch_webpage'),
];

// ─────────────────────────────────────────────────────────────
// Pharmcube primary track tools — drugBaseLiteCN + drugDeal + web tools for Step 4
// ─────────────────────────────────────────────────────────────

const PHARMCUBE_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  TOOLS.find(t => t.name === 'fetch_webpage'),
  {
    name: 'drugBaseLiteCN',
    description: [
      'Search Pharmcube pharmaceutical database for a company\'s pipeline assets (lite/low-cost version — 15 pts per record vs 90 pts).',
      'IMPORTANT: Pharmcube charges per record returned. Always pass drugType2=["生物"], diseaseArea="肿瘤领域", status=["Active","Unknown"] to pre-filter and avoid paying for irrelevant records.',
      'Returns all core fields needed for Steps 1+2 screening:',
      '  drug_type_2: "生物" = Biologic, "化药" = Small molecule',
      '  drug_type_3 / modality: "抗体" = mAb, "双特异性抗体" = bsAb, "抗体偶联药物" = ADC,',
      '    "单域抗体" = VHH/nanobody (EXCLUDED), "mRNA疗法" = mRNA/LNP (EXCLUDED),',
      '    "抗体融合蛋白" = Fc-fusion, "T细胞衔接器" = TCE, "NK细胞衔接器" = NKCE',
      '  disease_area: "肿瘤领域" = oncology/tumor',
      '  latest_phase: development phase',
      '  status: Active (progress within 3yr), Unknown (3-6yr), Inactive (>6yr/abandoned)',
      'Use companyName to look up by company. Returns all assets across all phases.',
      'Always pass pageNo (0-indexed) and pageSize (use 20).',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        companyName: { type: 'string', description: 'Company name to search (English or Chinese accepted)' },
        pageNo: { type: 'number', description: 'Page number, 0-indexed (use 0 for first page)' },
        pageSize: { type: 'number', description: 'Results per page (use 20)', enum: [1, 5, 10, 20, 50] },
        drugType2: { type: 'array', items: { type: 'string' }, description: 'Filter by drug category. ALWAYS pass ["生物"] to return only biologics and avoid charges for small molecules.' },
        diseaseArea: { type: 'string', description: 'Filter by disease area. ALWAYS pass "肿瘤领域" to return only oncology assets and avoid charges for non-oncology.' },
        status: { type: 'array', items: { type: 'string' }, description: 'Filter by development status. ALWAYS pass ["Active","Unknown"] to exclude Inactive (abandoned) assets.' },
      },
      required: ['companyName', 'pageNo', 'pageSize'],
    },
  },
  {
    name: 'drugDeal',
    description: [
      'Search Pharmcube for licensing and partnership deals.',
      'Use transferor to find deals where a company out-licensed an asset.',
      'Returns: deal type, asset name, partner (transferee), rights scope (geography), date.',
      'Rights scope "Global" or "US" = out-licensed, exclude that asset.',
      'Rights scope "ex-US" or "China" = US rights retained, asset passes.',
      'Collaboration / co-development with rights retained = asset passes.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        transferor: { type: 'string', description: 'Company that out-licensed (licensor)' },
        drugName: { type: 'string', description: 'Specific drug/asset name (optional)' },
        dateFrom: { type: 'string', description: 'Search from this date YYYY-MM-DD (use "2010-01-01" for all-time)' },
        dateTo: { type: 'string', description: 'Search until this date YYYY-MM-DD (optional)' },
      },
      required: ['transferor'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Repository recall helpers
// ─────────────────────────────────────────────────────────────

async function lookupRecentScreening(companyName) {
  try {
    const row = await pool.query(`
      SELECT result_json, screened_at
      FROM screened_companies
      WHERE company_name ILIKE $1
        AND status != 'inconclusive'
        AND screened_at > NOW() - INTERVAL '3 months'
      ORDER BY screened_at DESC
      LIMIT 1
    `, [companyName]);
    if (!row.rows.length) return null;
    return {
      result: row.rows[0].result_json,
      screenedAt: new Date(row.rows[0].screened_at),
    };
  } catch (_) {
    return null; // DB unavailable — fall through to full screen
  }
}

// Collect every URL that was consulted during the original screening run.
// Priority: allSourcesConsulted (server-side ground truth) → sources (Claude self-reported)
//           → website → asset layer sources → externalSources (all fallbacks for older records).
function extractStoredUrls(storedResult) {
  const seen = new Set();
  const urls = [];
  function add(url, label) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push({ url, label: label || url });
  }
  // 1. Server-side capture — most reliable; every URL actually passed to fetch_webpage
  for (const url of (storedResult.allSourcesConsulted || [])) {
    add(url, null); // no label at this level; label resolved from sources array if present
  }
  // 2. Claude's self-reported sources (new schema) — provides descriptive labels
  for (const s of (storedResult.sources || [])) {
    if (s && s.url) add(s.url, s.label ? `${s.label} (${s.usedFor || s.type || ''})` : null);
  }
  // 3. Backward compat fallbacks for records predating allSourcesConsulted
  if (storedResult.website) add(storedResult.website, 'Company website');
  for (const a of (storedResult.assets || [])) {
    for (const key of ['layer1', 'layer2', 'layer3', 'layer4']) {
      const src = (a[key] || {}).source;
      if (src) add(src, `${a.name || 'asset'} ${key} source`);
    }
  }
  for (const s of (storedResult.externalSources || [])) {
    if (s && s.url) add(s.url, s.title || s.note || null);
  }
  return urls;
}

async function deltaScreenWithClaude(companyName, storedResult, lastScreenedAt, client, websiteUrl) {
  const lastScreenDate = lastScreenedAt.toISOString().slice(0, 10);
  const assetSummary = (storedResult.assets || [])
    .map(a => `${a.name} (${a.modality || '?'}, ${(a.targets || []).join('/') || '?'})`)
    .join('; ') || 'none identified';
  const exclusionSummary = storedResult.excludedAt
    ? `${storedResult.excludedAt} — ${storedResult.excludedReason || ''}`
    : 'none (qualifying or inconclusive)';

  // Collect saved URLs. If the caller passed an explicit websiteUrl and it's not already in the
  // stored sources, add it first so we always have at least one URL to re-fetch.
  const storedUrls = extractStoredUrls(storedResult);
  if (websiteUrl && !storedUrls.some(u => u.url === websiteUrl)) {
    storedUrls.unshift({ url: websiteUrl, label: 'Company website (user-supplied)' });
  }

  const urlList = storedUrls.length > 0
    ? storedUrls.map((u, i) => `  ${i + 1}. ${u.url}${u.label && u.label !== u.url ? ` — ${u.label}` : ''}`).join('\n')
    : '  (none saved — no re-fetch possible)';

  const messages = [{
    role: 'user',
    content: `You are running a RECALL DELTA SCAN — a lightweight re-check of pages already consulted during the original screen, NOT a full re-screen and NOT a web search.

Company: "${companyName}"
Last fully screened: ${lastScreenDate}
Stored result: status=${storedResult.status}, type=${storedResult.type || 'unknown'}
Known assets (${(storedResult.assets || []).length}): ${assetSummary}
Previous exclusion: ${exclusionSummary}

URLS FROM THE ORIGINAL SCREEN — re-fetch these and look for changes since ${lastScreenDate}:
${urlList}

YOUR TASK: Re-fetch each URL above (use fetch_webpage) and identify ONLY what has changed since ${lastScreenDate}. Do not run any web_search. Do not fetch any URL not listed above. Do not re-evaluate layers already assessed — just look for new pipeline entries, removed assets, or new Layer 3/4 disclosures.

BUDGET: up to ${Math.min(storedUrls.length + 1, 4)} fetch_webpage calls. Stop as soon as you have enough.

Return ONLY this JSON — no other text:
{
  "newAssets": [],
  "removedAssets": [],
  "layerChanges": {
    "layer3": null,
    "layer4": null
  },
  "deltaNotes": "Plain-English summary of changes since ${lastScreenDate}. Write 'No material changes found' if nothing changed.",
  "scanDate": "${new Date().toISOString().slice(0, 10)}"
}

For newAssets, use the same schema as a full screening asset object (name, modality, targets, indication, phase, layer1-4 as inconclusive since not fully evaluated, overallStatus: "inconclusive", isPlatform: false, notes, flags: []).
For layerChanges, each key is null or { "update": "one-sentence description", "source": "url" }.`,
  }];

  const MAX_DELTA_ITERATIONS = 5;
  for (let i = 0; i < MAX_DELTA_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      temperature: 0,
      tools: DELTA_TOOLS,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch (_) {}
      }
      return { deltaNotes: 'Delta scan returned no parseable result', newAssets: [], removedAssets: [], layerChanges: {} };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUses) {
        let output;
        try {
          output = await fetchWebpage(toolUse.input.url, toolUse.input.section);
        } catch (e) {
          output = `Tool error: ${e.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: output });
      }
      messages.push({ role: 'user', content: toolResults });
    }
    // pause_turn: loop continues
  }
  return { deltaNotes: 'Delta scan hit iteration limit', newAssets: [], removedAssets: [], layerChanges: {} };
}

function mergeWithDelta(storedResult, delta, lastScreenedAt) {
  const result = JSON.parse(JSON.stringify(storedResult)); // deep clone
  result.recallTrack    = true;
  result.lastScreenedAt = lastScreenedAt.toISOString();
  result.deltaFindings  = delta.deltaNotes || 'No material changes found';
  result.deltaScanDate  = delta.scanDate   || new Date().toISOString().slice(0, 10);

  // Append newly found assets — mark them so the UI can distinguish them
  if (delta.newAssets && delta.newAssets.length > 0) {
    for (const a of delta.newAssets) a.isNewSinceRecall = true;
    result.assets = [...(result.assets || []), ...delta.newAssets];
  }

  // Surface layer changes prominently in researchNotes
  const lc = delta.layerChanges || {};
  const layerNotes = [
    lc.layer3 ? `Layer 3 update: ${lc.layer3.update}${lc.layer3.source ? ' — ' + lc.layer3.source : ''}` : null,
    lc.layer4 ? `Layer 4 update: ${lc.layer4.update}${lc.layer4.source ? ' — ' + lc.layer4.source : ''}` : null,
  ].filter(Boolean).join('\n');

  const deltaHeader = `[Recall track — last screen: ${lastScreenedAt.toISOString().slice(0,10)}, delta: ${result.deltaScanDate}]\n${result.deltaFindings}${layerNotes ? '\n' + layerNotes : ''}`;
  result.researchNotes = deltaHeader + (storedResult.researchNotes ? '\n---\n' + storedResult.researchNotes : '');

  return result;
}

// ─────────────────────────────────────────────────────────────
// Screening methodology system prompt
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a pharmaceutical business development analyst screening companies as potential biologics manufacturing partners for BeOne Medicines' Hopewell, NJ facility.

OBJECTIVE: Identify oncology biologics companies that lack US biologics manufacturing capacity or a US CDMO relationship. These are manufacturing partnership opportunities.

You have three tools: web_search (locate the company and its website, and later for
manufacturing/licensing press releases not on the company's own site), fetch_webpage (fetch a
specific URL), and lookup_sec_filing (given a US ticker symbol you found stated on the
company's website, returns the exact URL of their most recent 10-K/20-F).

IMPORTANT — identification vs. evidence are two separate steps, not one. Finding the company's
website with web_search (and confirming it's the right company / has an oncology program) is
identification only — it is NOT automatically your evidence source for Layers 1-4. The actual
primary source for Layers 1-4 is a specific page you must separately locate and read, and which
one depends on the RESEARCH TRACK, not just the "type" label:
- SEC-FILING track (US-listed public companies only): their most recent 10-K/20-F filing, via
  lookup_sec_filing — "Item 1. Business" (or equivalent) covers oncology relevance, modality,
  rights, and manufacturing in one read.
- IR-FILING track (non-US-listed public companies — HKEX/SSE/SZSE/TSX/ASX/etc.): their
  IR / Investor Relations page → most recent annual report or equivalent filing (年報, 年度报告,
  Annual Results, etc.) → Business/Operations section of that document. This is the primary
  source for all four layers, equivalent in role to Item 1 Business in a 10-K. Fall back to
  WEBSITE track only if the IR page or annual report cannot be reached.
- WEBSITE track (private companies; fallback for non-US public when IR/annual report unreachable):
  their dedicated pipeline / "Our Science" page — not the homepage. A homepage mentioning a
  lead candidate is not a substitute for actually reading the pipeline page.
You may never skip this mandatory read just because an earlier page (e.g. the homepage) felt
sufficient — see the per-company instructions for exactly when "stop once confident" is and
isn't allowed to apply.
If the primary source leaves a layer genuinely ambiguous, ClinicalTrials.gov can help on
indication/modality: https://clinicaltrials.gov/api/v2/studies?query.spons=COMPANY+NAME&pageSize=10&format=json

RELEVANT MODALITIES (CHO/mammalian cell culture — these qualify):
mAb, bsAb, tsAb, ADC, TCE (T-cell engager, CD3-containing), NKCE (NK cell engager), Fc-fusion, Immunocytokine (cytokine fused to antibody/Fc for tumor targeting)
Always normalize to exactly these terms — e.g. write "mAb", never "msAb" (monospecific antibody
is the same thing as mAb). Downstream competitor-matching does exact string comparison, so an
unnormalized synonym silently breaks that check.

EXCLUDED MODALITIES (different manufacturing — do not qualify):
Cell therapy (CAR-T, CAR-NK, TCR-T including allogeneic), LNP/mRNA biologics, yeast/microbial proteins (nanobodies, VHH, scFv), peptide therapeutics, small-molecule conjugates

PRE-FILTERS — run before any layer evaluation, for every company:

STEP 0: Big Pharma exclusion (instant, no research needed)
Exclude immediately: AbbVie, Amgen, AstraZeneca, Pfizer, Roche, Genentech, Merck/MSD, Novartis, BMS, Sanofi, GSK, Eli Lilly, Takeda, Bayer, Gilead, Regeneron, Biogen, Daiichi Sankyo, Astellas, Boehringer Ingelheim, J&J/Janssen
→ excludedAt: "pre-filter"

STEP 0b: Oncology pre-filter (quick scan, company-level — distinct from Layer 1's asset-level detail)
No oncology program anywhere in the company → excludedAt: "pre-filter"
At least one oncology program → proceed to Layers 1-4
Ambiguous or sparse source → do NOT exclude, fall through to Layers 1-4

SCREENING LAYERS — evaluate in order only after both pre-filters pass, stop at first failure:

LAYER 1 — Oncology Relevance
Pass: at least one asset targets a cancer indication
Fail: no oncology programs → excludedAt: "layer1"

LAYER 2 — Modality Confirmation
Pass: has mAb/bsAb/tsAb/ADC/TCE/NKCE/Fc-fusion/Immunocytokine in CHO/mammalian expression
Fail: only excluded modalities → excludedAt: "layer2"
Platform record: if site describes a general oncology biologic platform without named candidates, create one asset with isPlatform: true
Note: a mixed-modality pipeline (mostly small molecules but with some ADCs/mAbs) still passes if any qualifying asset exists. A company is only excluded at Layer 2 if NONE of its assets qualify.
ENUMERATE ALL ASSETS — list every individually named asset from the pipeline page as a separate asset object regardless of phase. Discovery, Preclinical, Lead Opt, IND-Enabling, Phase 1/2/3, Approved — all are included. If the table has 10 rows, output 10 objects. Do NOT filter by phase, do NOT collapse the pipeline into one representative asset, do NOT summarize as "several mAbs". Extract all rows from what you already fetched — do not make extra tool calls per asset.

LAYER 5 — Competitive Overlap (evaluate HERE, immediately after Layer 2, BEFORE Layers 3 and 4)
Check each qualifying asset against the BeOne pipeline. Assets that are direct competitors are eliminated here so you do not waste research on their rights or manufacturing status.

BEONE PIPELINE (modality + NCI-normalized targets):
  mAb   / PD-1
  bsAb  / HER2               ← HER2 SPECIAL RULE
  ADC   / EGFR + MET + MET
  mAb   / FGFR2b
  TCE   / CD3 + CEA
  ADC   / ADAM9
  TCE   / CD3 + DLL3
  TCE   / CD3 + CD19
  TCE   / CD3 + STEAP1
  TCE   / CD3 + CLDN6
  bsAb  / GPC3 + 4-1BB
  mAb   / KLRG1

Matching rules:
  HER2 "contains" rule: HER2 anywhere in the candidate's target list → competitive overlap with BeOne HER2 bsAb, regardless of modality or co-targets.
  All others — exact multiset rule: candidate's modality AND full target set must exactly match a BEONE_PIPELINE entry. Partial overlap (one shared target of several, or same targets but different modality) does NOT match.

Per asset:
  Match → layer5: { status: "fail", reason: "Competitive overlap: matches BeOne [name] ([modality]/[targets])" }, overallStatus: "excluded". Do NOT evaluate Layers 3+4 for this asset.
  No match → layer5: { status: "pass", reason: "No competitive overlap with BeOne pipeline" }. Proceed to Layer 3.
  Platform-level record (no target) → layer5: { status: "inconclusive", reason: "No target — not applicable" }. Proceed to Layer 3.

LAYER 3 — Rights Retained
Pass: company retains global or US rights for its qualifying assets
Fail: global or US rights out-licensed via license deal, asset sale, or option
Note: ex-US licensing only = still PASSES. A headline out-licensing deal for one asset does not mean all assets are out-licensed — if the company has other unlicensed qualifying assets, those still pass.

LAYER 4 — US Manufacturing Screen
Pass: no US drug substance manufacturing solution found for this asset
Fail: has an active, asset-specific US CDMO relationship for drug substance manufacturing, OR owns a US biologics facility used for drug substance production → excludedAt: "layer4"

RULE A — Drug substance only. BeOne's focus is drug substance (DS) manufacturing:
bioreactor cell culture, upstream processing, fermentation, downstream processing, purification,
bulk drug substance production. Fill & finish (F&F), formulation, vialing, labeling, packaging,
finishing, and drug product (DP) steps handled by a separate contract organization do NOT
constitute a manufacturing exclusion — those are downstream of what BeOne does. If a CDMO
relationship is explicitly described as fill & finish or drug product only → PASS Layer 4.
If it is genuinely unclear whether a CDMO is doing DS or F&F → default to PASS, note in researchNotes.

RULE B — Asset-level scope. A CDMO agreement covers only the specific asset it names.
If a company has Asset A with a US DS CDMO and Asset B with no CDMO mentioned:
→ Asset A fails Layer 4; Asset B passes Layer 4. Never fail all of a company's assets
because one asset has a manufacturing partner. Only set excludedAt: "layer4" at the company
level if every qualifying asset fails Layer 4.

RULE C — Recency and active status. Only rely on evidence from the two most recent annual
filings (10-K or 20-F) or, for private companies, content from the last ~2 years. An agreement
mentioned only in older documents that does not appear in either of the two most recent filings
may have expired or been terminated — treat as PASS, note in researchNotes. If a termination,
expiration, or non-renewal is explicitly documented → PASS. Agreements that renew on a fixed
cycle (e.g. every 3 years) must be confirmed active in a recent filing to count as a fail.

RULE D — Source required. Every Layer 4 fail MUST have the exact URL of the filing or press
release confirming the active DS agreement in the layer's "source" field. A Layer 4 fail
with no source is not valid — if you cannot cite a specific recent document, default to PASS.

Named US CDMOs (drug substance operations): Lonza US, Samsung Biologics US, WuXi Biologics US,
Thermo Fisher Biologics, Fujifilm Diosynth US, Catalent Biologics, Rentschler US, AGC Biologics US,
Patheon (drug substance operations only — Patheon fill & finish does not count).
Own US biologics facility (drug substance scale): excluded only if ≥200L bioreactor capacity
confirmed. If capacity unstated → PASS, note in researchNotes.
Default if ambiguous, budget exhausted, or time runs out: PASS for that asset, add "check-mfg-partner" to company-level flags[]. Never return inconclusive on manufacturing alone — the company still qualifies. Only exclude if clearly disclosed.

RULES:
- Return ONLY valid JSON at the end — no text before or after it
- Every response you send must end with either a tool call or the final JSON object — never
  both-less. If you write text describing what you found ("the website loaded, I can see X..."),
  that description is not a complete response by itself — immediately continue in the SAME
  response with your next tool call or the final JSON. Stopping after only a description, with
  no tool call and no JSON, is invalid and wastes a full extra turn correcting it.
- Assess Layer 5 (competitive overlap) immediately after Layer 2 — BEFORE Layers 3+4. Assets that fail Layer 5 skip Layers 3+4 entirely.
- ENUMERATE ASSETS: list every individually named asset as its own object in "assets" regardless of phase (Discovery/Preclinical/Lead Opt/IND-Enabling/clinical/approved — all count). Never collapse, never filter by phase, never write "several mAbs". Read the pipeline page once and extract all rows; do not make extra tool calls per individual asset.
- If after all searching you cannot find reliable information: status = "inconclusive", inconclusiveReason = "Website Input Needed"
- Be specific in reasons — cite what you found (e.g. "Lonza US manufacturing agreement announced March 2024 per press release")
- Whenever a specific page/filing/press release is the actual basis for a layer's pass/fail
  (especially Layer 3 rights and Layer 4 manufacturing — the layers that actually drive
  exclusions), put that exact URL in that layer's "source" field. If the company is excluded
  at the company level (excludedAt set), put the URL behind that reason in "excludedSource"
  too. Leave "source"/"excludedSource" empty if there genuinely isn't a single page it came
  from (e.g. a Big Pharma pre-filter match, or a judgment call from general site browsing) —
  don't invent a URL just to fill the field.
- Use NCI-standard target names (PD-1 not PD1, HER2 not ERBB2)
- If the company is based in Greater China (mainland China, Hong Kong, Taiwan) or has a
  Chinese-language name: spend AT MOST 1 extra tool call specifically trying to find name
  variants (Chinese legal name, exchange-listing/rebrand name) — usually visible on the
  homepage or an /about page you've likely already fetched, so this is often already known
  without any extra call. If a variant surfaces, reuse it in later searches this turn. If
  nothing surfaces within that 1 extra call, proceed with the name you have — do not keep
  searching for name variants, this is a minor enhancement, not worth burning your budget on.
- If the company's own website never loaded usable content and a likely-private company had to rely on external sources instead (press releases, conference abstracts, regulatory filings ONLY — never sales databases or generic explainers): set "externalSourcing": true and include "purple-flag" in "flags" once you have enough from at most 2-3 such sources. If those 2-3 sources aren't enough, do not keep digging — return "inconclusive" instead (see step 0a). This is a stricter, speed-first policy: don't fill gaps, don't guess, keep this company under ~30 seconds of research.

REQUIRED JSON OUTPUT:
{
  "name": "company name as given",
  "type": "public" | "private" | "unknown",
  "website": "url or null",
  "status": "qualifying" | "excluded" | "inconclusive",
  "excludedAt": null | "pre-filter" | "layer1" | "layer2" | "layer3" | "layer4",
  "excludedReason": "",
  "excludedSource": "url or empty string — the specific page/filing/press release that is the basis for excludedReason, if there is one (leave empty for a Big Pharma pre-filter match, there's no source for that)",
  "inconclusiveReason": "",
  "assets": [
    {
      "name": "asset name or [Platform]",
      "modality": "mAb|bsAb|tsAb|ADC|TCE|NKCE|Fc-fusion|Immunocytokine",
      "targets": ["TARGET1"],
      "indication": "cancer type",
      "phase": "Discovery|Lead Opt|Preclinical|IND-Enabling|Phase 1|Phase 2|Phase 3|Approved|Unknown",
      "isPlatform": false,
      "layer1": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "layer2": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "layer5": { "status": "pass|fail|inconclusive", "reason": "" },
      "layer3": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "layer4": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "overallStatus": "qualifying|excluded",
      "notes": "",
      "sources": [],
      "flags": []
    }
  ],
  "beoneAnalyzed": false,
  "beoneOutcome": null,
  "flags": [],
  "externalSourcing": false,
  "externalSources": [],
  "researchNotes": "",
  "sources": [
    {
      "url": "https://...",
      "label": "short descriptive name (e.g. '10-K 2024', 'Pipeline page', 'Press release Mar 2024')",
      "usedFor": "which layer(s) or criteria this URL informed (e.g. 'Layer 1–2 modality/indication', 'Layer 4 manufacturing screen')",
      "type": "filing | company-website | press-release | external"
    }
  ]
}

SOURCES ARRAY — populate "sources" at the company level with EVERY URL you actually opened
(via fetch_webpage) or used as evidence (from a web_search result snippet). This includes:
- The company's own website / pipeline page / IR page → type "company-website"
- SEC filings, annual reports, 20-F / prospectus PDFs → type "filing"
- The company's own press releases (on their domain or a PR newswire from them) → type "press-release"
- Any third-party URL (news, databases, a CDMO's own site, etc.) → type "external"
Do NOT include URLs you fetched but found completely empty/unreadable. Include every URL
that contributed any information to your assessment. Populate "usedFor" with which layer(s)
or pre-filter step the source supported (e.g. "Layer 1–2 oncology/modality", "Layer 4 manufacturing",
"Pre-filter: oncology confirmation", "Identification / website search").
This field is REQUIRED — populate it for every company, even if the only source is the company website.

FLAGS — Claude sets these automatically:
  "purple-flag" — set when externalSourcing is true (data from web_search/press/third-party
    rather than the company's own site).
  "check-mfg-partner" — set when Layer 4 manufacturing is ambiguous, budget is exhausted
    without a clear answer, or the screen could not confirm/deny a US manufacturing partner
    for at least one qualifying asset. Company still screens IN when this flag is set.
indication-synergy, phase-synergy, checkpoint-io-alt, and masked-tce-4-1bb are auto-computed
server-side from asset data after screening — do not set these yourself.
adc-novel-payload still requires manual autoflag (payload detail not in Pharmcube).
`.trim();

// ─────────────────────────────────────────────────────────────
// Pharmcube primary track system prompt
// ─────────────────────────────────────────────────────────────

const PHARMCUBE_PRIMARY_PROMPT = `
You are a pharmaceutical business development analyst screening companies for BeOne Medicines' Hopewell, NJ biologics manufacturing partnership program.

CONTEXT: PRIMARY TRACK — Pharmcube MCP. The company has already passed the Big Pharma pre-filter. You have access to Pharmcube (drugBaseLiteCN, drugDeal) plus web tools (web_search, fetch_webpage) for Step 5.

OBJECTIVE: Screen through Steps 1+2 → 3 → 4 → 5 in order. If the company is NOT FOUND in Pharmcube, return inconclusive immediately — do NOT search the web. The secondary research track will handle it.

═══ STEPS 1 + 2 — Oncology Biologic Identification (call drugBaseLiteCN FIRST) ═══

Call drugBaseLiteCN with:
  companyName = the given company name
  pageNo = 0, pageSize = 20
  drugType2 = ["生物"]        ← biologics only (avoids charges for small molecules)
  diseaseArea = "肿瘤领域"    ← oncology only (avoids charges for non-oncology assets)
  status = ["Active","Unknown"] ← exclude Inactive (abandoned) assets upfront

Filter results to qualifying assets where ALL of:
  (a) disease_area contains oncology/tumor indication
      — 肿瘤领域, 肿瘤, tumor, cancer, leukemia, lymphoma, carcinoma, sarcoma, etc.
  (b) drug_type_2 = "生物" (Biologic)
  (c) drug_type_3 / modality is a qualifying CHO-expressed format:
  (d) status ≠ "Inactive" — silently drop Inactive assets (officially abandoned or >6yr no progress); keep Active and Unknown

QUALIFYING (CHO — these count):
  抗体 / Monoclonal antibody      → mAb
  双特异性抗体 / Bispecific        → bsAb
  三特异性抗体 / Trispecific       → tsAb
  抗体偶联药物 / ADC               → ADC
  T细胞衔接器 / T cell engager     → TCE
  NK细胞衔接器 / NK cell engager   → NKCE
  抗体融合蛋白 / Fc融合蛋白         → Fc-fusion
  免疫细胞因子 / Immunocytokine    → Immunocytokine

EXCLUDED (NOT CHO — do not qualify):
  单域抗体 / VHH / nanobody        — yeast/microbial expressed
  mRNA疗法 / mRNA / LNP            — in vitro transcription
  CAR-T / CAR-NK / TCR-T           — cell therapy
  化药 / 小分子 / Small molecule    — not a biologic
  多肽 / Peptide
  其他 (Other) with clearly non-CHO description → exclude; genuinely ambiguous → mark asset inconclusive, continue with company

Per qualifying asset, save: name, modality (English term), target(s), indication (English), latest_phase, status (Active/Unknown/Inactive).

OUTCOMES from Steps 1+2:
  (A) drugBaseLiteCN returns zero results for this company →
      Before concluding "not found", make exactly ONE fallback call with common corporate suffixes
      stripped from the name. Strip any trailing: Bio, Biotech, Biosciences, Biotherapeutics,
      Therapeutics, Pharma, Pharmaceuticals, Sciences, Medicine, Medicines, Inc, Ltd, Corp, Co,
      Group, Holdings, Oncology, Immunology, Genomics. Strip only one suffix per retry
      (e.g. "Hanchor Bio" → "Hanchor"). Then re-call drugBaseLiteCN with the stripped name and the same filters (drugType2, diseaseArea, status).
      Sanity check: if results come back, confirm that the company name field in at least one
      result plausibly matches the original query (shared word root, Chinese name phonetically
      similar, or English alias). If no plausible match, treat as not found.
      If still zero results after the one retry → return: status="inconclusive",
      inconclusiveReason="Company not found in Pharmcube — route to secondary track".
      Total cap: 2 drugBaseLiteCN calls. Do NOT try web searches.
  (B) Results found, ≥1 qualifying oncology biologic asset → proceed to Step 3
  (C) Results found, zero qualifying assets (all non-oncology, all small-molecule, all excluded modalities, or all Inactive) →
      Return: status="excluded", excludedAt="step1-2", excludedReason="No qualifying oncology biologic assets in Pharmcube"
      If all assets were Inactive, set excludedReason="All oncology biologic assets are Inactive (abandoned or >6yr no progress)"

═══ STEP 3 — COMPETITIVE OVERLAP (no API call — pure data check, run immediately after Steps 1+2) ═══

Before making any further API calls, check each qualifying asset from Steps 1+2 against the BeOne pipeline below. This eliminates direct competitors cheaply before the expensive licensing and manufacturing checks.

BEONE PIPELINE (modality + NCI-normalized targets):
  mAb   / PD-1
  bsAb  / HER2                    ← HER2 SPECIAL RULE (see below)
  ADC   / EGFR + MET + MET
  mAb   / FGFR2b
  TCE   / CD3 + CEA
  ADC   / ADAM9
  TCE   / CD3 + DLL3
  TCE   / CD3 + CD19
  TCE   / CD3 + STEAP1
  TCE   / CD3 + CLDN6
  bsAb  / GPC3 + 4-1BB
  mAb   / KLRG1

MATCHING RULES:
  HER2 "contains" rule: if HER2 appears ANYWHERE in the candidate asset's target list → competitive
  overlap with BeOne HER2 bsAb, regardless of modality or other co-targets.

  All other targets — exact multiset rule: the candidate's modality AND full target set must exactly
  match a BEONE_PIPELINE entry (same modality, same targets in any order, same count).
  Partial overlap (one shared target out of several, or same targets but different modality) does NOT match.

  Examples:
    mAb / PD-1               → MATCH (exact)
    bsAb / HER2 + PD-1       → MATCH (HER2 contains rule)
    ADC / EGFR + MET + MET   → MATCH (exact)
    TCE / CD3 + CD19         → MATCH (exact)
    mAb / EGFR               → NO match (EGFR alone not in pipeline as mAb)
    ADC / HER2               → MATCH (HER2 contains rule)
    TCE / CD3 + PD-L1        → NO match (exact rule — not in pipeline)

OUTCOMES per asset:
  — Match → set layer5: { status: "fail", reason: "Competitive overlap: matches BeOne [name] ([modality]/[targets])" }
    set overallStatus: "excluded". Do NOT run Steps 4+5 for this asset.
  — No match → asset continues to Step 4
  — Platform-level record (no target) → Step 3 not applicable, asset continues to Step 4

If ALL qualifying assets are eliminated here → excludedAt="step3", status="excluded"
If ≥1 asset passes → proceed to Step 4 with passing assets only

═══ STEP 4 — Rights Retained (call drugDeal for non-competing assets) ═══

Call drugDeal with transferor = company name, dateFrom = "2010-01-01".

Per asset still passing after Step 3:
  — Global or US rights out-licensed → exclude that asset (note partner + date)
  — Ex-US rights only (China-only, APAC-only, etc.) → asset PASSES (US rights retained)
  — Collaboration / co-development with rights retained → asset PASSES (note deal)
  — No deal found → asset PASSES

If ALL remaining assets excluded here → excludedAt="step4"
If ≥1 passes → proceed to Step 5

═══ STEP 5 — US Manufacturing Screen ═══

Applies to all companies (public and private) — use the same escalation regardless of listing status.
Target: complete Step 5 in ≤90 seconds. Stop immediately once you have a conclusive answer.
Budget: max 5 tool calls for this step.

Escalation order (stop as soon as a clear answer is found):

  5a — Company newsroom / press releases page (1 fetch):
       Fetch /news, /press, /media, or /newsroom. Scan headlines for manufacturing deal announcements.

  5b — Targeted CDMO search + fetch (1 search + 1 fetch):
       web_search: "[company name]" (Lonza OR "WuXi Biologics" OR "Samsung Biologics" OR
       "Thermo Fisher" OR "Catalent" OR "Fujifilm Diosynth" OR "AGC Biologics" OR Rentschler) manufacturing
       Fetch the top result if it looks relevant.

  5c — General US manufacturing search + fetch (1 search + 1 fetch):
       web_search: "[company name]" biologics manufacturing CDMO "United States" OR "US facility" OR "US plant"
       Fetch the top result if it looks relevant.

Manufacturing keywords (US drug substance):
  CDMO, CMO, contract manufacturing, manufacturing agreement, supply agreement, tech transfer,
  bioreactor, Lonza, Samsung Biologics, WuXi Biologics, Thermo Fisher Biologics,
  Fujifilm Diosynth, AGC Biologics, Catalent Biologics, Rentschler, Patheon
US-specific: US manufacturing, US facility, US plant, domestic manufacturing, Hopewell

ASSET-LEVEL SCOPE: A manufacturing relationship covers only the specific asset it names. If one
asset has a confirmed US CDMO and another does not, the second asset still passes. Only set
excludedAt: "step5" at the company level if EVERY qualifying asset has a confirmed US manufacturing
partner. If even one asset is unresolved or clear, the company screens in for that asset.

OUTCOMES per asset:
  — US-based CDMO for drug substance confirmed → layer4: fail, overallStatus: excluded (note partner + URL)
  — Own US biologics facility ≥200L confirmed → layer4: fail, overallStatus: excluded
  — Own US facility, capacity unstated → layer4: pass, note in researchNotes
  — Fill & finish / drug product only → layer4: pass
  — Ex-US manufacturing only → layer4: pass
  — No manufacturing disclosure found → layer4: pass (manufacturing gap confirmed)
  — Ambiguous / Step 5 budget or time exhausted without clear answer → layer4: pass, add "check-mfg-partner"
    to the company-level flags[] array. Never return inconclusive due to Step 5 alone — the company still qualifies.

SOURCING: Add every URL consulted in Step 5 to the top-level sources[] with usedFor: "Step 5 manufacturing".

═══ RULES ═══

  ★ GOLDEN RULE — ASSET-LEVEL PASS: If even ONE asset passes all steps, the company is
    status="qualifying". A company is only excluded if ALL qualifying assets are eliminated.
    Example: 14 assets screened out + 1 asset passes Step 5 → company QUALIFIES on that asset.
    Never set status="excluded" while any single asset still has overallStatus="qualifying".

  — Always call drugBaseLiteCN BEFORE any web tool
  — drugBaseLiteCN: max 2 calls total (exact name + one suffix-stripped retry if zero results)
  — If still not found after retry: return inconclusive immediately, no web search
  — Run Step 3 (competitive overlap) BEFORE calling drugDeal — it's free and eliminates assets
  — Normalize modality to exactly: mAb | bsAb | tsAb | ADC | TCE | NKCE | Fc-fusion | Immunocytokine
  — Use NCI-standard target names: PD-1 (not PD1), HER2 (not ERBB2), EGFR, CD3, CD19, etc.
  — Return ONLY valid JSON at end — no text before or after it
  — Every turn must end with either a tool call or the final JSON — never neither

═══ REQUIRED JSON OUTPUT ═══

{
  "name": "company name as given",
  "type": "public" | "private" | "unknown",
  "website": "url or null",
  "status": "qualifying" | "excluded" | "inconclusive",
  "sourceTrack": "pharmcube",
  "excludedAt": null | "pre-filter" | "step1-2" | "step3" | "step4" | "step5",
  "excludedReason": "plain-language reason",
  "excludedSource": "url of press release or deal record confirming exclusion, if applicable",
  "inconclusiveReason": "",
  "assets": [
    {
      "name": "asset name",
      "modality": "mAb|bsAb|tsAb|ADC|TCE|NKCE|Fc-fusion|Immunocytokine",
      "targets": ["TARGET1"],
      "indication": "cancer type in English",
      "phase": "Discovery|Lead Opt|Preclinical|IND-Enabling|Phase 1|Phase 2|Phase 3|Approved|Unknown",
      "status": "Active|Unknown|Inactive",
      "isPlatform": false,
      "layer1": { "status": "pass|fail|inconclusive", "reason": "oncology indication confirmed via Pharmcube" },
      "layer2": { "status": "pass|fail|inconclusive", "reason": "modality: [English modality term]" },
      "layer5": { "status": "pass|fail|inconclusive", "reason": "competitive overlap check (Step 3)" },
      "layer3": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "layer4": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "overallStatus": "qualifying|excluded",
      "notes": "",
      "flags": []
    }
  ],
  "beoneAnalyzed": false,
  "beoneOutcome": null,
  "flags": [],
  "externalSourcing": false,
  "externalSources": [],
  "researchNotes": "",
  "sources": [
    {
      "url": "pharmcube:drugBaseLiteCN",
      "label": "Pharmcube drugBaseLiteCN",
      "usedFor": "Steps 1+2 — oncology biologic identification",
      "type": "pharmcube"
    }
  ]
}

Notes on the asset schema:
  layer5 = Step 3 competitive overlap. Fill for all assets (pass or fail). For platform-level records with no target, set layer5.status = "inconclusive", reason = "No target — not applicable".
  layer3 = Step 4 rights check. Only fill for assets that passed Step 3 (not competed out). For assets eliminated at Step 3, leave layer3/layer4 as null or omit.
  layer4 = Step 5 manufacturing check. Only fill for assets that passed Steps 3+4.
  For Pharmcube tool calls in sources[], use "pharmcube:drugBaseLiteCN" and "pharmcube:drugDeal" as url placeholders.
`.trim();

// ─────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────

// 10-Ks/20-Fs are huge — jump straight to the requested section instead of
// truncating from the top. Heading wording varies slightly across filers, so
// these are deliberately loose matches.
const SEC_SECTION_PATTERNS = {
  item1: /item\s*1\.?\s*business/i,
  item7: /item\s*7\.?\s*management.?s?\s*discussion/i,
  item2: /item\s*2\.?\s*propert/i,
};

async function fetchWebpage(url, section) {
  try {
    const isSec = url.includes('sec.gov');
    const res = await axios.get(url, {
      // Raised from 8000 — under SCREEN_CONCURRENCY=4, several companies' fetches
      // compete for network/CPU at once, so a fetch that'd succeed in 3-4s in
      // isolation can cross an 8s ceiling under contention and get misread as a
      // genuinely broken site, triggering the external-sourcing fallback for no
      // real reason.
      timeout: 15000,
      maxRedirects: 4,
      headers: {
        // SEC's fair-access policy wants a descriptive contact User-Agent, not a browser spoof
        'User-Agent': isSec
          ? 'BeOne-Superhighway-Screener research-tool@beonemedicines.com'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
      validateStatus: s => s < 400,
    });

    if (typeof res.data !== 'string') return 'Could not read page (non-HTML response).';

    const $ = cheerio.load(res.data);
    $('script, style, nav, footer, header, .nav, .footer, .cookie-banner, iframe, [aria-hidden="true"]').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();

    if (text.length <= 100) {
      return 'Page content appears empty (likely JavaScript-rendered — try fetching a different URL or searching for cached/text version).';
    }

    if (isSec) {
      const requested = SEC_SECTION_PATTERNS[section] || SEC_SECTION_PATTERNS.item1;
      const match = text.match(requested);
      if (match) return text.slice(match.index, match.index + 8000);

      // Requested section heading not found (wording varies by filer) — fall
      // back to Item 1 rather than returning nothing.
      if (section && section !== 'item1') {
        const fallback = text.match(SEC_SECTION_PATTERNS.item1);
        const note = `Could not find an "${section}" section heading in this filing — returning Item 1 Business instead.\n\n`;
        return fallback ? note + text.slice(fallback.index, fallback.index + 8000) : note + text.slice(0, 8000);
      }
    }

    return text.slice(0, 15000);
  } catch (e) {
    return `Could not fetch page: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────
// Evidence snapshot — captures what was actually read for audit trail
// ─────────────────────────────────────────────────────────────

function makeEvidenceSnapshot(url, content, type = 'fetch') {
  const retrievedAt = new Date().toISOString();
  const fullText = typeof content === 'string' ? content : JSON.stringify(content);
  const contentHash = crypto.createHash('sha256').update(fullText).digest('hex');
  return {
    type,
    url,
    retrievedAt,
    contentSnippet: fullText.slice(0, 3000),
    contentHash,
  };
}

// ─────────────────────────────────────────────────────────────
// Pharmcube MCP — direct JSON-RPC call to the Streamable HTTP endpoint
// Called when Claude (in the primary track loop) invokes drugBaseLiteCN or drugDeal
// ─────────────────────────────────────────────────────────────

async function callPharmcubeTool(toolName, toolArgs) {
  const apiKey = process.env.PHARMCUBE_API_KEY || process.env.pharmcube_api_key;
  if (!apiKey) throw new Error('PHARMCUBE_API_KEY not set — primary track disabled');

  const mcpToolName = `pharmcube-mcp-${toolName}`;

  let rawBody;
  try {
    const resp = await axios.post(
      'https://mcp-openapi.pharmcube.com/mcp',
      {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: mcpToolName, arguments: toolArgs },
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        timeout: 30000,
        responseType: 'text',
      }
    );
    rawBody = resp.data;
  } catch (e) {
    return `Pharmcube network error calling ${toolName}: ${e.message}`;
  }

  // Parse JSON response (handles both direct JSON and SSE "data: {...}" streams)
  const tryJson = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

  let data = tryJson(rawBody);
  if (!data) {
    // Try extracting from SSE stream lines
    const events = (rawBody || '').split('\n')
      .filter(l => l.startsWith('data: '))
      .map(l => tryJson(l.slice(6)))
      .filter(Boolean);
    data = events.find(e => e.result || e.error) || events[0] || null;
  }

  if (!data) return `Pharmcube returned unparseable response for ${toolName}: ${String(rawBody).slice(0, 500)}`;

  if (data.error) {
    const err = data.error;
    return `Pharmcube error ${err.code || ''}: ${err.message || JSON.stringify(err)}`;
  }

  if (data.result) {
    const content = data.result.content;
    if (Array.isArray(content)) {
      return content.map(c => (typeof c === 'string' ? c : (c.text || JSON.stringify(c)))).join('\n');
    }
    return JSON.stringify(data.result, null, 2);
  }

  return JSON.stringify(data, null, 2);
}

// ─────────────────────────────────────────────────────────────
// Public/private determination + 10-K lookup via SEC EDGAR
// ─────────────────────────────────────────────────────────────

let tickerCache = null; // ~8000 entries, fetched once per server process

async function loadCompanyTickers() {
  if (tickerCache) return tickerCache;
  const res = await axios.get('https://www.sec.gov/files/company_tickers.json', {
    timeout: 10000,
    headers: { 'User-Agent': 'BeOne-Superhighway-Screener research-tool@beonemedicines.com' },
  });
  tickerCache = Object.values(res.data || {}); // { cik_str, ticker, title }
  return tickerCache;
}

// Exact-match only — Claude supplies this after reading it directly off the
// company's website, so there's no fuzzy name-matching false-positive risk
// (unlike resolving public/private from the spreadsheet name alone).
async function findCikByTicker(ticker) {
  try {
    const tickers = await loadCompanyTickers();
    const normalizedTicker = String(ticker || '').trim().toUpperCase();
    const match = tickers.find(t => String(t.ticker || '').toUpperCase() === normalizedTicker);
    return match ? String(match.cik_str).padStart(10, '0') : null;
  } catch (e) {
    return null;
  }
}

async function getLatestFilingUrl(cik) {
  try {
    const res = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      timeout: 10000,
      headers: { 'User-Agent': 'BeOne-Superhighway-Screener research-tool@beonemedicines.com' },
    });

    const recent = res.data && res.data.filings && res.data.filings.recent;
    if (!recent || !recent.form) return null;

    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] === '10-K' || recent.form[i] === '20-F') {
        const accNoDashes = recent.accessionNumber[i].replace(/-/g, '');
        const cikUnpadded = String(parseInt(cik, 10));
        return `https://www.sec.gov/Archives/edgar/data/${cikUnpadded}/${accNoDashes}/${recent.primaryDocument[i]}`;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Auto-flag: Indication Synergy + Phase Synergy via ClinicalTrials.gov,
// Strategic Synergy via a small capped Claude research pass. Triggered
// on-demand from the results view ("Flag High Priority Assets"), not
// during initial screening — these need a registered trial (CT.gov) or
// deeper science detail that isn't always resolved in the main pass.
// ─────────────────────────────────────────────────────────────

async function lookupClinicalTrialsForAsset(companyName, assetName) {
  try {
    const url = `https://clinicaltrials.gov/api/v2/studies?query.spons=${encodeURIComponent(companyName)}&pageSize=20&format=json`;
    const res = await axios.get(url, { timeout: 10000 });
    const studies = (res.data && res.data.studies) || [];
    const needle = (assetName || '').toLowerCase().trim();
    if (!needle) return null;

    const matches = studies.filter(s => {
      const ps = s.protocolSection || {};
      const id = ps.identificationModule || {};
      const title = `${id.briefTitle || ''} ${id.officialTitle || ''}`.toLowerCase();
      const interventions = (ps.armsInterventionsModule?.interventions || [])
        .map(iv => (iv.name || '').toLowerCase()).join(' ');
      return title.includes(needle) || interventions.includes(needle);
    });
    if (matches.length === 0) return null;

    const conditions = [];
    const phases = new Set();
    let anyCompleted = false;
    for (const s of matches) {
      const ps = s.protocolSection || {};
      (ps.conditionsModule?.conditions || []).forEach(c => conditions.push(c));
      (ps.designModule?.phases || []).forEach(p => phases.add(String(p).toUpperCase()));
      if (/complet/i.test(ps.statusModule?.overallStatus || '')) anyCompleted = true;
    }
    return { conditions, phases: Array.from(phases), anyCompleted };
  } catch (e) {
    return null;
  }
}

// Plan's fixed Indication Synergy keyword list (hematology, lung, GI, breast/gyn).
const INDICATION_SYNERGY_TERMS = [
  'CLL', 'B-CLL', 'SLL', 'WM', 'Waldenstrom', 'Waldenström', 'lymphoplasmacytic lymphoma',
  'FL', 'Follicular Lymphoma', 'MCL', 'Mantle Cell Lymphoma', 'MZL', 'Marginal Zone Lymphoma',
  'MALT lymphoma', 'NHL', 'Non-Hodgkin Lymphoma', 'MM', 'Multiple Myeloma', 'plasma cell myeloma',
  'MDS', 'Myelodysplastic Syndrome', 'myelodysplasia', 'AML', 'Acute Myeloid Leukemia',
  'acute myelogenous leukemia', 'B-cell malignancies',
  'SCLC', 'Small Cell Lung Cancer', 'small cell lung carcinoma', 'NSCLC',
  'Non-Small Cell Lung Cancer', 'lung adenocarcinoma', 'squamous cell lung carcinoma',
  'ESCC', 'Esophageal Squamous Cell Carcinoma', 'GC', 'Gastric Cancer', 'stomach cancer',
  'stomach carcinoma', 'GEJC', 'Gastroesophageal Junction Cancer', 'GEJ cancer', 'GEA',
  'Gastroesophageal Adenocarcinoma', 'HCC', 'Hepatocellular Carcinoma', 'liver cell carcinoma',
  'NPC', 'Nasopharyngeal Carcinoma', 'nasopharyngeal cancer', 'UBC', 'Urothelial Bladder Cancer',
  'bladder urothelial carcinoma', 'transitional cell carcinoma of the bladder', 'MSI-H',
  'Microsatellite Instability-High', 'MSI-high', 'dMMR', 'Deficient Mismatch Repair',
  'MMR-deficient', 'BTC', 'Biliary Tract Cancer', 'cholangiocarcinoma', 'bile duct cancer',
  'gallbladder cancer',
  'Breast cancer', 'breast carcinoma', 'HER2-positive breast cancer',
  'triple-negative breast cancer', 'TNBC', 'ovarian cancer', 'ovarian carcinoma',
  'cervical cancer', 'cervical carcinoma', 'endometrial cancer', 'endometrial carcinoma',
  'uterine cancer',
];

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchesIndicationSynergy(text) {
  if (!text) return false;
  return INDICATION_SYNERGY_TERMS.some(term => new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(text));
}

function computePhaseSynergy(asset, ctgov) {
  const phase = (asset.phase || '').toLowerCase();
  if (phase === 'preclinical' || phase.includes('preclinical')) return true;
  if (phase.includes('2/3') || phase.includes('ii/iii')) return true;
  if (phase === 'phase 3' || phase === 'phase iii' || phase === '3' || phase === 'iii') return true;
  if (!ctgov) return false;
  const phases = new Set(ctgov.phases || []);
  if (phases.has('PHASE2') && phases.has('PHASE3')) return true;
  if (phases.has('PHASE3')) return true;
  return false;
}

// Targets that qualify for checkpoint-IO-alt flag
const CHECKPOINT_ALT_TARGETS = ['lag-3', 'lag3', 'tim-3', 'tim3', 'tigit', 'ctla-4', 'ctla4', 'vista', 'btla', 'cd96', 'nkg2a'];

// Compute flags directly from Pharmcube Steps 1+2 asset data (no web research needed).
// Called automatically after every screening run — no manual autoflag step required
// for indication-synergy, phase-synergy, checkpoint-io-alt, or masked-tce-4-1bb (4-1BB arm).
// adc-novel-payload and TCE masking moiety still need manual autoflag (not in Pharmcube data).
function computeFlagsFromAsset(asset) {
  if (!asset || asset.overallStatus === 'excluded') return [];
  const flags = new Set();
  const targets = (asset.targets || []).map(t => (t || '').toLowerCase());
  const modality = (asset.modality || '').toLowerCase();
  const phase = (asset.phase || '').toLowerCase();

  // Indication synergy — keyword match on indication field
  if (matchesIndicationSynergy(asset.indication || '')) flags.add('indication-synergy');

  // Phase synergy — preclinical OR Phase 2/3 OR Phase 3
  if (phase === 'preclinical' || phase.includes('preclinical')) flags.add('phase-synergy');
  if (phase.includes('2/3') || phase.includes('ii/iii')) flags.add('phase-synergy');
  if (phase === 'phase 3' || phase === 'phase iii') flags.add('phase-synergy');

  // Strategic — checkpoint IO alt: non-PD1/PD-L1 checkpoint target, or bsAb/tsAb hitting PD-1/PD-L1
  const hasPD = targets.some(t => t.includes('pd-1') || t.includes('pd-l1') || t === 'pd1' || t === 'pdl1');
  const hasAltCheckpoint = targets.some(t => CHECKPOINT_ALT_TARGETS.some(c => t.includes(c)));
  const isBispecificPlus = ['bsab', 'tsab'].includes(modality);
  if (hasAltCheckpoint || (hasPD && isBispecificPlus)) flags.add('checkpoint-io-alt');

  // Strategic — 4-1BB arm (TCE or bsAb/tsAb engaging 4-1BB/CD137)
  const has41BB = targets.some(t => t.includes('4-1bb') || t.includes('cd137'));
  if (has41BB) flags.add('masked-tce-4-1bb');

  return Array.from(flags);
}

// Apply auto-flags to all qualifying assets in a screening result and bubble up to company level.
function applyAutoFlags(result) {
  if (!result || !result.assets) return result;
  const companyFlags = new Set(result.flags || []);
  for (const asset of result.assets) {
    const derived = computeFlagsFromAsset(asset);
    asset.flags = derived;
    derived.forEach(f => companyFlags.add(f));
  }
  result.flags = Array.from(companyFlags);
  return result;
}

// Strategic Synergy needs molecular detail (payload identity, masking moiety,
// exact checkpoint target) that the main screening pass doesn't always capture.
// Capped at 3 tool calls total — if nothing turns up, leave the flag unset
// rather than guessing (per the plan's Flagging Rule).
const STRATEGIC_FLAG_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  TOOLS.find(t => t.name === 'fetch_webpage'),
];

async function researchStrategicSynergy(company, asset, client) {
  const messages = [{
    role: 'user',
    content: `Determine if this oncology biologic asset qualifies for a "Strategic Synergy" flag.

Company: ${company.name}
Asset: ${asset.name || '(unnamed)'} — modality: ${asset.modality || 'unknown'}, targets: ${(asset.targets || []).join(', ') || 'unknown'}
Known indication: ${asset.indication || 'unknown'}
Existing research notes: ${asset.notes || company.researchNotes || '(none)'}
Company website: ${company.website || '(unknown)'}

Qualifies if ANY of:
1. masked-tce-4-1bb: a TCE with EITHER a masking/prodrug moiety (TME-cleavable, probody, conditional activation) OR engaging 4-1BB (CD137) as one of its targets.
2. adc-novel-payload: an ADC using a single payload OTHER than a TOP1 inhibitor (DXd/deruxtecan, SN-38, exatecan) or MMAE — e.g. DM1, DM4, PBD, calicheamicin, tubulysin, cryptophycin — OR a dual payload combination other than MMAE+TOP1.
3. checkpoint-io-alt: targets a T-cell checkpoint receptor OTHER than PD-1/PD-L1 (LAG-3, TIM-3, TIGIT, CTLA-4, VISTA, BTLA, CD96, NKG2A), OR targets PD-1/PD-L1 IN COMBINATION with another target.

BUDGET: at most 3 tool calls total. Look at the asset's own science/pipeline page or the
existing notes above first — only search if the specific molecular detail (payload identity,
masking moiety, exact checkpoint target) genuinely isn't there yet. If you still can't find
clear evidence after 3 calls, do NOT guess — return "none".

Return ONLY this JSON, nothing else:
{"flag": "masked-tce-4-1bb" | "adc-novel-payload" | "checkpoint-io-alt" | "none", "reason": ""}`
  }];

  const MAX_ITERATIONS = 5; // 3 tool calls + final JSON turn + 1 retry-nudge headroom

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        temperature: 0,
        tools: STRATEGIC_FLAG_TOOLS,
        messages,
      });
    } catch (e) {
      return null;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        messages.push({ role: 'user', content: 'Return ONLY the JSON object, no other text.' });
        continue;
      }
      try {
        const result = JSON.parse(jsonMatch[0]);
        return result.flag && result.flag !== 'none' ? result.flag : null;
      } catch (e) {
        return null;
      }
    }

    if (response.stop_reason === 'pause_turn') continue;

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUses) {
        let output;
        try {
          if (toolUse.name === 'fetch_webpage') {
            output = await fetchWebpage(toolUse.input.url, toolUse.input.section);
          } else {
            output = 'Unknown tool.';
          }
        } catch (e) {
          output = `Tool error: ${e.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: output });
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      return null;
    }
  }
  return null; // exhausted the budget without a clear answer — don't guess
}

// ─────────────────────────────────────────────────────────────
// Pharmcube primary track — Claude loop using drugBaseLiteCN + drugDeal + web tools
// Returns a full result object. If status=inconclusive and inconclusiveReason
// contains "not found in Pharmcube", the caller should run the secondary track.
// ─────────────────────────────────────────────────────────────

async function screenWithPharmcubePrimary(companyName, client) {
  const messages = [{
    role: 'user',
    content: `Screen this company through the Pharmcube primary track: "${companyName}"\n\nStart immediately by calling drugBaseLiteCN. Do not run web_search first.`,
  }];

  const MAX_ITERATIONS = 14;
  const collectedSources = [];
  const fetchedUrls = [];
  const evidenceSnapshots = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      temperature: 0,
      system: PHARMCUBE_PRIMARY_PROMPT,
      tools: PHARMCUBE_TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item && item.url) {
            collectedSources.push({ url: item.url, title: item.title || '' });
            evidenceSnapshots.push({
              type: 'search-result',
              url: item.url,
              title: item.title || '',
              retrievedAt: new Date().toISOString(),
              contentSnippet: item.snippet || item.description || null,
              contentHash: null,
            });
          }
        }
      }
    }

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        console.log(`    [${companyName}] [pharmcube] [warn] No JSON — requesting conversion`);
        messages.push({
          role: 'user',
          content: 'Return ONLY the JSON screening result now — no other text.',
        });
        continue;
      }

      const result = JSON.parse(jsonMatch[0]);
      result.name = companyName;
      result.id = slugify(companyName);
      result.sourceTrack = 'pharmcube';
      if (result.beoneAnalyzed == null) result.beoneAnalyzed = false;
      if (result.beoneOutcome  == null) result.beoneOutcome  = null;
      if (!Array.isArray(result.flags)) result.flags = [];
      result.allSourcesConsulted = [...new Set(fetchedUrls)];
      result.evidenceSnapshots = evidenceSnapshots;

      if (result.externalSourcing === true) {
        const sourceMap = new Map();
        for (const s of collectedSources) sourceMap.set(s.url, s);
        if (Array.isArray(result.externalSources)) {
          for (const s of result.externalSources) if (s && s.url) sourceMap.set(s.url, s);
        }
        result.externalSources = Array.from(sourceMap.values());
      } else {
        result.externalSourcing = false;
        result.externalSources = [];
      }

      return result;
    }

    if (response.stop_reason === 'pause_turn') {
      console.log(`    [${companyName}] [pharmcube] [pause_turn] iteration ${i + 1}/${MAX_ITERATIONS}`);
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`    [${companyName}] [pharmcube] [tool] ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 100)}`);
        let output;
        try {
          if (toolUse.name === 'drugBaseLiteCN' || toolUse.name === 'drugDeal') {
            output = await callPharmcubeTool(toolUse.name, toolUse.input);
          } else if (toolUse.name === 'fetch_webpage') {
            fetchedUrls.push(toolUse.input.url);
            output = await fetchWebpage(toolUse.input.url, toolUse.input.section);
            evidenceSnapshots.push(makeEvidenceSnapshot(toolUse.input.url, output));
          } else {
            output = 'Unknown tool.';
          }
        } catch (e) {
          output = `Tool error: ${e.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: output });
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  console.log(`    [${companyName}] [pharmcube] [warn] Hit MAX_ITERATIONS — returning inconclusive`);
  return {
    name: companyName,
    id: slugify(companyName),
    type: 'unknown',
    website: null,
    status: 'inconclusive',
    sourceTrack: 'pharmcube',
    excludedAt: null,
    excludedReason: '',
    inconclusiveReason: 'Pharmcube primary track hit iteration limit',
    assets: [],
    beoneAnalyzed: false,
    beoneOutcome: null,
    flags: [],
    externalSourcing: false,
    externalSources: [],
    researchNotes: '',
    allSourcesConsulted: [...new Set(fetchedUrls)],
    evidenceSnapshots,
  };
}

// ─────────────────────────────────────────────────────────────
// Step 0 — Big Pharma pre-filter (static list, instant, no research)
// ─────────────────────────────────────────────────────────────

const BIG_PHARMA = [
  'AbbVie', 'Amgen', 'AstraZeneca', 'Bayer', 'Bristol-Myers Squibb', 'BMS',
  'Eli Lilly', 'Lilly', 'Genentech', 'Roche', 'GlaxoSmithKline', 'GSK',
  'Johnson & Johnson', 'Janssen', 'Merck', 'MSD', 'Novartis', 'Pfizer',
  'Sanofi', 'Takeda', 'Boehringer Ingelheim', 'Astellas', 'Daiichi Sankyo',
  'Gilead', 'Regeneron', 'Biogen', 'Seagen',
];

function matchesBigPharma(companyName) {
  const normalizedQuery = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return BIG_PHARMA.find(name => {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalizedQuery.includes(normalizedName) || normalizedName.includes(normalizedQuery);
  }) || null;
}

// ─────────────────────────────────────────────────────────────
// Claude API call with tool loop
// ─────────────────────────────────────────────────────────────

async function screenWithClaude(companyName, client, websiteUrl = null, opts = {}) {
  const { skipPharmcube = false } = opts;
  // Step 0 first — instant, no research needed, per the plan. Skips the Claude
  // call entirely for an obvious Big Pharma match.
  const bigPharmaMatch = matchesBigPharma(companyName);
  if (bigPharmaMatch) {
    console.log(`    [${companyName}] [pre-filter] EXCLUDED — matches Big Pharma list: ${bigPharmaMatch}`);
    return {
      name: companyName,
      id: slugify(companyName),
      type: 'unknown',
      website: null,
      status: 'excluded',
      excludedAt: 'pre-filter',
      excludedReason: `Matches Big Pharma exclusion list (${bigPharmaMatch})`,
      inconclusiveReason: '',
      assets: [],
      beoneAnalyzed: false,
      beoneOutcome: null,
      flags: [],
      researchNotes: '',
    };
  }

  // ── PRIMARY TRACK: Pharmcube MCP ──────────────────────────────────────────────
  const pharmcubeApiKey = process.env.PHARMCUBE_API_KEY || process.env.pharmcube_api_key;
  if (pharmcubeApiKey && !skipPharmcube) {
    console.log(`    [${companyName}] [primary-track] Pharmcube MCP`);
    let pharmResult;
    try {
      pharmResult = await screenWithPharmcubePrimary(companyName, client);
    } catch (e) {
      console.log(`    [${companyName}] [pharmcube] [error] ${e.message} — falling through to secondary track`);
      pharmResult = null;
    }

    if (pharmResult) {
      // Only route to secondary if Pharmcube explicitly says "not found"
      const notFound = pharmResult.status === 'inconclusive' &&
        /not found in pharmcube/i.test(pharmResult.inconclusiveReason || '');

      if (!notFound) {
        applyAutoFlags(pharmResult);
        logScreeningBreakdown(pharmResult);
        console.log(`    [${companyName}] [FINAL] ${pharmResult.status} (pharmcube track)${pharmResult.excludedAt ? ' — excluded at ' + pharmResult.excludedAt : ''}${pharmResult.inconclusiveReason ? ' — ' + pharmResult.inconclusiveReason : ''}`);
        return pharmResult;
      }
      console.log(`    [${companyName}] [primary→secondary] Not in Pharmcube — falling through to web research`);
    }
  } else {
    console.log(`    [${companyName}] [secondary-track] No PHARMCUBE_API_KEY — using web research directly`);
  }
  // ──────────────────────────────────────────────────────────────────────────────
  // SECONDARY TRACK: full web research methodology (original public/private tracks)
  // Runs when: (a) company not found in Pharmcube, (b) no Pharmcube key configured,
  // or (c) Pharmcube threw an error.
  // ──────────────────────────────────────────────────────────────────────────────
  console.log(`    [${companyName}] [secondary-track] Web research methodology`);

  const messages = [
    {
      role: 'user',
      content: `Screen this company for a BeOne Medicines manufacturing partnership: "${companyName}"${websiteUrl ? `\n\nURL PROVIDED: The company's website is already known: ${websiteUrl}\nIn Step 0a, fetch this URL directly instead of running a web_search — skip the search entirely and go straight to fetch_webpage("${websiteUrl}").` : ''}

BUDGET: you have at most 6 tool calls total for this company (the external-sourcing fallback
in step 0a below has its own separate, additional sub-cap — see that step). Track your count.
If you're not confident by call 6, stop and return inconclusive rather than continuing to search.
Never end a turn with only a stated plan ("let me now search for X") — either make that tool
call in this same turn or return the JSON now. Do not narrate a next step without taking it.

CRITICAL: steps 0 through 3 below contain MANDATORY reads — the actual primary source for
Layers 1-4. You may NOT skip ahead to finalizing just because an earlier page (e.g. the
homepage from step 0a) felt informative enough. "Stop once confident" does not exist yet at
this point in the sequence — it only applies after step 3, see below.

STEP 0 — Big Pharma exclusion (instant, no research needed):
Match? → stop, excludedAt: "pre-filter", don't fetch anything.

STEP 0a — IDENTIFICATION ONLY (this is not your Layer 1-4 evidence source, just finding the company):
web_search("${companyName} biotech") ONCE. Fetch the top result, purely to confirm you've found
the right company and to locate its website/ticker/listing.
    - If it loads with real content, move on to 0b. Do not treat it as sufficient evidence for
      Layers 1-4 yet — that comes from the mandatory read in step 2 below, which is usually a
      different, more specific page.
    - If it's empty/unreadable (JS-rendered) or unclear, try AT MOST ONE more URL variation (drop "www" or try the bare domain).
    - If the company's own site still hasn't given you usable content after that: first check
      whether a US ticker or non-US listing signal (HKEX/SSE/SZSE) is visible just from the
      web_search snippets themselves, even without the page loading. If so, this is a public
      company — proceed to Step 1/2 normally, the SEC filing / listing doesn't depend on the
      marketing site working.
    - If there's no ticker/listing signal either (likely private — public companies' filings
      stay reliably accessible regardless of their marketing site): check AT MOST 2-3 sources,
      restricted to ONLY the company's own press releases (PR Newswire/Business Wire/
      GlobeNewswire), conference abstracts/journal papers authored by the company (AACR/ASCO/
      PubMed), or regulatory filings. Do NOT use sales lead-gen databases (ZoomInfo, LeadIQ),
      pharma intelligence aggregators (Crunchbase, Pitchbook, Bloomberg, aVenture, Patsnap
      Synapse), tax/equity directories (QSBS Expert), or generic explainer articles not
      specifically about this company — these are excluded outright, not just deprioritized.
    - If those 2-3 sources give you enough to evaluate Layers 1-2: proceed, set
      "externalSourcing": true, include "purple-flag" in "flags", and list the sources you
      used in "externalSources" (e.g. [{"url": "...", "note": "what it told you"}]).
    - If those 2-3 sources still leave you without enough: STOP. Do not keep searching, do not
      guess, do not fill gaps from weaker sources. Return status: "inconclusive",
      inconclusiveReason: "Website Input Needed" immediately — this company should cost no more
      than ~30 seconds of research; further digging isn't worth it.
    - SPECIAL CASE — website found but unreadable: if fetch_webpage returns "Page content appears
      empty (likely JavaScript-rendered)" or an HTTP error (403/429/timeout) for the company's
      main site AND the external sourcing fallback (press releases, abstracts) also fails to give
      enough for Layers 1-2, set inconclusiveReason: "Website Unreadable — JS-rendered or access
      blocked" (NOT "Website Input Needed"). This signals to the team that a URL isn't needed —
      the site exists, it just can't be read by the screener.

STEP 0b — Oncology pre-filter (quick scan, from whatever you fetched in 0a):
Confirm it's the right company. Does this company have ANY oncology program, anywhere on the
site? No oncology at all → stop, excludedAt: "pre-filter". Ambiguous or sparse → do not
exclude, continue below.

STEP 1 — Research track AND type label, from what you already have. These are independent:
"type" is just a classification (is it listed anywhere), while the research track below is
about which sources actually exist to read.
- US stock ticker explicitly stated → research track: SEC-FILING. Set "type": "public".
- HKEX listing signal (HKEX stock code, ".HK", "SEHK", HK exchange reference) → research track: HKEX-FILING. Set "type": "public".
- Other non-US listing (SSE/SZSE/TSX/ASX/other foreign exchange) → research track: IR-FILING. Set "type": "public".
- No listing signal at all → Set "type": "private". Research track: WEBSITE.

STEP 2 — MANDATORY PRIMARY-SOURCE READ (do this regardless of how confident you already feel — this is not optional):

Unified Layer 4 manufacturing escalation (used by ALL tracks when Layer 4 is ambiguous after
the primary-source read — stop as soon as you have a clear answer):
  L4-a: Fetch company newsroom / press releases page (/news, /press, /media) — 0 extra calls
         if already fetched for Layer 3, otherwise 1 fetch.
  L4-b: web_search: "${companyName}" (Lonza OR "WuXi Biologics" OR "Samsung Biologics" OR
         "Thermo Fisher" OR "Catalent" OR "Fujifilm Diosynth" OR "AGC Biologics") manufacturing
         + fetch top result if relevant.
  L4-c: web_search: "${companyName}" biologics manufacturing CDMO "United States" OR "US facility"
         + fetch top result if relevant.
  Default: PASS + add "check-mfg-partner" to flags[] if still unresolved after L4-c.
  Tag all Layer 4 escalation sources with usedFor: "Layer 4 manufacturing" in sources[].

- SEC-FILING track: call lookup_sec_filing(ticker) once, then fetch_webpage the result once
  (defaults to section "item1" — Business). This is your primary source for ALL of Layers 1-4
  in one read.
    - If Item 1 leaves Layer 3 (rights) or Layer 4 (manufacturing) genuinely ambiguous,
      fetch_webpage the SAME filing URL again with section: "item7" (MD&A) — one additional
      call, can resolve ambiguity on both layers at once.
    - If Layer 4 specifically (does the company own a US facility) is still unclear after that,
      fetch_webpage the SAME filing URL again with section: "item2" (Properties) — short
      section, fast read.
    - If Layer 4 is still ambiguous after item7 + item2 (10-Ks can be up to a year stale):
      run the unified Layer 4 escalation above (L4-a through L4-d).
    - Layer 3 ambiguity only: ONE web_search("${companyName} out-license OR partnership OR
      option rights terminated") — snippets only, no further fetch.

- HKEX-FILING track (HKEX-listed companies):
  Step A: web_search: "${companyName}" site:hkexnews.hk "annual report" 2024 OR 2025
    From the search results, identify the direct hkexnews.hk URL for the most recent annual
    report or annual results document. Count this as one search call.
  Step B: fetch_webpage that hkexnews.hk URL. This is your primary source for ALL of Layers 1-4,
    same role as Item 1 Business in a 10-K. Count this as one fetch.
  Step C: If Layer 3 or Layer 4 remain ambiguous after the annual filing:
    Layer 3: ONE web_search("${companyName} out-license OR partnership OR option rights terminated")
    Layer 4: run the unified Layer 4 escalation above (L4-a through L4-d).
  Fallback A: if the hkexnews.hk document is a PDF that doesn't render usable text, try
    fetching the company's Annual Results announcement (HTML) — usually also listed on hkexnews.hk
    for the same period. Count as one additional fetch.
  Fallback B: if no hkexnews.hk URL is found in Step A, fall through to IR-FILING track
    (company's own IR page) and note in researchNotes.

- IR-FILING track (other non-US-listed public companies — SSE/SZSE/TSX/ASX/etc.):
  Step A: fetch_webpage their IR / Investor Relations page (/investors, /ir, /investor-relations).
    Count this as one call.
  Step B: From the IR page, find the most recent annual report or equivalent filing link.
    Terms: Annual Report, Annual Results, 年報, 年度报告, Annual Review, Prospectus.
    Fetch that document — primary source for ALL of Layers 1-4. Count as one call.
  Step C: If Layer 3 or Layer 4 remain ambiguous:
    Layer 3: ONE web_search("${companyName} out-license OR partnership OR option rights terminated")
    Layer 4: run the unified Layer 4 escalation above (L4-a through L4-d).
  Fallback A: if the annual report is a PDF that doesn't render, fetch the Annual Results
    announcement HTML instead (linked from same IR page).
  Fallback B: if IR page fails to load or no annual report link found, fall through to
    WEBSITE track and note in researchNotes.

- WEBSITE track (private companies; fallback for non-US public when IR/annual report unreachable):
  fetch_webpage their dedicated pipeline / "Our Science" page once — NOT the homepage.
  (If step 0a already landed on that page, it counts — otherwise fetch it now.)
  This is your primary source for Layers 1-2. Do not finalize Layers 1-2 from the homepage alone.

STEP 3 — Layer 3/4 evidence (WEBSITE track only — other tracks covered this in step 2):
Layer 3 (rights): fetch_webpage their news/press page once and scan for rights-transfer keywords
  (license, out-license, divest, option, collaboration, terminated). Note whether any found
  agreement is fill & finish / drug product only (does not exclude) vs. drug substance (excludes).
  If Layer 3 still ambiguous: ONE web_search("${companyName} out-license OR partnership OR option
  rights terminated") — snippets only.

Layer 4 (manufacturing): run the unified Layer 4 escalation from Step 2 (L4-a through L4-c).
  L4-a (newsroom) may already be fetched from the Layer 3 scan above — 0 extra calls if so.

ONLY NOW does "stop once confident" apply: once steps 0-3 above are complete for your track,
the budget is a ceiling, not a target — the moment you have enough to answer confidently, stop
and return the JSON immediately rather than hunting for further confirmation beyond this.

★ GOLDEN RULE — ASSET-LEVEL PASS: If even ONE asset passes all layers, the company is
status="qualifying". A company is only excluded if ALL qualifying assets are eliminated across
all layers. Example: 13 assets screened out + 1 asset passes every layer → company QUALIFIES.
Never set status="excluded" while any single asset still has overallStatus="qualifying".

LAYER EVALUATION:
Evaluate Layers 1 → 2 → 5 → 3 → 4 in that order from whatever you've fetched in steps 0-3.
Layer 5 (competitive overlap) runs RIGHT AFTER Layer 2 — before you assess Layers 3 and 4. Assets that fail Layer 5 do not need Layer 3/4 assessed.
Do not make additional tool calls to firm up an answer — if something is genuinely unclear, mark that layer "inconclusive" and move on.
IMPORTANT: populate "assets" with EVERY individually named asset you saw — one object per named drug/program at any phase (Discovery, Preclinical, Lead Opt, IND-Enabling, Phase 1/2/3, Approved). Do not filter by phase. Do not collapse. Do not add tool calls for individual assets; extract all from pages already fetched.
Return the JSON screening result now.`
    }
  ];

  // Prompt states a 6-tool-call budget (plus up to 3 more in the external-sourcing
  // fallback); this allows headroom for that worst case plus the final JSON turn
  // and retry nudges for complex companies with multiple escalation paths.
  const MAX_ITERATIONS = 10;

  // Captured independently of Claude's self-reported "externalSources" — web_search
  // is resolved server-side by Anthropic, so the actual result URLs are sitting in
  // response.content on every turn whether or not Claude bothers to transcribe them.
  const collectedSources = [];

  // Server-side ground truth: every URL actually passed to fetch_webpage this run.
  // Stored as result.allSourcesConsulted so the recall track can re-fetch exactly
  // these pages without running any new web searches.
  const fetchedUrls = [];
  const evidenceSnapshots = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item && item.url) {
            collectedSources.push({ url: item.url, title: item.title || '' });
            evidenceSnapshots.push({
              type: 'search-result',
              url: item.url,
              title: item.title || '',
              retrievedAt: new Date().toISOString(),
              contentSnippet: item.snippet || item.description || null,
              contentHash: null,
            });
          }
        }
      }
    }

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        // Claude wrote prose instead of JSON (usually when it got uncertain
        // partway through) — give it one corrective nudge with what it said,
        // rather than discarding the reasoning and failing outright.
        console.log(`    [${companyName}] [warn] No JSON in response, asking Claude to convert: "${(textBlock ? textBlock.text : '').slice(0, 150)}"`);
        messages.push({
          role: 'user',
          content: 'That was not valid JSON. Based on everything you found above, return ONLY the JSON screening result now — no other text. If you could not determine something, use "inconclusive" for that field rather than explaining in prose.',
        });
        continue;
      }

      const result = JSON.parse(jsonMatch[0]);
      result.name = companyName;
      result.id   = slugify(companyName);
      result.sourceTrack = result.sourceTrack || 'secondary';
      if (result.beoneAnalyzed == null) result.beoneAnalyzed = false;
      if (result.beoneOutcome  == null) result.beoneOutcome  = null;
      if (!Array.isArray(result.flags)) result.flags = [];

      // Claude's own judgment call on whether the website itself was ever usable
      // drives externalSourcing — a search happening at all (e.g. step 0a finding
      // the site URL) shouldn't trip this on its own. But once externalSourcing
      // is true, fill out the citation list from what was actually collected
      // server-side, so it's complete even if Claude's own write-up missed some.
      if (result.externalSourcing === true) {
        const sourceMap = new Map();
        for (const s of collectedSources) sourceMap.set(s.url, s);
        if (Array.isArray(result.externalSources)) {
          for (const s of result.externalSources) if (s && s.url) sourceMap.set(s.url, s);
        }
        result.externalSources = Array.from(sourceMap.values());
        // purple-flag removed — externalSourcing is tracked but not surfaced as a flag
      } else {
        result.externalSourcing = false;
        result.externalSources = [];
      }

      // Deduplicated list of every URL actually fetched server-side during this run.
      // Used by the recall track to re-fetch the same pages without any web search.
      result.allSourcesConsulted = [...new Set(fetchedUrls)];
      result.evidenceSnapshots = evidenceSnapshots;

      return result;
    }

    // web_search is server-side now — Anthropic resolves it automatically and
    // includes results directly in response.content. If its internal search
    // loop hits its own iteration cap, the API returns pause_turn; just
    // re-send (assistant content already pushed above) to let it continue.
    // This previously logged nothing, making a long pause_turn chain (e.g.
    // open-ended name-variant searching) invisible until the iteration
    // budget silently ran out — log every occurrence now.
    if (response.stop_reason === 'pause_turn') {
      console.log(`    [${companyName}] [pause_turn] internal search loop continuing (iteration ${i + 1}/${MAX_ITERATIONS})`);
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`    [${companyName}] [tool] ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 80)}`);
        let output;
        try {
          if (toolUse.name === 'fetch_webpage') {
            fetchedUrls.push(toolUse.input.url);
            output = await fetchWebpage(toolUse.input.url, toolUse.input.section);
            evidenceSnapshots.push(makeEvidenceSnapshot(toolUse.input.url, output));
          } else if (toolUse.name === 'lookup_sec_filing') {
            const ticker = toolUse.input.ticker;
            const tickerCik = await findCikByTicker(ticker);
            if (!tickerCik) {
              output = `No SEC-registered company found for ticker "${ticker}". This may not be a US-listed ticker, or the ticker may be incorrect.`;
            } else {
              const tickerFilingUrl = await getLatestFilingUrl(tickerCik);
              console.log(`    [${companyName}] [edgar] ${ticker} → CIK ${tickerCik} → ${tickerFilingUrl || '(no 10-K/20-F on file)'}`);
              output = tickerFilingUrl
                ? `Filing found: ${tickerFilingUrl}`
                : `CIK ${tickerCik} found for ticker "${ticker}" but no 10-K/20-F on file.`;
            }
          } else {
            output = 'Unknown tool.';
          }
        } catch (e) {
          output = `Tool error: ${e.message}`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: output,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  // Exhausted the iteration budget without reaching end_turn+JSON — degrade
  // gracefully to inconclusive rather than throwing, same as every other
  // budget cap in this pipeline. This can happen if several conditional
  // escalation paths (external-sourcing fallback, named-CDMO search, name-
  // variant resolution, etc.) stack on one unusually hard company.
  console.log(`    [${companyName}] [warn] Hit MAX_ITERATIONS (${MAX_ITERATIONS}) without finishing — returning inconclusive.`);
  return {
    name: companyName,
    id: slugify(companyName),
    type: 'unknown',
    website: null,
    status: 'inconclusive',
    sourceTrack: 'secondary',
    excludedAt: null,
    excludedReason: '',
    inconclusiveReason: 'Hit iteration limit before finishing — likely several escalation paths stacked on this company. Re-run individually.',
    assets: [],
    beoneAnalyzed: false,
    beoneOutcome: null,
    flags: [],
    externalSourcing: false,
    externalSources: [],
    researchNotes: '',
  };
}

// ─────────────────────────────────────────────────────────────
// Layer-by-layer breakdown logging
// ─────────────────────────────────────────────────────────────

function logScreeningBreakdown(result) {
  const tag = `[${result.name}]`;
  const track = result.sourceTrack === 'pharmcube' ? 'pharmcube' : 'secondary (web research)';
  console.log(`    ${tag} [track] ${track}`);

  if (result.excludedAt === 'pre-filter') {
    console.log(`    ${tag} [pre-filter] EXCLUDED (Big Pharma) — ${result.excludedReason || ''}`);
    return;
  }
  console.log(`    ${tag} [pre-filter] passed — biotech/biopharma`);

  if (result.externalSourcing) {
    console.log(`    ${tag} [purple-flag] Not Sourced From Company Website — company website never loaded usable content`);
    (result.externalSources || []).forEach(s => console.log(`      ${tag} [source] ${s.url}${s.title ? ' — ' + s.title : ''}`));
  }

  if (!result.assets || result.assets.length === 0) {
    console.log(`    ${tag} No assets identified.${result.inconclusiveReason ? ' Reason: ' + result.inconclusiveReason : ''}`);
    return;
  }

  result.assets.forEach((asset, i) => {
    console.log(`    ${tag} Asset ${i + 1}/${result.assets.length}: ${asset.name} (${asset.modality || '?'})`);
    for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
      const l = asset[layer];
      if (l) console.log(`      ${tag} [${layer}] ${l.status}${l.reason ? ' — ' + l.reason : ''}`);
    }
    console.log(`      ${tag} [overall] ${asset.overallStatus}`);
  });

  // Layer 5 (direct competitor check) runs client-side in the browser —
  // it just compares modality+targets against BEONE_PIPELINE, no research needed.
  if (result.researchNotes) console.log(`    ${tag} [notes] ${result.researchNotes}`);
}

// ─────────────────────────────────────────────────────────────
// Build a human-readable console log string from a result object
// (same information as logScreeningBreakdown but returned as text
//  so it can be sent to the client and shown in the console modal)
// ─────────────────────────────────────────────────────────────

function buildScreenerLog(result) {
  const lines = [];
  const tag = `[${result.name}]`;

  if (result.recallTrack) {
    lines.push(`${'═'.repeat(50)}`);
    lines.push(`${tag} [RECALL TRACK] Served from repository`);
    lines.push(`${tag} Last full screen : ${(result.lastScreenedAt || '').slice(0, 10)}`);
    lines.push(`${tag} Delta scan date  : ${result.deltaScanDate || '—'}`);
    lines.push(`${tag} Delta findings   : ${result.deltaFindings || 'No material changes found'}`);
    lines.push(`${'═'.repeat(50)}`);
    lines.push('');
  }

  lines.push(`${tag} Status: ${result.status.toUpperCase()}`);
  if (result.sourceTrack) {
    const trackLabel = result.sourceTrack === 'pharmcube' ? 'Pharmcube MCP (primary)' : 'Web research (secondary)';
    lines.push(`${tag} [track] ${trackLabel}`);
  }

  if (result.excludedAt === 'pre-filter') {
    lines.push(`${tag} [pre-filter] EXCLUDED (Big Pharma) — ${result.excludedReason || ''}`);
    return lines.join('\n');
  }
  lines.push(`${tag} [pre-filter] passed — biotech/biopharma`);

  if (result.externalSourcing) {
    lines.push(`${tag} [purple-flag] Not Sourced From Company Website`);
    (result.externalSources || []).forEach(s =>
      lines.push(`  ${tag} [source] ${s.url}${s.title ? ' — ' + s.title : ''}`)
    );
  }

  if (result.website) lines.push(`${tag} [website] ${result.website}`);
  if (result.excludedSource) lines.push(`${tag} [excluded-source] ${result.excludedSource}`);

  if (!result.assets || result.assets.length === 0) {
    lines.push(`${tag} No assets identified.${result.inconclusiveReason ? ' Reason: ' + result.inconclusiveReason : ''}`);
    return lines.join('\n');
  }

  result.assets.forEach((asset, i) => {
    lines.push(`${tag} Asset ${i + 1}/${result.assets.length}: ${asset.name} (${asset.modality || '?'})`);
    for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
      const l = asset[layer];
      if (l) lines.push(`  ${tag} [${layer}] ${l.status}${l.reason ? ' — ' + l.reason : ''}`);
    }
    lines.push(`  ${tag} [overall] ${asset.overallStatus}`);
  });

  if (result.inconclusiveReason) lines.push(`${tag} [inconclusive] ${result.inconclusiveReason}`);
  if (result.researchNotes)      lines.push(`${tag} [notes] ${result.researchNotes}`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// API endpoint
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Run history endpoints
// ─────────────────────────────────────────────────────────────

app.post('/api/runs', async (req, res) => {
  try {
    const { companyCount } = req.body;
    const result = await pool.query(
      'INSERT INTO screening_runs (company_count) VALUES ($1) RETURNING id, created_at',
      [companyCount || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.id, r.created_at, r.company_count,
             COUNT(sc.id) FILTER (WHERE sc.status = 'qualifying')   AS qualifying,
             COUNT(sc.id) FILTER (WHERE sc.status = 'excluded')     AS excluded,
             COUNT(sc.id) FILTER (WHERE sc.status = 'inconclusive') AS inconclusive,
             COUNT(sc.id) AS actual_count
      FROM screening_runs r
      LEFT JOIN screened_companies sc ON sc.run_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/runs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const runRow = await pool.query('SELECT * FROM screening_runs WHERE id = $1', [id]);
    if (!runRow.rows.length) return res.status(404).json({ error: 'Run not found' });
    const companiesRow = await pool.query(
      'SELECT result_json FROM screened_companies WHERE run_id = $1 ORDER BY screened_at',
      [id]
    );
    res.json({ run: runRow.rows[0], companies: companiesRow.rows.map(r => r.result_json) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// API endpoint
// ─────────────────────────────────────────────────────────────

app.post('/api/screen', async (req, res) => {
  const { company, runId, websiteUrl, skipPharmcube } = req.body;
  if (!company) return res.status(400).json({ error: 'Missing company name' });

  const apiKey = req.headers['x-api-key'] ||
    process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured. Enter your key in the screener settings.' });

  console.log(`\n${'─'.repeat(60)}\n[${company}] Screening: ${company}${websiteUrl ? ` (URL: ${websiteUrl})` : ''}\n${'─'.repeat(60)}`);

  try {
    const client = new Anthropic({ apiKey, maxRetries: 5 });

    // ── Repository recall check ──────────────────────────────
    const recent = await lookupRecentScreening(company);
    if (recent) {
      const ageDays = Math.round((Date.now() - recent.screenedAt.getTime()) / 86400000);
      console.log(`    [${company}] [recall-track] Found in repository (screened ${recent.screenedAt.toISOString().slice(0,10)}, ${ageDays}d ago) — running delta scan`);
      const delta  = await deltaScreenWithClaude(company, recent.result, recent.screenedAt, client, websiteUrl || recent.result.website || null);
      const result = mergeWithDelta(recent.result, delta, recent.screenedAt);
      console.log(`    [${company}] [recall-track] Delta: ${result.deltaFindings}`);
      result.screenerLog = buildScreenerLog(result);
      if (runId) saveCompanyToDb(runId, result);
      return res.json(result);
    }
    // ────────────────────────────────────────────────────────

    const result = await screenWithClaude(company, client, websiteUrl || null, { skipPharmcube: !!skipPharmcube });
    applyAutoFlags(result);
    logScreeningBreakdown(result);
    console.log(`    [${company}] [FINAL] ${result.status}${result.excludedAt ? ' (excluded at ' + result.excludedAt + ')' : ''}${result.inconclusiveReason ? ' — ' + result.inconclusiveReason : ''}`);
    result.screenerLog = buildScreenerLog(result);
    if (runId) saveCompanyToDb(runId, result);
    res.json(result);
  } catch (err) {
    // Classify the error: transient (safe to re-run) vs. genuine failure.
    // Transient: 429/500/502/503/529 from Anthropic, explicit SDK error types,
    // or messages containing "overloaded" or "internal server error".
    const errType   = err.error?.type || '';
    const errStatus = err.status || 0;
    const errMsg    = err.message || '';
    const isTransient =
      errStatus === 429 || errStatus === 500 || errStatus === 502 ||
      errStatus === 503 || errStatus === 529 ||
      errType === 'overloaded_error' || errType === 'api_error' ||
      /rate.?limit/i.test(errMsg) ||
      /overloaded/i.test(errMsg) ||
      /internal server error/i.test(errMsg);
    console.error(`  [${company}] ✗ ${isTransient ? '(transient — safe to re-run) ' : ''}${errMsg}`);
    const errorResult = {
      name: company,
      id: slugify(company),
      type: 'unknown',
      website: null,
      status: 'inconclusive',
      excludedAt: null,
      excludedReason: '',
      inconclusiveReason: isTransient
        ? 'Anthropic API hiccup (rate limit/overload/server error) — re-run this company individually, not a research failure'
        : 'Screening error — see server console',
      assets: [],
      beoneAnalyzed: false,
      beoneOutcome: null,
      flags: [],
      researchNotes: errMsg,
    };
    errorResult.screenerLog = buildScreenerLog(errorResult);
    if (runId) saveCompanyToDb(runId, errorResult);
    res.json(errorResult);
  }
});

// ─────────────────────────────────────────────────────────────
// Auto-flag endpoint — "Flag High Priority Assets" button, run on-demand
// against already-screened companies, not part of the main /api/screen pass.
// ─────────────────────────────────────────────────────────────

app.post('/api/autoflag', async (req, res) => {
  const { company } = req.body;
  if (!company) return res.status(400).json({ error: 'Missing company' });

  const apiKey = req.headers['x-api-key'] ||
    process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured. Enter your key in the screener settings.' });

  console.log(`\n[autoflag] ${company.name}`);

  try {
    const client = new Anthropic({ apiKey, maxRetries: 5 });
    const STRATEGIC_IDS = ['masked-tce-4-1bb', 'adc-novel-payload', 'checkpoint-io-alt'];

    for (const asset of company.assets || []) {
      if (asset.overallStatus === 'excluded') continue;

      const flags = new Set(asset.flags || []);

      const ctgov = await lookupClinicalTrialsForAsset(company.name, asset.name);
      const indicationText = `${asset.indication || ''} ${(ctgov && ctgov.conditions || []).join(' ')}`;

      if (matchesIndicationSynergy(indicationText)) flags.add('indication-synergy');
      else flags.delete('indication-synergy');

      if (computePhaseSynergy(asset, ctgov)) flags.add('phase-synergy');
      else flags.delete('phase-synergy');

      STRATEGIC_IDS.forEach(id => flags.delete(id)); // recompute fresh each run
      const stratFlag = await researchStrategicSynergy(company, asset, client);
      if (stratFlag) flags.add(stratFlag);

      asset.flags = Array.from(flags);
      console.log(`    [autoflag] ${asset.name || '(unnamed)'}: ${asset.flags.join(', ') || '(none)'}`);
    }

    res.json(company);
  } catch (err) {
    console.error(`  [autoflag] ✗ ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Company repository — deduplicated view across all runs
// ─────────────────────────────────────────────────────────────

app.get('/api/repository', requireAuth, async (req, res) => {
  try {
    // Most recent screening result per company name
    const companiesResult = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (LOWER(company_name))
          id, company_name, status, excluded_at, excluded_reason,
          inconclusive_reason, screened_at, result_json
        FROM screened_companies
        ORDER BY LOWER(company_name), screened_at DESC
      )
      SELECT l.*,
        COALESCE(
          json_agg(
            json_build_object(
              'asset_name', sa.asset_name,
              'modality',   sa.modality,
              'pathway',    sa.pathway
            ) ORDER BY sa.id
          ) FILTER (WHERE sa.id IS NOT NULL),
          '[]'
        ) AS qualifying_assets
      FROM latest l
      LEFT JOIN screened_assets sa
        ON sa.company_id = l.id AND sa.screen_decision = 'screen_in'
      GROUP BY l.id, l.company_name, l.status, l.excluded_at,
               l.excluded_reason, l.inconclusive_reason, l.screened_at, l.result_json
      ORDER BY
        CASE l.status WHEN 'qualifying' THEN 0 WHEN 'inconclusive' THEN 1 ELSE 2 END,
        LOWER(l.company_name)
    `);
    res.json(companiesResult.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all run history (cascades to screened_companies and screened_assets)
app.delete('/api/runs', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM screening_runs');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Excel export endpoint — downloads asset-level data for a run
// ─────────────────────────────────────────────────────────────

const XLSX = require('xlsx');

app.get('/api/runs/:id/export', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const runRow = await pool.query('SELECT * FROM screening_runs WHERE id = $1', [id]);
    if (!runRow.rows.length) return res.status(404).json({ error: 'Run not found' });

    const companiesRow = await pool.query(
      `SELECT sc.id, sc.company_name, sc.status, sc.excluded_at, sc.excluded_reason,
              sc.inconclusive_reason, sc.screened_at
       FROM screened_companies sc WHERE sc.run_id = $1 ORDER BY sc.screened_at`,
      [id]
    );

    const assetsRow = await pool.query(
      `SELECT sa.company_id, sa.asset_name, sa.modality, sa.pathway, sa.indication,
              sa.is_platform, sa.screen_decision, sa.excluded_layer, sa.excluded_reason
       FROM screened_assets sa
       JOIN screened_companies sc ON sc.id = sa.company_id
       WHERE sc.run_id = $1
       ORDER BY sc.screened_at, sa.id`,
      [id]
    );

    const assetsByCompany = {};
    for (const a of assetsRow.rows) {
      if (!assetsByCompany[a.company_id]) assetsByCompany[a.company_id] = [];
      assetsByCompany[a.company_id].push(a);
    }

    const rows = [];
    for (const c of companiesRow.rows) {
      const assets = assetsByCompany[c.id] || [];
      if (assets.length === 0) {
        rows.push({
          'Company': c.company_name,
          'Company Status': c.status,
          'Excluded At': c.excluded_at || '',
          'Excluded Reason': c.excluded_reason || c.inconclusive_reason || '',
          'Asset Name': '',
          'Modality': '',
          'Pathway (Targets)': '',
          'Indication': '',
          'Platform Asset': '',
          'Screen Decision': '',
          'Excluded Layer': '',
          'Asset Excluded Reason': '',
          'Screened At': new Date(c.screened_at).toLocaleString(),
        });
      } else {
        for (const a of assets) {
          rows.push({
            'Company': c.company_name,
            'Company Status': c.status,
            'Excluded At': c.excluded_at || '',
            'Excluded Reason': c.excluded_reason || c.inconclusive_reason || '',
            'Asset Name': a.asset_name || '',
            'Modality': a.modality || '',
            'Pathway (Targets)': a.pathway || '',
            'Indication': a.indication || '',
            'Platform Asset': a.is_platform ? 'Yes' : 'No',
            'Screen Decision': a.screen_decision === 'screen_in' ? 'Screen In' : 'Screen Out',
            'Excluded Layer': a.excluded_layer || '',
            'Asset Excluded Reason': a.excluded_reason || '',
            'Screened At': new Date(c.screened_at).toLocaleString(),
          });
        }
      }
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
      { wch: 30 }, { wch: 14 }, { wch: 12 }, { wch: 40 },
      { wch: 28 }, { wch: 12 }, { wch: 24 }, { wch: 24 },
      { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 44 }, { wch: 20 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Screening Results');

    const runDate = new Date(runRow.rows[0].created_at).toISOString().slice(0, 10);
    const filename = `BeOne_Screener_Run${id}_${runDate}.xlsx`;

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ BeOne Screener running → http://localhost:${PORT}`);
  console.log(`  Open that URL in your browser (not the file directly)\n`);
});
