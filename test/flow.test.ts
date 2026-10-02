import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Contract } from '../core/types.ts';
import { awards, sourcing } from '../modules/index.ts';
import { run } from '../sample/demo.ts';

const quiet = () => {};

test('end-to-end: intake to awarded contracts, audit chain intact', () => {
  const { p, ev, award, result } = run(quiet);
  assert.equal(ev.status, 'awarded');
  assert.equal(award.status, 'approved');
  assert.deepEqual(result.ranking.map(r => r.supplierId), ['SUP-MER', 'SUP-NWD', 'SUP-FAL']); // Al Noor below threshold
  assert.equal(award.value, 35_447_750);
  assert.equal(p.projects.get('DC1')!.committed['26-32-00'], 35_447_750);
  assert.equal(p.table<Contract>('contracts').size, 2); // drafted by the award.approved subscriber
  assert.deepEqual(p.audit.verify(), { ok: true });
  assert.deepEqual(awards.actions(p, p.users.get('u-rashid')!, award.id), []);          // decided: no buttons left
  assert.deepEqual(sourcing.actions(p, p.users.get('u-priya')!, ev.id), []);            // awarded is terminal
});
