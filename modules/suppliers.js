import { daysBetween } from '../core/dates.js';
import { available, guard, next } from '../core/workflow.js';
// Supplier onboarding, qualification, eligibility and discovery.
export const REQUIRED_DOCS = ['trade_licence', 'insurance', 'tax_certificate'];
const EXPIRY_WARNING_DAYS = 30;
// Can this supplier be invited to a sourcing event in this category today?
export function eligibility(s, category, today) {
    const blockers = [];
    const warnings = [];
    if (s.sanctioned)
        blockers.push('Sanctions screening hit');
    if (s.status !== 'qualified')
        blockers.push(`Supplier status is ${s.status}`);
    if (!s.categories.includes(category))
        blockers.push(`Not qualified for ${category}`);
    for (const type of REQUIRED_DOCS) {
        const doc = s.docs.find(d => d.type === type);
        if (!doc)
            blockers.push(`Missing ${type}`);
        else if (doc.expires < today)
            blockers.push(`${type} expired ${doc.expires}`);
        else if (daysBetween(today, doc.expires) <= EXPIRY_WARNING_DAYS)
            warnings.push(`${type} expires ${doc.expires}`);
    }
    if (s.risk === 'high')
        warnings.push('High risk rating: mitigation plan required');
    return { eligible: blockers.length === 0, blockers, warnings };
}
// Supplier discovery: everyone in the category, eligible first, then by performance.
export function discover(suppliers, category, today) {
    return suppliers
        .filter(s => s.categories.includes(category))
        .map(s => ({ id: s.id, name: s.name, performance: s.performance, risk: s.risk, ...eligibility(s, category, today) }))
        .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.performance - a.performance);
}
export const supplierFlow = {
    invited: { register: { to: 'registered', roles: ['supplier'] } },
    registered: {
        qualify: { to: 'qualified', roles: ['procurement_manager'] },
        reject: { to: 'rejected', roles: ['procurement_manager'] },
    },
    qualified: { suspend: { to: 'suspended', roles: ['procurement_manager'] } },
    suspended: { reinstate: { to: 'qualified', roles: ['procurement_manager'] } },
};
export function register(p, user, docs) {
    const s = p.get('suppliers', user.supplierId ?? '');
    s.status = next(supplierFlow, s.status, 'register', user);
    s.docs = docs;
    p.emit(user, 'supplier.registered', s.id, { docs: docs.map(d => d.type) });
    return s;
}
export function qualify(p, user, supplierId, action, note = '') {
    const s = p.get('suppliers', supplierId);
    if (action === 'qualify') {
        const missing = REQUIRED_DOCS.filter(t => !s.docs.some(d => d.type === t && d.expires >= p.today));
        if (missing.length)
            throw new Error(`Cannot qualify: missing or expired ${missing.join(', ')}`);
    }
    s.status = next(supplierFlow, s.status, action, user);
    p.emit(user, `supplier.${s.status}`, s.id, { note });
    return s;
}
const SEARCHERS = ['buyer', 'procurement_manager', 'category_manager'];
// Supplier discovery for a category, eligible first.
export function search(p, user, category) {
    guard(user, SEARCHERS);
    return discover([...p.suppliers.values()], category, p.today);
}
const card = (s, today) => ({
    id: s.id, name: s.name, status: s.status, country: s.country, categories: s.categories, risk: s.risk, performance: s.performance, sanctioned: s.sanctioned,
    docs: s.docs.map(d => ({ ...d, state: d.expires < today ? 'expired' : daysBetween(today, d.expires) <= EXPIRY_WARNING_DAYS ? 'expiring' : 'valid' })),
});
export function list(p, user) {
    guard(user, SEARCHERS);
    return [...p.suppliers.values()].map(s => card(s, p.today));
}
export function get(p, user, supplierId) {
    guard(user, SEARCHERS);
    return card(p.get('suppliers', supplierId), p.today);
}
export function actions(p, user, supplierId) {
    if (user.roles.includes('supplier') && user.supplierId !== supplierId)
        return [];
    return available(supplierFlow, p.get('suppliers', supplierId).status, user);
}
export const commands = { register, qualify, search, actions, list, get };
