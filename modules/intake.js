import { available, guard, next } from '../core/workflow';
import { boqFromCsv } from './sourcing';
import { schedule } from './planning';
// Guided intake: free text + value → structured requisition → approved package.
// Category taxonomy with typical manufacturing + delivery lead times (weeks).
// ponytail: keyword classifier. Swap for an LLM classifier later; keep the
// { category, confidence, evidence } output so callers do not change.
export const CATEGORIES = [
    { name: 'Electrical / Generators', leadWeeks: 52, keywords: ['generator', 'generators', 'genset', 'gensets', 'diesel', 'standby power'] },
    { name: 'Mechanical / Cooling', leadWeeks: 40, keywords: ['chiller', 'chillers', 'crah', 'cooling', 'hvac', 'air handling'] },
    { name: 'Electrical / MV Switchgear', leadWeeks: 36, keywords: ['switchgear', 'rmu', 'transformer', 'transformers', 'mv panel'] },
    { name: 'Electrical / UPS', leadWeeks: 26, keywords: ['ups', 'battery', 'batteries', 'uninterruptible'] },
    { name: 'IT / Structured Cabling', leadWeeks: 10, keywords: ['cabling', 'fibre', 'fiber', 'rack', 'racks', 'containment'] },
    { name: 'Civil Works', leadWeeks: 6, keywords: ['concrete', 'excavation', 'rebar', 'civil', 'foundation', 'foundations'] },
    { name: 'Professional Services', leadWeeks: 2, services: true, keywords: ['consultant', 'consultancy', 'design', 'survey', 'advisory', 'commissioning agent'] },
];
const GENERAL = { name: 'General', leadWeeks: 4, services: false, keywords: [] };
// Procurement route by value (AED). First match wins. Admin-configurable.
export const ROUTES = [
    { upTo: 50_000, route: 'Direct PO', minBidders: 1, envelopes: 1 },
    { upTo: 500_000, route: 'RFQ', minBidders: 3, envelopes: 1 },
    { upTo: 5_000_000, route: 'RFP', minBidders: 3, envelopes: 2 },
    { upTo: Infinity, route: 'ITT', minBidders: 4, envelopes: 2 },
];
const LONG_LEAD_WEEKS = 26;
export function classify(text) {
    const hits = CATEGORIES.map(c => ({
        c,
        evidence: c.keywords.filter(k => new RegExp(`\\b${k}\\b`, 'i').test(text)),
    })).sort((a, b) => b.evidence.length - a.evidence.length);
    const best = hits[0];
    const total = hits.reduce((s, h) => s + h.evidence.length, 0);
    if (!best.evidence.length)
        return { category: GENERAL, confidence: 0, evidence: [] };
    // Two distinct keyword hits with no competing category = full confidence.
    const confidence = Math.min(1, best.evidence.length / 2) * (best.evidence.length / total);
    return { category: best.c, confidence: Math.round(confidence * 100) / 100, evidence: best.evidence.map(k => `matched "${k}"`) };
}
export function recommend(text, amount) {
    const { category, confidence, evidence } = classify(text);
    let rule = ROUTES.find(r => amount <= r.upTo);
    const reasons = [`Value AED ${amount.toLocaleString('en')} falls in the ${rule.route} band`];
    if (category.services && rule.envelopes === 1 && amount > ROUTES[0].upTo) {
        rule = ROUTES.find(r => r.route === 'RFP');
        reasons.push('Professional services use quality-based selection (RFP)');
    }
    const longLead = category.leadWeeks >= LONG_LEAD_WEEKS;
    if (longLead)
        reasons.push(`Long-lead category (${category.leadWeeks} weeks): prequalify and plan backwards from need date`);
    return {
        category: category.name,
        confidence,
        evidence,
        route: rule.route,
        minBidders: rule.minBidders,
        envelopes: rule.envelopes,
        prequal: rule.route === 'ITT' || longLead,
        longLead,
        leadTimeWeeks: category.leadWeeks,
        reasons,
    };
}
export function checkBudget(project, costCode, amount) {
    const budget = project.budgets[costCode];
    if (budget === undefined)
        throw new Error(`Cost code ${costCode} is not in ${project.name}'s budget`);
    const committed = project.committed[costCode] ?? 0;
    const available = budget - committed;
    return { ok: amount <= available, budget, committed, available, shortfall: Math.max(0, amount - available) };
}
export const requisitionFlow = {
    draft: { submit: { to: 'submitted', roles: ['requester', 'buyer'] } },
    submitted: {
        approve: { to: 'approved', roles: ['budget_owner'] },
        reject: { to: 'rejected', roles: ['budget_owner'] },
    },
};
export const requisitions = (p) => p.table('requisitions');
export const boqTemplates = (p) => p.table('boqTemplates');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function submit(p, user, input) {
    guard(user, ['requester', 'buyer'], { projectId: input.projectId });
    if (!(input.amount > 0))
        throw new Error('Amount must be positive');
    if (!ISO_DATE.test(input.needBy) || input.needBy <= p.today)
        throw new Error('Need-by must be a future YYYY-MM-DD date');
    const recommendation = recommend(`${input.title} ${input.description}`, input.amount);
    const req = {
        ...input,
        id: p.id('PR'),
        requesterId: user.id,
        status: next(requisitionFlow, 'draft', 'submit', user),
        recommendation,
        budget: checkBudget(p.get('projects', input.projectId), input.costCode, input.amount),
        schedule: schedule(input.needBy, recommendation.route, recommendation.leadTimeWeeks, recommendation.prequal, p.today),
    };
    requisitions(p).set(req.id, req);
    p.emit(user, 'requisition.submitted', req.id, { amount: req.amount, category: recommendation.category, route: recommendation.route });
    return req;
}
export function decide(p, user, id, decision, reason = '') {
    const req = p.get('requisitions', id);
    guard(user, ['budget_owner'], { projectId: req.projectId });
    if (user.id === req.requesterId)
        throw new Error('Segregation of duties: cannot approve your own requisition');
    if (decision === 'reject' && !reason.trim())
        throw new Error('A rejection needs a reason');
    if (decision === 'approve') {
        req.budget = checkBudget(p.get('projects', req.projectId), req.costCode, req.amount);
        if (!req.budget.ok)
            throw new Error(`Budget shortfall of AED ${req.budget.shortfall.toLocaleString('en')}: raise a budget transfer first`);
    }
    req.status = next(requisitionFlow, req.status, decision, user);
    p.emit(user, `requisition.${req.status}`, req.id, { reason });
    if (decision === 'reject')
        return { requisition: req };
    const r = req.recommendation;
    const pkg = {
        id: p.id('PKG'), requisitionId: req.id, requesterId: req.requesterId, projectId: req.projectId, costCode: req.costCode,
        title: req.title, category: r.category, estimate: req.amount, needBy: req.needBy, route: r.route, longLead: r.longLead,
        schedule: req.schedule, status: 'planned',
    };
    p.packages.set(pkg.id, pkg);
    p.emit(user, 'package.created', pkg.id, { requisition: req.id, route: pkg.route, longLead: pkg.longLead });
    return { requisition: req, package: pkg };
}
export function uploadBoq(p, user, input) {
    guard(user, ['buyer', 'procurement_manager'], { projectId: input.projectId });
    const lines = boqFromCsv(input.csvText);
    const lots = Array.from(new Set(lines.map(l => l.lotId))).map(id => ({ id, name: `Lot ${id}` }));
    const boq = {
        id: p.id('BOQ'),
        projectId: input.projectId,
        name: input.name,
        description: input.description,
        lines,
        lots,
        createdBy: user.id,
        createdAt: p.clock(),
    };
    boqTemplates(p).set(boq.id, boq);
    p.emit(user, 'boq.uploaded', boq.id, { name: boq.name, lineCount: lines.length, lotCount: lots.length });
    return boq;
}
export function createPackagesFromBoq(p, user, input) {
    guard(user, ['buyer', 'procurement_manager'], { projectId: input.costCode });
    if (!(input.estimate > 0))
        throw new Error('Estimate must be positive');
    if (!ISO_DATE.test(input.needBy) || input.needBy <= p.today)
        throw new Error('Need-by must be a future YYYY-MM-DD date');
    const boq = p.get('boqTemplates', input.boqTemplateId);
    guard(user, user.roles, { projectId: boq.projectId });
    const project = p.get('projects', boq.projectId);
    const budgetCheck = checkBudget(project, input.costCode, input.estimate);
    if (!budgetCheck.ok)
        throw new Error(`Budget shortfall of AED ${budgetCheck.shortfall.toLocaleString('en')}: raise a budget transfer first`);
    const sched = schedule(input.needBy, input.route, 10, input.longLead, p.today);
    const pkg = {
        id: p.id('PKG'), projectId: boq.projectId, costCode: input.costCode, title: boq.name, category: input.category,
        estimate: input.estimate, needBy: input.needBy, route: input.route, longLead: input.longLead, schedule: sched, status: 'planned',
    };
    p.packages.set(pkg.id, pkg);
    p.emit(user, 'package.created', pkg.id, { boqTemplate: input.boqTemplateId, route: input.route, longLead: input.longLead });
    return pkg;
}
// What the API may call. Pure helpers above stay internal.
export function actions(p, user, id) {
    const req = p.get('requisitions', id);
    guard(user, user.roles, { projectId: req.projectId });
    return available(requisitionFlow, req.status, user);
}
export const commands = { submit, decide, uploadBoq, createPackagesFromBoq, actions };
