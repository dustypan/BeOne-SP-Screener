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
// Citeline primary track tools — Steps 1+2 come from SQL; Steps 4+5 use OneBD
// ─────────────────────────────────────────────────────────────

const CITELINE_TOOLS = [
  {
    name: 'fetch_webpage',
    description: 'Fetch and read the text content of a specific webpage URL — use for the company pipeline/about page when thin-coverage enrichment is needed.',
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
      'Call this ONCE before onebd_get_deals — it returns the company_id needed for deal lookup.',
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
    for (const key of ['layer1', 'layer2', 'layer3', 'layer4', 'layer5']) {
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

YOUR TASK: Re-fetch each URL above (use fetch_webpage) and identify ONLY what has changed since ${lastScreenDate}. Do not run any web_search. Do not fetch any URL not listed above. Do not re-evaluate layers already assessed — just look for new pipeline entries, removed assets, or new Layer 4/5 disclosures.

BUDGET: up to ${Math.min(storedUrls.length + 1, 4)} fetch_webpage calls. Stop as soon as you have enough.

Return ONLY this JSON — no other text:
{
  "newAssets": [],
  "removedAssets": [],
  "layerChanges": {
    "layer4": null,
    "layer5": null
  },
  "deltaNotes": "Plain-English summary of changes since ${lastScreenDate}. Write 'No material changes found' if nothing changed.",
  "scanDate": "${new Date().toISOString().slice(0, 10)}"
}

For newAssets, use the same schema as a full screening asset object (name, modality, targets, indication, phase, layer1-5 as inconclusive since not fully evaluated, overallStatus: "inconclusive", isPlatform: false, notes, flags: []).
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
    lc.layer4 ? `Layer 4 update: ${lc.layer4.update}${lc.layer4.source ? ' — ' + lc.layer4.source : ''}` : null,
    lc.layer5 ? `Layer 5 update: ${lc.layer5.update}${lc.layer5.source ? ' — ' + lc.layer5.source : ''}` : null,
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

PARTIAL CONTRIBUTOR EDGE CASE — screen out at Layer 2 any asset where the screened company does NOT manufacture the biologic drug substance (cell line / protein expression). This applies when:
- The company provides only the small molecule component of a biologic (e.g. ADC payload/warhead provider — they supply the toxin, not the antibody)
- The company provides only AI/computational drug discovery support for a biologic partnership (no wet lab, no cell line, no protein production)
- The company provides only fill & finish / formulation / drug product (no drug substance / upstream bioreactor work)
- The company is a clinical CRO, regulatory consultant, or platform licensor only
Set layer2: fail, reason: "Company role is [X] only — does not manufacture biologic drug substance (cell line/protein expression)". Do NOT screen out co-developers who share manufacturing responsibilities or who have a manufacturing arm alongside their contribution.

ENUMERATE ALL ASSETS — list every individually named asset from the pipeline page as a separate asset object regardless of phase. Discovery, Preclinical, Lead Opt, IND-Enabling, Phase 1/2/3, Approved — all are included. If the table has 10 rows, output 10 objects. Do NOT filter by phase, do NOT collapse the pipeline into one representative asset, do NOT summarize as "several mAbs". Extract all rows from what you already fetched — do not make extra tool calls per asset.

LAYER 3 — Competitive Overlap (evaluate HERE, immediately after Layer 2, BEFORE Layers 4 and 5)
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
  Match → layer3: { status: "fail", reason: "Competitive overlap: matches BeOne [name] ([modality]/[targets])" }, overallStatus: "excluded". Do NOT evaluate Layers 4+5 for this asset.
  No match → layer3: { status: "pass", reason: "No competitive overlap with BeOne pipeline" }. Proceed to Layer 4.
  Platform-level record (no target) → layer3: { status: "inconclusive", reason: "No target — not applicable" }. Proceed to Layer 4.

LAYER 4 — Rights Retained
Pass: company retains global or US rights for its qualifying assets
Fail: global or US rights out-licensed via license deal, asset sale, or option
Note: ex-US licensing only = still PASSES. A headline out-licensing deal for one asset does not mean all assets are out-licensed — if the company has other unlicensed qualifying assets, those still pass.

LAYER 5 — US Manufacturing Screen
Pass: no US drug substance manufacturing solution found for this asset
Fail: has an active, asset-specific US CDMO relationship for drug substance manufacturing, OR owns a US biologics facility used for drug substance production → excludedAt: "layer5"

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
Default if ambiguous, budget exhausted, or time runs out: PASS for that asset, add "check-mfg-partner" to company-level flags[]. Never return inconclusive on Layer 5 alone — the company still qualifies. Only exclude if clearly disclosed.

RULES:
- Return ONLY valid JSON at the end — no text before or after it
- Every response you send must end with either a tool call or the final JSON object — never
  both-less. If you write text describing what you found ("the website loaded, I can see X..."),
  that description is not a complete response by itself — immediately continue in the SAME
  response with your next tool call or the final JSON. Stopping after only a description, with
  no tool call and no JSON, is invalid and wastes a full extra turn correcting it.
- Assess Layer 3 (competitive overlap) immediately after Layer 2 — BEFORE Layers 4+5. Assets that fail Layer 3 skip Layers 4+5 entirely.
- ENUMERATE ASSETS: list every individually named asset as its own object in "assets" regardless of phase (Discovery/Preclinical/Lead Opt/IND-Enabling/clinical/approved — all count). Never collapse, never filter by phase, never write "several mAbs". Read the pipeline page once and extract all rows; do not make extra tool calls per individual asset.
- If after all searching you cannot find reliable information: status = "inconclusive", inconclusiveReason = "Website Input Needed"
- Be specific in reasons — cite what you found (e.g. "Lonza US manufacturing agreement announced March 2024 per press release")
- Whenever a specific page/filing/press release is the actual basis for a layer's pass/fail
  (especially Layer 4 rights and Layer 5 manufacturing — the layers that actually drive
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
  "excludedAt": null | "pre-filter" | "layer1" | "layer2" | "layer4" | "layer5",
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
      "usedFor": "which layer(s) or criteria this URL informed (e.g. 'Layer 1–2 modality/indication', 'Layer 5 manufacturing screen')",
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
or pre-filter step the source supported (e.g. "Layer 1–2 oncology/modality", "Layer 5 manufacturing",
"Pre-filter: oncology confirmation", "Identification / website search").
This field is REQUIRED — populate it for every company, even if the only source is the company website.

FLAGS — Claude sets these automatically:
  "purple-flag" — set when externalSourcing is true (data from web_search/press/third-party
    rather than the company's own site).
  "check-mfg-partner" — set when Layer 5 manufacturing is ambiguous, budget is exhausted
    without a clear answer, or the screen could not confirm/deny a US manufacturing partner
    for at least one qualifying asset. Company still screens IN when this flag is set.
indication-synergy, phase-synergy, checkpoint-io-alt, and masked-tce-4-1bb are auto-computed
server-side from asset data after screening — do not set these yourself.
adc-novel-payload still requires manual autoflag (payload detail not in Citeline data).
`.trim();

// ─────────────────────────────────────────────────────────────
// Base prompt — Steps 3+4+5 logic shared by all tracks.
// CITELINE_PRIMARY_PROMPT slices from the Step 3 marker onward and prepends its own header.
// ─────────────────────────────────────────────────────────────

const PHARMCUBE_PRIMARY_PROMPT = `
You are a pharmaceutical business development analyst screening companies for BeOne Medicines' Hopewell, NJ biologics manufacturing partnership program.

CONTEXT: PRIMARY TRACK — Pharmcube MCP (Steps 1–3) + OneBD Cortellis deals (Steps 4–5). The company has already passed the Big Pharma pre-filter. Steps 1+2 (oncology biologics discovery) and Step 3 (competitive overlap) use Pharmcube drugBaseLiteCN. Steps 4 (licensing/rights) and 5 (manufacturing) use OneBD Cortellis deal data via onebd_resolve_company + onebd_get_deals.

OBJECTIVE: Screen through Steps 1+2 → 3 → 4 → 5 in order. If the company is NOT FOUND in Pharmcube, return inconclusive immediately — do NOT search the web. The secondary research track will handle it.

═══ STEPS 1 + 2 — Oncology Biologic Identification (call drugBaseLiteCN FIRST) ═══

Call drugBaseLiteCN with:
  companyName = the given company name
  pageNo = 0, pageSize = 20
  drugType2 = ["生物"]        ← biologics only (avoids charges for small molecules)
  diseaseArea = "肿瘤领域"    ← oncology only (avoids charges for non-oncology assets)
  status = ["Active","Unknown"] ← exclude Inactive (abandoned) assets upfront

If the response contains a totalCount > 20, make EXACTLY ONE additional call:
  pageNo = 1, pageSize = 10  ← gets records 21–30 (max 10 more × 15 pts = 150 pts)
  (same filters: drugType2, diseaseArea, status)
Do NOT paginate beyond page 1 regardless of totalCount. Cap = 30 records total.

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
      If still zero results after the one retry → DISAMBIGUATION STEP before routing to secondary:
        Make ONE more call: drugBaseLiteCN with companyName only (NO drugType2, NO diseaseArea filters), pageSize: 1.
        — If this returns ≥1 result → company EXISTS in Pharmcube, just has no oncology biologics
            → return: status="excluded", excludedAt="step1-2", excludedReason="No qualifying oncology biologic assets in Pharmcube (company exists but pipeline is non-oncology or non-biologic)"
        — If this also returns 0 → company genuinely not in Pharmcube
            → return: status="inconclusive", inconclusiveReason="Company not found in Pharmcube — route to secondary track"
      Total cap: 3 drugBaseLiteCN calls (2 filtered + 1 unfiltered existence check). Do NOT try web searches.
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
  — Match → set layer3: { status: "fail", reason: "Competitive overlap: matches BeOne [name] ([modality]/[targets])" }
    set overallStatus: "excluded". Do NOT run Steps 4+5 for this asset.
  — No match → asset continues to Step 4
  — Platform-level record (no target) → Step 3 not applicable, asset continues to Step 4

If ALL qualifying assets are eliminated here → excludedAt="step3", status="excluded"
If ≥1 asset passes → proceed to Step 4 with passing assets only

═══ STEPS 4 + 5 — Licensing & Manufacturing Check (OneBD Cortellis deals) ═══

MANDATORY CALL SEQUENCE:
1. onebd_resolve_company(companyName) → company_id
   — If not found: no Cortellis history. All passing assets pass both Steps 4 and 5. Output deals:[] and go straight to JSON.
2. ★ YOU MUST call onebd_get_deals(company_id) immediately after resolve returns found:true.
   ★ NEVER produce JSON output before calling onebd_get_deals. This call is not optional.
   — Returns all company-level Cortellis deals with title, date, summary, assets[], territories[], values[], parties[].

DEALS ARRAY — populate deals[] in the JSON output with EVERY deal related to cancer biologics:
  Include: licensing deals, manufacturing/CDMO agreements, collaborations, options, co-development, acquisitions
    that involve oncology assets or biologic programs.
  Exclude: purely financial deals (debt, equity raises with no asset component), non-oncology deals,
    non-biologic small molecule deals.
  Set scope to:
    "specific-asset"  — deal names one or more individual assets/compounds by name → set assetNames[]
    "modality-group"  — deal covers a program type (e.g. "bsAb program", "ADC franchise") → set modalityGroup
    "all"             — deal covers entire pipeline or all biologics
    "company-level"   — collaboration, equity, platform deal with no specific asset or modality scope
  ALL cancer biologic deals go into deals[] regardless of whether they cause asset exclusion.

ASSET MATCHING — only needed for deals that scope to a specific asset or modality group:

  Step A — for deals where scope = "modality-group" OR deal.assets[] is EMPTY:
  Check the title and summary for a modality or program-category description using the keyword
  mapping below. Apply the deal to ALL qualifying assets of the matching modality type.
  No tool call needed. For Step 5 manufacturing deals: set layer5: fail for every asset of that
  modality type (e.g. "bsAb mfg partner" → layer5: fail on ALL bsAb assets in the pipeline).

  Step B — for deals where scope = "specific-asset" and deal.assets[] lists named compounds:
  Match using the asset's drugId, primary name, AND altNames (synonym list from Citeline).
  For each name in deal.assets[]:
    1. Check against asset.name and every entry in asset.altNames (brand names, INNs, research codes).
       If ANY altName matches the deal asset name (case-insensitive) → confirmed match → apply deal.
    2. Only if altName matching is genuinely ambiguous (multiple assets could match, or the deal uses
       an unfamiliar code name not in altNames): call onebd_resolve_asset(dealAssetName) and
       onebd_resolve_asset(assetPrimaryName) to confirm by ID.
    3. If IDs match → confirmed same molecule → apply deal.
    4. If IDs differ → different assets → deal does NOT apply.
  Prefer altName matching over tool calls — it covers most cases and saves iterations.

  Keyword → scope mapping:

  "fusion program(s)" / "fusion protein(s)" / "bi- and multi-functional fusion" / "Fc-fusion" /
  "multi-functional fusion" / "ADAPTIR" / "DVD-Ig" / "fusion bispecific":
    → Applies to: Fc-fusion assets ONLY + bispecific/trispecific assets that use a fusion-protein
      format (Fc-fusion scaffold, heterodimeric fusion, ADAPTIR-type, etc.).
    → Does NOT apply to: standard bispecific IgG formats (CrossMab, DuoBody, BiTE, DART,
      knobs-into-holes IgG) that are not fusion proteins.
    → WHEN IN DOUBT about whether a bsAb/tsAb uses a fusion format: APPLY the deal to it.
      Err toward including more assets in the deal scope rather than excluding them — the user
      can review; a missed disqualifying deal is worse than a false flag.

  "bispecific program(s)" / "bispecific antibody program(s)" (without "fusion"):
    → Applies to all bsAb assets. Does NOT automatically cover Fc-fusion or tsAb unless specified.

  "trispecific program(s)" / "multispecific program(s)" (without "fusion"):
    → Applies to all tsAb and bsAb assets.

  "bi- and trispecific" / "bi- and multi-specific" (without "fusion"):
    → Applies to all bsAb and tsAb assets, NOT to pure Fc-fusion assets.

  CRITICAL PARSING RULE — "bispecific ADCs" / "trispecific ADCs" / "bi- and trispecific ADCs" /
  "bispecific and trispecific ADCs" / "[format] ADCs":
    → The format qualifier (bi-, tri-, multispecific) MODIFIES ADC — it means ADCs of that format.
    → Applies ONLY to ADC assets that are bispecific or trispecific. Does NOT apply to plain bsAbs
       or tsAbs that carry no ADC payload.
    → Example: "bsAb and trispecific ADCs" = bispecific ADCs + trispecific ADCs. A plain bsAb
       without ADC payload is NOT covered. A bsAb-ADC IS covered.

  "ADC program(s)" / "antibody-drug conjugate portfolio" (without format qualifier):
    → Applies to all ADC assets regardless of format (mono, bi, tri).

  "antibody program(s)" / "mAb portfolio" / "monoclonal antibody program(s)":
    → Applies to all mAb assets.

  "TCE program(s)" / "T-cell engager program(s)":
    → Applies to all TCE assets.

  "entire pipeline" / "all programs" / "all assets" / "all biologics":
    → Applies to every qualifying asset.

  If the title/summary contains NO modality or program-category language → true company-level deal
  (equity, platform technology, general collaboration). Record as "company-level deal (no specific
  asset): [title]" in researchNotes and do NOT apply to any individual asset.

ASSESS STEPS 4 AND 5 SIMULTANEOUSLY for each qualifying asset using the same deal batch:

Step 4 — Licensing/Rights (per asset still passing after Step 3):
  Use ONLY these explicit rights-transfer keywords: out-licens, exclusive license, grant license,
  license rights, sublicens, royalt, assign rights, transfer rights, commercialization rights.
  Also check the deal's transaction_type and agreement_type fields directly — these are structured
  Cortellis fields and are more reliable than keyword matching on title/summary.
  Do NOT trigger on: collaboration, partnership, co-develop, co-promotion — these typically mean both
  parties retain rights and are not exclusion events.

  — transaction_type contains "Option" OR "License Option" OR agreement_type contains "Option" →
    layer3: fail, excluded regardless of territory.
    Note in asset notes: "License option granted — asset encumbered. Partner: [name], Date: [date]"
  — Deal with explicit rights-transfer language, territory = Global or US → layer3: fail, excluded (note partner + date)
  — Deal with explicit rights-transfer language, territory = ex-US only (China, APAC, Europe explicitly stated) → layer3: pass
  — Deal with explicit rights-transfer language, territory unspecified or empty → layer3: fail, excluded
    Note in asset notes: "Out-licensed — no territory disclosed, assumed global. Partner: [name], Date: [date]"
  — Collaboration / co-development with no rights-transfer language → layer3: pass (note deal in researchNotes)
  — No matching rights-transfer deal → layer3: pass

Step 5 — US Manufacturing (per asset still passing Step 4):
  Keywords: manufactur, cdmo, cmo, contract manufactur, supply agreement, tech transfer, bioreactor,
            lonza, wuxi biolog, samsung biolog, thermo fisher, catalent, fujifilm, agc biolog, rentschler, patheon

  When territories[] is empty, infer US presence from the CDMO entity name in companies[]:
    Look at the name of the manufacturing party (the CDMO / non-screened-company party).
    Entity names carry geographic identifiers — read them literally:

    Entity name implies a SPECIFIC NON-US location → no US capacity from this entity → layer4: PASS:
      "(Shanghai)", "(Suzhou)", "(Wuxi)", "(Beijing)", any "(China)" city, "Co Ltd" Chinese suffix,
      "(Korea)", "(Seoul)", "(Ireland)" alone without US partner, "(Germany)", "(Switzerland)" alone,
      "(Japan)", "(Singapore)", "(India)"
      Example: "WuXi Biologics (Shanghai) Co Ltd" → Shanghai entity → non-US → PASS

    Entity name implies a GLOBAL CDMO or US presence → has or may have US drug-substance capacity → layer4: FAIL:
      No geographic qualifier or qualifier includes "Global", "Inc" (US corporate suffix), "(USA)",
      "(US)", "North America", "United States", or is a well-known global CDMO with US sites:
      Lonza, WuXi Biologics (global CDMO regardless of which subsidiary entity), Fujifilm Diosynth,
      AGC Biologics, Thermo Fisher, Catalent, Patheon, Boehringer Ingelheim Biopharmaceuticals,
      Samsung Biologics
      Example: "Lonza AG" → global CDMO with US sites → FAIL

    Truly ambiguous (cannot tell from entity name) → layer4: PASS + add "check-mfg-partner" to flags[]

  Per asset:
  — Manufacturing deal, territory explicitly includes Global or US → layer4: fail, excluded (note CDMO entity + date)
  — Manufacturing deal, territory explicitly non-US (China, Asia, Europe) → layer4: pass
  — Manufacturing deal, territory unspecified, CDMO entity = specific non-US location → layer4: pass
  — Manufacturing deal, territory unspecified, CDMO entity = global or US-capable → layer4: fail, excluded (note CDMO entity + date)
  — Manufacturing deal, territory unspecified, CDMO entity truly ambiguous → layer4: pass + add "check-mfg-partner" to flags[]
  — No matching manufacturing deal → layer4: pass (manufacturing gap confirmed)
  Always note the CDMO entity name, deal date, and outcome in the asset's notes field.

DEAL NOTES — MANDATORY for every asset that reaches Steps 4+5:
  Populate each asset's "notes" field referencing any deals[] entries that apply to that asset
  (matched via specific-asset ID confirmation OR modality-group keyword OR scope=all).
  Format each matched deal as one line:
    "[date] [title] | [licensing/manufacturing/collaboration] | Territory: [territory or 'unspecified'] | [outcome reason]"
  Examples:
    "2025-07-01 Henlius to develop and commercialize HCB-101 | licensing | Territory: ex-US (China, SE Asia, MENA) | US rights retained — pass"
    "2026-01-26 WuXi Biologics (Shanghai) — end-to-end manufacturing for fusion programs | manufacturing | Territory: unspecified (WuXi = global CDMO with US capacity) | screened out"
    "2024-03-15 Lonza biologics supply agreement | manufacturing | Territory: unspecified (Lonza = global CDMO with US capacity) | screened out"
  If no deals[] entries match this asset, write "No Cortellis deals matched to this asset".
  Do NOT leave notes blank for any asset that went through Steps 4+5.

If ALL remaining assets excluded at Step 4 → excludedAt="step4"
If ALL remaining assets excluded at Step 5 → excludedAt="step5"
Never return inconclusive due to Step 5 alone — if any asset still passes, company qualifies.

SOURCING: Add "onebd:cortellis-deals" to sources[] with usedFor "Steps 4+5 — licensing and manufacturing deals".

═══ RULES ═══

  ★ GOLDEN RULE — ASSET-LEVEL PASS: If even ONE asset passes all steps, the company is
    status="qualifying". A company is only excluded if ALL qualifying assets are eliminated.
    Example: 14 assets screened out + 1 asset passes Step 5 → company QUALIFIES on that asset.
    Never set status="excluded" while any single asset still has overallStatus="qualifying".

  — Always call drugBaseLiteCN BEFORE any OneBD tool
  — drugBaseLiteCN: max 2 calls total (exact name + one suffix-stripped retry if zero results)
  — If still not found after retry: return inconclusive immediately
  — Run Step 3 (competitive overlap) BEFORE calling OneBD — it's free and eliminates assets early
  — onebd_resolve_company: call ONCE per company
  — onebd_get_deals: MANDATORY immediately after resolve returns found:true — call ONCE, never skip
  — Steps 4 and 5 both use the SAME deal batch from onebd_get_deals — no additional OneBD calls
  — Match deals to Pharmcube assets by name (fuzzy) — no asset-level OneBD resolution needed
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
      "url": "pharmcube:drugBaseLiteCN",
      "label": "Pharmcube drugBaseLiteCN",
      "usedFor": "Steps 1+2 — oncology biologic identification",
      "type": "pharmcube"
    }
  ]
}

Notes on the asset schema:
  layer3 = Step 3 competitive overlap. Fill for all assets (pass or fail). For platform-level records with no target, set layer3.status = "inconclusive", reason = "No target — not applicable".
  layer4 = Step 4 rights check. Only fill for assets that passed Step 3 (not competed out). For assets eliminated at Step 3, leave layer4/layer5 as null or omit.
  layer5 = Step 5 manufacturing check. Only fill for assets that passed Steps 3+4.
  For Pharmcube tool calls in sources[], use "pharmcube:drugBaseLiteCN" as url placeholder.
  For OneBD calls in sources[], use "onebd:cortellis-deals" as url placeholder.
`.trim();

// Derived from PHARMCUBE_PRIMARY_PROMPT — identical Steps 3+4+5 logic, header replaced.
// Steps 1+2 data is pre-loaded from Citeline SQL and passed in the user message.
const CITELINE_PRIMARY_PROMPT = (() => {
  const step3Marker = '═══ STEP 3 — COMPETITIVE OVERLAP';
  const idx = PHARMCUBE_PRIMARY_PROMPT.indexOf(step3Marker);
  const body = idx !== -1 ? PHARMCUBE_PRIMARY_PROMPT.slice(idx) : PHARMCUBE_PRIMARY_PROMPT;
  return (
    `You are a pharmaceutical business development analyst screening companies for BeOne Medicines' Hopewell, NJ biologics manufacturing partnership program.

CONTEXT: PRIMARY TRACK — Citeline database (Steps 1+2 pre-loaded) + OneBD Cortellis deals (Steps 4+5). The company has already passed the Big Pharma pre-filter. Steps 1+2 (oncology biologic identification) are DONE — the qualifying assets are already in the user message.

OBJECTIVE: Use the Citeline asset list provided. Do NOT call any pipeline lookup tool. Start immediately at STEP 3 (competitive overlap), then STEPS 4+5 via onebd_resolve_company and onebd_get_deals.

${body}`
  )
    .replace('"sourceTrack": "pharmcube"', '"sourceTrack": "citeline"')
    .replace(
      'For Pharmcube tool calls in sources[], use "pharmcube:drugBaseLiteCN" as url placeholder.',
      'Steps 1+2 source: Citeline SQL (use "citeline:sql" as url placeholder in sources[]).',
    )
    .trim();
})();

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
// Pipeline page discovery — used for thin-coverage enrichment.
// Fetches the homepage, scores same-domain links by pipeline keywords,
// then fetches the best-matching subpage. Returns { url, content } or null.
// ─────────────────────────────────────────────────────────────

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
    // Homepage fetch — 6s budget leaves room for subpage fetch within 15s total
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

    // Subpage fetch — 8s budget (6 + 8 = 14s max, comfortably under 15s wall)
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
// OneBD REST API helper
// Base URL: https://onebd.pchomelab.com/api/v1
// Auth:     X-API-Key header
// ─────────────────────────────────────────────────────────────

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
    throw new Error(`OneBD ${method} ${path} → ${status || 'network'}: ${detail}`);
  }
}

// Thin wrappers — each returns the parsed JSON response object.

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

// Suffixes that carry no identity signal — strip these to get the core name
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

  const noSpaces = words.join('');              // "Hanchor Bio" → "HanchorBio"
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
      console.log(`    [onebd_resolve_company] "${companyName}" → "${match.name}" (id=${match.id})${usedQuery}`);
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

// ─────────────────────────────────────────────────────────────
// Citeline SQL — Azure Synapse connection + Steps 1+2 query
// ─────────────────────────────────────────────────────────────

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
    'Immune checkpoint inhibitor','Immuno-oncology therapy','Antineoplastic','Antitumour','Cytotoxic'
  )
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

// ─────────────────────────────────────────────────────────────
// Citeline spreadsheet loader — file-based primary when SQL auth
// is unavailable (BeiGene Conditional Access policy blocks direct
// connection from unmanaged devices). Falls back to SQL if no file.
// ─────────────────────────────────────────────────────────────

const COMPANY_SUFFIXES = /[\s\-]*(therapeutics?|biosciences?|biotechnolog(?:y|ies)|biotech|biopharma|pharmaceuticals?|pharma|sciences?|biotherapeutics?|oncolog(?:y|ies)|medicines?|health(?:care)?|biologics?|bio|inc\.?|ltd\.?|llc\.?|co\.?|corp\.?|corporation|group|holdings?|labs?|laborator(?:y|ies)|partners?)\s*$/i;

function stemCompany(name) {
  // Split CamelCase so "HanchorBio" → "Hanchor Bio" → stem "hanchor"
  let s = String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  // Strip suffixes up to 3 passes ("Bio Sciences Inc" → "Bio Sciences" → "Bio" → "")
  for (let i = 0; i < 3; i++) {
    const prev = s;
    s = s.replace(COMPANY_SUFFIXES, '').trim();
    if (s === prev) break;
  }
  return s.replace(/[^a-z0-9]/g, ''); // remove spaces, hyphens, punctuation
}

let citelineIndex = null; // map: stemmedCompanyName → row[]

function loadCitelineSpreadsheet() {
  const candidates = [
    path.join(__dirname, 'citeline-data', 'Citeline_Screener_Data.xlsx'),
    path.join(__dirname, 'Citeline_Screener_Data.xlsx'),
    'C:/Users/arjun.shah/OneDrive - BeiGene/Citeline_Screener_Data.xlsx',
  ];
  const filePath = candidates.find(p => fs.existsSync(p));
  if (!filePath) {
    console.log('[citeline] No spreadsheet found — will attempt SQL connection');
    return;
  }
  console.log(`[citeline] Loading spreadsheet: ${path.basename(filePath)}`);
  const XLSX = require('xlsx');
  const wb   = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames.includes('Sheet2') ? 'Sheet2' : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);

  citelineIndex = {};
  for (const row of rows) {
    const stem = stemCompany(row.companyName);
    if (!stem || stem.length < 3) continue;
    if (!citelineIndex[stem]) citelineIndex[stem] = [];
    citelineIndex[stem].push(row);
  }
  console.log(`[citeline] Spreadsheet ready: ${rows.length} rows, ${Object.keys(citelineIndex).length} company stems`);
}

const EXCLUDED_STATUSES = new Set(['Discontinued', 'Withdrawn', 'Suspended', 'Ceased']);

function citelineGetAssetsLocal(companyName) {
  const needle = stemCompany(companyName);

  if (!needle || needle.length < 3) {
    return { rows: [], coverageStatus: 'inconclusive-not-found', companyWebsite: null, pipelineUrl: null };
  }

  // Stem match: "hanchor bio" = "hanchorbio" = "hanchor therapeutics" → all stem to "hanchor"
  const matchedRows = [];
  for (const [stem, rows] of Object.entries(citelineIndex)) {
    if (stem === needle ||
        (needle.length >= 4 && stem.length >= 4 && (stem.includes(needle) || needle.includes(stem)))) {
      matchedRows.push(...rows);
    }
  }

  if (matchedRows.length === 0) {
    return { rows: [], coverageStatus: 'inconclusive-not-found', companyWebsite: null, pipelineUrl: null };
  }

  // Company-level URL fields — same across all rows for this company
  const companyWebsite = matchedRows[0].companyWebsite || null;
  const pipelineUrl    = matchedRows.find(r => r.pipelineUrl)?.pipelineUrl || null;

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

  // Deduplicate by drugId — keep best modality per drug using MODALITY_PRIORITY
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
    citelineModality: r.drugTypeCaption,
    citelinePhase:    r.globalStatus,
    status:           r.globalStatus,
    companyWebsite:   null,
    targets:          r.allMechanisms  || 'Undisclosed',
    indications:      r.allDiseases    || '',
    allLicensees:     r.allLicensees   || '',
    allLicensers:     r.allLicensers   || '',
    allTerritories:   r.allTerritories || '',
    allDealTypes:     r.allDealTypes   || '',
    allManufacturers: r.allManufacturers || '',
    allPayloads:      r.allPayloads    || '',
    allTargets:       r.allTargets     || '',
  }));

  return { rows, coverageStatus: 'qualifying', companyWebsite, pipelineUrl };
}

async function citelineGetAssets(companyName) {
  if (citelineIndex) return citelineGetAssetsLocal(companyName);
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

  // 0 qualifying assets — check what the company actually has in Citeline
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

// Indication Synergy keyword list — hematology, lung, GI (colorectal/stomach/gallbladder/pancreas),
// women's cancers (breast/gyn). Prostate is explicitly NOT included.
const INDICATION_SYNERGY_TERMS = [
  // Hematology
  'CLL', 'B-CLL', 'SLL', 'WM', 'Waldenstrom', 'Waldenström', 'lymphoplasmacytic lymphoma',
  'FL', 'Follicular Lymphoma', 'MCL', 'Mantle Cell Lymphoma', 'MZL', 'Marginal Zone Lymphoma',
  'MALT lymphoma', 'NHL', 'Non-Hodgkin Lymphoma', 'MM', 'Multiple Myeloma', 'plasma cell myeloma',
  'MDS', 'Myelodysplastic Syndrome', 'myelodysplasia', 'AML', 'Acute Myeloid Leukemia',
  'acute myelogenous leukemia', 'B-cell malignancies',
  // Lung
  'SCLC', 'Small Cell Lung Cancer', 'small cell lung carcinoma', 'NSCLC',
  'Non-Small Cell Lung Cancer', 'lung adenocarcinoma', 'squamous cell lung carcinoma',
  // GI — colorectal, stomach, gallbladder, pancreas, esophagus, biliary
  'CRC', 'colorectal cancer', 'colorectal carcinoma', 'colon cancer', 'rectal cancer',
  'ESCC', 'Esophageal Squamous Cell Carcinoma', 'esophageal cancer', 'esophageal adenocarcinoma',
  'GC', 'Gastric Cancer', 'stomach cancer', 'stomach carcinoma',
  'GEJC', 'Gastroesophageal Junction Cancer', 'GEJ cancer', 'GEA', 'Gastroesophageal Adenocarcinoma',
  'HCC', 'Hepatocellular Carcinoma', 'liver cell carcinoma',
  'NPC', 'Nasopharyngeal Carcinoma', 'nasopharyngeal cancer',
  'BTC', 'Biliary Tract Cancer', 'cholangiocarcinoma', 'bile duct cancer', 'gallbladder cancer',
  'pancreatic cancer', 'pancreatic ductal adenocarcinoma', 'PDAC', 'pancreatic carcinoma',
  'MSI-H', 'Microsatellite Instability-High', 'MSI-high', 'dMMR', 'Deficient Mismatch Repair', 'MMR-deficient',
  // Women's cancers
  'Breast cancer', 'breast carcinoma', 'HER2-positive breast cancer',
  'triple-negative breast cancer', 'TNBC', 'ovarian cancer', 'ovarian carcinoma',
  'cervical cancer', 'cervical carcinoma', 'endometrial cancer', 'endometrial carcinoma', 'uterine cancer',
];

// Prostate cancer is NOT a BeOne indication synergy focus — strip it before matching
// so MSI-H prostate or other broad terms don't accidentally trigger the flag.
const PROSTATE_RE = /prostate(\s+cancer|\s+carcinoma|\s+adenocarcinoma|\s+tumor)?/gi;

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchesIndicationSynergy(text) {
  if (!text) return false;
  const stripped = text.replace(PROSTATE_RE, '');
  return INDICATION_SYNERGY_TERMS.some(term => new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(stripped));
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

// Targets that qualify for checkpoint-IO-alt flag — non-PD-1/PD-L1 checkpoint receptors only.
// TCEs are excluded (they have their own masked-tce flag). PD-1/PD-L1 combos no longer qualify.
const CHECKPOINT_ALT_TARGETS = ['lag-3', 'lag3', 'tim-3', 'tim3', 'tigit', 'ctla-4', 'ctla4', 'vista', 'btla', 'cd96', 'nkg2a', 'ox40', 'cd134', '4-1bb', 'cd137', 'icos', 'cd278', 'gitr', 'cd357'];

// Compute flags directly from Steps 1+2 asset data (no web research needed).
// Called automatically after every screening run — no manual autoflag step required
// for indication-synergy, phase-synergy, checkpoint-io-alt, or masked-tce-4-1bb (4-1BB arm).
// adc-novel-payload and TCE masking moiety still need manual autoflag (payload detail not in Citeline data).
function computeFlagsFromAsset(asset) {
  if (!asset || asset.overallStatus === 'excluded') return [];
  const flags = new Set();
  const targets = (asset.targets || []).map(t => (t || '').toLowerCase());
  const modality = (asset.modality || '').toLowerCase();
  const phase = (asset.phase || '').toLowerCase();

  // Indication synergy — keyword match on indication field
  if (matchesIndicationSynergy(asset.indication || '')) flags.add('indication-synergy');

  // Phase synergy — lead optimization OR Phase 2→3 boundary only
  const leadOptTerms = ['lead opt', 'lead optimization', 'lead candidate', 'lead selection'];
  if (leadOptTerms.some(t => phase.includes(t))) flags.add('phase-synergy');
  if (phase.includes('2/3') || phase.includes('ii/iii') || phase.includes('2/iii') || phase.includes('ii/3')) flags.add('phase-synergy');

  // Strategic — checkpoint IO alt: non-PD-1/PD-L1 checkpoint target, non-TCE modality only.
  // TCEs are excluded (they belong to masked-tce). PD-1/PD-L1 combos no longer qualify.
  const isTCE = modality === 'tce' || modality.includes('t cell engager') || modality.includes('t-cell engager');
  const hasAltCheckpoint = targets.some(t => CHECKPOINT_ALT_TARGETS.some(c => t.includes(c)));
  if (hasAltCheckpoint && !isTCE) flags.add('checkpoint-io-alt');

  // Strategic — 4-1BB arm (TCE or bsAb/tsAb engaging 4-1BB/CD137)
  const has41BB = targets.some(t => t.includes('4-1bb') || t.includes('cd137'));
  if (has41BB) flags.add('masked-tce-4-1bb');

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
3. checkpoint-io-alt: targets a non-PD-1/PD-L1 checkpoint receptor (LAG-3, TIM-3, TIGIT, CTLA-4, VISTA, BTLA, CD96, NKG2A, OX40, 4-1BB, ICOS, GITR) AND is NOT a TCE modality. TCEs belong to masked-tce-4-1bb. PD-1/PD-L1 combinations do NOT qualify for this flag.

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
// Citeline primary track — SQL Steps 1+2, then Claude for Steps 3+4+5
// Returns a full result object, or null if no qualifying assets found (fall through).
// ─────────────────────────────────────────────────────────────

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
    let line =
      `[${i + 1}] ${r.drug} (drugId: ${r.drugId})\n` +
      `  AltNames   : ${r.altNames || 'None'}\n` +
      `  Modality   : ${modality} (Citeline: ${r.citelineModality})\n` +
      `  MOA/Targets: ${r.targets || 'Undisclosed'}\n` +
      `  Indications: ${r.indications || 'Not specified'}\n` +
      `  Phase      : ${phase}\n` +
      `  Status     : ${r.status}`;
    return line;
  }).join('\n\n');

  // Pre-fetch pipeline content for thin-coverage companies before calling Claude
  let pipelineFetch = null;
  if (thinCoverage) {
    if (pipelineUrl) {
      console.log(`    [${companyName}] [citeline] thin-coverage: fetching pipeline URL from spreadsheet: ${pipelineUrl}`);
      const content = await fetchWebpage(pipelineUrl);
      pipelineFetch = { url: pipelineUrl, content };
    } else if (companyWebsite) {
      // No dedicated pipeline URL — always crawl the company homepage to find
      // the best pipeline/science/drug subpage. Hard 15s wall clock limit.
      console.log(`    [${companyName}] [citeline] thin-coverage: crawling ${companyWebsite} for pipeline subpage (15s max)`);
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 15000));
      pipelineFetch = await Promise.race([findAndFetchPipelinePage(companyWebsite), timeout]);
      if (pipelineFetch) {
        console.log(`    [${companyName}] [citeline] thin-coverage: found pipeline page: ${pipelineFetch.url}`);
      } else {
        console.log(`    [${companyName}] [citeline] thin-coverage: no pipeline page found or timed out`);
      }
    }
  }

  const sparseReason = allNDR ? 'all assets show "No Development Reported"'
    : rows.length <= 2    ? `only ${rows.length} asset(s) found`
    : 'missing target data';

  const thinCoverageInstruction = !thinCoverage
    ? `Steps 1+2 are DONE. Start at Step 3 (competitive overlap) immediately, then Steps 4+5 via OneBD.`
    : pipelineFetch
    ? `THIN COVERAGE — PIPELINE PAGE PRE-FETCHED:\n` +
      `Citeline data is sparse (${sparseReason}). The pipeline page has been fetched below — treat it as a supplementary source alongside the Citeline assets above.\n` +
      `Merge both into a single asset list:\n` +
      `  • Assets in both sources: keep Citeline drugId/altNames/modality, enrich with website details\n` +
      `  • Assets only on website: include with modality/target/phase from the page\n` +
      `  • Exclude anything the website marks as ceased, discontinued, terminated, or withdrawn\n` +
      `Then run Steps 3–5 on the merged list.\n\n` +
      `PIPELINE PAGE (${pipelineFetch.url}):\n${'─'.repeat(60)}\n${pipelineFetch.content.slice(0, 8000)}\n${'─'.repeat(60)}`
    : `THIN COVERAGE — NO PIPELINE PAGE AVAILABLE:\n` +
      `Citeline data is sparse (${sparseReason}) and no website URL is available for enrichment.\n` +
      `Proceed with available Citeline assets and flag as thin-coverage.`;

  const messages = [{
    role: 'user',
    content:
      `Screen this company through the Citeline primary track: "${companyName}"\n\n` +
      `CITELINE DATABASE — Steps 1+2 complete (${rows.length} qualifying oncology biologic assets):\n\n` +
      `${assetLines}\n\n` +
      `Company website: ${companyWebsite || '(not in Citeline)'}\n\n` +
      thinCoverageInstruction,
  }];

  const MAX_ITERATIONS = 50;
  const fetchedUrls = [];
  const evidenceSnapshots = [];
  let oneBdCompanyId   = null;
  let oneBdDealsFetched = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8000,
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
            `Apply Steps 4+5 using these deals, then return the complete revised JSON.`,
        });
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
        result.sources.unshift({
          url: 'citeline:sql', label: 'Citeline database (Steps 1+2)',
          usedFor: 'Steps 1+2 — oncology biologic identification', type: 'citeline',
        });
      }

      return result;
    }

    if (response.stop_reason === 'pause_turn') {
      console.log(`    [${companyName}] [citeline] [pause_turn] iteration ${i + 1}`);
      continue;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses   = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`    [${companyName}] [citeline] [tool] ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 100)}`);
        let output;
        try {
          if (toolUse.name === 'onebd_resolve_company') {
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
            output = `Unknown tool: ${toolUse.name}`;
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

  console.log(`    [${companyName}] [citeline] hit MAX_ITERATIONS — returning inconclusive`);
  return {
    name: companyName, id: slugify(companyName), type: 'unknown', website: companyWebsite,
    status: 'inconclusive', sourceTrack: 'citeline', excludedAt: null, excludedReason: '',
    inconclusiveReason: 'Citeline primary track hit iteration limit',
    assets: [], beoneAnalyzed: false, beoneOutcome: null, flags: [],
    externalSourcing: false, externalSources: [], researchNotes: '',
    allSourcesConsulted: [...new Set(fetchedUrls)], evidenceSnapshots,
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
  const { skipCiteline = false } = opts;

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

  // ── PRIMARY TRACK: Citeline SQL (Steps 1+2) ───────────────────────────────────
  let autoEscalatedFromNDR = false;
  if (!skipCiteline && DefaultAzureCredential) {
    console.log(`    [${companyName}] [primary-track] Citeline SQL`);
    let citelineResult = null;
    try {
      citelineResult = await screenWithCitelinePrimary(companyName, client);
    } catch (e) {
      console.log(`    [${companyName}] [citeline] [error] ${e.message} — falling through to secondary track`);
    }
    if (citelineResult) {
      applyAutoFlags(citelineResult);
      logScreeningBreakdown(citelineResult);
      console.log(`    [${companyName}] [FINAL] ${citelineResult.status} (citeline track)${citelineResult.excludedAt ? ' — excluded at ' + citelineResult.excludedAt : ''}${citelineResult.inconclusiveReason ? ' — ' + citelineResult.inconclusiveReason : ''}`);
      return citelineResult;
    }
    console.log(`    [${companyName}] [citeline→secondary] No qualifying assets in Citeline — routing to secondary track`);
  }
  // ──────────────────────────────────────────────────────────────────────────────

  // ── SECONDARY TRACK: web research methodology ────────────────────────────────
  console.log(`    [${companyName}] [secondary-track] Web research methodology`);

  const messages = [
    {
      role: 'user',
      content: `Screen this company for a BeOne Medicines manufacturing partnership: "${companyName}"${websiteUrl ? `\n\nURL PROVIDED: The company's website is already known: ${websiteUrl}\nIn Step 0a, fetch this URL directly instead of running a web_search — skip the search entirely and go straight to fetch_webpage("${websiteUrl}").` : ''}${skipCiteline ? `\n\nCONTEXT — WEBSITE TRACK: This company was found in Citeline with thin coverage (≤2 qualifying assets or missing target data). Use the WEBSITE track methodology to get richer asset data and complete layers 3–5. The website URL is pre-supplied above — start there. You may find additional qualifying assets beyond what Citeline reported; include all active ones in assets[]. Exclude any assets explicitly marked as ceased, discontinued, terminated, withdrawn, or suspended.` : ''}

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
      result.name = companyName.replace(/BeiGene/gi, 'BeOne');
      result.id   = slugify(companyName);
      result.sourceTrack = result.sourceTrack || 'secondary';
      if (result.beoneAnalyzed == null) result.beoneAnalyzed = false;
      if (result.beoneOutcome  == null) result.beoneOutcome  = null;
      if (!Array.isArray(result.flags)) result.flags = [];
      if (!Array.isArray(result.deals)) result.deals = [];

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
  const track = result.sourceTrack === 'citeline' ? 'citeline (primary)' : 'secondary (web research)';
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
    const trackLabel = result.sourceTrack === 'citeline' ? 'Citeline SQL (primary)' : 'Web research (secondary)';
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
  const { company, runId, websiteUrl } = req.body;
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

    const result = await screenWithClaude(company, client, websiteUrl || null);
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
// Website Track endpoint — supplemental research for thin-coverage companies
// already found in Citeline. Skips primary Citeline query and runs the
// secondary WEBSITE track with the provided URL.
// ─────────────────────────────────────────────────────────────

app.post('/api/screen/website-track', async (req, res) => {
  const { companyName, websiteUrl } = req.body;
  if (!companyName) return res.status(400).json({ error: 'Missing companyName' });
  if (!websiteUrl)  return res.status(400).json({ error: 'Missing websiteUrl — thin-coverage company must have a Citeline website URL' });

  const apiKey = req.headers['x-api-key'] ||
    process.env.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API key not configured.' });

  console.log(`\n${'─'.repeat(60)}\n[${companyName}] Website Track (supplemental): ${websiteUrl}\n${'─'.repeat(60)}`);

  try {
    const client = new Anthropic({ apiKey, maxRetries: 5 });
    const result = await screenWithClaude(companyName, client, websiteUrl, { skipCiteline: true });
    applyAutoFlags(result);
    logScreeningBreakdown(result);
    console.log(`    [${companyName}] [website-track FINAL] ${result.status}`);
    result.screenerLog = buildScreenerLog(result);
    res.json(result);
  } catch (err) {
    console.error(`  [${companyName}] ✗ website-track: ${err.message}`);
    res.status(500).json({ error: err.message });
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
  loadCitelineSpreadsheet();
});
