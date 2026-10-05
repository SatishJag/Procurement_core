import { toCsv } from '../core/csv.js';
import { available, guard, next } from '../core/workflow.js';
import { projectOf } from './sourcing.js';
// Construction accounts payable, phase 1: certified IPC -> AP invoice -> approval -> subledger journal -> GL export.
// One IPC = one invoice (Option A). AED only; no payments, bank or tax-rule engine yet.
const FIN = ['finance'];
const APPROVERS = ['finance', 'executive'];
const READERS = ['finance', 'executive', 'project_manager', 'auditor', 'buyer', 'procurement_manager'];
// ponytail: fixed chart of accounts, move to a finance-owned mapping table when the ERP chart is known.
const ACCT = {
    wip: ['1410', 'Project WIP'], inputTax: ['1520', 'Recoverable Input Tax'], retention: ['2210', 'Retention Payable'],
    advance: ['1430', 'Contractor Advance'], deductions: ['4910', 'Deductions Recovery'], wht: ['2230', 'WHT Payable'], ap: ['2110', 'AP Liability'],
};
export const ipcFlow = {
    staged: { validate: { to: 'validated', roles: ['project_manager'] }, fail: { to: 'validation_failed', roles: ['project_manager'] } },
    validated: { invoice: { to: 'invoiced', roles: FIN }, withdraw: { to: 'withdrawn', roles: ['project_manager', 'finance'] } },
    invoiced: { reject: { to: 'rejected', roles: APPROVERS }, account: { to: 'accounted', roles: FIN } },
};
// Invoices are born in approval_required (the IPC's own validation is the draft step).
// Held invoices go back to approval_required on release, so a hold always forces a fresh approval.
export const invoiceFlow = {
    approval_required: { approve: { to: 'approved', roles: APPROVERS }, reject: { to: 'rejected', roles: APPROVERS }, hold: { to: 'on_hold', roles: APPROVERS } },
    approved: { account: { to: 'accounted', roles: FIN }, hold: { to: 'on_hold', roles: APPROVERS } },
    on_hold: { release: { to: 'approval_required', roles: READERS } }, // holder rules below decide who may
};
const journalFlow = { pending_transfer: { export: { to: 'transferred', roles: FIN } } };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sum = (xs) => r2(xs.reduce((a, b) => a + b, 0));
const aed = (n) => `AED ${n.toLocaleString('en', { minimumFractionDigits: 2 })}`;
// Round-trip so 2026-02-31 is refused rather than rolled into March.
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
const norm = (s) => s.trim().toLowerCase();
const num = (n) => typeof n === 'number' && Number.isFinite(n);
const text = (s) => typeof s === 'string' && s.trim() !== '';
const tbl = {
    terms: (p) => p.table('contract_terms'), ipcs: (p) => p.table('ap_ipcs'),
    invoices: (p) => p.table('ap_invoices'), journals: (p) => p.table('ap_journals'),
    settings: (p) => p.table('ap_settings'),
};
const closedThrough = (p) => tbl.settings(p).get('cfg')?.closedThrough ?? '';
// contract -> award -> event -> package gives the project every guard scopes on.
function contractOf(p, id) {
    const contract = p.get('contracts', id);
    const ev = p.get('events', p.get('awards', contract.awardId).eventId);
    return { contract, projectId: projectOf(p, ev) };
}
// IPCs staged or invoiced but not yet accounted still consume contract headroom, retention cap and advance balance.
const pending = (p, contractId) => [...tbl.ipcs(p).values()].filter(i => i.contractId === contractId && (i.status === 'validated' || i.status === 'invoiced'));
// Pure: technical layer, element shapes first so malformed payloads become stored errors, not TypeErrors.
export function technicalErrors(i) {
    const e = [];
    if (!text(i.ipcRef))
        e.push('ipcRef is required');
    if (i.taxInvoiceNo !== undefined && !text(i.taxInvoiceNo))
        e.push('taxInvoiceNo must be text when given');
    if (!Number.isInteger(i.version) || i.version < 1)
        e.push('version must be a whole number from 1');
    if (!isDate(i.periodFrom) || !isDate(i.periodTo))
        e.push('periodFrom and periodTo must be real ISO dates');
    else if (i.periodFrom > i.periodTo)
        e.push('periodFrom is after periodTo');
    if (i.invoiceDate !== undefined && !isDate(i.invoiceDate))
        e.push('invoiceDate must be a real ISO date');
    if (!Array.isArray(i.lines) || !i.lines.length)
        e.push('At least one IPC line is required');
    else
        i.lines.forEach((l, n) => {
            if (!isObj(l))
                return void e.push(`Line ${n + 1} must be an object`);
            if (![l.boqItem, l.wbs, l.costCode, l.uom].every(text))
                e.push(`Line ${n + 1}: boqItem, wbs, costCode and uom are required`);
            if (![l.prevQty, l.currQty, l.rate].every(num) || l.prevQty < 0 || l.currQty < 0 || l.rate < 0)
                e.push(`Line ${n + 1}: quantities and rate must be numbers, not negative`);
        });
    if (!Array.isArray(i.variations) || i.variations.some(v => !isObj(v) || !text(v.ref) || !num(v.amount)))
        e.push('Each variation needs a ref and a numeric amount');
    const a = i.adjustments;
    if (!isObj(a))
        e.push('adjustments is required');
    else {
        for (const k of ['materialOnSite', 'retention', 'advanceRecovery'])
            if (a[k] !== undefined && (!num(a[k]) || a[k] < 0))
                e.push(`${k} must be a number, not negative`);
        if (a.otherDeductions !== undefined && (!Array.isArray(a.otherDeductions) || a.otherDeductions.some(d => !isObj(d) || !text(d.type) || !num(d.amount) || d.amount <= 0)))
            e.push('Every deduction needs a type and a positive amount');
    }
    if (!Array.isArray(i.attachments) || i.attachments.some(x => !isObj(x) || !text(x.type) || !text(x.name)))
        e.push('attachments must list a type and name for each file');
    return e;
}
// Pure: the spec arithmetic, rounded per line.
// ponytail: currQty is this period's quantity; prevQty is informational and not checked against accounted history; material on site counts as
// certified work with no later reversal. Upgrade: check quantities against the BOQ and accounted history, and book material on site as a liability that reverses on installation.
export function compute(i, t, retainedSoFar, recoveredSoFar) {
    const gross = sum([...i.lines.map(l => r2(l.currQty * l.rate)), ...i.variations.map(v => r2(v.amount)), r2(i.adjustments.materialOnSite ?? 0)]);
    const capLeft = Math.max(0, r2(t.retentionCap - retainedSoFar));
    const advLeft = Math.max(0, r2(t.advanceAmount - recoveredSoFar));
    const rule = { retention: Math.min(r2(gross * t.retentionPct / 100), capLeft), advance: Math.min(r2(gross * t.advanceRecoveryPct / 100), advLeft) };
    const retention = r2(i.adjustments.retention ?? rule.retention), advanceRecovery = r2(i.adjustments.advanceRecovery ?? rule.advance);
    const deductions = sum((i.adjustments.otherDeductions ?? []).map(d => d.amount));
    const netBeforeTax = r2(gross - retention - advanceRecovery - deductions);
    const vat = r2(netBeforeTax * t.vatPct / 100), wht = r2(netBeforeTax * t.whtPct / 100);
    const calc = { gross, retention, advanceRecovery, deductions, netBeforeTax, vat, wht, netPayable: r2(netBeforeTax + vat - wht) };
    return { calc, capLeft, advLeft, rule };
}
// Balanced subledger journal; throws if debits and credits differ.
export function journalLines(c) {
    const L = (k, dr, cr) => ({ account: ACCT[k][0], name: ACCT[k][1], dr, cr });
    const lines = [L('wip', c.gross, 0), L('inputTax', c.vat, 0), L('retention', 0, c.retention), L('advance', 0, c.advanceRecovery),
        L('deductions', 0, c.deductions), L('wht', 0, c.wht), L('ap', 0, c.netPayable)].filter(l => l.dr || l.cr);
    if (sum(lines.map(l => l.dr)) !== sum(lines.map(l => l.cr)))
        throw new Error('Journal does not balance: debits differ from credits, so nothing was accounted');
    return lines;
}
const TERM_KEYS = ['retentionPct', 'retentionCap', 'advanceAmount', 'advanceRecoveryPct', 'vatPct', 'whtPct', 'revisedValue'];
export function setTerms(p, user, contractId, t) {
    const { contract, projectId } = contractOf(p, contractId);
    guard(user, FIN, { projectId });
    if (!isObj(t))
        throw new Error('Financial terms are required');
    const pct = (n) => num(n) && n >= 0 && n <= 100;
    if (!pct(t.retentionPct) || !pct(t.advanceRecoveryPct) || !pct(t.vatPct) || !pct(t.whtPct))
        throw new Error('Percentages must be between 0 and 100');
    if (![t.retentionCap, t.advanceAmount].every(n => num(n) && n >= 0) || !num(t.revisedValue) || t.revisedValue <= 0)
        throw new Error('Retention cap and advance must not be negative, and the revised contract value must be above zero');
    const old = tbl.terms(p).get(contractId), open = pending(p, contractId);
    if ((old?.certified || open.length) && old && TERM_KEYS.slice(0, 6).some(k => t[k] !== old[k]))
        throw new Error('Retention, advance, VAT and WHT terms cannot change while certified work is accounted or an IPC is still open for this contract');
    const committed = sum([old?.certified ?? 0, ...open.map(i => i.calc.gross)]);
    if (t.revisedValue < committed)
        throw new Error(`Revised value is below the ${aed(committed)} already certified or in process`);
    // ponytail: a variation reference is a free-text audit pointer; real variation orders with their own approval come later.
    if (t.revisedValue > contract.value && t.revisedValue !== old?.revisedValue && !text(t.variationRef))
        throw new Error(`Raising the contract above its awarded ${aed(contract.value)} needs a variation reference`);
    // Counters are engine-owned: the stored row is built from validated fields only, never from caller-supplied counters.
    const row = { id: contractId, ...Object.fromEntries(TERM_KEYS.map(k => [k, t[k]])), certified: old?.certified ?? 0, retained: old?.retained ?? 0, advanceRecovered: old?.advanceRecovered ?? 0 };
    tbl.terms(p).set(contractId, row);
    p.emit(user, 'contract.terms_set', contractId, { ...Object.fromEntries(TERM_KEYS.map(k => [k, t[k]])), variationRef: t.variationRef });
    return row;
}
// ponytail: closing a period affects every project, so it needs an executive with all-project access; real period control moves to a finance-controller role.
export function setClosedThrough(p, user, date) {
    guard(user, ['executive']);
    if (!user.projects.includes('*'))
        throw new Error(`${user.name} needs access to all projects to close a period`);
    if (!isDate(date))
        throw new Error('Enter the closed-through date as YYYY-MM-DD');
    if (date > p.today)
        throw new Error(`A period cannot be closed beyond today (${p.today})`);
    // ponytail: periods only close forward; reopening needs its own authorised command.
    if (date < closedThrough(p))
        throw new Error(`Periods are already closed through ${closedThrough(p)} and cannot be reopened here`);
    tbl.settings(p).set('cfg', { id: 'cfg', closedThrough: date });
    p.emit(user, 'period.closed', 'cfg', { closedThrough: date });
    return date;
}
// Integration staging. Business failures are stored on the IPC (status validation_failed + errors), not thrown.
const IPC_KEYS = ['messageId', 'ipcRef', 'version', 'periodFrom', 'periodTo', 'taxInvoiceNo', 'invoiceDate', 'lines', 'variations', 'adjustments', 'attachments'];
const LIVE = ['validated', 'invoiced', 'accounted'];
export function stageIpc(p, user, contractId, input) {
    const { contract, projectId } = contractOf(p, contractId);
    guard(user, ['project_manager'], { projectId });
    const raw = input;
    if (!isObj(raw) || !text(raw.messageId))
        throw new Error('messageId is required so a resend can be recognised');
    const all = [...tbl.ipcs(p).values()];
    const seen = all.find(i => i.messageId === raw.messageId);
    if (seen) {
        if (seen.contractId !== contractId)
            throw new Error('Message id already used');
        return seen; // idempotent replay: no second IPC, no second event
    }
    const clean = structuredClone(Object.fromEntries(IPC_KEYS.filter(k => k in raw).map(k => [k, raw[k]]))); // only known fields are stored
    const errors = technicalErrors(clean);
    const terms = tbl.terms(p).get(contractId);
    let calc;
    if (!errors.length) {
        const supplier = p.get('suppliers', contract.supplierId);
        if (supplier.status !== 'qualified' || supplier.sanctioned)
            errors.push(`Supplier ${supplier.name} is ${supplier.sanctioned ? 'sanctioned' : supplier.status}, so no IPC can be processed`);
        // ponytail: Contract.status is only 'draft' today, so "contract is live" means finance has set its terms; add a status check when contracts gain execution states.
        if (!terms)
            errors.push('The contract has no financial terms yet: finance must set them first');
        const budgets = p.get('projects', projectId).budgets;
        for (const l of clean.lines)
            if (!(l.costCode in budgets))
                errors.push(`Cost code ${l.costCode} is not in the project budget`);
        if (clean.taxInvoiceNo && all.some(i => i.supplierId === contract.supplierId && LIVE.includes(i.status) && i.taxInvoiceNo && norm(i.taxInvoiceNo) === norm(clean.taxInvoiceNo)))
            errors.push(`Tax invoice ${clean.taxInvoiceNo} is already on file for this supplier`);
    }
    if (!errors.length && terms) {
        const open = pending(p, contractId);
        const r = compute(clean, terms, terms.retained + sum(open.map(i => i.calc.retention)), terms.advanceRecovered + sum(open.map(i => i.calc.advanceRecovery)));
        calc = r.calc;
        const cumulative = sum([terms.certified, ...open.map(i => i.calc.gross), calc.gross]);
        if (calc.gross <= 0)
            errors.push('The certified amount must be above zero');
        if (cumulative > terms.revisedValue)
            errors.push(`Cumulative certified ${aed(cumulative)} exceeds the revised contract value ${aed(terms.revisedValue)}`);
        if (all.some(i => i.contractId === contractId && i.ipcRef === clean.ipcRef && i.version === clean.version && LIVE.includes(i.status)))
            errors.push(`IPC ${clean.ipcRef} version ${clean.version} was already received`);
        if (calc.retention > r.capLeft)
            errors.push(`Retention ${aed(calc.retention)} exceeds what is left under the retention cap (${aed(r.capLeft)})`);
        else if (calc.retention !== r.rule.retention)
            errors.push(`Retention ${aed(calc.retention)} does not match the contract rule (${aed(r.rule.retention)})`);
        if (calc.advanceRecovery > r.advLeft)
            errors.push(`Advance recovery ${aed(calc.advanceRecovery)} exceeds the remaining advance balance (${aed(r.advLeft)})`);
        else if (calc.advanceRecovery > r2(calc.gross * terms.advanceRecoveryPct / 100))
            errors.push(`Advance recovery ${aed(calc.advanceRecovery)} is above the contract recovery rate of ${terms.advanceRecoveryPct}%`);
        if (calc.netBeforeTax < 0)
            errors.push('Deductions exceed the certified amount');
    }
    const status = next(ipcFlow, 'staged', errors.length ? 'fail' : 'validate', user);
    const ipc = { ...clean, id: p.id('IPC'), contractId, projectId, supplierId: contract.supplierId, certifiedBy: user.id, stagedAt: p.clock(), status, errors, calc }; // id only once validation has run
    tbl.ipcs(p).set(ipc.id, ipc);
    p.emit(user, 'ipc.staged', ipc.id, { contractId, ipcRef: ipc.ipcRef, version: ipc.version, messageId: ipc.messageId });
    if (errors.length)
        p.emit(user, 'ipc.validation_failed', ipc.id, { errors });
    return ipc;
}
// A validated IPC that cannot be invoiced (duplicate amount and date, wrong certification) is withdrawn, which frees its headroom, retention cap and advance.
export function withdrawIpc(p, user, ipcId, reason) {
    const ipc = p.get('ap_ipcs', ipcId);
    guard(user, ['project_manager', 'finance'], { projectId: ipc.projectId });
    if (!text(reason))
        throw new Error('Withdrawing an IPC needs a reason');
    ipc.status = next(ipcFlow, ipc.status, 'withdraw', user);
    p.emit(user, 'ipc.withdrawn', ipcId, { reason });
    return ipc;
}
export function createInvoice(p, user, ipcId) {
    const ipc = p.get('ap_ipcs', ipcId);
    guard(user, FIN, { projectId: ipc.projectId });
    const to = next(ipcFlow, ipc.status, 'invoice', user); // failed or already-invoiced IPCs stop here
    const calc = ipc.calc, date = ipc.invoiceDate ?? p.today;
    const live = [...tbl.invoices(p).values()].filter(i => i.supplierId === ipc.supplierId && i.status !== 'rejected');
    if (ipc.taxInvoiceNo && live.some(i => i.taxInvoiceNo && norm(i.taxInvoiceNo) === norm(ipc.taxInvoiceNo)))
        throw new Error(`Tax invoice ${ipc.taxInvoiceNo} is already on file for this supplier`);
    if (live.some(i => i.calc.netPayable === calc.netPayable && i.invoiceDate === date))
        throw new Error(`This supplier already has an invoice for ${aed(calc.netPayable)} dated ${date}`);
    ipc.status = to;
    const inv = {
        id: p.id('INV'), ipcId, contractId: ipc.contractId, projectId: ipc.projectId, supplierId: ipc.supplierId, taxInvoiceNo: ipc.taxInvoiceNo, invoiceDate: date, calc,
        status: 'approval_required', preparedBy: user.id, certifiedBy: ipc.certifiedBy, holds: [],
    };
    ipc.invoiceId = inv.id;
    tbl.invoices(p).set(inv.id, inv);
    p.emit(user, 'invoice.created', inv.id, { ipcId, netPayable: calc.netPayable });
    return inv;
}
function load(p, user, roles, id) {
    const inv = p.get('ap_invoices', id);
    guard(user, roles, { projectId: inv.projectId });
    return inv;
}
export function approveInvoice(p, user, id, comment = '') {
    const inv = load(p, user, APPROVERS, id);
    if ([inv.preparedBy, inv.certifiedBy].includes(user.id))
        throw new Error(`Segregation of duties: ${user.name} prepared or certified this invoice and cannot approve it`);
    const limit = user.approvalLimit ?? 0; // same rule as awards: no limit set means no authority
    if (inv.calc.netPayable > limit)
        throw new Error(`${aed(inv.calc.netPayable)} is above ${user.name}'s authority limit: an executive with sufficient authority must approve`);
    inv.status = next(invoiceFlow, inv.status, 'approve', user);
    Object.assign(inv, { approvedBy: user.id, approvalComment: comment });
    p.emit(user, 'invoice.approved', id, { netPayable: inv.calc.netPayable, comment });
    return inv;
}
export function rejectInvoice(p, user, id, reason) {
    const inv = load(p, user, APPROVERS, id);
    if (!text(reason))
        throw new Error('A rejection needs a reason');
    const ipc = p.get('ap_ipcs', inv.ipcId);
    const [to, ipcTo] = [next(invoiceFlow, inv.status, 'reject', user), next(ipcFlow, ipc.status, 'reject', user)];
    Object.assign(inv, { status: to, rejectedReason: reason });
    ipc.status = ipcTo; // frees the headroom; the certifier restages a corrected version
    p.emit(user, 'invoice.rejected', id, { reason });
    return inv;
}
export function hold(p, user, id, h) {
    const inv = load(p, user, APPROVERS, id);
    if (![h?.reason, h?.ownerId, h?.releaseCondition].every(text))
        throw new Error('A hold needs a reason, an owner and a release condition');
    const owner = p.get('users', h.ownerId);
    if (!owner.roles.some(r => READERS.includes(r)) || !p.sees(owner, inv.projectId))
        throw new Error(`${owner.name} cannot own a hold on this project's invoices`);
    inv.status = next(invoiceFlow, inv.status, 'hold', user);
    inv.approvedBy = inv.approvalComment = undefined; // a released invoice is approved afresh
    inv.holds.push({ ...h, placedBy: user.id, placedOn: p.today, releaseAuthority: `${owner.name}, or an executive other than ${user.name}` });
    p.emit(user, 'invoice.held', id, h);
    return inv;
}
export function releaseHold(p, user, id, comment) {
    const inv = load(p, user, READERS, id);
    const h = inv.holds.at(-1);
    if (inv.status !== 'on_hold' || !h)
        throw new Error(`Cannot release: invoice is ${inv.status}, not on hold`);
    if (!text(comment))
        throw new Error('Releasing a hold needs a comment');
    if (user.id !== h.ownerId && !(user.roles.includes('executive') && user.id !== h.placedBy))
        throw new Error(`Only ${h.releaseAuthority} can release this hold`);
    inv.status = next(invoiceFlow, inv.status, 'release', user);
    Object.assign(h, { releasedBy: user.id, releasedOn: p.today, releaseComment: comment });
    p.emit(user, 'invoice.released', id, { comment, condition: h.releaseCondition });
    return inv;
}
export function account(p, user, id) {
    const inv = load(p, user, FIN, id);
    const closed = closedThrough(p), terms = p.get('contract_terms', inv.contractId), c = inv.calc;
    const ipc = p.get('ap_ipcs', inv.ipcId);
    const [to, ipcTo] = [next(invoiceFlow, inv.status, 'account', user), next(ipcFlow, ipc.status, 'account', user)]; // held or unapproved invoices stop here
    if (closed && inv.invoiceDate <= closed)
        throw new Error(`The period through ${closed} is closed: invoice dated ${inv.invoiceDate} cannot be accounted`);
    if (sum([terms.certified, c.gross]) > terms.revisedValue)
        throw new Error(`Accounting would take certified work past the revised contract value ${aed(terms.revisedValue)}`);
    if (sum([terms.retained, c.retention]) > terms.retentionCap)
        throw new Error(`Accounting would take retention past the cap of ${aed(terms.retentionCap)}`);
    if (sum([terms.advanceRecovered, c.advanceRecovery]) > terms.advanceAmount)
        throw new Error(`Accounting would recover more than the ${aed(terms.advanceAmount)} advance`);
    const lines = journalLines(c);
    inv.status = to;
    ipc.status = ipcTo;
    const j = { id: p.id('JE'), invoiceId: id, ipcId: inv.ipcId, contractId: inv.contractId, projectId: inv.projectId, date: inv.invoiceDate, lines, status: 'pending_transfer' };
    tbl.journals(p).set(j.id, j);
    inv.journalId = j.id;
    Object.assign(terms, { certified: sum([terms.certified, c.gross]), retained: sum([terms.retained, c.retention]), advanceRecovered: sum([terms.advanceRecovered, c.advanceRecovery]) });
    p.emit(user, 'invoice.accounted', id, { journalId: j.id, gross: c.gross, netPayable: c.netPayable });
    return j;
}
const csvOf = (batchId, js) => toCsv(js.flatMap(j => j.lines.map(l => ({ batch: batchId, journal: j.id, date: j.date, account: l.account, name: l.name, debit: l.dr, credit: l.cr, invoice: j.invoiceId, ipc: j.ipcId, contract: j.contractId, project: j.projectId }))));
// One batch for everything pending in the caller's projects; a second call finds nothing and returns an empty batch.
export function exportJournals(p, user) {
    guard(user, FIN);
    const due = [...tbl.journals(p).values()].filter(j => j.status === 'pending_transfer' && p.sees(user, j.projectId));
    if (!due.length)
        return { batchId: null, count: 0, csv: '' };
    const batchId = p.id('GL');
    for (const j of due) {
        j.status = next(journalFlow, j.status, 'export', user);
        j.batchId = batchId;
    }
    p.emit(user, 'journals.transferred', batchId, { journals: due.map(j => j.id), debit: sum(due.flatMap(j => j.lines.map(l => l.dr))), credit: sum(due.flatMap(j => j.lines.map(l => l.cr))) });
    return { batchId, count: due.length, csv: csvOf(batchId, due) };
}
// Re-download of an already transferred batch, limited to the caller's projects.
export function getBatch(p, user, batchId) {
    guard(user, ['finance', 'auditor']);
    const js = [...tbl.journals(p).values()].filter(j => j.batchId === batchId && p.sees(user, j.projectId));
    if (!js.length)
        throw new Error(`Batch ${batchId} not found`);
    return { batchId, count: js.length, csv: csvOf(batchId, js) };
}
// Buttons the user may press on this invoice now; SoD and limits come back as the command's error.
export function actions(p, user, id) {
    const inv = load(p, user, READERS, id);
    return available(invoiceFlow, inv.status, user);
}
// Reads: staff with project access; suppliers have no role here.
export function get(p, user, id) { return load(p, user, READERS, id); }
// List reads are newest first: tables keep insertion order and nothing is ever deleted, so reversing it is the time order.
const seen = (p, user, rows) => {
    guard(user, READERS);
    return [...rows.values()].filter(r => p.sees(user, r.projectId)).reverse();
};
export function list(p, user) { return seen(p, user, tbl.invoices(p)); }
export function listIpcs(p, user) {
    return seen(p, user, tbl.ipcs(p)).map(({ id, ipcRef, version, contractId, projectId, supplierId, periodFrom, periodTo, status, errors, calc, invoiceId, stagedAt, certifiedBy }) => ({ id, ipcRef, version, contractId, projectId, supplierId, periodFrom, periodTo, status, errors, calc, invoiceId, stagedAt, certifiedBy }));
}
export function listJournals(p, user) { return seen(p, user, tbl.journals(p)); }
// Every contract the caller can see, with or without finance terms (the UI prompts to set them).
export function listContracts(p, user) {
    guard(user, READERS);
    return [...p.table('contracts').values()].flatMap(c => {
        const { projectId } = contractOf(p, c.id);
        if (!p.sees(user, projectId))
            return [];
        const t = tbl.terms(p).get(c.id);
        return [{ id: c.id, supplierId: c.supplierId, supplierName: p.suppliers.get(c.supplierId)?.name ?? null, projectId, value: c.value, terms: t ?? null, position: t ? position(p, t) : null }];
    });
}
export function getIpc(p, user, id) {
    const ipc = p.get('ap_ipcs', id);
    guard(user, READERS, { projectId: ipc.projectId });
    return ipc;
}
// PMIS feedback: where the certified IPC stands.
export function ipcStatus(p, user, id) {
    const ipc = getIpc(p, user, id);
    return { ipcId: id, ipcRef: ipc.ipcRef, version: ipc.version, status: ipc.status, errors: ipc.errors, invoiceId: ipc.invoiceId, invoiceStatus: ipc.invoiceId ? p.get('ap_invoices', ipc.invoiceId).status : undefined };
}
export function contractPosition(p, user, contractId) {
    const { projectId } = contractOf(p, contractId);
    guard(user, READERS, { projectId });
    return position(p, p.get('contract_terms', contractId));
}
const position = (p, t) => {
    const contractId = t.id;
    return {
        contractId, revisedValue: t.revisedValue, cumulativeCertified: t.certified, pendingCertified: sum(pending(p, contractId).map(i => i.calc.gross)),
        remainingCommitment: r2(t.revisedValue - t.certified), retentionBalance: t.retained, advanceBalance: r2(t.advanceAmount - t.advanceRecovered),
    };
};
export const commands = { setTerms, setClosedThrough, stageIpc, withdrawIpc, createInvoice, approveInvoice, rejectInvoice, hold, releaseHold, account, exportJournals, getBatch, actions, get, list, listIpcs, listContracts, listJournals, getIpc, ipcStatus, contractPosition };
