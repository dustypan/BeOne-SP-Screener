'use strict';

// BeOne pipeline — modality + NCI-normalized targets per asset.
// Update modalities/names to match actual pipeline entries.
const BEONE_PIPELINE = [
  { id: 'bp-pd1',     name: 'Anti-PD-1',          modality: 'mAb',      targets: ['PD-1'] },
  { id: 'bp-her2',    name: 'Anti-HER2',           modality: 'bsAb',     targets: ['HER2'] },
  { id: 'bp-egfr',    name: 'EGFR×MET ADC',        modality: 'ADC',      targets: ['EGFR', 'MET', 'MET'] },
  { id: 'bp-fgfr2b',  name: 'Anti-FGFR2b',         modality: 'mAb',      targets: ['FGFR2b'] },
  { id: 'bp-cea',     name: 'CEA TCE',              modality: 'TCE',      targets: ['CD3', 'CEA'] },
  { id: 'bp-adam9',   name: 'ADAM9 ADC',           modality: 'ADC',      targets: ['ADAM9'] },
  { id: 'bp-dll3',    name: 'CD3×DLL3 TCE',         modality: 'TCE',      targets: ['CD3', 'DLL3'] },
  { id: 'bp-cd19',    name: 'CD3×CD19 TCE',         modality: 'TCE',      targets: ['CD3', 'CD19'] },
  { id: 'bp-steap1',  name: 'CD3×STEAP1 TCE',       modality: 'TCE',      targets: ['CD3', 'STEAP1'] },
  { id: 'bp-cldn6',   name: 'CD3×CLDN6 TCE',        modality: 'TCE',      targets: ['CD3', 'CLDN6'] },
  { id: 'bp-gpc3',    name: 'GPC3×4-1BB bsAb',      modality: 'bsAb',     targets: ['GPC3', '4-1BB'] },
  { id: 'bp-klrg1',   name: 'Anti-KLRG1',           modality: 'mAb',      targets: ['KLRG1'] },
];


const FLAG_DEFS = {
  'masked-tce-4-1bb':    { label: 'Masked TCE / 4-1BB TCE',     category: 'Strategic Synergy',  color: 'green'  },
  'adc-novel-payload':   { label: 'ADC Novel Payload',           category: 'Strategic Synergy',  color: 'green'  },
  'checkpoint-io-alt':   { label: 'Checkpoint IO Alternative',   category: 'Strategic Synergy',  color: 'green'  },
  'indication-synergy':  { label: 'Indication Synergy',          category: 'Indication Synergy', color: 'red'    },
  'phase-synergy':       { label: 'Phase Synergy',               category: 'Phase Synergy',      color: 'blue'   },
  'check-mfg-partner':   { label: 'Check Mfg Partner',           category: 'Action Required',    color: 'orange' },
  'thin-coverage':       { label: 'Thin Coverage',               category: 'Data Quality',        color: 'yellow' },
};

const BIG_PHARMA = [
  'AbbVie', 'Amgen', 'AstraZeneca', 'Bayer', 'Bristol-Myers Squibb', 'BMS',
  'Eli Lilly', 'Lilly', 'Genentech', 'Roche', 'GlaxoSmithKline', 'GSK',
  'Johnson & Johnson', 'Janssen', 'Merck', 'MSD', 'Novartis', 'Pfizer',
  'Sanofi', 'Takeda', 'Boehringer Ingelheim', 'Astellas', 'Daiichi Sankyo',
  'Gilead', 'Regeneron', 'Biogen', 'Seagen', 'AbbVie',
];
