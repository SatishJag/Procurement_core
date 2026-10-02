"""
BOQ to PO engine: benchmark BOQ lines, level bids, build award scenarios, route approvals
and draft purchase orders. Deterministic; AI agents supply the classified lines, extracted
attributes and gate scores, this module does the arithmetic and records why.
"""

from __future__ import annotations

import statistics

GATES = ("project", "package", "functional", "technical", "commercial", "time_location")
GATE_MIN = 70            # a history record must score at least this on every gate to be comparable
REVIEW_CONFIDENCE = 75   # below this, a person reviews the benchmark
REVIEW_VARIANCE = 10     # % from the median that triggers review
NEUTRAL_BAND = 5         # % either side of benchmark treated as neutral when levelling bids
PRICING_STATUSES = ("priced", "included_elsewhere", "unpriced", "provisional_sum", "rate_only", "client_supplied")


def amount(line: dict) -> float:
    return (line.get("quantity") or 0) * (line.get("rate") or 0)


def benchmark(line: dict, history: list[dict]) -> dict:
    """
    line    = {"item_code", "quantity", "rate", "is_critical_asset"?}
    history = [{"rate" (already normalized to project currency/date/location), "project", "year",
                "adjustment", "gates": {gate: 0..100}}]
    Returns the range, confidence, variance, band and whether a person must review it.
    """
    usable, rejected = [], []
    for h in history:
        failed = [g for g in GATES if h.get("gates", {}).get(g, 0) < GATE_MIN]
        (rejected if failed else usable).append({**h, "failed_gates": failed} if failed else h)
    out: dict = {"item_code": line.get("item_code"), "comparisons": len(usable), "rejected": rejected}
    if not usable:
        return {**out, "status": "no_benchmark", "requires_review": True, "review_reasons": ["No history passes all six gates"]}

    rates = sorted(h["rate"] for h in usable)
    low, median, high = (statistics.quantiles(rates, n=4, method="inclusive") if len(rates) > 1 else [rates[0]] * 3)
    gate_avg = {g: round(statistics.mean(h["gates"][g] for h in usable), 1) for g in GATES}
    match = (gate_avg["technical"] + gate_avg["commercial"] + gate_avg["time_location"]) / 3
    confidence = round(match * min(1, 0.6 + len(usable) / 25))

    rate = line.get("rate")
    variance = round((rate - median) / median * 100, 1) if rate else None
    band = None if not rate else "over" if rate > high else "under" if rate < low else "within"
    reasons = []
    if confidence < REVIEW_CONFIDENCE:
        reasons.append(f"Confidence {confidence}% is below {REVIEW_CONFIDENCE}%")
    if variance is not None and abs(variance) > REVIEW_VARIANCE:
        reasons.append(f"Quoted rate is {variance:+.1f}% from the median")
    if line.get("is_critical_asset"):
        reasons.append("Critical data-centre asset: engineering and commercial sign-off required")
    return {
        **out, "status": "benchmarked", "low_rate": round(low, 2), "median_rate": round(median, 2), "high_rate": round(high, 2),
        "recommended_rate": round(median, 2), "gate_scores": gate_avg, "confidence": confidence,
        "variance_pct": variance, "band": band,
        "saving_to_median": round((rate - median) * line.get("quantity", 0), 2) if band == "over" else 0.0,
        "requires_review": bool(reasons), "review_reasons": reasons,
        "source_records": [{k: h.get(k) for k in ("project", "year", "rate", "adjustment")} for h in usable],
    }


def _bench_value(line: dict, bench: dict | None) -> float:
    """Benchmark value of a line: quantity x median where benchmarked, else the BOQ amount."""
    if bench and bench.get("status") == "benchmarked":
        return line["quantity"] * bench["median_rate"]
    return amount(line)


def level_bids(lines: list[dict], benchmarks: dict[str, dict], bids: list[dict]) -> list[dict]:
    """
    Normalize every bid line by line against the benchmark.
    bids = [{"bidder", "rates": {item_code: rate | None}}]. A priced BOQ line with no bid rate is unpriced.
    """
    out = []
    for b in bids:
        bills: dict[str, dict] = {}
        unpriced, outliers, total = [], [], 0.0
        for l in lines:
            if l.get("pricing_status", "priced") != "priced":
                continue
            bench = _bench_value(l, benchmarks.get(l["item_code"]))
            rate = b["rates"].get(l["item_code"])
            if rate is None:
                unpriced.append(l["item_code"])
                continue
            value = rate * l["quantity"]
            total += value
            bill = bills.setdefault(l.get("bill", "Unassigned"), {"benchmark": 0.0, "bid": 0.0})
            bill["benchmark"] += bench
            bill["bid"] += value
            var = (value - bench) / bench * 100 if bench else 0
            if abs(var) > 25:
                outliers.append({"item_code": l["item_code"], "variance_pct": round(var, 1)})
        for bill in bills.values():
            bill["variance_pct"] = round((bill["bid"] - bill["benchmark"]) / bill["benchmark"] * 100, 1) if bill["benchmark"] else None
        out.append({"bidder": b["bidder"], "total": round(total, 2), "bills": bills,
                    "unpriced_lines": unpriced, "outlier_lines": outliers})
    return out


def award_scenarios(levelled: list[dict], ranking: list[str], qualified: list[str]) -> dict:
    """
    Single award to the top-ranked bidder, and a split award where each bill goes to the
    qualified bidder closest to benchmark. ranking/qualified come from the evaluation engine.
    """
    by_name = {b["bidder"]: b for b in levelled}
    if not ranking or ranking[0] not in by_name:
        raise ValueError("Ranking must start with a levelled bidder")
    pool = [by_name[n] for n in qualified if n in by_name]
    if not pool:
        raise ValueError("No qualified bidder to split the award across")
    single = [{"bill": bill, "bidder": ranking[0], "value": v["bid"]} for bill, v in by_name[ranking[0]]["bills"].items()]
    split = []
    for bill in by_name[ranking[0]]["bills"]:
        priced = [b for b in pool if bill in b["bills"] and b["bills"][bill]["variance_pct"] is not None]
        best = min(priced, key=lambda b: abs(b["bills"][bill]["variance_pct"]))
        split.append({"bill": bill, "bidder": best["bidder"], "value": best["bills"][bill]["bid"]})
    total = lambda s: round(sum(x["value"] for x in s), 2)  # noqa: E731
    return {"single": {"lines": single, "total": total(single)}, "split": {"lines": split, "total": total(split)}}


def approval_route(value: float, authority: list[dict]) -> list[dict]:
    """Every approver whose threshold the award crosses, lowest first. authority = [{"role", "from"}]."""
    return sorted((a for a in authority if value >= a["from"]), key=lambda a: a["from"])


def draft_purchase_orders(award_lines: list[dict], project_code: str, terms: dict, start_no: int = 1,
                          wbs: dict[str, str] | None = None, cost_codes: dict[str, str] | None = None) -> list[dict]:
    """One PO per supplier from the approved award; Oracle stays the system of record for the issued PO."""
    pos = []
    for i, supplier in enumerate(dict.fromkeys(x["bidder"] for x in award_lines)):
        items = [x for x in award_lines if x["bidder"] == supplier]
        pos.append({
            "po_number": f"PO-{project_code}-{start_no + i:04d}", "supplier": supplier,
            "po_value": round(sum(x["value"] for x in items), 2), **terms, "oracle_status": "draft",
            "lines": [{"bill": x["bill"], "amount": round(x["value"], 2),
                       "wbs_code": (wbs or {}).get(x["bill"]), "cost_code": (cost_codes or {}).get(x["bill"])} for x in items],
        })
    return pos
