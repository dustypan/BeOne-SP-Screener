'use strict';

// ──────────────────────────────────────────────────────────────
// Application state
// ──────────────────────────────────────────────────────────────

const state = {
  // Excel parsing
  sheetRows: [],
  sheetHeaders: [],

  // Screener output
  companies: [],          // all resolved companies (Excel names + COMPANY_DATA)
  categories: null,       // { qualifying, excluded, inconclusive }

  // Wizard
  wizardStep: 1,
  anyTarget: true,
  selectedTargetIds: new Set(),
  beoneReviews: {},        // companyId → 'positive' | 'revisit' | 'negative' | null
  websiteInputs: {},       // companyId → url string
  skippedInconclusives: new Set(), // companyIds skipped in Ask 1 re-screen

  // Filtered list (output of wizard, updated at each step)
  wizardFiltered: [],

  // Results view
  hidingCompetitors: true,
  searchQuery: '',

  // Current screening run (DB-backed)
  currentRunId: null,
};

// ──────────────────────────────────────────────────────────────
// Persistence (localStorage)
// ──────────────────────────────────────────────────────────────

// ── API Key ────────────────────────────────────────────────────

function getApiKey() {
  return localStorage.getItem('beone-api-key') || '';
}

function initApiKey() {
  const input    = document.getElementById('api-key-input');
  const saveBtn  = document.getElementById('api-key-save-btn');
  const statusEl = document.getElementById('api-key-status');
  if (!input) return;

  const saved = getApiKey();
  if (saved) {
    input.value = saved;
    statusEl.textContent = 'Key saved ✓';
    statusEl.className = 'api-key-status saved';
  }

  saveBtn.addEventListener('click', () => {
    const key = input.value.trim();
    if (!key) {
      localStorage.removeItem('beone-api-key');
      statusEl.textContent = 'Key cleared';
      statusEl.className = 'api-key-status missing';
      return;
    }
    if (!key.startsWith('sk-ant-')) {
      statusEl.textContent = 'Does not look like an Anthropic key (should start with sk-ant-)';
      statusEl.className = 'api-key-status missing';
      return;
    }
    localStorage.setItem('beone-api-key', key);
    statusEl.textContent = 'Key saved ✓';
    statusEl.className = 'api-key-status saved';
  });
}

// ───────────────────────────────────────────────────────────────

function loadPersisted() {
  try {
    const r = localStorage.getItem('beone-reviews');
    if (r) state.beoneReviews = JSON.parse(r);
    const w = localStorage.getItem('beone-website-inputs');
    if (w) state.websiteInputs = JSON.parse(w);
  } catch (_) {}
}


function saveReviews() {
  localStorage.setItem('beone-reviews', JSON.stringify(state.beoneReviews));
}

function saveWebsiteInputs() {
  localStorage.setItem('beone-website-inputs', JSON.stringify(state.websiteInputs));
}

// ──────────────────────────────────────────────────────────────
// Section navigation
// ──────────────────────────────────────────────────────────────

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ──────────────────────────────────────────────────────────────
// SECTION: Upload
// ──────────────────────────────────────────────────────────────

function initUpload() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  document.getElementById('run-textbox-btn').addEventListener('click', () => {
    const raw = document.getElementById('company-textbox').value;
    const names = raw
      .split('\n')
      .map(n => n.trim())
      .filter(n => n.length > 0);

    if (names.length === 0) {
      alert('Enter at least one company name.');
      return;
    }

    runScreener(names);
  });
}

function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(ext)) {
    alert('Please upload an Excel file (.xlsx, .xls) or CSV.');
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      if (!rows || rows.length < 2) {
        alert('The file appears to be empty or has no data rows.');
        return;
      }

      state.sheetRows = rows;
      state.sheetHeaders = (rows[0] || []).map((h, i) => ({
        index: i,
        label: String(h || '').trim() || `Column ${i + 1}`,
      }));

      document.getElementById('file-name-display').textContent = file.name;
      renderColumnPicker();
      showSection('section-column-pick');
    } catch (err) {
      alert('Could not parse the file. Make sure it is a valid Excel or CSV file.');
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ──────────────────────────────────────────────────────────────
// SECTION: Column Picker
// ──────────────────────────────────────────────────────────────

function renderColumnPicker() {
  const select = document.getElementById('column-select');
  select.innerHTML = state.sheetHeaders
    .map(h => `<option value="${h.index}">${escHtml(h.label)}</option>`)
    .join('');

  // Auto-detect likely company name column
  const autoIdx = state.sheetHeaders.findIndex(h =>
    /company|name|org|firm/i.test(h.label)
  );
  if (autoIdx >= 0) select.value = autoIdx;

  updateColumnPreview(parseInt(select.value, 10));
  select.addEventListener('change', e => updateColumnPreview(parseInt(e.target.value, 10)));
}

function updateColumnPreview(colIndex) {
  const samples = state.sheetRows
    .slice(1, 8)
    .map(r => String(r[colIndex] || '').trim())
    .filter(v => v.length > 0)
    .slice(0, 4);

  document.getElementById('column-preview').textContent =
    samples.length ? `Preview: ${samples.join('  ·  ')}` : 'No data in this column';
}

function initColumnPicker() {
  document.getElementById('back-to-upload').addEventListener('click', () => {
    showSection('section-upload');
  });

  document.getElementById('run-screener-btn').addEventListener('click', () => {
    const colIndex = parseInt(document.getElementById('column-select').value, 10);
    const names = state.sheetRows
      .slice(1)
      .map(r => String(r[colIndex] || '').trim())
      .filter(n => n.length > 0);

    if (names.length === 0) {
      alert('No company names found in the selected column.');
      return;
    }

    runScreener(names);
  });
}

// ──────────────────────────────────────────────────────────────
// SECTION: Loading / Processing
// ──────────────────────────────────────────────────────────────

// Companies are independent of each other, so they're screened concurrently
// (worker-pool pattern, CONCURRENCY in flight at once) rather than one at a
// time — this is the dominant lever on wall-clock time per company, since
// each individual screening call already takes several Claude API turns.
const SCREEN_CONCURRENCY = 4;

async function runScreener(names) {
  showSection('section-loading');

  const bar   = document.getElementById('progress-bar-fill');
  const label = document.getElementById('progress-label');
  const total = names.length;
  const companies = new Array(total);
  let completed = 0;

  bar.style.width = '0%';
  bar.classList.add('progress-starting');
  label.textContent = 'Starting…';

  // Create a run record in the DB to track this session
  state.currentRunId = null;
  try {
    const runResp = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyCount: total }),
    });
    if (runResp.ok) {
      const run = await runResp.json();
      state.currentRunId = run.id;
    }
  } catch (_) {}

  async function screenOne(i) {
    const name = names[i];

    // Use cached result from data.js if available
    const cached = resolveCompany(name);
    if (cached.status !== 'inconclusive' || cached.inconclusiveReason !== 'Not yet screened') {
      // Already screened — use cached
      if (state.beoneReviews[cached.id] != null) {
        cached.beoneOutcome = state.beoneReviews[cached.id];
        cached.beoneAnalyzed = true;
      }
      companies[i] = cached;
    } else {
      // Not yet screened — call the server
      try {
        const resp = await fetch('/api/screen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
          body: JSON.stringify({ company: name, runId: state.currentRunId }),
        });

        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

        const result = await resp.json();

        // Compute Layer 5 for each asset
        for (const asset of result.assets || []) {
          asset.layer3 = computeLayer3(asset);
        }

        // Apply persisted BeOne review
        if (state.beoneReviews[result.id] != null) {
          result.beoneOutcome = state.beoneReviews[result.id];
          result.beoneAnalyzed = true;
        }

        companies[i] = result;
      } catch (err) {
        // Server not running or network error
        const isConnectionError = err.message.includes('fetch') || err.message.includes('Failed') || err.message.includes('NetworkError');
        companies[i] = {
          id: slugify(name),
          name,
          type: null,
          website: null,
          status: 'inconclusive',
          excludedAt: null,
          excludedReason: '',
          inconclusiveReason: isConnectionError
            ? 'Server not running — start with: node server.js'
            : `Screening error: ${err.message}`,
          assets: [],
          beoneAnalyzed: false,
          beoneOutcome: null,
          flags: [],
          researchNotes: '',
        };
      }
    }

    completed++;
    bar.classList.remove('progress-starting');
    bar.style.width = `${Math.round((completed / total) * 100)}%`;
    label.textContent = `Screened ${completed} of ${total}…`;
  }

  // Worker pool: keep up to SCREEN_CONCURRENCY requests in flight, refilling
  // as each finishes, rather than waiting for a whole fixed-size batch.
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < total) {
      const i = nextIndex++;
      await screenOne(i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SCREEN_CONCURRENCY, total) }, worker)
  );

  bar.style.width = '100%';
  label.textContent = 'Screening complete';
  setTimeout(() => finishScreening(companies), 400);
}

function finishScreening(companies) {
  state.companies = companies;
  state.categories = categorize(companies);
  state.wizardFiltered = [...state.categories.qualifying];

  renderSummary();
  showSection('section-summary');
}

// ──────────────────────────────────────────────────────────────
// SECTION: Summary (three buckets)
// ──────────────────────────────────────────────────────────────

function renderSummary() {
  const { qualifying, excluded, inconclusive } = state.categories;

  setCount('count-qualifying', qualifying.length);
  setCount('count-excluded', excluded.length);
  setCount('count-inconclusive', inconclusive.length);

  renderBucketList('list-qualifying', qualifying, c =>
    `${(c.assets || []).filter(a => !a.layer3 || a.layer3.status !== 'fail').length} asset(s) qualifying`
  );
  renderBucketList('list-excluded', excluded, c => {
    const at = c.excludedAt ? ` (Layer ${c.excludedAt.replace('layer', '')})` : c.excludedAt === 'pre-filter' ? ' (Pre-filter)' : '';
    return (c.excludedReason || 'Screened out') + at;
  });
  // Inconclusive bucket — inline render so we can add the "unreadable" badge
  (function() {
    const el = document.getElementById('list-inconclusive');
    if (!el) return;
    if (inconclusive.length === 0) { el.innerHTML = '<p class="empty-msg">None</p>'; return; }
    el.innerHTML = inconclusive.map(c => {
      const reason = c.inconclusiveReason || 'Inconclusive';
      const isUnreadable = /website unreadable/i.test(reason);
      const badge = isUnreadable
        ? '<span class="badge-unreadable">🔒 Unreadable</span>'
        : '';
      return `<div class="bucket-item">
        <span class="bucket-company">${escHtml(c.name)}</span>
        ${badge}
        <span class="bucket-reason">${escHtml(reason)}</span>
      </div>`;
    }).join('');
  })();
}

function setCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = n;
}

function renderBucketList(containerId, companies, reasonFn) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (companies.length === 0) {
    el.innerHTML = '<p class="empty-msg">None</p>';
    return;
  }

  el.innerHTML = companies.map(c => `
    <div class="bucket-item">
      <span class="bucket-company">${escHtml(c.name)}</span>
      <span class="bucket-reason">${escHtml(reasonFn(c))}</span>
    </div>
  `).join('');
}

function initSummary() {
  // Toggle expand/collapse for each bucket body
  document.querySelectorAll('.bucket-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.closest('.bucket-card').querySelector('.bucket-body');
      const expanded = !body.classList.contains('collapsed');
      body.classList.toggle('collapsed', expanded);
      btn.textContent = expanded ? '▶' : '▼';
    });
  });

  document.getElementById('continue-wizard-btn').addEventListener('click', () => {
    startWizard();
  });
}

// ──────────────────────────────────────────────────────────────
// SECTION: Wizard (four asks)
// ──────────────────────────────────────────────────────────────

function startWizard() {
  state.wizardStep = 1;
  // Reset selections
  state.anyTarget = true;
  state.selectedTargetIds = new Set();
  state.wizardFiltered = [...state.categories.qualifying];

  showSection('section-wizard');
  renderWizardStep();
}

function renderWizardStep() {
  // Step indicator dots
  document.querySelectorAll('.step-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i + 1 === state.wizardStep);
    dot.classList.toggle('done', i + 1 < state.wizardStep);
  });

  // Show correct ask panel
  document.querySelectorAll('.ask-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`ask-${state.wizardStep}`);
  if (panel) panel.classList.add('active');

  // Back/Next button labels
  const backBtn = document.getElementById('wizard-back-btn');
  const nextBtn = document.getElementById('wizard-next-btn');
  backBtn.textContent = state.wizardStep === 1 ? '← Summary' : '← Back';
  nextBtn.textContent = state.wizardStep === 3 ? 'View Results →' : 'Next →';

  switch (state.wizardStep) {
    case 1: renderAsk1(); break; // Website Input
    case 2: renderAsk2(); break; // Met With
    case 3: renderAsk3(); break; // Target / Pathway
  }

  updateRemainingCount();
}

function updateRemainingCount() {
  document.getElementById('remaining-count').textContent =
    `${state.wizardFiltered.length} ${state.wizardFiltered.length === 1 ? 'company' : 'companies'} remaining`;
}

// Ask 1 — Rerun Inconclusives (show ALL inconclusives, URL optional)
function renderAsk1() {
  const container = document.getElementById('ask1-companies');
  const noInput = document.getElementById('ask1-none-msg');
  if (!container) return;

  const allInconclusive = state.categories.inconclusive;

  if (allInconclusive.length === 0) {
    container.innerHTML = '';
    if (noInput) noInput.classList.remove('hidden');
    return;
  }

  if (noInput) noInput.classList.add('hidden');

  container.innerHTML = allInconclusive.map(c => {
    const isPaused = c.status === 'paused';
    const isSkipped = state.skippedInconclusives.has(c.id);
    const notFoundInPharmcube = /not found in pharmcube/i.test(c.inconclusiveReason || '');
    if (isPaused) {
      return `
    <div class="url-row url-row-paused" data-id="${escHtml(c.id)}">
      <span class="url-company">${escHtml(c.name)}</span>
      <span class="url-reason">${escHtml(c.inconclusiveReason || 'Credit cap reached')}</span>
      <span class="url-note url-note-warn">⚡ Pharmcube data saved — no re-billing needed to continue</span>
      <button class="btn-continue-screen" data-id="${escHtml(c.id)}">Continue anyway</button>
    </div>`;
    }
    return `
    <div class="url-row${isSkipped ? ' url-row-skipped' : ''}" data-id="${escHtml(c.id)}">
      <span class="url-company">${escHtml(c.name)}</span>
      <span class="url-reason">${escHtml(c.inconclusiveReason || 'Inconclusive')}</span>
      ${notFoundInPharmcube
        ? `<span class="url-note">⚡ Will use URL you provide — Pharmcube skipped</span>`
        : /website unreadable/i.test(c.inconclusiveReason || '')
          ? `<span class="url-note url-note-warn">🔒 Site found but unreadable — provide an alternative URL or skip</span>`
          : ''}
      <input type="url" class="url-input" placeholder="https://… (optional)"
        value="${escHtml(state.websiteInputs[c.id] || '')}"
        data-id="${escHtml(c.id)}"
        ${isSkipped ? 'disabled' : ''}>
      <button class="btn-skip-inconclusive${isSkipped ? ' is-skipped' : ''}" data-id="${escHtml(c.id)}">
        ${isSkipped ? '↩ Unskip' : 'Skip'}
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('.url-input').forEach(input => {
    input.addEventListener('input', e => {
      state.websiteInputs[e.target.dataset.id] = e.target.value.trim();
      saveWebsiteInputs();
    });
  });

  container.querySelectorAll('.btn-skip-inconclusive').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const row = container.querySelector(`.url-row[data-id="${CSS.escape(id)}"]`);
      const input = container.querySelector(`.url-input[data-id="${CSS.escape(id)}"]`);
      if (state.skippedInconclusives.has(id)) {
        state.skippedInconclusives.delete(id);
        btn.textContent = 'Skip';
        btn.classList.remove('is-skipped');
        if (row) row.classList.remove('url-row-skipped');
        if (input) input.disabled = false;
      } else {
        state.skippedInconclusives.add(id);
        btn.textContent = '↩ Unskip';
        btn.classList.add('is-skipped');
        if (row) row.classList.add('url-row-skipped');
        if (input) input.disabled = true;
      }
    });
  });

  container.querySelectorAll('.btn-continue-screen').forEach(btn => {
    btn.addEventListener('click', () => continueCompanyScreening(btn.dataset.id));
  });
}

// Continue a company that was paused at the Pharmcube credit cap.
// Uses the saved call history so Pharmcube is NOT re-billed.
async function continueCompanyScreening(companyId) {
  const company = state.companies.find(c => c.id === companyId);
  if (!company || !company.pausedState) return;

  const row = document.querySelector(`#ask1-companies .url-row[data-id="${CSS.escape(companyId)}"]`);
  const btn = row && row.querySelector('.btn-continue-screen');
  if (btn) { btn.textContent = 'Running…'; btn.disabled = true; }

  try {
    const resp = await fetch('/api/screen/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
      body: JSON.stringify({
        company: company.name,
        runId: state.currentRunId,
        pausedState: company.pausedState,
      }),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const result = await resp.json();
    for (const asset of result.assets || []) {
      asset.layer3 = computeLayer3(asset);
    }
    if (state.beoneReviews[result.id] != null) {
      result.beoneOutcome = state.beoneReviews[result.id];
      result.beoneAnalyzed = true;
    }
    const idx = state.companies.findIndex(c => c.id === companyId);
    if (idx !== -1) state.companies[idx] = result;
    state.categories = categorize(state.companies);
    state.wizardFiltered = [...state.categories.qualifying];
    renderAsk1();
  } catch (err) {
    if (btn) { btn.textContent = 'Error — retry'; btn.disabled = false; }
  }
}

// Re-screen all inconclusive companies before proceeding to Ask 2
async function runRescreening() {
  const allInconclusives = state.categories.inconclusive;
  // Exclude companies the user explicitly skipped
  const inconclusives = allInconclusives.filter(c => !state.skippedInconclusives.has(c.id));
  if (inconclusives.length === 0) return;

  showSection('section-rescreening');
  const bar   = document.getElementById('rescreen-progress-bar-fill');
  const label = document.getElementById('rescreen-progress-label');
  bar.style.width = '0%';
  bar.classList.add('progress-starting');
  label.textContent = 'Starting…';

  let completed = 0;
  const total = inconclusives.length;

  async function rescreenOne(company) {
    const websiteUrl = state.websiteInputs[company.id] || company.website || null;
    // If the company wasn't found in Pharmcube during the first run, skip Pharmcube
    // and go straight to secondary track with the user-provided URL
    const notFoundInPharmcube = /not found in pharmcube/i.test(company.inconclusiveReason || '');
    const skipPharmcube = notFoundInPharmcube;
    try {
      const resp = await fetch('/api/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
        body: JSON.stringify({
          company: company.name,
          runId: state.currentRunId,
          websiteUrl,
          skipPharmcube,
        }),
      });
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const result = await resp.json();
      for (const asset of result.assets || []) {
        asset.layer3 = computeLayer3(asset);
      }
      if (state.beoneReviews[result.id] != null) {
        result.beoneOutcome = state.beoneReviews[result.id];
        result.beoneAnalyzed = true;
      }
      return result;
    } catch (err) {
      return {
        ...company,
        inconclusiveReason: `Re-screen error: ${err.message}`,
        screenerLog: null,
      };
    } finally {
      completed++;
      bar.classList.remove('progress-starting');
      bar.style.width = `${Math.round((completed / total) * 100)}%`;
      label.textContent = `Re-screened ${completed} of ${total}…`;
    }
  }

  // Run with same concurrency as main screener
  const queue = [...inconclusives];
  let qi = 0;
  async function worker() {
    while (qi < queue.length) {
      const company = queue[qi++];
      const newResult = await rescreenOne(company);
      // Replace the old company entry in state.companies
      const idx = state.companies.findIndex(c => c.id === company.id);
      if (idx !== -1) state.companies[idx] = newResult;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SCREEN_CONCURRENCY, total) }, worker)
  );

  // Recompute categories with updated results
  state.categories = categorize(state.companies);
  state.wizardFiltered = [...state.categories.qualifying];

  bar.style.width = '100%';
  label.textContent = 'Re-screening complete';
  await new Promise(r => setTimeout(r, 400));
}

// Ask 2 — Met With This Company? (Prior BeOne Analysis)
function renderAsk2() {
  const container = document.getElementById('ask2-companies');
  if (!container) return;

  if (state.wizardFiltered.length === 0) {
    container.innerHTML = '<p class="empty-msg">No qualifying companies remain after filtering.</p>';
    return;
  }

  container.innerHTML = state.wizardFiltered.map(c => {
    const review = state.beoneReviews[c.id] || '';
    return `
      <div class="review-row">
        <span class="review-company">${escHtml(c.name)}</span>
        <div class="review-options">
          <label class="radio-label">
            <input type="radio" name="rv-${escHtml(c.id)}" value="" ${review === '' ? 'checked' : ''}>
            Not yet reviewed
          </label>
          <label class="radio-label positive">
            <input type="radio" name="rv-${escHtml(c.id)}" value="positive" ${review === 'positive' ? 'checked' : ''}>
            Positive (+)
          </label>
          <label class="radio-label revisit">
            <input type="radio" name="rv-${escHtml(c.id)}" value="revisit" ${review === 'revisit' ? 'checked' : ''}>
            Revisit
          </label>
          <label class="radio-label negative">
            <input type="radio" name="rv-${escHtml(c.id)}" value="negative" ${review === 'negative' ? 'checked' : ''}>
            Negative (–)
          </label>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('input[type=radio]').forEach(radio => {
    radio.addEventListener('change', e => {
      const name = e.target.name; // "rv-{id}"
      const companyId = name.replace(/^rv-/, '');
      state.beoneReviews[companyId] = e.target.value || null;
      saveReviews();
      recomputeWizardFilter();
    });
  });
}

// Ask 3 — Target / Pathway. Checkbox list is compiled dynamically from the
// targets actually present on screened-in companies' (non-excluded) assets —
// not a fixed list — so it always reflects whatever's in the current run.

// NCI synonym map — maps variant spellings/aliases to one canonical name.
const TARGET_SYNONYMS = {
  'B7H3':     'B7-H3',
  'B7 H3':    'B7-H3',
  'PD1':      'PD-1',
  'PDL1':     'PD-L1',
  'PDL-1':    'PD-L1',
  'PD-L-1':   'PD-L1',
  'ERBB2':    'HER2',
  'ErbB2':    'HER2',
  'KK-LC-1':  'CT83',
  'KKLC1':    'CT83',
  // CD nomenclature → familiar names used by BeOne colleagues
  'CD137':    '4-1BB',
  'CD134':    'OX40',
  'CD278':    'ICOS',
  'CD279':    'PD-1',
  'CD274':    'PD-L1',
  'CD223':    'LAG-3',
  'CD366':    'TIM-3',
  'CD152':    'CTLA-4',
  'CD28':     'CD28',
  'Multiple':                     'Undisclosed',
  'Various':                      'Undisclosed',
  'Unknown':                      'Undisclosed',
  'TBD':                          'Undisclosed',
  'TAA':                          'Undisclosed',
  'Tumor Associated Antigen':     'Undisclosed',
  'Tumor-Associated Antigen':     'Undisclosed',
  'tumor-associated antigen':     'Undisclosed',
  'tumor associated antigen':     'Undisclosed',
  'Undisclosed Target':           'Undisclosed',
  'Proprietary Target':           'Undisclosed',
};

// Mechanism/modality terms that are NOT specific molecular targets —
// strip these from the target display so Ask 3 shows only real targets.
const NON_TARGET_TERMS = new Set([
  'Protein degrader', 'Protein Degrader', 'Protein degradation', 'Protein Degradation',
  'Tubulin', 'Microtubule', 'Microtubules',
  'DNA', 'DNA damage', 'Topoisomerase', 'Topoisomerase I', 'Topoisomerase II',
  'Radiotherapy', 'Chemotherapy', 'Immunotherapy',
  'mRNA', 'siRNA', 'miRNA',
  'Fc receptor', 'Fc Receptor',
]);

function normalizeTarget(t) {
  if (!t || !t.trim()) return null;
  const s = t.trim();
  if (NON_TARGET_TERMS.has(s)) return null;
  const mapped = TARGET_SYNONYMS[s];
  if (mapped === 'Undisclosed') return null;
  return mapped || s;
}

// Returns the full target combination as a single string (e.g. "PD-1×IL-2").
// Targets are normalized, deduped, and sorted so order in the raw data doesn't matter.
function formatTargetSet(targets) {
  if (!targets || targets.length === 0) return 'Undisclosed';
  const normalized = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  if (normalized.length === 0) return 'Undisclosed';
  return normalized.sort((a, b) => a.localeCompare(b)).join('×');
}

function computeAvailableTargets() {
  const targets = new Set();
  for (const c of state.categories.qualifying) {
    for (const a of (c.assets || [])) {
      if (a.overallStatus === 'excluded') continue;
      targets.add(formatTargetSet(a.targets));
    }
  }
  return Array.from(targets).sort((a, b) => {
    if (a === 'Undisclosed') return 1;
    if (b === 'Undisclosed') return -1;
    return a.localeCompare(b);
  });
}

function renderAsk3() {
  const container = document.getElementById('ask3-targets');
  const anyToggle = document.getElementById('any-target-toggle');
  const selectAllBtn = document.getElementById('ask3-select-all-btn');
  const deselectAllBtn = document.getElementById('ask3-deselect-all-btn');
  if (!container) return;

  const availableTargets = computeAvailableTargets();

  container.innerHTML = availableTargets.map(t => `
    <label class="cb-label ${state.anyTarget ? 'disabled' : ''}">
      <input type="checkbox" value="${escHtml(t)}"
        ${state.selectedTargetIds.has(t) ? 'checked' : ''}
        ${state.anyTarget ? 'disabled' : ''}>
      <span>${escHtml(t)}</span>
    </label>
  `).join('');

  if (anyToggle) {
    anyToggle.checked = state.anyTarget;
    anyToggle.onchange = e => {
      state.anyTarget = e.target.checked;
      renderAsk3();
      applyAsk3Filter();
    };
  }

  if (selectAllBtn) {
    selectAllBtn.onclick = () => {
      state.anyTarget = false;
      if (anyToggle) anyToggle.checked = false;
      state.selectedTargetIds = new Set(availableTargets);
      renderAsk3();
    };
  }

  if (deselectAllBtn) {
    deselectAllBtn.onclick = () => {
      state.anyTarget = false;
      if (anyToggle) anyToggle.checked = false;
      state.selectedTargetIds = new Set();
      renderAsk3();
    };
  }

  container.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', applyAsk3Filter)
  );

  applyAsk3Filter();
}

function applyAsk3Filter() {
  const checked = Array.from(
    document.querySelectorAll('#ask3-targets input:checked')
  ).map(cb => cb.value);
  state.selectedTargetIds = new Set(checked);
  recomputeWizardFilter();
}

// Recompute filtered list from all active ask2 (review) + ask3 (target) criteria.
// Revisit is intentionally excluded from this filter-out check — only Negative
// removes a company from the screened-in set.
function recomputeWizardFilter() {
  let result = state.categories.qualifying;

  result = result.filter(c => state.beoneReviews[c.id] !== 'negative');

  if (!state.anyTarget && state.selectedTargetIds.size > 0) {
    result = result.filter(c =>
      (c.assets || []).some(a => {
        if (a.overallStatus === 'excluded') return false;
        return state.selectedTargetIds.has(formatTargetSet(a.targets));
      })
    );
  }

  state.wizardFiltered = result;
  updateRemainingCount();
}

function initWizard() {
  document.getElementById('wizard-next-btn').addEventListener('click', async () => {
    if (state.wizardStep === 1) {
      // Re-screen all inconclusives before moving to Ask 2
      await runRescreening();
      state.wizardStep = 2;
      showSection('section-wizard');
      renderWizardStep();
    } else if (state.wizardStep < 3) {
      state.wizardStep++;
      renderWizardStep();
    } else {
      renderResults();
      showSection('section-results');
    }
  });

  document.getElementById('wizard-back-btn').addEventListener('click', () => {
    if (state.wizardStep > 1) {
      state.wizardStep--;
      renderWizardStep();
    } else {
      showSection('section-summary');
    }
  });
}

// ──────────────────────────────────────────────────────────────
// SECTION: Results
// ──────────────────────────────────────────────────────────────

function renderResults() {
  // Search
  const searchEl = document.getElementById('results-search');
  searchEl.value = state.searchQuery;
  searchEl.oninput = e => {
    state.searchQuery = e.target.value;
    renderResultsTable();
  };

  // Competitors toggle
  const toggle = document.getElementById('hide-competitors-toggle');
  toggle.checked = state.hidingCompetitors;
  toggle.onchange = e => {
    state.hidingCompetitors = e.target.checked;
    renderResultsTable();
  };

  // Show screened-out toggle
  const screenedOutToggle = document.getElementById('show-screened-out-toggle');
  screenedOutToggle.checked = state.showScreenedOut || false;
  screenedOutToggle.onchange = e => {
    state.showScreenedOut = e.target.checked;
    renderResultsTable();
  };

  // Export
  document.getElementById('export-csv-btn').onclick = exportCSV;

  // Back to wizard
  document.getElementById('back-to-wizard-btn').onclick = () => {
    showSection('section-wizard');
  };

  // Auto-flag high priority assets
  document.getElementById('autoflag-btn').onclick = runAutoFlag;

  renderResultsTable();
  renderAllExcludedSection();
  renderExcludedFooter();
  renderInconclusivesFooter();
}

function getFilteredAssets(company) {
  return (company.assets || []).filter(a => {
    // Step 4 (rights) and Step 5 (manufacturing) excluded assets always shown — red shading inline
    if (a.overallStatus === 'excluded' && a.layer4 && a.layer4.status === 'fail') return true;
    if (a.overallStatus === 'excluded' && a.layer5 && a.layer5.status === 'fail') return true;
    if (a.overallStatus === 'excluded' && !state.showScreenedOut) return false;
    if (state.hidingCompetitors && a.layer3 && a.layer3.status === 'fail') return false;
    return true;
  });
}

function getScreenedOutReason(a) {
  if (a.overallStatus !== 'excluded') return null;
  if (a.layer3 && a.layer3.status === 'fail') return { step: 'Step 3 — Competitive overlap', reason: a.layer3.reason || 'Direct competitor to BeOne pipeline' };
  if (a.layer2 && a.layer2.status === 'fail') return { step: 'Step 2 — Modality', reason: a.layer2.reason || 'Excluded modality' };
  if (a.layer1 && a.layer1.status === 'fail') return { step: 'Step 1 — Oncology relevance', reason: a.layer1.reason || 'No oncology indication' };
  if (a.layer4 && a.layer4.status === 'fail') return { step: 'Step 4 — Rights', reason: a.layer4.reason || 'US/global rights out-licensed' };
  if (a.layer5 && a.layer5.status === 'fail') return { step: 'Step 5 — Manufacturing', reason: a.layer5.reason || 'US manufacturing confirmed' };
  return { step: 'Screened out', reason: 'See research notes' };
}

function renderResultsTable() {
  const tbody = document.getElementById('results-tbody');
  const query = state.searchQuery.toLowerCase();

  // Companies where ALL non-competitor assets are excluded go to the all-excluded section
  const hasQualifyingAsset = c => (c.assets || []).some(a =>
    a.overallStatus !== 'excluded' && !(a.layer3 && a.layer3.status === 'fail')
  );

  const companies = state.wizardFiltered.filter(c => {
    if (!hasQualifyingAsset(c)) return false;
    if (!query) return true;
    if (c.name.toLowerCase().includes(query)) return true;
    return (c.assets || []).some(a => (a.name || '').toLowerCase().includes(query));
  });

  if (companies.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No qualifying companies match your current filters.</td></tr>`;
    updateResultsCount(0);
    return;
  }

  let html = '';
  let totalAssetRows = 0;

  for (const c of companies) {
    const visibleAssets = getFilteredAssets(c);
    const competitorAssets = (c.assets || []).filter(a => a.layer3 && a.layer3.status === 'fail');
    const companyFlags = c.flags || [];

    if (visibleAssets.length === 0) {
      // Company exists in filtered list but all its assets are hidden (competitors)
      html += `
        <tr class="company-row competitor-all-hidden">
          <td colspan="7" class="company-hidden-cell">
            <span class="co-name">${escHtml(c.name)}</span>
            <span class="hidden-badge">${competitorAssets.length} competitor asset(s) hidden</span>
          </td>
        </tr>
      `;
      continue;
    }

    visibleAssets.forEach((a, idx) => {
      const isFirst = idx === 0;
      const rowspan = visibleAssets.length;
      const assetFlags = a.flags || [];
      const allFlags = [...new Set([...companyFlags, ...assetFlags])];
      const isCompetitor = a.layer3 && a.layer3.status === 'fail';
      const isScreenedOut = a.overallStatus === 'excluded';
      const screenedOutInfo = isScreenedOut ? getScreenedOutReason(a) : null;
      const rowId = `row-${c.id}-${idx}`;
      const detailId = `detail-${c.id}-${idx}`;

      if (!isScreenedOut) totalAssetRows++;

      html += `
        <tr class="asset-row ${isCompetitor ? 'competitor' : ''} ${isScreenedOut ? 'asset-screened-out' : ''} ${isFirst ? 'company-first-row' : ''}" id="${rowId}" data-detail="${detailId}">
          ${isFirst ? `
            <td class="co-cell" rowspan="${rowspan}">
              <span class="qualifying-badge" title="Qualifies for BeOne partnership outreach">✓</span>
              <div class="co-cell-inner">
                <strong class="co-name">${escHtml(c.name)}</strong>
                ${c.type ? `<span class="type-badge ${c.type}">${c.type === 'public' ? 'Public' : 'Private'}</span>` : ''}
                ${c.recallTrack ? `<span class="recall-badge" title="Served from repository — last screened ${(c.lastScreenedAt || '').slice(0,10)}">🔄 Recall</span>` : ''}
                ${c.website ? `<a class="co-cell-btn" href="${escHtml(c.website)}" target="_blank" rel="noopener noreferrer">${c.type === 'public' ? '📋 10-K' : '🌐 Pipeline'}</a>` : ''}
                <button class="view-sources-btn" data-co="${escHtml(c.id)}">🔗 Sources</button>
                ${c.screenerLog ? `<button class="co-cell-btn co-console-btn" data-co-id="${escHtml(c.id)}">📋 Console</button>` : ''}
                ${c.researchNotes ? `<button class="co-cell-btn co-notes-btn" data-co-id="${escHtml(c.id)}">📋 Notes</button>` : ''}
                ${companyFlags.includes('thin-coverage') ? `<button class="co-cell-btn co-website-track-btn" data-co-id="${escHtml(c.id)}" data-co-website="${escHtml(c.website || '')}">🔍 Website Track</button>` : ''}
                ${(c.deals || []).length ? `<button class="co-cell-btn co-deals-btn" data-co-id="${escHtml(c.id)}">📄 ${c.deals.length} Deal${c.deals.length !== 1 ? 's' : ''}</button>` : ''}
                ${!state.hidingCompetitors && competitorAssets.length > 0 ? `
                  <span class="comp-count">${competitorAssets.length} competitor</span>` : ''}
              </div>
              ${(c.deals || []).length ? renderDealsPanel(c) : ''}
            </td>
          ` : ''}
          <td class="asset-name-cell">
            ${escHtml(a.name || (a.isPlatform ? '[Platform]' : '—'))}
            ${isCompetitor ? '<span class="comp-tag">competitor</span>' : ''}
            ${isScreenedOut && screenedOutInfo ? `<span class="screened-out-tag">${escHtml(screenedOutInfo.step)}</span>` : ''}
          </td>
          <td><span class="mod-tag mod-${(a.modality || '').toLowerCase().replace(/[^a-z]/g,'')}">${escHtml(a.modality || '—')}</span></td>
          <td class="targets-cell">${(a.targets || []).length ? (a.targets || []).map(t => `<span class="tgt-tag">${escHtml(t)}</span>`).join('') : '<span class="undisclosed">Undisclosed</span>'}</td>
          <td class="phase-cell">${escHtml(a.phase || '—')}</td>
          <td class="indication-cell">${escHtml(a.indication || '—')}</td>
          <td class="flags-cell">
            ${isScreenedOut && screenedOutInfo
              ? `<span class="screened-out-reason">${escHtml(screenedOutInfo.reason)}</span>`
              : `<div class="flags-inner">
                  ${renderFlagBadges(allFlags)}
                  <button class="edit-flags-btn" data-co="${escHtml(c.id)}" data-asset-idx="${idx}" title="Edit flags">✎</button>
                </div>`
            }
          </td>
        </tr>
        <tr class="detail-row hidden" id="${detailId}">
          <td colspan="7">${renderAssetDetail(c, a)}</td>
        </tr>
      `;
    });
  }

  tbody.innerHTML = html;
  updateResultsCount(totalAssetRows);

  // Expand/collapse on row click
  tbody.querySelectorAll('.asset-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const detail = document.getElementById(row.dataset.detail);
      if (detail) detail.classList.toggle('hidden');
    });
  });

  // Flag editor buttons
  tbody.querySelectorAll('.edit-flags-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openFlagModal(btn.dataset.co, parseInt(btn.dataset.assetIdx, 10));
    });
  });

  // External sources view buttons
  tbody.querySelectorAll('.view-sources-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openSourcesModal(btn.dataset.co);
    });
  });

  // Company-level console button
  tbody.querySelectorAll('.co-console-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const company = state.wizardFiltered.find(c => c.id === btn.dataset.coId);
      if (company) openConsoleModal(company.name, company.screenerLog);
    });
  });

  // Website Track button
  tbody.querySelectorAll('.co-website-track-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      runWebsiteTrack(btn.dataset.coId, btn.dataset.coWebsite, btn);
    });
  });

  // Deals panel toggle
  tbody.querySelectorAll('.co-deals-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const panel = document.getElementById(`deals-panel-${btn.dataset.coId}`);
      if (panel) panel.classList.toggle('open');
    });
  });

  // Company notes button
  tbody.querySelectorAll('.co-notes-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const company = state.wizardFiltered.find(c => c.id === btn.dataset.coId);
      if (company) openConsoleModal(`Notes — ${company.name}`, company.researchNotes);
    });
  });
}

function updateResultsCount(n) {
  const el = document.getElementById('results-asset-count');
  if (el) el.textContent = `${n} qualifying asset${n !== 1 ? 's' : ''}`;
}

function renderFlagBadges(flags) {
  if (!flags || flags.length === 0) return '<span class="no-flags">—</span>';
  return flags.map(f => {
    const def = FLAG_DEFS[f];
    if (!def) return '';
    return `<span class="flag-badge fc-${def.color}" title="${escHtml(def.category)}">${escHtml(def.label)}</span>`;
  }).join('');
}

function renderDealsPanel(company) {
  const deals = company.deals || [];
  if (!deals.length) return '';
  const badgeClass = { licensing: 'rights', manufacturing: 'mfg', collaboration: 'collab', option: 'option' };
  const items = deals.map(d => {
    const bc = badgeClass[d.type] || 'other';
    const scope = d.scope === 'modality-group' ? d.modalityGroup
                : d.scope === 'specific-asset'  ? (d.assetNames || []).join(', ')
                : d.scope === 'all'             ? 'All assets'
                : 'Company-level';
    return `<div class="deal-item">
      <div class="deal-item-title">${escHtml(d.title || '—')}</div>
      <div class="deal-item-meta">
        <span class="deal-badge deal-badge-${bc}">${escHtml(d.type || 'deal')}</span>
        ${d.date ? `<span>${escHtml(d.date)}</span> · ` : ''}
        ${d.partner ? `<span>${escHtml(d.partner)}</span> · ` : ''}
        <span>Territory: ${escHtml(d.territory || 'unspecified')}</span> ·
        <span>Scope: ${escHtml(scope)}</span>
      </div>
      ${d.summary ? `<div class="deal-item-meta" style="margin-top:2px;color:var(--gray-600)">${escHtml(d.summary)}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="deals-panel" id="deals-panel-${escHtml(company.id)}">
    <div class="deals-panel-title">Cortellis Deals</div>
    ${items}
  </div>`;
}

function renderAssetDetail(company, asset) {
  const layerDefs = [
    { key: 'layer1', name: 'Layer 1 — Oncology Relevance' },
    { key: 'layer2', name: 'Layer 2 — Modality / Biologic' },
    { key: 'layer3', name: 'Layer 3 — Competitive Overlap' },
    { key: 'layer4', name: 'Layer 4 — Rights Retained' },
    { key: 'layer5', name: 'Layer 5 — US Manufacturing' },
  ];

  const seenSources = new Set();
  const layerRows = layerDefs.map(({ key, name }) => {
    const d = asset[key] || {};
    const st = d.status || '—';
    let sourceCell = '—';
    if (d.source) {
      if (seenSources.has(d.source)) {
        sourceCell = '<span class="source-repeat" title="Same source as above">↑ same</span>';
      } else {
        seenSources.add(d.source);
        sourceCell = `<a href="${escHtml(d.source)}" target="_blank" rel="noopener noreferrer">source ↗</a>`;
      }
    }
    return `
      <tr>
        <td class="layer-name">${escHtml(name)}</td>
        <td><span class="status-badge st-${st}">${escHtml(st)}</span></td>
        <td class="layer-reason">${escHtml(d.reason || '—')}</td>
        <td>${sourceCell}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="detail-panel">
      ${company.recallTrack ? `
        <div class="recall-notice">
          <span class="recall-notice-icon">🔄</span>
          <span><strong>Recall track</strong> — result from repository (last screened ${escHtml((company.lastScreenedAt || '').slice(0,10))}, delta ${escHtml(company.deltaScanDate || '—')})</span>
          <span class="recall-delta">${escHtml(company.deltaFindings || 'No material changes found')}</span>
        </div>` : ''}
      <div class="detail-meta">
        ${asset.indication ? `<div><label>Indication:</label> ${escHtml(asset.indication)}</div>` : ''}
        ${asset.phase ? `<div><label>Phase:</label> ${escHtml(asset.phase)}</div>` : ''}
        ${company.website ? `<div><label>Website:</label> <a href="${escHtml(company.website)}" target="_blank" rel="noopener noreferrer">${escHtml(company.website)}</a></div>` : ''}
      </div>
      <table class="layer-table">
        <thead><tr><th>Layer</th><th>Result</th><th>Reason</th><th>Source</th></tr></thead>
        <tbody>${layerRows}</tbody>
      </table>
      ${asset.notes ? `<div class="detail-notes"><strong>Research notes:</strong> ${escHtml(asset.notes)}</div>` : ''}
    </div>
  `;
}

function renderAllExcludedSection() {
  const section = document.getElementById('all-excluded-footer');
  const tbody = document.getElementById('all-excluded-tbody');
  if (!section || !tbody) return;

  const hasQualifyingAsset = c => (c.assets || []).some(a =>
    a.overallStatus !== 'excluded' && !(a.layer3 && a.layer3.status === 'fail')
  );

  const allExcluded = (state.wizardFiltered || []).filter(c => !hasQualifyingAsset(c));

  if (allExcluded.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  tbody.innerHTML = allExcluded.map(c => {
    const reasons = [];
    const l4 = (c.assets || []).filter(a => a.layer4 && a.layer4.status === 'fail');
    const l5 = (c.assets || []).filter(a => a.layer5 && a.layer5.status === 'fail');
    if (l4.length) {
      const uniq = [...new Set(l4.map(a => a.layer4.reason).filter(Boolean))];
      reasons.push('Rights out-licensed (Step 4)' + (uniq.length ? ': ' + uniq[0] : ''));
    }
    if (l5.length) {
      const uniq = [...new Set(l5.map(a => a.layer5.reason).filter(Boolean))];
      reasons.push('US mfg confirmed (Step 5)' + (uniq.length ? ': ' + uniq[0] : ''));
    }
    if (!reasons.length) {
      const any = (c.assets || []).find(a => a.overallStatus === 'excluded');
      reasons.push(any ? (any.excludedReason || 'All assets excluded') : 'All assets excluded');
    }
    return `
      <tr>
        <td><span class="all-excluded-badge" title="All assets excluded">✗</span> <strong>${escHtml(c.name)}</strong></td>
        <td>${(c.assets || []).length}</td>
        <td>${escHtml(reasons.join('; '))}</td>
      </tr>`;
  }).join('');
}

function renderExcludedFooter() {
  const section = document.getElementById('excluded-footer');
  const tbody = document.getElementById('excluded-tbody');
  if (!section || !tbody) return;

  // Screener-excluded companies (deduped)
  const seenIds = new Set();
  const screenerExcluded = (state.categories.excluded || []).filter(c => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  });

  // Qualifying companies the user marked negative in Ask 2
  const userExcluded = (state.categories.qualifying || []).filter(c =>
    state.beoneReviews[c.id] === 'negative' && !seenIds.has(c.id)
  );

  const allItems = screenerExcluded.length + userExcluded.length;
  if (allItems === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  const screenerRows = screenerExcluded.map(c => {
    let sourceLink = '—';
    if (c.excludedSource) {
      sourceLink = `<a href="${escHtml(c.excludedSource)}" target="_blank" rel="noopener noreferrer">Evidence ↗</a>`;
    } else if (c.website) {
      sourceLink = `<a href="${escHtml(c.website)}" target="_blank" rel="noopener noreferrer">${c.type === 'public' ? '10-K ↗' : 'Pipeline ↗'}</a>`;
    }
    return `
      <tr>
        <td>${escHtml(c.name)}</td>
        <td>${escHtml(c.excludedAt || '—')}</td>
        <td>${escHtml(c.excludedReason || '—')}</td>
        <td>${sourceLink}</td>
        <td>${c.screenerLog ? `<button class="btn-console-view" data-id="${escHtml(c.id)}">View</button>` : '—'}</td>
        <td><button class="btn-sources-view" data-co-id="${escHtml(c.id)}">🔗 Sources</button></td>
      </tr>
    `;
  });

  const userRows = userExcluded.map(c => `
    <tr class="user-excluded-row">
      <td>${escHtml(c.name)}</td>
      <td>UI review</td>
      <td>BeOne not interested — noted in session review</td>
      <td>${c.website ? `<a href="${escHtml(c.website)}" target="_blank" rel="noopener noreferrer">${c.type === 'public' ? '10-K ↗' : 'Pipeline ↗'}</a>` : '—'}</td>
      <td>${c.screenerLog ? `<button class="btn-console-view" data-id="${escHtml(c.id)}">View</button>` : '—'}</td>
      <td><button class="btn-sources-view" data-co-id="${escHtml(c.id)}">🔗 Sources</button></td>
    </tr>
  `);

  tbody.innerHTML = [...screenerRows, ...userRows].join('');

  tbody.querySelectorAll('.btn-console-view').forEach(btn => {
    btn.addEventListener('click', () => {
      const company = [...screenerExcluded, ...userExcluded].find(c => c.id === btn.dataset.id);
      if (company) openConsoleModal(company.name, company.screenerLog);
    });
  });

  tbody.querySelectorAll('.btn-sources-view').forEach(btn => {
    btn.addEventListener('click', () => openSourcesModal(btn.dataset.coId));
  });

  // Manufacturing-excluded assets sub-section (step5 / layer4 failures across all companies)
  const mfgExcluded = [];
  for (const co of (state.companies || [])) {
    for (const a of (co.assets || [])) {
      if (a.layer4 && a.layer4.status === 'fail') {
        mfgExcluded.push({ co, a });
      }
    }
  }

  let mfgSection = document.getElementById('mfg-excluded-section');
  if (!mfgSection) {
    mfgSection = document.createElement('div');
    mfgSection.id = 'mfg-excluded-section';
    section.appendChild(mfgSection);
  }

  if (mfgExcluded.length === 0) {
    mfgSection.innerHTML = '';
  } else {
    const mfgRows = mfgExcluded.map(({ co, a }) => {
      const src = a.layer4.source
        ? `<a href="${escHtml(a.layer4.source)}" target="_blank" rel="noopener noreferrer">Evidence ↗</a>`
        : '—';
      return `<tr>
        <td>${escHtml(co.name)}</td>
        <td>${escHtml(a.name || '—')}</td>
        <td>${escHtml(a.modality || '—')}</td>
        <td>${escHtml((a.targets || []).join(', ') || '—')}</td>
        <td>${escHtml(a.layer4.reason || 'US manufacturing confirmed')}</td>
        <td>${src}</td>
      </tr>`;
    }).join('');

    mfgSection.innerHTML = `
      <h4 class="mfg-excluded-heading">Assets excluded at manufacturing (Step 5)</h4>
      <div class="results-table-wrap">
        <table class="results-table">
          <thead><tr>
            <th>Company</th><th>Asset</th><th>Modality</th>
            <th>Target(s)</th><th>Reason</th><th>Source</th>
          </tr></thead>
          <tbody>${mfgRows}</tbody>
        </table>
      </div>`;
  }
}

function openConsoleModal(name, log) {
  const modal = document.getElementById('console-modal');
  document.getElementById('console-modal-title').textContent = `Screening Console — ${name}`;
  document.getElementById('console-modal-log').textContent = log || '(No log available)';
  modal.classList.remove('hidden');
}

function renderInconclusivesFooter() {
  const section = document.getElementById('inconclusives-footer');
  const tbody = document.getElementById('inconclusives-tbody');
  if (!section || !tbody) return;

  const seenIds = new Set();
  const items = (state.categories.inconclusive || []).filter(c => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  });

  if (items.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  tbody.innerHTML = items.map(c => {
    const isPaused = c.status === 'paused';
    let sourceCell = '—';
    if (c.website) {
      sourceCell = `<a href="${escHtml(c.website)}" target="_blank" rel="noopener noreferrer">${c.type === 'public' ? '10-K ↗' : 'Pipeline ↗'}</a>`;
    } else if (state.websiteInputs[c.id]) {
      sourceCell = `<a href="${escHtml(state.websiteInputs[c.id])}" target="_blank" rel="noopener">user input ↗</a>`;
    }
    return `
      <tr${isPaused ? ' class="row-paused"' : ''}>
        <td>${escHtml(c.name)}</td>
        <td>${escHtml(c.inconclusiveReason || '—')}</td>
        <td>${sourceCell}</td>
        <td>${c.screenerLog ? `<button class="btn-console-view" data-id="${escHtml(c.id)}">View</button>` : '—'}</td>
        <td>
          ${isPaused && c.pausedState
            ? `<button class="btn-continue-screen btn-continue-results" data-id="${escHtml(c.id)}">Continue</button>`
            : `<button class="btn-sources-view" data-co-id="${escHtml(c.id)}">🔗 Sources</button>`}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-console-view').forEach(btn => {
    btn.addEventListener('click', () => {
      const company = items.find(c => c.id === btn.dataset.id);
      if (company) openConsoleModal(company.name, company.screenerLog);
    });
  });

  tbody.querySelectorAll('.btn-sources-view').forEach(btn => {
    btn.addEventListener('click', () => openSourcesModal(btn.dataset.coId));
  });

  tbody.querySelectorAll('.btn-continue-results').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = 'Running…';
      btn.disabled = true;
      await continueCompanyScreening(btn.dataset.id);
      renderInconclusivesFooter();
      renderResults();
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Auto-flag — "Flag High Priority Assets" button
// ──────────────────────────────────────────────────────────────

async function runAutoFlag() {
  const btn = document.getElementById('autoflag-btn');
  const statusEl = document.getElementById('autoflag-status');
  const companies = state.wizardFiltered;

  statusEl.classList.remove('hidden');

  if (companies.length === 0) {
    statusEl.textContent = 'No qualifying companies to flag.';
    return;
  }

  btn.disabled = true;
  let done = 0;

  for (const company of companies) {
    statusEl.textContent = `Flagging ${done + 1} of ${companies.length}: ${company.name}…`;
    try {
      const resp = await fetch('/api/autoflag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': getApiKey() },
        body: JSON.stringify({ company }),
      });

      if (resp.ok) {
        const updated = await resp.json();
        (updated.assets || []).forEach((ua, i) => {
          if (company.assets && company.assets[i]) company.assets[i].flags = ua.flags || [];
        });

        // Persist to COMPANY_DATA cache too, same pattern as the manual flag editor
        const inData = (window.COMPANY_DATA || []).find(c => c.id === company.id);
        if (inData) {
          (updated.assets || []).forEach((ua, i) => {
            if (inData.assets && inData.assets[i]) inData.assets[i].flags = ua.flags || [];
          });
        }
      } else {
        console.error(`Auto-flag failed for ${company.name}: server returned ${resp.status}`);
      }
    } catch (err) {
      console.error(`Auto-flag failed for ${company.name}:`, err);
    }
    done++;
    renderResultsTable();
  }

  statusEl.textContent = `Done — flagged ${done} of ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}.`;
  btn.disabled = false;
}

// ──────────────────────────────────────────────────────────────
// Sources modal — all sources for a company (traditional + external)
// ──────────────────────────────────────────────────────────────

function buildSourcesList(company) {
  const seen = new Set();
  const out = [];

  function add(url, label, usedFor, type) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label: label || url, usedFor: usedFor || '—', type: type || 'external' });
  }

  // 1. Top-level sources array populated by Claude (new schema)
  for (const s of (company.sources || [])) {
    if (s && s.url) add(s.url, s.label, s.usedFor, s.type);
  }

  // 2. Company website (backward compat — may not be in sources yet)
  if (company.website) {
    add(company.website,
      company.type === 'public' ? 'Company 10-K / IR page' : 'Company pipeline page',
      'Identification / pre-filter',
      'company-website');
  }

  // 3. Asset-level layer sources (backward compat)
  for (const a of (company.assets || [])) {
    for (const key of ['layer1', 'layer2', 'layer3', 'layer4']) {
      const src = (a[key] || {}).source;
      if (src) add(src, `${a.name || 'Asset'} — ${key}`, `${key} screen`, 'filing');
    }
  }

  // 4. externalSources (legacy purple-flag trail)
  for (const s of (company.externalSources || [])) {
    if (s && s.url) add(s.url, s.title || s.note || s.url, 'External research', 'external');
  }

  return out;
}

const TYPE_LABELS = {
  'filing':         'Filing',
  'company-website':'Website',
  'press-release':  'Press Release',
  'external':       'External',
};

function renderSourcesModalContent(company) {
  const modal = document.getElementById('sources-modal');
  const title = document.getElementById('sources-modal-title');
  const listEl = document.getElementById('sources-modal-list');

  title.textContent = `${company.name} — Sources`;

  const sources = buildSourcesList(company);

  const snapshots = Array.isArray(company.evidenceSnapshots) ? company.evidenceSnapshots : [];

  if (sources.length === 0 && snapshots.length === 0) {
    listEl.innerHTML = '<p class="empty-msg">No sources recorded for this company.</p>';
  } else {
    const sourcesHtml = sources.length === 0 ? '' : `
      <table class="sources-table">
        <thead>
          <tr><th>Type</th><th>Source</th><th>Used For</th></tr>
        </thead>
        <tbody>
          ${sources.map(s => `
            <tr>
              <td><span class="src-type-badge src-type-${escHtml(s.type)}">${escHtml(TYPE_LABELS[s.type] || s.type)}</span></td>
              <td><a href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escHtml(s.label)}</a></td>
              <td class="src-used-for">${escHtml(s.usedFor)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    const snapshotsHtml = snapshots.length === 0 ? '' : `
      <details class="evidence-snapshots-section">
        <summary class="evidence-snapshots-header">Evidence Snapshots (${snapshots.length})</summary>
        ${snapshots.map((snap, idx) => `
          <div class="evidence-snapshot">
            <div class="evidence-snap-meta">
              <span class="evidence-snap-type">${escHtml(snap.type === 'search-result' ? 'Search result' : 'Fetched page')}</span>
              <a class="evidence-snap-url" href="${escHtml(snap.url)}" target="_blank" rel="noopener noreferrer">${escHtml(snap.url)}</a>
              <span class="evidence-snap-ts">${escHtml(snap.retrievedAt || '')}</span>
              ${snap.contentHash ? `<span class="evidence-snap-hash" title="SHA-256 of full content">SHA-256: ${escHtml(snap.contentHash.slice(0, 16))}…</span>` : ''}
            </div>
            ${snap.contentSnippet ? `
              <details class="evidence-snap-content-wrap">
                <summary>Show content preview</summary>
                <pre class="evidence-snap-content">${escHtml(snap.contentSnippet)}</pre>
              </details>
            ` : '<p class="evidence-snap-no-content">No content captured (search result metadata only)</p>'}
          </div>
        `).join('')}
      </details>
    `;

    listEl.innerHTML = sourcesHtml + snapshotsHtml;
  }

  modal.classList.remove('hidden');
  document.getElementById('close-sources-btn').onclick = () => modal.classList.add('hidden');
  document.getElementById('sources-modal-overlay').onclick = () => modal.classList.add('hidden');
}

function openSourcesModal(companyId) {
  // Search across all active-run company arrays (slug IDs)
  const allCompanies = [
    ...(state.categories.qualifying  || []),
    ...(state.categories.excluded    || []),
    ...(state.categories.inconclusive|| []),
  ];
  const company = allCompanies.find(c => c.id === companyId);
  if (company) renderSourcesModalContent(company);
}

function openSourcesModalFromResult(result) {
  // For repository page — result is the parsed result_json object
  if (result) renderSourcesModalContent(result);
}

// ──────────────────────────────────────────────────────────────
// Flag editor modal
// ──────────────────────────────────────────────────────────────

function openFlagModal(companyId, assetIdx) {
  const company = state.wizardFiltered.find(c => c.id === companyId);
  if (!company) return;

  const asset = (company.assets || [])[assetIdx];
  const flagTarget = asset || company;
  const currentFlags = new Set(flagTarget.flags || []);

  const modal = document.getElementById('flag-modal');
  const title = document.getElementById('flag-modal-title');
  const optionsEl = document.getElementById('flag-modal-options');

  title.textContent = asset
    ? `${company.name} — ${asset.name || 'Asset'}`
    : company.name;

  optionsEl.innerHTML = Object.entries(FLAG_DEFS).map(([id, def]) => `
    <label class="flag-option-label">
      <input type="checkbox" value="${escHtml(id)}" ${currentFlags.has(id) ? 'checked' : ''}>
      <span class="flag-badge fc-${def.color}">${escHtml(def.label)}</span>
      <small class="flag-cat">${escHtml(def.category)}</small>
    </label>
  `).join('');

  modal.classList.remove('hidden');

  document.getElementById('save-flags-btn').onclick = () => {
    const selected = Array.from(optionsEl.querySelectorAll('input:checked')).map(cb => cb.value);
    flagTarget.flags = selected;

    // Persist back to COMPANY_DATA if it exists there
    const inData = (window.COMPANY_DATA || []).find(c => c.id === companyId);
    if (inData) {
      if (asset) {
        const inDataAsset = (inData.assets || [])[assetIdx];
        if (inDataAsset) inDataAsset.flags = selected;
      } else {
        inData.flags = selected;
      }
    }

    modal.classList.add('hidden');
    renderResultsTable();
  };

  document.getElementById('cancel-flags-btn').onclick = () => modal.classList.add('hidden');
  document.getElementById('modal-overlay').onclick = () => modal.classList.add('hidden');
}

// ──────────────────────────────────────────────────────────────
// Website Track
// ──────────────────────────────────────────────────────────────

async function runWebsiteTrack(companyId, websiteUrl, btn) {
  const company = state.wizardFiltered.find(c => c.id === companyId);
  if (!company) return;

  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Running…';

  try {
    const resp = await fetch('/api/screen/website-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName: company.name, websiteUrl: websiteUrl || company.website || '' }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const result = await resp.json();

    // Merge supplemental assets into existing company data
    if (result.assets && result.assets.length > 0) {
      company.assets = mergeWebsiteTrackAssets(company.assets || [], result.assets);
    }
    // Carry over any new flags; remove thin-coverage if research was conclusive
    const newFlags = new Set([...(company.flags || []), ...(result.flags || [])]);
    if (!result.thinCoverage) newFlags.delete('thin-coverage');
    company.flags = [...newFlags];

    if (result.screenerLog) company.screenerLog = (company.screenerLog || '') + '\n\n── Website Track ──\n' + result.screenerLog;
    if (result.sources)     company.sources = [...(company.sources || []), ...result.sources];

    renderResultsTable();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = origLabel;
    alert(`Website Track failed: ${err.message}`);
  }
}

function mergeWebsiteTrackAssets(existing, incoming) {
  const merged = [...existing];
  for (const na of incoming) {
    const idx = merged.findIndex(a => a.name && na.name && a.name.toLowerCase() === na.name.toLowerCase());
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...na, sourceTrack: 'website' };
    } else {
      merged.push({ ...na, sourceTrack: 'website' });
    }
  }
  return merged;
}

// ──────────────────────────────────────────────────────────────
// CSV Export
// ──────────────────────────────────────────────────────────────

function exportCSV() {
  const headers = [
    'Company', 'Type', 'Asset', 'Modality', 'Target(s)', 'Indication', 'Phase',
    'L1 Result', 'L2 Result', 'L3 Result', 'L4 Result', 'L5 Result',
    'Flags', 'BeOne Reviewed', 'BeOne Outcome', 'Notes',
  ];

  const rows = [headers];

  for (const c of state.wizardFiltered) {
    const assets = (c.assets || []).filter(a => a.overallStatus !== 'excluded');
    if (assets.length === 0) {
      rows.push([c.name, c.type || '', '', '', '', '', '', '', '', '', '', '', (c.flags || []).map(f => FLAG_DEFS[f]?.label || f).join('; '), c.beoneAnalyzed ? 'Yes' : 'No', c.beoneOutcome || '', c.researchNotes || '']);
      continue;
    }
    for (const a of assets) {
      const allFlags = [...new Set([...(c.flags || []), ...(a.flags || [])])];
      rows.push([
        c.name,
        c.type || '',
        a.name || '',
        a.modality || '',
        (a.targets || []).join(', '),
        a.indication || '',
        a.phase || '',
        a.layer1?.status || '',
        a.layer2?.status || '',
        a.layer3?.status || '',
        a.layer4?.status || '',
        a.layer5?.status || '',
        allFlags.map(f => FLAG_DEFS[f]?.label || f).join('; '),
        c.beoneAnalyzed ? 'Yes' : 'No',
        c.beoneOutcome || '',
        a.notes || c.researchNotes || '',
      ]);
    }
  }

  const csv = rows.map(r =>
    r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `beone-screener-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ──────────────────────────────────────────────────────────────
// Utility
// ──────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ──────────────────────────────────────────────────────────────
// SECTION: History
// ──────────────────────────────────────────────────────────────

function formatRunDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

async function loadHistory() {
  const container = document.getElementById('history-list');
  if (!container) return;
  container.innerHTML = '<p class="empty-msg">Loading…</p>';
  try {
    const resp = await fetch('/api/runs');
    if (!resp.ok) throw new Error('Failed to fetch');
    const runs = await resp.json();
    if (!runs.length) {
      container.innerHTML = '<p class="empty-msg">No screening runs saved yet. Run the screener to start tracking history.</p>';
      return;
    }
    container.innerHTML = runs.map(r => `
      <div class="run-card" data-run-id="${r.id}">
        <div class="run-date">
          ${escHtml(formatRunDate(r.created_at))}
          <div class="run-sub">Run #${r.id}</div>
        </div>
        <div class="run-stats">
          <span class="run-total">${r.actual_count} companies</span>
          <span class="run-badge q">✓ ${r.qualifying} qualifying</span>
          <span class="run-badge e">✗ ${r.excluded} excluded</span>
          <span class="run-badge i">? ${r.inconclusive} inconclusive</span>
          <button class="run-export-btn" data-run-id="${r.id}" title="Download Excel">⬇ Export</button>
        </div>
        <span class="run-arrow">›</span>
      </div>
    `).join('');
    container.querySelectorAll('.run-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.run-export-btn')) return;
        loadRun(parseInt(card.dataset.runId, 10));
      });
    });
    container.querySelectorAll('.run-export-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const runId = btn.dataset.runId;
        btn.textContent = '⏳ Downloading…';
        btn.disabled = true;
        const a = document.createElement('a');
        a.href = `/api/runs/${runId}/export`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => { btn.textContent = '⬇ Export'; btn.disabled = false; }, 2000);
      });
    });
  } catch (_) {
    container.innerHTML = '<p class="empty-msg">Could not load history.</p>';
  }
}

async function loadRun(runId) {
  showSection('section-loading');
  const bar   = document.getElementById('progress-bar-fill');
  const label = document.getElementById('progress-label');
  bar.style.width = '30%';
  label.textContent = 'Loading saved run…';

  try {
    const resp = await fetch(`/api/runs/${runId}`);
    if (!resp.ok) throw new Error('Run not found');
    const { companies } = await resp.json();

    bar.style.width = '80%';
    label.textContent = 'Processing results…';

    for (const company of companies) {
      for (const asset of company.assets || []) {
        asset.layer3 = computeLayer3(asset);
      }
      if (state.beoneReviews[company.id] != null) {
        company.beoneOutcome = state.beoneReviews[company.id];
        company.beoneAnalyzed = true;
      }
    }

    bar.style.width = '100%';
    label.textContent = 'Done';
    setTimeout(() => finishScreening(companies), 300);
  } catch (err) {
    alert('Could not load run: ' + err.message);
    showSection('section-history');
  }
}

async function clearAllData() {
  if (!confirm('Delete ALL run history and company repository data? This cannot be undone.')) return;
  try {
    const resp = await fetch('/api/runs', { method: 'DELETE' });
    if (!resp.ok) throw new Error('Server error');
    return true;
  } catch (e) {
    alert('Could not clear data: ' + e.message);
    return false;
  }
}

function initHistory() {
  document.getElementById('view-history-btn').addEventListener('click', () => {
    showSection('section-history');
    loadHistory();
  });
  document.getElementById('back-from-history-btn').addEventListener('click', () => {
    showSection('section-upload');
  });
  document.getElementById('clear-history-btn').addEventListener('click', async () => {
    if (await clearAllData()) loadHistory();
  });
}

// ──────────────────────────────────────────────────────────────
// SECTION: Company Repository
// ──────────────────────────────────────────────────────────────

let repoData = [];        // full list, cached for filtering
let repoStatusFilter = 'all'; // current status filter

const LAYER_LABELS = {
  'pre-filter': 'Pre-screen',
  layer1: 'Layer 1 — Oncology focus',
  layer2: 'Layer 2 — Modality',
  layer3: 'Layer 3 — Competitive overlap',
  layer4: 'Layer 4 — Rights',
  layer5: 'Layer 5 — US manufacturing',
};

function renderRepoList(companies) {
  const container = document.getElementById('repo-list');
  const countEl   = document.getElementById('repo-count');
  if (!companies.length) {
    container.innerHTML = '<p class="empty-msg">No companies match.</p>';
    countEl.textContent = '0 companies';
    return;
  }
  countEl.textContent = `${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`;

  container.innerHTML = companies.map(c => {
    const cls = c.status === 'qualifying' ? 'is-qualifying'
              : c.status === 'excluded'   ? 'is-excluded'
              : 'is-inconclusive';
    const badgeCls = c.status === 'qualifying' ? 'q'
                   : c.status === 'excluded'   ? 'e' : 'i';
    const badgeLabel = c.status === 'qualifying' ? 'Qualifying'
                     : c.status === 'excluded'   ? 'Excluded' : 'Inconclusive';
    const date = new Date(c.screened_at).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    let detailHtml = '';

    if (c.status === 'excluded') {
      const layerLabel = LAYER_LABELS[c.excluded_at] || (c.excluded_at || '');
      const reason = c.excluded_reason || 'No reason recorded.';
      detailHtml = `
        <div class="repo-excluded-reason">
          ${layerLabel ? `<div class="repo-excluded-layer">${escHtml(layerLabel)}</div>` : ''}
          ${escHtml(reason)}
        </div>`;
    } else if (c.status === 'inconclusive') {
      const reason = c.inconclusive_reason || 'Reason not recorded.';
      detailHtml = `<div class="repo-inconclusive-reason">${escHtml(reason)}</div>`;
    } else if (c.status === 'qualifying') {
      const assets = c.qualifying_assets || [];
      if (assets.length) {
        const assetRows = assets.map(a => {
          const targets = (a.pathway || '').trim();
          return `
            <div class="repo-asset-row">
              <span class="repo-asset-name">${escHtml(a.asset_name || '—')}</span>
              ${a.modality ? `<span class="repo-asset-modality">${escHtml(a.modality)}</span>` : ''}
              ${targets ? `<span class="repo-asset-targets">${escHtml(targets)}</span>` : ''}
            </div>`;
        }).join('');
        detailHtml = `
          <div class="repo-assets">
            <div class="repo-assets-label">Qualifying assets</div>
            ${assetRows}
          </div>`;
      }
    }

    return `
      <div class="repo-company ${cls}">
        <div class="repo-company-header">
          <span class="repo-company-name">${escHtml(c.company_name)}</span>
          <span class="repo-status-badge ${badgeCls}">${badgeLabel}</span>
          <span class="repo-screened-date">${date}</span>
          ${c._result ? `<button class="btn-sources-view repo-sources-btn" data-repo-idx="${c._repoIdx}">🔗 Sources</button>` : ''}
        </div>
        ${detailHtml}
      </div>`;
  }).join('');

  container.querySelectorAll('.repo-sources-btn').forEach(btn => {
    const idx = parseInt(btn.dataset.repoIdx, 10);
    const entry = repoData[idx]; // repoData is the full unfiltered list; idx is stable
    if (entry && entry._result) btn.addEventListener('click', () => openSourcesModalFromResult(entry._result));
  });
}

async function loadRepo() {
  const container = document.getElementById('repo-list');
  const countEl   = document.getElementById('repo-count');
  container.innerHTML = '<p class="empty-msg">Loading…</p>';
  countEl.textContent = '';
  try {
    const resp = await fetch('/api/repository');
    if (!resp.ok) throw new Error('Failed to fetch');
    repoData = await resp.json();
    // Parse result_json and tag each entry with its index for the Sources button
    repoData.forEach((c, i) => {
      c._repoIdx = i;
      try { c._result = c.result_json ? JSON.parse(c.result_json) : null; } catch (_) { c._result = null; }
    });
    renderRepoList(repoData);
  } catch (_) {
    container.innerHTML = '<p class="empty-msg">Could not load repository.</p>';
  }
}

function applyRepoFilters() {
  const q = (document.getElementById('repo-search').value || '').trim().toLowerCase();
  let filtered = repoStatusFilter === 'all'
    ? repoData
    : repoData.filter(c => c.status === repoStatusFilter);
  if (q) filtered = filtered.filter(c => c.company_name.toLowerCase().includes(q));
  renderRepoList(filtered);
}

function initRepo() {
  document.getElementById('view-repo-btn').addEventListener('click', () => {
    showSection('section-repo');
    loadRepo();
  });
  document.getElementById('back-from-repo-btn').addEventListener('click', () => {
    showSection('section-upload');
  });
  document.getElementById('clear-all-data-btn').addEventListener('click', async () => {
    if (await clearAllData()) loadRepo();
  });
  document.getElementById('repo-search').addEventListener('input', applyRepoFilters);

  document.querySelectorAll('.repo-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.repo-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      repoStatusFilter = btn.dataset.filter;
      applyRepoFilters();
    });
  });
}

// ──────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Show logout button if auth is active
  try {
    const authResp = await fetch('/api/auth/check');
    if (authResp.ok) {
      const logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) {
        logoutBtn.hidden = false;
        logoutBtn.addEventListener('click', async () => {
          await fetch('/api/auth/logout', { method: 'POST' });
          window.location.href = '/login.html';
        });
      }
    }
  } catch (_) {}

  // Console modal
  const consoleModal = document.getElementById('console-modal');
  if (consoleModal) {
    document.getElementById('close-console-btn').onclick = () => consoleModal.classList.add('hidden');
    document.getElementById('console-modal-overlay').onclick = () => consoleModal.classList.add('hidden');
  }

  loadPersisted();
  initApiKey();
  initUpload();
  initColumnPicker();
  initSummary();
  initWizard();
  initHistory();
  initRepo();
  showSection('section-upload');
});
