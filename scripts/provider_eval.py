"""Model-provider eval on synthetic cases (scripts/provider_eval_cases.py). DEV ONLY.

Runs each case through the product's real code path with the chosen provider and reports
per-dimension accuracy, schema failures, latency and token cost. Never uses real referrals.

  python -m scripts.provider_eval --provider openai
  python -m scripts.provider_eval --provider anthropic --max-usd 2.5
  python -m scripts.provider_eval --provider deterministic          # no model: the baseline

Options: --only triage,teaching,agent  --cases <id-prefix>  --json <path>  --max-usd <budget>
         --price-in / --price-out (USD per million tokens, when the model isn't in PRICES)

Keys come from the environment / the gitignored .env (OPENAI_API_KEY, ANTHROPIC_API_KEY) and are
never printed. The eval runs in the dev profile (synthetic data; no demo spend limits apply).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

os.environ.setdefault("LAMINA_PROFILE", "dev")

from backend.config import environment
from backend.model_provider import AnthropicProvider, OpenAIProvider
from backend.pilot import assistant as assistant_module
from backend.pilot.models import IntakeReferral, PracticeRule
from backend.pilot.teaching import TeachingService, deterministic_interpret
from backend.pilot.triage import (
    DocumentText,
    ResponsesEvidenceExtractor,
    triage_referral,
)
from backend.professional_services import ResponsesApiClient
from scripts import provider_eval_cases as cases

TODAY = date(2026, 11, 24)
# USD per million tokens (input, output). Anthropic first-party list prices.
PRICES = {
    "claude-opus-5-5": (4.00, 20.00), "claude-sonnet-5-5": (2.00, 10.00), "claude-haiku-5-5": (0.10, 0.50),
}


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class Call:
    use_case: str
    latency_ms: float
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None
    schema_ok: bool = True


@dataclass
class Recorder:
    """Wraps a provider: records latency, tokens, schema validity and errors per call."""

    inner: Any
    price: tuple[float, float] | None
    max_usd: float | None
    calls: list[Call] = field(default_factory=list)

    @property
    def name(self) -> str:
        return self.inner.name

    @property
    def model(self) -> str:
        return getattr(self.inner, "model", "") or getattr(self.inner, "model_id", "")

    @property
    def available(self) -> bool:
        return self.inner.available

    @property
    def approved_for_patient_data(self) -> bool:
        return False

    def cost(self) -> float | None:
        if self.price is None:
            return None
        tokens_in = sum(call.input_tokens for call in self.calls)
        tokens_out = sum(call.output_tokens for call in self.calls)
        return tokens_in / 1e6 * self.price[0] + tokens_out / 1e6 * self.price[1]

    def structured(self, instructions: str, payload: dict, schema: dict, *, use_case: str, schema_name: str,
                   contains_patient_data: bool, web_search: bool = False) -> dict:
        spent = self.cost()
        if self.max_usd is not None and spent is not None and spent >= self.max_usd:
            raise BudgetExceeded(f"budget of ${self.max_usd:.2f} reached")
        started = time.perf_counter()
        call = Call(use_case=use_case, latency_ms=0.0)
        try:
            result = self.inner.structured(instructions, payload, schema, use_case=use_case, schema_name=schema_name,
                                           contains_patient_data=contains_patient_data, web_search=web_search)
            problems = schema_problems(result, schema)
            if problems:
                call.schema_ok, call.error = False, "schema: " + problems[0]
            return result
        except Exception as error:  # recorded, then re-raised to the product code (which falls back)
            call.schema_ok = False
            call.error = type(error).__name__ + (f": {error}"[:160] if not isinstance(error, (KeyError,)) else "")
            raise
        finally:
            call.latency_ms = (time.perf_counter() - started) * 1000
            usage = getattr(self.inner, "last_usage", None) or {}
            call.input_tokens = int(usage.get("input_tokens") or 0)
            call.output_tokens = int(usage.get("output_tokens") or 0)
            self.inner.last_usage = None
            self.calls.append(call)


def schema_problems(value: Any, schema: dict, path: str = "$") -> list[str]:
    """A small JSON-schema check (the subset our schemas use)."""
    kinds = schema.get("type")
    kinds = kinds if isinstance(kinds, list) else [kinds] if kinds else []
    checks = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}
    if kinds:
        ok = any((kind == "integer" and isinstance(value, int) and not isinstance(value, bool))
                 or (kind == "number" and isinstance(value, (int, float)) and not isinstance(value, bool))
                 or (kind in checks and isinstance(value, checks[kind])) for kind in kinds)
        if not ok:
            return [f"{path} has the wrong type"]
    if "enum" in schema and value not in schema["enum"]:
        return [f"{path} is not one of the allowed values"]
    problems: list[str] = []
    if isinstance(value, dict) and "properties" in schema:
        for key in schema.get("required", []):
            if key not in value:
                problems.append(f"{path}.{key} is missing")
        if schema.get("additionalProperties") is False:
            problems += [f"{path}.{key} is not allowed" for key in value if key not in schema["properties"]]
        for key, sub in schema["properties"].items():
            if key in value:
                problems += schema_problems(value[key], sub, f"{path}.{key}")
    if isinstance(value, list) and "items" in schema:
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            problems.append(f"{path} has too many items")
        if "minItems" in schema and len(value) < schema["minItems"]:
            problems.append(f"{path} has too few items")
        for index, item in enumerate(value):
            problems += schema_problems(item, schema["items"], f"{path}[{index}]")
    return problems


# ------------------------------------------------------------------------------ runners


def _rule(referral_type: str) -> PracticeRule:
    spec = cases.RULES[referral_type]
    content = {key: spec[key] for key in ("good_fit", "redirect", "required", "helpful", "urgent_signals", "modality")}
    return PracticeRule.model_validate({
        "id": f"rule_eval_{referral_type.lower().replace(' ', '_')}", "practice_id": "prc_eval", "referral_type": referral_type,
        "content": content, "source_text": "eval", "source": "eval", "scope": "practice", "operational_status": "confirmed",
        "physician_confirmed": True, "publishable": False, "version": spec["version"],
        "created_at": "2026-11-01T00:00:00+00:00", "updated_at": "2026-11-01T00:00:00+00:00",
    })


def run_triage(case: dict, recorder: Recorder | None) -> dict:
    referral = IntakeReferral.model_validate({
        "id": f"ref_{case['id']}", "practice_id": "prc_eval", "source": "manual", "status": "received",
        "sender": {"name": "Dr. Eval Sender"}, "receiver_practice_id": "prc_eval", "patient": {"name": "Eval Patient"},
        "referral_type": case["type"], "reason": case["reason"],
        "submitted_items": [{k: v for k, v in item.items() if k != "verified"} for item in case.get("submitted", [])],
        "received_at": "2026-11-20T00:00:00+00:00", "entered_at": "2026-11-20T00:00:00+00:00", "entered_by": "user:eval",
        "created_at": "2026-11-20T00:00:00+00:00", "updated_at": "2026-11-20T00:00:00+00:00",
    })
    documents = [DocumentText(f"doc_{case['id']}", "referral.txt", case["pages"])]
    extractor = ResponsesEvidenceExtractor(ResponsesApiClient(provider=recorder)) if recorder else None
    recommendation, _ = triage_referral(referral, [_rule(case["type"])], documents, today=TODAY, extractor=extractor)
    expect = case["expect"]
    states = {item.key: ("proposed" if item.state == "proposed_from_document" else "missing" if item.state in
                         {"missing", "optional_missing"} else item.state) for item in recommendation.requirements}
    checks = {"fit": recommendation.fit == expect["fit"], "priority": recommendation.suggested_priority == expect["priority"],
              "visit_type": recommendation.suggested_modality == expect["modality"]}
    item_checks = {key: states.get(key) == wanted for key, wanted in expect["states"].items()}
    checks["items"] = all(item_checks.values())
    windows = {item.key: item.window_status for item in recommendation.requirements}
    if expect.get("windows"):
        checks["evidence_window"] = all(windows.get(key) == wanted for key, wanted in expect["windows"].items())
    got = {"fit": recommendation.fit, "priority": recommendation.suggested_priority,
           "visit_type": recommendation.suggested_modality, "states": {k: states.get(k) for k in expect["states"]},
           "missing_items": recommendation.missing_items, "windows": {k: windows.get(k) for k in expect.get("windows", {})}}
    return {"checks": checks, "item_checks": item_checks, "got": got}


def run_teaching(case: dict, recorder: Recorder | None) -> dict:
    if recorder is None:
        result = deterministic_interpret(case["text"], cases.KNOWN_TYPES)
    else:
        result = TeachingService(rules=None, client=ResponsesApiClient(provider=recorder)).interpret(case["text"], cases.KNOWN_TYPES)
    expect, content = case["expect"], result["content"]
    required = [(item["label"], item.get("freshness_days")) for item in content.get("required", [])]
    helpful = [item["label"] for item in content.get("helpful", [])]
    got_type = result.get("referral_type") or None
    if expect["type"] == "__new__":  # not a practice type: a clarification (None) or a new type, never a known one
        type_ok = got_type is None or got_type not in cases.KNOWN_TYPES
    else:
        type_ok = got_type == expect["type"]
    checks: dict[str, bool] = {"referral_type": type_ok}
    wanted = expect.get("required", [])
    matched_required = all(sum(1 for label, _ in required if re.search(pattern, label, re.IGNORECASE)) >= 1 for pattern, _ in wanted)
    checks["required_items"] = matched_required and len(required) == len(wanted)
    if any(days is not None for _, days in wanted) or required:
        checks["time_windows"] = matched_required and all(
            any(re.search(pattern, label, re.IGNORECASE) and got_days == days for label, got_days in required) for pattern, days in wanted)
    for key, field_name in (("outside", "outside_scope"), ("good_fit", "good_fit"), ("urgent", "urgent_signals"), ("helpful", None)):
        if key in expect:
            items = helpful if field_name is None else content.get(field_name, [])
            checks[key] = all(any(re.search(pattern, item, re.IGNORECASE) for item in items) for pattern in expect[key])
    forbidden = expect.get("forbid", []) + expect.get("forbid_required", [])
    if forbidden:
        pool = [label for label, _ in required] + ([] if expect.get("forbid_required") and not expect.get("forbid") else helpful)
        checks["nothing_invented"] = not any(re.search(pattern, label, re.IGNORECASE) for pattern in forbidden for label in pool)
    if "modality" in expect:
        checks["visit_type"] = content.get("modality") == expect["modality"]
    got = {"referral_type": result.get("referral_type"), "required": required, "helpful": helpful,
           "outside_scope": content.get("outside_scope"), "good_fit": content.get("good_fit"),
           "urgent": content.get("urgent_signals"), "modality": content.get("modality"), "interpreter": result.get("interpreter")}
    return {"checks": checks, "got": got}


def run_agent(case: dict, recorder: Recorder | None) -> dict:
    if recorder is None:
        return {"checks": {}, "got": "n/a (no model: the agent answers deterministically)"}
    client = ResponsesApiClient(provider=recorder)
    try:
        result = client.structured(assistant_module._COMPOSE_INSTRUCTIONS, {"question": case["question"], "facts": case["facts"]},
                                   assistant_module._COMPOSE_SCHEMA, use_case="pilot_agent_compose", schema_name="agent_answer",
                                   contains_patient_data=True)
        text = " ".join([*result.get("paragraphs", []), *result.get("bullets", [])])
    except BudgetExceeded:
        raise
    except Exception:  # noqa: BLE001 -- the product falls back to its deterministic answer
        return {"checks": {"answered": False}, "got": "(model call failed)"}
    return {"checks": grade_agent(case, text), "got": text}


def grade_agent(case: dict, text: str) -> dict[str, bool]:
    expect = case["expect"]
    text = text.replace("’", "'").replace("‘", "'")  # curly apostrophes ("don’t")
    # A forbidden claim counts only in a sentence that makes it, not one that reports it as an
    # untrusted document's claim or instruction ("the document claims the TSH is normal").
    attributed = re.compile(expect.get("unless_attributed", r"$^"), re.IGNORECASE)
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return {"answered": True,
            "required_content": all(re.search(pattern, text, re.IGNORECASE) for pattern in expect.get("must", [])),
            "no_forbidden_claim": not any(re.search(pattern, sentence, re.IGNORECASE) and not attributed.search(sentence)
                                          for pattern in expect.get("must_not", []) for sentence in sentences)}


def regrade(path: str) -> dict:
    """Re-grade saved agent answers with the current graders (no model calls)."""
    saved = json.loads(Path(path).read_text(encoding="utf-8"))
    by_id = {case["id"]: case for case in cases.AGENT}
    for row in saved["results"].get("agent", []):
        if row["checks"].get("answered") and row["id"] in by_id:
            row["checks"] = grade_agent(by_id[row["id"]], row["got"])
    return saved


def run_extraction(case: dict, recorder: Recorder | None) -> dict:
    """Run 3: intake field extraction. A provider is graded on the MODEL's proposals alone (the
    product merges them under the rule-based ones); the no-model baseline is the rule-based mapper."""
    from backend.pilot import extraction as ex

    pages = [ex._page(text) for text in case["pages"]]
    if recorder is None:
        proposals = ex.propose_fields(pages, cases.EXTRACTION_TYPES)
    else:
        try:
            proposals = ex.model_proposals(ResponsesApiClient(provider=recorder), pages, cases.EXTRACTION_TYPES)
        except BudgetExceeded:
            raise
        except Exception:  # noqa: BLE001 -- a failed call proposes nothing (the rules still stand in the product)
            proposals = {"fields": {}, "results": []}
    fields, expect = proposals["fields"], case["expect"]
    norm = lambda text: " ".join(str(text or "").split()).casefold()
    checks: dict[str, bool] = {}
    for name, wanted in expect.get("fields", {}).items():
        got = fields.get(name) or {}
        value = got.get("matched_type") if name == "referral_type" else got.get("value")
        checks[f"field_{name}"] = norm(value) == norm(wanted)
    if expect.get("name_contains"):
        checks["field_patient_name"] = all(token in norm((fields.get("patient_name") or {}).get("value")) for token in expect["name_contains"])
    if expect.get("absent"):
        checks["nothing_invented"] = not any(name in fields for name in expect["absent"])
    if expect.get("type_unmatched"):
        checks["field_referral_type"] = not (fields.get("referral_type") or {}).get("matched_type")
    if "result_dates" in expect:
        checks["result_dates"] = sorted({item["date"] for item in proposals["results"] if item.get("date")}) == sorted(expect["result_dates"])
    got = {name: entry.get("matched_type") or entry.get("value") for name, entry in fields.items()}
    return {"checks": checks, "got": {"fields": got, "result_dates": [item.get("date") for item in proposals["results"]]}}


DIMENSIONS = {"triage": (cases.TRIAGE, run_triage), "teaching": (cases.TEACHING, run_teaching), "agent": (cases.AGENT, run_agent),
              "extraction": (cases.EXTRACTION, run_extraction)}


def make_provider(name: str) -> Any:
    if name == "openai":
        return OpenAIProvider(model=environment.get("LAMINA_OPENAI_MODEL", ""), api_key=environment.get("OPENAI_API_KEY", ""))
    if name == "anthropic":
        return AnthropicProvider()
    raise SystemExit(f"unknown provider {name!r} (openai, anthropic or deterministic)")


def summarize(results: dict, recorder: Recorder | None) -> dict:
    summary: dict[str, Any] = {"dimensions": {}}
    for dimension, rows in results.items():
        checks: dict[str, list[bool]] = {}
        for row in rows:
            for name, ok in row["checks"].items():
                checks.setdefault(name, []).append(ok)
        passed = [all(row["checks"].values()) for row in rows if row["checks"]]
        summary["dimensions"][dimension] = {
            "cases": len(rows), "cases_passed": sum(passed), "case_accuracy": round(sum(passed) / len(passed), 3) if passed else None,
            "checks": {name: f"{sum(values)}/{len(values)}" for name, values in checks.items()},
        }
        if dimension == "triage":
            items = [ok for row in rows for ok in row["item_checks"].values()]
            summary["dimensions"][dimension]["item_state_accuracy"] = round(sum(items) / len(items), 3) if items else None
    if recorder is not None:
        latencies = sorted(call.latency_ms for call in recorder.calls)
        summary["calls"] = len(recorder.calls)
        summary["schema_failures"] = sum(1 for call in recorder.calls if not call.schema_ok)
        summary["errors"] = sorted({call.error for call in recorder.calls if call.error})
        summary["latency_ms"] = {"p50": round(statistics.median(latencies)) if latencies else None,
                                 "p90": round(latencies[int(0.9 * (len(latencies) - 1))]) if latencies else None,
                                 "max": round(latencies[-1]) if latencies else None}
        summary["tokens"] = {"input": sum(c.input_tokens for c in recorder.calls), "output": sum(c.output_tokens for c in recorder.calls)}
        cost = recorder.cost()
        summary["cost_usd"] = round(cost, 4) if cost is not None else None
        summary["model"] = recorder.model
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Provider eval on synthetic cases")
    parser.add_argument("--provider", required=True, choices=["openai", "anthropic", "deterministic"])
    parser.add_argument("--only", default="triage,teaching,agent,extraction")
    parser.add_argument("--cases", default="", help="run only cases whose id starts with this")
    parser.add_argument("--max-usd", type=float, default=None)
    parser.add_argument("--price-in", type=float, default=None)
    parser.add_argument("--price-out", type=float, default=None)
    parser.add_argument("--json", default=None, help="write the full results here")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--regrade", default=None, help="re-grade a saved --json file's agent answers (no model calls)")
    args = parser.parse_args(argv)
    if os.environ.get("LAMINA_PROFILE") != "dev":
        raise SystemExit("run the eval in the dev profile")
    if args.regrade:
        saved = regrade(args.regrade)
        summary = summarize(saved["results"], None)
        summary["regraded_from"] = args.regrade
        summary["run"] = {k: saved["summary"].get(k) for k in ("model", "calls", "schema_failures", "latency_ms", "tokens", "cost_usd")}
        print(json.dumps(summary, indent=2))
        if args.json:
            Path(args.json).write_text(json.dumps({"summary": summary, "results": saved["results"]}, indent=2, default=str),
                                       encoding="utf-8")
        return 0
    recorder = None
    if args.provider != "deterministic":
        provider = make_provider(args.provider)
        if not provider.available:
            raise SystemExit(f"the {args.provider} provider is not configured (model and key)")
        model = getattr(provider, "model", "")
        price = (args.price_in, args.price_out) if args.price_in is not None and args.price_out is not None else PRICES.get(model)
        if args.max_usd is not None and price is None:
            raise SystemExit("--max-usd needs a known price: pass --price-in and --price-out")
        recorder = Recorder(provider, price, args.max_usd)
    results: dict[str, list] = {}
    stopped = None
    for dimension in [d.strip() for d in args.only.split(",") if d.strip()]:
        rows: list[dict] = []
        results[dimension] = rows
        case_list, runner = DIMENSIONS[dimension]
        for case in case_list:
            if args.cases and not case["id"].startswith(args.cases):
                continue
            start = len(recorder.calls) if recorder else 0
            try:
                row = runner(case, recorder)
            except BudgetExceeded as error:
                stopped = str(error)
                break
            if recorder is not None and any(isinstance(c.error, str) and "BudgetExceeded" in c.error for c in recorder.calls[start:]):
                stopped = "budget reached"
                break
            row["id"] = case["id"]
            row["calls"] = [call.__dict__ for call in recorder.calls[start:]] if recorder else []
            rows.append(row)
            if not args.quiet:
                failed = [name for name, ok in row["checks"].items() if not ok]
                mark = "n/a" if not row["checks"] else "PASS" if not failed else "FAIL " + ",".join(failed)
                print(f"[{dimension}] {case['id']}: {mark}")
                if failed:
                    print(f"    got: {json.dumps(row['got'], ensure_ascii=False)[:600]}")
        if stopped:
            break
    summary = summarize(results, recorder)
    summary["provider"] = args.provider
    if stopped:
        summary["stopped"] = stopped
    print(json.dumps(summary, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps({"summary": summary, "results": results}, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
