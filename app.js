import { generate, DEFAULT_DRIFT } from './core/sim.js';
import { runPipeline, FEATURE_NAMES } from './core/guarantee.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const money = (x) => Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => 'Oct ' + Number(d.slice(8));
const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}"></i>`;
const SECONDS_PER_LINE = 20; // assumption shown in the UI
const CHECK = '<svg class="fchk" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#15803d"/><path d="M6 10.3l2.6 2.5L14.2 7.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const data = generate({});
const clients = data.clients;
let validity = null;
let P = null;
let model = null;
let monFeed = null;
const state = { alpha: 0.01, delta: 0.05, auditRate: 0.1 };

function compute() {
  P = runPipeline(data, { ...state, model });
  model = P.model;
}

function setWorking(busy) {
  const w = $('working');
  if (busy) { w.classList.remove('done'); w.innerHTML = '<span class="spin"></span><span>Certifying…</span>'; }
  else {
    w.classList.add('done');
    w.innerHTML = P.lttRisk.certified >= 0 ? `${icon('circle-check-big', 'ok')}<span>Certified</span>` : `${icon('circle-alert', 'ok')}<span>Not certified</span>`;
  }
}

// ---------- derived numbers (all from P) ----------
function derive() {
  const live = P.live;
  const skip = live.filter((r) => r.finalTier === 'auto' && !r.audit);
  const reviewed = live.length - skip.length;
  const step = P.lttRisk.certified >= 0 ? P.lttRisk.steps[P.lttRisk.certified] : null;
  const alarms = P.monitor.filter((m) => m.alarmDate);
  const confCut = P.lttConf.cut;
  const confAuto = live.filter((r) => !r.aboveMat && 1 - r.conf <= confCut);
  return { live, skip, reviewed, step, alarms, confAuto };
}

// ---------- policy tab ----------
function renderPolicy(D) {
  const st = P.stats;
  const step = D.step;
  $('certBadge').innerHTML = step
    ? `<div class="cert"><span class="ic">${icon('shield-check')}</span><div><b>Certified at ≤ ${pct(P.alpha)} miscoded</b><span>${step.j + 1} of ${P.gridRisk.length} cutoffs passed · p = ${step.pval.toFixed(3)}</span></div></div>`
    : `<div class="cert"><span class="ic bad">${icon('shield-x')}</span><div><b>Cannot certify ${pct(P.alpha)}</b><span>Not enough evidence; every line goes to review</span></div></div>`;

  const autoShare = st.auto.n / st.live;
  const backHeld = P.live.filter((r) => r.finalTier === 'requeued' || r.finalTier === 'paused').length;
  const auditOnly = P.live.filter((r) => r.finalTier === 'auto' && r.audit).length;
  const hoursSaved = (D.skip.length * SECONDS_PER_LINE) / 3600;
  const feedsPaused = D.alarms.length;
  $('kpis').innerHTML = `
    <div class="kpi"><div class="kl">${icon('send')}Posts without line-by-line review</div>
      <div class="kv">${fmt(D.skip.length)}<small>of ${fmt(st.live)}</small></div>
      <div class="ks">Cutoff covers <b>${fmt(st.auto.n)}</b> (${pct(autoShare)}); ${fmt(auditOnly)} audited, ${fmt(backHeld)} sent back or held</div>
      <div class="bar"><i style="width:${(D.skip.length / st.live) * 100}%;background:var(--ink)"></i><i style="width:${(auditOnly / st.live) * 100}%;background:var(--accent)"></i><i style="width:${(backHeld / st.live) * 100}%;background:var(--danger)"></i></div></div>
    <div class="kpi"><div class="kl">${icon('shield-check')}Certified miscode rate</div>
      <div class="kv">≤ ${pct(P.alpha)}<small>at ${pct(1 - P.delta, 0)} confidence</small></div>
      <div class="ks">${step ? `Jul – Sep at this cutoff: <b>${fmt(step.k)}</b> of ${fmt(step.n)} changed by reviewers (${pct(step.rate, 2)})` : 'No cutoff passed the test at this target'}</div></div>
    <div class="kpi"><div class="kl">${icon('list-checks')}Still reviewed line by line</div>
      <div class="kv">${fmt(D.reviewed)}<small>lines</small></div>
      <div class="ks">${fmt(st.review.n)} flagged, ${fmt(st.material.n)} above materiality, ${fmt(auditOnly + backHeld)} audited, sent back or held. <b>≈ ${hoursSaved.toFixed(0)} h</b> saved at ${SECONDS_PER_LINE} s a line (assumed)</div></div>
    <div class="kpi"><div class="kl">${icon('scan-search')}Audit sample</div>
      <div class="kv">${fmt(st.audited.k)}<small>of ${fmt(st.audited.n)} changed</small></div>
      <div class="ks">${P.monitor.length} feeds watched daily · <b style="color:${feedsPaused ? 'var(--danger)' : 'var(--done)'}">${feedsPaused ? `${feedsPaused} paused` : 'none paused'}</b></div></div>`;

  drawCurve();
  renderTxList(D);
  renderAlert(D);
  renderCompare(D);
  $('navTx').textContent = fmt(st.live);
}

function drawCurve() {
  const el = $('curve');
  const W = el.clientWidth || 640, H = el.clientHeight || 268;
  const m = { l: 44, r: 12, t: 10, b: 30 };
  const calN = P.cal.length;
  const pts = (steps) => steps.filter((s) => s.n > 0).map((s) => ({ x: s.n / calN, y: s.rate, s }));
  const R = pts(P.lttRisk.steps), C = pts(P.lttConf.steps);
  const ymax = Math.max(0.025, P.alpha * 2.2);
  const X = (x) => m.l + ((x - 0) / 1) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - Math.min(y, ymax) / ymax) * (H - m.t - m.b);
  let g = '';
  for (let i = 0; i <= 5; i++) { const y = (ymax * i) / 5; g += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}"/><text x="${m.l - 8}" y="${Y(y) + 4}" text-anchor="end">${(y * 100).toFixed(1)}%</text>`; }
  for (let i = 0; i <= 5; i++) { const x = i / 5; g += `<text x="${X(x)}" y="${H - 8}" text-anchor="middle">${i * 20}%</text>`; }
  const line = (arr, col, w) => `<path d="${arr.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round"/>`;
  const band = R.length ? `<path d="${R.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.s.ucb).toFixed(1)}`).join('')}${[...R].reverse().map((p) => `L${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('')}Z" fill="#0f0d0b" opacity="0.06"/>` : '';
  const aY = Y(P.alpha);
  let marks = '';
  const cr = P.lttRisk.certified >= 0 ? P.lttRisk.steps[P.lttRisk.certified] : null;
  const cc = P.lttConf.certified >= 0 ? P.lttConf.steps[P.lttConf.certified] : null;
  if (cc) marks += `<circle cx="${X(cc.n / calN)}" cy="${Y(cc.rate)}" r="4.5" fill="#fff" stroke="var(--mud)" stroke-width="2"/>`;
  if (cr) {
    const x = X(cr.n / calN), y = Y(cr.rate);
    marks += `<line x1="${x}" x2="${x}" y1="${y}" y2="${H - m.b}" stroke="var(--ink)" stroke-dasharray="2 3"/><circle cx="${x}" cy="${y}" r="5" fill="var(--ink)"/>`;
    marks += `<g transform="translate(${x - 162},${Math.max(m.t + 4, y - 96)})"><rect width="150" height="40" rx="8" fill="#fff" stroke="var(--hair)"/><text x="10" y="16" style="fill:var(--ink);font-weight:600;font-size:12px">Certified: ${pct(cr.n / calN, 0)} posted</text><text x="10" y="31">Jul – Sep rate ${pct(cr.rate, 2)}</text></g>`;
  }
  const hit = [...R.map((p) => ({ ...p, who: 'Basis risk score' })), ...C.map((p) => ({ ...p, who: 'Agent confidence' }))]
    .map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5" fill="transparent" data-tip="${p.who}: post ${pct(p.x, 0)} of history → ${pct(p.y, 2)} miscoded (${p.s.k}/${fmt(p.s.n)}); p = ${p.s.pval < 0.001 ? '<0.001' : p.s.pval.toFixed(3)}${p.s.rejected ? ', passes' : ', stops here'}"/>`).join('');
 const shareOf = (st) => (st ? st.n / calN : 0);
  const stc = P.stats.staticAuto;
  $('curveStats').innerHTML = `<div><div class="l">Certified to post</div><div class="v">${pct(shareOf(cr), 0)}<small>vs ${pct(shareOf(cc), 0)} on confidence</small></div></div>
    <div><div class="l">Ranking quality (AUC)</div><div class="v">${P.aucRisk.toFixed(2)}<small>vs ${P.aucConf.toFixed(2)}</small></div></div>
    <div><div class="l">99% confidence cutoff, Oct</div><div class="v" style="color:${stc.rate > P.alpha ? 'var(--danger)' : 'var(--ink)'}">${pct(stc.rate, 1)}<small>miscoded</small></div></div>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}${band}<line x1="${m.l}" x2="${W - m.r}" y1="${aY}" y2="${aY}" stroke="var(--danger)" stroke-dasharray="4 3"/><text x="${m.l + 6}" y="${aY - 6}" style="fill:var(--danger)">Target ${pct(P.alpha)}</text>${line(C, 'var(--clay)', 2)}${line(R, 'var(--ink)', 2)}${marks}<text x="${m.l}" y="${H - 8}" text-anchor="start" dx="-6" style="opacity:0">.</text>${hit}</svg>`;
  bindTips(el);
}

function pickRows() {
  const live = P.live;
  const nameOf = (r) => clients[r.client].name;
  const used = new Set();
  const first = (pred) => { const r = live.find((x) => !used.has(x.vendor) && pred(x)); if (r) used.add(r.vendor); return r; };
  const rows = [
    first((r) => r.vendor === 'AWS' && r.finalTier === 'auto' && !r.audit),
    first((r) => r.vendor === 'Delta Air Lines' && r.finalTier === 'auto' && !r.audit),
    first((r) => r.audit && !r.miscoded && r.finalTier === 'auto'),
    first((r) => r.client === 0 && r.drifted && r.miscoded && (r.finalTier === 'requeued' || r.finalTier === 'paused')),
    first((r) => r.vendor === 'Venmo' && r.tier === 'review'),
    first((r) => r.tier === 'material' && r.vendor === 'Landlord'),
    first((r) => r.vendor === 'Zoom' && r.finalTier === 'auto' && !r.audit),
  ].filter(Boolean);
  return rows.map((r) => ({ r, client: nameOf(r) }));
}

function statusOf(r) {
  if (r.finalTier === 'requeued' || r.finalTier === 'paused') return `<span class="st back">${icon('undo-2')}Sent back</span>`;
  if (r.tier === 'material') return `<span class="chip">Above materiality</span>`;
  if (r.tier === 'review') return `<span class="chip warn">Needs review</span>`;
  if (r.audit) return `<span class="acct">${r.coded}</span><span class="chip acc">Audit</span>`;
  return `<span class="acct">${r.coded}</span>`;
}

function renderTxList(D) {
  const rows = pickRows();
  $('txSummary').innerHTML = `${CHECK}${fmt(D.skip.length)} of ${fmt(P.stats.live)} posted`;
  $('txList').innerHTML = rows.map(({ r, client }) => `
    <div class="tx" data-tip="${client} · ${r.desc} · risk score ${(r.risk * 100).toFixed(2)}% · agent confidence ${(r.conf * 100).toFixed(1)}%">
      <div class="v">${r.vendor === 'Landlord' ? 'Harborview' : r.vendor}<small>${day(r.date)} · ${client}</small></div>
      <div class="a">${r.amount < 0 ? '−' : ''}${money(r.amount)}</div>
      <div class="s">${statusOf(r)}</div>
    </div>`).join('');
  bindTips($('txList'));
}

function renderAlert(D) {
  const el = $('alertCard');
  const a = D.alarms.sort((x, y) => (x.alarmDate < y.alarmDate ? -1 : 1))[0];
  if (!a) { el.style.display = 'none'; return; }
  el.style.display = '';
  const back = P.live.filter((r) => r.client === a.client && r.src === a.src && r.finalTier === 'requeued');
  const held = P.live.filter((r) => r.client === a.client && r.src === a.src && r.finalTier === 'paused');
  const at = a.series.find((s) => s.date === a.alarmDate);
  el.innerHTML = `<span class="aic">${icon('octagon-pause')}</span><div><b>${clients[a.client].name} · ${a.src} feed paused ${day(a.alarmDate)}</b><p>Audit found ${at.s} of ${at.t} changed. ${fmt(back.length)} posted transactions went back to review and ${fmt(held.length)} later ones were held${D.alarms.length > 1 ? `; ${D.alarms.length - 1} more feed${D.alarms.length > 2 ? 's' : ''} paused` : ''}.</p></div><span class="go">${icon('chevron-right')}</span>`;
  el.onclick = () => { monFeed = a; showTab('monitor'); };
}

function renderCompare(D) {
  const live = P.live;
  const errs = (arr) => arr.reduce((s, r) => s + r.miscoded, 0);
  const certNoMon = live.filter((r) => r.tier === 'auto');
  const stat = live.filter((r) => r.confTier === 'auto');
  const rowsDef = [
    { name: 'Certified cutoff + feed monitoring', note: 'This policy', arr: D.skip, g: 'ok', gt: `≤ ${pct(P.alpha)} at ${pct(1 - P.delta, 0)}`, hl: true },
    { name: 'Certified cutoff, no monitoring', note: 'Kestrel drift goes unnoticed', arr: certNoMon, g: 'warn', gt: 'Broken by drift' },
    { name: 'Certified, agent confidence alone', note: 'Same test, weaker score', arr: D.confAuto, g: P.lttConf.certified >= 0 ? 'ok' : 'bad', gt: P.lttConf.certified >= 0 ? `≤ ${pct(P.alpha)}, fewer posted` : 'Cannot certify' },
    { name: 'Hand-set 99% confidence cutoff', note: 'Typical static threshold', arr: stat, g: 'bad', gt: 'None' },
  ];
  $('cmpTable').innerHTML = `<thead><tr><th>Policy</th><th class="n">Posted unreviewed</th><th class="n">Share of October</th><th class="n">Miscoded among them</th><th class="n">Rate</th><th>Guarantee</th></tr></thead><tbody>${rowsDef.map((d) => {
    const k = errs(d.arr), n = d.arr.length;
    return `<tr class="${d.hl ? 'hl' : ''}"><td class="strong">${d.name}<div class="sm">${d.note}</div></td><td class="n">${fmt(n)}</td><td class="n">${pct(n / live.length)}</td><td class="n">${fmt(k)}</td><td class="n"><span style="color:${n && k / n > P.alpha ? 'var(--danger)' : 'var(--ink2)'}">${n ? pct(k / n, 2) : '–'}</span></td><td><span class="pill ${d.g}">${icon(d.g === 'ok' ? 'shield-check' : d.g === 'warn' ? 'triangle-alert' : 'shield-off')}${d.gt}</span></td></tr>`;
  }).join('')}</tbody>`;
}

// ---------- feeds tab ----------
function renderFeeds() {
  const live = P.live;
  const rows = P.monitor.map((m) => {
    const lr = live.filter((r) => r.client === m.client && r.src === m.src);
    const auto = lr.filter((r) => r.tier === 'auto').length;
    const last = m.series[m.series.length - 1];
    return { m, n: lr.length, auto, share: lr.length ? auto / lr.length : 0, last };
  }).sort((a, b) => (!!b.m.alarmDate - !!a.m.alarmDate) || b.n - a.n);
  $('feedTable').innerHTML = `<thead><tr><th>Client</th><th>Feed</th><th class="n">October</th><th>Posted without review</th><th class="n">Audited</th><th class="n">Changed</th><th class="n">Upper bound (anytime)</th><th>Status</th></tr></thead><tbody>${rows.map(({ m, n, auto, share, last }) => `
    <tr data-c="${m.client}" data-s="${m.src}"><td class="strong">${clients[m.client].name}</td><td>${m.src === 'card' ? (m.client === 0 && m.alarmDate ? 'Amex card' : 'Card') : 'Bank'}</td><td class="n">${fmt(n)}</td>
    <td><span class="mini"><i style="width:${share * 100}%"></i></span>${pct(share, 0)}</td><td class="n">${fmt(last.t)}</td><td class="n">${fmt(last.s)}</td><td class="n">${last.t ? pct(last.hi, 1) : '–'}</td>
    <td>${m.alarmDate ? `<span class="pill bad">${icon('octagon-pause')}Paused ${day(m.alarmDate)}</span>` : last.t < 15 ? `<span class="pill">${icon('clock')}Collecting</span>` : `<span class="pill ok">${icon('circle-check-big')}Within target</span>`}</td></tr>`).join('')}</tbody>`;
  $('feedTable').querySelectorAll('tr[data-c]').forEach((tr) => tr.onclick = () => { monFeed = P.monitor.find((m) => m.client === +tr.dataset.c && m.src === tr.dataset.s); showTab('monitor'); });
  $('feedAlarmCount').textContent = P.monitor.filter((m) => m.alarmDate).length || '';
  // sidebar clients
  const byClient = clients.map((c) => {
    const lr = live.filter((r) => r.client === c.id);
    const alarm = P.monitor.some((m) => m.client === c.id && m.alarmDate);
    return { c, alarm, share: lr.filter((r) => r.finalTier === 'auto').length / lr.length, n: lr.length };
  }).sort((a, b) => (b.alarm - a.alarm) || b.n - a.n);
  $('navClients').textContent = clients.length;
  $('clientNav').innerHTML = byClient.slice(0, 9).map((x) => `<a><span class="cdot ${x.alarm ? 'warn' : ''}"></span><span class="cname">${x.c.name}</span><span class="cpct">${pct(x.share, 0)}</span></a>`).join('') + `<a style="color:var(--muted)">${icon('ellipsis')}${clients.length - 9} more</a>`;
}

// ---------- monitor tab ----------
function seriesChart(el, series, opts = {}) {
  const W = el.clientWidth || 700, H = el.clientHeight || 268;
  const m = { l: 44, r: 14, t: 14, b: 28 };
  const ymax = opts.ymax ?? 0.4;
  const n = series.length;
  const X = (i) => m.l + (i / (n - 1)) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - Math.min(y, ymax) / ymax) * (H - m.t - m.b);
  let g = '';
  for (let i = 0; i <= 5; i++) { const y = (ymax * i) / 5; g += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}"/><text x="${m.l - 8}" y="${Y(y) + 4}" text-anchor="end">${(y * 100).toFixed(0)}%</text>`; }
  series.forEach((s, i) => { if (i % 5 === 0 || i === n - 1) g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${day(s.date)}</text>`; });
  const valid = series.map((s, i) => ({ s, i })).filter((p) => p.s.t > 0);
  const band = valid.length ? `<path d="${valid.map((p, k) => `${k ? 'L' : 'M'}${X(p.i)},${Y(p.s.hi)}`).join('')}${[...valid].reverse().map((p) => `L${X(p.i)},${Y(p.s.lo)}`).join('')}Z" fill="#41666f" opacity="0.16"/>` : '';
  const est = valid.length ? `<path d="${valid.map((p, k) => `${k ? 'L' : 'M'}${X(p.i)},${Y(p.s.s / p.s.t)}`).join('')}" fill="none" stroke="var(--ink)" stroke-width="2"/>` : '';
  const aY = Y(P.alpha);
  let ann = '';
  if (opts.event) { const i = series.findIndex((s) => s.date >= opts.event.date); if (i >= 0) ann += `<line x1="${X(i)}" x2="${X(i)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--clay)" stroke-dasharray="3 3"/><text x="${X(i) + 6}" y="${m.t + 10}" style="fill:var(--graphite)">${opts.event.label}</text>`; }
  if (opts.alarm) { const i = series.findIndex((s) => s.date === opts.alarm); const s = series[i]; ann += `<line x1="${X(i)}" x2="${X(i)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--danger)"/><circle cx="${X(i)}" cy="${Y(s.s / s.t)}" r="5" fill="var(--danger)"/><text x="${X(i) + 6}" y="${m.t + 26}" style="fill:var(--danger);font-weight:600">Paused ${day(opts.alarm)}</text>`; }
  const hit = series.map((s, i) => `<rect x="${X(i) - (W - m.l - m.r) / (2 * (n - 1))}" y="${m.t}" width="${(W - m.l - m.r) / (n - 1)}" height="${H - m.t - m.b}" fill="transparent" data-tip="${day(s.date)}: ${s.s} of ${s.t} audited changed · anytime range ${s.t ? `${pct(s.lo, 1)} – ${pct(s.hi, 1)}` : '–'} · evidence vs ${pct(P.alpha)}: ×${Math.exp(s.llr).toFixed(s.llr > 4 ? 0 : 2)}"/>`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}${band}<line x1="${m.l}" x2="${W - m.r}" y1="${aY}" y2="${aY}" stroke="var(--danger)" stroke-dasharray="4 3"/>${est}${ann}${hit}</svg>`;
  bindTips(el);
}

function renderMonitor() {
  const f = monFeed ?? P.monitor.find((m) => m.alarmDate) ?? P.monitor[0];
  const c = clients[f.client];
  $('monTitle').textContent = `${c.name} · ${f.src === 'card' ? 'card' : 'bank'} feed`;
  $('monSub').textContent = `Audit sample of transactions posted without review. Share changed by reviewers, with a range that stays valid however often it is checked.`;
  const isDrift = f.client === DEFAULT_DRIFT.client && f.src === 'card';
  seriesChart($('monChart'), f.series, { ymax: 0.5, alarm: f.alarmDate, event: isDrift ? { date: DEFAULT_DRIFT.from, label: 'Card program moved to Amex' } : null });
  const live = P.live.filter((r) => r.client === f.client && r.src === f.src);
  const posted = live.filter((r) => r.tier === 'auto');
  const back = live.filter((r) => r.finalTier === 'requeued');
  const held = live.filter((r) => r.finalTier === 'paused');
  const firstErr = f.series.find((s) => s.s > 0);
  const at = f.alarmDate ? f.series.find((s) => s.date === f.alarmDate) : null;
  const ev = [];
  ev.push(['Oct 1', `Certified cutoff applied. <b>${fmt(posted.length)}</b> of ${fmt(live.length)} ${f.src} transactions for ${c.name} qualify to post this month; ${pct(P.auditRate, 0)} of them are audited at random.`]);
  if (isDrift) ev.push([day(DEFAULT_DRIFT.from), `${c.name} moves its cards to Amex. Descriptors now read like <b>${(live.find((r) => r.drifted && r.vendor === 'Henry Schein') || live.find((r) => r.drifted) || {}).desc ?? 'AMEX *…'}</b>; the agent's confidence does not drop.`]);
  if (firstErr) ev.push([day(firstErr.date), `First audited transaction with a changed account (${firstErr.s} of ${firstErr.t}).`]);
  if (at) {
    ev.push([day(f.alarmDate), `<b>Paused.</b> ${at.s} of ${at.t} audited changed; evidence against "≤ ${pct(P.alpha)}" reached ×${Math.exp(at.llr).toFixed(0)}, past the ×${(1 / P.deltaMon).toFixed(0)} line. New ${f.src} transactions go to review.`]);
    ev.push([day(f.alarmDate), `<b>${fmt(back.length)}</b> already-posted transactions go back to review and <b>${fmt(held.length)}</b> later ones are held. Reviewers would change <b>${fmt([...back, ...held].reduce((s, r) => s + r.miscoded, 0))}</b> of the ${fmt(back.length + held.length)} (simulation truth).`]);
  } else {
    const last = f.series[f.series.length - 1];
    ev.push(['Oct 31', `No alarm. ${last.s} of ${last.t} audited changed; the anytime range ends at ${pct(last.lo, 1)} – ${pct(last.hi, 1)}.`]);
  }
  const others = P.monitor.filter((m) => m !== f && m.alarmDate).length;
  ev.push(['Firm', `${others ? `${others} other feed${others > 1 ? 's' : ''} also paused.` : `The other ${P.monitor.length - 1} feeds stayed within target.`}`]);
  $('monStory').innerHTML = ev.map(([d, t]) => `<div class="ev"><span class="d">${d}</span><span>${t}</span></div>`).join('');
  seriesChart($('firmChart'), P.firmSeries, { ymax: 0.05, alarm: P.firmAlarmDate });
  const fa = P.firmAlarmDate, ka = (P.monitor.find((m) => m.alarmDate) || {}).alarmDate;
  $('firmSub').textContent = `Pooled audit sample across every client. ${fa ? `The pooled monitor alarms on ${day(fa)}${ka ? `, ${Math.round((new Date(fa) - new Date(ka)) / 864e5)} days after the Kestrel card feed` : ''}, and would pause every client at once.` : `The pooled monitor never alarms in October${ka ? ': the Kestrel change is diluted by 47 healthy feeds' : ''}.`}`;
}

// ---------- method tab ----------
function renderMethod() {
  const el = $('relChart');
  const W = el.clientWidth || 380, H = el.clientHeight || 268;
  const m = { l: 40, r: 10, t: 12, b: 42 };
  const bins = P.relConf.filter((b) => b.n >= 20);
  const ymin = 0.8;
  const X = (i) => m.l + ((i + 0.5) / bins.length) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - (Math.max(y, ymin) - ymin) / (1 - ymin)) * (H - m.t - m.b);
  let g = '';
  for (let i = 0; i <= 4; i++) { const y = ymin + ((1 - ymin) * i) / 4; g += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${Y(y)}" y2="${Y(y)}"/><text x="${m.l - 6}" y="${Y(y) + 4}" text-anchor="end">${(y * 100).toFixed(0)}%</text>`; }
  bins.forEach((b, i) => {
    const bw = Math.min(26, (W - m.l - m.r) / bins.length / 3);
    g += `<rect x="${X(i) - bw - 1}" y="${Y(b.meanPred)}" width="${bw}" height="${Y(ymin) - Y(b.meanPred)}" rx="3" fill="var(--clay)" data-tip="Stated ${pct(b.meanPred, 1)} (n=${fmt(b.n)})"/>`;
    g += `<rect x="${X(i) + 1}" y="${Y(b.observed)}" width="${bw}" height="${Y(ymin) - Y(b.observed)}" rx="3" fill="var(--ink)" data-tip="Kept by reviewer ${pct(b.observed, 1)} (n=${fmt(b.n)})"/>`;
    g += `<text x="${X(i)}" y="${H - m.b + 15}" text-anchor="middle">${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%</text>`;
  });
  g += `<text x="${m.l}" y="${H - 6}">Stated confidence bin</text><g transform="translate(${W - 150},${H - 14})"><rect width="9" height="9" rx="2" fill="var(--clay)"/><text x="13" y="8">Stated</text><rect x="62" width="9" height="9" rx="2" fill="var(--ink)"/><text x="75" y="8">Observed</text></g>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
  bindTips(el);

  const w = P.model.w;
  $('coefTable').innerHTML = `<thead><tr><th>Input</th><th class="n">Weight (std.)</th><th>Effect</th></tr></thead><tbody>${FEATURE_NAMES.map((f, i) => `<tr><td>${f}</td><td class="n">${w[i] >= 0 ? '+' : ''}${w[i].toFixed(2)}</td><td><span class="mini"><i style="width:${Math.min(100, Math.abs(w[i]) * 60)}%;background:${w[i] > 0 ? 'var(--danger)' : 'var(--done)'}"></i></span></td></tr>`).join('')}
    <tr><td class="strong">Ranking quality (AUC, Jul – Sep)</td><td class="n strong">${P.aucRisk.toFixed(3)}</td><td class="sm">confidence alone ${P.aucConf.toFixed(3)}</td></tr></tbody>`;

  if (validity) {
    $('valSub').textContent = `${validity.R} fresh simulated firms, no drift (${validity.generatedBy}). Same pipeline, fresh data each time.`;
    $('valTable').innerHTML = `<thead><tr><th>Target</th><th class="n">Posted</th><th class="n">Exceeded</th><th class="n">Conf. only</th><th class="n">99% cutoff</th></tr></thead><tbody>${validity.results.map((r) => `<tr class="${r.alpha === P.alpha ? 'hl' : ''}"><td class="strong">${pct(r.alpha)}</td><td class="n">${pct(r.riskScore.meanAutoShare, 0)}</td><td class="n">${pct(r.riskScore.violationRate, 1)}</td><td class="n">${pct(r.rawConfidence.meanAutoShare, 0)}</td><td class="n" style="color:${r.staticCutoff.violationRate > 0.05 ? 'var(--danger)' : 'inherit'}">${pct(r.staticCutoff.violationRate, 0)}</td></tr>`).join('')}</tbody>`;
    $('valNote').innerHTML = `<b>Posted</b>: average share the certificate posts. <b>Exceeded</b>: firms where the true rate of what posted was above target (must stay under ${pct(validity.delta, 0)}). <b>Conf. only</b>: share posted when the same test uses agent confidence alone. <b>99% cutoff</b>: firms where a hand-set 99% confidence cutoff exceeded the target.`;
  }
}

// ---------- shell ----------
function bindTips(root) {
  const tip = $('tip');
  root.querySelectorAll('[data-tip]').forEach((n) => {
    n.addEventListener('mousemove', (e) => { tip.textContent = n.dataset.tip; tip.style.opacity = 1; tip.style.left = Math.min(e.clientX + 12, innerWidth - 290) + 'px'; tip.style.top = e.clientY + 14 + 'px'; });
    n.addEventListener('mouseleave', () => { tip.style.opacity = 0; });
  });
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('on', p.id === 'tab-' + name));
  if (name === 'monitor') renderMonitor();
  if (name === 'method') renderMethod();
  if (name === 'policy') drawCurve();
  history.replaceState(null, '', '#tab=' + name);
  if (window.lucide) lucide.createIcons();
}

function renderAll() {
  const D = derive();
  renderPolicy(D);
  renderFeeds();
  const active = document.querySelector('.tab.on')?.dataset.tab;
  if (active === 'monitor') renderMonitor();
  if (active === 'method') renderMethod();
  setWorking(false);
  if (window.lucide) lucide.createIcons();
}

function recompute() {
  setWorking(true);
  setTimeout(() => { compute(); renderAll(); }, 30);
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$('selAlpha').onchange = (e) => { state.alpha = +e.target.value; recompute(); };
$('selDelta').onchange = (e) => { state.delta = +e.target.value; recompute(); };
$('selAudit').onchange = (e) => { state.auditRate = +e.target.value; recompute(); };
$('btnApply').onclick = () => {
  const D = derive();
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `${icon('circle-check-big')}Applied to October: ${fmt(D.skip.length)} transactions post without line-by-line review; ${P.monitor.length} feeds stay under watch.`;
  document.body.appendChild(t);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => t.remove(), 3200);
};
window.addEventListener('resize', () => { const a = document.querySelector('.tab.on')?.dataset.tab; if (a === 'policy') drawCurve(); if (a === 'monitor') renderMonitor(); if (a === 'method') renderMethod(); });

fetch('data/validity.json').then((r) => r.json()).then((v) => { validity = v; if (document.querySelector('.tab.on')?.dataset.tab === 'method') renderMethod(); }).catch(() => {});
setWorking(true);
compute();
renderAll();
const h = new URLSearchParams(location.hash.slice(1));
if (h.get('tab')) showTab(h.get('tab'));
if (window.lucide) lucide.createIcons();
