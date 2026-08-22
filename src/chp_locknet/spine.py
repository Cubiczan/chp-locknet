"""CHP control-spine gate — vendored and extended for Locknet.

Implements R0 → Adversary → Lock → Human → Seal pipeline.
Only LOCKED packs are evidence. An engine cannot countersign its own output.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from hashlib import sha256
import json
from typing import Any, Mapping, Sequence


SPINE_VERSION = "0.2.0-locknet"
CHP_ALIGNMENT = "consensus-hardening-protocol + Nosana compute + Arweave provenance"


class LockState(str, Enum):
    EXPLORING = "EXPLORING"
    ADVISORY = "ADVISORY"
    PROVISIONAL_LOCK = "PROVISIONAL_LOCK"
    LOCKED = "LOCKED"
    HALT = "HALT"


class Verdict(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    FATAL = "FATAL"


@dataclass(frozen=True)
class Finding:
    code: str
    message: str
    blocking: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "blocking": self.blocking}


@dataclass
class AgentVote:
    """A single agent's contribution to a decision."""
    agent_id: str
    agent_role: str  # watcher, osint, consensus, executor
    output: str
    confidence: float
    model_id: str = "unknown"
    inference_id: str = ""  # Nosana job ID
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id, "agent_role": self.agent_role,
            "output": self.output, "confidence": self.confidence,
            "model_id": self.model_id, "inference_id": self.inference_id,
            "timestamp": self.timestamp,
        }


def canonical_hash(payload: Any) -> str:
    """Deterministic SHA-256 of any JSON-serializable structure."""
    blob = json.dumps(payload, sort_keys=True, default=str, separators=(",", ":"))
    return sha256(blob.encode("utf-8")).hexdigest()


def evaluate_r0(
    *,
    population_count: int,
    control_id: str,
    threshold: str,
    engine_id: str,
    inputs_hash: str,
    owner_signoff: str,
    prepared_by: str,
) -> dict[str, str]:
    """CHP R0 gate: solvable, scoped, valid, worth_it, human."""
    return {
        "Solvable": Verdict.PASS.value if population_count > 0 else Verdict.FATAL.value,
        "Scoped": Verdict.PASS.value if bool(control_id and threshold) else Verdict.FATAL.value,
        "Valid": Verdict.PASS.value if bool(engine_id and inputs_hash) else Verdict.FATAL.value,
        "Worth_it": Verdict.PASS.value if control_id.startswith(("ICFR-", "LN-")) else Verdict.FATAL.value,
        "Human_gate": (
            Verdict.PASS.value
            if owner_signoff and owner_signoff.strip() != prepared_by.strip()
            else Verdict.FATAL.value
        ),
    }


def adversary_check(
    *,
    population_count: int,
    owner_signoff: str,
    prepared_by: str,
    blocking: Sequence[Finding],
    foundation: Sequence[str],
    agent_votes: Sequence[AgentVote],
    agreement_threshold: float = 0.7,
) -> list[dict[str, str]]:
    """Adversary challenges — extended with agent consensus check."""
    # Base challenges from control-spine
    challenges = [
        {
            "id": "COMPLETENESS",
            "attack": "The agent population is empty — a clean pack is indistinguishable from a missed control.",
            "verdict": Verdict.PASS.value if population_count > 0 else Verdict.FAIL.value,
        },
        {
            "id": "HUMAN_OWNER",
            "attack": "The engine countersigned its own output — separation of duties violated.",
            "verdict": (
                Verdict.PASS.value
                if owner_signoff and owner_signoff.strip() != prepared_by.strip()
                else Verdict.FAIL.value
            ),
        },
        {
            "id": "OPEN_EXCEPTIONS",
            "attack": "Blocking findings remain; LOCKED would assert a control that did not operate.",
            "verdict": Verdict.PASS.value if not any(f.blocking for f in blocking) else Verdict.FAIL.value,
        },
        {
            "id": "FOUNDATION",
            "attack": "Assumptions were not committed before the inference ran.",
            "verdict": Verdict.PASS.value if foundation else Verdict.FAIL.value,
        },
    ]
    # Locknet-specific: agent consensus
    if agent_votes:
        confs = [v.confidence for v in agent_votes]
        avg_conf = sum(confs) / len(confs)
        consensus_met = avg_conf >= agreement_threshold
        challenges.append({
            "id": "AGENT_CONSENSUS",
            "attack": f"Agent consensus below {agreement_threshold:.0%} threshold (actual: {avg_conf:.1%}). Decision unreliable.",
            "verdict": Verdict.PASS.value if consensus_met else Verdict.FAIL.value,
        })
    else:
        challenges.append({
            "id": "AGENT_CONSENSUS",
            "attack": "No agent votes recorded. Cannot verify consensus.",
            "verdict": Verdict.FAIL.value,
        })
    return challenges


def compute_lock_state(
    r0: Mapping[str, str],
    challenges: Sequence[Mapping[str, str]],
    owner: str,
) -> LockState:
    """Determine lock state from R0 + adversary results."""
    if any(v == Verdict.FATAL.value for k, v in r0.items() if k != "Human_gate"):
        return LockState.HALT
    blocking_fail = any(c["verdict"] != Verdict.PASS.value for c in challenges if c["id"] != "HUMAN_OWNER")
    human_ok = r0.get("Human_gate") == Verdict.PASS.value
    exceptions_clear = all(c["verdict"] == Verdict.PASS.value for c in challenges if c["id"] == "OPEN_EXCEPTIONS")
    if blocking_fail and not human_ok:
        return LockState.EXPLORING
    if blocking_fail and human_ok:
        return LockState.PROVISIONAL_LOCK
    if not human_ok:
        return LockState.EXPLORING
    if exceptions_clear and human_ok and all(v == Verdict.PASS.value for v in r0.values()):
        return LockState.LOCKED
    return LockState.ADVISORY


def seal_evidence(
    *,
    engine_id: str,
    engine_version: str,
    inputs: Any,
    foundation: Sequence[str],
    agent_votes: Sequence[AgentVote],
    owner_signoff: str,
    prepared_by: str,
    control_id: str = "",
    threshold: str = "",
    blocking_findings: Sequence[Finding] = (),
    agreement_threshold: float = 0.7,
    nosana_job_ids: Sequence[str] = (),
) -> dict[str, Any]:
    """Full spine pipeline: R0 → Adversary → Lock → Seal.

    Returns a sealed evidence pack. Only LOCKED packs are evidence.
    """
    population = len(agent_votes)
    inputs_hash = canonical_hash(inputs)
    findings = tuple(blocking_findings)

    r0 = evaluate_r0(
        population_count=population,
        control_id=control_id,
        threshold=threshold,
        engine_id=engine_id,
        inputs_hash=inputs_hash,
        owner_signoff=owner_signoff,
        prepared_by=prepared_by,
    )
    challenges = adversary_check(
        population_count=population,
        owner_signoff=owner_signoff,
        prepared_by=prepared_by,
        blocking=findings,
        foundation=foundation,
        agent_votes=agent_votes,
        agreement_threshold=agreement_threshold,
    )
    state = compute_lock_state(r0, challenges, owner_signoff)

    # Compute agreement score
    confs = [v.confidence for v in agent_votes] if agent_votes else [0.0]
    agreement_score = round(sum(confs) / len(confs), 4)

    # Document hashes for each agent's output
    vote_hashes = {v.agent_id: canonical_hash(v.to_dict()) for v in agent_votes}
    # Document hash of the aggregate decision
    decision_hash = canonical_hash({
        "inputs_hash": inputs_hash,
        "vote_hashes": vote_hashes,
        "agreement_score": agreement_score,
        "lock_state": state.value,
    })

    body = {
        "spine_version": SPINE_VERSION,
        "chp_alignment": CHP_ALIGNMENT,
        "engine_id": engine_id,
        "engine_version": engine_version,
        "inputs_hash": inputs_hash,
        "foundation": list(foundation),
        "agent_votes": [v.to_dict() for v in agent_votes],
        "vote_hashes": vote_hashes,
        "agreement_score": agreement_score,
        "decision_hash": decision_hash,
        "nosana_job_ids": list(nosana_job_ids),
        "r0": r0,
        "adversary": challenges,
        "blocking_findings": [f.to_dict() for f in findings],
        "lock_state": state.value,
        "owner_signoff": owner_signoff,
        "prepared_by": prepared_by,
        "is_evidence": state is LockState.LOCKED,
        "sealed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    body["envelope_hash"] = canonical_hash({k: v for k, v in body.items() if k != "envelope_hash"})
    return body


def verify_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    """Independently verify a sealed evidence envelope.

    Recomputes hashes and checks lock state consistency.
    Anyone can run this — no trust in the original sealer required.
    """
    # Recompute envelope hash
    body_for_hash = {k: v for k, v in envelope.items() if k != "envelope_hash"}
    recomputed_hash = canonical_hash(body_for_hash)
    hash_valid = recomputed_hash == envelope.get("envelope_hash")

    # Recompute inputs hash
    vote_hashes = envelope.get("vote_hashes", {})
    decision_recomputed = canonical_hash({
        "inputs_hash": envelope.get("inputs_hash", ""),
        "vote_hashes": vote_hashes,
        "agreement_score": envelope.get("agreement_score", 0),
        "lock_state": envelope.get("lock_state", ""),
    })
    decision_valid = decision_recomputed == envelope.get("decision_hash")

    # Verify each vote hash
    vote_hashes_valid = True
    for vote in envelope.get("agent_votes", []):
        expected = canonical_hash(vote)
        actual = vote_hashes.get(vote.get("agent_id", ""))
        if expected != actual:
            vote_hashes_valid = False
            break

    # Check R0 consistency
    r0 = envelope.get("r0", {})
    r0_consistent = all(v == Verdict.PASS.value for v in r0.values())

    # Check adversary consistency
    adversary = envelope.get("adversary", [])
    adversary_pass = all(c.get("verdict") == Verdict.PASS.value for c in adversary)

    # Final: lock state should be LOCKED for evidence
    ls = envelope.get("lock_state") == LockState.LOCKED.value
    ie = envelope.get("is_evidence", False) is True
    lock_consistent = ls and ie

    all_valid = hash_valid and decision_valid and vote_hashes_valid and lock_consistent

    return {
        "valid": all_valid,
        "envelope_hash_ok": hash_valid,
        "decision_hash_ok": decision_valid,
        "vote_hashes_ok": vote_hashes_valid,
        "r0_pass": r0_consistent,
        "adversary_pass": adversary_pass,
        "lock_consistent": lock_consistent,
        "is_evidence": envelope.get("is_evidence", False),
        "lock_state": envelope.get("lock_state", "UNKNOWN"),
    }
