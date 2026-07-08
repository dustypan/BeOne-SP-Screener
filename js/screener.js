'use strict';

// ──────────────────────────────────────────────────────────────
// Layer 5 — direct competitor check (pure data, no fetch)
// ──────────────────────────────────────────────────────────────

// "msAb" (monospecific antibody) is standard terminology for the same thing as "mAb" —
// normalize so a screening result using either term still matches correctly.
function normalizeModality(modality) {
  const m = String(modality || '').trim();
  return m.toLowerCase() === 'msab' ? 'mAb' : m;
}

function computeLayer5(asset) {
  if (asset.isPlatform) {
    return { status: 'inconclusive', reason: 'Platform record — Layer 5 not applicable' };
  }

  const candidateModality = normalizeModality(asset.modality);
  const candidateTargets = [...(asset.targets || [])].sort();

  // PD-1/PD-L1 "contains" rule (single-target mAb only, same treatment as HER2 below):
  // BeOne's anti-PD-1 mAb pipeline entry competes with ANY single-target monospecific
  // antibody against either side of the same checkpoint axis — PD-1 or PD-L1 — not just an
  // exact "PD-1" string match. Does not extend to bispecifics/multispecifics containing PD-1/PD-L1.
  const pd1Entry = BEONE_PIPELINE.find(e => e.modality === 'mAb' && e.targets.length === 1 && e.targets[0] === 'PD-1');
  if (pd1Entry && candidateModality === 'mAb' && candidateTargets.length === 1 &&
      (candidateTargets[0] === 'PD-1' || candidateTargets[0] === 'PD-L1')) {
    return {
      status: 'fail',
      reason: `Competitive overlap — PD-1/PD-L1 checkpoint mAb vs BeOne pipeline (${pd1Entry.name})`,
    };
  }

  for (const entry of BEONE_PIPELINE) {
    // HER2 "contains" rule: if the BeOne entry has HER2, any candidate asset with HER2 anywhere is a match.
    if (entry.targets.includes('HER2')) {
      if (candidateTargets.includes('HER2')) {
        return {
          status: 'fail',
          reason: `Competitive overlap — HER2 match with BeOne pipeline (${entry.name})`,
        };
      }
      continue;
    }

    // Exact multiset rule for all other targets.
    if (candidateModality === entry.modality) {
      const entryTargets = [...entry.targets].sort();
      if (JSON.stringify(candidateTargets) === JSON.stringify(entryTargets)) {
        return {
          status: 'fail',
          reason: `Competitive overlap with BeOne pipeline: ${entry.name}`,
        };
      }
    }
  }

  return { status: 'pass', reason: '' };
}

// ──────────────────────────────────────────────────────────────
// Normalize company name for fuzzy matching
// Strips legal suffixes so "Acme Inc." matches "Acme"
// ──────────────────────────────────────────────────────────────

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[.,]$/, '')
    .replace(
      /\s+(inc|ltd|llc|co|corp|corporation|therapeutics|biosciences|biologics|pharma|pharmaceuticals|biotech|biotechnology|biopharma|oncology|sciences|biotherapeutics)\.?\s*$/i,
      ''
    )
    .trim();
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ──────────────────────────────────────────────────────────────
// Build a unified company list from Excel names + COMPANY_DATA
// ──────────────────────────────────────────────────────────────

function resolveCompany(name) {
  const key = normalizeName(name);
  const existing = (window.COMPANY_DATA || []).find(c => normalizeName(c.name) === key);

  if (!existing) {
    return {
      id: slugify(name),
      name: name.trim(),
      type: null,
      website: '',
      status: 'inconclusive',
      excludedAt: null,
      excludedReason: '',
      inconclusiveReason: 'Not yet screened',
      assets: [],
      beoneAnalyzed: false,
      beoneOutcome: null,
      flags: [],
      researchNotes: '',
    };
  }

  // Deep clone so we don't mutate the source data
  const company = JSON.parse(JSON.stringify(existing));

  // Compute Layer 5 at runtime for each asset
  for (const asset of company.assets || []) {
    asset.layer5 = computeLayer5(asset);
  }

  return company;
}

// ──────────────────────────────────────────────────────────────
// Categorize a list of companies into three buckets
// ──────────────────────────────────────────────────────────────

function categorize(companies) {
  const qualifying = [];
  const excluded = [];
  const inconclusive = [];

  for (const c of companies) {
    if (c.status === 'excluded') {
      excluded.push(c);
    } else if (c.status === 'inconclusive') {
      inconclusive.push(c);
    } else if (c.status === 'qualifying') {
      // A company qualifies if it has at least one asset that passes all layers including L5
      const hasQualifyingAsset = (c.assets || []).some(
        a => a.overallStatus !== 'excluded' && (!a.layer5 || a.layer5.status === 'pass')
      );
      if (hasQualifyingAsset) {
        qualifying.push(c);
      } else {
        const allCompetitors = (c.assets || []).every(a => a.layer5 && a.layer5.status === 'fail');
        excluded.push({
          ...c,
          excludedAt: 'layer5',
          excludedReason: allCompetitors
            ? 'All assets are direct competitors of BeOne pipeline'
            : 'No qualifying assets passed all layers',
        });
      }
    } else {
      // unscreened or unknown status
      inconclusive.push(c);
    }
  }

  return { qualifying, excluded, inconclusive };
}

