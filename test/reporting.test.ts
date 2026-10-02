import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Platform } from '../core/kernel.ts';
import type { User } from '../core/types.ts';
import { commands, dashboard, twin } from '../modules/reporting.ts';

const user = (id: string, roles: User['roles'], projects = ['*']): User => ({ id, name: id, roles, projects });
const buyer = user('buyer', ['buyer']), p1buyer = user('b1', ['buyer'], ['P1']), p2buyer = user('b2', ['buyer'], ['P2']);

const sched = { milestones: [{ name: 'RFx issue', date: '2027-01-01' }], floatDays: 90, health: 'on_track' };
const pkg = (id: string, projectId: string, status = 'sourcing') => ({ id, projectId, costCode: 'C1', title: id, category: 'Electrical', estimate: 1000, route: 'RFP', schedule: sched, status });
const bid = (supplierId: string, a: number, b: number) => ({ supplierId, currency: 'AED', exclusions: [], deviations: [], lines: [{ lineId: 'A', rate: a, amount: a * 10 }, { lineId: 'B', rate: b, amount: b }] });
const evt = (id: string, packageId: string, status: string, bids: unknown[]) => ({ id, packageId, type: 'RFP', title: id, status, invited: ['S1', 'S2'], bids, scores: [{ evaluatorId: 'e1', supplierId: 'S1', criterionId: 'Q', score: 87.5 }] });

function setup() {
  const p = new Platform({
    fx: { AED: 1 },
    tables: {
      projects: [{ id: 'P1', name: 'DC1', site: 'Dubai', capacityMW: 20, budgets: { C1: 5000 }, committed: { C1: 4800 } }, { id: 'P2', name: 'DC2', site: 'Abu Dhabi', capacityMW: 10, budgets: { C1: 900 }, committed: {} }] as never,
      packages: [pkg('PKG-1', 'P1'), pkg('PKG-2', 'P2')] as never,
      // S1 total 2 x 1234.56 + 777.77 = distinctive sealed prices; EVT-1 still sealed (open)
      events: [evt('EVT-1', 'PKG-1', 'open', [bid('S1', 123.456, 777.77), bid('S2', 200, 5)]), evt('EVT-2', 'PKG-2', 'open', [])] as never,
      suppliers: [
        { id: 'S1', name: 'Alpha', country: 'AE', categories: ['Electrical'], status: 'invited', docs: [], risk: 'low', sanctioned: false, performance: 80 },
        { id: 'S2', name: 'Beta', country: 'AE', categories: ['Electrical'], status: 'qualified', docs: [], risk: 'medium', sanctioned: false, performance: 70 },
        { id: 'S3', name: 'Gamma', country: 'AE', categories: ['Civil'], status: 'registered', docs: [{ type: 'trade_licence', expires: '2026-10-10' }], risk: 'high', sanctioned: false, performance: 50 },
      ] as never,
      awards: [{ id: 'AW-1', eventId: 'EVT-2', scenario: 'best', allocations: [], value: 888, status: 'approved', steps: [] }] as never,
      contracts: [{ id: 'CT-1', awardId: 'AW-1', supplierId: 'S3', lotIds: [], value: 888, status: 'draft' }] as never,
    },
  }, () => '2026-10-02T09:00:00.000Z');
  for (let i = 0; i < 30; i++) p.emit(i % 2 ? buyer : p2buyer, i === 20 ? 'bid.submitted' : 'package.created', i === 20 ? 'EVT-1' : 'PKG-1', { seal: 'x' });
  p.emit(buyer, 'award.decision', 'PKG-2', {}); // other project's entity
  return p;
}

test('twin: shape, edges resolve, sealed event exposes no prices or scores, activity newest first', () => {
  const p = setup();
  const t = twin(p, buyer);
  const ids = new Set(t.nodes.map(n => n.id));
  assert.equal(ids.size, t.nodes.length);
  assert.ok(t.edges.length && t.edges.every(e => ids.has(e.from) && ids.has(e.to)));
  const kinds = (k: string) => t.edges.filter(e => e.kind === k).length;
  assert.deepEqual(['project-budget', 'budget-package', 'package-event', 'event-supplier', 'event-award', 'award-contract', 'contract-supplier'].map(kinds), [2, 2, 2, 4, 1, 1, 1]);
  assert.deepEqual(t.nodes.find(n => n.id === 'P1:C1'), { id: 'P1:C1', kind: 'budget', label: 'C1', value: 200, health: 'at_risk', meta: { committed: 4800, total: 5000 } });
  assert.deepEqual(t.nodes.find(n => n.id === 'EVT-1')!.meta, { type: 'RFP', bids: 2 });
  assert.ok(!ids.has('S4') && t.nodes.some(n => n.id === 'S3'));               // linked by contract though unqualified
  const json = JSON.stringify(t);
  for (const sealed of ['123.456', '777.77', '1234.56', '87.5', 'rate', 'score', 'lines', 'normalised']) assert.ok(!json.includes(sealed), sealed);
  assert.ok(t.activity.find(a => a.type === 'bid.submitted')?.actor === 'sealed');
  assert.equal(t.activity.length, 25);
  assert.ok(t.activity.every((a, i) => !i || t.activity[i - 1].at >= a.at));
  assert.equal(t.activity[0].type, 'award.decision');
  assert.deepEqual(p.audit.events.length, 31); // read-only: nothing emitted
});

test('twin: project scope, role guard, exposed as a command', () => {
  const p = setup();
  const t = twin(p, p1buyer);
  assert.ok(t.nodes.every(n => !/P2|PKG-2|EVT-2|AW-1|CT-1/.test(n.id) && n.id !== 'S3'));
  assert.ok(t.activity.every(a => !/PKG-2|EVT-2/.test(a.ref)));
  assert.equal(twin(p, p2buyer).nodes.some(n => n.id === 'CT-1'), true);
  for (const r of ['supplier', 'technical_evaluator', 'requester'] as const) assert.throws(() => twin(p, user('x', [r])), /needs one of/);
  assert.equal(commands.twin, twin);
});

test('dashboard: supplier-portal users are blocked, internal roles still work', () => {
  const p = setup();
  assert.throws(() => dashboard(p, user('s', ['supplier'], [])), /internal role/);
  assert.ok(dashboard(p, user('b', ['buyer'])).pipeline);
});
