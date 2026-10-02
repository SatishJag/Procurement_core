import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourcingEvent } from '../core/types.ts';
import { normalize, rank, technical } from '../modules/evaluation.ts';
import { validateCriteria } from '../modules/sourcing.ts';

test('normalization: arithmetic correction, FX, scope-gap loading, low-bid and collusion flags', () => {
  const ev = {
    lots: [{ id: 'L1', name: 'Lot 1' }],
    boq: [{ id: 'A', lotId: 'L1', item: 'Item A', unit: 'nr', qty: 10 }, { id: 'B', lotId: 'L1', item: 'Item B', unit: 'nr', qty: 1 }],
    bids: [
      { supplierId: 'S1', currency: 'AED', lines: [{ lineId: 'A', rate: 100, amount: 900 }, { lineId: 'B', rate: 50, amount: 50 }], exclusions: [] },
      { supplierId: 'S2', currency: 'USD', lines: [{ lineId: 'A', rate: 30, amount: 300 }], exclusions: [] },
      { supplierId: 'S3', currency: 'AED', lines: [{ lineId: 'A', rate: 100, amount: 1000 }, { lineId: 'B', rate: 30, amount: 30 }], exclusions: [{ lotId: 'L1', description: 'Freight', addBack: 20 }] },
      { supplierId: 'S4', currency: 'AED', lines: [{ lineId: 'A', rate: 40, amount: 400 }, { lineId: 'B', rate: 40, amount: 40 }], exclusions: [] },
    ],
  } as unknown as SourcingEvent;
  const [s1, s2, s3, s4] = normalize(ev, { AED: 1, USD: 3.5 });
  assert.equal(s1.total, 1050);                 // 900 corrected to 1000 (rate governs) + 50
  assert.match(s1.adjustments[0], /arithmetic corrected/);
  assert.equal(s2.total, 1100);                 // 30 USD × 10 × 3.5 = 1050, + B loaded at highest other rate 50
  assert.equal(s3.total, 1050);                 // 1000 + 30 + 20 exclusion add-back
  assert.equal(s4.total, 440);
  assert.ok(s4.anomalies.some(a => /abnormally low/.test(a)));
  assert.ok(s4.anomalies.some(a => /unit rate -60%/.test(a)));
  assert.ok(s1.anomalies.some(a => /collusion-risk/.test(a)));  // S1 and S3 land on the same total
  assert.equal(s2.anomalies.length, 0);
});

test('technical: gates disqualify, quorum and evidence are enforced, ranking uses lowest compliant price', () => {
  const ev = {
    criteria: [{ id: 'G', name: 'HSE', weight: 0, gate: true }, { id: 'Q', name: 'Quality', weight: 100 }],
    techThreshold: 50, quorum: 2, moderations: [], declarations: {},
    bids: [{ supplierId: 'S1' }, { supplierId: 'S2' }, { supplierId: 'S3' }],
    scores: [
      ...['e1', 'e2'].flatMap(e => [{ evaluatorId: e, supplierId: 'S1', criterionId: 'G', score: 1 }, { evaluatorId: e, supplierId: 'S1', criterionId: 'Q', score: 8 }]),
      ...['e1', 'e2'].flatMap(e => [{ evaluatorId: e, supplierId: 'S2', criterionId: 'G', score: 0, comment: 'No HSE plan' }, { evaluatorId: e, supplierId: 'S2', criterionId: 'Q', score: 7 }]),
      { evaluatorId: 'e1', supplierId: 'S3', criterionId: 'G', score: 1 }, { evaluatorId: 'e1', supplierId: 'S3', criterionId: 'Q', score: 10 },
    ],
  } as unknown as SourcingEvent;
  const [s1, s2, s3] = technical(ev);
  assert.equal(s1.score, 80);
  assert.equal(s1.qualified, true);
  assert.equal(s2.gatesPassed, false);
  assert.equal(s2.qualified, false);
  assert.equal(s3.complete, false);              // one evaluator, quorum 2
  const ranking = rank([s1, s2], [{ supplierId: 'S1', total: 200 }, { supplierId: 'S2', total: 100 }] as never, 0.5);
  assert.deepEqual(ranking.map(r => [r.supplierId, r.commercial]), [['S1', 100]]); // S2's cheaper price ignored: failed gate
  assert.throws(() => validateCriteria([{ id: 'a', name: 'a', weight: 60 }, { id: 'b', name: 'b', weight: 30 }]), /total 100/);
});
