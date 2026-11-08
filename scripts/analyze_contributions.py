#!/usr/bin/env python3
"""Read and flag contribution patterns from a Crowdfunding contract."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from collections import defaultdict
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_CONTRACT = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
CONTRIBUTION_TOPIC = (
    "0xd2d33c5340520954ae03d46ba5f056dd7adb35260f86df538a709bed96d89afb"
)
WEI_PER_ETH = 10**18


@dataclass(frozen=True)
class Contribution:
    campaign_id: int
    contributor: str
    amount_wei: int
    block_number: int
    transaction_hash: str


def rpc_call(rpc_url: str, method: str, params: list[object]) -> object:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    request = Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            result = json.load(response)
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f"RPC request failed: {error}") from error

    if "error" in result:
        raise RuntimeError(f"RPC {method} failed: {result['error']}")
    if "result" not in result:
        raise RuntimeError(f"RPC {method} returned no result")
    return result["result"]


def decode_log(raw_log: dict[str, object]) -> Contribution:
    topics = raw_log.get("topics")
    data = raw_log.get("data")
    if not isinstance(topics, list) or len(topics) != 3:
        raise ValueError("ContributionReceived log has an invalid topics list")
    if not isinstance(data, str) or len(data.removeprefix("0x")) < 128:
        raise ValueError("ContributionReceived log has invalid event data")

    campaign_id = int(str(topics[1]), 16)
    contributor = "0x" + str(topics[2])[-40:]
    event_data = data.removeprefix("0x")
    amount_wei = int(event_data[0:64], 16)
    block_number = int(str(raw_log["blockNumber"]), 16)
    transaction_hash = str(raw_log["transactionHash"])

    return Contribution(
        campaign_id=campaign_id,
        contributor=contributor.lower(),
        amount_wei=amount_wei,
        block_number=block_number,
        transaction_hash=transaction_hash,
    )


def analyze(
    contributions: list[Contribution],
    repeat_count: int,
    peak_multiple: float,
    linked_window: int,
    linked_min_matches: int,
) -> dict[str, object]:
    by_campaign_amount: dict[tuple[int, int], list[Contribution]] = defaultdict(list)
    by_campaign: dict[int, list[Contribution]] = defaultdict(list)
    for contribution in contributions:
        by_campaign_amount[
            (contribution.campaign_id, contribution.amount_wei)
        ].append(contribution)
        by_campaign[contribution.campaign_id].append(contribution)

    repeated_amounts = []
    for (campaign_id, amount_wei), matches in sorted(by_campaign_amount.items()):
        if len(matches) >= repeat_count:
            repeated_amounts.append(
                {
                    "campaign_id": campaign_id,
                    "amount_eth": amount_wei / WEI_PER_ETH,
                    "count": len(matches),
                    "distinct_contributors": len(
                        {match.contributor for match in matches}
                    ),
                    "contributors": sorted(
                        {match.contributor for match in matches}
                    ),
                }
            )

    peaks = []
    for campaign_id, campaign_contributions in sorted(by_campaign.items()):
        median_amount = statistics.median(
            item.amount_wei for item in campaign_contributions
        )
        for contribution in campaign_contributions:
            if contribution.amount_wei > median_amount * peak_multiple:
                peaks.append(
                    {
                        "campaign_id": campaign_id,
                        "contributor": contribution.contributor,
                        "amount_eth": contribution.amount_wei / WEI_PER_ETH,
                        "campaign_median_eth": median_amount / WEI_PER_ETH,
                        "block_number": contribution.block_number,
                        "transaction_hash": contribution.transaction_hash,
                    }
                )

    # A link is only a timing/amount correlation: same campaign, same amount,
    # and nearby blocks. It does not establish common ownership.
    by_pattern: dict[tuple[int, int], list[Contribution]] = defaultdict(list)
    for contribution in contributions:
        by_pattern[
            (contribution.campaign_id, contribution.amount_wei)
        ].append(contribution)

    linked: dict[tuple[int, str, str], set[tuple[int, int]]] = defaultdict(set)
    for (campaign_id, amount_wei), matches in by_pattern.items():
        ordered = sorted(matches, key=lambda item: item.block_number)
        for index, left in enumerate(ordered):
            for right in ordered[index + 1 :]:
                if right.block_number - left.block_number > linked_window:
                    break
                if left.contributor == right.contributor:
                    continue
                pair = tuple(sorted((left.contributor, right.contributor)))
                linked[(campaign_id, pair[0], pair[1])].add(
                    (left.block_number, right.block_number)
                )

    linked_addresses = [
        {
            "campaign_id": campaign_id,
            "address_a": address_a,
            "address_b": address_b,
            "matching_patterns": len(patterns),
        }
        for (campaign_id, address_a, address_b), patterns in sorted(
            linked.items()
        )
        if len(patterns) >= linked_min_matches
    ]

    return {
        "contribution_count": len(contributions),
        "repeated_amounts": repeated_amounts,
        "peaks": peaks,
        "possibly_linked_addresses": linked_addresses,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Analyze ContributionReceived logs (read-only)."
    )
    parser.add_argument(
        "--rpc-url",
        default=os.getenv("RPC_URL", "http://127.0.0.1:8545"),
        help="JSON-RPC endpoint (default: local Hardhat node or RPC_URL)",
    )
    parser.add_argument(
        "--contract",
        default=os.getenv("CROWDFUNDING_ADDRESS", DEFAULT_CONTRACT),
        help="Crowdfunding contract address",
    )
    parser.add_argument("--from-block", type=lambda value: int(value, 0), default=0)
    parser.add_argument("--repeat-count", type=int, default=3)
    parser.add_argument("--peak-multiple", type=float, default=3.0)
    parser.add_argument("--linked-window", type=int, default=2)
    parser.add_argument("--linked-min-matches", type=int, default=2)
    args = parser.parse_args()

    if args.repeat_count < 2:
        parser.error("--repeat-count must be at least 2")
    if args.peak_multiple <= 1:
        parser.error("--peak-multiple must be greater than 1")
    if args.linked_window < 0:
        parser.error("--linked-window must not be negative")
    if args.linked_min_matches < 1:
        parser.error("--linked-min-matches must be at least 1")
    if not args.contract.startswith("0x") or len(args.contract) != 42:
        parser.error("--contract must be a 20-byte 0x-prefixed address")

    latest_block = int(str(rpc_call(args.rpc_url, "eth_blockNumber", [])), 16)
    raw_logs = rpc_call(
        args.rpc_url,
        "eth_getLogs",
        [
            {
                "address": args.contract,
                "fromBlock": hex(args.from_block),
                "toBlock": "latest",
                "topics": [CONTRIBUTION_TOPIC],
            }
        ],
    )
    if not isinstance(raw_logs, list):
        raise RuntimeError("RPC eth_getLogs returned an invalid result")

    contributions = [decode_log(log) for log in raw_logs]
    report = analyze(
        contributions,
        args.repeat_count,
        args.peak_multiple,
        args.linked_window,
        args.linked_min_matches,
    )
    report["contract"] = args.contract
    report["block_range"] = {
        "from": args.from_block,
        "to": latest_block,
    }
    report["heuristics"] = {
        "repeated_amounts": f"same amount in one campaign at least {args.repeat_count} times",
        "peaks": (
            f"amount greater than {args.peak_multiple:g}x the campaign median"
        ),
        "possibly_linked_addresses": (
            "same campaign and amount within "
            f"{args.linked_window} blocks, at least "
            f"{args.linked_min_matches} matching event pairs; correlation only"
        ),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
