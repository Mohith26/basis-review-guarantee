// Seeded synthetic CAS practice: clients, vendors, card/bank transactions, the coding
// agent's account + raw confidence, and the reviewer outcome (was the account changed?).
// Runs in the browser and in Node. Everything is deterministic given the seed.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  const rng = {
    u,
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let x, y, r;
      do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r === 0 || r >= 1);
      const f = Math.sqrt(-2 * Math.log(r) / r);
      spare = y * f;
      return x * f;
    },
    pick(arr) { return arr[Math.floor(u() * arr.length)]; },
    weighted(items, weights) {
      let tot = 0; for (const w of weights) tot += w;
      let r = u() * tot;
      for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
      return items[items.length - 1];
    },
    int(lo, hi) { return lo + Math.floor(u() * (hi - lo + 1)); },
  };
  return rng;
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => Math.log(p / (1 - p));

// Vendor catalogue. amb = how often the right account depends on context the
// descriptor does not carry (Amazon, Venmo, checks), typ = typical amount.
export const VENDORS = [
  { key: 'aws', name: 'AWS', desc: () => 'AWS EMEA aws.amazon.co', acct: 'Software & hosting', amb: 0.02, typ: 900, sd: 0.8, src: 'card' },
  { key: 'gws', name: 'Google Workspace', desc: () => 'GOOGLE *GSUITE_', acct: 'Software & hosting', amb: 0.03, typ: 140, sd: 0.4, src: 'card' },
  { key: 'zoom', name: 'Zoom', desc: () => 'ZOOM.US 888-799-9666', acct: 'Software & hosting', amb: 0.02, typ: 150, sd: 0.3, src: 'card' },
  { key: 'slack', name: 'Slack', desc: () => 'SLACK T04M4TUPN', acct: 'Software & hosting', amb: 0.03, typ: 220, sd: 0.4, src: 'card' },
  { key: 'adobe', name: 'Adobe', desc: () => 'ADOBE *ACROPRO SUBS', acct: 'Software & hosting', amb: 0.05, typ: 60, sd: 0.3, src: 'card' },
  { key: 'delta', name: 'Delta Air Lines', desc: (r) => `DELTA AIR 006${r.int(1000000, 9999999)}`, acct: 'Travel', amb: 0.06, typ: 480, sd: 0.5, src: 'card' },
  { key: 'uber', name: 'Uber', desc: () => 'UBER *TRIP HELP.UBER.COM', acct: 'Travel', amb: 0.10, typ: 34, sd: 0.6, src: 'card' },
  { key: 'ubereats', name: 'Uber Eats', desc: () => 'UBER *EATS PENDING', acct: 'Meals', amb: 0.22, typ: 48, sd: 0.5, src: 'card' },
  { key: 'doordash', name: 'DoorDash', desc: () => 'DOORDASH*SWEETGREEN', acct: 'Meals', amb: 0.18, typ: 62, sd: 0.6, src: 'card' },
  { key: 'staples', name: 'Staples', desc: (r) => `STAPLES 00${r.int(1000, 9999)}`, acct: 'Office supplies', amb: 0.14, typ: 160, sd: 0.7, src: 'card' },
  { key: 'amazon', name: 'Amazon', desc: (r) => `AMZN Mktp US*${r.int(10, 99)}K${r.int(100, 999)}L`, acct: 'Office supplies', alt: ['Equipment', 'Cost of goods sold', 'Repairs & maintenance'], amb: 0.55, typ: 140, sd: 1.0, src: 'card' },
  { key: 'costco', name: 'Costco', desc: (r) => `COSTCO WHSE #0${r.int(100, 999)}`, acct: 'Office supplies', alt: ['Meals', 'Cost of goods sold'], amb: 0.45, typ: 310, sd: 0.8, src: 'card' },
  { key: 'homedepot', name: 'The Home Depot', desc: (r) => `THE HOME DEPOT #${r.int(1000, 6999)}`, acct: 'Repairs & maintenance', alt: ['Materials', 'Equipment'], amb: 0.42, typ: 260, sd: 0.9, src: 'card' },
  { key: 'venmo', name: 'Venmo', desc: (r) => `VENMO *${r.pick(['J RIVERA', 'M CHEN', 'D OKAFOR', 'S PATEL', 'L NGUYEN'])}`, acct: 'Contractors', alt: ['Owner draws', 'Meals'], amb: 0.62, typ: 520, sd: 0.7, src: 'bank' },
  { key: 'zelle', name: 'Zelle', desc: (r) => `ZELLE TO ${r.pick(['RIVERA J', 'BRIGHTLINE CLEAN', 'OKAFOR D', 'MARTINEZ R'])}`, acct: 'Contractors', alt: ['Rent', 'Owner draws'], amb: 0.58, typ: 900, sd: 0.8, src: 'bank' },
  { key: 'check', name: 'Check', desc: (r) => `CHECK #${r.int(1001, 1999)}`, acct: 'Contractors', alt: ['Rent', 'Repairs & maintenance', 'Professional fees'], amb: 0.70, typ: 1400, sd: 0.9, src: 'bank' },
  { key: 'gusto', name: 'Gusto', desc: () => 'GUSTO PAYROLL NET', acct: 'Payroll', amb: 0.02, typ: 4200, sd: 0.4, src: 'bank' },
  { key: 'gustotax', name: 'Gusto taxes', desc: () => 'GUSTO TAX 941', acct: 'Payroll taxes', amb: 0.05, typ: 1300, sd: 0.4, src: 'bank' },
  { key: 'comcast', name: 'Comcast Business', desc: () => 'COMCAST BUSINESS 800-391', acct: 'Utilities & telecom', amb: 0.04, typ: 210, sd: 0.2, src: 'bank' },
  { key: 'verizon', name: 'Verizon', desc: () => 'VZWRLSS*APOCC VISB', acct: 'Utilities & telecom', amb: 0.05, typ: 180, sd: 0.3, src: 'card' },
  { key: 'statefarm', name: 'State Farm', desc: () => 'STATE FARM RO 27 SFPP', acct: 'Insurance', amb: 0.06, typ: 640, sd: 0.3, src: 'bank' },
  { key: 'fbads', name: 'Meta ads', desc: (r) => `FACEBK *${r.int(10, 99)}QW${r.int(100, 999)}`, acct: 'Advertising', amb: 0.05, typ: 380, sd: 0.8, src: 'card' },
  { key: 'gads', name: 'Google Ads', desc: () => 'GOOGLE *ADS2049173', acct: 'Advertising', amb: 0.05, typ: 450, sd: 0.8, src: 'card' },
  { key: 'stripe', name: 'Stripe', desc: () => 'STRIPE TRANSFER ST-P4M', acct: 'Revenue clearing', amb: 0.08, typ: 3100, sd: 0.9, src: 'bank' },
  { key: 'transfer', name: 'Transfer', desc: (r) => `ONLINE TRANSFER TO CHK ...${r.int(1000, 9999)}`, acct: 'Intercompany transfer', alt: ['Owner draws'], amb: 0.35, typ: 2500, sd: 0.9, src: 'bank' },
  { key: 'sysco', name: 'Sysco', desc: () => 'SYSCO CORP ACH', acct: 'Cost of goods sold', amb: 0.04, typ: 2100, sd: 0.6, src: 'bank' },
  { key: 'schein', name: 'Henry Schein', desc: () => 'HENRY SCHEIN INC', acct: 'Clinical supplies', amb: 0.06, typ: 820, sd: 0.7, src: 'card' },
  { key: 'lowes', name: "Lowe's", desc: (r) => `LOWES #0${r.int(1000, 2999)}*`, acct: 'Materials', alt: ['Repairs & maintenance'], amb: 0.30, typ: 340, sd: 0.9, src: 'card' },
  { key: 'rent', name: 'Landlord', desc: () => 'HARBORVIEW PROPERTIES LLC', acct: 'Rent', amb: 0.03, typ: 6200, sd: 0.1, src: 'bank' },
  { key: 'cpa', name: 'Legal & accounting', desc: () => 'CLIO*LAWPAY TRUST', acct: 'Professional fees', amb: 0.15, typ: 900, sd: 0.6, src: 'card' },
];

const IND = {
  dental: ['schein', 'amazon', 'gusto', 'gustotax', 'rent', 'comcast', 'verizon', 'statefarm', 'staples', 'gads', 'check', 'zelle', 'costco', 'adobe'],
  restaurant: ['sysco', 'costco', 'doordash', 'gusto', 'gustotax', 'rent', 'comcast', 'homedepot', 'venmo', 'zelle', 'check', 'fbads', 'statefarm', 'amazon'],
  construction: ['homedepot', 'lowes', 'gusto', 'gustotax', 'check', 'venmo', 'zelle', 'verizon', 'statefarm', 'amazon', 'uber', 'transfer', 'comcast', 'costco'],
  saas: ['aws', 'gws', 'slack', 'zoom', 'adobe', 'gusto', 'gustotax', 'delta', 'uber', 'ubereats', 'amazon', 'fbads', 'gads', 'stripe', 'rent'],
  services: ['gws', 'zoom', 'adobe', 'delta', 'uber', 'ubereats', 'doordash', 'gusto', 'gustotax', 'rent', 'staples', 'cpa', 'amazon', 'verizon', 'check'],
  retail: ['amazon', 'costco', 'stripe', 'gusto', 'gustotax', 'rent', 'fbads', 'gads', 'staples', 'comcast', 'transfer', 'venmo', 'statefarm'],
  nonprofit: ['gws', 'zoom', 'amazon', 'gusto', 'gustotax', 'rent', 'staples', 'check', 'costco', 'fbads', 'delta', 'verizon', 'doordash'],
};

export const CLIENTS = [
  ['Kestrel Dental Group', 'dental', 1240, 5000],
  ['Marlow & Finch Architects', 'services', 520, 7500],
  ['Bluepine Construction', 'construction', 910, 10000],
  ['Oaktree Physical Therapy', 'dental', 430, 4000],
  ['Saltbox Kitchen', 'restaurant', 840, 5000],
  ['Nimbus Analytics', 'saas', 690, 10000],
  ['Rowan Street Bakery', 'restaurant', 610, 2500],
  ['Halcyon Legal', 'services', 380, 7500],
  ['Cedar Ridge Landscaping', 'construction', 540, 5000],
  ['Lumen Health Foundation', 'nonprofit', 350, 5000],
  ['Tidewater Outfitters', 'retail', 720, 5000],
  ['Parcel & Pine', 'retail', 480, 2500],
  ['Fernbrook Pediatrics', 'dental', 520, 5000],
  ['Quarry Hill Brewing', 'restaurant', 650, 5000],
  ['Atlas Field Robotics', 'saas', 580, 10000],
  ['Wren Creative Studio', 'services', 300, 2500],
  ['Ironwood Roofing', 'construction', 470, 7500],
  ['Brightwater Learning', 'nonprofit', 280, 2500],
  ['Copperleaf Home Goods', 'retail', 560, 5000],
  ['Northgate Veterinary', 'dental', 450, 5000],
  ['Signal Hill Software', 'saas', 410, 10000],
  ['Elm & Ash Interiors', 'services', 330, 5000],
  ['Harbor Lane Cafe', 'restaurant', 390, 2500],
  ['Summit Youth Soccer', 'nonprofit', 170, 2500],
].map(([name, ind, vol, mat], i) => ({ id: i, name, ind, vol, mat }));

export const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const MONTH_DAYS = { '2026-04': 30, '2026-05': 31, '2026-06': 30, '2026-07': 31, '2026-08': 31, '2026-09': 30, '2026-10': 31 };

export const DEFAULT_DRIFT = { client: 0, from: '2026-10-09', logitShift: 3.8, label: 'Kestrel Dental Group moved its card program to Amex on Oct 9; card descriptors changed format.' };

// True miscode model (hidden from the agent). Returns logit of P(reviewer changes the account).
function trueLogit(f) {
  return -5.6 + 3.2 * f.amb + 1.5 * (f.hist === 0) + 0.7 * (f.hist > 0 && f.hist < 4) - 1.7 * f.rule + 0.55 * Math.min(f.amtZ, 3) + 0.4 * f.refund;
}

/**
 * Generate a firm's transactions.
 * opts: { seed, months (array), drift (object|null), scale (volume multiplier) }
 * Returns { clients, rows } where rows carry features, agent output and the reviewer outcome.
 */
export function generate(opts = {}) {
  const seed = opts.seed ?? 20261031;
  const months = opts.months ?? MONTHS;
  const drift = opts.drift === undefined ? DEFAULT_DRIFT : opts.drift;
  const scale = opts.scale ?? 1;
  const r = makeRng(seed);
  const vmap = Object.fromEntries(VENDORS.map((v) => [v.key, v]));
  const rows = [];
  // per client: vendor weights, per-vendor rule flag, history counts
  const cstate = CLIENTS.map((c) => {
    const pool = IND[c.ind];
    const w = pool.map(() => 0.3 + r.u() * 1.7);
    const rules = {};
    for (const k of pool) rules[k] = r.u() < (vmap[k].amb < 0.2 ? 0.55 : 0.15) ? 1 : 0;
    // client-specific usual account for ambiguous vendors (some clients use the alt as default)
    const usual = {};
    for (const k of pool) { const v = vmap[k]; usual[k] = v.alt && r.u() < 0.3 ? r.pick(v.alt) : v.acct; }
    // long-tail one-off vendors appear too
    return { pool, w, rules, usual, hist: {} };
  });
  let id = 0;
  for (const m of months) {
    const days = MONTH_DAYS[m] ?? 30;
    for (const c of CLIENTS) {
      const st = cstate[c.id];
      const n = Math.round(c.vol * scale * (0.9 + 0.2 * r.u()));
      const batch = [];
      for (let i = 0; i < n; i++) {
        const day = 1 + Math.floor(r.u() * days);
        const date = `${m}-${String(day).padStart(2, '0')}`;
        const oneOff = r.u() < 0.07; // a vendor this client has never used
        const k = oneOff ? r.pick(VENDORS).key : r.weighted(st.pool, st.w);
        const v = vmap[k];
        const refund = r.u() < 0.025 ? 1 : 0;
        let amount = Math.exp(Math.log(v.typ) + v.sd * r.normal());
        if (amount >= c.mat * 0.9 && r.u() < 0.5) amount *= 0.4; // keep most below materiality
        amount = Math.round(amount * 100) / 100 * (refund ? -1 : 1);
        batch.push({ day, date, k, v, oneOff, refund, amount });
      }
      batch.sort((a, b) => a.day - b.day);
      for (const t of batch) {
        const v = t.v;
        const hkey = t.oneOff ? `${t.k}#${t.amount}` : t.k;
        const hist = st.hist[hkey] ?? 0;
        const amtZ = Math.abs(Math.log(Math.abs(t.amount)) - Math.log(v.typ)) / v.sd;
        const f = { amb: v.amb, hist: Math.min(hist, 50), rule: t.oneOff ? 0 : st.rules[t.k] ?? 0, amtZ, refund: t.refund };
        const base = trueLogit(f);
        const drifted = drift && c.id === drift.client && t.date >= drift.from && v.src === 'card';
        const pErr = sigmoid(base + (drifted ? drift.logitShift : 0));
        // Agent confidence: overconfident, noisy view of the pre-drift error probability.
        // The agent sees the descriptor and amount well, but only weakly knows how often this
        // client has used the vendor and ignores the firm's coding rules.
        const agentView = -5.6 + 3.2 * f.amb + 0.55 * Math.min(f.amtZ, 3) + 0.4 * f.refund + 0.45 * (f.hist === 0);
        const conf = sigmoid(1.2 * -agentView + 0.8 + 0.55 * r.normal());
        const miscoded = r.u() < pErr ? 1 : 0;
        const correct = t.oneOff ? v.acct : st.usual[t.k];
        let coded = correct;
        if (miscoded) {
          const opts2 = [v.acct, ...(v.alt ?? []), 'Office supplies', 'Meals', 'Contractors', 'Equipment'].filter((a) => a !== correct);
          coded = r.pick(opts2);
        }
        rows.push({
          id: id++, client: c.id, month: m, date: t.date, vendor: v.name, desc: drifted ? `AMEX *${v.desc(r).replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)}` : v.desc(r),
          src: v.src, amount: t.amount, coded, correct, conf, miscoded, pErr,
          f, drifted: drifted ? 1 : 0, aboveMat: Math.abs(t.amount) >= c.mat ? 1 : 0,
        });
        st.hist[hkey] = hist + 1;
      }
    }
  }
  return { clients: CLIENTS, rows };
}
