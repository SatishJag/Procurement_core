import { guard } from '../core/workflow';
import { results } from './evaluation';
import { checkBudget } from './intake';
import { advance, eventFor } from './sourcing';
// Award recommendation and delegation-of-authority approval.
// Emits award.approved, which downstream modules (contracts, later POs) subscribe to.
// Delegation-of-authority matrix (AED). First band that covers the value wins.
export const DOA = [
    { upTo: 500_000, chain: ['procurement_manager'] },
    { upTo: 5_000_000, chain: ['procurement_manager', 'budget_owner'] },
    { upTo: Infinity, chain: ['procurement_manager', 'budget_owner', 'executive'] },
];
const ORDER = ['procurement_manager', 'budget_owner', 'legal', 'executive'];
// Conditional routing on value, budget position and deviation from the recommendation.
export function routeApproval(value, { overBudget = false, deviation = false } = {}) {
    const band = DOA.find(d => value <= d.upTo);
    const steps = band.chain.map(role => ({ role, reason: `Authority matrix: AED ${value.toLocaleString('en')}` }));
    const add = (role, reason) => {
        const step = steps.find(s => s.role === role);
        if (step)
            step.reason += `; ${reason}`;
        else
            steps.push({ role, reason });
    };
    if (overBudget)
        add('budget_owner', 'Exceeds available budget');
    if (deviation)
        add('executive', 'Deviates from best-value ranking');
    return steps.sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
}
// Sequential approval with segregation of duties and authority limits.
export function applyDecision(award, user, decision, comment, at, conflicted) {
    if (award.status !== 'pending')
        throw new Error(`Award is already ${award.status}`);
    const step = award.steps.find(s => !s.decision);
    if (!user.roles.includes(step.role))
        throw new Error(`Awaiting ${step.role}, not ${user.name}`);
    if (conflicted.includes(user.id) || award.recommendedBy === user.id || award.steps.some(s => s.by === user.id)) {
        throw new Error(`Segregation of duties: ${user.name} cannot approve this award`);
    }
    const last = step === award.steps.at(-1);
    if (decision === 'approved' && last && (user.approvalLimit ?? 0) < award.value) {
        throw new Error(`${user.name}'s authority limit is below AED ${award.value.toLocaleString('en')}`);
    }
    if (decision === 'rejected' && !comment.trim())
        throw new Error('A rejection needs a reason');
    Object.assign(step, { decision, by: user.id, at, comment });
    award.status = decision === 'rejected' ? 'rejected' : last ? 'approved' : 'pending';
    return award;
}
export const awards = (p) => p.table('awards');
const APPROVERS = ['procurement_manager', 'budget_owner', 'legal', 'executive'];
export function recommend(p, user, eventId, scenarioId, justification = '') {
    const ev = eventFor(p, user, eventId);
    const result = results(p, user, eventId);
    const unpriced = ev.bids
        .filter(b => result.ranking.some(r => r.supplierId === b.supplierId))
        .flatMap(b => b.exclusions.filter(x => x.addBack === undefined).map(x => `${b.supplierId}: ${x.description}`));
    if (unpriced.length)
        throw new Error(`Price these exclusions first: ${unpriced.join('; ')}`);
    const scenario = result.scenarios.find(s => s.id === scenarioId);
    if (!scenario)
        throw new Error(`Unknown scenario ${scenarioId}`);
    if (scenario.deviation && !justification.trim())
        throw new Error('Deviating from the best-value ranking needs a justification');
    const pkg = p.get('packages', ev.packageId);
    const budget = checkBudget(p.get('projects', pkg.projectId), pkg.costCode, scenario.value);
    advance(ev, 'recommend', user);
    const award = {
        id: p.id('AW'), eventId, scenario: scenario.id, allocations: scenario.allocations, value: scenario.value,
        justification, deviation: scenario.deviation, recommendedBy: user.id,
        steps: routeApproval(scenario.value, { overBudget: !budget.ok, deviation: scenario.deviation }), status: 'pending',
    };
    awards(p).set(award.id, award);
    p.emit(user, 'award.recommended', award.id, { eventId, scenario: scenario.id, value: award.value, route: award.steps.map(s => s.role) });
    return award;
}
export function decide(p, user, awardId, decision, comment = '') {
    const award = p.get('awards', awardId);
    const ev = eventFor(p, user, award.eventId);
    const pkg = p.get('packages', ev.packageId);
    guard(user, APPROVERS, { projectId: pkg.projectId });
    const step = award.steps.find(s => !s.decision);
    applyDecision(award, user, decision, comment, p.clock(), [pkg.requesterId ?? '', ...ev.evaluators]);
    p.emit(user, 'award.decision', award.id, { role: step.role, decision, comment });
    if (award.status === 'rejected')
        advance(ev, 'reject', user);
    if (award.status !== 'approved')
        return award;
    advance(ev, 'award', user);
    const project = p.get('projects', pkg.projectId);
    project.committed[pkg.costCode] = (project.committed[pkg.costCode] ?? 0) + award.value;
    Object.assign(pkg, { status: 'awarded', awardedValue: award.value });
    const regrets = ev.bids.map(b => b.supplierId).filter(id => !award.allocations.some(a => a.supplierId === id));
    p.emit(user, 'award.approved', award.id, { eventId: ev.id, value: award.value, allocations: award.allocations, regrets });
    return award;
}
// Approve/reject buttons only for the role the award is waiting on.
export function actions(p, user, awardId) {
    const award = p.get('awards', awardId);
    eventFor(p, user, award.eventId);
    const step = award.status === 'pending' ? award.steps.find(s => !s.decision) : undefined;
    return step && user.roles.includes(step.role) ? ['approved', 'rejected'] : [];
}
export const commands = { recommend, decide, actions };
