// Rule tests for the decision engine embedded in index.html.
// Run: node tests.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
if (!m) throw new Error('engine block not found');
const mod = { exports: {} };
new Function('module', m[1])(mod);
const E = mod.exports;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
const ev = s => E.evaluate(s);
const keys = r => r.asks.map(a => a.key);
const opt = (r, id) => r.opts.find(o => o.id === id);
const WELL = { sq: 'yes', kps: '90', dem: 'none', alb: 4, cNone: true };
const FRAIL = { sq: 'no', kps: '30', dem: 'mild', alb: 2.4, ccChf: true, ccPvd: true, ccDm2: true };

console.log('Guided flow');
t('nothing entered → asks only for the base card', () => assert.deepEqual(keys(ev({})), ['base']));
t('pre-dialysis → kidney card asked; on dialysis → not asked', () => {
  assert.ok(keys(ev({ age: 60, stage: 'ckd', cap: 'yes' })).includes('kidney'));
  assert.ok(!keys(ev({ age: 60, stage: 'hd', cap: 'yes' })).includes('kidney'));
});
t('pending card is removed from asks', () => {
  const r = ev({ age: 60, stage: 'ckd', cap: 'yes', _pending: ['kidney'] });
  assert.ok(!keys(r).includes('kidney')); assert.deepEqual(r.pending, ['kidney']);
});
t('values card links to the values tab and clears once anything is rated', () => {
  const a = ev({ age: 60, stage: 'ckd', cap: 'yes' }).asks.find(x => x.key === 'vals');
  assert.equal(a.link, 'vals');
  assert.ok(!keys(ev({ age: 60, stage: 'ckd', cap: 'yes', _v: { home: 3 } })).includes('vals'));
});
t('RPA-poor patient is not asked about transplant barriers', () => {
  assert.ok(!keys(ev({ age: 84, stage: 'ckd', cap: 'yes', ...FRAIL })).includes('txc'));
});

console.log('Prognosis (RPA 2010 Rec 6)');
t('84 y, SQ no + dependent + high comorbidity + alb 2.4 → RPA, poor', () => {
  const P = ev({ age: 84, stage: 'ckd', cap: 'yes', ...FRAIL }).P;
  assert.equal(P.rpa, true); assert.equal(P.level, 'poor'); assert.equal(P.crit.length, 4);
});
t('74 y with the same criteria → not RPA (age <75) but still poor', () => {
  const P = ev({ age: 74, stage: 'ckd', cap: 'yes', ...FRAIL }).P;
  assert.equal(P.rpa, false); assert.equal(P.level, 'poor');
});
t('only one criterion (SQ no) → guarded', () => {
  const P = ev({ age: 78, stage: 'ckd', cap: 'yes', ...WELL, sq: 'no' }).P;
  assert.equal(P.rpa, false); assert.equal(P.level, 'guarded');
});
t('albumin exactly 2.5 does not meet the <2.5 criterion', () => {
  const P = ev({ age: 80, stage: 'ckd', cap: 'yes', ...WELL, sq: 'no', alb: 2.5 }).P;
  assert.equal(P.crit.length, 1);
});
t('metastatic tumour alone → Charlson ≥8 → high comorbidity', () => {
  const P = ev({ age: 80, stage: 'ckd', cap: 'yes', sq: 'no', kps: '80', dem: 'none', ccMets: true }).P;
  assert.ok(P.crit.some(c => c.startsWith('高共病負擔'))); assert.equal(P.rpa, true);
});
t('KPS 40 is not <40; KPS 30 is', () => {
  assert.ok(!ev({ age: 80, stage: 'ckd', sq: 'yes', kps: '40', cNone: true }).P.crit.some(c => c.includes('KPS')));
  assert.ok(ev({ age: 80, stage: 'ckd', sq: 'yes', kps: '30', cNone: true }).P.crit.some(c => c.includes('KPS')));
});
t('well 45 y → good', () => assert.equal(ev({ age: 45, stage: 'ckd', cap: 'yes', ...WELL }).P.level, 'good'));
t('prognosis unknown until SQ and KPS given', () => assert.equal(ev({ age: 70, stage: 'ckd', cap: 'yes' }).P.level, null));

console.log('Charlson comorbidity index');
t('renal disease 2 points always; 1 age point per full decade over 40', () => {
  assert.equal(E.charlson({}, 45).total, 2);
  assert.equal(E.charlson({}, 55).total, 3);
  assert.equal(E.charlson({}, 65).total, 4);
  assert.equal(E.charlson({}, 75).total, 5);
  assert.equal(E.charlson({}, 85).total, 6);
  assert.equal(E.charlson({}, 92).total, 7);
});
t('diabetes without organ damage still scores 2 with kidney disease (minimum 4)', () => assert.equal(E.charlson({ ccDm: true }, 40).base, 4));
t('hierarchies: DM with organ damage replaces DM; metastatic replaces tumour; severe liver replaces mild', () => {
  assert.equal(E.charlson({ ccDm: true, ccDm2: true }, 40).base, 4);
  assert.equal(E.charlson({ ccTum: true, ccMets: true }, 40).base, 8);
  assert.equal(E.charlson({ ccLiv1: true, ccLiv3: true }, 40).base, 5);
});
t('dementia from cognition field adds 1', () => assert.equal(E.charlson({ dem: 'mild' }, 40).base, 3));
t('FRAIL 84 y → 11 (CHF 1, PVD 1, DM2 2, dementia 1, renal 2, age 4)', () => assert.equal(E.charlson({ ...FRAIL }, 84).total, 11));
t('high comorbidity needs an answered comorbidity card', () => assert.equal(ev({ age: 90, stage: 'ckd' }).d.highComorb, false));

console.log('REIN score');
t('REIN only for ≥75 y before dialysis', () => {
  assert.equal(ev({ age: 74, stage: 'ckd', rNone: true }).d.rein, null);
  assert.equal(ev({ age: 80, stage: 'hd', rNone: true }).d.rein, null);
  assert.deepEqual(ev({ age: 80, stage: 'ckd', rNone: true }).d.rein, { score: 0, mort6: 8 });
});
t('REIN mapping 1→10, 2→17, 4→21, 6→33, 8→50, 9→70', () => {
  const sc = x => ev({ age: 80, stage: 'ckd', ...x }).d.rein.mort6;
  assert.equal(sc({ rDm: true }), 10);
  assert.equal(sc({ rChf: true }), 17);
  assert.equal(sc({ rChf: true, rPvd: true }), 21);
  assert.equal(sc({ rTrans: true, rChf: true, rArr: true }), 33);
  assert.equal(sc({ rTrans: true, rChf: true, rPvd: true, rArr: true }), 50);
  assert.equal(sc({ rTrans: true, rChf: true, rPvd: true, rBeh: true }), 70);
});
t('REIN ≥33% appears as a prognosis flag and REIN card is optional', () => {
  const r = ev({ age: 80, stage: 'ckd', cap: 'yes', rTrans: true, rChf: true, rArr: true, sq: 'yes', kps: '50' });
  assert.ok(r.P.flags.some(f => f.startsWith('REIN')));
  assert.equal(ev({ age: 80, stage: 'ckd', cap: 'yes' }).asks.find(a => a.key === 'rein').pri, 'later');
});

console.log('Timing (KDIGO 2024)');
t('eGFR 25 → still time, transplant referral (<30)', () => {
  const T = ev({ stage: 'ckd', egfr: 25 }).timing;
  assert.equal(T.c, 'info'); assert.ok(T.x.some(x => x.includes('移植評估')));
});
t('eGFR 18 → preparation phase (<20)', () => assert.equal(ev({ stage: 'ckd', egfr: 18 }).timing.c, 'warn'));
t('eGFR 25 but KFRE 45% → preparation phase', () => assert.equal(ev({ stage: 'ckd', egfr: 25, kfre: 45 }).timing.c, 'warn'));
t('KFRE 12% → multidisciplinary care note; 10% exactly → none', () => {
  assert.ok(ev({ stage: 'ckd', egfr: 35, kfre: 12 }).timing.x.some(x => x.includes('多專業')));
  assert.ok(!ev({ stage: 'ckd', egfr: 35, kfre: 10 }).timing.x.some(x => x.includes('多專業')));
});
t('severe uraemic symptoms → urgent', () => assert.equal(ev({ stage: 'ckd', egfr: 25, sx: 'sev' }).timing.c, 'stop'));
t('RPA-poor → no transplant referral in timing, CKM step instead', () => {
  const x = ev({ age: 84, stage: 'ckd', egfr: 9, ...FRAIL }).timing.x;
  assert.ok(!x.some(v => v.includes('移植'))); assert.ok(x.some(v => v.includes('保守治療')));
});
t('on dialysis → no timing block', () => assert.equal(ev({ stage: 'hd', egfr: 5 }).timing, null));

console.log('Options');
t('pre-dialysis option set: HD, PD, HHD, Tx, CKM (no withdrawal)', () => {
  const ids = ev({ age: 50, stage: 'ckd', cap: 'yes', ...WELL }).opts.map(o => o.id);
  assert.deepEqual(ids, ['hd', 'pd', 'hhd', 'tx', 'ckm']);
});
t('on HD: withdrawal offered, CKM not; HD flagged as current', () => {
  const r = ev({ age: 60, stage: 'hd', cap: 'yes', ...WELL });
  assert.ok(opt(r, 'wd')); assert.ok(!opt(r, 'ckm')); assert.equal(opt(r, 'hd').cur, true);
});
t('time-limited trial appears only when prognosis is not good', () => {
  assert.ok(!opt(ev({ age: 50, stage: 'ckd', cap: 'yes', ...WELL }), 'ttl'));
  assert.ok(opt(ev({ age: 78, stage: 'ckd', cap: 'yes', ...WELL, sq: 'no' }), 'ttl'));
});
t('uncorrectable hernia → PD not advised', () => assert.equal(opt(ev({ stage: 'ckd', aHernia: true }), 'pd').st, 'no'));
t('cannot self-care and no helper → PD and HHD not advised', () => {
  const r = ev({ stage: 'ckd', self: 'none' });
  assert.equal(opt(r, 'pd').st, 'no'); assert.equal(opt(r, 'hhd').st, 'no');
});
t('prior abdominal surgery → PD needs evaluation', () => assert.equal(opt(ev({ stage: 'ckd', aSurg: true, self: 'self', home: 'ok' }), 'pd').st, 'eval'));
t('helper-assisted → PD needs evaluation', () => assert.equal(opt(ev({ stage: 'ckd', aNone: true, self: 'helper', home: 'ok' }), 'pd').st, 'eval'));
t('no PD barriers → PD ok', () => assert.equal(opt(ev({ stage: 'ckd', aNone: true, self: 'self', home: 'ok' }), 'pd').st, 'ok'));
t('RPA-poor → transplant not advised, CKM flagged for priority', () => {
  const r = ev({ age: 84, stage: 'ckd', cap: 'yes', ...FRAIL });
  assert.equal(opt(r, 'tx').st, 'no'); assert.equal(opt(r, 'ckm').pref, true);
});
t('patient declines transplant → not advised', () => assert.equal(opt(ev({ age: 50, stage: 'ckd', tNo: true }), 'tx').st, 'no'));
t('transplant barrier → needs evaluation, not excluded', () => assert.equal(opt(ev({ age: 50, stage: 'ckd', ...WELL, tInf: true }), 'tx').st, 'eval'));
t('living donor before dialysis → pre-emptive transplant mentioned', () => {
  assert.ok(opt(ev({ age: 45, stage: 'ckd', ...WELL, tNone: true, donor: 'yes' }), 'tx').why.some(w => w.includes('先發性')));
});
t('age 72 alone does not exclude transplant', () => assert.equal(opt(ev({ age: 72, stage: 'ckd', ...WELL, tNone: true }), 'tx').st, 'ok'));
t('poor prognosis on dialysis → withdrawal flagged for priority', () => {
  assert.equal(opt(ev({ age: 80, stage: 'hd', cap: 'yes', ...FRAIL }), 'wd').pref, true);
});

console.log('Values fit');
t('no ratings → no fit', () => assert.equal(ev({ stage: 'ckd' }).fit, null));
t('home + schedule → PD ranks above in-centre HD', () => {
  const rows = ev({ stage: 'ckd', aNone: true, self: 'self', home: 'ok', _v: { home: 4, sched: 4 } }).fit.rows;
  const i = id => rows.findIndex(r => r.id === id);
  assert.ok(i('pd') < i('hd'));
});
t('avoid procedures → CKM top', () => assert.equal(ev({ stage: 'ckd', _v: { proc: 4 } }).fit.rows[0].id, 'ckm'));
t('only staff matters → HD scores 100%', () => assert.equal(ev({ stage: 'ckd', _v: { staff: 4 } }).fit.rows.find(r => r.id === 'hd').score, 100));
t('options marked "not advised" are excluded from fit', () => {
  const rows = ev({ stage: 'ckd', aHernia: true, _v: { home: 4 } }).fit.rows;
  assert.ok(!rows.some(r => r.id === 'pd'));
});
t('poor prognosis lowers dialysis "life" score', () => {
  const good = ev({ age: 50, stage: 'ckd', ...WELL, _v: { life: 4 } }).fit.rows.find(r => r.id === 'hd').score;
  const poor = ev({ age: 84, stage: 'ckd', ...FRAIL, _v: { life: 4 } }).fit.rows.find(r => r.id === 'hd').score;
  assert.equal(good, 75); assert.equal(poor, 40);
});
t('top values = rated ≥3', () => assert.deepEqual(ev({ stage: 'ckd', _v: { home: 3, diet: 2, life: 4 } }).fit.top, ['盡量延長壽命', '在家治療，待在熟悉的地方']));

console.log('Recommendation');
const FEAS = { age: 60, stage: 'ckd', cap: 'yes', egfr: 12, ...WELL, tNone: true, donor: 'no', aNone: true, self: 'self', home: 'ok' };
t('no values, no choice → needs data', () => assert.equal(ev(FEAS).rec.status, 'need'));
t('undecided + values → suggests top fit', () => {
  const r = ev({ ...FEAS, _v: { home: 4, sched: 4 }, choice: 'undecided' }).rec;
  assert.equal(r.status, 'suggest'); assert.equal(r.primary.id, 'pd');
});
t('feasible choice is respected even if another fits better', () => {
  const r = ev({ ...FEAS, _v: { home: 4, sched: 4 }, choice: 'hd' }).rec;
  assert.equal(r.status, 'ok'); assert.equal(r.primary.id, 'hd');
  assert.ok(r.notes.some(n => n.includes('差距較大')));
});
t('choice not advised → conflict, best feasible alternative offered', () => {
  const r = ev({ ...FEAS, aNone: false, aHernia: true, _v: { home: 4 }, choice: 'pd' }).rec;
  assert.equal(r.status, 'conflict'); assert.ok(['hd', 'hhd'].includes(r.primary.id));
});
t('choice needing evaluation → backup offered', () => {
  const r = ev({ ...FEAS, aNone: false, aSurg: true, _v: { home: 4, staff: 2 }, choice: 'pd' }).rec;
  assert.equal(r.status, 'eval'); assert.ok(r.alt && r.alt.id !== 'pd');
});
t('transplant → bridge dialysis chosen; pre-emptive note with living donor', () => {
  const r = ev({ ...FEAS, donor: 'yes', _v: { home: 4 }, choice: 'tx' }).rec;
  assert.equal(r.primary.id, 'tx'); assert.equal(r.bridge.id, 'pd'); assert.ok(r.notes.some(n => n.includes('先發性')));
});
t('time-limited trial gets a bridge modality', () => assert.ok(ev({ ...FEAS, sq: 'no', choice: 'ttl' }).rec.bridge));
t('CKM chosen while on dialysis maps to withdrawal', () => assert.equal(ev({ ...FEAS, stage: 'hd', choice: 'ckm' }).rec.primary.id, 'wd'));
t('poor prognosis + dialysis choice → time-limited framing', () => {
  assert.ok(ev({ age: 84, stage: 'ckd', cap: 'yes', ...FRAIL, aNone: true, self: 'helper', home: 'ok', choice: 'hd' }).rec.notes.some(n => n.includes('限時嘗試')));
});
t('SURE 3/4 → not ready; 4/4 → ready', () => {
  const y = { sure1: 'y', sure2: 'y', sure3: 'y', sure4: 'y' };
  assert.equal(ev({ ...FEAS, choice: 'hd', ...y, sure2: 'n' }).rec.ready, false);
  assert.equal(ev({ ...FEAS, choice: 'hd', ...y }).rec.ready, true);
});
t('SURE asked only after a choice is made', () => {
  assert.ok(!keys(ev({ ...FEAS, choice: 'undecided' })).includes('sure'));
  assert.ok(keys(ev({ ...FEAS, choice: 'hd' })).includes('sure'));
});

console.log('Care pathway');
t('pre-dialysis HD pathway includes access steps; on HD continuing → maintenance path', () => {
  assert.ok(ev({ ...FEAS, choice: 'hd' }).plan[0].steps.some(x => x.key === 'hd.avf'));
  const p = ev({ ...FEAS, stage: 'hd', choice: 'cont' }).plan;
  assert.equal(p[0].id, 'cont');
});
t('PD on dialysis already → no catheter step', () => {
  assert.ok(!ev({ ...FEAS, stage: 'hd', choice: 'pd' }).plan[0].steps.some(x => x.key === 'pd.cath'));
});
t('transplant pathway: donor step only with a donor; bridge pathway appended', () => {
  const a = ev({ ...FEAS, donor: 'no', choice: 'tx' }).plan;
  assert.ok(!a[0].steps.some(x => x.key === 'tx.donor')); assert.equal(a.length, 2);
  assert.ok(ev({ ...FEAS, donor: 'yes', choice: 'tx' }).plan[0].steps.some(x => x.key === 'tx.donor'));
});
t('completed steps counted', () => {
  const p = ev({ ...FEAS, choice: 'ckm', _st: { 'ckm.hosp': 1, 'ckm.sx': 2 } }).plan[0];
  assert.equal(p.n, 2);
});

console.log('Knowledge check');
t('scores answers', () => {
  const Q = ev({ _q: { q1: false, q2: true, q3: true } }).quiz;
  assert.equal(Q.answered, 3); assert.equal(Q.right, 2); assert.deepEqual(Q.wrong, ['q3']);
});
t('quiz has 10 items with explanations', () => { assert.equal(E.QUIZ.length, 10); assert.ok(E.QUIZ.every(q => q.x && typeof q.a === 'boolean')); });

console.log('Advance care planning');
t('capable, no ACP → recommend ACP and agent', () => {
  const t_ = ev({ stage: 'ckd', cap: 'yes', acp: 'none', agent: 'none' }).acp.map(i => i.t);
  assert.ok(t_.some(x => x.includes('預立醫療照護諮商'))); assert.ok(t_.some(x => x.includes('醫療委任代理人')));
});
t('no capacity → ACP not offered, proxy path explained', () => {
  const A = ev({ stage: 'ckd', cap: 'no' }).acp;
  assert.equal(A[0].c, 'stop'); assert.ok(!A.some(i => i.t.includes('建議安排預立醫療照護諮商')));
});
t('poor prognosis → DNR discussion + hospice referral', () => {
  const t_ = ev({ age: 84, stage: 'ckd', cap: 'yes', ...FRAIL, dnr: 'none' }).acp.map(i => i.t);
  assert.ok(t_.some(x => x.includes('DNR'))); assert.ok(t_.some(x => x.includes('安寧共同照護')));
});
t('ACP done + agent + DNR signed + talked → nothing outstanding when prognosis good', () => {
  assert.equal(ev({ age: 50, stage: 'ckd', cap: 'yes', ...WELL, acp: 'done', agent: 'yes', dnr: 'signed', talked: true, place: 'hosp' }).acp.length, 0);
});
t('≥65 on dialysis → ACP item says NHI-covered as 重大傷病', () => {
  const a = ev({ age: 70, stage: 'hd', cap: 'yes', acp: 'none' }).acp.find(i => i.t.includes('預立醫療照護諮商'));
  assert.ok(a.x.includes('65 歲以上透析病人'));
  const b = ev({ age: 60, stage: 'hd', cap: 'yes', acp: 'none' }).acp.find(i => i.t.includes('預立醫療照護諮商'));
  assert.ok(!b.x.includes('65 歲以上透析病人'));
});
t('wants to die at home → home hospice item', () => assert.ok(ev({ stage: 'hd', cap: 'yes', place: 'home' }).acp.some(i => i.t.includes('居家'))));

console.log('Path & summary');
t('path marks first incomplete step as current', () => {
  const p = ev({ age: 60, stage: 'ckd', cap: 'yes' }).path;
  assert.equal(p.findIndex(x => x.now), 1);
});
t('on dialysis: kidney-function step is skipped', () => assert.equal(ev({ stage: 'hd', cap: 'yes' }).path[1].skip, true));
t('summary contains stage, prognosis, options, decision', () => {
  const s = E.summary({ age: 84, stage: 'ckd', cap: 'yes', egfr: 9, ...FRAIL, _v: { home: 4 }, _q: { q1: false }, choice: 'ckm', when: 'now', sure1: 'y', sure2: 'y', sure3: 'y', sure4: 'n', _st: { 'ckm.hosp': 1 } }, '2026-10-09');
  ['2026-10-09', '84 歲', 'eGFR 9', '預後不良', 'RPA', 'KPS 30', 'Charlson 11', '理解確認：1/10', '病人選擇：腎臟保守治療（不透析）', 'SURE：3/4（有決策衝突）', '綜合建議：依病人選擇「腎臟保守治療（不透析）」', '已完成 1/8'].forEach(k => assert.ok(s.includes(k), k));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
