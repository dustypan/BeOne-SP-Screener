'use strict';
/**
 * OneBD data-pull test
 * Usage:  node scripts/onebd-test.js "Company A" "Company B" ...
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const BASE   = 'https://onebd.pchomelab.com/api/v1';
const APIKEY = process.env.ONEBD_API_KEY;
if (!APIKEY) { console.error('ONEBD_API_KEY not set'); process.exit(1); }

const H = { 'X-API-Key': APIKEY, 'Content-Type': 'application/json' };

async function get(path)        { const r = await axios.get(`${BASE}${path}`, { headers: H }); return r.data; }
async function post(path, body) { const r = await axios.post(`${BASE}${path}`, body, { headers: H }); return r.data; }

const MFG_KEYWORDS = [
  'manufactur', 'cdmo', 'cmo', 'contract manufactur', 'supply agreement',
  'tech transfer', 'bioreactor', 'lonza', 'wuxi biolog', 'samsung biolog',
  'thermo fisher', 'catalent', 'fujifilm', 'agc biolog', 'rentschler', 'patheon',
];

function isMfgDeal(title, summary) {
  const text = (title + ' ' + (summary || '')).toLowerCase();
  return MFG_KEYWORDS.some(k => text.includes(k));
}

function isLicensingDeal(title, summary) {
  const text = (title + ' ' + (summary || '')).toLowerCase();
  return ['licens', 'out-licens', 'territory', 'rights', 'royalt', 'option to licens',
          'commercializ', 'develop and commercializ', 'exclusive', 'sublicens'].some(k => text.includes(k));
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 350);
}

// ── resolve company name → company record ─────────────────────────────────
async function resolveCompany(name) {
  const res = await post('/search', {
    query: name,
    datasets: ['companies'],
    limit_per_dataset: 5,
  });
  const hits = ((res.groups || []).find(g => g.dataset === 'companies')?.items) || [];
  const exact = hits.find(c => c.name.toLowerCase().includes(name.toLowerCase().split(' ')[0].toLowerCase()));
  return exact || hits[0] || null;
}

// ── assets linked to company ──────────────────────────────────────────────
async function getAssets(companyId) {
  const res = await post('/assets/search', {
    companies: { all: [{ id: companyId }] },
    expand: ['modalities', 'diseases', 'targets', 'companies'],
    limit: 50,
  });
  return res.items || [];
}

// ── deals for a company (using id) ───────────────────────────────────────
async function getDeals(companyId) {
  const res = await post('/deals/search', {
    companies: { all: [{ id: companyId }] },
    expand: ['assets', 'companies', 'territories', 'values', 'modalities', 'diseases'],
    limit: 100,
  });
  return res.items || [];
}

// ── print helpers ─────────────────────────────────────────────────────────
function fmtList(arr, field) {
  if (!arr || arr.length === 0) return '—';
  return arr.map(x => (typeof x === 'string' ? x : (x[field] || x.name || x.label || JSON.stringify(x)))).join(', ');
}

// ── main per-company function ─────────────────────────────────────────────
async function testCompany(name) {
  console.log('\n' + '═'.repeat(72));
  console.log(`  COMPANY: ${name}`);
  console.log('═'.repeat(72));

  const co = await resolveCompany(name);
  if (!co) {
    console.log('  ✗ Not found in OneBD\n');
    return;
  }
  console.log(`  ✓ "${co.name}"  id:${co.id}  type:${co.company_type || '—'}  total deals:${co.deal_count ?? '?'}`);

  // ── Assets ───────────────────────────────────────────────────────────────
  const assets = await getAssets(co.id);
  console.log(`\n  ── ASSETS (${assets.length}) ──────────────────────────────────────`);
  if (assets.length === 0) {
    console.log('  none returned');
  } else {
    for (const a of assets) {
      const mods     = fmtList(a.modalities, 'name');
      const dis      = fmtList(a.diseases,   'name');
      const tgts     = fmtList(a.targets,    'name');
      const phase    = a.phase_highest_now || a.phase_highest_start || '—';
      const isBio    = (a.modalities || []).some(m => m.name === 'Biological') ? 'Biologic'
                     : (a.modalities || []).some(m => /small.?mol/i.test(m.name)) ? 'Small molecule'
                     : '—';
      const role     = (a.companies || []).find(c => c.id === co.id)?.role || '—';
      console.log(`\n  • ${a.name_display || a.id}`);
      console.log(`    Bio/SM     : ${isBio}`);
      console.log(`    Modality   : ${mods}`);
      console.log(`    Indication : ${dis}`);
      console.log(`    Target(s)  : ${tgts}`);
      console.log(`    Phase      : ${phase}`);
      console.log(`    Co. role   : ${role}`);
    }
  }

  // ── Deals ────────────────────────────────────────────────────────────────
  const deals = await getDeals(co.id);
  const mfgDeals = deals.filter(d => isMfgDeal(d.title, d.summary_excerpt));
  const licDeals = deals.filter(d => isLicensingDeal(d.title, d.summary_excerpt) && !isMfgDeal(d.title, d.summary_excerpt));
  const other    = deals.filter(d => !isMfgDeal(d.title, d.summary_excerpt) && !isLicensingDeal(d.title, d.summary_excerpt));

  console.log(`\n  ── MANUFACTURING DEALS (${mfgDeals.length} / ${deals.length} total) ──────────────`);
  if (mfgDeals.length === 0) {
    console.log('  none');
  } else {
    for (const d of mfgDeals) {
      const terr  = fmtList(d.territories, 'name');
      const vals  = d.values?.length ? d.values.map(v => `${v.type} $${v.amount_usd_m}M`).join(', ') : '';
      const anames = fmtList(d.assets, 'name_display');
      console.log(`\n  • [${d.date_start?.slice(0,10)}] ${d.title}`);
      if (anames !== '—') console.log(`    Assets     : ${anames}`);
      if (terr   !== '—') console.log(`    Territory  : ${terr}`);
      if (vals)           console.log(`    Value      : ${vals}`);
      console.log(`    ${stripHtml(d.summary_excerpt)}`);
    }
  }

  console.log(`\n  ── LICENSING / RIGHTS DEALS (${licDeals.length}) ───────────────────────`);
  if (licDeals.length === 0) {
    console.log('  none');
  } else {
    for (const d of licDeals) {
      const terr  = fmtList(d.territories, 'name');
      const vals  = d.values?.length ? d.values.map(v => `${v.type} $${v.amount_usd_m}M`).join(', ') : '';
      const anames = fmtList(d.assets, 'name_display');
      console.log(`\n  • [${d.date_start?.slice(0,10)}] ${d.title}`);
      if (anames !== '—') console.log(`    Assets     : ${anames}`);
      if (terr   !== '—') console.log(`    Territory  : ${terr}`);
      if (vals)           console.log(`    Value      : ${vals}`);
      console.log(`    ${stripHtml(d.summary_excerpt)}`);
    }
  }

  if (other.length) {
    console.log(`\n  ── OTHER DEALS (${other.length}) ─────────────────────────────────────`);
    for (const d of other) {
      console.log(`  • [${d.date_start?.slice(0,10)}] ${d.title}`);
    }
  }
}

// ── entry point ────────────────────────────────────────────────────────────
const companies = process.argv.slice(2);
if (!companies.length) { console.error('Usage: node scripts/onebd-test.js "Company A" ...'); process.exit(1); }

(async () => {
  for (const name of companies) {
    try { await testCompany(name); }
    catch (e) { console.error(`\n  ERROR for "${name}": ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`); }
  }
  console.log('\n' + '─'.repeat(72) + '\nDone.');
})();
