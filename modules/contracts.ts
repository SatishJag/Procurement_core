import type { Handler } from '../core/kernel.ts';
import type { Award, Contract } from '../core/types.ts';

// Contract handoff. Phase 2 (contract lifecycle management) grows from here.

// Subscribed to award.approved: one draft contract per awarded allocation.
export const draftFromAward: Handler = (e, p) => {
  const award = p.get<Award>('awards', e.entity);
  const ids = award.allocations.map(a => {
    const c: Contract = { id: p.id('CT'), awardId: award.id, supplierId: a.supplierId, lotIds: a.lotIds, value: a.value, status: 'draft' };
    p.table<Contract>('contracts').set(c.id, c);
    return c.id;
  });
  p.emit(p.get('users', e.actor), 'contract.drafted', award.id, { contracts: ids });
};
