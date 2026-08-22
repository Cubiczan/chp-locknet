"""CHP Locknet — the main orchestrator.

Full pipeline:
  1. Submit agent inference jobs to Nosana GPUs
  2. Collect agent votes
  3. Run CHP control-spine gates (R0 → Adversary → Lock → Seal)
  4. If LOCKED: store evidence envelope on Arweave
  5. Anyone can independently verify via envelope hash

Usage:
    net = Locknet(nosana_api_key="...", arweave_wallet="...")
    result = net.run(votes, inputs, owner="alice", prepared_by="bob")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .spine import (
    AgentVote, Finding, LockState, seal_evidence, verify_envelope, canonical_hash,
)
from .nosana import NosanaClient, NosanaJob
from .arweave import ArweaveClient, ArweaveTransaction


@dataclass
class LocknetResult:
    """Result of a Locknet verification run."""
    # Spine output
    envelope: dict[str, Any]
    lock_state: str
    is_evidence: bool
    envelope_hash: str

    # Nosana
    nosana_job_ids: list[str] = field(default_factory=list)
    nosana_total_cost: float = 0.0

    # Arweave
    arweave_tx_id: str = ""
    arweave_tx_url: str = ""
    arweave_verify_url: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "lock_state": self.lock_state,
            "is_evidence": self.is_evidence,
            "envelope_hash": self.envelope_hash,
            "nosana_job_ids": self.nosana_job_ids,
            "nosana_total_cost": self.nosana_total_cost,
            "arweave_tx_id": self.arweave_tx_id,
            "arweave_tx_url": self.arweave_tx_url,
            "arweave_verify_url": self.arweave_verify_url,
        }

    def summary(self) -> str:
        lines = [
            f"Lock State:  {self.lock_state}",
            f"Is Evidence: {self.is_evidence}",
            f"Envelope:    {self.envelope_hash[:16]}...",
        ]
        if self.nosana_job_ids:
            lines.append(f"Nosana Jobs: {', '.join(self.nosana_job_ids)}")
            lines.append(f"Nosana Cost: ${self.nosana_total_cost:.2f}")
        if self.arweave_tx_id:
            lines.append(f"Arweave TX:  {self.arweave_tx_id}")
            lines.append(f"Verify URL:  {self.arweave_verify_url}")
        return "\n".join(lines)


class Locknet:
    """CHP Locknet orchestrator.

    Routes inference to Nosana, gates through CHP control-spine,
    seals evidence to Arweave.
    """

    def __init__(
        self,
        *,
        nosana_api_key: str = "",
        arweave_wallet: str = "",
        engine_id: str = "chp-locknet",
        engine_version: str = "0.1.0",
        agreement_threshold: float = 0.7,
        demo: bool = False,
    ):
        self.engine_id = engine_id
        self.engine_version = engine_version
        self.agreement_threshold = agreement_threshold
        self.nosana = NosanaClient(api_key=nosana_api_key, demo=demo)
        self.arweave = ArweaveClient(wallet_key=arweave_wallet, demo=demo)

    def submit_inference(
        self,
        *,
        container_image: str,
        agent_id: str,
        agent_role: str,
        prompt: str = "",
        model: str = "llama3.1:8b",
        gpu_type: str = "RTX_4090",
        timeout_minutes: int = 5,
    ) -> NosanaJob:
        """Submit a single agent inference job to Nosana."""
        env = {
            "AGENT_ID": agent_id,
            "AGENT_ROLE": agent_role,
            "MODEL": model,
            "PROMPT": prompt,
        }
        return self.nosana.submit_job(
            container_image=container_image,
            command=f"python -c 'import os; print(os.environ.get(\"PROMPT\", \"\"))'",
            env_vars=env,
            gpu_type=gpu_type,
            timeout_minutes=timeout_minutes,
            label=f"locknet-{agent_id}",
        )

    def run(
        self,
        *,
        votes: list[AgentVote],
        inputs: Any,
        foundation: list[str] | None = None,
        owner_signoff: str,
        prepared_by: str,
        control_id: str = "LN-VERIFY-001",
        threshold: str = "consensus",
        blocking_findings: list[Finding] | None = None,
        store_on_arweave: bool = True,
        nosana_job_ids: list[str] | None = None,
    ) -> LocknetResult:
        """Run the full Locknet pipeline.

        1. Seal evidence through CHP spine gates
        2. If LOCKED, store on Arweave for permanent provenance
        3. Return result with all IDs for verification
        """
        foundation = foundation or []
        blocking_findings = blocking_findings or []
        nosana_job_ids = nosana_job_ids or []

        # Step 1: CHP Gate Pipeline
        envelope = seal_evidence(
            engine_id=self.engine_id,
            engine_version=self.engine_version,
            inputs=inputs,
            foundation=foundation,
            agent_votes=votes,
            owner_signoff=owner_signoff,
            prepared_by=prepared_by,
            control_id=control_id,
            threshold=threshold,
            blocking_findings=blocking_findings,
            agreement_threshold=self.agreement_threshold,
            nosana_job_ids=nosana_job_ids,
        )

        result = LocknetResult(
            envelope=envelope,
            lock_state=envelope["lock_state"],
            is_evidence=envelope["is_evidence"],
            envelope_hash=envelope["envelope_hash"],
            nosana_job_ids=nosana_job_ids,
        )

        # Step 2: If LOCKED, anchor to Arweave
        if envelope["is_evidence"] and store_on_arweave:
            tx = self.arweave.store_evidence(
                envelope,
                tags={
                    "Control-ID": control_id,
                    "Agreement-Score": str(envelope.get("agreement_score", 0)),
                    "Agent-Count": str(len(votes)),
                },
            )
            result.arweave_tx_id = tx.tx_id
            result.arweave_tx_url = tx.url
            result.arweave_verify_url = self.arweave.build_verify_url(tx.tx_id)

        return result

    @staticmethod
    def verify(envelope: dict[str, Any]) -> dict[str, Any]:
        """Independently verify any sealed evidence envelope.

        No trust in the original sealer required.
        Recomputes all hashes and checks consistency.
        """
        return verify_envelope(envelope)
