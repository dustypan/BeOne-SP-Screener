'use strict';

// COMPANY_DATA — populated by screening sessions (Claude + manual research).
// Each object = one company with all layer results and asset details.
//
// Schema per company:
//   id              string   — URL-safe slug
//   name            string   — display name (matches Excel)
//   type            string   — 'public' | 'private'
//   website         string   — company website URL
//   status          string   — 'qualifying' | 'excluded' | 'inconclusive'
//   excludedAt      string   — null | 'pre-filter' | 'layer1' | 'layer2' | 'layer3' | 'layer4'
//   excludedReason  string   — plain-language reason
//   inconclusiveReason string — e.g. 'Website Input Needed'
//   assets          array    — see asset schema below
//   beoneAnalyzed   bool
//   beoneOutcome    string   — null | 'positive' | 'negative'
//   flags           array    — company-level flags (see FLAG_DEFS in enums.js)
//   researchNotes   string
//
// Schema per asset:
//   name        string
//   modality    string   — 'mAb' | 'bsAb' | 'tsAb' | 'ADC' | 'TCE' | 'NKCE' | 'Fc-fusion'
//   targets     array    — NCI-normalized target names
//   indication  string
//   phase       string
//   isPlatform  bool     — true = platform-level record, Layer 5 not applicable
//   layer1      { status, reason, source }
//   layer2      { status, reason, source }
//   layer3      { status, reason, source }
//   layer4      { status, reason, source }
//   layer5      { status, reason }   — auto-computed at runtime
//   overallStatus string — 'qualifying' | 'excluded'
//   notes       string
//   sources     array
//   flags       array    — asset-level flags

window.COMPANY_DATA = [
  // Add screened companies here after each research session.
  // Example (uncomment and fill in real data):
  //
  // {
  //   id: 'example-bio',
  //   name: 'Example Biotherapeutics',
  //   type: 'private',
  //   website: 'https://www.examplebio.com',
  //   status: 'qualifying',
  //   excludedAt: null,
  //   excludedReason: '',
  //   inconclusiveReason: '',
  //   assets: [
  //     {
  //       name: 'EXB-001',
  //       modality: 'ADC',
  //       targets: ['HER3'],
  //       indication: 'NSCLC',
  //       phase: 'Phase 1',
  //       isPlatform: false,
  //       layer1: { status: 'pass', reason: 'NSCLC indication confirmed', source: 'https://www.examplebio.com/pipeline' },
  //       layer2: { status: 'pass', reason: 'ADC (CHO-expressed)', source: '' },
  //       layer3: { status: 'pass', reason: 'No out-licensing disclosed', source: '' },
  //       layer4: { status: 'pass', reason: 'No US CDMO or facility found in press releases', source: '' },
  //       overallStatus: 'qualifying',
  //       notes: 'Promising HER3 ADC; no US manufacturing disclosed as of 2025-06.',
  //       sources: ['https://www.examplebio.com/pipeline'],
  //       flags: [],
  //     }
  //   ],
  //   beoneAnalyzed: false,
  //   beoneOutcome: null,
  //   flags: [],
  //   researchNotes: '',
  // },
];
