#!/usr/bin/env python3
"""
Promo Model Checker — Daily audit of WorkBuddy's promotional/free model lineup.

Reads the WorkBuddy local storage product config, extracts modelPromotions,
compares against the previous snapshot, and outputs a diff report.
Updates the snapshot file for the next run.

Usage:
    python3 promo-model-check.py [--snapshot PATH] [--source PATH] [--report-dir PATH]
"""

import json
import os
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path


# ---- Defaults ----

DEFAULT_SOURCE = os.path.expanduser(
    "~/.workbuddy-ai/local_storage/entry_d43e96994f944cfb77961c2ea7d04605.info"
)
DEFAULT_SNAPSHOT = (
    "/Users/guru/workbuddy-ai/promocheck/.workbuddy-ai/memory/automations/"
    "6c4ddfb3-c8d0-41be-8c59-0aa138bd5afc/promo-models-snapshot.json"
)
DEFAULT_REPORT_DIR = (
    "/Users/guru/workbuddy-ai/promocheck/.workbuddy-ai/memory/automations/"
    "6c4ddfb3-c8d0-41be-8c59-0aa138bd5afc"
)

# Days threshold for "imminent expiry" warning
IMMINENT_DAYS = 7


def parse_args():
    p = argparse.ArgumentParser(description="Audit WorkBuddy promo models")
    p.add_argument("--source", default=DEFAULT_SOURCE, help="Path to local storage .info file")
    p.add_argument("--snapshot", default=DEFAULT_SNAPSHOT, help="Path to snapshot JSON file")
    p.add_argument("--report-dir", default=DEFAULT_REPORT_DIR, help="Directory for report output")
    return p.parse_args()


def load_source(path):
    """Load the WorkBuddy local storage file and extract modelPromotions + models."""
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # The file is a list of entries: [{ userId, data, ts }]
    # data contains modelPromotions (array), models (array), productFeaturesConfig (object)
    if isinstance(raw, list):
        if not raw:
            raise ValueError("Source file is an empty list")
        data = raw[0].get("data", {})
    elif isinstance(raw, dict):
        data = raw.get("data", raw)
    else:
        raise ValueError(f"Unexpected source format: {type(raw).__name__}")

    promos = data.get("modelPromotions", [])

    # models is a list of model objects — convert to dict keyed by id
    raw_models = data.get("models", [])
    if isinstance(raw_models, list):
        models = {m.get("id", ""): m for m in raw_models}
    else:
        models = raw_models  # already a dict

    features = data.get("productFeaturesConfig", {})

    return promos, models, features


def enrich_promo(promo, models, features):
    """Convert a raw modelPromotion entry into a rich comparison record."""
    model_ids = promo.get("modelIds", [])
    model_id = model_ids[0] if model_ids else ""

    # Look up model info
    model_info = models.get(model_id, {})
    model_name = model_info.get("name") or model_id
    base_credits = model_info.get("credits", "unknown")
    description = model_info.get("descriptionEn") or model_info.get("descriptionZh", "")

    # Extract discount info
    discount = promo.get("discount", {})
    factor = discount.get("factor", 1)
    discounted_credits = discount.get("discountedCredits", "")

    # Extract schedule info
    schedule = promo.get("schedule", {})
    valid_from = schedule.get("validFrom", "")
    valid_until = schedule.get("validUntil", "")
    tz = schedule.get("timezone", "Asia/Shanghai")

    # Extract badge info
    badge_obj = promo.get("badge", {})
    badge_label = badge_obj.get("label", "")

    # Extract hover text
    hover_obj = promo.get("hover", {})
    hover_text = hover_obj.get("textZh", "")

    # Calculate days remaining
    days_remaining = None
    if valid_until:
        try:
            dt_until = datetime.fromisoformat(valid_until)
            now = datetime.now(timezone.utc)
            delta = dt_until - now
            days_remaining = max(0, delta.days)
        except (ValueError, TypeError):
            days_remaining = None

    # Check for paid variant in ModelRateLimitCap
    paid_variant = None
    cap_config = features.get("ModelRateLimitCap", {})
    for line in cap_config.get("lines", []):
        if line.get("freeId") == model_id:
            paid_id = line.get("paidId", "")
            paid_model = models.get(paid_id, {})
            paid_variant = {
                "id": paid_id,
                "name": paid_model.get("name", paid_id),
                "credits": paid_model.get("credits", "unknown"),
                "allowPaidSwitch": line.get("allowPaidSwitch", False),
            }
            break

    # Check for trial banner
    trial_banner = None
    banner_config = features.get("ModelTrialBanner", {})
    for banner in banner_config.get("banners", []):
        if banner.get("modelId") == model_id:
            target_id = banner.get("targetModelId", "")
            target_model = models.get(target_id, {})
            trial_banner = {
                "targetModelId": target_id,
                "targetModelName": target_model.get("name", target_id),
                "targetModelCredits": target_model.get("credits", "unknown"),
                "trialDays": banner.get("trialDays", 0),
            }
            break

    return {
        "id": promo.get("id", ""),
        "modelId": model_id,
        "modelName": model_name,
        "modelDescription": description,
        "badge": badge_label,
        "discountFactor": factor,
        "displayedCredits": discounted_credits,
        "baseCredits": base_credits,
        "hoverText": hover_text,
        "validFrom": valid_from,
        "validUntil": valid_until,
        "timezone": tz,
        "enabled": promo.get("enabled", True),
        "priority": promo.get("priority", 0),
        "kind": promo.get("kind", ""),
        "daysRemaining": days_remaining,
        "paidVariant": paid_variant,
        "trialBanner": trial_banner,
    }


def load_previous_snapshot(path):
    """Load the previous snapshot file. Returns None if not found."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def compare_promos(current, previous):
    """Compare current and previous promotion lists. Returns diff dict."""
    if not previous:
        return {"status": "baseline", "added": current, "removed": [], "changed": [], "unchanged": []}

    prev_by_id = {p["id"]: p for p in previous}
    curr_by_id = {p["id"]: p for p in current}

    added = []
    removed = []
    changed = []
    unchanged = []

    # Fields to compare (exclude daysRemaining — it changes daily and isn't a real "change")
    compare_keys = [
        "modelId", "modelName", "badge", "discountFactor",
        "displayedCredits", "baseCredits", "hoverText",
        "validFrom", "validUntil", "enabled", "priority", "kind",
        "paidVariant", "trialBanner",
    ]

    for promo in current:
        pid = promo["id"]
        if pid not in prev_by_id:
            added.append(promo)
        else:
            prev = prev_by_id[pid]
            diff_fields = {}
            for key in compare_keys:
                curr_val = promo.get(key)
                prev_val = prev.get(key)
                if curr_val != prev_val:
                    diff_fields[key] = {"previous": prev_val, "current": curr_val}

            if diff_fields:
                changed.append({"promo": promo, "changes": diff_fields})
            else:
                unchanged.append(promo)

    for promo in previous:
        pid = promo["id"]
        if pid not in curr_by_id:
            removed.append(promo)

    return {
        "status": "compared",
        "added": added,
        "removed": removed,
        "changed": changed,
        "unchanged": unchanged,
    }


def format_report(diff, current, snapshot_date):
    """Generate a human-readable markdown report."""
    lines = []
    lines.append("# Promo Model Check Report")
    lines.append("")
    lines.append(f"**Run time:** {snapshot_date}")
    lines.append(f"**Models found:** {len(current)}")
    lines.append("")

    if diff["status"] == "baseline":
        lines.append("## Baseline Established")
        lines.append("")
        lines.append("No previous snapshot found. This run establishes the baseline.")
        lines.append("")
    else:
        has_changes = bool(diff["added"] or diff["removed"] or diff["changed"])
        if not has_changes:
            lines.append("## No Changes Detected")
            lines.append("")
            lines.append("The promotional model lineup is unchanged since the last run.")
            lines.append("")
        else:
            if diff["added"]:
                lines.append("## Added Models")
                lines.append("")
                for p in diff["added"]:
                    days = p.get("daysRemaining")
                    days_str = f" ({days} days remaining)" if days is not None else ""
                    lines.append(f"- **{p['modelName']}** (`{p['modelId']}`) — {p['badge']}, valid until {p.get('validUntil', 'N/A')}{days_str}")
                    if p.get("paidVariant"):
                        pv = p["paidVariant"]
                        lines.append(f"  - Paid fallback: {pv.get('name', pv.get('id', ''))} at {pv.get('credits', 'N/A')}")
                lines.append("")

            if diff["removed"]:
                lines.append("## Removed Models")
                lines.append("")
                for p in diff["removed"]:
                    lines.append(f"- **{p.get('modelName', 'Unknown')}** (`{p.get('modelId', '')}`) — was {p.get('badge', 'N/A')}, was valid until {p.get('validUntil', 'N/A')}")
                lines.append("")

            if diff["changed"]:
                lines.append("## Changed Models")
                lines.append("")
                for item in diff["changed"]:
                    p = item["promo"]
                    lines.append(f"- **{p['modelName']}** (`{p['modelId']}`)")
                    for field, vals in item["changes"].items():
                        lines.append(f"  - {field}: `{vals['previous']}` -> `{vals['current']}`")
                lines.append("")

    # Always list current models with details
    lines.append("## Current Promotional Models")
    lines.append("")
    for p in current:
        days = p.get("daysRemaining")
        days_str = f" ({days} days remaining)" if days is not None else ""
        imminent = " [IMMINENT EXPIRY]" if days is not None and days <= IMMINENT_DAYS else ""
        lines.append(f"- **{p['modelName']}** (`{p['modelId']}`) — {p['badge']}, valid until {p.get('validUntil', 'N/A')}{days_str}{imminent}")
        if p.get("modelDescription"):
            lines.append(f"  - Description: {p['modelDescription']}")
        if p.get("paidVariant"):
            pv = p["paidVariant"]
            lines.append(f"  - Paid fallback: {pv.get('name', pv.get('id', ''))} at {pv.get('credits', 'N/A')} (auto-switch: {pv.get('allowPaidSwitch', False)})")
        if p.get("trialBanner"):
            tb = p["trialBanner"]
            lines.append(f"  - Trial banner: {tb.get('trialDays', 0)}-day trial, then directs to {tb.get('targetModelName', tb.get('targetModelId', ''))} at {tb.get('targetModelCredits', 'N/A')}")

    return "\n".join(lines)


def write_summary(diff, current, snapshot_date, report_dir):
    """Write a structured JSON summary for downstream consumers (e.g. WorkBuddy automation)."""
    summary = {
        "runTime": snapshot_date,
        "status": diff["status"],
        "modelCount": len(current),
        "changes": {
            "added": len(diff["added"]),
            "removed": len(diff["removed"]),
            "changed": len(diff["changed"]),
        },
        "models": current,
    }
    summary_path = Path(report_dir) / "latest-summary.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    return summary_path


def main():
    args = parse_args()
    snapshot_date = datetime.now(timezone.utc).isoformat()

    # Load source data
    try:
        raw_promos, models, features = load_source(args.source)
    except FileNotFoundError:
        print(f"ERROR: Source file not found: {args.source}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to parse source file: {e}", file=sys.stderr)
        sys.exit(1)

    # Enrich promotions
    current = [enrich_promo(p, models, features) for p in raw_promos]

    # Load previous snapshot
    previous_data = load_previous_snapshot(args.snapshot)
    previous_promos = previous_data.get("modelPromotions", []) if previous_data else None

    # Compare
    diff = compare_promos(current, previous_promos or [])

    # Generate report
    report = format_report(diff, current, snapshot_date)

    # Print report to stdout
    print(report)

    # Update snapshot
    snapshot = {
        "snapshotDate": snapshot_date,
        "source": "local_storage/entry_d43e96994f944cfb77961c2ea7d04605.info (product config)",
        "modelPromotions": current,
        "productFeaturesConfig": features,
    }

    snapshot_path = Path(args.snapshot)
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    with open(snapshot_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=2, ensure_ascii=False)

    # Write report to file
    report_path = Path(args.report_dir) / "latest-report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report)

    # Write structured JSON summary for downstream AI interpretation
    summary_path = write_summary(diff, current, snapshot_date, args.report_dir)

    # Summary line for log parsing
    n_changes = len(diff["added"]) + len(diff["removed"]) + len(diff["changed"])
    print(f"\n---\nSnapshot updated: {snapshot_path}")
    print(f"Report saved: {report_path}")
    print(f"Summary saved: {summary_path}")
    print(f"Status: {diff['status']}, Changes: {n_changes}")


if __name__ == "__main__":
    main()
