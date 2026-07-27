'use strict';

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const axios      = require('axios');
const cheerio    = require('cheerio');
const { Pool }  = require('pg');
const sql        = require('mssql');
const fs         = require('fs');
const path       = require('path');
let DefaultAzureCredential = null;
try { ({ DefaultAzureCredential } = require('@azure/identity')); } catch (_) {}
require('dotenv').config();

// Per-request log streaming — captures console.log output and forwards it as
// SSE events to the browser during live screening.
const { AsyncLocalStorage } = require('async_hooks');
const _screeningLogStore = new AsyncLocalStorage();
const _origConsoleLog = console.log;
console.log = (...args) => {
  _origConsoleLog(...args);
  const _cb = _screeningLogStore.getStore();
  if (_cb) _cb(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
};

// Dev DB doesn't support SSL; prod (Replit deployment) requires it
const pool = new Pool(
  process.env.REPLIT_DEPLOYMENT ? { ssl: { rejectUnauthorized: false } } : {}
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Schema bootstrap - idempotent, safe to re-run on every start
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DB helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * For a single asset, determine whether it screens in or out and which
 * layer caused the exclusion.
 * Layer order: 1=oncology, 2=modality, 3=comp overlap, 4=rights, 5=manufacturing.
 */
function assetScreenDecision(asset) {
  for (const layer of ['layer1', 'layer2', 'layer3', 'layer4', 'layer5']) {
    if (asset[layer] && asset[layer].status === 'fail') {
      return { decision: 'screen_out', layer, reason: asset[layer].reason || '' };
    }
  }
  if (asset.overallStatus === 'excluded') {
    return { decision: 'screen_out', layer: null, reason: '' };
  }
  return { decision: 'screen_in', layer: null, reason: '' };
}

// Strips non-target descriptors from a targets array returned by Claude.
// Mirrors the client-side normalizeTarget logic so DB, autoflag, and display
// all agree on what counts as a real molecular target.
const _NON_TARGET_EXACT_SVR = new Set([
  'Undisclosed','Unknown','TBD','TAA','Various','Multiple',
  'Antigen','Receptor','Tumor antigen','Tumor Antigen','Cancer antigen',
  'Tumor Associated Antigen','Tumor-Associated Antigen',
  'tumor-associated antigen','tumor associated antigen',
  'Cell surface','Cell Surface','Surface antigen',
  'Immune checkpoint','Checkpoint','Cytokine','Payload','Warhead',
  'Undisclosed Target','Proprietary Target',
]);
const _NON_TARGET_PATTERNS_SVR = [
  /^undisclosed$/i,
  /\b(tumor|tumour)\b/i,
  /cell[\s-]?surface/i,
];
function cleanTargetArray(targets) {
  if (!Array.isArray(targets)) return targets;
  return targets.filter(t => {
    if (!t || !t.trim()) return false;
    const s = t.trim();
    if (_NON_TARGET_EXACT_SVR.has(s)) return false;
    if (_NON_TARGET_PATTERNS_SVR.some(re => re.test(s))) return false;
    return true;
  });
}

/**
 * Insert one screened_companies row (with RETURNING id) then, for each
 * asset that Claude returned, insert a screened_assets row.
 *
 * Company-level exclusions (pre-filter / layer1 / layer4) often have no
 * assets in the result - in that case the assets loop is a no-op and the
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
          cleanTargetArray(asset.targets || []).join(', ') || null,
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Passkey auth - simple token-in-cookie gate
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const AUTH_TOKENS = new Set();   // in-memory; wiped on restart (forces re-login)

function requireAuth(req, res, next) {
  const passkey = process.env.SITE_PASSKEY;
  if (!passkey) return next();  // no passkey configured â†' open access
  const token = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith('beo_auth='));
  const val = token ? token.slice('beo_auth='.length) : null;
  if (val && AUTH_TOKENS.has(val)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// POST /api/auth/login  { passkey }  â†' sets cookie
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
    `beo_auth=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${60 * 60 * 24 * 7}`
  );
  res.json({ ok: true });
});

// GET /api/auth/check - returns 200 if authed, 401 if not
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tools available to Claude during screening
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TOOLS = [
  // Native, server-side - Anthropic runs the search on its own infrastructure.
  // Resolved automatically; never hits our tool_use branch below. Using the
  // older 20250305 version deliberately - 20260209 supports dynamic filtering,
  // which requires tracking a code-execution container_id across turns; we
  // don't thread that through our loop, so it 400s once filtering kicks in.
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
  {
    name: 'fetch_webpage',
    description: 'Fetch and read the text content of a specific webpage URL - the company website, its pipeline/news pages, or a known structured URL (ClinicalTrials.gov API, SEC EDGAR). For a SEC filing URL you already fetched once, you can re-fetch the SAME url with a different "section" to jump elsewhere in the document instead of re-reading from the start.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
        section: {
          type: 'string',
          enum: ['item1', 'item7', 'item2'],
          description: 'SEC filings only: which section to jump to - item1 = Business (default), item7 = MD&A (rights/manufacturing fallback), item2 = Properties (own-facility check). Ignored for non-SEC URLs.'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'lookup_sec_filing',
    description: 'Given a US stock ticker symbol found on the company\'s own website, look up their exact CIK and return the direct URL to their most recent 10-K/20-F filing. Only call this with a ticker you actually found stated on the website - do not guess one.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'US stock ticker symbol, e.g. "CPRX"' }
      },
      required: ['ticker']
    }
  }
];

// Website input track - fetch_webpage + OneBD only. No web_search.
// Used when re-screening a company that was not found in Citeline.
const WEBSITE_INPUT_TOOLS = [
  TOOLS.find(t => t.name === 'fetch_webpage'),
  TOOLS.find(t => t.name === 'onebd_resolve_company'),
  TOOLS.find(t => t.name === 'onebd_get_deals'),
  TOOLS.find(t => t.name === 'onebd_resolve_asset'),
].filter(Boolean);

// Website search track — web_search (max 3) + fetch_webpage + OneBD. Used when no URL provided.
const WEBSITE_SEARCH_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  TOOLS.find(t => t.name === 'fetch_webpage'),
  TOOLS.find(t => t.name === 'onebd_resolve_company'),
  TOOLS.find(t => t.name === 'onebd_get_deals'),
  TOOLS.find(t => t.name === 'onebd_resolve_asset'),
].filter(Boolean);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Citeline primary track tools - Steps 1+2 come from SQL; Steps 4+5 use OneBD
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CITELINE_TOOLS = [
  {
    name: 'fetch_webpage',
    description: 'Fetch and read the text content of a specific webpage URL - use for the company pipeline/about page when thin-coverage enrichment is needed.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'onebd_resolve_company',
    description: [
      'Resolve a company name to an OneBD Cortellis company record.',
      'Call this ONCE before onebd_get_deals - it returns the company_id needed for deal lookup.',
      'If the company is not found, treat as "no Cortellis deal history" and proceed to Step 5 with no deals.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        companyName: { type: 'string', description: 'Company name to look up (English)' },
      },
      required: ['companyName'],
    },
  },
  {
    name: 'onebd_get_deals',
    description: [
      'Fetch all Cortellis deals for a company from OneBD. Use the company_id returned by onebd_resolve_company.',
      'Returns deals with title, date, summary, assets, territories, values, and parties.',
      'Call this ONCE per company. Results are reused for both Step 4 (licensing) and Step 5 (manufacturing).',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        companyId: { type: 'number', description: 'OneBD company_id (integer) returned by onebd_resolve_company' },
      },
      required: ['companyId'],
    },
  },
  {
    name: 'onebd_resolve_asset',
    description: [
      'Resolve a drug/asset name to an OneBD canonical asset record, returning an asset_id.',
      'Call it for BOTH names (the deal asset name AND the Citeline asset name). If both return the same',
      'asset_id, they are confirmed as the same molecule and the deal applies. If IDs differ, they are',
      'different assets and the deal does NOT apply to that Citeline asset.',
      'Only call this when a deal with licensing or manufacturing exclusion keywords is found.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        assetName: { type: 'string', description: 'Drug or asset name to resolve (code name, INN, or brand name)' },
      },
      required: ['assetName'],
    },
  },
];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Screening methodology system prompt
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SYSTEM_PROMPT = `
You are a pharmaceutical business development analyst screening companies as potential biologics manufacturing partners for BeOne Medicines' Hopewell, NJ facility.

OBJECTIVE: Identify oncology biologics companies that lack US biologics manufacturing capacity or a US CDMO relationship. These are manufacturing partnership opportunities.

You have three tools: web_search (locate the company and its website, and later for
manufacturing/licensing press releases not on the company's own site), fetch_webpage (fetch a
specific URL), and lookup_sec_filing (given a US ticker symbol you found stated on the
company's website, returns the exact URL of their most recent 10-K/20-F).

IMPORTANT - identification vs. evidence are two separate steps, not one. Finding the company's
website with web_search (and confirming it's the right company / has an oncology program) is
identification only - it is NOT automatically your evidence source for Layers 1-4. The actual
primary source for Layers 1-4 is a specific page you must separately locate and read, and which
one depends on the RESEARCH TRACK, not just the "type" label:
- SEC-FILING track (US-listed public companies only): their most recent 10-K/20-F filing, via
  lookup_sec_filing - "Item 1. Business" (or equivalent) covers oncology relevance, modality,
  rights, and manufacturing in one read.
- IR-FILING track (non-US-listed public companies - HKEX/SSE/SZSE/TSX/ASX/etc.): their
  IR / Investor Relations page â†' most recent annual report or equivalent filing (å¹´å ±, å¹´åº¦æŠ¥å'Š,
  Annual Results, etc.) â†' Business/Operations section of that document. This is the primary
  source for all four layers, equivalent in role to Item 1 Business in a 10-K. Fall back to
  WEBSITE track only if the IR page or annual report cannot be reached.
- WEBSITE track (private companies; fallback for non-US public when IR/annual report unreachable):
  their dedicated pipeline / "Our Science" page - not the homepage. A homepage mentioning a
  lead candidate is not a substitute for actually reading the pipeline page.
You may never skip this mandatory read just because an earlier page (e.g. the homepage) felt
sufficient - see the per-company instructions for exactly when "stop once confident" is and
isn't allowed to apply.
If the primary source leaves a layer genuinely ambiguous, ClinicalTrials.gov can help on
indication/modality: https://clinicaltrials.gov/api/v2/studies?query.spons=COMPANY+NAME&pageSize=10&format=json

RELEVANT MODALITIES (CHO/mammalian cell culture - these qualify):
mAb, bsAb, tsAb, ADC, TCE (T-cell engager, CD3-containing), NKCE (NK cell engager), Fc-fusion, Immunocytokine (cytokine fused to antibody/Fc for tumor targeting)
Always normalize to exactly these terms - e.g. write "mAb", never "msAb" (monospecific antibody
is the same thing as mAb). Downstream competitor-matching does exact string comparison, so an
unnormalized synonym silently breaks that check.

EXCLUDED MODALITIES (different manufacturing - do not qualify):
Cell therapy (CAR-T, CAR-NK, TCR-T including allogeneic), LNP/mRNA biologics, yeast/microbial proteins (nanobodies, VHH, scFv), peptide therapeutics, small-molecule conjugates

PRE-FILTERS - run before any layer evaluation, for every company:

STEP 0: Big Pharma exclusion (instant, no research needed)
Exclude immediately: AbbVie, Amgen, AstraZeneca, Pfizer, Roche, Genentech, Merck/MSD, Novartis, BMS, Sanofi, GSK, Eli Lilly, Takeda, Bayer, Gilead, Regeneron, Biogen, Daiichi Sankyo, Astellas, Boehringer Ingelheim, J&J/Janssen
â†' excludedAt: "pre-filter"

STEP 0b: Oncology pre-filter (quick scan, company-level - distinct from Layer 1's asset-level detail)
No oncology program anywhere in the company â†' excludedAt: "pre-filter"
At least one oncology program â†' proceed to Layers 1-4
Ambiguous or sparse source â†' do NOT exclude, fall through to Layers 1-4

SCREENING LAYERS - evaluate in order only after both pre-filters pass, stop at first failure:

LAYER 1 - Oncology Relevance
Pass: at least one asset targets a cancer indication
Fail: no oncology programs â†' excludedAt: "layer1"

LAYER 2 - Modality Confirmation
Pass: has mAb/bsAb/tsAb/ADC/TCE/NKCE/Fc-fusion/Immunocytokine in CHO/mammalian expression
Fail: only excluded modalities â†' excludedAt: "layer2"
Platform record: if site describes a general oncology biologic platform without named candidates, create one asset with isPlatform: true
Note: a mixed-modality pipeline (mostly small molecules but with some ADCs/mAbs) still passes if any qualifying asset exists. A company is only excluded at Layer 2 if NONE of its assets qualify.

PARTIAL CONTRIBUTOR EDGE CASE - screen out at Layer 2 any asset where the screened company does NOT manufacture the biologic drug substance (cell line / protein expression). This applies when:
- The company provides only the small molecule component of a biologic (e.g. ADC payload/warhead provider - they supply the toxin, not the antibody)
- The company provides only AI/computational drug discovery support for a biologic partnership (no wet lab, no cell line, no protein production)
- The company provides only fill & finish / formulation / drug product (no drug substance / upstream bioreactor work)
- The company is a clinical CRO, regulatory consultant, or platform licensor only
Set layer2: fail, reason: "Company role is [X] only - does not manufacture biologic drug substance (cell line/protein expression)". Do NOT screen out co-developers who share manufacturing responsibilities or who have a manufacturing arm alongside their contribution.

ENUMERATE ALL ASSETS - list every individually named asset from the pipeline page as a separate asset object regardless of phase. Discovery, Preclinical, Lead Opt, IND-Enabling, Phase 1/2/3, Approved - all are included. If the table has 10 rows, output 10 objects. Do NOT filter by phase, do NOT collapse the pipeline into one representative asset, do NOT summarize as "several mAbs". Extract all rows from what you already fetched - do not make extra tool calls per asset.

LAYER 3 - Competitive Overlap (evaluate HERE, immediately after Layer 2, BEFORE Layers 4 and 5)
Check each qualifying asset against the BeOne pipeline. Assets that are direct competitors are eliminated here so you do not waste research on their rights or manufacturing status.

BEONE PIPELINE (modality + NCI-normalized targets):
  mAb   / PD-1
  bsAb  / HER2               â† HER2 SPECIAL RULE
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
  HER2 "contains" rule: HER2 anywhere in the candidate's target list â†' competitive overlap with BeOne HER2 bsAb, regardless of modality or co-targets.
  All others - exact multiset rule: candidate's modality AND full target set must exactly match a BEONE_PIPELINE entry. Partial overlap (one shared target of several, or same targets but different modality) does NOT match.

Per asset:
  Match â†' layer3: { status: "fail", reason: "Competitive overlap: matches BeOne [name] ([modality]/[targets])" }, overallStatus: "excluded". Do NOT evaluate Layers 4+5 for this asset.
  No match â†' layer3: { status: "pass", reason: "No competitive overlap with BeOne pipeline" }. Proceed to Layer 4.
  Platform-level record (no target) â†' layer3: { status: "inconclusive", reason: "No target - not applicable" }. Proceed to Layer 4.

LAYER 4 - Rights Retained
Pass: company retains global or US rights for its qualifying assets
Fail: global or US rights out-licensed via license deal, asset sale, or option
Note: ex-US licensing only = still PASSES. A headline out-licensing deal for one asset does not mean all assets are out-licensed - if the company has other unlicensed qualifying assets, those still pass.

LAYER 5 - US Manufacturing Screen
Pass: no US drug substance manufacturing solution found for this asset
Fail: has an active, asset-specific US CDMO relationship for drug substance manufacturing, OR owns a US biologics facility used for drug substance production â†' excludedAt: "layer5"

RULE A - Drug substance only. BeOne's focus is drug substance (DS) manufacturing:
bioreactor cell culture, upstream processing, fermentation, downstream processing, purification,
bulk drug substance production. Fill & finish (F&F), formulation, vialing, labeling, packaging,
finishing, and drug product (DP) steps handled by a separate contract organization do NOT
constitute a manufacturing exclusion - those are downstream of what BeOne does. If a CDMO
relationship is explicitly described as fill & finish or drug product only â†' PASS Layer 4.
If it is genuinely unclear whether a CDMO is doing DS or F&F â†' default to PASS, note in researchNotes.

RULE B - Asset-level scope. A CDMO agreement covers only the specific asset it names.
If a company has Asset A with a US DS CDMO and Asset B with no CDMO mentioned:
â†' Asset A fails Layer 4; Asset B passes Layer 4. Never fail all of a company's assets
because one asset has a manufacturing partner. Only set excludedAt: "layer4" at the company
level if every qualifying asset fails Layer 4.

RULE C - Recency and active status. Only rely on evidence from the two most recent annual
filings (10-K or 20-F) or, for private companies, content from the last ~2 years. An agreement
mentioned only in older documents that does not appear in either of the two most recent filings
may have expired or been terminated - treat as PASS, note in researchNotes. If a termination,
expiration, or non-renewal is explicitly documented â†' PASS. Agreements that renew on a fixed
cycle (e.g. every 3 years) must be confirmed active in a recent filing to count as a fail.

RULE D - Source required. Every Layer 4 fail MUST have the exact URL of the filing or press
release confirming the active DS agreement in the layer's "source" field. A Layer 4 fail
with no source is not valid - if you cannot cite a specific recent document, default to PASS.

Named US CDMOs (drug substance operations): Lonza US, Samsung Biologics US, WuXi Biologics US,
Thermo Fisher Biologics, Fujifilm Diosynth US, Catalent Biologics, Rentschler US, AGC Biologics US,
Patheon (drug substance operations only - Patheon fill & finish does not count).
Own US biologics facility (drug substance scale): excluded only if â‰¥200L bioreactor capacity
confirmed. If capacity unstated â†' PASS, note in researchNotes.
Default if ambiguous, budget exhausted, or time runs out: PASS for that asset, add "check-mfg-partner" to company-level flags[]. Never return inconclusive on Layer 5 alone - the company still qualifies. Only exclude if clearly disclosed.

RULES:
- Return ONLY valid JSON at the end - no text before or after it
- Every response you send must end with either a tool call or the final JSON object - never
  both-less. If you write text describing what you found ("the website loaded, I can see X..."),
  that description is not a complete response by itself - immediately continue in the SAME
  response with your next tool call or the final JSON. Stopping after only a description, with
  no tool call and no JSON, is invalid and wastes a full extra turn correcting it.
- Assess Layer 3 (competitive overlap) immediately after Layer 2 - BEFORE Layers 4+5. Assets that fail Layer 3 skip Layers 4+5 entirely.
- ENUMERATE ASSETS: list every individually named asset as its own object in "assets" regardless of phase (Discovery/Preclinical/Lead Opt/IND-Enabling/clinical/approved - all count). Never collapse, never filter by phase, never write "several mAbs". Read the pipeline page once and extract all rows; do not make extra tool calls per individual asset.
- If after all searching you cannot find reliable information: status = "inconclusive", inconclusiveReason = "Website Input Needed"
- Be specific in reasons - cite what you found (e.g. "Lonza US manufacturing agreement announced March 2024 per press release")
- Whenever a specific page/filing/press release is the actual basis for a layer's pass/fail
  (especially Layer 4 rights and Layer 5 manufacturing - the layers that actually drive
  exclusions), put that exact URL in that layer's "source" field. If the company is excluded
  at the company level (excludedAt set), put the URL behind that reason in "excludedSource"
  too. Leave "source"/"excludedSource" empty if there genuinely isn't a single page it came
  from (e.g. a Big Pharma pre-filter match, or a judgment call from general site browsing) - 
  don't invent a URL just to fill the field.
- Use NCI-standard target names (PD-1 not PD1, HER2 not ERBB2)
- If the company is based in Greater China (mainland China, Hong Kong, Taiwan) or has a
  Chinese-language name: spend AT MOST 1 extra tool call specifically trying to find name
  variants (Chinese legal name, exchange-listing/rebrand name) - usually visible on the
  homepage or an /about page you've likely already fetched, so this is often already known
  without any extra call. If a variant surfaces, reuse it in later searches this turn. If
  nothing surfaces within that 1 extra call, proceed with the name you have - do not keep
  searching for name variants, this is a minor enhancement, not worth burning your budget on.
- If the company's own website never loaded usable content and a likely-private company had to rely on external sources instead (press releases, conference abstracts, regulatory filings ONLY - never sales databases or generic explainers): set "externalSourcing": true and include "purple-flag" in "flags" once you have enough from at most 2-3 such sources. If those 2-3 sources aren't enough, do not keep digging - return "inconclusive" instead (see step 0a). This is a stricter, speed-first policy: don't fill gaps, don't guess, keep this company under ~30 seconds of research.

REQUIRED JSON OUTPUT:
{
  "name": "company name as given",
  "type": "public" | "private" | "unknown",
  "website": "url or null",
  "status": "qualifying" | "excluded" | "inconclusive",
  "excludedAt": null | "pre-filter" | "layer1" | "layer2" | "layer4" | "layer5",
  "excludedReason": "",
  "excludedSource": "url or empty string - the specific page/filing/press release that is the basis for excludedReason, if there is one (leave empty for a Big Pharma pre-filter match, there's no source for that)",
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
      "layer3": { "status": "pass|fail|inconclusive", "reason": "" },
      "layer4": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "layer5": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "overallStatus": "qualifying|excluded",
      "notes": "",
      "sources": [],
      "flags": []
    }
  ],
  "deals": [
    {
      "title": "deal title from Cortellis",
      "date": "YYYY-MM-DD or YYYY",
      "partner": "counterparty company name",
      "type": "licensing|manufacturing|collaboration|option|acquisition|other",
      "territory": "Global|US|Ex-US|China|unspecified|...",
      "scope": "all|modality-group|specific-asset|company-level",
      "modalityGroup": "bsAb|TCE|ADC|mAb|Fc-fusion|tsAb or null",
      "assetNames": ["named assets if scope=specific-asset, else empty array"],
      "relevance": "rights|manufacturing|collaboration|equity|other",
      "summary": "one-line deal summary"
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
      "usedFor": "which layer(s) or criteria this URL informed (e.g. 'Layer 1â€“2 modality/indication', 'Layer 5 manufacturing screen')",
      "type": "filing | company-website | press-release | external"
    }
  ]
}

SOURCES ARRAY - populate "sources" at the company level with EVERY URL you actually opened
(via fetch_webpage) or used as evidence (from a web_search result snippet). This includes:
- The company's own website / pipeline page / IR page â†' type "company-website"
- SEC filings, annual reports, 20-F / prospectus PDFs â†' type "filing"
- The company's own press releases (on their domain or a PR newswire from them) â†' type "press-release"
- Any third-party URL (news, databases, a CDMO's own site, etc.) â†' type "external"
Do NOT include URLs you fetched but found completely empty/unreadable. Include every URL
that contributed any information to your assessment. Populate "usedFor" with which layer(s)
or pre-filter step the source supported (e.g. "Layer 1â€“2 oncology/modality", "Layer 5 manufacturing",
"Pre-filter: oncology confirmation", "Identification / website search").
This field is REQUIRED - populate it for every company, even if the only source is the company website.

FLAGS - Claude sets these automatically:
  "purple-flag" - set when externalSourcing is true (data from web_search/press/third-party
    rather than the company's own site).
  "check-mfg-partner" - set when Layer 5 manufacturing is ambiguous, budget is exhausted
    without a clear answer, or the screen could not confirm/deny a US manufacturing partner
    for at least one qualifying asset. Company still screens IN when this flag is set.
indication-synergy, phase-synergy, checkpoint-io-alt, and masked-tce-4-1bb are auto-computed
server-side from asset data after screening - do not set these yourself.
adc-novel-payload now also auto-detected from drugOverview when payload text is clear.
`.trim();

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Base prompt - Steps 3+4+5 logic shared by all tracks.
// Each track prepends its own header + Steps 1+2 instructions.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const BASE_STEPS_345_PROMPT = `
â•â•â• STEP 3 - COMPETITIVE OVERLAP (no API call - pure data check, run immediately after Steps 1+2) â•â•â•

Before making any further API calls, check each qualifying asset from Steps 1+2 against the BeOne pipeline below. This eliminates direct competitors cheaply before the expensive licensing and manufacturing checks.

BEONE PIPELINE (modality + NCI-normalized targets):
  mAb   / PD-1
  bsAb  / HER2                    â† HER2 SPECIAL RULE (see below)
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
  HER2 "contains" rule: if HER2 appears ANYWHERE in the candidate asset's target list â†' competitive
  overlap with BeOne HER2 bsAb, regardless of modality or other co-targets.

  All other targets - exact multiset rule: the candidate's modality AND full target set must exactly
  match a BEONE_PIPELINE entry (same modality, same targets in any order, same count).
  Partial overlap (one shared target out of several, or same targets but different modality) does NOT match.

  Examples:
    mAb / PD-1               â†' MATCH (exact)
    bsAb / HER2 + PD-1       â†' MATCH (HER2 contains rule)
    ADC / EGFR + MET + MET   â†' MATCH (exact)
    TCE / CD3 + CD19         â†' MATCH (exact)
    mAb / EGFR               â†' NO match (EGFR alone not in pipeline as mAb)
    ADC / HER2               â†' MATCH (HER2 contains rule)
    TCE / CD3 + PD-L1        â†' NO match (exact rule - not in pipeline)

OUTCOMES per asset:
 - Match â†' set layer3: { status: "fail", reason: "Competitive overlap: matches BeOne [name] ([modality]/[targets])" }
    set overallStatus: "excluded". Do NOT run Steps 4+5 for this asset.
 - No match â†' asset continues to Step 4
 - Platform-level record (no target) â†' Step 3 not applicable, asset continues to Step 4

If ALL qualifying assets are eliminated here â†' excludedAt="step3", status="excluded"
If â‰¥1 asset passes â†' proceed to Step 4 with passing assets only

â•â•â• STEPS 4 + 5 - Licensing & Manufacturing Check (OneBD Cortellis deals) â•â•â•

MANDATORY CALL SEQUENCE:
1. onebd_resolve_company(companyName) â†' company_id
  - If not found: no Cortellis history. All passing assets pass both Steps 4 and 5. Output deals:[] and go straight to JSON.
2. â˜… YOU MUST call onebd_get_deals(company_id) immediately after resolve returns found:true.
   â˜… NEVER produce JSON output before calling onebd_get_deals. This call is not optional.
  - Returns all company-level Cortellis deals with title, date, summary, assets[], territories[], values[], parties[].

DEALS ARRAY - populate deals[] in the JSON output with EVERY deal related to cancer biologics:
  Include: licensing deals, manufacturing/CDMO agreements, collaborations, options, co-development, acquisitions
    that involve oncology assets or biologic programs.
  Exclude: purely financial deals (debt, equity raises with no asset component), non-oncology deals,
    non-biologic small molecule deals.
  Set scope to:
    "specific-asset" - deal names one or more individual assets/compounds by name â†' set assetNames[]
    "modality-group" - deal covers a program type (e.g. "bsAb program", "ADC franchise") â†' set modalityGroup
    "all"            - deal covers entire pipeline or all biologics
    "company-level"  - collaboration, equity, platform deal with no specific asset or modality scope
  ALL cancer biologic deals go into deals[] regardless of whether they cause asset exclusion.

ASSET MATCHING - only needed for deals that scope to a specific asset or modality group:

  Step A - for deals where scope = "modality-group" OR deal.assets[] is EMPTY:
  Check the title and summary for a modality or program-category description using the keyword
  mapping below. Apply the deal to ALL qualifying assets of the matching modality type.
  No tool call needed. For Step 5 manufacturing deals: set layer5: fail for every asset of that
  modality type (e.g. "bsAb mfg partner" â†' layer5: fail on ALL bsAb assets in the pipeline).

  FUTURE-SCOPE EXCEPTION: If the deal title or summary contains language indicating it covers only
  future or next-generation assets -- e.g. "next generation", "next-gen", "next-generation",
  "future assets", "future programs", "future pipeline", "future candidates", "to be developed",
  "arising from", "newly developed", "future collaboration targets", "options on future" -- then
  the deal does NOT apply to existing named assets already in the Citeline pipeline. Existing
  assets of that modality type PASS Step 4 despite the deal. Note in researchNotes:
  "Deal '[title]' covers future/next-gen [modality] only -- existing assets not in scope. Pass."


  Step B â€” for deals where scope = "specific-asset" and deal.assets[] lists named compounds:
  Match using the asset's drugId, primary name, AND altNames (synonym list from Citeline).
  For each name in deal.assets[]:
    1. Check against asset.name and every entry in asset.altNames (brand names, INNs, research codes).
       If ANY altName matches the deal asset name (case-insensitive) â†' confirmed match â†' apply deal.
    2. Only if altName matching is genuinely ambiguous (multiple assets could match, or the deal uses
       an unfamiliar code name not in altNames): call onebd_resolve_asset(dealAssetName) and
       onebd_resolve_asset(assetPrimaryName) to confirm by ID.
    3. If IDs match â†' confirmed same molecule â†' apply deal.
    4. If IDs differ â†' different assets â†' deal does NOT apply.
  Prefer altName matching over tool calls - it covers most cases and saves iterations.

  Keyword â†' scope mapping:

  "fusion program(s)" / "fusion protein(s)" / "bi- and multi-functional fusion" / "Fc-fusion" /
  "multi-functional fusion" / "ADAPTIR" / "DVD-Ig" / "fusion bispecific":
    â†' Applies to: Fc-fusion assets ONLY + bispecific/trispecific assets that use a fusion-protein
      format (Fc-fusion scaffold, heterodimeric fusion, ADAPTIR-type, etc.).
    â†' Does NOT apply to: standard bispecific IgG formats (CrossMab, DuoBody, BiTE, DART,
      knobs-into-holes IgG) that are not fusion proteins.
    â†' WHEN IN DOUBT about whether a bsAb/tsAb uses a fusion format: APPLY the deal to it.
      Err toward including more assets in the deal scope rather than excluding them - the user
      can review; a missed disqualifying deal is worse than a false flag.

  "bispecific program(s)" / "bispecific antibody program(s)" (without "fusion"):
    â†' Applies to all bsAb assets. Does NOT automatically cover Fc-fusion or tsAb unless specified.

  "trispecific program(s)" / "multispecific program(s)" (without "fusion"):
    â†' Applies to all tsAb and bsAb assets.

  "bi- and trispecific" / "bi- and multi-specific" (without "fusion"):
    â†' Applies to all bsAb and tsAb assets, NOT to pure Fc-fusion assets.

  CRITICAL PARSING RULE - "bispecific ADCs" / "trispecific ADCs" / "bi- and trispecific ADCs" /
  "bispecific and trispecific ADCs" / "[format] ADCs":
    â†' The format qualifier (bi-, tri-, multispecific) MODIFIES ADC - it means ADCs of that format.
    â†' Applies ONLY to ADC assets that are bispecific or trispecific. Does NOT apply to plain bsAbs
       or tsAbs that carry no ADC payload.
    â†' Example: "bsAb and trispecific ADCs" = bispecific ADCs + trispecific ADCs. A plain bsAb
       without ADC payload is NOT covered. A bsAb-ADC IS covered.

  "ADC program(s)" / "antibody-drug conjugate portfolio" (without format qualifier):
    â†' Applies to all ADC assets regardless of format (mono, bi, tri).

  "antibody program(s)" / "mAb portfolio" / "monoclonal antibody program(s)":
    â†' Applies to all mAb assets.

  "TCE program(s)" / "T-cell engager program(s)":
    â†' Applies to all TCE assets.

  "entire pipeline" / "all programs" / "all assets" / "all biologics":
    â†' Applies to every qualifying asset.

  If the title/summary contains NO modality or program-category language â†' true company-level deal
  (equity, platform technology, general collaboration). Record as "company-level deal (no specific
  asset): [title]" in researchNotes and do NOT apply to any individual asset.

ASSESS STEPS 4 AND 5 SIMULTANEOUSLY for each qualifying asset using the same deal batch:

Step 4 - Licensing/Rights (per asset still passing after Step 3):
  Use ONLY these explicit rights-transfer keywords: out-licens, exclusive license, grant license,
  license rights, sublicens, royalt, assign rights, transfer rights, commercialization rights.
  Also check the deal's transaction_type and agreement_type fields directly - these are structured
  Cortellis fields and are more reliable than keyword matching on title/summary.
  Do NOT trigger on: collaboration, partnership, co-develop, co-promotion - these typically mean both
  parties retain rights and are not exclusion events.

 - transaction_type contains "Option" OR "License Option" OR agreement_type contains "Option" â†'
    layer3: fail, excluded regardless of territory.
    Note in asset notes: "License option granted â€” asset encumbered. Partner: [name], Date: [date]"
  â€” Deal with explicit rights-transfer language, territory = Global or US â†' layer3: fail, excluded (note partner + date)
  â€” Deal with explicit rights-transfer language, territory = ex-US only (China, APAC, Europe explicitly stated) â†' layer3: pass
  â€” Deal with explicit rights-transfer language, territory unspecified or empty â†' layer3: fail, excluded
    Note in asset notes: "Out-licensed â€” no territory disclosed, assumed global. Partner: [name], Date: [date]"
  â€” Collaboration / co-development with no rights-transfer language â†' layer3: pass (note deal in researchNotes)
  â€” No matching rights-transfer deal â†' layer3: pass
  -- Modality-group deal where title/summary indicates future/next-gen scope only (see FUTURE-SCOPE EXCEPTION above) --> layer3: pass for existing assets. Note in researchNotes.

Step 5 - US Manufacturing (per asset still passing Step 4):
  Keywords: manufactur, cdmo, cmo, contract manufactur, supply agreement, tech transfer, bioreactor,
            lonza, wuxi biolog, samsung biolog, thermo fisher, catalent, fujifilm, agc biolog, rentschler, patheon

  When territories[] is empty, infer US presence from the CDMO entity name in companies[]:
    Look at the name of the manufacturing party (the CDMO / non-screened-company party).
    Entity names carry geographic identifiers - read them literally:

    Entity name implies a SPECIFIC NON-US location â†' no US capacity from this entity â†' layer4: PASS:
      "(Shanghai)", "(Suzhou)", "(Wuxi)", "(Beijing)", any "(China)" city, "Co Ltd" Chinese suffix,
      "(Korea)", "(Seoul)", "(Ireland)" alone without US partner, "(Germany)", "(Switzerland)" alone,
      "(Japan)", "(Singapore)", "(India)"
      Example: "WuXi Biologics (Shanghai) Co Ltd" â†' Shanghai entity â†' non-US â†' PASS

    Entity name implies a GLOBAL CDMO or US presence â†' has or may have US drug-substance capacity â†' layer4: FAIL:
      No geographic qualifier or qualifier includes "Global", "Inc" (US corporate suffix), "(USA)",
      "(US)", "North America", "United States", or is a well-known global CDMO with US sites:
      Lonza, WuXi Biologics (global CDMO regardless of which subsidiary entity), Fujifilm Diosynth,
      AGC Biologics, Thermo Fisher, Catalent, Patheon, Boehringer Ingelheim Biopharmaceuticals,
      Samsung Biologics
      Example: "Lonza AG" â†' global CDMO with US sites â†' FAIL

    Truly ambiguous (cannot tell from entity name) â†' layer4: PASS + add "check-mfg-partner" to flags[]

  Per asset:
 - Manufacturing deal, territory explicitly includes Global or US â†' layer4: fail, excluded (note CDMO entity + date)
 - Manufacturing deal, territory explicitly non-US (China, Asia, Europe) â†' layer4: pass
 - Manufacturing deal, territory unspecified, CDMO entity = specific non-US location â†' layer4: pass
 - Manufacturing deal, territory unspecified, CDMO entity = global or US-capable â†' layer4: fail, excluded (note CDMO entity + date)
 - Manufacturing deal, territory unspecified, CDMO entity truly ambiguous â†' layer4: pass + add "check-mfg-partner" to flags[]
 - No matching manufacturing deal â†' layer4: pass (manufacturing gap confirmed)
  Always note the CDMO entity name, deal date, and outcome in the asset's notes field.

DEAL NOTES - MANDATORY for every asset that reaches Steps 4+5:
  Populate each asset's "notes" field referencing any deals[] entries that apply to that asset
  (matched via specific-asset ID confirmation OR modality-group keyword OR scope=all).
  Format each matched deal as one line:
    "[date] [title] | [licensing/manufacturing/collaboration] | Territory: [territory or 'unspecified'] | [outcome reason]"
  Examples:
    "2025-07-01 Henlius to develop and commercialize HCB-101 | licensing | Territory: ex-US (China, SE Asia, MENA) | US rights retained - pass"
    "2026-01-26 WuXi Biologics (Shanghai) - end-to-end manufacturing for fusion programs | manufacturing | Territory: unspecified (WuXi = global CDMO with US capacity) | screened out"
    "2024-03-15 Lonza biologics supply agreement | manufacturing | Territory: unspecified (Lonza = global CDMO with US capacity) | screened out"
  If no deals[] entries match this asset, write "No Cortellis deals matched to this asset".
  Do NOT leave notes blank for any asset that went through Steps 4+5.

If ALL remaining assets excluded at Step 4 â†' excludedAt="step4"
If ALL remaining assets excluded at Step 5 â†' excludedAt="step5"
Never return inconclusive due to Step 5 alone - if any asset still passes, company qualifies.

SOURCING: Add "onebd:cortellis-deals" to sources[] with usedFor "Steps 4+5 - licensing and manufacturing deals".

â•â•â• RULES â•â•â•

  â˜… GOLDEN RULE - ASSET-LEVEL PASS: If even ONE asset passes all steps, the company is
    status="qualifying". A company is only excluded if ALL qualifying assets are eliminated.
    Example: 14 assets screened out + 1 asset passes Step 5 â†' company QUALIFIES on that asset.
    Never set status="excluded" while any single asset still has overallStatus="qualifying".

 - Run Step 3 (competitive overlap) BEFORE calling OneBD - it's free and eliminates assets early
 - onebd_resolve_company: call ONCE per company
 - onebd_get_deals: MANDATORY immediately after resolve returns found:true - call ONCE, never skip
 - Steps 4 and 5 both use the SAME deal batch from onebd_get_deals - no additional OneBD calls
 - Match deals to Citeline assets by name (fuzzy) - no asset-level OneBD resolution needed
 - Normalize modality to exactly: mAb | bsAb | tsAb | ADC | TCE | NKCE | Fc-fusion | Immunocytokine
 - Use NCI-standard target names: PD-1 (not PD1), HER2 (not ERBB2), EGFR, CD3, CD19, etc.
 - Return ONLY valid JSON at end - no text before or after it
 - Every turn must end with either a tool call or the final JSON - never neither

â•â•â• REQUIRED JSON OUTPUT â•â•â•

{
  "name": "company name as given",
  "type": "public" | "private" | "unknown",
  "website": "url or null",
  "status": "qualifying" | "excluded" | "inconclusive",
  "sourceTrack": "citeline",
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
      "layer1": { "status": "pass|fail|inconclusive", "reason": "oncology indication confirmed via Citeline" },
      "layer2": { "status": "pass|fail|inconclusive", "reason": "modality: [English modality term]" },
      "layer3": { "status": "pass|fail|inconclusive", "reason": "competitive overlap check (Step 3)" },
      "layer4": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "layer5": { "status": "pass|fail|inconclusive", "reason": "", "source": "" },
      "overallStatus": "qualifying|excluded",
      "notes": "",
      "flags": []
    }
  ],
  "deals": [
    {
      "title": "deal title from Cortellis",
      "date": "YYYY-MM-DD or YYYY",
      "partner": "counterparty company name",
      "type": "licensing|manufacturing|collaboration|option|acquisition|other",
      "territory": "Global|US|Ex-US|China|unspecified|...",
      "scope": "all|modality-group|specific-asset|company-level",
      "modalityGroup": "bsAb|TCE|ADC|mAb|Fc-fusion|tsAb or null",
      "assetNames": ["named assets if scope=specific-asset, else empty array"],
      "relevance": "rights|manufacturing|collaboration|equity|other",
      "summary": "one-line deal summary"
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
      "url": "citeline:sql",
      "label": "Citeline database",
      "usedFor": "Steps 1+2 - oncology biologic identification",
      "type": "citeline"
    }
  ]
}

Notes on the asset schema:
  layer3 = Step 3 competitive overlap. Fill for all assets (pass or fail). For platform-level records with no target, set layer3.status = "inconclusive", reason = "No target - not applicable".
  layer4 = Step 4 rights check. Only fill for assets that passed Step 3 (not competed out). For assets eliminated at Step 3, leave layer4/layer5 as null or omit.
  layer5 = Step 5 manufacturing check. Only fill for assets that passed Steps 3+4.
  For Citeline track, use "citeline:sql" as url placeholder in sources[].
  For OneBD calls in sources[], use "onebd:cortellis-deals" as url placeholder.
`.trim();

// Derived from BASE_STEPS_345_PROMPT - identical Steps 3+4+5 logic, header replaced.
// Steps 1+2 data is pre-loaded from Citeline SQL and passed in the user message.
const CITELINE_PRIMARY_PROMPT = (() => {
  const step3Marker = 'â•â•â• STEP 3 - COMPETITIVE OVERLAP';
  const idx = BASE_STEPS_345_PROMPT.indexOf(step3Marker);
  const body = idx !== -1 ? BASE_STEPS_345_PROMPT.slice(idx) : BASE_STEPS_345_PROMPT;
  return (
    `You are a pharmaceutical business development analyst screening companies for BeOne Medicines' Hopewell, NJ biologics manufacturing partnership program.

CONTEXT: PRIMARY TRACK - Citeline database (Steps 1+2 pre-loaded) + OneBD Cortellis deals (Steps 4+5). The company has already passed the Big Pharma pre-filter. Steps 1+2 (oncology biologic identification) are DONE - the qualifying assets are already in the user message.

OBJECTIVE: Use the Citeline asset list provided. Do NOT call any pipeline lookup tool. Start immediately at STEP 3 (competitive overlap), then STEPS 4+5 via onebd_resolve_company and onebd_get_deals.

CITELINE ASSET DATA — OVERVIEW-ASSISTED TARGETS & FLAGS

Each asset in the user message includes these Citeline fields:
  Targets    — structured target names from Citeline drug_targetFamilies
  MOA        — mechanism of action text
  Indications— all disease names for this asset
  Overview   — full Citeline drug description (payload, mechanism, masking details may appear here)
  Payloads   — ADC payload caption(s) if present

BEFORE running Step 3, for each asset:

(A) TARGET CHECK: If Targets is empty or "Undisclosed", extract target names from Overview and MOA.
    Populate targets[] in JSON from the best available source: Targets field first, then Overview/MOA.
    Use NCI-standard names: PD-1, HER2, EGFR, CD3, CD19, CD38, BCMA, DLL3, STEAP1, CLDN6, etc.

(B) SET THESE FLAGS in the asset flags[] from Citeline data (Targets, Indications, Overview, Payloads):

  "indication-synergy" — set if Indications OR Overview mentions any BeOne focus indication:
    Hematology: CLL, SLL, WM (Waldenstrom), FL, MCL, MZL, NHL, multiple myeloma, MDS, AML, B-cell malignancies
    Lung: SCLC, NSCLC, lung adenocarcinoma, squamous cell lung carcinoma
    GI: ESCC, gastric/stomach cancer, GEJ/GEJC, HCC (hepatocellular), NPC, urothelial/bladder, MSI-H/dMMR, BTC/cholangiocarcinoma
    Breast/Gyn: breast cancer (including HER2+, TNBC, triple-negative), ovarian, cervical, endometrial/uterine cancer
    DO NOT flag: prostate cancer, glioblastoma/CNS (not BeOne focus).

  "checkpoint-io-alt" — set if targets[] (after extraction) contains a non-PD-1/PD-L1 immune checkpoint:
    LAG-3, TIM-3, TIGIT, CTLA-4, VISTA, BTLA, CD96, NKG2A, OX40, 4-1BB, CD137, ICOS, GITR
    AND modality is NOT TCE (TCEs with 4-1BB belong to masked-tce-4-1bb instead).

  "masked-tce-4-1bb" — set if EITHER:
    (i)  targets[] contains 4-1BB or CD137 (any modality), OR
    (ii) modality is TCE AND (Overview OR MOA) mentions masking/conditional activation language:
         mask, prodrug, probody, TME-cleavable, protease-cleavable, conditional activation,
         tumor microenvironment activation, switchable, latent

  "adc-novel-payload" — set if modality is ADC AND EITHER:
    (i)  Payloads or Overview mentions TWO distinct payloads (dual-payload ADC), OR
    (ii) Payloads or Overview mentions a payload that is NOT a standard TOP1 inhibitor or MMAE:
         Standard (do NOT flag): DXd, deruxtecan, SN-38, exatecan, irinotecan-based, MMAE alone
         Novel (DO flag): DM1, DM4, PBD, pyrrolobenzodiazepine, calicheamicin, duocarmycin,
         tubulysin, cryptophycin, maytansinoid, amanitin, colchicine, spliceostatin,
         or any dual-payload combination (even MMAE+DXd, MMAE+TOP1, etc.)

${body}`
  )
    .replace('"sourceTrack": "citeline"', '"sourceTrack": "citeline"')
    .replace(
      'For Citeline track, use "citeline:sql" as url placeholder in sources[].',
      'Steps 1+2 source: Citeline SQL (use "citeline:sql" as url placeholder in sources[]).',
    )
    .trim();
})();

// Website input track prompt - Steps 1+2 from user-supplied URL, Steps 3+4+5 via OneBD.
// No web_search available. Derived from the same Steps 3+4+5 body as the other prompts.
const WEBSITE_INPUT_SYSTEM_PROMPT = (() => {
  const step3Marker = 'â•â•â• STEP 3 - COMPETITIVE OVERLAP';
  const idx = BASE_STEPS_345_PROMPT.indexOf(step3Marker);
  const body = idx !== -1 ? BASE_STEPS_345_PROMPT.slice(idx) : BASE_STEPS_345_PROMPT;
  return (
    `You are a pharmaceutical business development analyst screening companies for BeOne Medicines' Hopewell, NJ biologics manufacturing partnership program.

CONTEXT: WEBSITE INPUT TRACK - The company was not found in the Citeline database. The user has provided a pipeline page URL or company website URL. You have two tools only: fetch_webpage (to read the URL) and OneBD tools (for Steps 4+5 deals). You have NO web_search tool - do not attempt to search the web.

OBJECTIVE: Fetch the provided URL to discover the company's pipeline (Steps 1+2), then run Steps 3 â†' 4+5 in order.

STEPS 1+2 - PIPELINE DISCOVERY FROM URL:
1. Call fetch_webpage with the provided URL immediately.
2. If the page appears to be a general homepage rather than a pipeline/science page:
  - Look for a link to /pipeline, /science, /programs, /research, /therapeutic-areas, or /our-science on the SAME domain.
  - Fetch that subpage instead. Maximum 2 fetch_webpage calls for Steps 1+2.
3. Extract ALL individually named drug candidates at any development phase (Discovery through Approved).
  - Do NOT filter by phase. Include all named assets.
  - Exclude assets explicitly marked as ceased, discontinued, terminated, or withdrawn.
4. For each asset, identify:
   (a) Is it an oncology biologic? Qualifying modalities (CHO-expressed): mAb, bsAb, tsAb, ADC, TCE, NKCE, Fc-fusion, Immunocytokine.
   (b) Does the screened company manufacture the biologic drug substance (cell line/protein expression)?
       Exclude: AI/computational support only, payload/warhead-only suppliers, fill & finish only, CRO/regulatory consultant only.
5. PERMISSIVE SCREENING — if the page mentions a qualifying oncology biologic program (ADC, mAb, TCE, etc.) in a cancer area but does NOT list individually named drug candidates, specific targets, or clinical phases:
   - Screen the company IN. Sparse data is NOT grounds for inconclusive.
   - Create one asset per identifiable program: name = best description visible on the page (e.g. "anti-HER2 ADC" or "[Company] ADC Program"), modality = what the page states, indication = cancer area mentioned, targets = [] (empty — not disclosed), phase = "Not disclosed".
   - Only return inconclusive if the page is completely unreadable OR contains zero mention of an oncology biologic program.
6. If the URL is unreadable or shows no oncology biologic program at all, return immediately:
   status="inconclusive", inconclusiveReason="Website Input Needed - provided URL was not readable or contained no pipeline data"

${body}`
  )
    .replace('"sourceTrack": "citeline"', '"sourceTrack": "website-input"')
    .replace(
      'For Citeline track, use "citeline:sql" as url placeholder in sources[].',
      'Steps 1+2 source: user-supplied URL (add the fetched URL in sources[] with type "company-website").',
    )
    .trim();
})();

// Search-mode variant — same rules as URL track but context tells Claude it has web_search.
const WEBSITE_INPUT_SEARCH_SYSTEM_PROMPT = WEBSITE_INPUT_SYSTEM_PROMPT
  .replace(
    'You have two tools only: fetch_webpage (to read the URL) and OneBD tools (for Steps 4+5 deals). You have NO web_search tool - do not attempt to search the web.',
    'You have web_search (max 3 uses to locate the pipeline page), fetch_webpage, and OneBD tools.'
  )
  .replace(
    "OBJECTIVE: Fetch the provided URL to discover the company's pipeline (Steps 1+2), then run Steps 3 → 4+5 in order.",
    "OBJECTIVE: Search for the company's pipeline page, fetch it to discover the pipeline (Steps 1+2), then run Steps 3 → 4+5 in order."
  );

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tool implementations
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// 10-Ks/20-Fs are huge - jump straight to the requested section instead of
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
      // Raised from 8000 - under SCREEN_CONCURRENCY=4, several companies' fetches
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
      return 'Page content appears empty (likely JavaScript-rendered - try fetching a different URL or searching for cached/text version).';
    }

    if (isSec) {
      const requested = SEC_SECTION_PATTERNS[section] || SEC_SECTION_PATTERNS.item1;
      const match = text.match(requested);
      if (match) return text.slice(match.index, match.index + 8000);

      // Requested section heading not found (wording varies by filer) - fall
      // back to Item 1 rather than returning nothing.
      if (section && section !== 'item1') {
        const fallback = text.match(SEC_SECTION_PATTERNS.item1);
        const note = `Could not find an "${section}" section heading in this filing - returning Item 1 Business instead.\n\n`;
        return fallback ? note + text.slice(fallback.index, fallback.index + 8000) : note + text.slice(0, 8000);
      }
    }

    return text.slice(0, 15000);
  } catch (e) {
    return `Could not fetch page: ${e.message}`;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Pipeline page discovery - used for thin-coverage enrichment.
// Fetches the homepage, scores same-domain links by pipeline keywords,
// then fetches the best-matching subpage. Returns { url, content } or null.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PIPELINE_LINK_SCORES = [
  { re: /\/pipeline/i,    score: 10 },
  { re: /\/science/i,     score:  8 },
  { re: /\/programs/i,    score:  7 },
  { re: /\/research/i,    score:  6 },
  { re: /\/therapeutic/i, score:  5 },
  { re: /\/oncology/i,    score:  5 },
  { re: /\/portfolio/i,   score:  4 },
  { re: /\/drug/i,        score:  3 },
  { re: /\/product/i,     score:  3 },
];

async function findAndFetchPipelinePage(websiteUrl) {
  try {
    // Homepage fetch - 6s budget leaves room for subpage fetch within 15s total
    const res = await axios.get(websiteUrl, {
      timeout: 6000, maxRedirects: 4,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'text/html,*/*' },
      validateStatus: s => s < 400,
    });
    if (typeof res.data !== 'string') return null;

    const $        = cheerio.load(res.data);
    const baseHost = new URL(websiteUrl).hostname;
    const seen     = new Set();
    const ranked   = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
      try {
        const full = new URL(href, websiteUrl).href;
        if (new URL(full).hostname !== baseHost) return;
        if (seen.has(full)) return;
        seen.add(full);
        let score = 0;
        for (const { re, score: s } of PIPELINE_LINK_SCORES) {
          if (re.test(href)) score += s;
          if (re.test(text)) score += s * 0.5;
        }
        if (score > 0) ranked.push({ url: full, score });
      } catch {}
    });

    ranked.sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;

    // Subpage fetch - 8s budget (6 + 8 = 14s max, comfortably under 15s wall)
    const best = ranked[0].url;
    const res2 = await axios.get(best, {
      timeout: 8000, maxRedirects: 4,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Accept: 'text/html,*/*' },
      validateStatus: s => s < 400,
    });
    if (typeof res2.data !== 'string') return null;
    const $2      = cheerio.load(res2.data);
    $2('script, style, nav, footer, header, iframe, [aria-hidden="true"]').remove();
    const content = $2('body').text().replace(/\s+/g, ' ').trim().slice(0, 15000);
    return { url: best, content };
  } catch {
    return null;
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Evidence snapshot - captures what was actually read for audit trail
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// OneBD REST API helper
// Base URL: https://onebd.pchomelab.com/api/v1
// Auth:     X-API-Key header
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ONEBD_BASE = 'https://onebd.pchomelab.com/api/v1';

function getOneBdKey() {
  return process.env.ONEBD_API_KEY || process.env.onebd_api_key;
}

async function callOneBdApi(path, method = 'GET', body = null) {
  const apiKey = getOneBdKey();
  if (!apiKey) throw new Error('ONEBD_API_KEY not set');

  const url = `${ONEBD_BASE}${path}`;
  const opts = {
    method,
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    timeout: 30000,
  };
  if (body) opts.data = body;

  try {
    const resp = await axios({ url, ...opts });
    return resp.data;
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data?.detail || e.message;
    throw new Error(`OneBD ${method} ${path} â†' ${status || 'network'}: ${detail}`);
  }
}

// Thin wrappers - each returns the parsed JSON response object.

function oneBdCounts() {
  return callOneBdApi('/counts');
}

function oneBdSearch(query, opts = {}) {
  return callOneBdApi('/search', 'POST', {
    query,
    datasets: opts.datasets || ['deals', 'assets', 'companies', 'clinical_trials', 'edgar', 'contracts'],
    company_id: opts.company_id || undefined,
    date_from: opts.date_from || undefined,
    date_to: opts.date_to || undefined,
    limit_per_dataset: opts.limit_per_dataset || 10,
  });
}

function oneBdDealsSearch(params = {}) {
  return callOneBdApi('/deals/search', 'POST', params);
}

function oneBdAssetsSearch(params = {}) {
  return callOneBdApi('/assets/search', 'POST', params);
}

function oneBdEdgarSearch(params = {}) {
  return callOneBdApi('/edgar/search', 'POST', params);
}

function oneBdContractsSearch(params = {}) {
  return callOneBdApi('/contracts/search', 'POST', params);
}

function oneBdLiteratureSearch(params = {}) {
  return callOneBdApi('/literature/search', 'POST', params);
}

function oneBdClinicalTrialsSearch(params = {}) {
  return callOneBdApi('/clinical-trials/search', 'POST', params);
}

function oneBdCompanyDossier(companyId) {
  return callOneBdApi(`/companies/${companyId}/dossier`);
}

function oneBdAssetDossier(assetId) {
  return callOneBdApi(`/assets/${assetId}/dossier`);
}

// Tool-callable wrappers for Steps 4+5 (OneBD Cortellis)

// Suffixes that carry no identity signal - strip these to get the core name
const COMPANY_SUFFIX_RE = /\b(bio|biologics|biolog|biotherapeutics|biosciences|biopharma|therapeutics|pharma|pharmaceuticals|medicines|oncology|sciences|inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|ag|sa|plc|holdings|group)\b\.?$/gi;

function companyNameVariants(name) {
  const raw = name.trim();
  const words = raw.split(/\s+/);

  // Core name: strip trailing descriptor suffixes iteratively
  let core = raw;
  let prev;
  do {
    prev = core;
    core = core.replace(COMPANY_SUFFIX_RE, '').trim();
  } while (core !== prev && core.length > 0);
  if (!core) core = words[0]; // safety: never go fully empty

  const noSpaces = words.join('');              // "Hanchor Bio" â†' "HanchorBio"
  const coreNoSpaces = core.split(/\s+/).join(''); // for multi-word cores

  return [...new Set([raw, noSpaces, core, coreNoSpaces, words[0]])].filter(Boolean);
}

async function oneBdResolveCompanyForTool(companyName) {
  const key = getOneBdKey();
  const headers = { 'X-API-Key': key, 'Content-Type': 'application/json' };
  const firstWord = companyName.trim().split(/\s+/)[0].toLowerCase();
  const queries = companyNameVariants(companyName);

  for (const query of queries) {
    const res = await axios.post(`${ONEBD_BASE}/search`, {
      query,
      datasets: ['companies'],
      limit_per_dataset: 5,
    }, { headers, timeout: 20000 });

    const hits = ((res.data.groups || []).find(g => g.dataset === 'companies')?.items) || [];
    if (!hits.length) continue;

    const match = hits.find(c => (c.name || '').toLowerCase().includes(firstWord)) || hits[0];
    if (match) {
      const usedQuery = query !== companyName ? ` (matched via "${query}")` : '';
      console.log(`    [onebd_resolve_company] "${companyName}" â†' "${match.name}" (id=${match.id})${usedQuery}`);
      return JSON.stringify({ found: true, id: match.id, name: match.name, company_type: match.company_type || null, deal_count: match.deal_count ?? null });
    }
  }

  return JSON.stringify({ found: false, message: `"${companyName}" not found in OneBD (tried: ${queries.join(', ')})` });
}

async function oneBdGetDealsForTool(companyId) {
  const key = getOneBdKey();
  const res = await axios.post(`${ONEBD_BASE}/deals/search`, {
    companies: { all: [{ id: companyId }] },
    expand: ['assets', 'companies', 'territories', 'values'],
    limit: 100,
  }, { headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, timeout: 30000 });

  const deals = res.data.items || [];
  const formatted = formatDealsForTool(deals);
  return JSON.stringify({ total: deals.length, deals: formatted });
}

async function oneBdResolveAssetForTool(assetName) {
  const key = getOneBdKey();
  const res = await axios.post(`${ONEBD_BASE}/search`, {
    query: assetName,
    datasets: ['assets'],
    limit_per_dataset: 5,
  }, { headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, timeout: 20000 });

  const hits = ((res.data.groups || []).find(g => g.dataset === 'assets')?.items) || [];
  const lower = assetName.toLowerCase();
  const match = hits.find(a => (a.name_display || '').toLowerCase() === lower)
             || hits.find(a => (a.name_display || '').toLowerCase().includes(lower.split(' ')[0]))
             || hits[0] || null;
  if (!match) return JSON.stringify({ found: false, message: `"${assetName}" not found in OneBD Cortellis assets` });
  return JSON.stringify({ found: true, id: match.id, name_display: match.name_display, phase: match.phase_highest_now || match.phase_highest_start || null });
}

async function oneBdGetAssetDealsForTool(assetId, assetName) {
  const key = getOneBdKey();
  const res = await axios.post(`${ONEBD_BASE}/deals/search`, {
    assets: { all: [{ id: assetId }] },
    expand: ['assets', 'companies', 'territories', 'values'],
    limit: 50,
  }, { headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, timeout: 30000 });

  const deals = res.data.items || [];
  return JSON.stringify({ asset: assetName, asset_id: assetId, total: deals.length, deals: formatDealsForTool(deals) });
}

function formatDealsForTool(deals) {
  return deals.map(d => ({
    title: d.title,
    date: d.date_start ? d.date_start.slice(0, 10) : null,
    agreement_type: d.agreement_type || null,
    transaction_type: d.transaction_type || null,
    summary: (d.summary_excerpt || d.summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
    assets: (d.assets || []).map(a => a.name_display || a.name || String(a.id)),
    territories: (d.territories || []).map(t => t.name || t),
    value: d.values?.length ? d.values.map(v => `${v.type} $${v.amount_usd_m}M`).join(', ') : null,
    parties: (d.companies || []).map(c => ({ name: c.name, role: c.role })),
  }));
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Citeline SQL - Azure Synapse connection + Steps 1+2 query
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let _citelinePool = null;
let _citelineTokenExpiry = 0;

async function getCitelinePool() {
  const now = Date.now();
  if (_citelinePool && _citelineTokenExpiry > now + 5 * 60 * 1000) return _citelinePool;
  if (_citelinePool) {
    try { await _citelinePool.close(); } catch (_) {}
    _citelinePool = null;
  }
  if (!DefaultAzureCredential) throw new Error('@azure/identity not installed');
  const credential = new DefaultAzureCredential({ includeInteractiveCredentials: true });
  const tokenResp = await credential.getToken('https://database.windows.net/');
  _citelineTokenExpiry = tokenResp.expiresOnTimestamp;
  _citelinePool = await sql.connect({
    server: 'ea-bgne-synapse-dsoe.sql.azuresynapse.net',
    database: 'BGNE_DSOE',
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResp.token } },
    options: { encrypt: true, trustServerCertificate: false, enableArithAbort: true },
    port: 1433, connectionTimeout: 30000, requestTimeout: 60000,
  });
  return _citelinePool;
}

const CITELINE_ASSETS_SQL = `
WITH drug_company AS (
  SELECT pp.drugId, pp.highestDevelopmentStatus, pp.globalStatus, pp.companyRelationship,
    cp.companyWebsite,
    ROW_NUMBER() OVER (
      PARTITION BY pp.drugId
      ORDER BY
        CASE pp.companyRelationship WHEN 'Originator' THEN 1 ELSE 2 END,
        CASE pp.highestDevelopmentStatus
          WHEN 'Launched'                  THEN 1 WHEN 'Registered'               THEN 2
          WHEN 'Pre-registration'          THEN 3 WHEN 'Phase III Clinical Trial'  THEN 4
          WHEN 'Phase II Clinical Trial'   THEN 5 WHEN 'Phase I/II Clinical Trial' THEN 6
          WHEN 'Phase I Clinical Trial'    THEN 7 WHEN 'Clinical Trial'            THEN 8
          WHEN 'Preclinical'               THEN 9 ELSE 10
        END
    ) AS rn
  FROM CITELINE.drugComp_panel cp
  JOIN CITELINE.drugProg_panel pp ON pp.companyId = cp.companyId
  WHERE (cp.companyName LIKE '%' + @company + '%' OR cp.parentCompanyName LIKE '%' + @company + '%')
    AND pp.globalStatus NOT IN ('Discontinued','Withdrawn','Suspended')
    AND (pp.highestDevelopmentStatus NOT IN ('Ceased','Discontinued','Withdrawn','Suspended')
         OR pp.highestDevelopmentStatus IS NULL)
),
modality_ranked AS (
  SELECT drugId, drugTypeCaption,
    ROW_NUMBER() OVER (
      PARTITION BY drugId ORDER BY
        CASE drugTypeCaption
          WHEN 'Antibody-drug conjugate'       THEN 1
          WHEN 'Cell engager, bispecific'       THEN 2
          WHEN 'Trispecific cell engager'       THEN 2
          WHEN 'Cell engager, other'            THEN 2
          WHEN 'Multispecific antibody'         THEN 3
          WHEN 'Trispecific antibody'           THEN 4
          WHEN 'Bispecific antibody'            THEN 5
          WHEN 'Fusion protein'                 THEN 6
          WHEN 'Human monoclonal antibody'      THEN 7
          WHEN 'Humanized monoclonal antibody'  THEN 7
          WHEN 'Chimaeric monoclonal antibody'  THEN 7
          WHEN 'Murine monoclonal antibody'     THEN 7
          WHEN 'Monoclonal antibody, other'     THEN 8
          ELSE 9
        END
    ) AS rn
  FROM CITELINE.drug_drugType
  WHERE drugTypeCaption IN (
    'Human monoclonal antibody','Humanized monoclonal antibody',
    'Chimaeric monoclonal antibody','Murine monoclonal antibody','Monoclonal antibody, other',
    'Bispecific antibody','Trispecific antibody','Antibody-drug conjugate',
    'Cell engager, bispecific','Trispecific cell engager','Cell engager, other',
    'Fusion protein','Multispecific antibody'
  )
),
targets_agg AS (
  SELECT drugId, STRING_AGG(directMechanism, '; ') AS targets
  FROM CITELINE.drug_mechanismsOfAction
  WHERE directMechanism NOT IN (
    'Immune checkpoint inhibitor','Immuno-oncology therapy','Antineoplastic','Antitumour','Cytotoxic',
    'Unknown','TBD','TAA','Various','Multiple','Undisclosed','Antigen','Receptor',
    'Tumor antigen','Tumor Antigen','Cancer antigen',
    'Tumor Associated Antigen','Tumor-Associated Antigen',
    'Cell surface','Cell Surface','Surface antigen',
    'Immune checkpoint','Checkpoint','Cytokine'
  )
  AND directMechanism NOT LIKE '%tumor%'
  AND directMechanism NOT LIKE '%tumour%'
  AND directMechanism NOT LIKE '%cell surface%'
  GROUP BY drugId
),
indications_agg AS (
  SELECT drugId,
    STRING_AGG(CAST(diseaseName AS NVARCHAR(MAX)), '; ') AS indications
  FROM CITELINE.drug_indicationGroups
  WHERE indicationGroups = 'Anticancer'
  GROUP BY drugId
)
SELECT
  dp.drugId, dp.drugPrimaryName AS drug, mr.drugTypeCaption AS citelineModality,
  dc.highestDevelopmentStatus AS citelinePhase, dc.globalStatus AS status,
  dc.companyRelationship, dc.companyWebsite,
  ISNULL(ta.targets, '') AS targets,
  ISNULL(ia.indications, '') AS indications
FROM drug_company dc
JOIN CITELINE.drug_panel dp ON dp.drugId = dc.drugId
JOIN modality_ranked mr ON mr.drugId = dc.drugId AND mr.rn = 1
LEFT JOIN targets_agg ta ON ta.drugId = dc.drugId
JOIN indications_agg ia ON ia.drugId = dc.drugId
WHERE dc.rn = 1
ORDER BY dp.drugPrimaryName
`;

const CITELINE_MODALITY_MAP = {
  'Antibody-drug conjugate':       'ADC',
  'Cell engager, bispecific':      'TCE',
  'Trispecific cell engager':      'TCE',
  'Cell engager, other':           'TCE',
  'Multispecific antibody':        'bsAb',
  'Trispecific antibody':          'tsAb',
  'Bispecific antibody':           'bsAb',
  'Fusion protein':                'Fc-fusion',
  'Human monoclonal antibody':     'mAb',
  'Humanized monoclonal antibody': 'mAb',
  'Chimaeric monoclonal antibody': 'mAb',
  'Murine monoclonal antibody':    'mAb',
  'Monoclonal antibody, other':    'mAb',
};

const MODALITY_PRIORITY = {
  'Antibody-drug conjugate':       1,
  'Cell engager, bispecific':      2,
  'Trispecific cell engager':      2,
  'Cell engager, other':           2,
  'Multispecific antibody':        3,
  'Trispecific antibody':          4,
  'Bispecific antibody':           5,
  'Fusion protein':                6,
  'Human monoclonal antibody':     7,
  'Humanized monoclonal antibody': 7,
  'Chimaeric monoclonal antibody': 7,
  'Murine monoclonal antibody':    7,
  'Monoclonal antibody, other':    8,
};

const CITELINE_PHASE_MAP = {
  'Launched':                  'Approved',
  'Registered':                'Approved',
  'Pre-registration':          'Pre-registration',
  'Phase III Clinical Trial':  'Phase 3',
  'Phase II Clinical Trial':   'Phase 2',
  'Phase I/II Clinical Trial': 'Phase 1/2',
  'Phase I Clinical Trial':    'Phase 1',
  'Clinical Trial':            'Phase 1',
  'Preclinical':               'Preclinical',
  'No Development Reported':   'No Development Reported',
};

const CITELINE_MODALITY_CHECK_SQL = `
SELECT DISTINCT cp.companyWebsite, dt.drugTypeCaption, dt.drugTypeHierarchy
FROM CITELINE.drugComp_panel cp
LEFT JOIN CITELINE.drugProg_panel pp ON pp.companyId = cp.companyId
LEFT JOIN CITELINE.drug_drugType dt ON dt.drugId = pp.drugId
WHERE (cp.companyName LIKE '%' + @company + '%' OR cp.parentCompanyName LIKE '%' + @company + '%')
`;

const QUALIFYING_BIOLOGIC_MODALITIES = new Set([
  'Human monoclonal antibody','Humanized monoclonal antibody',
  'Chimaeric monoclonal antibody','Murine monoclonal antibody','Monoclonal antibody, other',
  'Bispecific antibody','Trispecific antibody','Antibody-drug conjugate',
  'Cell engager, bispecific','Trispecific cell engager','Cell engager, other',
  'Fusion protein','Multispecific antibody',
]);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Citeline spreadsheet loader - file-based primary when SQL auth
// is unavailable (BeiGene Conditional Access policy blocks direct
// connection from unmanaged devices). Falls back to SQL if no file.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const COMPANY_SUFFIXES = /[\s\-]*(therapeutics?|biosciences?|biotechnolog(?:y|ies)|biotech|biopharma|pharmaceuticals?|pharma|sciences?|biotherapeutics?|oncolog(?:y|ies)|medicines?|health(?:care)?|biologics?|bio|inc\.?|ltd\.?|llc\.?|co\.?|corp\.?|corporation|group|holdings?|labs?|laborator(?:y|ies)|partners?)\s*$/i;

function stemCompany(name) {
  // Split CamelCase so "HanchorBio" â†' "Hanchor Bio" â†' stem "hanchor"
  let s = String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  // Strip suffixes up to 3 passes ("Bio Sciences Inc" â†' "Bio Sciences" â†' "Bio" â†' "")
  for (let i = 0; i < 3; i++) {
    const prev = s;
    s = s.replace(COMPANY_SUFFIXES, '').trim();
    if (s === prev) break;
  }
  return s.replace(/[^a-z0-9]/g, ''); // remove spaces, hyphens, punctuation
}

// Guards against false Citeline matches where the stem matches but the companies
// are clearly different entities (e.g. "Checkmate Therapeutics" â‰  "Checkmate
// Pharmaceuticals"). Strips only truly-generic legal suffixes (Inc, LLC, Ltd, Corp)
// - not company-type descriptors - then checks for containment. If the names
// diverge beyond legal suffix variation, the match is rejected.
function closeNameMatch(searchName, citeName) {
  const LEGAL_SUFFIX = /\s*(,\s*)?(inc\.?|ltd\.?|llc\.?|co\.?|corp\.?|corporation|limited|plc|sa\.?|nv|gmbh|ag|bv)\s*$/gi;
  const norm = s => s.replace(LEGAL_SUFFIX, '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, ' ');
  const a = norm(searchName);
  const b = norm(citeName);
  if (a === b) return true;
  // Allow whole-word containment: "Zymeworks BC" ∋ "Zymeworks", "Hoffmann-La Roche" ∋ "Roche"
  // Uses word-boundary matching (space-delimited) to prevent substring-inside-word false positives,
  // e.g. "heidelberg pharma" must NOT match "berg" just because "berg" is inside "heidelberg".
  const wordContains = (haystack, needle) =>
    new RegExp('(?:^|\\s)' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)').test(haystack);
  if (a.length > 3 && wordContains(b, a)) return true;
  if (b.length > 3 && wordContains(a, b)) return true;
  // Stem match: strip ALL company-type descriptors (Biologics, Therapeutics, etc.)
  // so "Duality Biologics" matches "Duality Biosciences" — the brand name is what matters
  const sa = stemCompany(searchName);
  const sb = stemCompany(citeName);
  if (sa && sb && sa.length >= 4 && sa === sb) return true;
  return false;
}

let citelineByName  = null; // map: exact companyName → row[]
let drugOverviewMap = {};   // map: drugId → drugOverview text

// Extract the first meaningful word from a company name for broad-sweep matching.
// Splits CamelCase so "JechoBio" → "jecho", "PrimeLink" → "prime"; skips leading
// generics (bio/the/new) that would produce too many coincidental hits.
function getRootWord(name) {
  if (!name) return '';
  const s = String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // CamelCase → words
    .toLowerCase().trim();
  const skip = new Set(['the', 'bio', 'new']);
  const words = s.split(/[\s\-]+/);
  const root  = words.find(w => w.replace(/[^a-z0-9]/g, '').length >= 3 && !skip.has(w))
             || words[0]
             || '';
  return root.replace(/[^a-z0-9]/g, '');
}

// All significant keywords from a name (used for lenient keyword-overlap matching).
// "Leads BioLabs" → ["leads", "biolabs"]; single-char and generic words are skipped.
function getAllKeywords(name) {
  const skip = new Set(['the', 'bio', 'new']);
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s\-]+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(w => w.length >= 3 && !skip.has(w));
}
let exclusionsIndex = null; // map: exact companyName → exclusion record

function loadCitelineSpreadsheet() {
  const candidates = [
    path.join(__dirname, 'citeline-data', 'Citeline_Screener_Data.xlsx'),
    path.join(__dirname, 'Citeline_Screener_Data.xlsx'),
    'C:/Users/arjun.shah/OneDrive - BeiGene/Desktop/CitelineBigData.xlsx',
    'C:/Users/arjun.shah/OneDrive - BeiGene/Citeline_Screener_Data.xlsx',
  ];
  const filePath = candidates.find(p => fs.existsSync(p));
  if (!filePath) {
    console.log('[citeline] No spreadsheet found - will attempt SQL connection');
    return;
  }
  console.log(`[citeline] Loading spreadsheet: ${path.basename(filePath)}`);
  const XLSX = require('xlsx');
  const wb   = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames.includes('Sheet2') ? 'Sheet2' : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);

  citelineByName  = {};
  drugOverviewMap = {};
  for (const row of rows) {
    const cn = row.companyName;
    if (!cn) continue;
    if (!citelineByName[cn]) citelineByName[cn] = [];
    citelineByName[cn].push(row);
    if (row.drugId && row.drugOverview && !drugOverviewMap[String(row.drugId)]) {
      drugOverviewMap[String(row.drugId)] = row.drugOverview;
    }
  }
  console.log(`[citeline] Spreadsheet ready: ${rows.length} rows, ${Object.keys(citelineByName).length} companies`);
}

function loadExclusionsSpreadsheet() {
  const candidates = [
    path.join(__dirname, 'citeline-data', 'Exclusions.xlsx'),
    path.join(__dirname, 'Exclusions.xlsx'),
    'C:/Users/arjun.shah/OneDrive - BeiGene/Desktop/Exclusions.xlsx',
    'C:/Users/arjun.shah/OneDrive - BeiGene/Documents/Exclusions.xlsx',
    'C:/Users/arjun.shah/OneDrive - BeiGene/Exclusions.xlsx',
  ];
  const filePath = candidates.find(p => fs.existsSync(p));
  if (!filePath) {
    console.log('[exclusions] No Exclusions spreadsheet found -- skipping');
    return;
  }
  console.log(`[exclusions] Loading: ${path.basename(filePath)}`);
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  exclusionsIndex = {};

  const oncNonBiolSheet = wb.Sheets['ONC, NON-BIOL'];
  if (oncNonBiolSheet) {
    const rows = XLSX.utils.sheet_to_json(oncNonBiolSheet);
    for (const row of rows) {
      const cn = row.companyName;
      if (!cn) continue;
      exclusionsIndex[cn] = { bucket: 'ONC_NON_BIOL', assets: row.oncologyAssets || '', companyName: cn };
    }
    console.log(`[exclusions] ONC, NON-BIOL: ${rows.length} companies`);
  }

  const nonOncSheet = wb.Sheets['NON ONC'];
  if (nonOncSheet) {
    const rows = XLSX.utils.sheet_to_json(nonOncSheet);
    for (const row of rows) {
      const cn = row.companyName;
      if (!cn || exclusionsIndex[cn]) continue;
      exclusionsIndex[cn] = { bucket: 'NON_ONC', indications: row.indicationGroups || '', companyName: cn };
    }
    console.log(`[exclusions] NON ONC: ${rows.length} companies`);
  }

  console.log(`[exclusions] Ready: ${Object.keys(exclusionsIndex).length} companies`);
}

function checkExclusions(companyName) {
  if (!exclusionsIndex) return null;
  const root = getRootWord(companyName);
  if (!root || root.length < 3) return null;

  // Stage 1: root-word substring scan (same as citelineGetAssetsLocal)
  let candidates = Object.keys(exclusionsIndex)
    .filter(cn => cn.toLowerCase().includes(root));

  // Stage 2: closeNameMatch guard
  let matched = candidates.find(cn => closeNameMatch(companyName, cn));

  // Stage 3: keyword-overlap fallback (handles city-prefix variants)
  if (!matched && candidates.length === 0) {
    const keywords = getAllKeywords(companyName);
    const fallback = Object.keys(exclusionsIndex).find(cn => {
      const flat = cn.toLowerCase().replace(/[^a-z0-9]/g, '');
      return keywords.length > 0 && keywords.every(k => flat.includes(k));
    });
    if (fallback) matched = fallback;
  }

  if (!matched) return null;
  const match = exclusionsIndex[matched];

  if (match.bucket === 'ONC_NON_BIOL') {
    const assetList = (match.assets || '').split(';').map(s => s.trim()).filter(Boolean).slice(0, 5).join(', ') || 'non-biologic assets';
    return { bucket: 'ONC_NON_BIOL', excludedReason: `All oncology assets are non-biologic: ${assetList}` };
  }
  if (match.bucket === 'NON_ONC') {
    const indList = (match.indications || '').split(';').map(s => s.trim()).filter(Boolean).slice(0, 3).join(', ') || 'non-oncology indications';
    return { bucket: 'NON_ONC', excludedReason: `No oncology assets -- pipeline covers: ${indList}` };
  }
  return null;
}

const EXCLUDED_STATUSES = new Set(['Discontinued', 'Withdrawn', 'Suspended', 'Ceased']);

function citelineGetAssetsLocal(companyName) {
  const root = getRootWord(companyName);

  if (!root || root.length < 3) {
    return { rows: [], coverageStatus: 'inconclusive-not-found', companyWebsite: null, pipelineUrl: null };
  }

  // Root-word substring search: find every Citeline company whose name contains
  // the root word (case-insensitive). "JechoBio" → root "jecho" matches
  // "Jecho Biopharmaceuticals"; "Primelink" → root "primelink" matches
  // "PrimeLink BioTherapeutics" but not "Prime Medicine".
  const candidates = Object.entries(citelineByName)
    .filter(([cn]) => cn.toLowerCase().includes(root));

  // Apply the close-name guard to reject coincidental substring hits
  // (e.g. root "impact" would also match "PACT Pharma" without this filter).
  let matchingCompanies = candidates
    .filter(([cn]) => closeNameMatch(companyName, cn));

  // Lenient fallback: city-prefix variants like "Nanjing Leadsbiolabs" for "Leads BioLabs".
  // When closeNameMatch finds nothing, require ALL significant keywords from the query to
  // appear inside the flattened (space-removed) candidate name.
  if (matchingCompanies.length === 0 && candidates.length > 0) {
    const keywords = getAllKeywords(companyName);
    if (keywords.length >= 2) {
      const overlap = candidates.filter(([cn]) => {
        const flat = cn.toLowerCase().replace(/\s+/g, '');
        return keywords.every(kw => flat.includes(kw));
      });
      if (overlap.length > 0) {
        console.log(`    [${companyName}] [citeline] keyword-overlap match: ${overlap.map(([cn]) => cn).join(', ')}`);
        matchingCompanies = overlap;
      }
    }
  }

  if (matchingCompanies.length === 0) {
    if (candidates.length > 0) {
      console.log(`    [${companyName}] [citeline] root "${root}" hit (${candidates.map(([cn]) => cn).slice(0, 5).join(', ')}) but none pass name guard - routing to website input`);
    }
    return { rows: [], coverageStatus: 'inconclusive-not-found', companyWebsite: null, pipelineUrl: null };
  }

  // Pick best match: prefer the one whose stem equals the query stem (most specific),
  // fall back to the first candidate.
  const needle = stemCompany(companyName);
  const bestMatch = matchingCompanies.find(([cn]) => stemCompany(cn) === needle) || matchingCompanies[0];
  const citelineCompanyName = bestMatch[0];
  const matchedRows = bestMatch[1];

  if (matchingCompanies.length > 1) {
    console.log(`    [${companyName}] [citeline] multiple name matches: ${matchingCompanies.map(([cn]) => cn).join(', ')} - using "${citelineCompanyName}"`);
  }

  // Company-level URL fields - same across all rows for this company
  const cleanUrl = v => (v && typeof v === 'string' && v.trim() && v.trim().toUpperCase() !== 'NULL') ? v.trim() : null;
  const companyWebsite = cleanUrl(matchedRows.find(r => r.companyWebsite)?.companyWebsite);
  const pipelineUrl    = cleanUrl(matchedRows.find(r => r.pipelineUrl)?.pipelineUrl);

  // Filter discontinued, regimens (combination "+" therapies), and qualifying modalities
  const active     = matchedRows.filter(r =>
    !EXCLUDED_STATUSES.has(r.globalStatus) &&
    r.drugPrimaryName && !r.drugPrimaryName.includes('+')
  );
  const qualifying = active.filter(r => QUALIFYING_BIOLOGIC_MODALITIES.has(r.drugTypeCaption));

  if (qualifying.length === 0) {
    const allModalities = [...new Set(active.map(r => r.drugTypeCaption).filter(Boolean))];
    const hasQualifyingBiologic = allModalities.some(m => QUALIFYING_BIOLOGIC_MODALITIES.has(m));
    return {
      rows: [],
      coverageStatus: hasQualifyingBiologic ? 'excluded-biologic-no-oncology' : 'excluded-small-molecule',
      companyWebsite, pipelineUrl,
      nonQualifyingModalities: allModalities,
    };
  }

  // Deduplicate by drugId - keep best modality per drug using MODALITY_PRIORITY
  const byDrugId = {};
  for (const row of qualifying) {
    const id = String(row.drugId);
    if (!byDrugId[id]) {
      byDrugId[id] = row;
    } else {
      const cur = MODALITY_PRIORITY[byDrugId[id].drugTypeCaption] || 99;
      const nxt = MODALITY_PRIORITY[row.drugTypeCaption] || 99;
      if (nxt < cur) byDrugId[id] = row;
    }
  }

  const rows = Object.values(byDrugId).map(r => ({
    drugId:           r.drugId,
    drug:             r.drugPrimaryName ? r.drugPrimaryName.replace(/BeiGene/gi, 'BeOne') : r.drugPrimaryName,
    altNames:         r.altNames ? r.altNames.replace(/BeiGene/gi, 'BeOne') : '',
    drugOverview:     r.drugOverview    || '',
    citelineModality: r.drugTypeCaption,
    citelinePhase:    r.globalStatus,
    status:           r.globalStatus,
    companyWebsite:   null,
    targets:          r.allTargets     || '',
    moa:              r.allMechanisms  || '',
    indications:      r.allDiseases    || '',
    drugOverview:     r.drugOverview   || '',
    allLicensees:     r.allLicensees   || '',
    allLicensers:     r.allLicensers   || '',
    allTerritories:   r.allTerritories || '',
    allDealTypes:     r.allDealTypes   || '',
    allManufacturers: r.allManufacturers || '',
    allPayloads:      r.allPayloads    || '',
    allTargets:       r.allTargets     || '',
    allTargetsRaw:    r.allTargets     || '',
  }));

  return { rows, coverageStatus: 'qualifying', companyWebsite, pipelineUrl };
}

async function citelineGetAssets(companyName) {
  if (citelineByName) return citelineGetAssetsLocal(companyName);
  const pool = await getCitelinePool();
  const result = await pool.request()
    .input('company', sql.NVarChar(200), companyName)
    .query(CITELINE_ASSETS_SQL);

  if (result.recordset.length > 0) {
    return {
      rows: result.recordset,
      coverageStatus: 'qualifying',
      companyWebsite: result.recordset[0]?.companyWebsite || null,
      pipelineUrl:    result.recordset[0]?.pipelineUrl    || null,
    };
  }

  // 0 qualifying assets - check what the company actually has in Citeline
  const checkResult = await pool.request()
    .input('company', sql.NVarChar(200), companyName)
    .query(CITELINE_MODALITY_CHECK_SQL);

  if (checkResult.recordset.length === 0) {
    return { rows: [], coverageStatus: 'inconclusive-not-found', companyWebsite: null };
  }

  const companyWebsite = checkResult.recordset.find(r => r.companyWebsite)?.companyWebsite || null;
  const modalityRows   = checkResult.recordset.filter(r => r.drugTypeCaption != null);

  if (modalityRows.length === 0) {
    // Company exists in Citeline but has no drug records at all
    return { rows: [], coverageStatus: 'inconclusive-not-found', companyWebsite };
  }

  const hasQualifyingBiologic = modalityRows.some(r => QUALIFYING_BIOLOGIC_MODALITIES.has(r.drugTypeCaption));
  return {
    rows: [],
    coverageStatus: hasQualifyingBiologic ? 'excluded-biologic-no-oncology' : 'excluded-small-molecule',
    companyWebsite,
    nonQualifyingModalities: [...new Set(modalityRows.map(r => r.drugTypeCaption))],
  };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public/private determination + 10-K lookup via SEC EDGAR
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// Exact-match only - Claude supplies this after reading it directly off the
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Auto-flag: Indication Synergy + Phase Synergy via ClinicalTrials.gov,
// Strategic Synergy via a small capped Claude research pass. Triggered
// on-demand from the results view ("Flag High Priority Assets"), not
// during initial screening - these need a registered trial (CT.gov) or
// deeper science detail that isn't always resolved in the main pass.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// Indication Synergy keyword list - hematology, lung, GI (colorectal/stomach/gallbladder/pancreas),
// women's cancers (breast/gyn). Prostate is explicitly NOT included.
// Simple keyword list — any of these anywhere in the Indication column → synergy.
// Prostate is excluded (not a BeOne focus). Everything else: if the word is there, it counts.
const INDICATION_SYNERGY_KEYWORDS = [
  // Lung
  'lung',
  // GI
  'gastric', 'gastro', 'stomach', 'colorectal', 'colon', 'rectal',
  'esophageal', 'esophagus', 'hepatocellular', 'liver cancer', 'liver carcinoma',
  'pancreatic', 'pancreas', 'biliary', 'bile duct', 'cholangiocarcinoma', 'gallbladder',
  'nasopharyngeal',
  // Women's cancers
  'breast', 'ovarian', 'cervical', 'endometrial', 'uterine',
  // Hematology
  'lymphoma', 'leukemia', 'myeloma', 'myeloid', 'myelodysplastic', 'myelodysplasia',
  // Biomarker-defined
  'microsatellite', 'MSI-H', 'MSI-high', 'dMMR', 'mismatch repair',
];

// Strip prostate mentions before checking — not a BeOne focus area.
const PROSTATE_RE = /prostate(\s+cancer|\s+carcinoma|\s+adenocarcinoma|\s+tumor)?/gi;

function matchesIndicationSynergy(text) {
  if (!text) return false;
  const cleaned = text.replace(PROSTATE_RE, '');
  const lower   = cleaned.toLowerCase();
  return INDICATION_SYNERGY_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
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

// Targets that qualify for checkpoint-IO-alt flag - non-PD-1/PD-L1 checkpoint receptors only.
// TCEs are excluded (they have their own masked-tce flag). PD-1/PD-L1 combos no longer qualify.
const CHECKPOINT_ALT_TARGETS = ['lag-3', 'lag3', 'tim-3', 'tim3', 'tigit', 'ctla-4', 'ctla4', 'vista', 'btla', 'cd96', 'nkg2a', 'ox40', 'cd134', '4-1bb', 'cd137', 'icos', 'cd278', 'gitr', 'cd357'];

// ── Overview-based flag patterns (mine drugOverview text) ────────────────────
// Checkpoint alt targets as free text
const OVERVIEW_CHECKPOINT_RE = /\b(lag-?3|tim-?3|tigit|ctla-?4|vista|btla|cd96|nkg2a|ox40|4-1bb|cd137|icos|gitr)\b/i;
// Masking / conditional activation language for masked TCE
const OVERVIEW_MASKED_TCE_RE = /\b(masked?|probody|conditional(?:ly)?\s*activ|TME[- ]cleavable|protease[- ]cleavable|enzyme[- ]cleavable|prodrug|masking\s+moiet|stimulus[- ]responsive|conditionally?\s+active|pro-?biologic|switchable)\b/i;
const OVERVIEW_TCE_RE        = /\b(t[- ]?cell\s+engag|bispecific.*t[- ]?cell|TCE|T[- ]cell\s+redirect|CD3)\b/i;
const OVERVIEW_4_1BB_RE      = /\b(4-1bb|cd137)\b/i;
// Novel ADC payload — dual or unique
const OVERVIEW_DUAL_PAYLOAD_RE   = /\b(dual[- ]payload|two\s+payload|dual[- ]warhead|two\s+warhead|combination\s+payload|dual[- ]drug)\b/i;
const OVERVIEW_NOVEL_PAYLOAD_RE  = /\b(DM1|DM4|maytansin|PBD|pyrrolobenzodiazepin|calicheamicin|tubulysin|cryptophycin|dolastatin|duocarmycin|alpha[- ]amanitin|amanitin|MMAF|monomethyl\s+auristatin\s+F|colchicine|combretastatin|KSP\s+inhibitor|kinesin\s+spindle|CC-1065|auristatin\s+F)\b/i;
const OVERVIEW_COMMON_PAYLOAD_RE = /\b(DXd|deruxtecan|SN-38|exatecan|MMAE|monomethyl\s+auristatin\s+E)\b/i;
const OVERVIEW_ADC_RE            = /\b(antibody[- ]drug\s+conjugate|ADC|conjugate)\b/i;

// Compute flags directly from Steps 1+2 asset data (no web research needed).
// Called automatically after every screening run - no manual autoflag step required
// for indication-synergy, phase-synergy, checkpoint-io-alt, or masked-tce-4-1bb (4-1BB arm).
// Compute flags from asset data. Claude may set some flags during screening;
// this function supplements with structured-data checks and drugOverview text.
function computeFlagsFromAsset(asset, overview) {
  if (!asset || asset.overallStatus === 'excluded') return [];
  const flags   = new Set();
  const targets  = cleanTargetArray(asset.targets || []).map(t => (t || '').toLowerCase());
  const modality = (asset.modality || '').toLowerCase();
  const phase    = (asset.phase || '').toLowerCase();
  const ov       = overview || '';  // drugOverview text — second-check source

  // ── Indication synergy ────────────────────────────────────────────────────
  if (matchesIndicationSynergy(asset.indication || '') || matchesIndicationSynergy(asset.indications || ''))
    flags.add('indication-synergy');

  // ── Phase synergy ─────────────────────────────────────────────────────────
  const leadOptTerms = ['lead opt', 'lead optimization', 'lead candidate', 'lead selection'];
  if (leadOptTerms.some(t => phase.includes(t))) flags.add('phase-synergy');
  if (phase.includes('2/3') || phase.includes('ii/iii') || phase.includes('2/iii') || phase.includes('ii/3')) flags.add('phase-synergy');

  // ── Checkpoint IO alt ─────────────────────────────────────────────────────
  // Primary: structured targets array.
  // Second check: drugOverview text — catches cases where target name is only in description.
  const isTCE = modality === 'tce' || modality.includes('t cell engager') || modality.includes('t-cell engager');
  const hasAltCheckpointTargets  = targets.some(t => CHECKPOINT_ALT_TARGETS.some(c => t.includes(c)));
  const hasAltCheckpointOverview = ov && OVERVIEW_CHECKPOINT_RE.test(ov);
  if ((hasAltCheckpointTargets || hasAltCheckpointOverview) && !isTCE)
    flags.add('checkpoint-io-alt');

  // ── Masked TCE (4-1BB / masking moiety) ──────────────────────────────────
  // Primary: 4-1BB / CD137 in structured targets.
  // Second check: drugOverview — 4-1BB mention OR masking language on a TCE.
  const has41BBTargets  = targets.some(t => t.includes('4-1bb') || t.includes('cd137'));
  const has41BBOverview = ov && OVERVIEW_4_1BB_RE.test(ov);
  const hasMaskingOv    = ov && OVERVIEW_MASKED_TCE_RE.test(ov) && OVERVIEW_TCE_RE.test(ov);
  if (has41BBTargets || has41BBOverview || hasMaskingOv)
    flags.add('masked-tce-4-1bb');

  // ── ADC novel payload ─────────────────────────────────────────────────────
  // From drugOverview only — payload names are not in structured Citeline columns.
  // Fires when: (a) novel/rare payload named explicitly, OR (b) dual payload mentioned.
  // Suppressed when only common payloads (DXd, SN-38, MMAE) appear without a novel one.
  const isADC = modality.includes('adc') || modality.includes('antibody-drug') ||
                modality.includes('antibody drug') || OVERVIEW_ADC_RE.test(ov);
  if (isADC && ov) {
    const hasDual       = OVERVIEW_DUAL_PAYLOAD_RE.test(ov);
    const hasNovel      = OVERVIEW_NOVEL_PAYLOAD_RE.test(ov);
    const hasCommonOnly = OVERVIEW_COMMON_PAYLOAD_RE.test(ov) && !hasNovel;
    if (hasDual || (hasNovel && !hasCommonOnly))
      flags.add('adc-novel-payload');
  }

  return Array.from(flags);
}

// Apply auto-flags to all qualifying assets in a screening result and bubble up to company level.
const CEASED_PHASES = new Set(['ceased', 'discontinued', 'withdrawn', 'suspended', 'terminated', 'no longer pursued']);

function applyAutoFlags(result) {
  if (!result || !result.assets) return result;
  const companyFlags = new Set(result.flags || []);
  for (const asset of result.assets) {
    // Exclude assets where Claude returned a ceased/discontinued phase
    if (asset.overallStatus !== 'excluded') {
      const p = (asset.phase || '').toLowerCase().trim();
      if (CEASED_PHASES.has(p) || [...CEASED_PHASES].some(c => p.includes(c))) {
        asset.overallStatus  = 'excluded';
        asset.excludedReason = `Development ceased (phase: ${asset.phase})`;
      }
    }
    const overview = drugOverviewMap[String(asset.drugId || '')] || asset.drugOverview || '';
    const derived = computeFlagsFromAsset(asset, overview);
    asset.flags = derived;
    derived.forEach(f => companyFlags.add(f));
  }
  result.flags = Array.from(companyFlags);
  return result;
}

// Strategic Synergy needs molecular detail (payload identity, masking moiety,
// exact checkpoint target) that the main screening pass doesn't always capture.
// Capped at 3 tool calls total - if nothing turns up, leave the flag unset
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
Asset: ${asset.name || '(unnamed)'} - modality: ${asset.modality || 'unknown'}, targets: ${(asset.targets || []).join(', ') || 'unknown'}
Known indication: ${asset.indication || 'unknown'}
Existing research notes: ${asset.notes || company.researchNotes || '(none)'}
Company website: ${company.website || '(unknown)'}

Qualifies if ANY of:
1. masked-tce-4-1bb: a TCE with EITHER a masking/prodrug moiety (TME-cleavable, probody, conditional activation) OR engaging 4-1BB (CD137) as one of its targets.
2. adc-novel-payload: an ADC using a single payload OTHER than a TOP1 inhibitor (DXd/deruxtecan, SN-38, exatecan) or MMAE - e.g. DM1, DM4, PBD, calicheamicin, tubulysin, cryptophycin - OR a dual payload combination other than MMAE+TOP1.
3. checkpoint-io-alt: targets a non-PD-1/PD-L1 checkpoint receptor (LAG-3, TIM-3, TIGIT, CTLA-4, VISTA, BTLA, CD96, NKG2A, OX40, 4-1BB, ICOS, GITR) AND is NOT a TCE modality. TCEs belong to masked-tce-4-1bb. PD-1/PD-L1 combinations do NOT qualify for this flag.

BUDGET: at most 3 tool calls total. Look at the asset's own science/pipeline page or the
existing notes above first - only search if the specific molecular detail (payload identity,
masking moiety, exact checkpoint target) genuinely isn't there yet. If you still can't find
clear evidence after 3 calls, do NOT guess - return "none".

Return ONLY this JSON, nothing else:
{"flag": "masked-tce-4-1bb" | "adc-novel-payload" | "checkpoint-io-alt" | "none", "reason": ""}`
  }];

  for (let i = 0; ; i++) {
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
  return null; // exhausted the budget without a clear answer - don't guess
}



// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Citeline primary track - SQL Steps 1+2, then Claude for Steps 3+4+5
// Returns a full result object, or null if no qualifying assets found (fall through).
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function screenWithCitelinePrimary(companyName, client) {
  console.log(`    [${companyName}] [citeline] querying Citeline SQL...`);
  const { rows, coverageStatus, companyWebsite, pipelineUrl, nonQualifyingModalities } = await citelineGetAssets(companyName);

  if (coverageStatus !== 'qualifying') {
    if (coverageStatus === 'inconclusive-not-found') {
      console.log(`    [${companyName}] [citeline] company not found in Citeline — falling through`);
      return null;
    }
    const modSample = (nonQualifyingModalities || []).slice(0, 3).join(', ');
    const excludedReason = coverageStatus === 'excluded-small-molecule'
      ? `No oncology biologics in Citeline — small molecule pipeline (${modSample})`
      : `Biologic pipeline present but no anticancer indication in Citeline (${modSample})`;
    console.log(`    [${companyName}] [citeline] ${excludedReason}`);
    return {
      name: companyName, id: slugify(companyName), type: 'unknown',
      website: companyWebsite, status: 'excluded', sourceTrack: 'citeline',
      excludedAt: 'Steps 1+2', excludedReason,
      inconclusiveReason: '', assets: [], beoneAnalyzed: false, beoneOutcome: null,
      flags: [], researchNotes: '', allSourcesConsulted: [], evidenceSnapshots: [],
      sources: [{ url: 'citeline:sql', label: 'Citeline database (Steps 1+2)', usedFor: 'Steps 1+2 — oncology biologic identification', type: 'citeline' }],
    };
  }

  console.log(`    [${companyName}] [citeline] ${rows.length} qualifying assets`);

  const allNDR = rows.every(r => r.citelinePhase === 'No Development Reported' || r.status === 'No Development Reported');
  const thinCoverage = rows.length <= 2
    || rows.some(r => !r.targets || r.targets.trim() === '')
    || allNDR;

  const assetLines = rows.map((r, i) => {
    const modality = CITELINE_MODALITY_MAP[r.citelineModality] || r.citelineModality;
    const phase    = CITELINE_PHASE_MAP[r.citelinePhase] || r.citelinePhase || 'Unknown';
    return (
      `[${i + 1}] ${r.drug} (drugId: ${r.drugId})\n` +
      `  AltNames   : ${r.altNames || 'None'}\n` +
      `  Modality   : ${modality} (Citeline: ${r.citelineModality})\n` +
      `  MOA/Targets: ${r.targets || 'Undisclosed'}\n` +
      (r.allTargetsRaw ? `  Targets(mol): ${r.allTargetsRaw}\n` : '') +
      `  Indications: ${r.indications || 'Not specified'}\n` +
      `  Overview   : ${r.drugOverview ? r.drugOverview.substring(0, 600) : ''}\n` +
      `  Phase      : ${phase}\n` +
      `  Status     : ${r.status}` +
      (r.drugOverview ? `\n  Overview   : ${r.drugOverview.slice(0, 500)}` : '')
    );
  }).join('\n\n');

  // For thin-coverage companies pre-fetch the pipeline page
  let websiteContent = null;
  let fetchedPipelineUrl = null;
  if (thinCoverage && (pipelineUrl || companyWebsite)) {
    const timeout15s = new Promise(resolve => setTimeout(() => resolve({ content: null, url: null }), 15000));
    const fetchWork = (async () => {
      if (pipelineUrl) {
        console.log(`    [${companyName}] [citeline] thin-coverage pipeline URL: ${pipelineUrl}`);
        try {
          const content = await fetchWebpage(pipelineUrl);
          if (content && content.length > 100) return { content, url: pipelineUrl };
        } catch (e) {
          console.log(`    [${companyName}] [citeline] pipeline URL fetch failed: ${e.message}`);
        }
      }
      if (companyWebsite) {
        console.log(`    [${companyName}] [citeline] thin-coverage crawling homepage: ${companyWebsite}`);
        try {
          const fetched = await findAndFetchPipelinePage(companyWebsite);
          if (fetched && fetched.content && fetched.content.length > 100) return fetched;
        } catch (e) {
          console.log(`    [${companyName}] [citeline] homepage crawl failed: ${e.message}`);
        }
      }
      return { content: null, url: null };
    })();
    const { content, url } = await Promise.race([fetchWork, timeout15s]);
    if (content) {
      websiteContent = content;
      fetchedPipelineUrl = url;
      console.log(`    [${companyName}] [citeline] pipeline page fetched (${content.length} chars) from ${url}`);
    } else {
      console.log(`    [${companyName}] [citeline] pipeline fetch timed out or empty — proceeding without`);
    }
  }

  const thinCoverageInstruction = thinCoverage && websiteContent
    ? `THIN COVERAGE — MERGE ASSETS FROM BOTH SOURCES:\nCiteline data is sparse (${allNDR ? 'all NDR' : rows.length <= 2 ? `only ${rows.length} asset(s)` : 'missing targets'}). Pipeline page pre-fetched below.\nMerge Citeline assets with website assets into one list, then run Steps 3–5.\n\nPIPELINE PAGE (${fetchedPipelineUrl}):\n${'─'.repeat(60)}\n${websiteContent.slice(0, 8000)}\n${'─'.repeat(60)}`
    : `Steps 1+2 are DONE. Start at Step 3 (competitive overlap) immediately, then Steps 4+5 via OneBD.`;

  const messages = [{
    role: 'user',
    content:
      `Screen this company through the Citeline primary track: "${companyName}"\n\n` +
      `CITELINE DATABASE — Steps 1+2 complete (${rows.length} qualifying oncology biologic assets):\n\n` +
      `${assetLines}\n\n` +
      `Company website: ${companyWebsite || '(not in Citeline)'}\n\n` +
      thinCoverageInstruction,
  }];

  const fetchedUrls = [];
  const evidenceSnapshots = [];
  let oneBdCompanyId   = null;
  let oneBdDealsFetched = false;

  for (let i = 0; ; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 16000,
      temperature: 0,
      system: CITELINE_PRIMARY_PROMPT,
      tools: CITELINE_TOOLS,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      if (oneBdCompanyId && !oneBdDealsFetched) {
        console.log(`    [${companyName}] [citeline] [guard] onebd_get_deals skipped — fetching now`);
        let dealsOutput;
        try { dealsOutput = await oneBdGetDealsForTool(oneBdCompanyId); oneBdDealsFetched = true; }
        catch (e) { dealsOutput = JSON.stringify({ deals: [], error: e.message }); }
        messages.push({ role: 'user', content:
          `MANDATORY CORRECTION: You must call onebd_get_deals before producing output.\n` +
          `Here are all Cortellis deals for this company (company_id=${oneBdCompanyId}):\n\n${dealsOutput}\n\n` +
          `Apply Steps 4+5 using these deals, then return the complete revised JSON.` });
        continue;
      }
      const textBlock = response.content.find(b => b.type === 'text');
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        messages.push({ role: 'user', content: 'Return ONLY the JSON screening result now — no other text.' });
        continue;
      }
      const result = JSON.parse(jsonMatch[0]);
      result.name        = companyName.replace(/BeiGene/gi, 'BeOne');
      result.id          = slugify(companyName);
      result.sourceTrack = 'citeline';
      result.website     = result.website || companyWebsite || null;
      if (result.beoneAnalyzed == null) result.beoneAnalyzed = false;
      if (result.beoneOutcome  == null) result.beoneOutcome  = null;
      if (!Array.isArray(result.flags)) result.flags = [];
      if (!Array.isArray(result.deals)) result.deals = [];
      if (thinCoverage && !result.flags.includes('thin-coverage')) result.flags.push('thin-coverage');
      result.allSourcesConsulted = [...new Set(fetchedUrls)];
      result.evidenceSnapshots   = evidenceSnapshots;
      if (!Array.isArray(result.sources)) result.sources = [];
      if (!result.sources.some(s => s.url === 'citeline:sql')) {
        result.sources.unshift({ url: 'citeline:sql', label: 'Citeline database (Steps 1+2)', usedFor: 'Steps 1+2 — oncology biologic identification', type: 'citeline' });
      }
      return result;
    }

    if (response.stop_reason === 'pause_turn') {
      console.log(`    [${companyName}] [citeline] [pause_turn] iteration ${i + 1}`);
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const toolUse of response.content.filter(b => b.type === 'tool_use')) {
        console.log(`    [${companyName}] [citeline] [tool] ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 100)}`);
        let output;
        try {
          if (toolUse.name === 'fetch_webpage') {
            output = await fetchWebpage(toolUse.input.url, toolUse.input.section);
            fetchedUrls.push(toolUse.input.url);
          } else if (toolUse.name === 'onebd_resolve_company') {
            output = await oneBdResolveCompanyForTool(toolUse.input.companyName);
            try { const p = JSON.parse(output); if (p.found && p.id) oneBdCompanyId = p.id; } catch (_) {}
          } else if (toolUse.name === 'onebd_get_deals') {
            output = await oneBdGetDealsForTool(toolUse.input.companyId);
            oneBdDealsFetched = true;
          } else if (toolUse.name === 'onebd_resolve_asset') {
            output = await oneBdResolveAssetForTool(toolUse.input.assetName);
          } else {
            output = `Unknown tool: ${toolUse.name}`;
          }
        } catch (e) { output = `Tool error: ${e.message}`; }
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: output });
      }
      messages.push({ role: 'user', content: toolResults });
    } else if (response.stop_reason === 'max_tokens') {
      messages.push({ role: 'user', content: 'Your output was cut off. Continue and complete the JSON screening result now.' });
    } else {
      console.log(`    [${companyName}] [citeline] [unexpected] stop_reason=${response.stop_reason} — breaking`);
      break;
    }
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Step 0 - Big Pharma pre-filter (static list, instant, no research)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Claude API call with tool loop
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Strip characters that break prompt formatting when company names come from
// external spreadsheets (smart quotes, em-dashes, control chars, etc.).
function sanitizeCompanyName(name) {
  if (!name || typeof name !== 'string') return name;
  return name
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // smart single quotes
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // smart double quotes
    .replace(/[\u2013\u2014\u2015]/g, '-')                       // en/em dash
    .replace(/[\u00A0\u202F\u2009]/g, ' ')                       // non-breaking / narrow spaces
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')               // control characters
    .replace(/[^\x20-\x7E\u00C0-\u024F\u4E00-\u9FFF\u3400-\u4DBF]/g, '') // keep printable + CJK
    .replace(/\s+/g, ' ')
    .trim();
}

async function screenWithClaude(companyName, client, websiteUrl = null, opts = {}) {
  companyName = sanitizeCompanyName(companyName) || companyName;
  const { skipCiteline = false } = opts;

  // Step 0 first - instant, no research needed, per the plan. Skips the Claude
  // call entirely for an obvious Big Pharma match.
  const bigPharmaMatch = matchesBigPharma(companyName);
  if (bigPharmaMatch) {
    console.log(`    [${companyName}] [pre-filter] EXCLUDED - matches Big Pharma list: ${bigPharmaMatch}`);
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

  // â”€â”€ PRIMARY TRACK: Citeline SQL (Steps 1+2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skipCiteline && (citelineByName || DefaultAzureCredential)) {
    console.log(`    [${companyName}] [primary-track] Citeline SQL`);
    let citelineResult = null;
    let citelineError  = null;
    try {
      citelineResult = await screenWithCitelinePrimary(companyName, client);
    } catch (e) {
      citelineError = e.message;
      console.log(`    [${companyName}] [citeline] [error] ${e.message} - falling through to website input`);
    }
    if (citelineResult) {
      applyAutoFlags(citelineResult);
      logScreeningBreakdown(citelineResult);
      console.log(`    [${companyName}] [FINAL] ${citelineResult.status} (citeline track)${citelineResult.excludedAt ? ' - excluded at ' + citelineResult.excludedAt : ''}${citelineResult.inconclusiveReason ? ' - ' + citelineResult.inconclusiveReason : ''}`);
      return citelineResult;
    }
    // Check Exclusions spreadsheet before routing to website input
    const exclusionMatch = checkExclusions(companyName);
    if (exclusionMatch) {
      console.log(`    [${companyName}] [exclusions] ${exclusionMatch.bucket}: ${exclusionMatch.excludedReason}`);
      return {
        id: slugify(companyName),
        name: companyName.replace(/BeiGene/gi, 'BeOne'),
        type: 'unknown', website: null,
        status: 'excluded', sourceTrack: 'citeline',
        excludedAt: 'Steps 1+2', excludedReason: exclusionMatch.excludedReason,
        excludedSource: '', inconclusiveReason: '',
        assets: [], deals: [], beoneAnalyzed: false, beoneOutcome: null,
        flags: [], externalSourcing: false, externalSources: [], researchNotes: '',
        sources: [{ url: 'citeline:exclusions', label: 'Citeline Exclusions list', usedFor: 'Steps 1+2 — modality/indication pre-filter', type: 'citeline' }],
      };
    }
    // Distinguish 'not found in Citeline' from 'found but screening threw an error'
    const inconclusiveReason = citelineError
      ? `Citeline screening error - website input needed (${citelineError.slice(0, 120)})`
      : 'Not found in Citeline database - website input needed';
    console.log(`    [${companyName}] [citeline→website-input] ${inconclusiveReason}`);
    return {
      id: slugify(companyName),
      name: companyName.replace(/BeiGene/gi, 'BeOne'),
      type: 'unknown',
      website: null,
      status: 'inconclusive',
      sourceTrack: 'website-input',
      excludedAt: null,
      excludedReason: '',
      excludedSource: '',
      inconclusiveReason,
      assets: [],
      deals: [],
      beoneAnalyzed: false,
      beoneOutcome: null,
      flags: [],
      externalSourcing: false,
      externalSources: [],
      researchNotes: '',
      sources: [],
    };
  }
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // ── WEBSITE INPUT TRACK ──────────────────────────────────────────────────────
  // Reached when skipCiteline=true. Two sub-modes:
  //   • URL provided  → fetch directly (no web_search)
  //   • No URL        → use web_search (max 3) to find the pipeline page first
  let _wsSystemPrompt, _wsTools, messages;

  if (!websiteUrl) {
    // No user-supplied URL and not skipped — search for the pipeline page.
    console.log(`    [${companyName}] [website-input-track] No URL — searching for pipeline page`);
    _wsSystemPrompt = WEBSITE_INPUT_SEARCH_SYSTEM_PROMPT;
    _wsTools        = WEBSITE_INPUT_SEARCH_TOOLS;
    messages = [
      {
        role: 'user',
        content: `Screen this company for a BeOne Medicines manufacturing partnership: "${companyName}"

WEBSITE INPUT TRACK - NO URL PROVIDED: No pipeline URL was given. Use web_search to find it.

STEP 1: Search for the company's pipeline page.
 - Try: "${companyName} pipeline", "${companyName} oncology program", "${companyName} biologics clinical"
 - Maximum 3 web_search calls. Once you find a relevant company or pipeline URL, fetch it with fetch_webpage.
 - If after 3 searches no oncology biologic pipeline is found, return: status="inconclusive", inconclusiveReason="No oncology pipeline found via web search"

STEP 2: Extract all assets and check qualification as usual.
PERMISSIVE: If the page shows a qualifying biologic in a cancer area but no named assets/targets, screen IN — create assets from what is visible.

Then proceed to Steps 3, 4, 5.

BUDGET: 9 tool calls max (≤3 searches + ≤2 fetches + resolve_company + get_deals + ≤2 asset resolves).
Never end a turn with only a plan — make the tool call or return the JSON in the same turn.`
      }
    ];
  } else {
    // User-supplied URL — fetch directly, no web search needed.
    console.log(`    [${companyName}] [website-input-track] Fetching user-supplied URL: ${websiteUrl}`);
    _wsSystemPrompt = WEBSITE_INPUT_SYSTEM_PROMPT;
    _wsTools        = WEBSITE_INPUT_TOOLS;
    messages = [
      {
        role: 'user',
        content: `Screen this company for a BeOne Medicines manufacturing partnership: "${companyName}"

WEBSITE INPUT TRACK - URL PROVIDED: ${websiteUrl}

STEP 1: Call fetch_webpage("${websiteUrl}") immediately to load the pipeline page.
 - If the page is a general company homepage (not showing specific drug candidates), look for a /pipeline, /science, /programs, /research, or /therapeutic-areas link on the SAME domain and fetch that subpage instead.
 - Maximum 2 fetch_webpage calls for pipeline discovery.
 - Extract ALL individually named drug candidates at any development phase (Discovery through Approved).
 - Exclude assets explicitly marked as ceased, discontinued, terminated, or withdrawn.

STEP 2: For each extracted asset, check:
  (a) Is it an oncology biologic? Qualifying: mAb, bsAb, tsAb, ADC, TCE, NKCE, Fc-fusion, Immunocytokine
  (b) Does the company manufacture the biologic drug substance? Exclude AI-only, payload-only, fill & finish only.
PERMISSIVE: If the page mentions a qualifying biologic in a cancer area but no named assets or targets, screen IN — create assets from what is visible (modality, indication). Do not return inconclusive for sparse data.

If the URL is completely unreadable or contains zero oncology biologic content, return:
  status="inconclusive", inconclusiveReason="Website Input Needed - provided URL was not readable or contained no pipeline data"

Then proceed directly to Steps 3, 4, 5 (competitive overlap then OneBD deals).

BUDGET: 6 tool calls max (up to 2 URL fetches + resolve_company + get_deals + up to 2 asset resolves).
Never end a turn with only a plan - make the tool call or return the JSON in the same turn.`
      }
    ];
  }

  const collectedSources = [];
  const fetchedUrls = [];
  const evidenceSnapshots = [];
  let oneBdCompanyId     = null;
  let oneBdDealsFetched  = false;

  for (let i = 0; ; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
      temperature: 0,
      system: _wsSystemPrompt,
      tools: _wsTools,
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
      // Guard: if Claude resolved the company but skipped onebd_get_deals, force it now
      if (oneBdCompanyId && !oneBdDealsFetched) {
        console.log(`    [${companyName}] [website-input] [guard] onebd_get_deals skipped — fetching now`);
        let dealsOutput;
        try {
          dealsOutput = await oneBdGetDealsForTool(oneBdCompanyId);
          oneBdDealsFetched = true;
        } catch (e) {
          dealsOutput = JSON.stringify({ deals: [], error: e.message });
        }
        messages.push({
          role: 'user',
          content:
            `MANDATORY CORRECTION: You must call onebd_get_deals before producing output.\n` +
            `Here are all Cortellis deals for this company (company_id=${oneBdCompanyId}):\n\n${dealsOutput}\n\n` +
            `Apply Steps 3+4+5 using these deals, then return the complete revised JSON.`,
        });
        continue;
      }

      const textBlock = response.content.find(b => b.type === 'text');
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        console.log(`    [${companyName}] [warn] No JSON in response, asking Claude to convert: “${(textBlock ? textBlock.text : '').slice(0, 150)}”`);
        messages.push({
          role: 'user',
          content: 'That was not valid JSON. Based on everything you found above, return ONLY the JSON screening result now — no other text. If you could not determine something, use “inconclusive” for that field rather than explaining in prose.',
        });
        continue;
      }

      const result = JSON.parse(jsonMatch[0]);
      result.name = companyName.replace(/BeiGene/gi, 'BeOne');
      result.id   = slugify(companyName);
      result.sourceTrack = result.sourceTrack || 'website-input';
      if (result.beoneAnalyzed == null) result.beoneAnalyzed = false;
      if (result.beoneOutcome  == null) result.beoneOutcome  = null;
      if (!Array.isArray(result.flags)) result.flags = [];
      if (!Array.isArray(result.deals)) result.deals = [];

      // Claude's own judgment call on whether the website itself was ever usable
      // drives externalSourcing - a search happening at all (e.g. step 0a finding
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
        // purple-flag removed - externalSourcing is tracked but not surfaced as a flag
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

    // web_search is server-side now - Anthropic resolves it automatically and
    // includes results directly in response.content. If its internal search
    // loop hits its own iteration cap, the API returns pause_turn; just
    // re-send (assistant content already pushed above) to let it continue.
    // This previously logged nothing, making a long pause_turn chain (e.g.
    // open-ended name-variant searching) invisible until the iteration
    // budget silently ran out - log every occurrence now.
    if (response.stop_reason === 'pause_turn') {
      console.log(`    [${companyName}] [pause_turn] internal search loop continuing (iteration ${i + 1})`);
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
          } else if (toolUse.name === 'onebd_resolve_company') {
            output = await oneBdResolveCompanyForTool(toolUse.input.companyName);
            try {
              const parsed = JSON.parse(output);
              if (parsed.found && parsed.id) oneBdCompanyId = parsed.id;
            } catch (_) {}
          } else if (toolUse.name === 'onebd_get_deals') {
            output = await oneBdGetDealsForTool(toolUse.input.companyId);
            oneBdDealsFetched = true;
          } else if (toolUse.name === 'onebd_resolve_asset') {
            output = await oneBdResolveAssetForTool(toolUse.input.assetName);
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

  // Exhausted the iteration budget without reaching end_turn+JSON - degrade
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Layer-by-layer breakdown logging
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function logScreeningBreakdown(result) {
  const tag = `[${result.name}]`;
  const track = result.sourceTrack === 'citeline' ? 'citeline (primary)' : 'secondary (web research)';
  console.log(`    ${tag} [track] ${track}`);

  if (result.excludedAt === 'pre-filter') {
    console.log(`    ${tag} [pre-filter] EXCLUDED (Big Pharma) - ${result.excludedReason || ''}`);
    return;
  }
  console.log(`    ${tag} [pre-filter] passed - biotech/biopharma`);

  if (result.externalSourcing) {
    console.log(`    ${tag} [purple-flag] Not Sourced From Company Website - company website never loaded usable content`);
    (result.externalSources || []).forEach(s => console.log(`      ${tag} [source] ${s.url}${s.title ? ' - ' + s.title : ''}`));
  }

  if (!result.assets || result.assets.length === 0) {
    console.log(`    ${tag} No assets identified.${result.inconclusiveReason ? ' Reason: ' + result.inconclusiveReason : ''}`);
    return;
  }

  result.assets.forEach((asset, i) => {
    console.log(`    ${tag} Asset ${i + 1}/${result.assets.length}: ${asset.name} (${asset.modality || '?'})`);
    for (const layer of ['layer1', 'layer2', 'layer3', 'layer4']) {
      const l = asset[layer];
      if (l) console.log(`      ${tag} [${layer}] ${l.status}${l.reason ? ' - ' + l.reason : ''}`);
    }
    console.log(`      ${tag} [overall] ${asset.overallStatus}`);
  });

  // Layer 5 (direct competitor check) runs client-side in the browser - 
  // it just compares modality+targets against BEONE_PIPELINE, no research needed.
  if (result.researchNotes) console.log(`    ${tag} [notes] ${result.researchNotes}`);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Build a human-readable console log string from a result object
// (same information as logScreeningBreakdown but returned as text
//  so it can be sent to the client and shown in the console modal)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildScreenerLog(result) {
  const lines = [];
  const tag = `[${result.name}]`;

  lines.push(`${tag} Status: ${result.status.toUpperCase()}`);
  if (result.sourceTrack) {
    const trackLabel = result.sourceTrack === 'citeline' ? 'Citeline SQL (primary)' : 'Web research (secondary)';
    lines.push(`${tag} [track] ${trackLabel}`);
  }

  if (result.excludedAt === 'pre-filter') {
    lines.push(`${tag} [pre-filter] EXCLUDED (Big Pharma) - ${result.excludedReason || ''}`);
    return lines.join('\n');
  }
  lines.push(`${tag} [pre-filter] passed - biotech/biopharma`);

  if (result.externalSourcing) {
    lines.push(`${tag} [purple-flag] Not Sourced From Company Website`);
    (result.externalSources || []).forEach(s =>
      lines.push(`  ${tag} [source] ${s.url}${s.title ? ' - ' + s.title : ''}`)
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
      if (l) lines.push(`  ${tag} [${layer}] ${l.status}${l.reason ? ' - ' + l.reason : ''}`);
    }
    lines.push(`  ${tag} [overall] ${asset.overallStatus}`);
  });

  if (result.inconclusiveReason) lines.push(`${tag} [inconclusive] ${result.inconclusiveReason}`);
  if (result.researchNotes)      lines.push(`${tag} [notes] ${result.researchNotes}`);

  return lines.join('\n');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// API endpoint
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Run history endpoints
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// Bulk-sync company final statuses after Ask 1 re-screening.
// Called once after runRescreening() completes to stamp every company's
// final bucket (qualifying / excluded / inconclusive) into the DB,
// including cached companies that were never individually saved.
app.post('/api/runs/:id/sync', async (req, res) => {
  try {
    const runId = parseInt(req.params.id, 10);
    if (!runId) return res.status(400).json({ error: 'Invalid run id' });
    const { companies } = req.body;
    if (!Array.isArray(companies)) return res.status(400).json({ error: 'companies must be an array' });

    // Fire all saves concurrently (saveCompanyToDb uses ON CONFLICT ... DO UPDATE)
    await Promise.all(companies.map(c => saveCompanyToDb(runId, c)));
    res.json({ ok: true, saved: companies.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// API endpoint
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/api/screen', async (req, res) => {
  const { company, runId, websiteUrl, skipCiteline } = req.body;
  if (!company) return res.status(400).json({ error: 'Missing company name' });

  const apiKey = process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured. Enter your key in the screener settings.' });

  // SSE — keeps connection alive through deployment proxy timeouts
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const _ka = setInterval(() => res.write('data: {"type":"keepalive"}\n\n'), 5000);
  const sseEnd = (data) => { clearInterval(_ka); res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); };

  console.log(`\n${'â”€'.repeat(60)}\n[${company}] Screening: ${company}${websiteUrl ? ` (URL: ${websiteUrl})` : ''}\n${'â”€'.repeat(60)}`);

  try {
    const client = new Anthropic({ apiKey, maxRetries: 5 });

    const result = await _screeningLogStore.run(
      (text) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'log', text })}\n\n`); },
      () => screenWithClaude(company, client, websiteUrl || null, { skipCiteline: !!skipCiteline })
    );
    applyAutoFlags(result);
    logScreeningBreakdown(result);
    console.log(`    [${company}] [FINAL] ${result.status}${result.excludedAt ? ' (excluded at ' + result.excludedAt + ')' : ''}${result.inconclusiveReason ? ' - ' + result.inconclusiveReason : ''}`);
    result.screenerLog = buildScreenerLog(result);
    if (runId) saveCompanyToDb(runId, result);
    sseEnd({ type: 'result', data: result });
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
    console.error(`  [${company}] âœ— ${isTransient ? '(transient - safe to re-run) ' : ''}${errMsg}`);
    const errorResult = {
      name: company,
      id: slugify(company),
      type: 'unknown',
      website: null,
      status: 'inconclusive',
      excludedAt: null,
      excludedReason: '',
      inconclusiveReason: isTransient
        ? 'Anthropic API hiccup (rate limit/overload/server error) - re-run this company individually, not a research failure'
        : 'Screening error - see server console',
      assets: [],
      beoneAnalyzed: false,
      beoneOutcome: null,
      flags: [],
      researchNotes: errMsg,
    };
    errorResult.screenerLog = buildScreenerLog(errorResult);
    if (runId) saveCompanyToDb(runId, errorResult);
    sseEnd({ type: 'result', data: errorResult });
  }
});


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Website Track endpoint - supplemental research for thin-coverage companies
// already found in Citeline. Skips primary Citeline query and runs the
// secondary WEBSITE track with the provided URL.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/api/screen/website-track', async (req, res) => {
  const { companyName, websiteUrl } = req.body;
  if (!companyName) return res.status(400).json({ error: 'Missing companyName' });
  if (!websiteUrl)  return res.status(400).json({ error: 'Missing websiteUrl - thin-coverage company must have a Citeline website URL' });

  const apiKey = process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured.' });

  // SSE — keeps connection alive through deployment proxy timeouts
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const _ka = setInterval(() => res.write('data: {"type":"keepalive"}\n\n'), 5000);
  const sseEnd = (data) => { clearInterval(_ka); res.write(`data: ${JSON.stringify(data)}\n\n`); res.end(); };

  console.log(`\n${'â”€'.repeat(60)}\n[${companyName}] Website Track (supplemental): ${websiteUrl}\n${'â”€'.repeat(60)}`);

  try {
    const client = new Anthropic({ apiKey, maxRetries: 5 });
    const result = await _screeningLogStore.run(
      (text) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'log', text })}\n\n`); },
      () => screenWithClaude(companyName, client, websiteUrl, { skipCiteline: true })
    );
    applyAutoFlags(result);
    logScreeningBreakdown(result);
    console.log(`    [${companyName}] [website-track FINAL] ${result.status}`);
    result.screenerLog = buildScreenerLog(result);
    sseEnd({ type: 'result', data: result });
  } catch (err) {
    console.error(`  [${companyName}] âœ— website-track: ${err.message}`);
    sseEnd({ type: 'result', data: { error: err.message } });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Auto-flag endpoint - "Flag High Priority Assets" button, run on-demand
// against already-screened companies, not part of the main /api/screen pass.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post('/api/autoflag', async (req, res) => {
  const { company } = req.body;
  if (!company) return res.status(400).json({ error: 'Missing company' });

  const apiKey = process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured. Enter your key in the screener settings.' });

  console.log(`\n[autoflag] ${company.name}`);

  try {
    const client = new Anthropic({ apiKey, maxRetries: 5 });
    const STRATEGIC_IDS = ['masked-tce-4-1bb', 'adc-novel-payload', 'checkpoint-io-alt'];

    for (const asset of company.assets || []) {
      if (asset.overallStatus === 'excluded') continue;

      const flags = new Set(asset.flags || []);

      const ctgov = await lookupClinicalTrialsForAsset(company.name, asset.name);

      // Indication synergy: strictly the structured indication field only.
      if (matchesIndicationSynergy(asset.indication || '')) flags.add('indication-synergy');
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
    console.error(`  [autoflag] âœ— ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Company repository - deduplicated view across all runs
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Excel export endpoint - downloads asset-level data for a run
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Utility
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Start
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.listen(PORT, () => {
  console.log(`\nâœ“ BeOne Screener running â†' http://localhost:${PORT}`);
  console.log(`  Open that URL in your browser (not the file directly)\n`);
  loadCitelineSpreadsheet();
  loadExclusionsSpreadsheet();
});
