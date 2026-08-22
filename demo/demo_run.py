#!/usr/bin/env python3
"""CHP Locknet — Live Demo

Demonstrates the full pipeline:
  Challenge submitted → CHP gates evaluate → Evidence sealed → Arweave TX → Independent verify

Run: python -m demo.demo_run
"""

import json
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from chp_locknet.spine import AgentVote, seal_evidence, verify_envelope, canonical_hash
from chp_locknet.nosana import NosanaClient
from chp_locknet.arweave import ArweaveClient
from chp_locknet.locknet import Locknet


def print_header(title: str):
    width = 60
    print(f"\n{'='*width}")
    print(f"  {title}")
    print(f"{'='*width}\n")


def print_json(data: dict, label: str = ""):
    if label:
        print(f"\n  [{label}]")
    for k, v in data.items():
        val = json.dumps(v) if isinstance(v, (dict, list)) else str(v)
        if len(val) > 60:
            val = val[:57] + "..."
        print(f"    {k}: {val}")


def demo():
    print_header("CHP LOCKNET — Verifiable AI on Decentralized Compute")

    # ── 1. Define the challenge ──
    print_header("1. CHALLENGE")
    inputs = {
        "protocol": "OmniLend",
        "tx_hash": "0x7f3a...b42c",
        "amount_usd": 8_200_000,
        "anomaly_type": "reentrancy_drain",
        "internal_tx_count": 47,
        "block_number": 19_847_291,
    }
    print(f"  Protocol: {inputs['protocol']}")
    print(f"  TX: {inputs['tx_hash']}")
    print(f"  Amount: ${inputs['amount_usd']:,}")
    print(f"  Anomaly: {inputs['anomaly_type']}")
    print(f"  Inputs hash: {canonical_hash(inputs)}")

    # ── 2. Agent votes from Nosana GPU inference ──
    print_header("2. NOSANA GPU INFERENCE (Demo Mode)")
    nosana = NosanaClient(demo=True)
    job = nosana.submit_job(
        container_image="ghcr.io/icohangar-ops/locknet-agent:latest",
        command="python agent.py",
        gpu_type="RTX_4090",
    )
    import time
    time.sleep(2)  # Wait for demo completion
    job = nosana.get_job(job.job_id)
    print(f"  Job ID: {job.job_id}")
    print(f"  Status: {job.status}")
    print(f"  GPU: {job.gpu_market}")
    print(f"  Cost: ${job.cost_credits:.2f}")

    votes = [
        AgentVote(
            agent_id="watcher-01", agent_role="watcher",
            output="Reentrancy pattern: external call before state update, 47 internal TXs",
            confidence=0.96, model_id="llama3.1:8b", inference_id=job.job_id,
        ),
        AgentVote(
            agent_id="osint-01", agent_role="osint",
            output="4 sources confirm active exploit. @zachxbt tweet: 'OmniLend is being drained'",
            confidence=0.94, model_id="llama3.1:8b",
        ),
        AgentVote(
            agent_id="consensus-01", agent_role="consensus",
            output="Threat score: 87/100. Anomaly base:20, OSINT verdict:+25, Confidence:+14, Amount:+20, Internal TX:+8",
            confidence=0.91, model_id="llama3.1:8b",
        ),
        AgentVote(
            agent_id="executor-01", agent_role="executor",
            output="triggerEmergencyPause() ready to broadcast on Sepolia",
            confidence=0.89, model_id="llama3.1:8b",
        ),
    ]
    print(f"\n  Agent Votes ({len(votes)} agents):")
    for v in votes:
        print(f"    [{v.agent_role:10}] {v.agent_id}: conf={v.confidence:.0%}")

    # ── 3. CHP Gate Pipeline ──
    print_header("3. CHP GATE PIPELINE (R0 → Adversary → Lock → Seal)")
    envelope = seal_evidence(
        engine_id="chp-locknet",
        engine_version="0.1.0",
        inputs=inputs,
        foundation=[
            "Reentrancy requires external call before state update",
            "Internal TX count > 10 strongly correlates with reentrancy",
            "OSINT confirmation weighted at 0.25 in consensus score",
            "Threshold: >=75 PAUSE, >=40 ALERT, <40 MONITOR",
        ],
        agent_votes=votes,
        owner_signoff="alice",  # Human reviewer
        prepared_by="chp-locknet",  # Engine (different from owner)
        control_id="LN-VERIFY-001",
        threshold="consensus",
        nosana_job_ids=[job.job_id],
    )

    print(f"  R0 Gate:")
    for k, v in envelope["r0"].items():
        icon = "PASS" if v == "PASS" else "FAIL"
        print(f"    [{icon:4}] {k}")

    print(f"\n  Adversary Challenges:")
    for c in envelope["adversary"]:
        icon = "PASS" if c["verdict"] == "PASS" else "FAIL"
        print(f"    [{icon:4}] {c['id']}: {c['attack'][:55]}...")

    print(f"\n  Agreement Score: {envelope['agreement_score']:.1%}")
    print(f"  Lock State: {envelope['lock_state']}")
    print(f"  Is Evidence: {envelope['is_evidence']}")
    print(f"  Envelope Hash: {envelope['envelope_hash']}")

    # ── 4. Arweave Storage ──
    print_header("4. ARWEAVE PERMANENT STORAGE")
    arweave = ArweaveClient(demo=True)
    tx = arweave.store_evidence(
        envelope,
        tags={"Protocol": inputs["protocol"], "Amount-USD": str(inputs["amount_usd"])},
    )
    print(f"  TX ID: {tx.tx_id}")
    print(f"  Data URL: {tx.url}")
    print(f"  Verify: {arweave.build_verify_url(tx.tx_id)}")
    print(f"  Data Size: {tx.data_size} bytes")
    print(f"  Confirmed: {tx.confirmation_status}")

    # ── 5. Independent Verification ──
    print_header("5. INDEPENDENT VERIFICATION")
    print("  (Anyone can run this — no trust in the sealer)")

    # Retrieve from Arweave
    retrieved = arweave.retrieve_evidence(tx.tx_id)
    print(f"  Retrieved from Arweave: {'YES' if retrieved else 'NO'}")

    # Verify on-chain
    on_chain = arweave.verify_on_chain(tx.tx_id)
    print(f"  On-chain: {'YES' if on_chain['found'] else 'NO'}")
    print(f"  Confirmed: {'YES' if on_chain['confirmed'] else 'NO'}")

    # Verify envelope integrity
    verification = verify_envelope(envelope)
    print(f"\n  Envelope Integrity:")
    for k, v in verification.items():
        icon = "OK" if v else "FAIL"
        print(f"    [{icon:4}] {k}")

    # ── 6. Summary ──
    print_header("RESULT")
    if envelope["is_evidence"]:
        print(f"  LOCKED — Evidence sealed to Arweave")
        print(f"  {envelope['envelope_hash']}")
        print(f"  TX: {tx.tx_id}")
    else:
        print(f"  {envelope['lock_state']} — Not evidence")
    print()


if __name__ == "__main__":
    demo()
