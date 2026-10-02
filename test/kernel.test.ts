import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditLog } from '../core/audit.ts';
import { parseCsv, toCsv } from '../core/csv.ts';
import { Platform } from '../core/kernel.ts';
import { available } from '../core/workflow.ts';

test('audit: tampering with any event breaks the chain', () => {
  const log = new AuditLog();
  log.append('u1', 'bid.submitted', 'EV-1', { total: 100 }, '2026-10-01T00:00:00Z');
  log.append('u2', 'award.approved', 'AW-1', { value: 100 }, '2026-10-02T00:00:00Z');
  assert.deepEqual(log.verify(), { ok: true });
  (log.events[0].data as { total: number }).total = 90;
  assert.deepEqual(log.verify(), { ok: false, brokenAt: 1 });
});

test('csv: quotes, commas, newlines round-trip; formulas neutralised', () => {
  const rows = [{ item: 'Panel, "MV"\nType 2', qty: 4, note: '=HYPERLINK("x")' }];
  const csv = toCsv(rows);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.deepEqual(parseCsv(csv), [{ item: 'Panel, "MV"\nType 2', qty: '4', note: `'=HYPERLINK("x")` }]);
});

test('kernel: new modules get their own tables and event subscriptions without kernel edits', () => {
  const p = new Platform({ fx: { AED: 1 }, tables: { users: [{ id: 'u1', name: 'U', roles: ['admin'], projects: ['*'] }] as never } });
  const seen: string[] = [];
  p.on('po.created', e => seen.push(e.entity));
  p.table<{ id: string }>('purchaseOrders').set('PO-1', { id: 'PO-1' });
  p.emit(p.users.get('u1')!, 'po.created', 'PO-1');
  assert.deepEqual(seen, ['PO-1']);
  assert.equal(p.get<{ id: string }>('purchaseOrders', 'PO-1').id, 'PO-1');
  assert.throws(() => p.get('purchaseOrders', 'PO-2'), /not found/);
});

test('workflow: available() returns only the actions the user can take, so the UI never shows dead buttons', () => {
  const flow = { submitted: { approve: { to: 'approved', roles: ['budget_owner' as const] }, withdraw: { to: 'draft', roles: ['requester' as const] } } };
  const user = { id: 'u', name: 'U', projects: ['*'], roles: ['budget_owner' as const] };
  assert.deepEqual(available(flow, 'submitted', user), ['approve']);
  assert.deepEqual(available(flow, 'approved', user), []);
});
