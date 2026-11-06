"""Internal pilot-approval CLI for operators with direct access to the workflow database.

    python -m scripts.pilot_physicians list [--status pending|approved|rejected|disabled|all]
    python -m scripts.pilot_physicians approve <owner_scope_id> --operator you@lamina [--note ..]
    python -m scripts.pilot_physicians reject  <owner_scope_id> --operator you@lamina [--note ..]
    python -m scripts.pilot_physicians disable <owner_scope_id> --operator you@lamina [--note ..]

This is not exposed over HTTP. Decisions go through the same service and DB
transitions as the allow-listed /api/internal/pilot-physicians endpoints and are
recorded as `cli:<operator>` in the audit trail.
"""

from __future__ import annotations

import argparse
import json
import sys

from backend.physician_onboarding import OnboardingError, PhysicianOnboardingService


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list")
    listing.add_argument(
        "--status",
        default="pending",
        choices=["pending", "approved", "rejected", "disabled", "all"],
    )
    for decision in ("approve", "reject", "disable"):
        command = commands.add_parser(decision)
        command.add_argument("owner_scope_id")
        command.add_argument("--operator", required=True)
        command.add_argument("--note")
    args = parser.parse_args(argv)
    service = PhysicianOnboardingService()
    if args.command == "list":
        rows = service.review_queue(None if args.status == "all" else args.status)
        print(json.dumps(rows, indent=2))
        return 0
    try:
        row = service.decide(
            args.owner_scope_id, args.command, f"cli:{args.operator.strip()}", args.note
        )
    except OnboardingError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 1
    print(json.dumps(row, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
