import { toCsv } from '../core/csv';
import type { Platform } from '../core/kernel';
import type { Award, Contract, Role, SourcingEvent, Supplier, User } from '../core/types';
import { available, type Flow, guard, next } from '../core/workflow';
import { projectOf } from './sourcing';

// Construction accounts payable, phase 1: certified IPC -> AP invoice -> approval -> subledger journal -> GL export.
// One IPC = one invoice (Option A). AED only; no payments, bank or tax-rule engine yet.

const FIN: Role[] = ['finance'];
const APPROVERS: Role[] = ['finance', 'executive'];
const READERS: Role[] = ['finance', 'executive', 'project_manager', 'auditor', 'buyer', 'procurement_manager'];

// ponytail: fixed chart of accounts, move to a finance-owned mapping table when the ERP chart is known.
const ACCT = {
  wip: ['1410', 'Project WIP'], inputTax: ['1520', 'Recoverable Input Tax'], retention: ['2210', 'Retention Payable'],
  advance: ['1430', 'Contractor Advance'], deductions: ['4910', 'Deductions Recovery'], wht: ['2230', 'WHT Payable'], ap: ['2110', 'AP Liability'],
} as const;

export interface Terms {
  id: string; // contract id
  retentionPct: number; retentionCap: number; advanceAmount: number; advanceRecoveryPct: number; vatPct: number; whtPct: number; revisedValue: number;
  certified: number; retained: number; advanceRecovered: number; // accounted position
}
export type TermsInput = Omit<Terms, 'id' | 'certified' | 'retained' | 'advanceRecovered'>;
export interface IpcLine { boqItem: string; wbs: string; costCode: string; description: string; uom: string; prevQty: number; currQty: number; rate: number }
export interface IpcInput {
  messageId: string; ipcRef: string; version: number; periodFrom: string; periodTo: string; taxInvoiceNo?: string; invoiceDate?: string;
  lines: IpcLine[]; variations: { ref: string; amount: number }[];
  // retention and advanceRecovery are what the certifier states; when omitted the contract rule applies.
  adjustments: { materialOnSite?: number; retention?: number; advanceRecovery?: number; otherDeductions?: { type: string; amount: number }[] };
  attachments: { type: string; name: string }[];
}
export interface Calc { gross: number; retention: number; advanceRecovery: number; deductions: number; netBeforeTax: number; vat: number; wht: number; netPayable: number }
export interface Ipc extends IpcInput {
  id: string; contractId: string; projectId: string; supplierId: string; certifiedBy: string; stagedAt: string;
  status: 'staged' | 'validated' | 'validation_failed' | 'invoiced' | 'rejected' | 'accounted'; errors: string[]; calc?: Calc; invoiceId?: string;
}
export interface Hold { reason: string; ownerId: string; placedBy: string; placedOn: string; releaseCondition: string; releaseAuthority: Role; releasedBy?: string; releasedOn?: string; releaseComment?: string }
export interface Invoice {
  id: string; ipcId: string; contractId: string; projectId: string; supplierId: string; taxInvoiceNo?: string; invoiceDate: string; calc: Calc;
  status: 'draft' | 'validated' | 'approval_required' | 'approved' | 'accounted' | 'on_hold' | 'rejected';
  preparedBy: string; certifiedBy: string; approvedBy?: string; approvalComment?: string; rejectedReason?: string; holds: Hold[]; journalId?: string;
}
export interface Journal {
  id: string; invoiceId: string; ipcId: string; contractId: string; projectId: string; date: string;
  lines: { account: string; name: string; dr: number; cr: number }[]; status: 'pending_transfer' | 'transferred'; batchId?: string;
}

export const ipcFlow: Flow = {
  staged: { validate: { to: 'validated', roles: ['project_manager'] }, fail: { to: 'validation_failed', roles: ['project_manager'] } },
  validated: { invoice: { to: 'invoiced', roles: FIN } },
  invoiced: { reject: { to: 'rejected', roles: APPROVERS }, account: { to: 'accounted', roles: FIN } },
};
// Held invoices go back to approval_required on release, so a hold always forces a fresh approval.
export const invoiceFlow: Flow = {
  draft: { validate: { to: 'validated', roles: FIN } },
  validated: { submit: { to: 'approval_required', roles: FIN } },
  approval_required: { approve: { to: 'approved', roles: APPROVERS }, reject: { to: 'rejected', roles: APPROVERS }, hold: { to: 'on_hold', roles: APPROVERS } },
  approved: { account: { to: 'accounted', roles: FIN }, hold: { to: 'on_hold', roles: APPROVERS } },
  on_hold: { release: { to: 'approval_required', roles: APPROVERS } },
};
const journalFlow: Flow = { pending_transfer: { export: { to: 'transferred', roles: FIN } } };

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
const aed = (n: number) => `AED ${n.toLocaleString('en', { minimumFractionDigits: 2 })}`;
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

const tbl = {
  terms: (p: Platform) => p.table<Terms>('contract_terms'), ipcs: (p: Platform) => p.table<Ipc>('ap_ipcs'),
  invoices: (p: Platform) => p.table<Invoice>('ap_invoices'), journals: (p: Platform) => p.table<Journal>('ap_journals'),
  settings: (p: Platform) => p.table<{ id: string; closedThrough: string }>('ap_settings'),
};
const closedThrough = (p: Platform) => tbl.settings(p).get('cfg')?.closedThrough ?? '';

// contract -> award -> event -> package gives the project every guard scopes on.
function contractOf(p: Platform, id: string) {
  const contract = p.get<Contract>('contracts', id);
  const ev = p.get<SourcingEvent>('events', p.get<Award>('awards', contract.awardId).eventId);
  return { contract, projectId: projectOf(p, ev) };
}

// IPCs staged or invoiced but not yet accounted still consume contract headroom, retention cap and advance balance.
const pending = (p: Platform, contractId: string, except = '') => [...tbl.ipcs(p).values()].filter(i => i.contractId === contractId && i.id !== except && (i.status === 'validated' || i.status === 'invoiced'));

// Pure: technical layer. Returns the first-layer errors; later layers need well-formed input.
export function technicalErrors(i: IpcInput): string[] {
  const e: string[] = [];
  for (const k of ['ipcRef'] as const) if (!text(i[k])) e.push(`${k} is required`);
  if (!Number.isInteger(i.version) || i.version < 1) e.push('version must be a whole number from 1');
  if (!isDate(i.periodFrom) || !isDate(i.periodTo)) e.push('periodFrom and periodTo must be ISO dates');
  else if (i.periodFrom > i.periodTo) e.push('periodFrom is after periodTo');
  if (i.invoiceDate !== undefined && !isDate(i.invoiceDate)) e.push('invoiceDate must be an ISO date');
  if (!Array.isArray(i.lines) || !i.lines.length) e.push('At least one IPC line is required');
  else i.lines.forEach((l, n) => {
    if (![l.boqItem, l.wbs, l.costCode, l.uom].every(text)) e.push(`Line ${n + 1}: boqItem, wbs, costCode and uom are required`);
    if (![l.prevQty, l.currQty, l.rate].every(num) || l.prevQty < 0 || l.currQty < 0 || l.rate < 0) e.push(`Line ${n + 1}: quantities and rate must be numbers, not negative`);
  });
  if (!Array.isArray(i.variations) || i.variations.some(v => !text(v.ref) || !num(v.amount))) e.push('Each variation needs a ref and a numeric amount');
  const a = i.adjustments;
  if (!a || typeof a !== 'object') e.push('adjustments is required');
  else for (const k of ['materialOnSite', 'retention', 'advanceRecovery'] as const) if (a[k] !== undefined && (!num(a[k]) || a[k] < 0)) e.push(`${k} must be a number, not negative`);
  if (a?.otherDeductions !== undefined && (!Array.isArray(a.otherDeductions) || a.otherDeductions.some(d => !text(d.type) || !num(d.amount) || d.amount <= 0))) e.push('Every deduction needs a type and a positive amount');
  if (!Array.isArray(i.attachments)) e.push('attachments is required');
  return e;
}

// Pure: the spec arithmetic, rounded per line. Material on site counts as certified work.
export function compute(i: IpcInput, t: Terms, retainedSoFar: number, recoveredSoFar: number) {
  const gross = sum([...i.lines.map(l => r2(l.currQty * l.rate)), ...i.variations.map(v => r2(v.amount)), r2(i.adjustments.materialOnSite ?? 0)]);
  const capLeft = Math.max(0, r2(t.retentionCap - retainedSoFar));
  const advLeft = Math.max(0, r2(t.advanceAmount - recoveredSoFar));
  const rule = { retention: Math.min(r2(gross * t.retentionPct / 100), capLeft), advance: Math.min(r2(gross * t.advanceRecoveryPct / 100), advLeft) };
  const retention = r2(i.adjustments.retention ?? rule.retention), advanceRecovery = r2(i.adjustments.advanceRecovery ?? rule.advance);
  const deductions = sum((i.adjustments.otherDeductions ?? []).map(d => d.amount));
  const netBeforeTax = r2(gross - retention - advanceRecovery - deductions);
  const vat = r2(netBeforeTax * t.vatPct / 100), wht = r2(netBeforeTax * t.whtPct / 100);
  const calc: Calc = { gross, retention, advanceRecovery, deductions, netBeforeTax, vat, wht, netPayable: r2(netBeforeTax + vat - wht) };
  return { calc, capLeft, advLeft, rule };
}

// Balanced subledger journal; throws if debits and credits differ.
export function journalLines(c: Calc) {
  const L = (k: keyof typeof ACCT, dr: number, cr: number) => ({ account: ACCT[k][0], name: ACCT[k][1], dr, cr });
  const lines = [L('wip', c.gross, 0), L('inputTax', c.vat, 0), L('retention', 0, c.retention), L('advance', 0, c.advanceRecovery),
    L('deductions', 0, c.deductions), L('wht', 0, c.wht), L('ap', 0, c.netPayable)].filter(l => l.dr || l.cr);
  if (sum(lines.map(l => l.dr)) !== sum(lines.map(l => l.cr))) throw new Error('Journal does not balance: debits differ from credits, so nothing was accounted');
  return lines;
}

export function setTerms(p: Platform, user: User, contractId: string, t: TermsInput) {
  const { projectId } = contractOf(p, contractId);
  guard(user, FIN, { projectId });
  const pct = (n: number) => num(n) && n >= 0 && n <= 100;
  if (!pct(t.retentionPct) || !pct(t.advanceRecoveryPct) || !pct(t.vatPct) || !pct(t.whtPct)) throw new Error('Percentages must be between 0 and 100');
  if (![t.retentionCap, t.advanceAmount].every(n => num(n) && n >= 0) || !num(t.revisedValue) || t.revisedValue <= 0) throw new Error('Retention cap and advance must not be negative, and the revised contract value must be above zero');
  const old = tbl.terms(p).get(contractId);
  if (old?.certified) {
    if ((['retentionPct', 'retentionCap', 'advanceAmount', 'advanceRecoveryPct', 'vatPct', 'whtPct'] as const).some(k => t[k] !== old[k])) throw new Error('Only the revised contract value can change once certified work has been accounted');
  }
  if (old && t.revisedValue < old.certified) throw new Error(`Revised value is below the ${aed(old.certified)} already certified`);
  const row: Terms = { certified: 0, retained: 0, advanceRecovered: 0, ...old, ...t, id: contractId };
  tbl.terms(p).set(contractId, row);
  p.emit(user, 'contract.terms_set', contractId, t);
  return row;
}

export function setClosedThrough(p: Platform, user: User, date: string) {
  guard(user, FIN);
  if (!isDate(date)) throw new Error('Enter the closed-through date as YYYY-MM-DD');
  // ponytail: periods only close forward; reopening needs its own authorised command.
  if (date < closedThrough(p)) throw new Error(`Periods are already closed through ${closedThrough(p)} and cannot be reopened here`);
  tbl.settings(p).set('cfg', { id: 'cfg', closedThrough: date });
  p.emit(user, 'period.closed', 'cfg', { closedThrough: date });
  return date;
}

// Integration staging. Business failures are stored on the IPC (status validation_failed + errors), not thrown.
export function stageIpc(p: Platform, user: User, contractId: string, input: IpcInput) {
  const { contract, projectId } = contractOf(p, contractId);
  guard(user, ['project_manager'], { projectId });
  if (!text(input?.messageId)) throw new Error('messageId is required so a resend can be recognised');
  const seen = [...tbl.ipcs(p).values()].find(i => i.messageId === input.messageId);
  if (seen) {
    if (seen.contractId !== contractId) throw new Error(`messageId ${input.messageId} was already used for another contract`);
    return seen; // idempotent replay: no second IPC, no second event
  }
  const ipc: Ipc = { ...structuredClone(input), id: p.id('IPC'), contractId, projectId, supplierId: contract.supplierId, certifiedBy: user.id, stagedAt: p.clock(), status: 'staged', errors: technicalErrors(input) };
  const errors = ipc.errors;
  const terms = tbl.terms(p).get(contractId);
  if (!errors.length) {
    const supplier = p.get<Supplier>('suppliers', contract.supplierId);
    if (supplier.status !== 'qualified' || supplier.sanctioned) errors.push(`Supplier ${supplier.name} is ${supplier.sanctioned ? 'sanctioned' : supplier.status}, so no IPC can be processed`);
    // ponytail: Contract.status is only 'draft' today, so "contract is live" means finance has set its terms; add a status check when contracts gain execution states.
    if (!terms) errors.push('The contract has no financial terms yet: finance must set them first');
    const budgets = p.get<{ budgets: Record<string, number> }>('projects', projectId).budgets;
    for (const l of ipc.lines) if (!(l.costCode in budgets)) errors.push(`Cost code ${l.costCode} is not in the project budget`);
  }
  if (!errors.length && terms) {
    const open = pending(p, contractId);
    const { calc, capLeft, advLeft, rule } = compute(ipc, terms, terms.retained + sum(open.map(i => i.calc!.retention)), terms.advanceRecovered + sum(open.map(i => i.calc!.advanceRecovery)));
    ipc.calc = calc;
    const cumulative = sum([terms.certified, ...open.map(i => i.calc!.gross), calc.gross]);
    if (cumulative > terms.revisedValue) errors.push(`Cumulative certified ${aed(cumulative)} exceeds the revised contract value ${aed(terms.revisedValue)}`);
    if ([...tbl.ipcs(p).values()].some(i => i.contractId === contractId && i.ipcRef === ipc.ipcRef && i.version === ipc.version && ['validated', 'invoiced', 'accounted'].includes(i.status))) errors.push(`IPC ${ipc.ipcRef} version ${ipc.version} was already received`);
    if (calc.retention > capLeft) errors.push(`Retention ${aed(calc.retention)} exceeds what is left under the retention cap (${aed(capLeft)})`);
    else if (calc.retention !== rule.retention) errors.push(`Retention ${aed(calc.retention)} does not match the contract rule (${aed(rule.retention)})`);
    if (calc.advanceRecovery > advLeft) errors.push(`Advance recovery ${aed(calc.advanceRecovery)} exceeds the remaining advance balance (${aed(advLeft)})`);
    else if (calc.advanceRecovery > r2(calc.gross * terms.advanceRecoveryPct / 100)) errors.push(`Advance recovery ${aed(calc.advanceRecovery)} is above the contract recovery rate of ${terms.advanceRecoveryPct}%`);
    if (calc.netBeforeTax < 0) errors.push('Deductions exceed the certified amount');
  }
  ipc.status = next(ipcFlow, 'staged', errors.length ? 'fail' : 'validate', user) as Ipc['status'];
  tbl.ipcs(p).set(ipc.id, ipc);
  p.emit(user, 'ipc.staged', ipc.id, { contractId, ipcRef: ipc.ipcRef, version: ipc.version, messageId: ipc.messageId });
  if (errors.length) p.emit(user, 'ipc.validation_failed', ipc.id, { errors });
  return ipc;
}

export function createInvoice(p: Platform, user: User, ipcId: string) {
  const ipc = p.get<Ipc>('ap_ipcs', ipcId);
  guard(user, FIN, { projectId: ipc.projectId });
  const to = next(ipcFlow, ipc.status, 'invoice', user) as Ipc['status']; // failed or already-invoiced IPCs stop here
  const calc = ipc.calc!, date = ipc.invoiceDate ?? p.today;
  const live = [...tbl.invoices(p).values()].filter(i => i.supplierId === ipc.supplierId && i.status !== 'rejected');
  if (ipc.taxInvoiceNo && live.some(i => i.taxInvoiceNo === ipc.taxInvoiceNo)) throw new Error(`Tax invoice ${ipc.taxInvoiceNo} is already on file for this supplier`);
  if (live.some(i => i.calc.netPayable === calc.netPayable && i.invoiceDate === date)) throw new Error(`This supplier already has an invoice for ${aed(calc.netPayable)} dated ${date}`);
  ipc.status = to;
  const inv: Invoice = {
    id: p.id('INV'), ipcId, contractId: ipc.contractId, projectId: ipc.projectId, supplierId: ipc.supplierId, taxInvoiceNo: ipc.taxInvoiceNo, invoiceDate: date, calc,
    status: 'draft', preparedBy: user.id, certifiedBy: ipc.certifiedBy, holds: [],
  };
  inv.status = next(invoiceFlow, inv.status, 'validate', user) as Invoice['status'];
  inv.status = next(invoiceFlow, inv.status, 'submit', user) as Invoice['status'];
  ipc.invoiceId = inv.id;
  tbl.invoices(p).set(inv.id, inv);
  p.emit(user, 'invoice.created', inv.id, { ipcId, netPayable: calc.netPayable });
  return inv;
}

function load(p: Platform, user: User, roles: Role[], id: string) {
  const inv = p.get<Invoice>('ap_invoices', id);
  guard(user, roles, { projectId: inv.projectId });
  return inv;
}

export function approveInvoice(p: Platform, user: User, id: string, comment = '') {
  const inv = load(p, user, APPROVERS, id);
  if ([inv.preparedBy, inv.certifiedBy].includes(user.id)) throw new Error(`Segregation of duties: ${user.name} prepared or certified this invoice and cannot approve it`);
  const limit = user.approvalLimit ?? (user.roles.includes('executive') ? Infinity : 0);
  if (inv.calc.netPayable > limit) throw new Error(`${aed(inv.calc.netPayable)} is above ${user.name}'s authority limit: an executive with sufficient authority must approve`);
  inv.status = next(invoiceFlow, inv.status, 'approve', user) as Invoice['status'];
  Object.assign(inv, { approvedBy: user.id, approvalComment: comment });
  p.emit(user, 'invoice.approved', id, { netPayable: inv.calc.netPayable, comment });
  return inv;
}

export function rejectInvoice(p: Platform, user: User, id: string, reason: string) {
  const inv = load(p, user, APPROVERS, id);
  if (!text(reason)) throw new Error('A rejection needs a reason');
  const ipc = p.get<Ipc>('ap_ipcs', inv.ipcId);
  const [to, ipcTo] = [next(invoiceFlow, inv.status, 'reject', user), next(ipcFlow, ipc.status, 'reject', user)];
  Object.assign(inv, { status: to, rejectedReason: reason });
  ipc.status = ipcTo as Ipc['status']; // frees the headroom; the certifier restages a corrected version
  p.emit(user, 'invoice.rejected', id, { reason });
  return inv;
}

export function hold(p: Platform, user: User, id: string, h: { reason: string; ownerId: string; releaseCondition: string }) {
  const inv = load(p, user, APPROVERS, id);
  if (![h?.reason, h?.ownerId, h?.releaseCondition].every(text)) throw new Error('A hold needs a reason, an owner and a release condition');
  p.get<User>('users', h.ownerId);
  inv.status = next(invoiceFlow, inv.status, 'hold', user) as Invoice['status'];
  inv.approvedBy = inv.approvalComment = undefined; // a released invoice is approved afresh
  inv.holds.push({ ...h, placedBy: user.id, placedOn: p.today, releaseAuthority: user.roles.includes('executive') ? 'executive' : 'finance' });
  p.emit(user, 'invoice.held', id, h);
  return inv;
}

export function releaseHold(p: Platform, user: User, id: string, comment: string) {
  const inv = load(p, user, APPROVERS, id);
  const h = inv.holds.at(-1);
  if (inv.status !== 'on_hold' || !h) throw new Error(`Cannot release: invoice is ${inv.status}, not on hold`);
  if (!text(comment)) throw new Error('Releasing a hold needs a comment');
  if (!user.roles.includes(h.releaseAuthority) && !user.roles.includes('executive')) throw new Error(`Only ${h.releaseAuthority} can release this hold`);
  inv.status = next(invoiceFlow, inv.status, 'release', user) as Invoice['status'];
  Object.assign(h, { releasedBy: user.id, releasedOn: p.today, releaseComment: comment });
  p.emit(user, 'invoice.released', id, { comment, condition: h.releaseCondition });
  return inv;
}

export function account(p: Platform, user: User, id: string) {
  const inv = load(p, user, FIN, id);
  const closed = closedThrough(p), terms = p.get<Terms>('contract_terms', inv.contractId), c = inv.calc;
  const ipc = p.get<Ipc>('ap_ipcs', inv.ipcId);
  const [to, ipcTo] = [next(invoiceFlow, inv.status, 'account', user), next(ipcFlow, ipc.status, 'account', user)]; // held or unapproved invoices stop here
  if (closed && inv.invoiceDate <= closed) throw new Error(`The period through ${closed} is closed: invoice dated ${inv.invoiceDate} cannot be accounted`);
  if (sum([terms.certified, c.gross]) > terms.revisedValue) throw new Error(`Accounting would take certified work past the revised contract value ${aed(terms.revisedValue)}`);
  const lines = journalLines(c);
  inv.status = to as Invoice['status'];
  ipc.status = ipcTo as Ipc['status'];
  const j: Journal = { id: p.id('JE'), invoiceId: id, ipcId: inv.ipcId, contractId: inv.contractId, projectId: inv.projectId, date: inv.invoiceDate, lines, status: 'pending_transfer' };
  tbl.journals(p).set(j.id, j);
  inv.journalId = j.id;
  Object.assign(terms, { certified: sum([terms.certified, c.gross]), retained: sum([terms.retained, c.retention]), advanceRecovered: sum([terms.advanceRecovered, c.advanceRecovery]) });
  p.emit(user, 'invoice.accounted', id, { journalId: j.id, gross: c.gross, netPayable: c.netPayable });
  return j;
}

// One batch for everything pending in the caller's projects; a second call finds nothing and returns an empty batch.
export function exportJournals(p: Platform, user: User) {
  guard(user, FIN);
  const due = [...tbl.journals(p).values()].filter(j => j.status === 'pending_transfer' && p.sees(user, j.projectId));
  if (!due.length) return { batchId: null, count: 0, csv: '' };
  const batchId = p.id('GL');
  const rows = due.flatMap(j => {
    j.status = next(journalFlow, j.status, 'export', user) as Journal['status'];
    j.batchId = batchId;
    return j.lines.map(l => ({ batch: batchId, journal: j.id, date: j.date, account: l.account, name: l.name, debit: l.dr, credit: l.cr, invoice: j.invoiceId, ipc: j.ipcId, contract: j.contractId, project: j.projectId }));
  });
  p.emit(user, 'journals.transferred', batchId, { journals: due.map(j => j.id), debit: sum(rows.map(r => r.debit)), credit: sum(rows.map(r => r.credit)) });
  return { batchId, count: due.length, csv: toCsv(rows) };
}

// Buttons the user may press on this invoice now; SoD and limits come back as the command's error.
export function actions(p: Platform, user: User, id: string) {
  const inv = load(p, user, READERS, id);
  return available(invoiceFlow, inv.status, user);
}

// Reads: staff with project access; suppliers have no role here.
export function get(p: Platform, user: User, id: string) { return load(p, user, READERS, id); }
export function list(p: Platform, user: User) {
  guard(user, READERS);
  return [...tbl.invoices(p).values()].filter(i => p.sees(user, i.projectId));
}
export function getIpc(p: Platform, user: User, id: string) {
  const ipc = p.get<Ipc>('ap_ipcs', id);
  guard(user, READERS, { projectId: ipc.projectId });
  return ipc;
}
// PMIS feedback: where the certified IPC stands.
export function ipcStatus(p: Platform, user: User, id: string) {
  const ipc = getIpc(p, user, id);
  return { ipcId: id, ipcRef: ipc.ipcRef, version: ipc.version, status: ipc.status, errors: ipc.errors, invoiceId: ipc.invoiceId, invoiceStatus: ipc.invoiceId ? p.get<Invoice>('ap_invoices', ipc.invoiceId).status : undefined };
}
export function contractPosition(p: Platform, user: User, contractId: string) {
  const { projectId } = contractOf(p, contractId);
  guard(user, READERS, { projectId });
  const t = p.get<Terms>('contract_terms', contractId);
  return {
    contractId, revisedValue: t.revisedValue, cumulativeCertified: t.certified, pendingCertified: sum(pending(p, contractId).map(i => i.calc!.gross)),
    remainingCommitment: r2(t.revisedValue - t.certified), retentionBalance: t.retained, advanceBalance: r2(t.advanceAmount - t.advanceRecovered),
  };
}

export const commands = { setTerms, setClosedThrough, stageIpc, createInvoice, approveInvoice, rejectInvoice, hold, releaseHold, account, exportJournals, actions, get, list, getIpc, ipcStatus, contractPosition };
