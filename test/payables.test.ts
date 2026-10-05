import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { User } from '../core/types.ts';
import { createPlatform } from '../modules/index.ts';
import * as pay from '../modules/payables.ts';

const u = (id: string, roles: User['roles'], projects = ['P1'], extra: Partial<User> = {}): User => ({ id, name: id, roles, projects, ...extra });
const users = [
  u('pm', ['project_manager']), u('pmfin', ['project_manager', 'finance'], ['P1'], { approvalLimit: 9e9 }),
  u('fin', ['finance'], ['P1'], { approvalLimit: 5_000_000 }), u('fin2', ['finance'], ['P1'], { approvalLimit: 500_000 }),
  u('exec', ['executive'], ['*'], { approvalLimit: 50_000_000 }), u('exec2', ['executive'], ['*'], { approvalLimit: 50_000_000 }), u('exec0', ['executive'], ['*']), u('execP1', ['executive'], ['P1'], { approvalLimit: 1e9 }), u('aud', ['auditor']), u('buyer', ['buyer']), u('other', ['finance'], ['P2']), u('sup', ['supplier'], [], { supplierId: 'S1' }),
];
const U = Object.fromEntries(users.map(x => [x.id, x]));
const now = '2026-10-02T09:00:00.000Z';

function setup() {
  const p = createPlatform({
    fx: { AED: 1 },
    tables: {
      users: users as never,
      projects: [{ id: 'P1', name: 'DC1', site: 'Dubai', capacityMW: 20, budgets: { C1: 1 }, committed: {} }, { id: 'P2', name: 'DC2', site: 'AUH', capacityMW: 5, budgets: { C1: 1 }, committed: {} }] as never,
      packages: [{ id: 'PKG-1', projectId: 'P1', costCode: 'C1' }] as never,
      events: [{ id: 'EV-1', packageId: 'PKG-1' }] as never,
      awards: [{ id: 'AW-1', eventId: 'EV-1' }] as never,
      contracts: [{ id: 'CT-1', awardId: 'AW-1', supplierId: 'S1', lotIds: [], value: 10_000_000, status: 'draft' }] as never,
      suppliers: [{ id: 'S1', name: 'Alpha', status: 'qualified', sanctioned: false, docs: [], categories: [], country: 'AE', risk: 'low', performance: 1 }] as never,
    },
  }, () => now);
  pay.setTerms(p, U.fin, 'CT-1', { retentionPct: 5, retentionCap: 500_000, advanceAmount: 400_000, advanceRecoveryPct: 10, vatPct: 5, whtPct: 0, revisedValue: 10_000_000 });
  return p;
}
let n = 0;
const ipc = (over: Partial<pay.IpcInput> = {}): pay.IpcInput => ({
  messageId: `M${++n}`, ipcRef: `IPC-${n}`, version: 1, periodFrom: '2026-09-01', periodTo: '2026-09-30', taxInvoiceNo: `TAX-${n}`,
  lines: [{ boqItem: '1.1', wbs: 'W1', costCode: 'C1', description: 'Works', uom: 'ls', prevQty: 0, currQty: 1000, rate: 1000 }], variations: [],
  adjustments: { retention: 50_000, advanceRecovery: 100_000, otherDeductions: [{ type: 'backcharge', amount: 20_000 }] }, attachments: [{ type: 'ipc', name: 'ipc.pdf' }], ...over,
});
const lineOf = (amount: number) => [{ boqItem: '1.1', wbs: 'W1', costCode: 'C1', description: 'Works', uom: 'ls', prevQty: 0, currQty: 1, rate: amount }];
const staged = (p: ReturnType<typeof setup>, over?: Partial<pay.IpcInput>) => pay.stageIpc(p, U.pm, 'CT-1', ipc(over));
const toApproval = (p: ReturnType<typeof setup>, over?: Partial<pay.IpcInput>) => pay.createInvoice(p, U.fin, staged(p, over).id);

test('spec example: 1,000,000 gross nets to 871,500 payable', () => {
  const i = staged(setup());
  assert.equal(i.status, 'validated');
  assert.deepEqual(i.calc, { gross: 1_000_000, retention: 50_000, advanceRecovery: 100_000, deductions: 20_000, netBeforeTax: 830_000, vat: 41_500, wht: 0, netPayable: 871_500 });
});

test('staging: replay is idempotent; duplicate ref+version, over-value, retention and advance failures are stored, not thrown', () => {
  const p = setup();
  const a = staged(p, { messageId: 'X' });
  assert.equal(pay.stageIpc(p, U.pm, 'CT-1', ipc({ messageId: 'X' })).id, a.id);
  assert.equal(p.audit.events.filter(e => e.action === 'ipc.staged').length, 1);

  const dup = staged(p, { ipcRef: a.ipcRef, version: a.version });
  assert.equal(dup.status, 'validation_failed');
  assert.match(dup.errors.join(), /already received/);
  assert.equal(staged(p, { ipcRef: a.ipcRef, version: 2 }).status, 'validated');

  const big = staged(p, { lines: lineOf(10_000_000), adjustments: { retention: 500_000, advanceRecovery: 0 } });
  assert.match(big.errors.join(), /exceeds the revised contract value/);
  assert.match(staged(p, { adjustments: { retention: 60_000, advanceRecovery: 100_000 } }).errors.join(), /does not match the contract rule/);
  assert.match(staged(p, { adjustments: { retention: 1, otherDeductions: [{ type: '', amount: 5 }] } }).errors.join(), /deduction/);
  assert.match(staged(p, { ipcRef: '' }).errors.join(), /ipcRef is required/);
  assert.match(staged(p, { adjustments: { advanceRecovery: 150_000 } }).errors.join(), /above the contract recovery rate/);
  assert.equal(p.audit.events.filter(e => e.action === 'ipc.validation_failed').length, 6);
});

test('retention cap and advance balance are enforced against what is already pending or accounted', () => {
  const p = setup();
  pay.setTerms(p, U.fin, 'CT-1', { retentionPct: 5, retentionCap: 60_000, advanceAmount: 150_000, advanceRecoveryPct: 10, vatPct: 5, whtPct: 0, revisedValue: 10_000_000 });
  assert.equal(staged(p).status, 'validated');                              // 50,000 retained, 100,000 recovered
  const second = staged(p, { adjustments: { retention: 50_000, advanceRecovery: 100_000 } });
  assert.match(second.errors.join(), /exceeds what is left under the retention cap \(AED 10,000.00\)/);
  assert.match(second.errors.join(), /exceeds the remaining advance balance \(AED 50,000.00\)/);
  assert.equal(staged(p, { adjustments: { retention: 10_000, advanceRecovery: 50_000 } }).status, 'validated');
});

test('invoice duplicates: tax invoice number and supplier+amount+date are blocked', () => {
  const p = setup();
  pay.createInvoice(p, U.fin, staged(p, { taxInvoiceNo: 'T1', invoiceDate: '2026-10-01' }).id);
  const dupTax = staged(p, { taxInvoiceNo: 'T1' });                                // caught at staging now, so nothing is left stuck
  assert.equal(dupTax.status, 'validation_failed');
  assert.throws(() => pay.createInvoice(p, U.fin, dupTax.id), /Cannot "invoice" while validation_failed/);
  assert.throws(() => pay.createInvoice(p, U.fin, staged(p, { taxInvoiceNo: 'T2', invoiceDate: '2026-10-01' }).id), /already has an invoice for AED 871,500.00 dated 2026-10-01/);
  assert.throws(() => pay.createInvoice(p, U.fin, staged(p, { ipcRef: '', taxInvoiceNo: 'T3' }).id), /Cannot "invoice" while validation_failed/);
  assert.throws(() => pay.createInvoice(p, U.pm, staged(p).id), /needs one of/);
});

test('approval: preparer and certifier cannot approve; limit sends it to an executive; reject needs a reason', () => {
  const p = setup();
  const inv = toApproval(p);
  assert.throws(() => pay.approveInvoice(p, U.fin, inv.id), /Segregation of duties/);
  assert.throws(() => pay.approveInvoice(p, U.pm, inv.id), /needs one of/);
  assert.throws(() => pay.approveInvoice(p, U.fin2, inv.id), /authority limit/);        // 871,500 > 500,000
  assert.throws(() => pay.approveInvoice(p, U.aud, inv.id), /needs one of/);
  assert.deepEqual(pay.actions(p, U.exec, inv.id).sort(), ['approve', 'hold', 'reject']);
  assert.deepEqual(pay.actions(p, U.pm, inv.id), []);

  const certifiedByFinance = pay.stageIpc(p, U.pmfin, 'CT-1', ipc({ invoiceDate: '2026-10-03' }));          // certifier who is also finance
  const inv2 = pay.createInvoice(p, U.fin, certifiedByFinance.id);
  assert.throws(() => pay.approveInvoice(p, U.pmfin, inv2.id), /Segregation of duties/);

  assert.throws(() => pay.rejectInvoice(p, U.exec, inv.id, ' '), /needs a reason/);
  assert.equal(pay.approveInvoice(p, U.exec, inv.id, 'ok').status, 'approved');
  assert.equal(pay.rejectInvoice(p, U.exec, inv2.id, 'wrong BOQ').status, 'rejected');
  assert.equal(pay.getIpc(p, U.fin, certifiedByFinance.id).status, 'rejected');       // headroom freed, restage allowed
});

test('hold: held invoice cannot be approved or accounted; release re-opens approval', () => {
  const p = setup();
  const inv = toApproval(p);
  const h = { reason: 'Missing timesheet', ownerId: 'pm', releaseCondition: 'Timesheet attached' };
  assert.throws(() => pay.hold(p, U.exec, inv.id, { ...h, reason: '' }), /needs a reason, an owner/);
  assert.throws(() => pay.hold(p, U.exec, inv.id, { ...h, ownerId: 'nobody' }), /not found/);
  pay.hold(p, U.fin, inv.id, h);
  assert.throws(() => pay.approveInvoice(p, U.exec, inv.id), /Cannot "approve" while on_hold/);
  assert.throws(() => pay.account(p, U.fin, inv.id), /Cannot "account" while on_hold/);
  assert.deepEqual(pay.get(p, U.aud, inv.id).holds[0], { ...h, placedBy: 'fin', placedOn: '2026-10-02', releaseAuthority: 'pm, or an executive other than fin' });
  assert.throws(() => pay.releaseHold(p, U.fin, inv.id, ''), /needs a comment/);
  pay.releaseHold(p, U.pm, inv.id, 'Timesheet received');
  assert.equal(pay.get(p, U.fin, inv.id).status, 'approval_required');
  assert.equal(pay.get(p, U.fin, inv.id).holds[0].releasedBy, 'pm');
  // only the owner, or a different executive, can release; neither the placer nor other finance staff
  pay.hold(p, U.exec, inv.id, h);
  assert.throws(() => pay.releaseHold(p, U.fin, inv.id, 'try'), /Only pm, or an executive other than exec/);
  assert.throws(() => pay.releaseHold(p, U.exec, inv.id, 'self-release'), /Only pm, or an executive/);
  assert.equal(pay.releaseHold(p, U.exec2, inv.id, 'second executive').status, 'approval_required');
  assert.throws(() => pay.hold(p, U.exec, inv.id, { ...h, ownerId: 'sup' }), /cannot own a hold/);
});

test('flow: retention + advance + WHT journal balances; closed period blocks; position updates; export is one-shot', () => {
  const p = setup();
  pay.setTerms(p, U.fin, 'CT-1', { retentionPct: 5, retentionCap: 500_000, advanceAmount: 400_000, advanceRecoveryPct: 10, vatPct: 5, whtPct: 2, revisedValue: 10_000_000 });
  const inv = toApproval(p, { invoiceDate: '2026-09-30' });
  assert.equal(inv.calc.wht, 16_600);
  assert.equal(inv.calc.netPayable, 854_900);                                     // 830,000 + 41,500 - 16,600
  assert.throws(() => pay.account(p, U.fin, inv.id), /Cannot "account" while approval_required/);
  pay.approveInvoice(p, U.exec, inv.id);
  pay.setClosedThrough(p, U.exec, '2026-09-30');
  assert.throws(() => pay.setClosedThrough(p, U.exec, '2026-08-31'), /cannot be reopened/);
  assert.throws(() => pay.account(p, U.fin, inv.id), /period through 2026-09-30 is closed/);
  assert.equal(pay.get(p, U.fin, inv.id).status, 'approved');
  assert.deepEqual(pay.contractPosition(p, U.buyer, 'CT-1'), { contractId: 'CT-1', revisedValue: 10_000_000, cumulativeCertified: 0, pendingCertified: 1_000_000, remainingCommitment: 10_000_000, retentionBalance: 0, advanceBalance: 400_000 });

  // a later-dated invoice for the same position clears the closed period
  const late = pay.createInvoice(p, U.fin, staged(p, { invoiceDate: '2026-10-01' }).id);
  pay.approveInvoice(p, U.exec, late.id);
  const j = pay.account(p, U.fin, late.id);
  const dr = j.lines.reduce((a, l) => a + l.dr, 0), cr = j.lines.reduce((a, l) => a + l.cr, 0);
  assert.equal(dr, 1_041_500);
  assert.equal(cr, dr);
  assert.deepEqual(j.lines.map(l => l.account), ['1410', '1520', '2210', '1430', '4910', '2230', '2110']);
  assert.deepEqual(pay.contractPosition(p, U.aud, 'CT-1'), { contractId: 'CT-1', revisedValue: 10_000_000, cumulativeCertified: 1_000_000, pendingCertified: 1_000_000, remainingCommitment: 9_000_000, retentionBalance: 50_000, advanceBalance: 300_000 });
  assert.deepEqual(pay.ipcStatus(p, U.pm, late.ipcId), { ipcId: late.ipcId, ipcRef: pay.getIpc(p, U.pm, late.ipcId).ipcRef, version: 1, status: 'accounted', errors: [], invoiceId: late.id, invoiceStatus: 'accounted' });

  assert.throws(() => pay.exportJournals(p, U.exec), /needs one of/);
  assert.equal(pay.exportJournals(p, U.other).count, 0);                           // no access to P1 journals
  const batch = pay.exportJournals(p, U.fin);
  assert.equal(batch.count, 1);
  assert.match(batch.csv, new RegExp(`${late.id},${late.ipcId},CT-1,P1`));
  assert.equal(pay.exportJournals(p, U.fin).count, 0);                             // never re-exports
  assert.equal(pay.exportJournals(p, U.fin).csv, '');
  assert.equal(p.audit.events.filter(e => e.action === 'journals.transferred').length, 1);
  assert.deepEqual(p.audit.verify(), { ok: true });
});

test('unbalanced journal is refused', () => {
  assert.throws(() => pay.journalLines({ gross: 100, retention: 0, advanceRecovery: 0, deductions: 0, netBeforeTax: 100, vat: 5, wht: 0, netPayable: 100 }), /does not balance/);
});

test('reads and commands are project-scoped; suppliers and other projects are refused', () => {
  const p = setup();
  const i = staged(p), inv = pay.createInvoice(p, U.fin, i.id);
  assert.equal(pay.get(p, U.buyer, inv.id).id, inv.id);
  assert.deepEqual(pay.list(p, U.aud).map(x => x.id), [inv.id]);
  assert.deepEqual(pay.list(p, U.other), []);
  for (const fn of [() => pay.get(p, U.other, inv.id), () => pay.getIpc(p, U.other, i.id), () => pay.ipcStatus(p, U.other, i.id), () => pay.contractPosition(p, U.other, 'CT-1'),
    () => pay.actions(p, U.other, inv.id), () => pay.stageIpc(p, u('pm2', ['project_manager'], ['P2']), 'CT-1', ipc()), () => pay.setTerms(p, U.other, 'CT-1', {} as never)]) {
    assert.throws(fn, /no access to project P1/);
  }
  assert.throws(() => pay.get(p, U.sup, inv.id), /needs one of/);
  assert.throws(() => pay.list(p, U.sup), /needs one of/);
  assert.throws(() => pay.stageIpc(p, U.fin, 'CT-1', ipc()), /needs one of/);
  assert.throws(() => pay.stageIpc(p, U.pm, 'CT-1', { ...ipc(), messageId: '' }), /messageId is required/);
  assert.deepEqual(Object.keys(pay.commands).includes('journalLines'), false);
});

test('QA 1: setTerms never accepts engine counters from the caller', () => {
  const p = setup();
  const t = { retentionPct: 5, retentionCap: 500_000, advanceAmount: 400_000, advanceRecoveryPct: 10, vatPct: 5, whtPct: 0, revisedValue: 10_000_000 };
  const row = pay.setTerms(p, U.fin, 'CT-1', { ...t, certified: 9e9, retained: 9e9, advanceRecovered: 9e9, id: 'X' } as never);
  assert.deepEqual([row.id, row.certified, row.retained, row.advanceRecovered], ['CT-1', 0, 0, 0]);
  assert.equal(pay.contractPosition(p, U.fin, 'CT-1').remainingCommitment, 10_000_000);
});

test('QA 2: only an all-project executive closes a period, never beyond today', () => {
  const p = setup();
  assert.throws(() => pay.setClosedThrough(p, U.fin, '2026-09-30'), /needs one of: executive/);
  assert.throws(() => pay.setClosedThrough(p, U.execP1, '2026-09-30'), /all projects/);
  assert.throws(() => pay.setClosedThrough(p, U.exec, '2026-10-03'), /beyond today/);
  assert.throws(() => pay.setClosedThrough(p, U.exec, '2026-02-31'), /YYYY-MM-DD/);
  assert.equal(pay.setClosedThrough(p, U.exec, '2026-10-02'), '2026-10-02');
});

test('QA 3 and 7: unknown fields are not stored; malformed elements are stored errors and burn no id', () => {
  const p = setup();
  const a = staged(p, { invoiceId: 'INV-9', status: 'accounted', calc: { netPayable: 1 } } as never);
  assert.equal(a.invoiceId, undefined);
  assert.equal(a.status, 'validated');
  assert.equal((a as unknown as { calc: { netPayable: number } }).calc.netPayable, 871_500);
  for (const bad of [{ lines: [null] }, { lines: ['x'] }, { variations: [null] }, { variations: 'v' }, { attachments: [null] }, { adjustments: null }, { adjustments: { otherDeductions: [null] } }, { adjustments: 5 }] as never[]) {
    assert.equal(staged(p, bad).status, 'validation_failed');
  }
  const seq = () => Number(p.id('PROBE').split('-')[1]);
  const before = seq();
  assert.throws(() => pay.stageIpc(p, U.pm, 'CT-1', null as never), /messageId is required/);
  assert.equal(seq(), before + 1);                                               // a refused payload burns no id
});

test('QA 4: duplicate tax invoice fails at staging (normalised); withdrawIpc frees headroom', () => {
  const p = setup();
  const first = staged(p, { taxInvoiceNo: 'TX-1' });
  const dup = staged(p, { taxInvoiceNo: '  tx-1 ' });
  assert.equal(dup.status, 'validation_failed');
  assert.match(dup.errors.join(), /already on file/);
  assert.throws(() => pay.withdrawIpc(p, U.pm, first.id, ' '), /needs a reason/);
  assert.throws(() => pay.withdrawIpc(p, U.sup, first.id, 'x'), /needs one of/);
  assert.equal(pay.contractPosition(p, U.fin, 'CT-1').pendingCertified, 1_000_000);
  assert.equal(pay.withdrawIpc(p, U.pm, first.id, 'certified in error').status, 'withdrawn');
  assert.equal(pay.contractPosition(p, U.fin, 'CT-1').pendingCertified, 0);
  assert.equal(staged(p, { taxInvoiceNo: 'TX-1' }).status, 'validated');            // number is free again
  assert.throws(() => pay.createInvoice(p, U.fin, first.id), /Cannot "invoice" while withdrawn/);
  assert.throws(() => pay.withdrawIpc(p, U.pm, first.id, 'again'), /Cannot "withdraw" while withdrawn/);
  const inv = pay.createInvoice(p, U.fin, staged(p).id);
  assert.throws(() => pay.withdrawIpc(p, U.pm, inv.ipcId, 'late'), /Cannot "withdraw" while invoiced/);
});

test('QA 5: terms are frozen while IPCs are open; revisedValue is bounded', () => {
  const p = setup();
  const t = { retentionPct: 5, retentionCap: 500_000, advanceAmount: 400_000, advanceRecoveryPct: 10, vatPct: 5, whtPct: 0, revisedValue: 10_000_000 };
  const open = staged(p);
  assert.throws(() => pay.setTerms(p, U.fin, 'CT-1', { ...t, retentionPct: 1 }), /cannot change while/);
  assert.throws(() => pay.setTerms(p, U.fin, 'CT-1', { ...t, revisedValue: 999_999 }), /below the AED 1,000,000.00 already certified or in process/);
  assert.throws(() => pay.setTerms(p, U.fin, 'CT-1', { ...t, revisedValue: 10_000_001 }), /needs a variation reference/);
  pay.setTerms(p, U.fin, 'CT-1', { ...t, revisedValue: 10_500_000, variationRef: 'VO-7' });
  assert.equal(p.audit.events.filter(e => e.action === 'contract.terms_set').at(-1)!.data && (p.audit.events.filter(e => e.action === 'contract.terms_set').at(-1)!.data as { variationRef: string }).variationRef, 'VO-7');
  pay.withdrawIpc(p, U.pm, open.id, 'reset');
  pay.setTerms(p, U.fin, 'CT-1', { ...t, retentionPct: 1, revisedValue: 10_500_000 });  // nothing open: allowed
  // account re-checks the cap even if the stored terms were tampered with
  const inv = pay.createInvoice(p, U.fin, staged(p, { adjustments: { retention: 10_000, advanceRecovery: 100_000, otherDeductions: [] } }).id);
  pay.approveInvoice(p, U.exec, inv.id);
  p.table<pay.Terms>('contract_terms').get('CT-1')!.retentionCap = 5_000;
  assert.throws(() => pay.account(p, U.fin, inv.id), /retention past the cap/);
  p.table<pay.Terms>('contract_terms').get('CT-1')!.retentionCap = 500_000;
  p.table<pay.Terms>('contract_terms').get('CT-1')!.advanceAmount = 50_000;
  assert.throws(() => pay.account(p, U.fin, inv.id), /more than the AED 50,000.00 advance/);
});

test('QA 6: no approvalLimit means no authority, executives included', () => {
  const p = setup();
  const inv = toApproval(p);
  assert.throws(() => pay.approveInvoice(p, U.exec0, inv.id), /authority limit/);
  assert.equal(pay.approveInvoice(p, U.exec, inv.id).status, 'approved');
});

test('QA 9: only the hold owner or another executive releases', () => {
  const p = setup();
  const inv = toApproval(p);
  pay.hold(p, U.fin, inv.id, { reason: 'r', ownerId: 'buyer', releaseCondition: 'c' });
  assert.throws(() => pay.releaseHold(p, U.fin, inv.id, 'placer'), /Only buyer, or an executive/);
  assert.throws(() => pay.releaseHold(p, U.fin2, inv.id, 'other finance'), /Only buyer/);
  assert.throws(() => pay.releaseHold(p, U.buyer, inv.id, '  '), /needs a comment/);
  assert.equal(pay.releaseHold(p, U.buyer, inv.id, 'condition met').status, 'approval_required');
});

test('QA 10: zero gross and impossible dates fail validation', () => {
  const p = setup();
  assert.match(staged(p, { lines: lineOf(0), adjustments: { retention: 0, advanceRecovery: 0 } }).errors.join(), /must be above zero/);
  assert.match(staged(p, { periodTo: '2026-02-31' }).errors.join(), /real ISO dates/);
  assert.match(staged(p, { invoiceDate: '2026-13-01' }).errors.join(), /invoiceDate must be a real/);
});

test('QA 11: getBatch returns the CSV of a transferred batch, scoped and role-guarded', () => {
  const p = setup();
  const inv = toApproval(p);
  pay.approveInvoice(p, U.exec, inv.id);
  pay.account(p, U.fin, inv.id);
  const b = pay.exportJournals(p, U.fin);
  assert.deepEqual(pay.getBatch(p, U.aud, b.batchId!), b);
  assert.throws(() => pay.getBatch(p, U.other, b.batchId!), /not found/);
  assert.throws(() => pay.getBatch(p, U.buyer, b.batchId!), /needs one of/);
  assert.throws(() => pay.getBatch(p, U.fin, 'GL-9999'), /not found/);
});

test('QA 12: message ids are scoped to the contract and a clash elsewhere is neutral', () => {
  const p = setup();
  p.table('contracts').set('CT-2', { id: 'CT-2', awardId: 'AW-1', supplierId: 'S1', lotIds: [], value: 1, status: 'draft' });
  staged(p, { messageId: 'SHARED' });
  assert.throws(() => pay.stageIpc(p, U.pm, 'CT-2', ipc({ messageId: 'SHARED' })), (e: Error) => e.message === 'Message id already used');
});
