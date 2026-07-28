# BeOne Superhighway Screener — CLAUDE.md

Pharmaceutical manufacturing partner screener for BeOne Medicines. Screens companies against a 5-layer methodology using Claude AI, Brave Search, Citeline data, and OneBD.

## Stack

- **Backend**: `server.js` — single ~3300-line Node.js/Express file. All API routes, prompts, screening logic, and DB code live here.
- **Frontend**: `index.html` + `js/app.js` (2200 lines), `js/screener.js`, `js/data.js`, `js/enums.js`, `css/`
- **Database**: Replit PostgreSQL (schema auto-bootstrapped on startup)
- **AI**: Anthropic Claude via `@anthropic-ai/sdk`
- **Search**: Brave Search API
- **Citeline**: Azure Synapse MSSQL (`ea-bgne-synapse-dsoe.sql.azuresynapse.net`) with local XLSX fallback (`citeline-data/Citeline_Screener_Data.xlsx`)

## Running

```bash
node server.js   # port 5000
```

## Environment variables

| Key | Notes |
|-----|-------|
| `ANTHROPIC_API_KEY` | Required |
| `BRAVE_API_KEY` | Required for web-search track |
| `CITELINE_USER` / `CITELINE_PASS` | Azure Synapse credentials; falls back to XLSX if absent |
| `ONEBD_API_KEY` | OneBD deal data |
| `SITE_PASSKEY` | Optional login gate |
| `SESSION_SECRET` | Cookie signing |

## Architecture

### Screening tracks

| Track | When used | Steps 1+2 source | Tools available |
|-------|-----------|-----------------|-----------------|
| **Citeline** (primary) | Company found in Citeline SQL | Pre-loaded DB data | `web_search`, `fetch_webpage`, OneBD |
| **Website Input** | Thin coverage / manual URL | Claude reads the URL | `fetch_webpage`, OneBD only — NO `web_search` |
| **Public (SEC/IR Filing)** | Public company | SEC 10-K or IR filings | `web_search`, `fetch_webpage`, OneBD |
| **Private (Website)** | Private company | Company pipeline page | `web_search`, `fetch_webpage`, OneBD |

### 5-layer screening

1. **Oncology** — at least one asset targets cancer
2. **Modality** — must be CHO/mammalian biologic (mAb, ADC, bsAb, TCE, Fc-fusion, etc.). Excludes cell therapy, mRNA, small molecules.
3. **Competitive overlap** — no direct conflict with BeOne's internal pipeline (PD-1, HER2, etc.)
4. **Rights** — US manufacturing/commercial rights must be available (unpartnered or mfg rights retained)
5. **Manufacturing** — no existing US biologics facility or US-capable CDMO relationship

Layers are evaluated per-asset and stored in `asset.layer1` … `asset.layer5` (each `{ status: 'pass'|'fail', reason }`) and `asset.overallStatus`.

### Prompt architecture

All prompts are constants near the top of `server.js`:

- `SYSTEM_PROMPT` — master analyst persona, tool usage, 5-layer methodology
- `BASE_STEPS_345_PROMPT` — shared competitive/rights/manufacturing logic (Steps 3-5)
- `CITELINE_SYSTEM_PROMPT` — derived from `BASE_STEPS_345_PROMPT`; Steps 1+2 are pre-filled by DB
- `WEBSITE_SEARCH_SYSTEM_PROMPT` — full 5-step research via web search
- `WEBSITE_INPUT_SYSTEM_PROMPT` — Steps 1+2 from a user-supplied URL, no `web_search`
- `WEBSITE_SEARCH_TOOLS` — tool definitions for web research tracks

### Flag system

Flags are **per-asset** (`asset.flags[]`). Never copy company-level flags down to individual assets. The table renders only `asset.flags` per row — do not merge with `result.flags`.

**Auto-computed (scripted, in `computeFlagsFromAsset`):**

| Flag | Trigger |
|------|---------|
| `indication-synergy` | `asset.indication` matches BeOne focus keywords (lung, GI, breast/gyn, hematology). Checks **only** `asset.indication` (AI-summarized) — NOT `asset.indications` (raw Citeline string, which can contain unrelated entries). Prostate is explicitly excluded. |
| `phase-synergy` | Preclinical, Phase 2/3, Phase 3, or Lead Opt |

**Auto-computed (Claude-aided, via `/api/autoflag`):**

| Flag | Trigger |
|------|---------|
| `checkpoint-io-alt` | Non-PD-1/PD-L1 checkpoint target (LAG-3, TIGIT, CTLA-4, etc.) and NOT a TCE |
| `masked-tce-4-1bb` | 4-1BB/CD137 target, OR masking/conditional-activation language on a TCE |
| `adc-novel-payload` | ADC with novel or dual payload (not just DXd/SN-38/MMAE) |

**Process flags (company-level only):**

| Flag | Meaning |
|------|---------|
| `thin-coverage` | Citeline data sparse; suggests Website Track follow-up |
| `purple-flag` | External sourcing used (press releases etc.) instead of company site |
| `check-mfg-partner` | Manufacturing partner territory/capability ambiguous |

### Key functions

| Function | Location | Notes |
|----------|----------|-------|
| `computeFlagsFromAsset(asset, overview)` | ~line 2080 | Scripted flag derivation — returns array, does NOT mutate asset |
| `applyAutoFlags(result)` | ~line 2135 | Iterates all assets, sets `asset.flags = derived`, bubbles to `result.flags` |
| `matchesIndicationSynergy(text)` | ~line 2039 | Keyword check; strips prostate first |
| `computePhaseSynergy(asset, ctgov)` | ~line 2046 | Phase check with ClinicalTrials.gov fallback |
| `citelineGetAssetsLocal(companyName)` | mid-file | Fuzzy-match company name against XLSX/SQL data |
| `checkExclusions(companyName)` | mid-file | Checks Exclusions.xlsx; multi-stage name matching |
| `assetScreenDecision(asset)` | ~line 97 | Returns `{ decision, layer, reason }` for DB storage |
| `saveScreeningResult(result, runId)` | ~line 129 | Upserts to `screened_companies` + `screened_assets` |

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/screen` | Main SSE screening stream |
| `POST` | `/api/screen/website-track` | Website-only deep research |
| `POST` | `/api/autoflag` | Re-compute flags for a company |
| `GET` | `/api/runs` | List all screening runs |
| `GET` | `/api/runs/:id` | Full results for a run |
| `POST` | `/api/runs/:id/sync` | Persist run results to DB |
| `GET` | `/api/runs/:id/export` | CSV export |
| `GET` | `/api/repository` | Deduplicated company repository |
| `DELETE` | `/api/runs` | Delete all runs |

## Common gotchas

1. **`indication` vs `indications`** — `asset.indication` is the AI-summarized string Claude returns. `asset.indications` is the raw Citeline `STRING_AGG(diseaseName)` dump. Only ever use `asset.indication` for flag logic and display. The raw `indications` field can contain cancer subtypes from unrelated trials.

2. **Asset flags are per-asset, not per-company** — `applyAutoFlags` bubbles asset flags up to `result.flags`, but the UI must render only `asset.flags` per row. Never display `result.flags` (company aggregate) on individual asset rows.

3. **SSE keepalives** — `/api/screen` sends a comment line every 5s to prevent proxy timeouts during long Claude calls. Don't remove this.

4. **Citeline SQL vs XLSX fallback** — If `CITELINE_USER`/`CITELINE_PASS` are absent or the Azure connection fails, the system silently falls back to the local XLSX. Both paths produce the same data shape.

5. **Name matching is fuzzy** — `citelineGetAssetsLocal` uses root-word → close-match → keyword-overlap stages. Company names with Ltd/Inc/Corp suffixes are normalized before matching.

6. **OneBD rate limiting** — Claude is instructed to call `onebd_resolve_company` and `onebd_get_deals` exactly once per company. Don't add extra calls in prompts.

7. **Prostate cancer** — explicitly excluded from `indication-synergy`. The `PROSTATE_RE` regex strips it before keyword matching. Do not add 'prostate' or 'urological' to the synergy keywords.

8. **`WEBSITE_SEARCH_TOOLS` vs `WEBSITE_INPUT_SEARCH_TOOLS`** — only `WEBSITE_SEARCH_TOOLS` exists; the old name `WEBSITE_INPUT_SEARCH_TOOLS` was a bug and has been removed.

## Database schema

```sql
screening_runs       (id, created_at, company_count)
screened_companies   (id, run_id, company_name, status, excluded_reason, inconclusive_reason, result_json JSONB)
screened_assets      (id, company_id, asset_name, modality, pathway, indication, is_platform, screen_decision, excluded_layer, excluded_reason)
```

`result_json` holds the full Claude output including all assets, flags, sources, deals, and layer details.
