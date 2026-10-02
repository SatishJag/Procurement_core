"""
REST API for Vendor PreQual, bid evaluation and BOQ to PO.

Stateless for now: callers send the facts, the engines return governed results. Persisting
cases, scores and evidence uses the tables in the schema (see procurement_core/README.md).
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from procurement_core import boq
from procurement_core.prequal import engine as pq

router = APIRouter(prefix="/api", tags=["procurement-core"])
Level = Literal["Low", "Medium", "High"]


def _book() -> dict:
    return pq.load_rulebook()


def _run(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'\""))
    except (ValueError, pq.GovernanceError, pq.RuleIntegrityError) as e:
        raise HTTPException(422, str(e))


class Evidence(BaseModel):
    document: str
    page: int | None = None
    section: str | None = None
    extract: str | None = None


class CriterionInput(BaseModel):
    value: float | None = None
    rating: int | None = Field(None, ge=1, le=5)
    final_rating: int | None = Field(None, ge=1, le=5)
    evidence_state: Literal["confirmed", "contradicts", "missing"] = "confirmed"
    evidence: list[Evidence] = []
    confidence: float | None = Field(None, ge=0, le=1)
    resolved: bool = False


def _inputs(d: dict[str, CriterionInput]) -> dict[str, dict]:
    return {k: v.model_dump(exclude_none=True) for k, v in d.items()}


# ── Rules ────────────────────────────────────────────────

@router.get("/prequal/rulebook")
def rulebook_summary():
    book = _book()
    report = pq.validate_rulebook(book)
    return {
        "version": book["version"], "source": book["source"], "grade_bands": book["grade_bands"], "trades": book["trades"],
        "rule_sets": [{"id": rs["id"], "label": rs["label"], "type": rs["type"], "party": rs["party"], "status": rs["status"],
                       "criteria": len(rs["criteria"]), "blocking_issues": len(pq.blocking(report[rs["id"]]))} for rs in book["rule_sets"]],
        "decision_matrix_issues": len(pq.blocking(report["decision_matrix"])),
    }


@router.get("/prequal/rulesets/{rs_id}")
def get_rule_set(rs_id: str):
    return _run(pq.rule_set, _book(), rs_id)


@router.get("/prequal/integrity")
def integrity():
    """Rule integrity report: anything with severity 'error' blocks activation."""
    return pq.validate_rulebook(_book())


@router.get("/prequal/decision-matrix")
def decision_matrix():
    book = _book()
    return {"rules": book["decision_matrix"], "issues": pq.validate_decision_matrix(book)}


class DecisionRequest(BaseModel):
    complexity: Level
    package_risk: Level | None = None
    trade: str | None = None


@router.post("/prequal/decision")
def decision(req: DecisionRequest):
    return _run(pq.decide, _book(), req.complexity, req.package_risk, req.trade)


# ── Assessment and evaluation ────────────────────────────

class AssessRequest(BaseModel):
    rule_set: str
    trade: str | None = None
    inputs: dict[str, CriterionInput]


@router.post("/prequal/assess")
def assess(req: AssessRequest):
    """Score a vendor x trade PQ, or one TE/CE envelope, with a line-by-line explanation."""
    return _run(pq.assess, _book(), req.rule_set, _inputs(req.inputs), req.trade)


class Qualification(BaseModel):
    grade: str | None = None
    valid_to: str | None = None


class Bid(BaseModel):
    bidder: str
    price: float | None = None
    qualification: Qualification
    technical: dict[str, CriterionInput] = {}
    commercial: dict[str, CriterionInput] = {}


class Package(BaseModel):
    trade: str
    complexity: Level
    package_risk: Level | None = None
    tender_date: str
    party: Literal["contractor", "consultant"] = "contractor"


class EvaluateRequest(BaseModel):
    package: Package
    bids: list[Bid] = Field(min_length=1)


@router.post("/prequal/evaluate-bids")
def evaluate_bids(req: EvaluateRequest):
    """Eligibility from the decision matrix, then TE + CE + composite ranking for every eligible bid."""
    bids = [{**b.model_dump(exclude={"technical", "commercial"}), "technical": _inputs(b.technical), "commercial": _inputs(b.commercial)}
            for b in req.bids]
    return _run(pq.evaluate_bids, _book(), req.package.model_dump(exclude_none=True), bids)


# ── BOQ to PO ────────────────────────────────────────────

class HistoryRecord(BaseModel):
    rate: float = Field(gt=0)
    project: str | None = None
    year: int | None = None
    adjustment: str | None = None
    gates: dict[str, float]


class BenchmarkRequest(BaseModel):
    item_code: str
    quantity: float = Field(ge=0)
    rate: float | None = Field(None, ge=0)
    is_critical_asset: bool = False
    history: list[HistoryRecord]


@router.post("/boq/benchmark")
def benchmark_line(req: BenchmarkRequest):
    line = req.model_dump(exclude={"history"})
    return _run(boq.benchmark, line, [h.model_dump() for h in req.history])


class Authority(BaseModel):
    role: str
    name: str | None = None
    from_: float = Field(alias="from", ge=0)


class RouteRequest(BaseModel):
    value: float = Field(ge=0)
    authority: list[Authority]


@router.post("/boq/approval-route")
def approval_route(req: RouteRequest):
    return boq.approval_route(req.value, [{**a.model_dump(by_alias=True)} for a in req.authority])


class BoqLine(BaseModel):
    item_code: str
    bill: str | None = None
    quantity: float = Field(ge=0)
    rate: float | None = Field(None, ge=0)
    pricing_status: Literal["priced", "included_elsewhere", "unpriced", "provisional_sum", "rate_only", "client_supplied"] = "priced"


class BidRates(BaseModel):
    bidder: str
    rates: dict[str, float | None]


class LevelRequest(BaseModel):
    lines: list[BoqLine]
    benchmarks: dict[str, dict] = {}   # item_code -> /boq/benchmark result
    bids: list[BidRates]


@router.post("/boq/level-bids")
def level_bids(req: LevelRequest):
    return boq.level_bids([l.model_dump() for l in req.lines], req.benchmarks, [b.model_dump() for b in req.bids])


class AwardRequest(BaseModel):
    levelled: list[dict]               # /boq/level-bids result
    ranking: list[str]                 # bidder names, best first, from /prequal/evaluate-bids
    qualified: list[str]


@router.post("/boq/award-scenarios")
def award_scenarios(req: AwardRequest):
    return _run(boq.award_scenarios, req.levelled, req.ranking, req.qualified)


class AwardLine(BaseModel):
    bill: str
    bidder: str
    value: float = Field(ge=0)


class PORequest(BaseModel):
    award_lines: list[AwardLine] = Field(min_length=1)
    project_code: str
    terms: dict[str, str | float] = {}
    start_no: int = Field(1, ge=1)
    wbs: dict[str, str] = {}
    cost_codes: dict[str, str] = {}


@router.post("/boq/purchase-orders")
def purchase_orders(req: PORequest):
    """Draft POs from an approved award, one per supplier, for handoff to Oracle."""
    return boq.draft_purchase_orders([a.model_dump() for a in req.award_lines], req.project_code, req.terms,
                                     req.start_no, req.wbs, req.cost_codes)
