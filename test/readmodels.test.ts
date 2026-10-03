import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../core/types.ts';
import { createPlatform } from '../modules/index.ts';
import * as awards from '../modules/awards.ts';
import * as intake from '../modules/intake.ts';
import * as reporting from '../modules/reporting.ts';
import * as sourcing from '../modules/sourcing.ts';
import * as suppliers from '../modules/suppliers.ts';

const u = (id: string, roles: User['roles'], projects = ['*'], extra: Partial<User> = {}): User => ({ id, name: id, roles, projects, ...extra });
const users = [
  u('req1', ['requester'], ['P1']), u('req2', ['requester'], ['P1']), u('b1', ['buyer'], ['P1']), u('b2', ['buyer'], ['P2']), u('boss', ['buyer']),
  u('pm', ['procurement_manager']), u('cm', ['category_manager']), u('bo', ['budget_owner'], ['*'], { approvalLimit: 10_000_000 }),
  u('te', ['technical_evaluator']), u('ce', ['commercial_evaluator']), u('aud', ['auditor']),
  u('sup1', ['supplier'], [], { supplierId: 'S1' }), u('sup3', ['supplier'], [], { supplierId: 'S3' }),
];
const U = Object.fromEntries(users.map(x => [x.id, x]));
const sched = { milestones: [{ name: 'RFx issue', date: '2027-01-01' }], floatDays: 90, health: 'on_track' };
const PRICE = 987_654.32, AWARD = 1_234_567;

function setup() {
  return createPlatform({
    fx: { AED: 1 },
    tables: {
      users: users as never,
      projects: [
        { id: 'P1', name: 'DC1', site: 'Dubai', capacityMW: 20, budgets: { C1: 5_000_000 }, committed: {} },
        { id: 'P2', name: 'DC2', site: 'Abu Dhabi', capacityMW: 10, budgets: { C1: 5_000_000 }, committed: {} },
      ] as never,
      packages: [
        { id: 'PKG-1', projectId: 'P1', costCode: 'C1', title: 'Gens', category: 'Electrical', estimate: 1, route: 'RFP', schedule: sched, status: 'sourcing', requesterId: 'req1' },
        { id: 'PKG-2', projectId: 'P2', costCode: 'C1', title: 'Chillers', category: 'Electrical', estimate: 1, route: 'RFP', schedule: sched, status: 'sourcing' },
      ] as never,
      requisitions: [{ id: 'PR-1', projectId: 'P1', requesterId: 'req1', status: 'submitted', amount: 5 }, { id: 'PR-2', projectId: 'P2', requesterId: 'req2', status: 'submitted', amount: 5 }] as never,
      events: [
        { id: 'EV-1', packageId: 'PKG-1', type: 'RFP', title: 'Gens RFP', status: 'open', lots: [{ id: 'L1', name: 'Lot 1' }], criteria: [{ id: 'Q', name: 'Quality', weight: 100 }],
          evaluators: ['te'], invited: ['S1', 'S2'], closesAt: '2027-01-01T00:00:00Z', blind: true, declarations: {}, scores: [], moderations: [],
          bids: [{ id: 'B1', supplierId: 'S1', currency: 'AED', exclusions: [], deviations: [], lines: [{ lineId: 'A', rate: PRICE, amount: PRICE }] }, { id: 'B2', supplierId: 'S2', lines: [] }],
          clarifications: [{ id: 'CL-1', supplierId: 'S1', question: 'Site access?', answer: 'Badge' }, { id: 'CL-2', supplierId: 'S2', question: 'Voltage?' }] },
        { id: 'EV-2', packageId: 'PKG-2', type: 'RFP', title: 'Chillers RFP', status: 'draft', lots: [], criteria: [], evaluators: [], invited: ['S1'], closesAt: '2027-01-01T00:00:00Z', bids: [], clarifications: [] },
      ] as never,
      awards: [{ id: 'AW-1', eventId: 'EV-1', scenario: 'best', allocations: [{ supplierId: 'S1', lotIds: ['L1'], value: AWARD }], value: AWARD, justification: 'cheapest', deviation: false,
        recommendedBy: 'boss', status: 'pending', steps: awards.routeApproval(AWARD) }] as never,
      suppliers: [
        { id: 'S1', name: 'Alpha', country: 'AE', categories: ['Electrical'], status: 'qualified', docs: [{ type: 'trade_licence', expires: '2026-10-10' }, { type: 'insurance', expires: '2026-09-01' }, { type: 'tax_certificate', expires: '2028-01-01' }], risk: 'low', sanctioned: false, performance: 80 },
        { id: 'S2', name: 'Beta', country: 'AE', categories: [], status: 'registered', docs: [], risk: 'high', sanctioned: true, performance: 50 },
      ] as never,
    },
  }, () => '2026-10-02T09:00:00.000Z');
}
const ids = (xs: { id: string }[]) => xs.map(x => x.id);

test('intake: BOQ packages guard on the BOQ project; requisition read models are scoped', () => {
  const p = setup();
  const csvText = 'lot,item,unit,qty\nL1,Racks,nr,10';
  const boq1 = intake.uploadBoq(p, U.boss, { projectId: 'P1', name: 'B1', csvText });
  const boq2 = intake.uploadBoq(p, U.boss, { projectId: 'P2', name: 'B2', csvText });
  const input = { costCode: 'C1', category: 'IT', estimate: 1000, needBy: '2027-03-01', route: 'RFQ' as const, longLead: false };
  assert.equal(intake.createPackagesFromBoq(p, U.b1, { ...input, boqTemplateId: boq1.id }).projectId, 'P1');
  assert.throws(() => intake.createPackagesFromBoq(p, U.b1, { ...input, boqTemplateId: boq2.id }), /no access to project P2/);
  assert.throws(() => intake.createPackagesFromBoq(p, U.req1, { ...input, boqTemplateId: boq1.id }), /needs one of/);
  assert.throws(() => intake.createPackagesFromBoq(p, U.req1, { ...input, boqTemplateId: 'BOQ-nope' }), /needs one of/); // no probing of BOQ ids

  assert.equal(intake.get(p, U.req1, 'PR-1').id, 'PR-1');                       // own
  assert.throws(() => intake.get(p, U.req1, 'PR-2'), /no access/);               // someone else's
  assert.throws(() => intake.get(p, U.b1, 'PR-2'), /no access/);                 // other project
  assert.equal(intake.get(p, U.b1, 'PR-1').id, 'PR-1');
  assert.deepEqual(ids(intake.list(p, U.b1)), ['PR-1']);
  assert.deepEqual(ids(intake.list(p, U.req2)), ['PR-2']);
  assert.deepEqual(ids(intake.list(p, U.boss)), ['PR-1', 'PR-2']);
  assert.deepEqual(intake.list(p, U.sup1), []);
});

test('awards: get masks value, allocations and rationale for non-readers; check reuses the decision rules', () => {
  const p = setup();
  const full = awards.get(p, U.pm, 'AW-1') as { value?: number; allocations?: unknown; steps: { reason: string }[] };
  assert.equal(full.steps.length, 2);
  assert.equal(full.value, AWARD);
  assert.ok(full.allocations && full.steps[0].reason.includes('1,234,567'));
  const sealed = awards.get(p, U.cm, 'AW-1');
  assert.ok(!JSON.stringify(sealed).includes('1234567') && !JSON.stringify(sealed).includes('1,234,567') && !('allocations' in sealed) && !('justification' in sealed));
  assert.ok(!('steps' in sealed) && (sealed as { waitingFor?: string }).waitingFor === 'procurement_manager'); // chain length would reveal the band
  p.table<{ id: string; status: string }>('awards').get('AW-1')!.status = 'approved';
  assert.equal((awards.get(p, U.cm, 'AW-1') as { value?: number }).value, AWARD);   // approved: value is open
  p.table<{ id: string; status: string }>('awards').get('AW-1')!.status = 'pending';
  assert.throws(() => awards.get(p, U.te, 'AW-1'), /needs one of/);
  assert.throws(() => awards.get(p, U.sup1, 'AW-1'), /needs one of/);
  assert.throws(() => awards.get(p, U.b2, 'AW-1'), /no access to project P1/);
  assert.deepEqual(ids(awards.list(p, U.cm)), ['AW-1']);
  assert.deepEqual(awards.list(p, U.b2), []);
  assert.throws(() => awards.list(p, U.sup1), /needs one of/);

  assert.deepEqual(awards.check(p, U.pm, 'AW-1'), { mine: true });
  assert.match(awards.check(p, U.bo, 'AW-1').reason!, /Awaiting procurement_manager/);
  assert.equal(awards.check(p, U.bo, 'AW-1').mine, false);
  assert.match(awards.check(p, U.cm, 'AW-1').reason!, /needs one of/);
  assert.equal(awards.check(p, { ...U.pm, id: 'boss', roles: ['procurement_manager'] }, 'AW-1').mine, false); // recommender: SoD
  assert.match(awards.check(p, { ...U.pm, id: 'boss' }, 'AW-1').reason!, /Segregation of duties/);
  assert.equal(awards.check(p, U.b1, 'AW-1').mine, false);
  assert.throws(() => awards.check(p, U.b2, 'AW-1'), /no access to project P1/);
  // check mirrors decide, and changes nothing
  const before = JSON.stringify(p.table('awards').get('AW-1'));
  awards.check(p, U.pm, 'AW-1');
  assert.equal(JSON.stringify(p.table('awards').get('AW-1')), before);
  awards.decide(p, U.pm, 'AW-1', 'approved');
  assert.deepEqual(awards.check(p, U.bo, 'AW-1'), { mine: true });
  assert.deepEqual(awards.check(p, { ...U.bo, approvalLimit: 1 }, 'AW-1'), { mine: true, reason: "bo's authority limit is below AED 1,234,567" });
});

test('sourcing: view and clarifications seal bidder, price and committee data; invitations are the supplier own', () => {
  const p = setup();
  const v = JSON.stringify(sourcing.view(p, U.pm, 'EV-1'));
  assert.ok(!v.includes('987654') && !v.includes('"bids"') && !v.includes('rate'));          // open: no prices, no bid count
  assert.deepEqual((sourcing.view(p, U.pm, 'EV-1') as { evaluators: { id: string }[] }).evaluators.map(e => e.id), ['te']);
  assert.ok('evaluators' in sourcing.view(p, U.aud, 'EV-1'));
  assert.ok(!('evaluators' in sourcing.view(p, U.cm, 'EV-1')));
  assert.equal((sourcing.view(p, U.cm, 'EV-1') as { invited: unknown[] }).invited.length, 2);
  assert.ok(!('invited' in sourcing.view(p, U.cm, 'EV-2')));                                // draft invitees: buyers and managers only
  assert.ok('invited' in sourcing.view(p, U.b2, 'EV-2'));
  assert.throws(() => sourcing.view(p, U.b1, 'EV-2'), /no access to project P2/);
  assert.throws(() => sourcing.view(p, U.sup1, 'EV-1'), /needs one of/);
  assert.throws(() => sourcing.view(p, U.te, 'EV-1'), /needs one of/);                       // evaluator before technical opens
  assert.deepEqual(sourcing.clarifications(p, U.cm, 'EV-1').map(c => c.id), ['CL-1']);             // open: unanswered text only for buyer / procurement_manager
  assert.deepEqual(sourcing.clarifications(p, U.cm, 'EV-1').map(c => c.askedBy), ['sealed']);
  assert.deepEqual(sourcing.clarifications(p, U.pm, 'EV-1').map(c => c.id), ['CL-1', 'CL-2']);
  assert.throws(() => sourcing.clarifications(p, U.sup1, 'EV-1'), /needs one of/);
  const ev = p.table<{ status: string }>('events').get('EV-1')!;
  ev.status = 'closed';
  assert.equal((sourcing.view(p, U.pm, 'EV-1') as { bids: number }).bids, 2);
  assert.ok(!JSON.stringify(sourcing.view(p, U.pm, 'EV-1')).includes('987654'));
  assert.deepEqual(sourcing.clarifications(p, U.cm, 'EV-1').map(c => c.askedBy), ['S1', 'S2']);
  assert.deepEqual(sourcing.clarifications(p, U.cm, 'EV-1').map(c => c.id), ['CL-1', 'CL-2']);
  ev.status = 'technical';
  assert.ok(!('evaluators' in sourcing.view(p, U.te, 'EV-1')) && !('invited' in sourcing.view(p, U.te, 'EV-1')));
  assert.deepEqual(sourcing.clarifications(p, U.te, 'EV-1').map(c => c.askedBy), ['sealed', 'sealed']);
  assert.throws(() => sourcing.view(p, U.ce, 'EV-1'), /needs one of/);                       // commercial evaluator waits for `commercial`
  ev.status = 'commercial';
  assert.equal(sourcing.view(p, U.ce, 'EV-1').id, 'EV-1');

  ev.status = 'open';
  assert.deepEqual(sourcing.invitations(p, U.sup1), [{ id: 'EV-1', title: 'Gens RFP', closesAt: '2027-01-01T00:00:00Z', status: 'open' }]); // EV-2 is draft
  assert.deepEqual(sourcing.invitations(p, U.sup3), []);
  assert.throws(() => sourcing.invitations(p, U.pm), /needs one of/);
});

test('suppliers and reporting: directory reads', () => {
  const p = setup();
  const s = suppliers.get(p, U.b1, 'S1');
  assert.deepEqual(s.docs.map(d => d.state), ['expiring', 'expired', 'valid']);
  assert.equal(suppliers.list(p, U.cm).length, 2);
  assert.equal(suppliers.get(p, U.pm, 'S2').sanctioned, true);
  for (const x of [U.te, U.sup1, U.req1, U.aud]) assert.throws(() => suppliers.list(p, x), /needs one of/);
  assert.throws(() => suppliers.get(p, U.sup1, 'S1'), /needs one of/);

  const names = (user: User) => reporting.people(p, user).map(x => x.id);
  assert.ok(names(U.pm).includes('te') && !names(U.pm).some(n => n.startsWith('sup')));
  assert.ok(!names(U.cm).includes('te') && names(U.cm).includes('pm'));                      // committee roster stays with those who may know it
  for (const x of [U.sup1, U.req1, U.te]) assert.throws(() => reporting.people(p, x), /needs one of/);
  assert.deepEqual(reporting.me(p, U.bo), { id: 'bo', name: 'bo', roles: ['budget_owner'], projects: ['*'], approvalLimit: 10_000_000 });
  assert.deepEqual(reporting.me(p, U.sup1).projects, []);
  for (const m of [awards, intake, sourcing, suppliers, reporting]) assert.ok(Object.keys(m.commands).length);
  assert.ok(['get', 'list', 'check'].every(k => k in awards.commands) && ['get', 'list'].every(k => k in intake.commands && k in suppliers.commands));
  assert.ok(['view', 'clarifications', 'invitations'].every(k => k in sourcing.commands) && ['people', 'me'].every(k => k in reporting.commands));
});

test('twin activity: evaluation actors are sealed for staff', () => {
  const p = setup();
  p.emit(U.te, 'score.recorded', 'EV-1'); p.emit(U.pm, 'conflict.declared', 'EV-1'); p.emit(U.pm, 'technical.opened', 'EV-1'); p.emit(U.boss, 'event.published', 'EV-1');
  const actors = Object.fromEntries(reporting.twin(p, U.cm).activity.map(a => [a.type, a.actor]));
  assert.deepEqual([actors['score.recorded'], actors['conflict.declared'], actors['technical.opened'], actors['event.published']], ['sealed', 'sealed', 'sealed', 'boss']);
});
