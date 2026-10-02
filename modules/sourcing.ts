import { sha256 } from '../core/audit.ts';
import { parseCsv } from '../core/csv.ts';
import type { Platform } from '../core/kernel.ts';
import type { BidLine, BoqLine, Criterion, EventStatus, Exclusion, Lot, Package, Role, SourcingEvent, User } from '../core/types.ts';
import { available, type Flow, guard, next } from '../core/workflow.ts';
import { ROUTES } from './intake.ts';
import { eligibility } from './suppliers.ts';

// Sourcing events (RFQ / RFP / ITT): setup, publication, clarifications, sealed bids.

const approvers: Role[] = ['procurement_manager', 'budget_owner', 'legal', 'executive'];

export const eventFlow: Flow = {
  draft: { publish: { to: 'open', roles: ['buyer'] } },
  open: {
    extend: { to: 'open', roles: ['buyer'] },
    close: { to: 'closed', roles: ['buyer'] },
  },
  closed: { open_technical: { to: 'technical', roles: ['buyer', 'procurement_manager'] } },
  technical: { complete_technical: { to: 'commercial', roles: ['procurement_manager'] } },
  commercial: { recommend: { to: 'approval', roles: ['buyer', 'procurement_manager'] } },
  approval: {
    award: { to: 'awarded', roles: approvers },
    reject: { to: 'commercial', roles: approvers },
  },
};

export const events = (p: Platform) => p.table<SourcingEvent>('events');
export const advance = (ev: SourcingEvent, action: string, user: User) => {
  ev.status = next(eventFlow, ev.status, action, user) as EventStatus;
};
export const projectOf = (p: Platform, ev: SourcingEvent) => p.get<Package>('packages', ev.packageId).projectId;

// Event lookup with project scoping for staff; suppliers are scoped by invitation instead.
export function eventFor(p: Platform, user: User, id: string) {
  const ev = p.get<SourcingEvent>('events', id);
  if (!user.roles.includes('supplier')) guard(user, user.roles, { projectId: projectOf(p, ev) });
  return ev;
}

function bidder(user: User, ev: SourcingEvent) {
  guard(user, ['supplier']);
  if (!user.supplierId || !ev.invited.includes(user.supplierId)) throw new Error('Not invited to this event');
  return user.supplierId;
}

// Scored criteria must total 100; gates are pass/fail and carry no weight.
export function validateCriteria(criteria: Criterion[]) {
  if (criteria.some(c => !c.gate && !(c.weight > 0))) throw new Error('Every scored criterion needs a positive weight');
  const total = criteria.filter(c => !c.gate).reduce((s, c) => s + c.weight, 0);
  if (Math.abs(total - 100) > 1e-9) throw new Error(`Scored criteria weights must total 100 (got ${total})`);
}

export function boqFromCsv(text: string): BoqLine[] {
  return parseCsv(text).map((r, i) => {
    const qty = Number(r.qty);
    if (!r.lot || !r.item || !(qty > 0)) throw new Error(`BOQ row ${i + 2}: needs lot, item and a positive qty`);
    return { id: r.id || `L${i + 1}`, lotId: r.lot, item: r.item, unit: r.unit || 'nr', qty };
  });
}

export function create(p: Platform, user: User, packageId: string, setup: {
  title?: string; lots: Lot[]; boq: BoqLine[]; criteria: Criterion[]; techWeight: number; techThreshold: number;
  quorum: number; blind?: boolean; evaluators: string[]; invite: string[]; closesAt: string;
}) {
  const pkg = p.get<Package>('packages', packageId);
  guard(user, ['buyer'], { projectId: pkg.projectId });
  if (pkg.status !== 'planned') throw new Error(`Package is already ${pkg.status}`);
  validateCriteria(setup.criteria);
  if (!(setup.techWeight >= 0 && setup.techWeight <= 1)) throw new Error('Technical weight must be between 0 and 1');
  if (!setup.boq.length || setup.boq.some(l => !setup.lots.some(lot => lot.id === l.lotId) || !(l.qty > 0))) {
    throw new Error('Every BOQ line needs a known lot and a positive quantity');
  }
  if (setup.evaluators.some(id => !p.users.get(id)?.roles.includes('technical_evaluator'))) throw new Error('Evaluators must hold the technical evaluator role');
  if (setup.evaluators.length < setup.quorum) throw new Error('Committee is smaller than the quorum');
  if (new Set(setup.invite).size !== setup.invite.length) throw new Error('Duplicate invitees');
  const blocked = setup.invite
    .map(id => ({ id, ...eligibility(p.get('suppliers', id), pkg.category, p.today) }))
    .filter(e => !e.eligible);
  if (blocked.length) throw new Error(`Ineligible bidders: ${blocked.map(b => `${b.id} (${b.blockers.join('; ')})`).join(', ')}`);
  const { minBidders } = ROUTES.find(r => r.route === pkg.route)!;
  if (setup.invite.length < minBidders) throw new Error(`${pkg.route} needs at least ${minBidders} eligible bidders`);

  const ev: SourcingEvent = {
    id: p.id('EV'), packageId, type: pkg.route, title: setup.title ?? pkg.title, status: 'draft',
    lots: setup.lots, boq: setup.boq, criteria: setup.criteria, techWeight: setup.techWeight, techThreshold: setup.techThreshold,
    quorum: setup.quorum, blind: setup.blind ?? false, evaluators: setup.evaluators, invited: setup.invite, closesAt: setup.closesAt,
    bids: [], scores: [], moderations: [], clarifications: [], declarations: {},
  };
  events(p).set(ev.id, ev);
  pkg.status = 'sourcing';
  p.emit(user, 'event.created', ev.id, { package: pkg.id, type: ev.type, invited: ev.invited, criteria: ev.criteria, techWeight: ev.techWeight });
  return ev;
}

export function publish(p: Platform, user: User, eventId: string) {
  const ev = eventFor(p, user, eventId);
  if (ev.closesAt <= p.clock()) throw new Error('Closing time must be in the future');
  advance(ev, 'publish', user);
  p.emit(user, 'event.published', ev.id, { closesAt: ev.closesAt, invited: ev.invited });
  return ev;
}

export function clarify(p: Platform, user: User, eventId: string, question: string) {
  const ev = eventFor(p, user, eventId);
  const supplierId = bidder(user, ev);
  if (ev.status !== 'open') throw new Error('Clarifications are only accepted while the event is open');
  const c = { id: p.id('CL'), supplierId, question };
  ev.clarifications.push(c);
  p.emit(user, 'clarification.asked', ev.id, c);
  return c;
}

// Answers go to every invited bidder; an extension is issued as an addendum.
export function answer(p: Platform, user: User, eventId: string, clarificationId: string, text: string, extendTo?: string) {
  const ev = eventFor(p, user, eventId);
  guard(user, ['buyer']);
  const c = ev.clarifications.find(x => x.id === clarificationId);
  if (!c) throw new Error(`Clarification ${clarificationId} not found`);
  c.answer = text;
  if (extendTo) {
    if (extendTo <= ev.closesAt) throw new Error('An extension must move the closing time later');
    advance(ev, 'extend', user);
    ev.closesAt = c.extendedTo = extendTo;
  }
  p.emit(user, extendTo ? 'addendum.issued' : 'clarification.answered', ev.id, { clarificationId, extendTo });
  return c;
}

// Supplier portal view: own bid only, anonymised Q&A.
export function portal(p: Platform, user: User, eventId: string) {
  const ev = eventFor(p, user, eventId);
  const supplierId = bidder(user, ev);
  return {
    id: ev.id, title: ev.title, type: ev.type, status: ev.status, closesAt: ev.closesAt, lots: ev.lots, boq: ev.boq,
    clarifications: ev.clarifications.filter(c => c.answer).map(({ question, answer, extendedTo }) => ({ question, answer, extendedTo })),
    myBid: ev.bids.find(b => b.supplierId === supplierId) ?? null,
  };
}

export function submitBid(p: Platform, user: User, eventId: string, input: { currency: string; lines: BidLine[]; exclusions?: Omit<Exclusion, 'addBack'>[]; deviations?: string[] }) {
  const ev = eventFor(p, user, eventId);
  const supplierId = bidder(user, ev);
  if (ev.status !== 'open' || p.clock() > ev.closesAt) throw new Error('Bidding is closed');
  if (!p.fx[input.currency]) throw new Error(`Unsupported currency ${input.currency}`);
  for (const l of input.lines) {
    if (!ev.boq.some(b => b.id === l.lineId) || !(l.rate >= 0) || !(l.amount >= 0)) throw new Error(`Invalid bid line ${l.lineId}`);
  }
  if (new Set(input.lines.map(l => l.lineId)).size !== input.lines.length) throw new Error('Each BOQ line can be priced once');
  if (!input.lines.some(l => l.rate > 0)) throw new Error('A bid must price at least one line');
  const exclusions = (input.exclusions ?? []).map(({ lotId, description }) => {
    if (!ev.lots.some(l => l.id === lotId)) throw new Error(`Unknown lot ${lotId}`);
    return { lotId, description };
  });
  const prev = ev.bids.find(b => b.supplierId === supplierId);
  const bid = {
    id: prev?.id ?? p.id('BID'), supplierId, currency: input.currency, lines: input.lines, exclusions,
    deviations: input.deviations ?? [], version: (prev?.version ?? 0) + 1, submittedAt: p.clock(),
  };
  if (prev) ev.bids[ev.bids.indexOf(prev)] = bid;
  else ev.bids.push(bid);
  // Sealed: the trail holds a fingerprint of the bid, not its prices.
  p.emit(user, 'bid.submitted', ev.id, { supplierId, version: bid.version, seal: sha256(bid) });
  return { id: bid.id, version: bid.version };
}

export function close(p: Platform, user: User, eventId: string) {
  const ev = eventFor(p, user, eventId);
  if (p.clock() < ev.closesAt) throw new Error(`Bids close at ${ev.closesAt}`);
  advance(ev, 'close', user);
  p.emit(user, 'event.closed', ev.id, { bids: ev.bids.map(b => ({ supplierId: b.supplierId, seal: sha256(b) })) });
  return ev;
}

// Event-stage actions. Approval-stage buttons come from awards.actions.
export function actions(p: Platform, user: User, eventId: string) {
  const ev = eventFor(p, user, eventId);
  return ev.status === 'approval' ? [] : available(eventFlow, ev.status, user);
}

export const commands = { create, publish, clarify, answer, portal, submitBid, close, actions };
