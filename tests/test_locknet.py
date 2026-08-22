"""Tests for CHP Locknet.

Covers: spine gates, envelope sealing, independent verification,
Nosana demo jobs, Arweave demo storage, full Locknet pipeline.
"""

from chp_locknet.spine import (
    AgentVote, Finding, LockState, Verdict,
    canonical_hash, seal_evidence, verify_envelope, evaluate_r0,
    adversary_check, compute_lock_state,
)
from chp_locknet.nosana import NosanaClient
from chp_locknet.arweave import ArweaveClient
from chp_locknet.locknet import Locknet
import time


# ── Fixtures ──────────────────────────────────────────

SAMPLE_VOTES = [
    AgentVote(agent_id="watcher-01", agent_role="watcher", output="Anomaly detected", confidence=0.95, model_id="llama3.1:8b"),
    AgentVote(agent_id="osint-01", agent_role="osint", output="Confirmed exploit", confidence=0.92, model_id="llama3.1:8b"),
    AgentVote(agent_id="consensus-01", agent_role="consensus", output="Score 87, recommend pause", confidence=0.88, model_id="llama3.1:8b"),
    AgentVote(agent_id="executor-01", agent_role="executor", output="Pause tx broadcast", confidence=0.90, model_id="llama3.1:8b"),
]

SAMPLE_INPUTS = {
    "protocol": "OmniLend",
    "tx_hash": "0xabc123...",
    "amount_usd": 8_200_000,
    "anomaly_type": "reentrancy",
}

FOUNDATION = [
    "Reentrancy requires external call before state update",
    "Internal TX count > 10 strongly correlates with reentrancy",
    "OSINT confirmation weighted at 0.25 in consensus score",
]


def test_canonical_hash_deterministic():
    h1 = canonical_hash({"a": 1, "b": 2})
    h2 = canonical_hash({"b": 2, "a": 1})
    assert h1 == h2, "Hash must be order-independent"
    assert len(h1) == 64, "SHA-256 produces 64 hex chars"


def test_r0_gate_passes():
    r0 = evaluate_r0(
        population_count=4,
        control_id="LN-VERIFY-001",
        threshold="consensus",
        engine_id="chp-locknet",
        inputs_hash="abc",
        owner_signoff="alice",
        prepared_by="chp-locknet",
    )
    assert all(v == Verdict.PASS.value for v in r0.values())


def test_r0_gate_blocks_self_sign():
    r0 = evaluate_r0(
        population_count=4,
        control_id="LN-VERIFY-001",
        threshold="consensus",
        engine_id="chp-locknet",
        inputs_hash="abc",
        owner_signoff="chp-locknet",  # Same as prepared_by!
        prepared_by="chp-locknet",
    )
    assert r0["Human_gate"] == Verdict.FATAL.value


def test_adversary_consensus_check():
    challenges = adversary_check(
        population_count=4,
        owner_signoff="alice",
        prepared_by="bob",
        blocking=[],
        foundation=FOUNDATION,
        agent_votes=SAMPLE_VOTES,
        agreement_threshold=0.7,
    )
    consensus = next(c for c in challenges if c["id"] == "AGENT_CONSENSUS")
    assert consensus["verdict"] == Verdict.PASS.value


def test_adversary_low_consensus_fails():
    low_votes = [
        AgentVote(agent_id="a1", agent_role="watcher", output="meh", confidence=0.3),
        AgentVote(agent_id="a2", agent_role="osint", output="meh", confidence=0.2),
    ]
    challenges = adversary_check(
        population_count=2,
        owner_signoff="alice",
        prepared_by="bob",
        blocking=[],
        foundation=["test"],
        agent_votes=low_votes,
        agreement_threshold=0.7,
    )
    consensus = next(c for c in challenges if c["id"] == "AGENT_CONSENSUS")
    assert consensus["verdict"] == Verdict.FAIL.value


def test_seal_evidence_locked():
    envelope = seal_evidence(
        engine_id="chp-locknet",
        engine_version="0.1.0",
        inputs=SAMPLE_INPUTS,
        foundation=FOUNDATION,
        agent_votes=SAMPLE_VOTES,
        owner_signoff="alice",
        prepared_by="chp-locknet",
        control_id="LN-VERIFY-001",
        threshold="consensus",
        nosana_job_ids=["job-001", "job-002"],
    )
    assert envelope["lock_state"] == LockState.LOCKED.value
    assert envelope["is_evidence"] is True
    assert "envelope_hash" in envelope
    assert len(envelope["envelope_hash"]) == 64
    assert envelope["agreement_score"] > 0.8
    assert len(envelope["vote_hashes"]) == 4
    assert envelope["nosana_job_ids"] == ["job-001", "job-002"]


def test_seal_evidence_halt_on_empty():
    envelope = seal_evidence(
        engine_id="chp-locknet",
        engine_version="0.1.0",
        inputs={},
        foundation=[],
        agent_votes=[],
        owner_signoff="alice",
        prepared_by="chp-locknet",
    )
    assert envelope["lock_state"] == LockState.HALT.value
    assert envelope["is_evidence"] is False


def test_verify_envelope_valid():
    # Create a valid locked envelope
    envelope = seal_evidence(
        engine_id="chp-locknet", engine_version="0.1.0",
        inputs=SAMPLE_INPUTS, foundation=FOUNDATION,
        agent_votes=SAMPLE_VOTES,
        owner_signoff="alice", prepared_by="chp-locknet",
        control_id="LN-VERIFY-001", threshold="consensus",
    )
    result = verify_envelope(envelope)
    assert result["valid"] is True
    assert result["envelope_hash_ok"] is True
    assert result["decision_hash_ok"] is True
    assert result["vote_hashes_ok"] is True
    assert result["is_evidence"] is True


def test_verify_tampered_envelope():
    envelope = seal_evidence(
        engine_id="chp-locknet", engine_version="0.1.0",
        inputs=SAMPLE_INPUTS, foundation=FOUNDATION,
        agent_votes=SAMPLE_VOTES,
        owner_signoff="alice", prepared_by="chp-locknet",
        control_id="LN-VERIFY-001", threshold="consensus",
    )
    # Tamper with the agreement score
    envelope["agreement_score"] = 0.99
    result = verify_envelope(envelope)
    assert result["valid"] is False
    assert result["envelope_hash_ok"] is False


def test_nosana_demo_submit():
    client = NosanaClient(demo=True)
    job = client.submit_job(
        container_image="ghcr.io/icohangar-ops/locknet-agent:latest",
        command="python agent.py",
    )
    assert job.job_id.startswith("nosana-demo-")
    assert job.status == "running"


def test_arweave_demo_store():
    client = ArweaveClient(demo=True)
    envelope = seal_evidence(
        engine_id="chp-locknet", engine_version="0.1.0",
        inputs=SAMPLE_INPUTS, foundation=FOUNDATION,
        agent_votes=SAMPLE_VOTES,
        owner_signoff="alice", prepared_by="chp-locknet",
    )
    tx = client.store_evidence(envelope)
    assert tx.tx_id.startswith("arweave-demo-")
    assert tx.data_size > 0
    # Retrieve it back
    retrieved = client.retrieve_evidence(tx.tx_id)
    assert retrieved is not None
    assert retrieved["envelope_hash"] == envelope["envelope_hash"]
    # Verify on-chain
    status = client.verify_on_chain(tx.tx_id)
    assert status["found"] is True
    assert status["confirmed"] is True


def test_full_locknet_pipeline():
    net = Locknet(demo=True)
    result = net.run(
        votes=SAMPLE_VOTES,
        inputs=SAMPLE_INPUTS,
        foundation=FOUNDATION,
        owner_signoff="alice",
        prepared_by="chp-locknet",
        control_id="LN-VERIFY-001",
        store_on_arweave=True,
    )
    assert result.is_evidence is True
    assert result.lock_state == "LOCKED"
    assert result.arweave_tx_id != ""
    assert result.envelope_hash != ""
    print(result.summary())


def test_locknet_halt_pipeline():
    net = Locknet(demo=True)
    result = net.run(
        votes=[],
        inputs={},
        foundation=[],
        owner_signoff="alice",
        prepared_by="chp-locknet",
    )
    assert result.is_evidence is False
    assert result.lock_state == "HALT"
    assert result.arweave_tx_id == ""  # Not stored


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
