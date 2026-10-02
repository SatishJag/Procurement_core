// Shared data objects, following the requirement's chain. A new module keeps its
// own types in its own file and only adds here what other modules must share.
// Project → Budget → Package → Requisition → Sourcing Event → Lot → Bid → Evaluation → Award → Contract
// Money is AED unless a field says otherwise. Dates are ISO strings (YYYY-MM-DD or full timestamps).

// Every role in the requirement's portal list, so new modules don't edit this line.
export type Role =
  | 'requester' | 'project_manager' | 'buyer' | 'procurement_manager' | 'category_manager'
  | 'technical_evaluator' | 'commercial_evaluator' | 'legal' | 'finance' | 'budget_owner' | 'executive'
  | 'compliance_reviewer' | 'expeditor' | 'admin' | 'auditor' | 'supplier';

export interface User {
  id: string;
  name: string;
  roles: Role[];
  projects: string[];      // project ids, or '*' for all
  approvalLimit?: number;  // AED authority when this user is the final approver
  supplierId?: string;     // supplier portal users: tenant isolation key
}

export interface Project {
  id: string;
  name: string;
  site: string;
  capacityMW: number;
  budgets: Record<string, number>;    // cost code → AED
  committed: Record<string, number>;  // cost code → AED
}

export type Route = 'Direct PO' | 'RFQ' | 'RFP' | 'ITT';

export interface Recommendation {
  category: string;
  confidence: number;      // 0..1
  evidence: string[];      // what the classification was based on
  route: Route;
  minBidders: number;
  envelopes: 1 | 2;
  prequal: boolean;
  longLead: boolean;
  leadTimeWeeks: number;
  reasons: string[];
}

export interface BudgetCheck { ok: boolean; budget: number; committed: number; available: number; shortfall: number }

export interface Milestone { name: string; date: string }
export type Health = 'on_track' | 'at_risk' | 'late';
export interface Schedule { milestones: Milestone[]; floatDays: number; health: Health }

export interface Requisition {
  id: string;
  projectId: string;
  costCode: string;
  title: string;
  description: string;
  amount: number;
  needBy: string;
  requesterId: string;
  status: string;
  recommendation: Recommendation;
  budget: BudgetCheck;
  schedule: Schedule;
}

export interface Package {
  id: string;
  requisitionId?: string;
  requesterId?: string;
  projectId: string;
  costCode: string;
  title: string;
  category: string;
  estimate: number;
  needBy: string;
  route: Route;
  longLead: boolean;
  schedule: Schedule;
  status: 'planned' | 'sourcing' | 'awarded';
  awardedValue?: number;
}

export interface SupplierDoc { type: string; expires: string }

export interface Supplier {
  id: string;
  name: string;
  country: string;
  categories: string[];
  status: 'invited' | 'registered' | 'qualified' | 'suspended' | 'rejected';
  docs: SupplierDoc[];
  risk: 'low' | 'medium' | 'high';
  sanctioned: boolean;
  performance: number; // 0..100 scorecard
}

export interface Criterion { id: string; name: string; weight: number; gate?: boolean } // gate: pass(1)/fail(0), no weight
export interface Lot { id: string; name: string }
export interface BoqLine { id: string; lotId: string; item: string; unit: string; qty: number }
export interface BoqTemplate { id: string; projectId: string; name: string; description?: string; lines: BoqLine[]; lots: { id: string; name: string }[]; createdBy: string; createdAt: string }
export interface BidLine { lineId: string; rate: number; amount: number } // bid currency
export interface Exclusion { lotId: string; description: string; addBack?: number } // add-back in AED, set by the commercial evaluator

export interface Bid {
  id: string;
  supplierId: string;
  currency: string;
  lines: BidLine[];
  exclusions: Exclusion[];
  deviations: string[];
  version: number;
  submittedAt: string;
}

export interface Score { evaluatorId: string; supplierId: string; criterionId: string; score: number; comment?: string }
export interface Moderation { supplierId: string; criterionId: string; score: number; note: string; by: string }
export interface Clarification { id: string; supplierId: string; question: string; answer?: string; extendedTo?: string }

export type EventStatus = 'draft' | 'open' | 'closed' | 'technical' | 'commercial' | 'approval' | 'awarded';

export interface SourcingEvent {
  id: string;
  packageId: string;
  type: Route;
  title: string;
  status: EventStatus;
  lots: Lot[];
  boq: BoqLine[];
  criteria: Criterion[];
  techWeight: number;      // 0..1 share of the combined score
  techThreshold: number;   // minimum technical score (0..100) to be commercially evaluated
  quorum: number;          // evaluator scores needed per criterion
  blind: boolean;          // evaluators see "Bidder A" instead of the supplier name
  evaluators: string[];
  invited: string[];
  closesAt: string;
  bids: Bid[];
  scores: Score[];
  moderations: Moderation[];
  clarifications: Clarification[];
  declarations: Record<string, string[]>; // evaluatorId → conflicted supplierIds (empty = declared, none)
}

export interface ApprovalStep {
  role: Role;
  reason: string;
  decision?: 'approved' | 'rejected';
  by?: string;
  at?: string;
  comment?: string;
}

export interface Allocation { supplierId: string; lotIds: string[]; value: number }

export interface Award {
  id: string;
  eventId: string;
  scenario: string;
  allocations: Allocation[];
  value: number;
  justification: string;
  deviation: boolean;
  recommendedBy: string;
  steps: ApprovalStep[];
  status: 'pending' | 'approved' | 'rejected';
}

export interface Contract { id: string; awardId: string; supplierId: string; lotIds: string[]; value: number; status: 'draft' }

export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  data: unknown;
  prev: string;
  hash: string;
}
