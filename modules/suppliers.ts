import { daysBetween } from '../core/dates';
import type { Platform } from '../core/kernel';
import type { Supplier, SupplierDoc, User } from '../core/types';
import { available, type Flow, guard, next } from '../core/workflow';

// Supplier onboarding, qualification, eligibility and discovery.

export const REQUIRED_DOCS = ['trade_licence', 'insurance', 'tax_certificate'];
const EXPIRY_WARNING_DAYS = 30;

// Can this supplier be invited to a sourcing event in this category today?
export function eligibility(s: Supplier, category: string, today: string) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (s.sanctioned) blockers.push('Sanctions screening hit');
  if (s.status !== 'qualified') blockers.push(`Supplier status is ${s.status}`);
  if (!s.categories.includes(category)) blockers.push(`Not qualified for ${category}`);
  for (const type of REQUIRED_DOCS) {
    const doc = s.docs.find(d => d.type === type);
    if (!doc) blockers.push(`Missing ${type}`);
    else if (doc.expires < today) blockers.push(`${type} expired ${doc.expires}`);
    else if (daysBetween(today, doc.expires) <= EXPIRY_WARNING_DAYS) warnings.push(`${type} expires ${doc.expires}`);
  }
  if (s.risk === 'high') warnings.push('High risk rating: mitigation plan required');
  return { eligible: blockers.length === 0, blockers, warnings };
}

// Supplier discovery: everyone in the category, eligible first, then by performance.
export function discover(suppliers: Supplier[], category: string, today: string) {
  return suppliers
    .filter(s => s.categories.includes(category))
    .map(s => ({ id: s.id, name: s.name, performance: s.performance, risk: s.risk, ...eligibility(s, category, today) }))
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.performance - a.performance);
}

export const supplierFlow: Flow = {
  invited: { register: { to: 'registered', roles: ['supplier'] } },
  registered: {
    qualify: { to: 'qualified', roles: ['procurement_manager'] },
    reject: { to: 'rejected', roles: ['procurement_manager'] },
  },
  qualified: { suspend: { to: 'suspended', roles: ['procurement_manager'] } },
  suspended: { reinstate: { to: 'qualified', roles: ['procurement_manager'] } },
};

export function register(p: Platform, user: User, docs: SupplierDoc[]) {
  const s = p.get<Supplier>('suppliers', user.supplierId ?? '');
  s.status = next(supplierFlow, s.status, 'register', user) as Supplier['status'];
  s.docs = docs;
  p.emit(user, 'supplier.registered', s.id, { docs: docs.map(d => d.type) });
  return s;
}

export function qualify(p: Platform, user: User, supplierId: string, action: 'qualify' | 'reject' | 'suspend' | 'reinstate', note = '') {
  const s = p.get<Supplier>('suppliers', supplierId);
  if (action === 'qualify') {
    const missing = REQUIRED_DOCS.filter(t => !s.docs.some(d => d.type === t && d.expires >= p.today));
    if (missing.length) throw new Error(`Cannot qualify: missing or expired ${missing.join(', ')}`);
  }
  s.status = next(supplierFlow, s.status, action, user) as Supplier['status'];
  p.emit(user, `supplier.${s.status}`, s.id, { note });
  return s;
}

// Supplier discovery for a category, eligible first.
export function search(p: Platform, user: User, category: string) {
  guard(user, ['buyer', 'procurement_manager', 'category_manager']);
  return discover([...p.suppliers.values()], category, p.today);
}

export function actions(p: Platform, user: User, supplierId: string) {
  if (user.roles.includes('supplier') && user.supplierId !== supplierId) return [];
  return available(supplierFlow, p.get<Supplier>('suppliers', supplierId).status, user);
}

export const commands = { register, qualify, search, actions };
