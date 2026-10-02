-- =============================================================
-- procurement_core: Postgres schema
-- (Vendor PreQual, bid evaluation, BOQ to PO). See README.md.
-- Master tables below are the minimum the module references; the vendor
-- master stays in the ERP and is mapped through external_references.
-- =============================================================

create extension if not exists "pgcrypto";

-- 1. MASTER DATA

create table contractors (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    annual_execution_capacity decimal not null,        -- AED/year
    headquarters_location text,
    labor_camp_location text,
    typology_strengths text[],
    annual_turnover decimal,                            -- AED
    net_worth decimal,
    current_ratio decimal,
    debt_ratio decimal,
    bonding_capacity decimal,
    vendor_type text not null default 'contractor',      -- 'contractor','consultant'
    created_at timestamptz default now()
);

create table projects (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    typology text not null,                              -- 'villas','highrise','hospitality','retail','mixed-use'
    location text,
    complexity_score decimal default 50                  -- 0-100
);

create table packages (
    id uuid primary key default gen_random_uuid(),
    project_id uuid references projects(id),
    name text,
    trade text,                                          -- 'civil','mep','facade','fitout','infrastructure'
    estimated_value decimal,
    estimated_quantity decimal,
    unit_of_measure text
);

-- Agent runs referenced by awards.
create table agent_executions (
    id uuid primary key default gen_random_uuid(),
    session_id text,
    intent text,
    agents_invoked text[],
    execution_mode text,                                   -- 'sequential','parallel','conditional'
    status text default 'running',                         -- 'running','completed','failed'
    started_at timestamptz default now(),
    completed_at timestamptz,
    error text
);

-- 2. BOQ TO PO

create table boq_documents (
    id uuid primary key default gen_random_uuid(),
    project_id uuid references projects(id) not null,
    file_name text not null,
    tender_stage text,                                    -- 'stage 4 day 2', 'tender', 'award'
    currency text not null default 'AED',
    pricing_date date,
    uploaded_by text,
    created_at timestamptz default now()
);

-- One standardized cost object per BOQ line.
create table boq_lines (
    id uuid primary key default gen_random_uuid(),
    boq_document_id uuid references boq_documents(id) not null,
    package_id uuid references packages(id),
    volume text, bill text, division text, system text, subsystem text,
    item_code text,
    original_description text not null,
    normalized_description text,
    location jsonb,                                        -- {"building":..,"floor":..,"zone":..,"phase":..}
    quantity decimal,
    unit text,
    rate decimal,
    amount decimal,
    pricing_status text not null default 'priced',        -- 'priced','included_elsewhere','unpriced','provisional_sum','rate_only','client_supplied'
    technical_attributes jsonb,                            -- material, size, capacity, voltage, current, IP/fire rating, ...
    commercial_attributes jsonb,                           -- supply/install, supports, testing, freight, taxes included ...
    is_critical_asset boolean default false               -- chillers, UPS, generators, transformers, busways, CDUs
);

-- Benchmark result per line: six matching gates plus the evidence behind the range.
create table benchmark_matches (
    id uuid primary key default gen_random_uuid(),
    boq_line_id uuid references boq_lines(id) not null,
    recommended_rate decimal,
    low_rate decimal, median_rate decimal, high_rate decimal,
    comparisons int,
    gate_scores jsonb,                                     -- {"project":100,"package":100,"functional":96,"technical":94,"commercial":91,"time_location":93}
    confidence decimal,
    source_records jsonb,                                  -- [{project, year, rate, adjustment}]
    assumptions text,
    requires_review boolean default false,
    model_version text,
    created_at timestamptz default now()
);

create table bids (
    id uuid primary key default gen_random_uuid(),
    boq_document_id uuid references boq_documents(id) not null,
    contractor_id uuid references contractors(id) not null,
    total_amount decimal,
    technical_score decimal,
    commercial_score decimal,
    overall_score decimal,
    unpriced_lines int default 0,
    submitted_at timestamptz
);

create table awards (
    id uuid primary key default gen_random_uuid(),
    boq_document_id uuid references boq_documents(id) not null,
    scenario text not null,                                -- 'single','split'
    award_value decimal,
    approval_chain jsonb,                                  -- [{role, name, approved_at}]
    status text default 'pending',                         -- 'pending','approved','rejected'
    execution_id uuid references agent_executions(id),     -- the AI recommendation it came from
    created_at timestamptz default now()
);

create table purchase_orders (
    id uuid primary key default gen_random_uuid(),
    award_id uuid references awards(id) not null,
    contractor_id uuid references contractors(id) not null,
    po_number text unique not null,
    po_value decimal,
    payment_terms text,
    retention_pct decimal,
    advance_pct decimal,
    performance_bond_pct decimal,
    oracle_status text default 'draft',                    -- 'draft','sent','acknowledged','error'
    oracle_po_id text,
    created_at timestamptz default now()
);

create table po_lines (
    id uuid primary key default gen_random_uuid(),
    purchase_order_id uuid references purchase_orders(id) not null,
    boq_line_id uuid references boq_lines(id),
    wbs_code text,
    cost_code text,
    amount decimal,
    delivery_milestones jsonb                              -- long-lead: [{milestone:'FAT', date:..}, ...]
);

-- 3. VENDOR PREQUAL AND BID EVALUATION (see procurement_core/README.md)
-- Rules are versioned data. AI proposes ratings with evidence; the engine
-- (procurement_core/prequal/engine.py) does the arithmetic; people approve.

-- Maps ERP/PMIS identifiers without copying the source master record.
create table external_references (
    id uuid primary key default gen_random_uuid(),
    system text not null,                                  -- 'oracle','sap','pmweb','procore'
    entity_type text not null,                             -- 'vendor','tender','package'
    external_id text not null,
    internal_id uuid not null,
    source_hash text,
    last_synced_at timestamptz,
    unique (system, entity_type, external_id)
);

create table trades (
    id uuid primary key default gen_random_uuid(),
    code text unique not null,                             -- 'MEP','FAC','PIL'
    name text not null,
    risk_class text not null check (risk_class in ('Low','Medium','High')),
    active boolean default true
);

-- Qualification is per vendor x trade, never per vendor.
create table vendor_trades (
    id uuid primary key default gen_random_uuid(),
    contractor_id uuid references contractors(id) not null,
    trade_id uuid references trades(id) not null,
    status text default 'applied',                         -- 'applied','qualified','not_qualified','suspended'
    unique (contractor_id, trade_id)
);

create table rule_sets (
    id uuid primary key default gen_random_uuid(),
    code text not null,                                    -- 'pq-contractor','pq-consultant','te-contractor','te-consultant','ce'
    type text not null check (type in ('prequalification','technical_evaluation','commercial_evaluation','decision_matrix')),
    party text not null default 'any',                     -- 'contractor','consultant','any'
    version text not null,
    status text not null default 'draft' check (status in ('draft','active','retired')),
    categories jsonb,                                      -- {"Financial Strength": 30, ...}
    grade_precision int default 2,
    source_hash text,                                      -- checksum of the imported workbook
    author text not null,
    approved_by text,                                      -- must differ from author (four-eye)
    effective_from date,
    created_at timestamptz default now(),
    unique (code, version),
    check (status <> 'active' or (approved_by is not null and approved_by <> author and effective_from is not null))
);

create table criteria (
    id uuid primary key default gen_random_uuid(),
    rule_set_id uuid references rule_sets(id) not null,
    code text not null,                                    -- stable id, e.g. 'PQ-FS-02', independent of workbook row
    category text,
    name text not null,
    weight decimal not null check (weight >= 0),           -- % of the rule set
    kind text not null default 'rubric' check (kind in ('rubric','numeric')),
    unit text,
    bounds text default '[)' check (bounds in ('[)','(]')),
    mandatory boolean,
    no_evidence_rating int check (no_evidence_rating between 1 and 5),
    evaluator_role text,
    unique (rule_set_id, code)
);

create table rubric_bands (
    id uuid primary key default gen_random_uuid(),
    criterion_id uuid references criteria(id) not null,
    rating int not null check (rating between 1 and 5),
    rubric_text text not null,
    min_value decimal,                                     -- numeric criteria only; null = open
    max_value decimal,
    unique (criterion_id, rating)
);

-- Trade-specific weight sets (e.g. MEP lifts technical compliance and commissioning).
create table criterion_trade_weights (
    id uuid primary key default gen_random_uuid(),
    criterion_id uuid references criteria(id) not null,
    trade_id uuid references trades(id) not null,
    applicable boolean default true,
    weight decimal not null check (weight >= 0),
    unique (criterion_id, trade_id)
);

create table grade_bands (
    id uuid primary key default gen_random_uuid(),
    rule_set_id uuid references rule_sets(id) not null,
    grade text not null,                                   -- 'A','B','C','D'
    min_score decimal not null,
    max_score decimal not null,
    unique (rule_set_id, grade)
);

-- Project complexity + package risk -> eligible grades and TE/CE weighting.
create table tender_decision_rules (
    id uuid primary key default gen_random_uuid(),
    rule_set_id uuid references rule_sets(id) not null,
    complexity text not null check (complexity in ('Low','Medium','High')),
    package_risk text not null check (package_risk in ('Low','Medium','High')),
    eligible_grades text[] not null,
    technical_weight decimal not null,
    commercial_weight decimal not null,
    pathway_code text,                                     -- governed label only; the weights above are authoritative
    unique (rule_set_id, complexity, package_risk),
    check (technical_weight + commercial_weight = 100)
);

create table rule_validation_issues (
    id uuid primary key default gen_random_uuid(),
    rule_set_id uuid references rule_sets(id) not null,
    severity text not null check (severity in ('error','warning')),
    check_type text not null,                              -- 'criteria_total','category_subweights','pathway_label', ...
    details text not null,
    resolution text,
    resolved_by text,
    created_at timestamptz default now()
);

-- One PQ run per vendor x trade; the published row is the current qualification.
create table qualification_assessments (
    id uuid primary key default gen_random_uuid(),
    vendor_trade_id uuid references vendor_trades(id) not null,
    rule_set_id uuid references rule_sets(id) not null,
    score decimal,                                         -- 0..1
    grade text,
    status text not null default 'ai_suggested',           -- 'ai_suggested','under_review','lead_approved','committee_approved','published'
    official boolean default false,                        -- scored against an active, clean rule set
    valid_from date,
    valid_to date,                                         -- drives expiry and requalification alerts
    created_at timestamptz default now()
);

create table bid_packages (
    id uuid primary key default gen_random_uuid(),
    package_id uuid references packages(id),
    external_event_id text,                                -- tender event in the sourcing system or PMIS
    trade_id uuid references trades(id) not null,
    party text not null default 'contractor',
    complexity text not null check (complexity in ('Low','Medium','High')),
    package_risk text not null check (package_risk in ('Low','Medium','High')),
    decision_rule_id uuid references tender_decision_rules(id),
    estimated_value decimal,
    tender_date date not null
);

create table bid_submissions (
    id uuid primary key default gen_random_uuid(),
    bid_package_id uuid references bid_packages(id) not null,
    contractor_id uuid references contractors(id) not null,
    revision int default 0,
    price decimal,
    currency text default 'AED',
    eligible boolean,
    eligibility_reason text,
    technical_score decimal,                               -- composite result, written by the engine
    commercial_score decimal,
    technical_weight decimal,
    commercial_weight decimal,
    total_score decimal,
    rank int,
    submitted_at timestamptz,
    unique (bid_package_id, contractor_id, revision)
);

-- One scoring run: a PQ assessment, or the TE or CE envelope of a bid.
create table evaluation_runs (
    id uuid primary key default gen_random_uuid(),
    qualification_assessment_id uuid references qualification_assessments(id),
    bid_submission_id uuid references bid_submissions(id),
    evaluation_type text not null check (evaluation_type in ('prequalification','technical','commercial')),
    rule_set_id uuid references rule_sets(id) not null,
    model_version text,
    score decimal,
    status text not null default 'incomplete',             -- 'incomplete','review_required','complete'
    created_at timestamptz default now(),
    check ((qualification_assessment_id is null) <> (bid_submission_id is null))
);

create table criterion_scores (
    id uuid primary key default gen_random_uuid(),
    evaluation_run_id uuid references evaluation_runs(id) not null,
    criterion_id uuid references criteria(id) not null,
    extracted_value decimal,                               -- numeric fact; the engine derives the rating
    ai_rating int check (ai_rating between 1 and 5),
    final_rating int check (final_rating between 1 and 5),
    weight decimal not null,
    weighted_score decimal,                                -- final_rating / 5 x weight
    confidence decimal,
    evidence_state text not null default 'missing' check (evidence_state in ('confirmed','contradicts','missing')),
    review_state text not null default 'ai_suggested',     -- 'ai_suggested','accepted','overridden','evidence_required'
    reviewed_by text,
    unique (evaluation_run_id, criterion_id)
);

create table evidence_documents (
    id uuid primary key default gen_random_uuid(),
    contractor_id uuid references contractors(id),
    bid_submission_id uuid references bid_submissions(id),
    document_type text not null,                           -- 'audited_accounts','iso_certificate','method_statement', ...
    storage_uri text not null,
    checksum text not null,
    expiry_date date,
    source_system text,
    created_at timestamptz default now()
);

-- Exact provenance: which page of which document supports which score.
create table evidence_spans (
    id uuid primary key default gen_random_uuid(),
    document_id uuid references evidence_documents(id) not null,
    criterion_score_id uuid references criterion_scores(id),
    page int,
    section text,
    extracted_value text,
    confidence decimal,
    model_version text
);

create table score_overrides (
    id uuid primary key default gen_random_uuid(),
    criterion_score_id uuid references criterion_scores(id) not null,
    original_rating int not null,
    override_rating int not null check (override_rating between 1 and 5),
    reason_code text not null,
    comments text,
    overridden_by text not null,
    approved_by text,
    created_at timestamptz default now()
);

-- Append-only decision history for PQ, evaluation and rule changes.
create table audit_events (
    id uuid primary key default gen_random_uuid(),
    actor text not null,
    event_type text not null,                              -- 'override','lead_approve','rule_activated', ...
    entity_type text not null,
    entity_id uuid not null,
    before_hash text,
    after_hash text,
    rule_set_version text,
    model_version text,
    details jsonb,
    created_at timestamptz default now()
);

create or replace function audit_events_append_only() returns trigger language plpgsql as $$
begin
    raise exception 'audit_events is append-only';
end $$;

create trigger audit_events_no_change before update or delete on audit_events
    for each row execute function audit_events_append_only();
