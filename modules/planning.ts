import { addDays, daysBetween } from '../core/dates.ts';
import type { Health, Milestone, Package, Route, Schedule } from '../core/types.ts';

// Weeks each sourcing stage takes per route. Admin-configurable.
const TENDER_WEEKS: Record<Route, number> = { 'Direct PO': 1, RFQ: 2, RFP: 4, ITT: 6 };
const EVAL_WEEKS: Record<Route, number> = { 'Direct PO': 0, RFQ: 1, RFP: 3, ITT: 4 };
const CONTRACT_WEEKS = 2;
const PREQUAL_WEEKS = 3;

// Plans backwards from the required-on-site date so long-lead items show
// how late the sourcing calendar already is.
export function schedule(needBy: string, route: Route, leadTimeWeeks: number, prequal: boolean, today: string): Schedule {
  const po = addDays(needBy, -leadTimeWeeks * 7);
  const award = addDays(po, -CONTRACT_WEEKS * 7);
  const bidsDue = addDays(award, -EVAL_WEEKS[route] * 7);
  const issue = addDays(bidsDue, -TENDER_WEEKS[route] * 7);
  const milestones: Milestone[] = [
    ...(prequal ? [{ name: 'Prequalification start', date: addDays(issue, -PREQUAL_WEEKS * 7) }] : []),
    { name: 'RFx issue', date: issue },
    { name: 'Bids due', date: bidsDue },
    { name: 'Award', date: award },
    { name: 'PO issued', date: po },
    { name: 'Required on site', date: needBy },
  ];
  return { milestones, ...health(milestones, today) };
}

export function health(milestones: Milestone[], today: string): { floatDays: number; health: Health } {
  const floatDays = daysBetween(today, milestones[0].date);
  return { floatDays, health: floatDays < 0 ? 'late' : floatDays < 14 ? 'at_risk' : 'on_track' };
}

// Milestones still ahead of a package given how far it has got.
export function remaining(p: Package) {
  const award = p.schedule.milestones.findIndex(m => m.name === 'Award');
  return p.schedule.milestones.slice(p.status === 'planned' ? 0 : p.status === 'sourcing' ? award : award + 1);
}
