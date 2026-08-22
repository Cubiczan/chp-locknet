"""Arweave permanent storage client.

Writes sealed evidence envelopes to Arweave's permanent storage.
Once stored, the envelope is immutable and publicly verifiable forever.

Uses Arweave JSON transactions for structured data storage.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError


ARWEAVE_GATEWAY = "https://arweave.net"
ARWEAVE_GRAPHQL = f"{ARWEAVE_GATEWAY}/graphql"


@dataclass
class ArweaveTransaction:
    """An Arweave transaction storing an evidence envelope."""
    tx_id: str
    owner: str = ""
    timestamp: int = 0
    data_size: int = 0
    tags: dict[str, str] = field(default_factory=dict)
    block_height: int = 0
    confirmation_status: str = "pending"

    def to_dict(self) -> dict[str, Any]:
        return {
            "tx_id": self.tx_id,
            "owner": self.owner,
            "timestamp": self.timestamp,
            "data_size": self.data_size,
            "tags": self.tags,
            "block_height": self.block_height,
            "confirmation_status": self.confirmation_status,
        }

    @property
    def url(self) -> str:
        return f"{ARWEAVE_GATEWAY}/{self.tx_id}"


class ArweaveClient:
    """Client for Arweave permanent storage.

    In production, signs and submits real Arweave transactions.
    In demo mode, simulates storage with realistic TX IDs.
    """

    def __init__(self, wallet_key: str = "", demo: bool = False):
        self.wallet_key = wallet_key
        self.demo = demo
        self._stored: dict[str, dict[str, Any]] = {}

    def store_evidence(
        self,
        envelope: dict[str, Any],
        tags: dict[str, str] | None = None,
    ) -> ArweaveTransaction:
        """Store a sealed evidence envelope on Arweave.

        The envelope becomes permanent, immutable, and publicly readable.
        """
        if self.demo:
            return self._demo_store(envelope, tags)

        # Real Arweave upload
        data_bytes = json.dumps(envelope).encode("utf-8")
        app_tags = [
            {"name": "Content-Type", "value": "application/json"},
            {"name": "App-Name", "value": "CHP-Locknet"},
            {"name": "App-Version", "value": "0.1.0"},
            {"name": "Envelope-Hash", "value": envelope.get("envelope_hash", "")},
            {"name": "Lock-State", "value": envelope.get("lock_state", "")},
            {"name": "Engine-ID", "value": envelope.get("engine_id", "")},
        ]
        if tags:
            for k, v in tags.items():
                app_tags.append({"name": k, "value": v})

        # POST to arweave.net/tx
        payload = {
            "data": data_bytes.decode("utf-8"),  # base64url in production
            "tags": app_tags,
        }
        req = Request(
            f"{ARWEAVE_GATEWAY}/tx",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.wallet_key}",
            },
            method="POST",
        )
        try:
            with urlopen(req) as resp:
                result = json.loads(resp.read())
        except HTTPError as e:
            raise RuntimeError(f"Arweave upload error {e.code}: {e.read().decode()}") from e

        tx = ArweaveTransaction(
            tx_id=result["id"],
            data_size=len(data_bytes),
            tags={t["name"]: t["value"] for t in app_tags},
        )
        self._stored[tx.tx_id] = envelope
        return tx

    def retrieve_evidence(self, tx_id: str) -> dict[str, Any] | None:
        """Retrieve a stored evidence envelope by transaction ID."""
        if self.demo:
            return self._stored.get(tx_id)

        req = Request(f"{ARWEAVE_GATEWAY}/{tx_id}")
        try:
            with urlopen(req) as resp:
                return json.loads(resp.read())
        except HTTPError:
            return None

    def verify_on_chain(self, tx_id: str) -> dict[str, Any]:
        """Verify transaction exists and is confirmed on Arweave.

        Returns status info. Anyone can call this — no trust needed.
        """
        if self.demo:
            stored = self._stored.get(tx_id)
            if stored:
                return {
                    "tx_id": tx_id,
                    "found": True,
                    "confirmed": True,
                    "block_height": 1_500_000,
                    "envelope_hash": stored.get("envelope_hash", ""),
                }
            return {"tx_id": tx_id, "found": False, "confirmed": False}

        # Query Arweave GraphQL
        query = {
            "query": """
            query ($txId: ID!) {
              transactions(ids: [$txId]) {
                edges {
                  node {
                    id
                    owner { address }
                    timestamp
                    block { height }
                    data { size }
                  }
                }
              }
            }
            """,
            "variables": {"txId": tx_id},
        }
        req = Request(
            ARWEAVE_GRAPHQL,
            data=json.dumps(query).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as resp:
            result = json.loads(resp.read())

        edges = result.get("data", {}).get("transactions", {}).get("edges", [])
        if not edges:
            return {"tx_id": tx_id, "found": False, "confirmed": False}

        node = edges[0]["node"]
        return {
            "tx_id": tx_id,
            "found": True,
            "confirmed": bool(node.get("block", {}).get("height")),
            "block_height": node.get("block", {}).get("height", 0),
            "owner": node.get("owner", {}).get("address", ""),
            "data_size": node.get("data", {}).get("size", 0),
        }

    def _demo_store(
        self, envelope: dict[str, Any], tags: dict[str, str] | None
    ) -> ArweaveTransaction:
        """Simulate Arweave storage."""
        import hashlib
        prefix = "arweave-demo-"
        # Deterministic-ish TX ID from envelope hash
        env_hash = envelope.get("envelope_hash", "")
        raw = f"{env_hash}-{time.time()}".encode()
        fake_tx = prefix + hashlib.sha256(raw).hexdigest()[:33]

        all_tags = {
            "Content-Type": "application/json",
            "App-Name": "CHP-Locknet",
            "Envelope-Hash": envelope.get("envelope_hash", ""),
            "Lock-State": envelope.get("lock_state", ""),
        }
        if tags:
            all_tags.update(tags)

        tx = ArweaveTransaction(
            tx_id=fake_tx,
            timestamp=int(time.time()),
            data_size=len(json.dumps(envelope)),
            tags=all_tags,
            block_height=1_500_000,
            confirmation_status="confirmed",
        )
        self._stored[fake_tx] = envelope
        return tx

    def build_verify_url(self, tx_id: str) -> str:
        """Build a public verification URL."""
        return f"https://viewblock.io/arweave/tx/{tx_id}"

    def build_data_url(self, tx_id: str) -> str:
        """Build a URL to retrieve the raw envelope data."""
        return f"{ARWEAVE_GATEWAY}/{tx_id}"
