import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sha256 } from '../core/audit.ts';
import { Platform } from '../core/kernel.ts';
import type { Requisition, SourcingEvent, User } from '../core/types.ts';
import { analyzeBids, classifyRequisition, insights, setComplete, type Request } from '../modules/insight.ts';

const user = (id: string, roles: User['roles'], projects = ['*']): User => ({ id, name: id, roles, projects });
const buyer = user('buyer', ['buyer', 'requester']);
const evaluator = user('tech', ['technical_evaluator']);
const outsider = user('out', ['buyer'], ['P2']);

const bid = (supplierId: string, a: [number, number], b: [number, number]) => ({
  supplierId, currency: 'AED', exclusions: [], deviations: [],
  lines: [{ lineId: 'A', rate: a[0], amount: a[1] }, { lineId: 'B', rate: b[0], amount: b[1] }],
});
const event = (status: string) => ({
  id: 'EVT-1', packageId: 'PKG-1', status, lots: [{ id: 'L1', name: 'Lot 1' }],
  boq: [{ id: 'A', lotId: 'L1', item: 'Item A', unit: 'nr', qty: 10 }, { id: 'B', lotId: 'L1', item: 'Item B', unit: 'nr', qty: 1 }],
  criteria: [{ id: 'Q', name: 'Quality', weight: 100 }], techWeight: 0.5, techThreshold: 50, quorum: 1, evaluators: ['e1'], declarations: { e1: [] }, moderations: [],
  bids: [bid('S1', [100, 1000], [50, 50]), bid('S2', [105, 1050], [60, 60]), bid('S3', [40, 400], [40, 40])],
  scores: ['S1', 'S2', 'S3'].map(supplierId => ({ evaluatorId: 'e1', supplierId, criterionId: 'Q', score: 8 })),
}) as unknown as SourcingEvent;

function setup(status = 'commercial') {
  const requisition = { id: 'REQ-1', projectId: 'P1', title: 'Standby diesel generators', description: 'Supply of 4 x 2.5MVA generators for hall A', amount: 3_000_000 } as Requisition;
  const p = new Platform({
    fx: { AED: 1 },
    tables: { requisitions: [requisition], packages: [{ id: 'PKG-1', projectId: 'P1' }] as never, events: [event(status)] },
  }, () => '2026-10-02T09:00:00.000Z');
  return p;
}

const sent: Request[] = [];
const stub = (data: unknown) => setComplete(async req => { sent.push(req); return { data, model: 'claude-test' }; });
afterEach(() => { setComplete(); sent.length = 0; });

test('classify: model and engine side by side, agreement flag, stored, audited, chain intact', async () => {
  const p = setup();
  stub({ category: 'Electrical / Generators', confidence: 0.95, evidence: ['diesel generators'], rationale: 'Genset supply' });
  const r = await classifyRequisition(p, buyer, 'REQ-1');
  assert.equal(r.source, 'ai');
  assert.equal('ai' in r && r.agrees, true);
  assert.equal('engine' in r && r.engine.category, 'Electrical / Generators');
  assert.equal(insights(p).get(r.id as string)?.kind, 'classify');
  const ev = p.audit.for(r.id as string);
  assert.equal(ev[0].action, 'insight.generated');
  assert.deepEqual(ev[0].data, { kind: 'classify', model: 'claude-test', inputHash: sha256(JSON.parse(sent[0].input)), subject: 'REQ-1' });
  assert.deepEqual(p.audit.verify(), { ok: true });

  stub({ category: 'Civil Works', confidence: 0.6, evidence: [], rationale: 'x' });
  assert.equal((await classifyRequisition(p, buyer, 'REQ-1') as { agrees: boolean }).agrees, false);
});

test('classify: bad ids, roles, project scope and malformed model output are refused', async () => {
  const p = setup();
  stub({ category: 'Made Up', confidence: 2, evidence: [], rationale: '' });
  await assert.rejects(classifyRequisition(p, buyer, 'REQ-9'), /Requisition REQ-9 was not found/);
  await assert.rejects(classifyRequisition(p, user('s', ['supplier']), 'REQ-1'), /needs one of/);
  await assert.rejects(classifyRequisition(p, outsider, 'REQ-1'), /no access to project P1/);
  await assert.rejects(classifyRequisition(p, buyer, 'REQ-1'), /could not read/);
  assert.equal(insights(p).size, 0);       // nothing stored or audited for a failed call
  assert.equal(p.audit.events.length, 0);
});

test('no key: deterministic engine result with a notice, no AI record, no audit event', async () => {
  const p = setup(), key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const c = await classifyRequisition(p, buyer, 'REQ-1');
    assert.equal(c.source, 'engine');
    assert.match(c.notice!, /ANTHROPIC_API_KEY/);
    assert.equal('engine' in c && c.engine.category, 'Electrical / Generators');
    const a = await analyzeBids(p, buyer, 'EVT-1');
    assert.equal(a.source, 'engine');
    assert.equal('engine' in a && a.engine.ranking.length, 3);
    assert.equal(insights(p).size + p.audit.events.length, 0);
  } finally { if (key) process.env.ANTHROPIC_API_KEY = key; }
});

test('analyze: sealed envelope, roles and unknown events block the model call', async () => {
  const p = setup('technical');
  stub({});
  await assert.rejects(analyzeBids(p, buyer, 'EVT-1'), /sealed until the technical evaluation is signed off/);
  await assert.rejects(analyzeBids(p, buyer, 'EVT-9'), /Sourcing event EVT-9 was not found/);
  p.table<SourcingEvent>('events').get('EVT-1')!.status = 'commercial';
  await assert.rejects(analyzeBids(p, evaluator, 'EVT-1'), /needs one of/);
  await assert.rejects(analyzeBids(p, outsider, 'EVT-1'), /no access to project P1/);
  assert.equal(sent.length, 0);            // the model never saw anything
});

test('analyze: risks citing evidence or bidders not in the engine output are dropped; the input hash covers exactly what was sent', async () => {
  const p = setup();
  const good = { severity: 'high', supplierId: 'S3', text: 'Abnormally low total', evidenceRef: 'anom:S3:0' };
  stub({
    summary: 'S1 ranks first.',
    risks: [good,
      { ...good, evidenceRef: 'anom:S3:99' },                    // invented ref
      { ...good, supplierId: 'S9' },                             // invented bidder
      { ...good, severity: 'catastrophic' },                     // bad severity
      { severity: 'low', supplierId: 'S1', text: 'Ranked first', evidenceRef: 'rank:S1' }],
    scenarioNotes: ['Split award saves nothing'], questionsForBidders: ['Confirm S3 scope'],
  });
  const r = await analyzeBids(p, buyer, 'EVT-1');
  assert.equal(r.source, 'ai');
  assert.ok('risks' in r);
  assert.deepEqual(r.risks.map(x => x.evidenceRef), ['anom:S3:0', 'rank:S1']);
  assert.equal(r.dropped, 3);
  const input = JSON.parse(sent[0].input);
  assert.ok(input.normalized[2].anomalies.some((a: { ref: string }) => a.ref === 'anom:S3:0'));
  assert.ok(!/ANTHROPIC|sk-ant/.test(sent[0].input));
  const stored = insights(p).get(r.id)!;
  assert.equal(stored.projectId, 'P1');
  assert.equal(stored.inputHash, sha256(input));
  assert.deepEqual(p.audit.for(r.id)[0].data, { kind: 'analyze', model: 'claude-test', inputHash: stored.inputHash, subject: 'EVT-1' });
  assert.deepEqual(p.audit.verify(), { ok: true });
  assert.equal(p.table<SourcingEvent>('events').get('EVT-1')!.status, 'commercial');   // advisory: no workflow change

  stub({ summary: 1 });
  await assert.rejects(analyzeBids(p, buyer, 'EVT-1'), /could not read/);
});
