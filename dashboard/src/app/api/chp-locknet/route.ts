import { NextRequest, NextResponse } from "next/server";
import {
  sealEvidence,
  verifyEnvelope,
  demoStoreEvidence,
  demoSubmitNosanaJob,
  DEMO_SCENARIOS,
  HmacLedger,
  type AgentVote,
  type EvidenceEnvelope,
  type LocknetResult,
} from "@/lib/chp-engine";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "run_pipeline") {
      return runPipeline(body);
    }
    if (action === "verify") {
      return verifyEvidence(body);
    }
    if (action === "scenarios") {
      return NextResponse.json({ scenarios: DEMO_SCENARIOS });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

function runPipeline(body: Record<string, unknown>) {
  const { scenarioId, customVotes, customInputs, customFoundation, ownerSignoff, preparedBy } = body;

  // Find scenario or use custom
  const scenario = DEMO_SCENARIOS.find(s => s.id === scenarioId);
  const votes: AgentVote[] = (customVotes || scenario?.agentVotes || []) as AgentVote[];
  const inputs = customInputs || scenario?.inputs || {};
  const foundation = customFoundation || scenario?.foundation || [];
  const owner = (ownerSignoff || scenario?.ownerSignoff || "CFO-Alice") as string;
  const preparer = (preparedBy || scenario?.preparedBy || "Agent-Mesh-Bob") as string;

  const startTime = performance.now();

  // Step 1: Simulate Nosana GPU inference jobs
  const nosanaJobs = votes.map(v =>
    demoSubmitNosanaJob({
      containerImage: "ghcr.io/nosana/ai-inference:latest",
      agentId: v.agent_id,
      agentRole: v.agent_role,
      gpuType: v.gpu_type || "RTX_4090",
      model: v.model_id || "llama3.1:8b",
      prompt: JSON.stringify(inputs),
    })
  );

  // Step 2: CHP Gate Pipeline
  const envelope = sealEvidence({
    engineId: "chp-locknet",
    engineVersion: "0.2.0",
    inputs,
    foundation: foundation as string[],
    agentVotes: votes,
    ownerSignoff: owner,
    preparedBy: preparer,
    controlId: scenario?.id ? `LN-${scenario.id.toUpperCase()}` : "LN-CUSTOM",
    threshold: "consensus",
    nosanaJobIds: nosanaJobs.map(j => j.job_id),
  });

  // Step 3: Build HMAC ledger
  const ledger = new HmacLedger("chp-locknet-session-key");
  ledger.append("INFERENCE_START", "locknet-orchestrator", { scenario: scenario?.id, agent_count: votes.length });
  for (const job of nosanaJobs) {
    ledger.append("NOSANA_JOB", "locknet-orchestrator", { job_id: job.job_id, gpu: job.gpu_market, status: job.status });
  }
  ledger.append("CHP_GATE", "control-spine", { r0: envelope.r0, lock_state: envelope.lock_state });
  ledger.append("ADVERSARY", "control-spine", { challenges: envelope.adversary.map(c => ({ id: c.id, v: c.verdict })) });
  if (envelope.is_evidence) {
    ledger.append("EVIDENCE_SEALED", "locknet-orchestrator", { envelope_hash: envelope.envelope_hash });
  }

  // Step 4: If LOCKED, anchor to Arweave
  let arweaveTx = null;
  if (envelope.is_evidence) {
    arweaveTx = demoStoreEvidence(envelope);
    ledger.append("ARWEAVE_ANCHOR", "arweave-client", { tx_id: arweaveTx.tx_id, block: arweaveTx.block_height });
  }

  // Step 5: Independent verification
  const verification = verifyEnvelope(envelope);

  const pipelineTimeMs = Math.round(performance.now() - startTime);

  const result: LocknetResult = {
    envelope,
    arweave_tx: arweaveTx,
    verification,
    pipeline_time_ms: pipelineTimeMs,
  };

  return NextResponse.json({
    ...result,
    nosana_jobs: nosanaJobs,
    ledger: ledger.getEntries(),
    ledger_valid: ledger.verify(),
  });
}

function verifyEvidence(body: Record<string, unknown>) {
  const { envelope } = body as { envelope: EvidenceEnvelope };
  if (!envelope) {
    return NextResponse.json({ error: "Missing envelope" }, { status: 400 });
  }
  const result = verifyEnvelope(envelope);
  return NextResponse.json({ verification: result });
}

export async function GET() {
  return NextResponse.json({ scenarios: DEMO_SCENARIOS });
}
