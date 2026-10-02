// Shared data objects, following the requirement's chain. A new module keeps its
// own types in its own file and only adds here what other modules must share.
// Project → Budget → Package → Requisition → Sourcing Event → Lot → Bid → Evaluation → Award → Contract
// Money is AED unless a field says otherwise. Dates are ISO strings (YYYY-MM-DD or full timestamps).
export {};
