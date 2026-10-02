import { daysBetween } from '../core/dates.js';
import { toCsv } from '../core/csv.js';
import { guard } from '../core/workflow.js';
import { awards } from './awards.js';
import { READERS } from './evaluation.js';
import { requisitions } from './intake.js';
import { health, remaining } from './planning.js';
import { events, projectOf } from './sourcing.js';
// Dashboards, registers and audit read access. Read-only over other modules' tables.
export function dashboard(p, user) {
    // Supplier-portal users must not read internal pipeline, savings or other suppliers' compliance data.
    if (user.roles.every(r => r === 'supplier'))
        throw new Error(`${user.name} needs an internal role to open the dashboard`);
    const today = p.today;
    const sum = (xs) => xs.reduce((s, x) => s + x, 0);
    const packages = [...p.packages.values()].filter(x => p.sees(user, x.projectId)).map(x => ({
        ...x, ...(x.status === 'awarded' ? { floatDays: 0, health: 'on_track' } : health(remaining(x), today)),
    }));
    const open = packages.filter(x => x.status !== 'awarded');
    const awarded = packages.filter(x => x.status === 'awarded');
    return {
        pipeline: { planned: packages.filter(x => x.status === 'planned').length, sourcing: packages.filter(x => x.status === 'sourcing').length, awarded: awarded.length },
        valueInPipeline: sum(open.map(x => x.estimate)),
        atRisk: open.filter(x => x.health !== 'on_track').map(x => ({ id: x.id, title: x.title, health: x.health, floatDays: x.floatDays })),
        longLead: open.filter(x => x.longLead).length,
        savings: { baseline: sum(awarded.map(x => x.estimate)), awarded: sum(awarded.map(x => x.awardedValue ?? 0)), saved: sum(awarded.map(x => x.estimate - (x.awardedValue ?? 0))) },
        myApprovals: [
            ...[...requisitions(p).values()]
                .filter(r => r.status === 'submitted' && user.roles.includes('budget_owner') && p.sees(user, r.projectId))
                .map(r => ({ type: 'requisition', id: r.id, value: r.amount })),
            ...[...awards(p).values()]
                .filter(a => a.status === 'pending' && user.roles.includes(a.steps.find(s => !s.decision).role) && p.sees(user, projectOf(p, events(p).get(a.eventId))))
                .map(a => ({ type: 'award', id: a.id, value: a.value })),
        ],
        expiringDocs: [...p.suppliers.values()].flatMap(s => s.docs
            .filter(d => daysBetween(today, d.expires) <= 30)
            .map(d => ({ supplier: s.name, doc: d.type, expires: d.expires, expired: d.expires < today }))),
        budget: [...p.projects.values()].filter(x => p.sees(user, x.id)).flatMap(x => Object.entries(x.budgets).map(([costCode, budget]) => {
            const committed = x.committed[costCode] ?? 0;
            return { project: x.id, costCode, budget, committed, available: budget - committed };
        })),
        audit: p.audit.verify(),
    };
}
export function exportPackages(p, user) {
    guard(user, ['buyer', 'procurement_manager', 'auditor']);
    return toCsv([...p.packages.values()].filter(x => p.sees(user, x.projectId)).map(x => ({
        id: x.id, title: x.title, category: x.category, route: x.route, estimate: x.estimate, awarded: x.awardedValue ?? '',
        status: x.status, longLead: x.longLead ? 'yes' : 'no', needBy: x.needBy, next: remaining(x)[0]?.name ?? '',
    })));
}
export function history(p, user, entity) {
    guard(user, ['auditor', 'procurement_manager', 'admin']);
    return p.audit.for(entity);
}
// Internal roles only: evaluators (blind), requesters and supplier-portal users do not get the enterprise map.
const TWIN_ROLES = ['buyer', 'procurement_manager', 'category_manager', 'project_manager', 'executive', 'finance', 'budget_owner', 'legal', 'compliance_reviewer', 'auditor', 'admin'];
export function twin(p, user) {
    guard(user, TWIN_ROLES);
    const nodes = [], edges = [];
    const link = (from, to, kind) => edges.push({ from, to, kind });
    const projects = [...p.projects.values()].filter(x => p.sees(user, x.id));
    for (const x of projects) {
        nodes.push({ id: x.id, kind: 'project', label: x.name, meta: { site: x.site, capacityMW: x.capacityMW } });
        for (const [code, total] of Object.entries(x.budgets)) {
            const committed = x.committed[code] ?? 0, id = `${x.id}:${code}`;
            nodes.push({ id, kind: 'budget', label: code, value: total - committed, health: committed > total ? 'late' : committed > total * 0.9 ? 'at_risk' : 'on_track', meta: { committed, total } });
            link(x.id, id, 'project-budget');
        }
    }
    const pkgs = [...p.packages.values()].filter(x => p.sees(user, x.projectId));
    for (const x of pkgs) {
        nodes.push({ id: x.id, kind: 'package', label: x.title, status: x.status, value: x.estimate, health: x.status === 'awarded' ? 'on_track' : health(remaining(x), p.today).health, meta: { category: x.category, route: x.route } });
        if (nodes.some(n => n.id === `${x.projectId}:${x.costCode}`))
            link(`${x.projectId}:${x.costCode}`, x.id, 'budget-package');
    }
    const evs = [...events(p).values()].filter(e => pkgs.some(x => x.id === e.packageId));
    const linked = new Set();
    for (const e of evs) {
        const sealed = e.status === 'draft' || e.status === 'open'; // bid count and invitations wait until the event closes / is published
        nodes.push({ id: e.id, kind: 'event', label: e.title, status: e.status, meta: sealed ? { type: e.type } : { type: e.type, bids: e.bids.length } });
        link(e.packageId, e.id, 'package-event');
        if (e.status !== 'draft')
            for (const s of e.invited)
                if (p.suppliers.has(s)) {
                    linked.add(s);
                    link(e.id, s, 'event-supplier');
                }
    }
    const aws = [...awards(p).values()].filter(a => evs.some(e => e.id === a.eventId));
    for (const a of aws) {
        nodes.push({ id: a.id, kind: 'award', label: `Award ${a.scenario}`, status: a.status, ...(a.status === 'approved' || READERS.some(r => user.roles.includes(r)) ? { value: a.value } : {}) });
        link(a.eventId, a.id, 'event-award');
    }
    for (const c of [...p.table('contracts').values()].filter(c => aws.some(a => a.id === c.awardId))) {
        nodes.push({ id: c.id, kind: 'contract', label: `Contract ${c.id}`, status: c.status, value: c.value });
        link(c.awardId, c.id, 'award-contract');
        if (p.suppliers.has(c.supplierId)) {
            linked.add(c.supplierId);
            link(c.id, c.supplierId, 'contract-supplier');
        }
    }
    for (const s of p.suppliers.values()) {
        if (!linked.has(s.id) && s.status !== 'qualified')
            continue;
        nodes.push({ id: s.id, kind: 'supplier', label: s.name, status: s.status, meta: { risk: s.risk, category: s.categories.join(', '), country: s.country } });
    }
    // Activity: only entities the caller can see; supplier-portal actors and bidders stay sealed, bid rows wait for the event to close.
    const seen = new Set([...nodes.map(n => n.id), ...[...requisitions(p).values()].filter(r => p.sees(user, r.projectId)).map(r => r.id)]);
    const activity = p.audit.events.filter(e => seen.has(e.entity) && !(e.action === 'bid.submitted' && events(p).get(e.entity)?.status === 'open')).slice(-25).reverse()
        .map(e => ({ at: e.at, type: e.action, ref: e.entity, actor: ['bid.submitted', 'clarification.asked'].includes(e.action) || p.users.get(e.actor)?.roles.includes('supplier') ? 'sealed' : e.actor }));
    return { nodes, edges, activity };
}
export const commands = { dashboard, exportPackages, history, twin };
