# procurement_core

Shared, UI-free backend for three procurement capabilities:

1. **Vendor PreQual**: qualification per vendor × trade, graded A to D from a governed rulebook.
2. **Bid evaluation**: package eligibility from a decision matrix, then technical, commercial
   and composite scoring with line-by-line explanations.
3. **BOQ to PO**: six-gate BOQ benchmarking, bid levelling, award scenarios, approval routing
   and purchase-order drafts for Oracle.

The same package runs in both products (ConstructionAI and Procure.AI). Each product supplies its own UI
and talks to the REST API in `procurement_core/api.py`. The package has no product-specific code, client
names or branding.

## Using it in a product

Pin a released version in the product's `requirements.txt`:

```
procurement-core @ git+https://github.com/SatishJag/Procurement_core@v0.1.0
```

Mount the API in the product's FastAPI app:

```python
from procurement_core.api import router
app.include_router(router)
```

The repo is private, so installs need a read-only GitHub token. Locally, git's normal credentials work.
In Docker builds, pass `GITHUB_TOKEN` as a build argument (see each product's Dockerfile).

## Making a change reach both products

1. Change the code here and run `pytest`.
2. Bump `version` in `pyproject.toml` and tag the commit (`git tag v0.1.1 && git push origin v0.1.1`).
3. In each product, change the pin to the new tag and redeploy.

Products move to a new version only when their pin changes, so a change made for one product can't
silently break the other's live demo. If `schema/procurement_core.sql` changed, apply the same change
to each product's database schema.

## Principle: rules are data, AI gives evidence, the engine does the arithmetic

| Layer | Owns | Where |
|---|---|---|
| Rulebook | Criteria, rubric bands 1 to 5, weights, trade weight sets, grade bands, decision matrix | `prequal/rulebook.json` (seed), then the `rule_sets`, `criteria` and `rubric_bands` tables |
| Evidence intelligence (AI agents) | Classify documents, extract facts, propose a rating, cite page and confidence | LangGraph agents (per product) |
| Deterministic engine | Rating numeric facts, weighting, grading, eligibility, composite score, integrity checks | `prequal/engine.py`, `boq.py` |
| People | Accept or override every rating, approve, publish | `engine.review()` workflow |

AI may say *why* a vendor meets Rating 4. It never defines Rating 4, its weight, a grade threshold or
a tender weighting.

## Scoring model

```
contribution = rating / 5 × weight            per criterion, weight in %
score        = Σ contribution / 100           0..1, graded at 2 decimals, half-up
final bid    = TE% × technical_weight + CE% × commercial_weight
```

Numeric criteria are rated by the engine from the extracted fact, never by the model. Example:
current assets / current liabilities = 1.32 → Rating 4 (band 1.25 to 1.49).

Grade bands: **A** 0.86 to 1.00, **B** 0.71 to 0.85, **C** 0.51 to 0.70, **D** 0.01 to 0.50.

### Rule sets in the seed rulebook

| Rule set | Categories (weights from the workbooks) |
|---|---|
| `pq-contractor` | Company Profile 20, Financial Strength 30, Technical Capability 30, PM Maturity 10, Compliance & Governance 10 (client testimonials 0) |
| `pq-consultant` | Company 10, Relevant Experience 20, Resources 20, Design Quality 20, Digital/BIM 15, Past Performance 5, Financial 5, Legal 5; each criterion Mandatory or Preferred |
| `te-contractor` | 11 criteria: credentials, team, resources, methodology, technical compliance, programme, QA/QCx, HSE, risk, VE, supply chain; trade weight sets for MEP, Façade, Shoring |
| `te-consultant` | Experience 25, Team 20, Design management 20, Methodology/VE 20, Digital/BIM 15 |
| `ce` | Price 60, Cost Control 10, Contractual Readiness 20, Financial Capacity 10 |

Taken from the workbooks: category weights, grade bands, decision-matrix weightings, the
working-capital rubric and the price-to-L1 rubric (L1, up to 5%, 5 to 10%, 10 to 15%, above 15%).
**Seed values until the workbook importer runs:** subcriterion splits within categories and the
remaining rubric wording.

### Decision matrix

Project complexity × package risk resolves to exactly one rule: eligible grades plus explicit
technical/commercial weights. Package risk defaults to the trade's risk class (Shoring, Piling, Main
Works, MEP, Vertical Transport and Façade are High). The weights are authoritative; the P1/P2/P3
pathway code is a governed label.

| Complexity \ Risk | Low | Medium | High |
|---|---|---|---|
| Low | A B C · 50/50 | A B C · 50/50 | A B · 60/40 |
| Medium | A B C · 50/50 | A B · 60/40 | A B · 70/30 |
| High | A B · 60/40 | A · 70/30 | A · 70/30 |

## Evidence states and missing information

Every criterion carries one of three evidence states: `confirmed`, `contradicts`, `missing`.

- **contradicts** → `review_required`; an evaluator must resolve it with a comment.
- **missing** → `rated_no_evidence` only where the rubric itself defines a no-evidence rating
  (for example, certifications not submitted = 1) and the criterion is not mandatory.
  Otherwise → `evidence_required`, and no grade is issued until the vendor responds.

Each scored line returns the explanation object: criterion, weight (after trade override), AI rating,
final rating, rubric text, extracted value, evidence documents with page and section, confidence,
the calculation (`4/5 x 8% = 6.40%`) and any override note.

## Human in the loop

```
ai_suggested → under_review → lead_approved → committee_approved → published
```

- Accept or override each rating. An override needs a rating and a reason code; the AI rating is kept.
- Lead and committee approval need every rated criterion decided and no open items.
- Segregation of duties: an evaluator can't approve the same case; each approver signs once.
- Only an **official** result (active rule set, no blocking integrity issues) can be published.
- Every step appends an audit event with before and after hashes.

## Rule integrity

A rule set moves from draft to active only when integrity checks pass and someone other than the
author approves it (also enforced by a check constraint on `rule_sets`). Checks: criterion weights
total 100%, category subweights match category weights, trade weight sets cover every criterion and
total 100%, each criterion has exactly one band per rating 1 to 5, numeric bands have no gap or overlap,
grade bands tile 0.01 to 1.00, every complexity × risk pair resolves exactly once, technical + commercial
= 100%, pathway labels mean the same weighting everywhere, mandatory flags are defined where required,
and active sets carry an approver and effective date.

**Findings on the current workbooks** (`GET /api/prequal/integrity`), which block activation until resolved:

1. Commercial evaluation subweights total **95%**, not 100%.
2. The Cost Control category is weighted 10% but its subcriteria total 5%.
3. **P1** is 50/50 in the decision matrix but 70/30 in the PQ workbook.
4. **P3** is 70/30 in the decision matrix but 50/50 in the PQ workbook.

Until governance resolves these and activates the rule sets, every score is returned as
`official: false` with the reasons, and publishing is refused.

## BOQ to PO engine (`boq.py`)

- **Benchmark:** only history passing all six gates (project, package, functional, technical,
  commercial, time and location; each ≥ 70) is comparable. Returns low/median/high (quartiles),
  confidence = mean(technical, commercial, recency) × min(1, 0.6 + n/25), variance, band, saving to
  median, source records and rejected records with the gates they failed. Review is required below 75%
  confidence, beyond ±10% variance, or for critical data-centre assets.
- **Level bids:** line by line against the benchmark; per-bill variance, unpriced lines, outliers (> 25%).
- **Award scenarios:** single award to the top-ranked bidder; split award giving each bill to the
  qualified bidder closest to benchmark. Ranking and qualification come from bid evaluation.
- **Approval route:** every authority threshold the award value crosses.
- **Purchase orders:** one draft PO per supplier with WBS and cost codes and terms, `oracle_status: draft`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/prequal/rulebook` | Rule sets, trades, grade bands, blocking-issue counts |
| GET | `/api/prequal/rulesets/{id}` | Full rule set with rubrics |
| GET | `/api/prequal/integrity` | Integrity report for every rule set, grade bands and decision matrix |
| GET | `/api/prequal/decision-matrix` | Matrix rows and issues |
| POST | `/api/prequal/decision` | Eligible grades and TE/CE weights for complexity + risk (or trade) |
| POST | `/api/prequal/assess` | Score a vendor × trade PQ, or one TE/CE envelope |
| POST | `/api/prequal/evaluate-bids` | Eligibility, L1, TE, CE, composite ranking, exclusions |
| POST | `/api/boq/benchmark` | Six-gate benchmark for one line |
| POST | `/api/boq/level-bids` | Bid levelling against benchmarks |
| POST | `/api/boq/award-scenarios` | Single and split award |
| POST | `/api/boq/approval-route` | Approvers for an award value |
| POST | `/api/boq/purchase-orders` | Draft POs from an approved award |

The API is stateless today: callers send facts and receive governed results. Persistence maps onto
the tables below.

## Data model

Postgres DDL: `schema/procurement_core.sql` (minimal master tables, then the BOQ to PO and Vendor
PreQual sections). ConstructionAI carries the same sections in `supabase/schema.sql`, sections 7 and 8.

```
contractors (vendor master, vendor_type) ─┬─ vendor_trades ── trades
                                          │        └─ qualification_assessments ── evaluation_runs
rule_sets ─┬─ criteria ─┬─ rubric_bands                                              └─ criterion_scores
           │            └─ criterion_trade_weights                                       ├─ evidence_spans ── evidence_documents
           ├─ grade_bands                                                                └─ score_overrides
           ├─ tender_decision_rules ── bid_packages ── bid_submissions ── evaluation_runs
           └─ rule_validation_issues
external_references (Oracle/SAP/PMIS ids)      audit_events (append-only, enforced by trigger)
```

**Systems of record:** ERP owns the vendor master, banking, POs, invoices and payments; the sourcing
system or PMIS owns tender events and awards. This module owns trade qualifications and grades, the
rulebook, evaluation results and the evidence chain, and writes back only a summary: qualification
status, trade, grade, validity, and the approved technical, commercial and final scores.

## Tests

`pip install -e .[dev] && pytest`: rubric boundaries, grading, integrity findings, activation
and four-eye rule, missing and contradicting evidence, trade weights, decision matrix, bid evaluation,
the review workflow, benchmarking, levelling, awards, approval routing, PO drafts and API smoke tests.

## Next

1. Workbook importer: read the two Excel rulebooks into `rule_sets` and friends, with a source hash and version diff.
2. Persistence: save cases, criterion scores, evidence spans, overrides and audit events per the schema.
3. Evidence agents: document classification and fact extraction (audited accounts, ISO certificates,
   manpower schedules, method statements) that feed `assess` with values, evidence and confidence.
4. ERP/PMIS sync: vendor and tender events in; qualification and evaluation summaries out.
