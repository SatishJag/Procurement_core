import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Award, User } from '../core/types.ts';
import { applyDecision, routeApproval } from '../modules/awards.ts';

test('approvals: DOA bands, conditional steps, sequence, segregation of duties, authority limit', () => {
  assert.deepEqual(routeApproval(400_000).map(s => s.role), ['procurement_manager']);
  assert.deepEqual(routeApproval(400_000, { overBudget: true, deviation: true }).map(s => s.role), ['procurement_manager', 'budget_owner', 'executive']);
  const award = { value: 2_000_000, status: 'pending', recommendedBy: 'buyer', steps: routeApproval(2_000_000) } as Award;
  const pm: User = { id: 'pm', name: 'PM', roles: ['procurement_manager'], projects: ['*'] };
  const bo: User = { id: 'bo', name: 'BO', roles: ['budget_owner'], projects: ['*'], approvalLimit: 1_000_000 };
  assert.throws(() => applyDecision(award, bo, 'approved', '', 't', []), /Awaiting procurement_manager/);
  assert.throws(() => applyDecision(award, pm, 'approved', '', 't', ['pm']), /Segregation of duties/);
  applyDecision(award, pm, 'approved', '', 't', []);
  assert.throws(() => applyDecision(award, bo, 'approved', '', 't', []), /authority limit/);
  assert.throws(() => applyDecision(award, bo, 'rejected', ' ', 't', []), /needs a reason/);
  applyDecision(award, bo, 'rejected', 'Over market', 't', []);
  assert.equal(award.status, 'rejected');
});
