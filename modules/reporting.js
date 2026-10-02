import { daysBetween } from '../core/dates.js';
import { toCsv } from '../core/csv.js';
import { guard } from '../core/workflow.js';
import { awards } from './awards.js';
import { requisitions } from './intake.js';
import { health, remaining } from './planning.js';
import { events, projectOf } from './sourcing.js';
// Dashboards, registers and audit read access. Read-only over other modules' tables.
export function dashboard(p, user) {
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
export const commands = { dashboard, exportPackages, history };
