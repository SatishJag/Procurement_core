"""Tests for procurement_core: Vendor PreQual rules engine, bid evaluation and BOQ to PO."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from procurement_core import boq
from procurement_core.api import router
from procurement_core.prequal import engine as pq


@pytest.fixture
def book():
    return pq.load_rulebook()


def crit(book, rs_id, cid):
    return next(c for c in pq.rule_set(book, rs_id)["criteria"] if c["id"] == cid)


def all_rated(book, rs_id, rating=4, **overrides):
    """Inputs that rate every rubric criterion `rating`, numeric ones by a value in the matching band."""
    out = {}
    for c in pq.rule_set(book, rs_id)["criteria"]:
        if c["kind"] == "numeric":
            _, _, lo, hi = next(b for b in c["bands"] if b[0] == rating)
            value = hi if c.get("bounds") == "(]" else (lo if lo is not None else hi - 1)
            out[c["id"]] = {"value": value, "evidence": [{"document": "PQ submission", "page": 1}]}
        else:
            out[c["id"]] = {"rating": rating, "evidence": [{"document": "PQ submission", "page": 1}], "confidence": 0.9}
    out.update(overrides)
    return out


# ── Rule integrity ───────────────────────────────────────

def test_integrity_catches_the_workbook_issues(book):
    report = pq.validate_rulebook(book)
    ce = [i["detail"] for i in pq.blocking(report["ce"])]
    assert "Criterion weights total 95%, not 100%" in ce
    assert any("Cost Control" in d for d in ce)
    matrix = [i["detail"] for i in pq.blocking(report["decision_matrix"])]
    assert any(d.startswith("P1 is 50/50") for d in matrix)
    assert any(d.startswith("P3 is 70/30") for d in matrix)
    for rs in ("pq-contractor", "pq-consultant", "te-contractor", "te-consultant"):
        assert pq.blocking(report[rs]) == [], rs
    assert report["grade_bands"] == []


def test_integrity_detects_broken_rules(book):
    rs = pq.rule_set(book, "pq-contractor")
    rs["criteria"][0]["bands"] = rs["criteria"][0]["bands"][:4]
    rs["criteria"][5]["bands"][1][2] = 1.2  # 4-band now overlaps the 3-band
    rs["trade_weights"] = {"MEP": {"PQ-CP-01": 100}}
    checks = {i["check"] for i in pq.validate_rule_set(rs)}
    assert {"rubric_ratings", "rubric_overlap", "trade_weights_coverage"} <= checks
    book["grade_bands"][1]["min"] = 0.72
    assert "gap" in pq.validate_grade_bands(book)[0]["detail"]


def test_activation_needs_clean_rules_and_a_second_person(book):
    with pytest.raises(pq.RuleIntegrityError):
        pq.activate(book, "ce", "governance.lead", "2026-11-01")
    book["pathway_sources"] = {}
    with pytest.raises(pq.GovernanceError):
        pq.activate(book, "pq-contractor", "rules-import", "2026-11-01")
    rs = pq.activate(book, "pq-contractor", "governance.lead", "2026-11-01")
    assert rs["status"] == "active" and pq.validate_rule_set(rs) == []


# ── Rating and grading ───────────────────────────────────

@pytest.mark.parametrize("ratio,rating", [(1.62, 5), (1.5, 5), (1.49, 4), (1.25, 4), (1.1, 3), (1.0, 2), (0.95, 1)])
def test_working_capital_rubric(book, ratio, rating):
    assert pq.rate(crit(book, "pq-contractor", "PQ-FS-02"), ratio) == rating


@pytest.mark.parametrize("above,rating", [(0, 5), (0.01, 4), (5, 4), (5.01, 3), (10, 3), (15, 2), (15.1, 1)])
def test_price_against_l1_rubric(book, above, rating):
    assert pq.rate(crit(book, "ce", "CE-01"), above) == rating


@pytest.mark.parametrize("score,grade", [(0.86, "A"), (0.855, "A"), (0.854, "B"), (0.705, "B"), (0.7049, "C"), (0.51, "C"), (0.5, "D"), (0.004, None)])
def test_grade_bands_round_half_up(book, score, grade):
    assert pq.grade(book, score) == grade


# ── Assessment ───────────────────────────────────────────

def test_pq_assessment_is_deterministic_and_explained(book):
    result = pq.assess(book, "pq-contractor", all_rated(book, "pq-contractor", 4), "MEP")
    assert result["score"] == 0.8 and result["grade"] == "B" and result["status"] == "complete"
    assert result["official"] is False and "provisional" in result["governance"][0]
    wc = next(l for l in result["lines"] if l["criterion"] == "PQ-TC-02")
    assert wc["rating"] == 4 and wc["calculation"] == "4/5 x 8% = 6.40%" and wc["rubric"] == "50% to 69%"
    testimonials = next(l for l in result["lines"] if l["criterion"] == "PQ-CP-04")
    assert testimonials["status"] == "not_applicable"
    assert pq.assess(book, "pq-contractor", all_rated(book, "pq-contractor", 4), "MEP") == result


def test_extracted_value_sets_the_rating(book):
    inputs = all_rated(book, "pq-contractor", 4, **{"PQ-TC-02": {"value": 58, "rating": 2}})
    line = next(l for l in pq.assess(book, "pq-contractor", inputs)["lines"] if l["criterion"] == "PQ-TC-02")
    assert line["rating"] == 4


def test_missing_evidence_only_rates_1_where_the_rubric_says_so(book):
    inputs = all_rated(book, "pq-contractor", 4)
    inputs["PQ-PM-02"] = {"evidence_state": "missing"}   # rubric: not submitted = 1
    result = pq.assess(book, "pq-contractor", inputs)
    line = next(l for l in result["lines"] if l["criterion"] == "PQ-PM-02")
    assert (line["rating"], line["status"]) == (1, "rated_no_evidence") and result["grade"] == "B"

    del inputs["PQ-TC-01"]                               # no fallback: evidence required, no grade
    result = pq.assess(book, "pq-contractor", inputs)
    assert result["status"] == "incomplete" and result["grade"] is None
    assert any(i.startswith("PQ-TC-01") for i in result["open_items"])


def test_mandatory_consultant_criterion_never_falls_back(book):
    inputs = all_rated(book, "pq-consultant", 5, **{"PQ-CN-02": {"evidence_state": "missing"}, "PQ-CN-06": {"evidence_state": "missing"}})
    result = pq.assess(book, "pq-consultant", inputs)
    status = {l["criterion"]: l["status"] for l in result["lines"]}
    assert status["PQ-CN-02"] == "evidence_required" and status["PQ-CN-06"] == "rated_no_evidence"


def test_contradicting_evidence_needs_review(book):
    inputs = all_rated(book, "pq-contractor", 4, **{"PQ-FS-01": {"value": 640, "evidence_state": "contradicts"}})
    assert pq.assess(book, "pq-contractor", inputs)["status"] == "review_required"


def test_trade_weights_apply(book):
    w = pq.weights(pq.rule_set(book, "te-contractor"), "MEP")
    assert w["TE-05"] == 16 and w["TE-07"] == 14 and sum(w.values()) == 100
    assert pq.weights(pq.rule_set(book, "te-contractor"), "LND")["TE-05"] == 14


def test_unknown_inputs_are_rejected(book):
    with pytest.raises(KeyError):
        pq.assess(book, "pq-contractor", {}, "XYZ")
    with pytest.raises(ValueError):
        pq.assess(book, "pq-contractor", {"PQ-CP-03": {"rating": 7}})


# ── Tender decision and bid evaluation ───────────────────

def test_decision_matrix(book):
    rule = pq.decide(book, "Medium", trade_code="MEP")
    assert rule["eligible_grades"] == ["A", "B"] and (rule["technical_weight"], rule["commercial_weight"]) == (70, 30)
    assert rule["package_risk_source"] == "trade risk class"
    assert pq.decide(book, "Low", "Low")["eligible_grades"] == ["A", "B", "C"]
    with pytest.raises(ValueError):
        pq.decide(book, "Extreme", "Low")


def test_evaluate_bids(book):
    tech = all_rated(book, "te-contractor", 4)
    comm = {k: v for k, v in all_rated(book, "ce", 4).items() if k != "CE-01"}
    q = lambda g, d="2027-06-30": {"grade": g, "valid_to": d}  # noqa: E731
    bids = [
        {"bidder": "Alpha", "price": 100e6, "qualification": q("A"), "technical": all_rated(book, "te-contractor", 3), "commercial": comm},
        {"bidder": "Beta", "price": 104e6, "qualification": q("B"), "technical": tech, "commercial": comm},
        {"bidder": "Gamma", "price": 90e6, "qualification": q("C"), "technical": tech, "commercial": comm},
        {"bidder": "Delta", "price": 95e6, "qualification": q("A", "2026-09-30"), "technical": tech, "commercial": comm},
    ]
    out = pq.evaluate_bids(book, {"trade": "MEP", "complexity": "Medium", "tender_date": "2026-10-15"}, bids)
    assert {e["bidder"] for e in out["excluded"]} == {"Gamma", "Delta"}
    assert out["l1"] == 100e6
    alpha, beta = (next(r for r in out["ranking"] if r["bidder"] == n) for n in ("Alpha", "Beta"))
    assert alpha["commercial"]["lines"][0]["rating"] == 5 and beta["commercial"]["lines"][0]["rating"] == 4
    # CE: price 5/5 x 50 + 45% of other weight at 4/5 = 86% (the draft CE set only reaches 95%); 70/30 weighting
    assert (alpha["technical_pct"], alpha["commercial_pct"], alpha["total"]) == (60.0, 86.0, 67.8)
    assert (beta["technical_pct"], beta["commercial_pct"], beta["total"]) == (80.0, 76.0, 78.8)
    assert [r["bidder"] for r in out["ranking"]] == ["Beta", "Alpha"] and out["official"] is False


# ── Human in the loop ────────────────────────────────────

def test_review_workflow(book):
    inputs = all_rated(book, "pq-contractor", 4, **{"PQ-FS-01": {"value": 640, "evidence_state": "contradicts"}})
    case = pq.open_case(book, "pq-contractor", inputs, "MEP")
    with pytest.raises(pq.GovernanceError):
        pq.review(book, case, "override", "eval.a", criterion="PQ-TC-01", rating=5)        # no reason code
    pq.review(book, case, "override", "eval.a", criterion="PQ-TC-01", rating=5, reason_code="NEW_EVIDENCE")
    assert case["decisions"]["PQ-TC-01"]["ai_rating"] == 4 and case["result"]["score"] == 0.82
    with pytest.raises(pq.GovernanceError):
        pq.review(book, case, "accept", "eval.a", criterion="PQ-FS-01")                    # contradiction needs a comment
    for line in case["result"]["lines"]:
        if line["rating"] is not None and line["criterion"] not in case["decisions"]:
            pq.review(book, case, "accept", "eval.b", criterion=line["criterion"], comment="Audited accounts govern")
    assert case["result"]["status"] == "complete"
    with pytest.raises(pq.GovernanceError):
        pq.review(book, case, "lead_approve", "eval.a")                                    # evaluator can't approve
    pq.review(book, case, "lead_approve", "lead.x")
    with pytest.raises(pq.GovernanceError):
        pq.review(book, case, "committee_approve", "lead.x")
    pq.review(book, case, "committee_approve", "committee.y")
    with pytest.raises(pq.GovernanceError):
        pq.review(book, case, "publish", "committee.y")                                    # rule set still draft
    assert case["state"] == "committee_approved"
    assert all(e["after_hash"] for e in case["audit"]) and case["audit"][-1]["actor"] == "committee.y"


# ── BOQ to PO ────────────────────────────────────────────

GOOD = {g: 90 for g in boq.GATES}


def test_benchmark_uses_only_gate_passing_history():
    history = [{"rate": r, "project": f"P{i}", "year": 2025, "gates": GOOD} for i, r in enumerate([40000, 42000, 44500, 46000, 49000])]
    history.append({"rate": 90000, "project": "CRAH not CDU", "gates": {**GOOD, "functional": 40}})
    out = boq.benchmark({"item_code": "ELE-BW-01", "quantity": 10, "rate": 52000, "is_critical_asset": True}, history)
    assert out["comparisons"] == 5 and out["rejected"][0]["failed_gates"] == ["functional"]
    assert (out["low_rate"], out["median_rate"], out["high_rate"]) == (42000, 44500, 46000)
    assert out["band"] == "over" and out["variance_pct"] == 16.9 and out["saving_to_median"] == 75000
    assert out["confidence"] == 72 and out["requires_review"] and len(out["review_reasons"]) == 3
    assert boq.benchmark({"item_code": "X", "quantity": 1}, [])["status"] == "no_benchmark"


def test_level_award_route_and_po():
    lines = [
        {"item_code": "M1", "bill": "Mechanical", "quantity": 10, "rate": 100},
        {"item_code": "E1", "bill": "Electrical", "quantity": 10, "rate": 100},
        {"item_code": "C1", "bill": "Electrical", "quantity": 1, "rate": 0, "pricing_status": "client_supplied"},
    ]
    bench = {"M1": {"status": "benchmarked", "median_rate": 100}, "E1": {"status": "benchmarked", "median_rate": 100}}
    levelled = boq.level_bids(lines, bench, [
        {"bidder": "A", "rates": {"M1": 98, "E1": 130}},
        {"bidder": "B", "rates": {"M1": 120, "E1": 101}},
        {"bidder": "C", "rates": {"M1": 100, "E1": None}},
    ])
    a, _, c = levelled
    assert a["bills"]["Electrical"]["variance_pct"] == 30.0 and a["outlier_lines"][0]["item_code"] == "E1"
    assert c["unpriced_lines"] == ["E1"]
    award = boq.award_scenarios(levelled, ["A", "B", "C"], ["A", "B"])
    assert award["single"]["total"] == 2280 and award["split"]["total"] == 1990
    assert [x["bidder"] for x in award["split"]["lines"]] == ["A", "B"]
    route = boq.approval_route(60e6, [{"role": "CFO", "from": 50e6}, {"role": "PM", "from": 0}, {"role": "CEO", "from": 150e6}])
    assert [r["role"] for r in route] == ["PM", "CFO"]
    pos = boq.draft_purchase_orders(award["split"]["lines"], "DC4", {"retention_pct": 10}, start_no=142, wbs={"Mechanical": "DC4.04.MEC"})
    assert [p["po_number"] for p in pos] == ["PO-DC4-0142", "PO-DC4-0143"]
    assert pos[0]["lines"][0]["wbs_code"] == "DC4.04.MEC" and pos[0]["oracle_status"] == "draft"


# ── API ──────────────────────────────────────────────────

def test_api_smoke():
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    summary = client.get("/api/prequal/rulebook").json()
    assert {r["id"]: r["blocking_issues"] for r in summary["rule_sets"]}["ce"] == 2
    assert client.post("/api/prequal/decision", json={"complexity": "High", "trade": "FAC"}).json()["eligible_grades"] == ["A"]
    r = client.post("/api/prequal/assess", json={"rule_set": "pq-contractor", "inputs": {"PQ-FS-02": {"value": 1.32}}})
    assert r.status_code == 200 and r.json()["status"] == "incomplete"
    assert client.post("/api/prequal/assess", json={"rule_set": "nope", "inputs": {}}).status_code == 404
    assert client.post("/api/prequal/assess", json={"rule_set": "ce", "inputs": {"CE-02": {"rating": 9}}}).status_code == 422
    route = client.post("/api/boq/approval-route", json={"value": 12e6, "authority": [{"role": "PM", "from": 0}, {"role": "VP", "from": 10e6}]})
    assert [a["role"] for a in route.json()] == ["PM", "VP"]
