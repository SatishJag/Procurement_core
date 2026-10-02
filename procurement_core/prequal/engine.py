"""
Vendor PreQual and bid evaluation engine.

The rulebook is data (rulebook.json, later the rule tables); this module is the governed,
deterministic arithmetic around it. AI proposes ratings or extracts facts with evidence;
this engine turns them into scores, grades, eligibility and rankings, identically every time.

    contribution = rating / 5 * weight          (weight in %)
    score        = sum(contribution) / 100      (0..1, graded at `grade_precision` decimals)
    final bid    = TE% * technical_weight + CE% * commercial_weight
"""

from __future__ import annotations

import copy
import hashlib
import json
from decimal import ROUND_HALF_UP, Decimal
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

RULEBOOK = Path(__file__).with_name("rulebook.json")
LEVELS = ("Low", "Medium", "High")
EVIDENCE_STATES = ("confirmed", "contradicts", "missing")


class RuleIntegrityError(ValueError):
    """Raised when a rule set with blocking integrity issues is activated."""


class GovernanceError(ValueError):
    """Raised when a review step breaks the workflow or segregation of duties."""


# ── Rulebook access ──────────────────────────────────────

@lru_cache(maxsize=1)
def _load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_rulebook(path: Path | str = RULEBOOK) -> dict:
    """Return a private copy so callers can't mutate the cached rulebook."""
    return copy.deepcopy(_load(str(path)))


def rule_set(book: dict, rs_id: str) -> dict:
    for rs in book["rule_sets"]:
        if rs["id"] == rs_id:
            return rs
    raise KeyError(f"Unknown rule set '{rs_id}'")


def trade(book: dict, code: str) -> dict:
    for t in book["trades"]:
        if t["code"] == code:
            return t
    raise KeyError(f"Unknown trade '{code}'")


def weights(rs: dict, trade_code: str | None = None) -> dict[str, float]:
    """Criterion weights in %, with the trade-specific override set when one exists."""
    override = (rs.get("trade_weights") or {}).get(trade_code or "")
    return {c["id"]: float(override.get(c["id"], 0) if override else c["weight"]) for c in rs["criteria"]}


def _band_matches(lo, hi, v: float, bounds: str) -> bool:
    if bounds == "(]":
        return (lo is None or v > lo) and (hi is None or v <= hi)
    return (lo is None or v >= lo) and (hi is None or v < hi)


def rate(criterion: dict, value: float) -> int:
    """Rubric rating for an extracted numeric fact, e.g. CA/CL 1.32 -> 4."""
    if criterion.get("kind") != "numeric":
        raise ValueError(f"{criterion['id']} is not a numeric criterion")
    bounds = criterion.get("bounds", "[)")
    for rating, _text, lo, hi in criterion["bands"]:
        if _band_matches(lo, hi, value, bounds):
            return rating
    raise ValueError(f"{criterion['id']}: value {value} falls outside every rubric band")


def rubric_text(criterion: dict, rating: int) -> str:
    return next(b[1] for b in criterion["bands"] if b[0] == rating)


def _round(x: float, places: int) -> float:
    """Half-up decimal rounding, so 0.705 grades the same on every platform."""
    return float(Decimal(repr(x)).quantize(Decimal(1).scaleb(-places), ROUND_HALF_UP))


def grade(book: dict, score: float) -> str | None:
    s = _round(score, book["grade_precision"])
    return next((g["grade"] for g in book["grade_bands"] if g["min"] <= s <= g["max"]), None)


# ── Rule integrity ───────────────────────────────────────

def _issue(check: str, detail: str, severity: str = "error") -> dict:
    return {"severity": severity, "check": check, "detail": detail}


def validate_rule_set(rs: dict) -> list[dict]:
    """Checks a rule set must pass before it can move from draft to active."""
    issues: list[dict] = []
    ids = [c["id"] for c in rs["criteria"]]
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        issues.append(_issue("duplicate_criterion", f"Criterion id {dup} appears more than once"))

    total = sum(c["weight"] for c in rs["criteria"])
    if abs(total - 100) > 1e-9:
        issues.append(_issue("criteria_total", f"Criterion weights total {total:g}%, not 100%"))

    cats = rs.get("categories") or {}
    if cats:
        if abs(sum(cats.values()) - 100) > 1e-9:
            issues.append(_issue("category_total", f"Category weights total {sum(cats.values()):g}%, not 100%"))
        for name, w in cats.items():
            sub = sum(c["weight"] for c in rs["criteria"] if c.get("category") == name)
            if abs(sub - w) > 1e-9:
                issues.append(_issue("category_subweights", f"{name}: subcriteria total {sub:g}% against a category weight of {w:g}%"))
        for c in rs["criteria"]:
            if c.get("category") not in cats:
                issues.append(_issue("unknown_category", f"{c['id']} has category '{c.get('category')}', not in the rule set"))

    for code, tw in (rs.get("trade_weights") or {}).items():
        if set(tw) != set(ids):
            issues.append(_issue("trade_weights_coverage", f"Trade {code}: weights must list every criterion exactly once"))
        if abs(sum(tw.values()) - 100) > 1e-9:
            issues.append(_issue("trade_weights_total", f"Trade {code}: weights total {sum(tw.values()):g}%, not 100%"))

    for c in rs["criteria"]:
        if sorted(b[0] for b in c["bands"]) != [1, 2, 3, 4, 5]:
            issues.append(_issue("rubric_ratings", f"{c['id']}: needs exactly one rubric band for each rating 1 to 5"))
        if c.get("kind") == "numeric":
            issues += _numeric_band_issues(c)
        if rs.get("requires_mandatory_flag") and not isinstance(c.get("mandatory"), bool):
            issues.append(_issue("mandatory_flag", f"{c['id']}: mandatory or preferred status is not defined"))
        if c.get("mandatory") and c.get("no_evidence_rating") is not None:
            issues.append(_issue("mandatory_fallback", f"{c['id']}: a mandatory criterion can't fall back to a no-evidence rating"))

    if rs.get("status") == "active" and not (rs.get("effective_from") and rs.get("approved_by")):
        issues.append(_issue("activation_metadata", "Active rule set needs an effective date and an approver"))
    return issues


def _numeric_band_issues(c: dict) -> list[dict]:
    bands = sorted(c["bands"], key=lambda b: float("-inf") if b[2] is None else b[2])
    out = []
    if bands[0][2] is not None and bands[0][2] > 0:
        out.append(_issue("rubric_gap", f"{c['id']}: values below {bands[0][2]:g} match no band", "warning"))
    if bands[-1][3] is not None:
        out.append(_issue("rubric_gap", f"{c['id']}: values above {bands[-1][3]:g} match no band", "warning"))
    for a, b in zip(bands, bands[1:]):
        if a[3] is None or b[2] is None or a[3] != b[2]:
            kind = "overlap" if (a[3] is None or (b[2] is not None and a[3] > b[2])) else "gap"
            out.append(_issue(f"rubric_{kind}", f"{c['id']}: bands for ratings {a[0]} and {b[0]} {kind} ({a[3]} vs {b[2]})"))
    return out


def validate_grade_bands(book: dict) -> list[dict]:
    """Bands must tile (0, 1] at the grading precision with no gap or overlap."""
    step = 10 ** -book["grade_precision"]
    bands = sorted(book["grade_bands"], key=lambda g: g["min"])
    issues = []
    if abs(bands[0]["min"] - step) > 1e-9:
        issues.append(_issue("grade_bands", f"Lowest grade starts at {bands[0]['min']}, not {step:g}"))
    if abs(bands[-1]["max"] - 1) > 1e-9:
        issues.append(_issue("grade_bands", f"Highest grade ends at {bands[-1]['max']}, not 1.00"))
    for a, b in zip(bands, bands[1:]):
        if abs(b["min"] - a["max"] - step) > 1e-9:
            kind = "overlap" if b["min"] <= a["max"] else "gap"
            issues.append(_issue("grade_bands", f"Grade {a['grade']} ends {a['max']} and grade {b['grade']} starts {b['min']}: {kind}"))
    return issues


def validate_decision_matrix(book: dict) -> list[dict]:
    issues = []
    grades = {g["grade"] for g in book["grade_bands"]}
    seen: dict[tuple, int] = {}
    pathway_weights: dict[str, set] = {}
    for row in book["decision_matrix"]:
        key = (row["complexity"], row["package_risk"])
        seen[key] = seen.get(key, 0) + 1
        if row["technical_weight"] + row["commercial_weight"] != 100:
            issues.append(_issue("tc_weights", f"{key}: technical + commercial = {row['technical_weight'] + row['commercial_weight']}%"))
        if not row["eligible_grades"] or set(row["eligible_grades"]) - grades:
            issues.append(_issue("eligible_grades", f"{key}: eligible grades {row['eligible_grades']} are not valid grades"))
        pathway_weights.setdefault(row["pathway_code"], set()).add((row["technical_weight"], row["commercial_weight"]))
    for c in LEVELS:
        for r in LEVELS:
            n = seen.get((c, r), 0)
            if n != 1:
                issues.append(_issue("matrix_resolution", f"Complexity {c} with package risk {r} resolves to {n} rules, needs exactly 1"))
    for code, ws in sorted(pathway_weights.items()):
        if len(ws) > 1:
            issues.append(_issue("pathway_label", f"{code} maps to more than one weighting in the decision matrix: {sorted(ws)}"))
        for src, mapping in (book.get("pathway_sources") or {}).items():
            if code in mapping and tuple(mapping[code]) not in ws:
                tw, cw = sorted(ws)[0]
                issues.append(_issue("pathway_label", f"{code} is {tw}/{cw} in the decision matrix but {mapping[code][0]}/{mapping[code][1]} in {src}"))
    return issues


def validate_rulebook(book: dict) -> dict[str, list[dict]]:
    report = {rs["id"]: validate_rule_set(rs) for rs in book["rule_sets"]}
    report["grade_bands"] = validate_grade_bands(book)
    report["decision_matrix"] = validate_decision_matrix(book)
    return report


def blocking(issues: list[dict]) -> list[dict]:
    return [i for i in issues if i["severity"] == "error"]


def activate(book: dict, rs_id: str, approver: str, effective_from: str) -> dict:
    """Draft -> active, only with clean integrity checks and a second person approving."""
    rs = rule_set(book, rs_id)
    errors = blocking(validate_rule_set(rs) + validate_grade_bands(book) + validate_decision_matrix(book))
    if errors:
        raise RuleIntegrityError(f"{rs_id} has {len(errors)} blocking issue(s): " + "; ".join(e["detail"] for e in errors))
    if approver == rs.get("author"):
        raise GovernanceError("The rule set author can't approve their own rule set")
    rs.update(status="active", approved_by=approver, effective_from=effective_from)
    return rs


# ── Assessment ───────────────────────────────────────────

def assess(book: dict, rs_id: str, inputs: dict[str, dict], trade_code: str | None = None) -> dict:
    """
    Score one vendor (PQ) or one bid envelope (TE/CE) against a rule set.

    inputs[criterion_id] = {
        "value": number            # numeric criteria: the extracted fact; the engine rates it
        "rating": 1..5             # rubric criteria: the AI or evaluator proposal
        "final_rating": 1..5       # set by a human override; the proposal is kept as ai_rating
        "evidence_state": "confirmed" | "contradicts" | "missing"
        "evidence": [{"document", "page", "section", "extract"}],
        "confidence": 0..1,
    }
    """
    rs = rule_set(book, rs_id)
    if trade_code is not None:
        trade(book, trade_code)
    w = weights(rs, trade_code)
    lines = [_line(rs, c, w[c["id"]], inputs.get(c["id"]) or {}) for c in rs["criteria"]]
    scored = [l for l in lines if l["rating"] is not None]
    precision = book["grade_precision"]
    score = sum(l["contribution"] for l in scored) / 100
    issues = validate_rule_set(rs)
    incomplete = any(l["status"] == "evidence_required" for l in lines)
    review = any(l["status"] == "review_required" for l in lines)
    official = rs.get("status") == "active" and not blocking(issues)
    return {
        "rule_set": rs_id,
        "rule_set_version": book["version"],
        "rule_set_status": rs.get("status"),
        "trade": trade_code,
        "score": _round(score, precision),
        "score_pct": _round(score * 100, 1),
        "grade": None if incomplete or rs["type"] != "prequalification" else grade(book, score),
        "status": "incomplete" if incomplete else "review_required" if review else "complete",
        "official": official,
        "governance": [] if official else (
            [f"Rule set is {rs.get('status')}, so this result is provisional"] + [i["detail"] for i in blocking(issues)]
        ),
        "lines": lines,
        "open_items": [f"{l['criterion']}: {l['note']}" for l in lines if l["status"] in ("evidence_required", "review_required")],
    }


def _line(rs: dict, c: dict, weight: float, inp: dict) -> dict:
    state = inp.get("evidence_state", "missing" if not inp else "confirmed")
    if state not in EVIDENCE_STATES:
        raise ValueError(f"{c['id']}: evidence_state must be one of {EVIDENCE_STATES}")
    for k in ("rating", "final_rating"):
        if inp.get(k) is not None and inp[k] not in (1, 2, 3, 4, 5):
            raise ValueError(f"{c['id']}: {k} must be an integer from 1 to 5")

    line = {
        "criterion": c["id"], "name": c["name"], "category": c.get("category"), "weight": weight,
        "mandatory": c.get("mandatory", False), "evaluator_role": c.get("role"),
        "value": inp.get("value"), "unit": c.get("unit"), "ai_rating": None, "rating": None,
        "rubric": None, "contribution": 0.0, "calculation": None, "evidence_state": state,
        "evidence": inp.get("evidence", []), "confidence": inp.get("confidence"),
        "status": "scored", "note": None,
    }
    if weight == 0:
        return {**line, "status": "not_applicable", "note": "Carries no weight for this trade or rule set"}

    proposed = inp.get("rating")
    if c.get("kind") == "numeric" and inp.get("value") is not None:
        proposed = rate(c, float(inp["value"]))
    if state == "missing" and proposed is None and inp.get("final_rating") is None:
        if c.get("mandatory") or c.get("no_evidence_rating") is None:
            return {**line, "status": "evidence_required", "note": "No evidence; request it from the vendor"}
        proposed, line["note"], line["status"] = c["no_evidence_rating"], "Rated per rubric: no evidence submitted", "rated_no_evidence"
    if proposed is None and inp.get("final_rating") is None:
        return {**line, "status": "evidence_required", "note": "Evidence present but not yet rated"}

    final = inp.get("final_rating") or proposed
    contribution = final / 5 * weight
    line.update(
        ai_rating=proposed, rating=final, rubric=rubric_text(c, final), contribution=round(contribution, 4),
        calculation=f"{final}/5 x {weight:g}% = {contribution:.2f}%",
    )
    if inp.get("final_rating") and inp["final_rating"] != proposed:
        line["note"] = f"Overridden from {proposed} to {final}"
    if state == "contradicts" and not inp.get("resolved"):
        line.update(status="review_required", note="Evidence contradicts the requirement or another document")
    return line


# ── Tender decision and bid evaluation ───────────────────

def decide(book: dict, complexity: str, package_risk: str | None = None, trade_code: str | None = None) -> dict:
    """Eligible grades and TE/CE weighting for a bid package, from the decision matrix."""
    source = "given" if package_risk else "trade risk class"
    if package_risk is None:
        if trade_code is None:
            raise ValueError("Give a package risk or a trade to derive it from")
        package_risk = trade(book, trade_code)["risk_class"]
    if complexity not in LEVELS or package_risk not in LEVELS:
        raise ValueError(f"Complexity and package risk must be one of {LEVELS}")
    rows = [r for r in book["decision_matrix"] if r["complexity"] == complexity and r["package_risk"] == package_risk]
    if len(rows) != 1:
        raise RuleIntegrityError(f"Decision matrix resolves ({complexity}, {package_risk}) to {len(rows)} rules")
    return {**rows[0], "package_risk_source": source}


def evaluate_bids(book: dict, package: dict, bids: list[dict]) -> dict:
    """
    package = {"trade", "complexity", "package_risk"?, "tender_date" (ISO), "party": "contractor"|"consultant"}
    bids    = [{"bidder", "price", "qualification": {"grade", "valid_to"}, "technical": inputs, "commercial": inputs}]
    """
    rule = decide(book, package["complexity"], package.get("package_risk"), package["trade"])
    tender_date = date.fromisoformat(package["tender_date"])
    te_rs = "te-consultant" if package.get("party") == "consultant" else "te-contractor"

    eligible, excluded = [], []
    for b in bids:
        q = b.get("qualification") or {}
        reason = None
        if q.get("grade") not in rule["eligible_grades"]:
            reason = f"Grade {q.get('grade') or 'none'} for {package['trade']}; package needs {'/'.join(rule['eligible_grades'])}"
        elif not q.get("valid_to") or date.fromisoformat(q["valid_to"]) < tender_date:
            reason = f"Qualification expired {q.get('valid_to') or '(no date)'}"
        elif not b.get("price") or b["price"] <= 0:
            reason = "No valid price submitted"
        if reason:
            excluded.append({"bidder": b["bidder"], "grade": q.get("grade"), "valid_to": q.get("valid_to"), "reason": reason})
        else:
            eligible.append(b)

    l1 = min((b["price"] for b in eligible), default=None)
    results = []
    for b in eligible:
        above = (b["price"] - l1) / l1 * 100
        commercial = {**(b.get("commercial") or {}), "CE-01": {"value": round(above, 4), "evidence_state": "confirmed",
                      "evidence": [{"document": "Form of tender", "extract": f"{b['price']:,.0f}, {above:.1f}% above L1"}]}}
        te = assess(book, te_rs, b.get("technical") or {}, package["trade"])
        ce = assess(book, "ce", commercial)
        total = te["score_pct"] * rule["technical_weight"] / 100 + ce["score_pct"] * rule["commercial_weight"] / 100
        results.append({
            "bidder": b["bidder"], "price": b["price"], "above_l1_pct": round(above, 1),
            "technical": te, "commercial": ce,
            "technical_pct": te["score_pct"], "commercial_pct": ce["score_pct"], "total": round(total, 1),
            "calculation": f"{te['score_pct']}% x {rule['technical_weight']}% + {ce['score_pct']}% x {rule['commercial_weight']}% = {total:.1f}",
            "status": "complete" if te["status"] == ce["status"] == "complete" else "open_items",
        })
    results.sort(key=lambda r: (-r["total"], r["price"]))
    for i, r in enumerate(results, 1):
        r["rank"] = i
    official = all(r["technical"]["official"] and r["commercial"]["official"] for r in results)
    return {"decision_rule": rule, "l1": l1, "ranking": results, "excluded": excluded, "official": official}


# ── Human in the loop ────────────────────────────────────
# ai_suggested -> under_review (accept / override per criterion) -> lead_approved
#   -> committee_approved -> published. Approvers can't be evaluators on the same case.

def _hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def open_case(book: dict, rs_id: str, inputs: dict[str, dict], trade_code: str | None = None) -> dict:
    result = assess(book, rs_id, inputs, trade_code)
    return {
        "rule_set": rs_id, "trade": trade_code, "inputs": copy.deepcopy(inputs), "result": result,
        "state": "ai_suggested", "decisions": {}, "evaluators": [], "approvers": [],
        "audit": [_event("system", "case_opened", None, result)],
    }


def _event(actor: str, action: str, before: Any, after: Any, **extra) -> dict:
    return {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "actor": actor, "action": action,
            "before_hash": _hash(before) if before is not None else None, "after_hash": _hash(after), **extra}


def review(book: dict, case: dict, action: str, actor: str, criterion: str | None = None,
           rating: int | None = None, reason_code: str | None = None, comment: str | None = None) -> dict:
    before = case["result"]
    if action in ("accept", "override"):
        if case["state"] not in ("ai_suggested", "under_review"):
            raise GovernanceError(f"Can't {action} a criterion once the case is {case['state']}")
        line = next((l for l in before["lines"] if l["criterion"] == criterion), None)
        if line is None:
            raise ValueError(f"Unknown criterion {criterion}")
        if line["status"] in ("not_applicable", "evidence_required"):
            raise GovernanceError(f"{criterion} is {line['status']} and has no rating to {action}")
        inp = case["inputs"].setdefault(criterion, {})
        if action == "override":
            if rating not in (1, 2, 3, 4, 5) or not reason_code:
                raise GovernanceError("An override needs a rating from 1 to 5 and a reason code")
            inp["final_rating"] = rating
        elif line["status"] == "review_required" and not comment:
            raise GovernanceError("Accepting contradicting evidence needs a comment explaining why")
        if line["status"] == "review_required":
            inp["resolved"] = True
        case["decisions"][criterion] = {"action": action, "actor": actor, "ai_rating": line["ai_rating"],
                                        "final_rating": rating if action == "override" else line["rating"],
                                        "reason_code": reason_code, "comment": comment}
        if actor not in case["evaluators"]:
            case["evaluators"].append(actor)
        case["state"] = "under_review"
    elif action == "lead_approve":
        _require(case, "under_review")
        pending = [l["criterion"] for l in before["lines"] if l["rating"] is not None and l["criterion"] not in case["decisions"]]
        if pending or before["status"] != "complete":
            raise GovernanceError(f"Every rated criterion needs a decision and no open items may remain: {pending + before['open_items']}")
        _segregate(case, actor)
        case["state"] = "lead_approved"
    elif action == "committee_approve":
        _require(case, "lead_approved")
        _segregate(case, actor)
        case["state"] = "committee_approved"
    elif action == "publish":
        _require(case, "committee_approved")
        if not before["official"]:
            raise GovernanceError("Can't publish a provisional result: " + "; ".join(before["governance"]))
        case["state"] = "published"
    else:
        raise ValueError(f"Unknown action {action}")

    case["result"] = assess(book, case["rule_set"], case["inputs"], case["trade"])
    case["audit"].append(_event(actor, action, before, case["result"], criterion=criterion, rating=rating,
                                reason_code=reason_code, comment=comment, state=case["state"]))
    return case


def _require(case: dict, state: str) -> None:
    if case["state"] != state:
        raise GovernanceError(f"Case is {case['state']}; this step needs {state}")


def _segregate(case: dict, actor: str) -> None:
    if actor in case["evaluators"] or actor in case["approvers"]:
        raise GovernanceError(f"{actor} already evaluated or approved this case")
    case["approvers"].append(actor)
