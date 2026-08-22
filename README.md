# CHP Locknet

> **Verifiable AI agent inference on decentralized compute.**
> Route inference to Nosana GPUs. Gate decisions through CHP. Seal evidence to Arweave.

```
Challenge submitted to agent swarm
       ↓
Nosana GPUs run inference (llama3.1, mistral, etc.)
       ↓
CHP R0 → Adversary → Lock → Seal
       ↓
If LOCKED: evidence envelope → Arweave (permanent, immutable)
       ↓
Anyone can re-verify — no trust in the sealer
```

### The Hook

*Decentralized compute without verifiable decisions is just a slower OpenAI.*

GPU marketplaces like Nosana let you run LLM inference without hyperscalers. But if you can't verify what the model decided — and why — you've just moved your trust from Microsoft to a random GPU node.

CHP Locknet adds a **cryptographic verification layer** between inference and action. Before any decision is acted on, it passes through the CHP control-spine gate pipeline (R0 → Adversary → Lock → Seal), and the resulting evidence envelope is permanently anchored to Arweave. Anyone can re-verify the decision without trusting the original sealer.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  NOSANA (Compute)        CHP CONTROL-SPINE (Gates)    ARWEAVE (Prov) │
│                                                                       │
│  Agent 1 → GPU → Vote     R0 Gate (5 checks)      Evidence Envelope  │
│  Agent 2 → GPU → Vote     Adversary (5 attacks)    → Arweave TX      │
│  Agent 3 → GPU → Vote     Lock State Machine       (permanent,       │
│  Agent N → GPU → Vote     HMAC Audit Ledger        immutable,        │
│                             Seal (SHA-256)           verifiable)      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## CHP Gate Pipeline

### R0 Gate (5 checks)

| Check | Rule |
|-------|------|
| **Solvable** | Agent population > 0 |
| **Scoped** | Control ID + threshold provided |
| **Valid** | Engine ID + inputs hash present |
| **Worth It** | Control ID starts with `LN-` or `ICFR-` |
| **Human Gate** | Owner ≠ prepared_by (separation of duties) |

### Adversary Challenges (5 checks)

| Challenge | Attack |
|-----------|-------|
| **COMPLETENESS** | Empty population → indistinguishable from missed control |
| **HUMAN_OWNER** | Engine countersigned its own output |
| **OPEN_EXCEPTIONS** | Blocking findings remain unaddressed |
| **FOUNDATION** | Assumptions not committed before measurement |
| **AGENT_CONSENSUS** | Average agent confidence below threshold (Locknet extension) |

### Lock States

```
EXPLORING → ADVISORY → PROVISIONAL_LOCK → LOCKED (evidence)
                                            → HALT
```

Only **LOCKED** packs are evidence. Only evidence gets stored on Arweave.

---

## Evidence Envelope

Every sealed envelope contains:

- **inputs_hash**: SHA-256 of the canonical challenge input
- **vote_hashes**: SHA-256 of each agent's vote payload
- **agreement_score**: mean confidence across all agents
- **decision_hash**: SHA-256 of (inputs_hash + vote_hashes + score + lock_state)
- **envelope_hash**: SHA-256 of the entire envelope body
- **r0**: all 5 gate results
- **adversary**: all 5 challenge results
- **nosana_job_ids**: which GPU jobs produced which votes
- **sealed_at**: UTC timestamp

Anyone can recompute every hash and verify the envelope without trusting the original sealer.

---

## Quick Start

### Dashboard (Next.js)

```bash
cd dashboard
npm install
npm run dev
# Open http://localhost:3000
```

### Python Core

```bash
cd src
pip install -e .
python -m pytest tests/ -v
```

### Run the demo

```bash
PYTHONPATH=src python demo/demo_run.py
```

---

## Demo Scenarios

| Scenario | Agents | Result | Why |
|----------|--------|--------|-----|
| **Clean Consensus** | 3 @ 92/88/85% | LOCKED | All gates pass, high agreement, evidence sealed to Arweave |
| **Low Confidence** | 3 @ 95/45/35% | PROVISIONAL_LOCK | Consensus below 70% threshold, human review required |
| **Self-Signing** | 2 @ 82/79% | HALT | Engine countersigned own output, separation of duties violated |
| **No Foundation** | 2 @ 78/81% | EXPLORING | No assumptions committed before inference |
| **Blocking Finding** | 3 @ 90/60/85% | EXPLORING | KYC incomplete for grant recipients |

---

## Deployment on Nosana

```bash
# Build the container
 docker build -t chp-locknet .

# Push to registry
 docker push ghcr.io/<user>/chp-locknet:latest

# Deploy on Nosana (deploy.nosana.com/deployments/create)
# IMPORTANT: Use Simple strategy, Replica Count 1, Container Timeout 30min
```

### Nosana Credit Optimization

With $70 credits, use these settings to maximize runtime:

1. Strategy: **Simple** (not Infinite)
2. Replica Count: **1**
3. Container Timeout: **30 minutes** (stop when idle)
4. GPU: **RTX 4090** ($0.08/h) — cheapest option for inference

At $0.08/h, $70 gives ~875 hours of compute.

---

## Tech Stack

- **[Nosana](https://nosana.com)** — Decentralized GPU marketplace for agent inference
- **[Arweave](https://arweave.net)** — Permanent, immutable evidence storage
- **[control-spine](https://github.com/icohangar-ops/control-spine)** — CHP R0/adversary/lock/seal gates
- **Next.js 16** — Interactive verification dashboard
- **TypeScript** — Type-safe CHP engine port
- **Python 3.10+** — Core library (SHA-256, HMAC, deterministic JSON)

---

## Decentralize AI Hackathon 2026

CHP Locknet hits all three layers of the decentralized AI stack:

1. **Compute** — Nosana GPU marketplace for decentralized inference
2. **Data** — Arweave for permanent, verifiable model decisions
3. **Governance** — CHP control-spine for cryptographic decision verification

---

## License

MIT
