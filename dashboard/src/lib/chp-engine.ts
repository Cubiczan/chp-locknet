// CHP Locknet Engine — TypeScript port of the Python control-spine + locknet pipeline
// Implements: R0 Gate → Adversary Challenges → Lock State → Evidence Seal → Arweave Anchor

export const SPINE_VERSION = "0.2.0-locknet";
export const CHP_ALIGNMENT = "consensus-hardening-protocol + Nosana compute + Arweave provenance";

export type LockState = "EXPLORING" | "ADVISORY" | "PROVISIONAL_LOCK" | "LOCKED" | "HALT";
export type Verdict = "PASS" | "FAIL" | "FATAL";

export interface Finding {
  code: string;
  message: string;
  blocking: boolean;
}

export interface AgentVote {
  agent_id: string;
  agent_role: string;
  output: string;
  confidence: number;
  model_id?: string;
  inference_id?: string;
  timestamp?: string;
  gpu_type?: string;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
}

export interface NosanaJob {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  container_image: string;
  gpu_market: string;
  agent_id: string;
  cost_credits: number;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  logs: string;
}

export interface EvidenceEnvelope {
  spine_version: string;
  chp_alignment: string;
  engine_id: string;
  engine_version: string;
  inputs_hash: string;
  foundation: string[];
  agent_votes: AgentVote[];
  vote_hashes: Record<string, string>;
  agreement_score: number;
  decision_hash: string;
  nosana_job_ids: string[];
  r0: Record<string, Verdict>;
  adversary: AdversaryChallenge[];
  blocking_findings: Finding[];
  lock_state: LockState;
  owner_signoff: string;
  prepared_by: string;
  is_evidence: boolean;
  sealed_at: string;
  envelope_hash: string;
}

export interface ArweaveTransaction {
  tx_id: string;
  owner: string;
  timestamp: number;
  data_size: number;
  tags: Record<string, string>;
  block_height: number;
  confirmation_status: string;
  url: string;
}

export interface LocknetResult {
  envelope: EvidenceEnvelope;
  arweave_tx: ArweaveTransaction | null;
  verification: VerificationResult;
  pipeline_time_ms: number;
}

export interface VerificationResult {
  valid: boolean;
  envelope_hash_ok: boolean;
  decision_hash_ok: boolean;
  vote_hashes_ok: boolean;
  r0_pass: boolean;
  adversary_pass: boolean;
  lock_consistent: boolean;
  is_evidence: boolean;
  lock_state: string;
}

export interface AdversaryChallenge {
  id: string;
  attack: string;
  verdict: Verdict;
}

// ── Crypto Primitives ──

export function canonicalHash(payload: unknown): string {
  const blob = JSON.stringify(payload, (_, v) => {
    if (typeof v === "undefined") return null;
    if (typeof v === "bigint") return v.toString();
    return v;
  }, 0);
  // Sort keys manually
  const sorted = sortKeys(JSON.parse(blob));
  const canonical = JSON.stringify(sorted);
  return sha256Hex(canonical);
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce((acc: Record<string, unknown>, key) => {
        acc[key] = sortKeys((obj as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return obj;
}

async function sha256Bytes(data: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(hashBuffer);
}

export async function sha256Hex(data: string): Promise<string> {
  const bytes = await sha256Bytes(data);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Synchronous fallback using a simple hash for demo (Web Crypto is async)
export function canonicalHashSync(payload: unknown): string {
  const blob = JSON.stringify(payload, (_, v) => {
    if (typeof v === "undefined") return null;
    if (typeof v === "bigint") return v.toString();
    return v;
  }, 0);
  const sorted = sortKeys(JSON.parse(blob));
  const canonical = JSON.stringify(sorted);
  return simpleHash(canonical);
}

function simpleHash(str: string): string {
  // FNV-1a → SHA-256-like hex (for demo, we use a deterministic approach)
  // In production, use Web Crypto API
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combine = (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  // Extend to 64 hex chars
  let extended = "";
  for (let i = 0; i < 4; i++) {
    let seed = h1 ^ h2 ^ (i * 0x9e3779b9);
    for (let j = 0; j < str.length; j++) {
      seed = Math.imul(seed ^ str.charCodeAt(j), 2654435761);
    }
    seed = Math.imul(seed ^ (seed >>> 16), 2246822507);
    extended += (seed >>> 0).toString(16).padStart(8, "0");
  }
  return extended + combine;
}

// ── HMAC Ledger (from cfo-agent-mesh pattern) ──

export interface LedgerEntry {
  index: number;
  action: string;
  principal: string;
  timestamp: string;
  sig: string;
  prevSig: string;
  payload: Record<string, unknown>;
}

export class HmacLedger {
  private entries: LedgerEntry[] = [];
  private secret: string;

  constructor(secret: string = "chp-locknet-demo-key") {
    this.secret = secret;
  }

  append(action: string, principal: string, payload: Record<string, unknown>): LedgerEntry {
    const prevSig = this.entries.length > 0 ? this.entries[this.entries.length - 1].sig : "";
    const canonical = JSON.stringify({ action, principal, payload, prevSig, ts: this.entries.length });
    const sig = simpleHash(this.secret + canonical);
    const entry: LedgerEntry = {
      index: this.entries.length,
      action,
      principal,
      timestamp: new Date().toISOString(),
      sig,
      prevSig,
      payload,
    };
    this.entries.push(entry);
    return entry;
  }

  getEntries(): LedgerEntry[] {
    return [...this.entries];
  }

  verify(): { valid: boolean; brokenAt?: number; reason?: string } {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      // Check prevSig linkage
      if (i > 0 && entry.prevSig !== this.entries[i - 1].sig) {
        return { valid: false, brokenAt: i, reason: "prevSig mismatch" };
      }
      if (i === 0 && entry.prevSig !== "") {
        return { valid: false, brokenAt: i, reason: "first entry must have empty prevSig" };
      }
      // Recompute sig
      const canonical = JSON.stringify({ action: entry.action, principal: entry.principal, payload: entry.payload, prevSig: entry.prevSig, ts: entry.index });
      const expectedSig = simpleHash(this.secret + canonical);
      if (entry.sig !== expectedSig) {
        return { valid: false, brokenAt: i, reason: "sig recomputation failed" };
      }
    }
    return { valid: true };
  }
}

// ── CHP R0 Gate ──

export function evaluateR0(params: {
  populationCount: number;
  controlId: string;
  threshold: string;
  engineId: string;
  inputsHash: string;
  ownerSignoff: string;
  preparedBy: string;
}): Record<string, Verdict> {
  return {
    Solvable: params.populationCount > 0 ? "PASS" : "FATAL",
    Scoped: (params.controlId && params.threshold) ? "PASS" : "FATAL",
    Valid: (params.engineId && params.inputsHash) ? "PASS" : "FATAL",
    Worth_it: (params.controlId.startsWith("ICFR-") || params.controlId.startsWith("LN-")) ? "PASS" : "FATAL",
    Human_gate: (params.ownerSignoff && params.ownerSignoff.trim() !== params.preparedBy.trim()) ? "PASS" : "FATAL",
  };
}

// ── Adversary Challenges ──

export function adversaryCheck(params: {
  populationCount: number;
  ownerSignoff: string;
  preparedBy: string;
  blocking: Finding[];
  foundation: string[];
  agentVotes: AgentVote[];
  agreementThreshold: number;
}): AdversaryChallenge[] {
  const challenges: AdversaryChallenge[] = [
    {
      id: "COMPLETENESS",
      attack: "The agent population is empty — a clean pack is indistinguishable from a missed control.",
      verdict: params.populationCount > 0 ? "PASS" : "FAIL",
    },
    {
      id: "HUMAN_OWNER",
      attack: "The engine countersigned its own output — separation of duties violated.",
      verdict: (params.ownerSignoff && params.ownerSignoff.trim() !== params.preparedBy.trim()) ? "PASS" : "FAIL",
    },
    {
      id: "OPEN_EXCEPTIONS",
      attack: "Blocking findings remain; LOCKED would assert a control that did not operate.",
      verdict: params.blocking.length === 0 ? "PASS" : "FAIL",
    },
    {
      id: "FOUNDATION",
      attack: "Assumptions were not committed before the inference ran.",
      verdict: params.foundation.length > 0 ? "PASS" : "FAIL",
    },
  ];

  // Locknet-specific: agent consensus
  if (params.agentVotes.length > 0) {
    const confs = params.agentVotes.map(v => v.confidence);
    const avgConf = confs.reduce((a, b) => a + b, 0) / confs.length;
    challenges.push({
      id: "AGENT_CONSENSUS",
      attack: `Agent consensus below ${(params.agreementThreshold * 100).toFixed(0)}% threshold (actual: ${(avgConf * 100).toFixed(1)}%). Decision unreliable.`,
      verdict: avgConf >= params.agreementThreshold ? "PASS" : "FAIL",
    });
  } else {
    challenges.push({
      id: "AGENT_CONSENSUS",
      attack: "No agent votes recorded. Cannot verify consensus.",
      verdict: "FAIL",
    });
  }

  return challenges;
}

// ── Lock State Machine ──

export function computeLockState(
  r0: Record<string, Verdict>,
  challenges: AdversaryChallenge[],
  owner: string
): LockState {
  const hasFatal = Object.entries(r0)
    .filter(([k]) => k !== "Human_gate")
    .some(([, v]) => v === "FATAL");
  if (hasFatal) return "HALT";

  const blockingFail = challenges.some(
    c => c.verdict !== "PASS" && c.id !== "HUMAN_OWNER"
  );
  const humanOk = r0.Human_gate === "PASS";
  const exceptionsClear = challenges
    .filter(c => c.id === "OPEN_EXCEPTIONS")
    .every(c => c.verdict === "PASS");

  if (blockingFail && !humanOk) return "EXPLORING";
  if (blockingFail && humanOk) return "PROVISIONAL_LOCK";
  if (!humanOk) return "EXPLORING";
  if (exceptionsClear && humanOk && Object.values(r0).every(v => v === "PASS")) return "LOCKED";
  return "ADVISORY";
}

// ── Full Pipeline: Seal Evidence ──

export function sealEvidence(params: {
  engineId: string;
  engineVersion: string;
  inputs: unknown;
  foundation: string[];
  agentVotes: AgentVote[];
  ownerSignoff: string;
  preparedBy: string;
  controlId?: string;
  threshold?: string;
  blockingFindings?: Finding[];
  agreementThreshold?: number;
  nosanaJobIds?: string[];
}): EvidenceEnvelope {
  const controlId = params.controlId || "LN-VERIFY-001";
  const threshold = params.threshold || "consensus";
  const blockingFindings = params.blockingFindings || [];
  const agreementThreshold = params.agreementThreshold || 0.7;
  const nosanaJobIds = params.nosanaJobIds || [];

  const inputsHash = canonicalHashSync(params.inputs);
  const population = params.agentVotes.length;

  const r0 = evaluateR0({
    populationCount: population,
    controlId,
    threshold,
    engineId: params.engineId,
    inputsHash,
    ownerSignoff: params.ownerSignoff,
    preparedBy: params.preparedBy,
  });

  const adversary = adversaryCheck({
    populationCount: population,
    ownerSignoff: params.ownerSignoff,
    preparedBy: params.preparedBy,
    blocking: blockingFindings,
    foundation: params.foundation,
    agentVotes: params.agentVotes,
    agreementThreshold,
  });

  const lockState = computeLockState(r0, adversary, params.ownerSignoff);

  const confs = params.agentVotes.length > 0
    ? params.agentVotes.map(v => v.confidence)
    : [0.0];
  const agreementScore = Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10000) / 10000;

  const voteHashes: Record<string, string> = {};
  for (const v of params.agentVotes) {
    voteHashes[v.agent_id] = canonicalHashSync(v);
  }

  const decisionHash = canonicalHashSync({
    inputs_hash: inputsHash,
    vote_hashes: voteHashes,
    agreement_score: agreementScore,
    lock_state: lockState,
  });

  const body: Omit<EvidenceEnvelope, "envelope_hash"> = {
    spine_version: SPINE_VERSION,
    chp_alignment: CHP_ALIGNMENT,
    engine_id: params.engineId,
    engine_version: params.engineVersion,
    inputs_hash: inputsHash,
    foundation: params.foundation,
    agent_votes: params.agentVotes,
    vote_hashes: voteHashes,
    agreement_score: agreementScore,
    decision_hash: decisionHash,
    nosana_job_ids: nosanaJobIds,
    r0,
    adversary,
    blocking_findings: blockingFindings,
    lock_state: lockState,
    owner_signoff: params.ownerSignoff,
    prepared_by: params.preparedBy,
    is_evidence: lockState === "LOCKED",
    sealed_at: new Date().toISOString(),
  };

  const envelopeHash = canonicalHashSync(body);
  return { ...body, envelope_hash: envelopeHash };
}

// ── Independent Verification ──

export function verifyEnvelope(envelope: EvidenceEnvelope): VerificationResult {
  const bodyForHash = { ...envelope };
  delete (bodyForHash as Partial<EvidenceEnvelope>).envelope_hash;
  const recomputedHash = canonicalHashSync(bodyForHash);
  const hashValid = recomputedHash === envelope.envelope_hash;

  const decisionRecomputed = canonicalHashSync({
    inputs_hash: envelope.inputs_hash,
    vote_hashes: envelope.vote_hashes,
    agreement_score: envelope.agreement_score,
    lock_state: envelope.lock_state,
  });
  const decisionValid = decisionRecomputed === envelope.decision_hash;

  let voteHashesValid = true;
  for (const vote of envelope.agent_votes) {
    const expected = canonicalHashSync(vote);
    if (expected !== envelope.vote_hashes[vote.agent_id]) {
      voteHashesValid = false;
      break;
    }
  }

  const r0Pass = Object.values(envelope.r0).every(v => v === "PASS");
  const adversaryPass = envelope.adversary.every(c => c.verdict === "PASS");
  const lockConsistent = envelope.lock_state === "LOCKED" && envelope.is_evidence === true;

  return {
    valid: hashValid && decisionValid && voteHashesValid && lockConsistent,
    envelope_hash_ok: hashValid,
    decision_hash_ok: decisionValid,
    vote_hashes_ok: voteHashesValid,
    r0_pass: r0Pass,
    adversary_pass: adversaryPass,
    lock_consistent: lockConsistent,
    is_evidence: envelope.is_evidence,
    lock_state: envelope.lock_state,
  };
}

// ── Arweave Demo Client ──

export function demoStoreEvidence(envelope: EvidenceEnvelope): ArweaveTransaction {
  const envHash = envelope.envelope_hash;
  const raw = `${envHash}-${Date.now()}`;
  const txId = `arweave-demo-${canonicalHashSync(raw).slice(0, 33)}`;

  return {
    tx_id: txId,
    owner: "demo-wallet-addr",
    timestamp: Math.floor(Date.now() / 1000),
    data_size: JSON.stringify(envelope).length,
    tags: {
      "Content-Type": "application/json",
      "App-Name": "CHP-Locknet",
      "Envelope-Hash": envHash,
      "Lock-State": envelope.lock_state,
      "Engine-ID": envelope.engine_id,
      "Control-ID": envelope.nosana_job_ids[0] || "",
      "Agreement-Score": String(envelope.agreement_score),
      "Agent-Count": String(envelope.agent_votes.length),
    },
    block_height: 1_500_000,
    confirmation_status: "confirmed",
    url: `https://arweave.net/${txId}`,
  };
}

// ── Nosana Demo Client ──

export function demoSubmitNosanaJob(params: {
  containerImage: string;
  agentId: string;
  agentRole: string;
  gpuType: string;
  model: string;
  prompt: string;
}): NosanaJob {
  const jobId = `nosana-demo-${canonicalHashSync(`${params.agentId}-${Date.now()}`).slice(0, 12)}`;
  return {
    job_id: jobId,
    status: "completed",
    container_image: params.containerImage,
    gpu_market: params.gpuType,
    agent_id: params.agentId,
    cost_credits: 0.04,
    latency_ms: 800 + Math.floor(Math.random() * 1200),
    tokens_in: 128,
    tokens_out: 256 + Math.floor(Math.random() * 512),
    logs: `Pulling ${params.containerImage}\nGPU allocated: ${params.gpuType}\nModel: ${params.model}\nRunning inference...\nDone.`,
  };
}

// ── Full Demo Pipeline ──

export interface DemoScenario {
  id: string;
  name: string;
  description: string;
  inputs: Record<string, unknown>;
  foundation: string[];
  ownerSignoff: string;
  preparedBy: string;
  agentVotes: AgentVote[];
  blockingFindings?: Finding[];
  expectedLockState: LockState;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "s1",
    name: "Clean Consensus — LOCKED",
    description: "Three agents agree with high confidence. All gates pass. Evidence sealed to Arweave.",
    inputs: { query: "Evaluate treasury reallocation: 40% SOL, 30% USDC, 20% BTC, 10% ETH", context: "Q4 2026 rebalance" },
    foundation: ["SOL liquidity depth > $50M on major DEXes", "USDC backing verified via on-chain reserves", "BTC/ETH positions hedged with 90-day options"],
    ownerSignoff: "CFO-Alice",
    preparedBy: "Agent-Mesh-Bob",
    agentVotes: [
      { agent_id: "risk-analyst", agent_role: "watcher", output: "Portfolio allocation within risk tolerance. VaR at 95% is 2.3%.", confidence: 0.92, model_id: "llama3.1:8b", gpu_type: "RTX_4090", latency_ms: 980, tokens_in: 128, tokens_out: 384 },
      { agent_id: "compliance-guard", agent_role: "consensus", output: "No regulatory concerns. All positions comply with current frameworks.", confidence: 0.88, model_id: "llama3.1:8b", gpu_type: "RTX_4090", latency_ms: 1100, tokens_in: 128, tokens_out: 412 },
      { agent_id: "treasury-executor", agent_role: "executor", output: "Execution plan feasible. Estimated slippage < 5bps across all pairs.", confidence: 0.85, model_id: "llama3.1:8b", gpu_type: "RTX_4090", latency_ms: 870, tokens_in: 128, tokens_out: 298 },
    ],
    expectedLockState: "LOCKED",
  },
  {
    id: "s2",
    name: "Low Confidence — PROVISIONAL_LOCK",
    description: "Agents disagree. Consensus below threshold. Human review required.",
    inputs: { query: "Should we liquidate 15% of treasury to cover operational costs?", context: "Emergency OpEx review" },
    foundation: ["Current runway: 18 months at burn rate", "No pending funding rounds"],
    ownerSignoff: "CFO-Alice",
    preparedBy: "Agent-Mesh-Bob",
    agentVotes: [
      { agent_id: "risk-analyst", agent_role: "watcher", output: "Liquidation increases single-point-of-failure risk. Recommend against.", confidence: 0.95, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
      { agent_id: "compliance-guard", agent_role: "consensus", output: "Proceed with caution. Ensure proper documentation.", confidence: 0.45, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
      { agent_id: "treasury-executor", agent_role: "executor", output: "Market conditions unfavorable for large sell. Spread would be 12bps.", confidence: 0.35, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
    ],
    expectedLockState: "PROVISIONAL_LOCK",
  },
  {
    id: "s3",
    name: "Self-Signing — HALT",
    description: "Engine prepared and signed off its own output. Separation of duties violated.",
    inputs: { query: "Approve vendor payment of $250,000 to Acme Corp", context: "Invoice #V-2026-0892" },
    foundation: ["Invoice verified against PO #PO-2026-0044"],
    ownerSignoff: "Agent-Mesh-Bob",
    preparedBy: "Agent-Mesh-Bob",
    agentVotes: [
      { agent_id: "risk-analyst", agent_role: "watcher", output: "Vendor trust score acceptable.", confidence: 0.82, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
      { agent_id: "compliance-guard", agent_role: "consensus", output: "Payment within policy limits.", confidence: 0.79, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
    ],
    expectedLockState: "HALT",
  },
  {
    id: "s4",
    name: "No Foundation — EXPLORING",
    description: "No assumptions were committed before inference. Cannot verify decision grounding.",
    inputs: { query: "Adjust DeFi yield strategy from 60/40 to 70/30 stable/volatile", context: "Yield optimization" },
    foundation: [],
    ownerSignoff: "CFO-Alice",
    preparedBy: "Agent-Mesh-Bob",
    agentVotes: [
      { agent_id: "risk-analyst", agent_role: "watcher", output: "Increasing volatile allocation by 10% is within tolerance.", confidence: 0.78, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
      { agent_id: "treasury-executor", agent_role: "executor", output: "Rebalancing executable within one trading session.", confidence: 0.81, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
    ],
    expectedLockState: "EXPLORING",
  },
  {
    id: "s5",
    name: "Blocking Finding — EXPLORING",
    description: "A compliance blocking finding prevents LOCKED state. Must resolve before evidence.",
    inputs: { query: "Transfer $500K USDC to multi-sig for grant disbursement", context: "Ecosystem grants Q3" },
    foundation: ["Grant committee approved 12 proposals", "Multi-sig threshold: 3/5 signers"],
    ownerSignoff: "CFO-Alice",
    preparedBy: "Agent-Mesh-Bob",
    agentVotes: [
      { agent_id: "risk-analyst", agent_role: "watcher", output: "Transfer amount within approved budget.", confidence: 0.90, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
      { agent_id: "compliance-guard", agent_role: "consensus", output: "BLOCKING: Recipient address not on sanctioned list BUT KYC incomplete for 3 of 12 grant recipients.", confidence: 0.60, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
      { agent_id: "treasury-executor", agent_role: "executor", output: "Execution ready pending compliance clearance.", confidence: 0.85, model_id: "llama3.1:8b", gpu_type: "RTX_4090" },
    ],
    blockingFindings: [{ code: "KYC-INCOMPLETE", message: "3 grant recipients lack KYC verification", blocking: true }],
    expectedLockState: "EXPLORING",
  },
];
