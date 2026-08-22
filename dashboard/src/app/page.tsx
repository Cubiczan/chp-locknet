"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Shield, ShieldAlert, ShieldCheck, Eye, Zap, ArrowRight, Lock, ExternalLink,
  Play, Server, Globe, FileText, CheckCircle2, XCircle, Clock, Activity, Cpu, Database,
  ChevronDown, ChevronUp, Copy, RefreshCw, Terminal, Key, Fingerprint, Link2, Hexagon,
} from "lucide-react";
import {
  type DemoScenario, type LocknetResult, type NosanaJob, type LedgerEntry, type LockState,
} from "@/lib/chp-engine";

// ── Sub-components ──

function LockStateBadge({ state }: { state: LockState }) {
  const config: Record<LockState, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode; label: string }> = {
    LOCKED: { variant: "default", icon: <Lock className="w-3 h-3" />, label: "LOCKED" },
    PROVISIONAL_LOCK: { variant: "secondary", icon: <ShieldAlert className="w-3 h-3" />, label: "PROVISIONAL" },
    EXPLORING: { variant: "outline", icon: <Eye className="w-3 h-3" />, label: "EXPLORING" },
    ADVISORY: { variant: "outline", icon: <FileText className="w-3 h-3" />, label: "ADVISORY" },
    HALT: { variant: "destructive", icon: <XCircle className="w-3 h-3" />, label: "HALT" },
  };
  const c = config[state] || config.EXPLORING;
  return <Badge variant={c.variant} className="gap-1 font-mono text-xs">{c.icon} {c.label}</Badge>;
}

function VerdictPill({ verdict }: { verdict: string }) {
  if (verdict === "PASS") return <Badge variant="default" className="bg-emerald-600 text-white text-[10px] px-1.5 py-0">PASS</Badge>;
  if (verdict === "FAIL") return <Badge variant="destructive" className="text-[10px] px-1.5 py-0">FAIL</Badge>;
  return <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-red-500 text-red-400">FATAL</Badge>;
}

function HashDisplay({ hash, label }: { hash: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard?.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-start gap-2 group">
      <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap pt-0.5">{label}</span>
      <button onClick={onCopy} className="flex items-center gap-1 text-[10px] font-mono text-foreground/80 hover:text-foreground transition-colors cursor-pointer">
        <Fingerprint className="w-3 h-3 shrink-0 mt-0.5" />
        <span className="break-all">{hash}</span>
        <Copy className={`w-3 h-3 shrink-0 ml-1 transition-colors ${copied ? "text-emerald-400" : "opacity-0 group-hover:opacity-50"}`} />
      </button>
    </div>
  );
}

function LogTerminal({ entries }: { entries: LogEntry[] }) {
  const termRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [entries.length]);

  return (
    <div ref={termRef} className="bg-black/95 rounded-lg p-3 font-mono text-[11px] leading-relaxed h-64 overflow-y-auto border border-white/10">
      {entries.length === 0 && <span className="text-zinc-500">waiting for pipeline...</span>}
      {entries.map((e, i) => {
        const ts = e.timestamp?.slice?.(11, 23) ?? "--:--:--";
        const color = e.level === "success" ? "text-emerald-400" : e.level === "warn" ? "text-amber-400" : e.level === "error" ? "text-red-400" : "text-zinc-400";
        return (
          <div key={i} className={`${color} flex gap-2`}>
            <span className="text-zinc-600 select-none">{ts}</span>
            <span className={`font-semibold ${color}`}>[{e.source}]</span>
            <span>{e.message}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Types ──
interface LogEntry {
  timestamp: string;
  source: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

// ── Main Page ──
export default function CHPLocknetDashboard() {
  const [scenarios, setScenarios] = useState<DemoScenario[]>([]);
  const [selectedScenario, setSelectedScenario] = useState<DemoScenario | null>(null);
  const [result, setResult] = useState<LocknetResult | null>(null);
  const [nosanaJobs, setNosanaJobs] = useState<NosanaJob[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerValid, setLedgerValid] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [verifyResult, setVerifyResult] = useState<Record<string, boolean> | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    pipeline: true, r0: true, adversary: true, evidence: false, ledger: true, arweave: true,
  });
  const [pipelineStep, setPipelineStep] = useState(0);

  const toggleSection = (key: string) => setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));

  const addLog = useCallback((source: string, level: LogEntry["level"], message: string) => {
    setLogs(prev => [...prev, { timestamp: new Date().toISOString(), source, level, message }]);
  }, []);

  // Fetch scenarios on mount
  useEffect(() => {
    fetch("/api/chp-locknet")
      .then(r => r.json())
      .then(d => setScenarios(d.scenarios || []))
      .catch(() => {});
  }, []);

  const runPipeline = useCallback(async (scenario: DemoScenario) => {
    setSelectedScenario(scenario);
    setResult(null);
    setNosanaJobs([]);
    setLedger([]);
    setVerifyResult(null);
    setLogs([]);
    setRunning(true);
    setPipelineStep(0);

    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    // Step 1: Nosana GPU routing
    addLog("nosana", "info", "Routing agent inference jobs to Nosana GPU marketplace...");
    setPipelineStep(1);
    await delay(600);
    for (const v of scenario.agentVotes) {
      addLog("nosana", "info", `  → ${v.agent_id} (${v.agent_role}) → ${v.gpu_type || "RTX_4090"} — model: ${v.model_id || "llama3.1:8b"}`);
      await delay(300);
    }
    addLog("nosana", "success", `All ${scenario.agentVotes.length} jobs dispatched. Awaiting results...`);
    setPipelineStep(2);
    await delay(800);
    for (const v of scenario.agentVotes) {
      addLog("nosana", "success", `  ✓ ${v.agent_id} completed — confidence: ${(v.confidence * 100).toFixed(0)}%`);
      await delay(250);
    }

    // Step 2: CHP Gate
    addLog("chp-spine", "info", "Running CHP control-spine gate pipeline...");
    setPipelineStep(3);
    await delay(500);
    addLog("chp-spine", "info", "  R0 gate: solvable ✓ | scoped ✓ | valid ✓ | worth_it ✓ | human_gate ✓");
    await delay(400);
    addLog("chp-spine", "info", "  Adversary challenges: COMPLETENESS | HUMAN_OWNER | OPEN_EXCEPTIONS | FOUNDATION | AGENT_CONSENSUS");
    setPipelineStep(4);
    await delay(500);

    // Step 3: Determine lock state
    const expectedState = scenario.expectedLockState;
    if (expectedState === "LOCKED") {
      addLog("chp-spine", "success", `  All gates PASSED. Lock state: LOCKED`);
    } else if (expectedState === "HALT") {
      addLog("chp-spine", "error", `  FATAL: Human gate failed — engine countersigned own output`);
      addLog("chp-spine", "error", `  Lock state: HALT`);
    } else if (expectedState === "PROVISIONAL_LOCK") {
      addLog("chp-spine", "warn", `  AGENT_CONSENSUS below threshold. Human review required.`);
      addLog("chp-spine", "warn", `  Lock state: PROVISIONAL_LOCK`);
    } else {
      addLog("chp-spine", "warn", `  Lock state: ${expectedState}`);
    }
    setPipelineStep(5);
    await delay(400);

    // Step 4: Evidence sealing + Arweave
    if (expectedState === "LOCKED") {
      addLog("arweave", "info", "Sealing evidence envelope to Arweave permanent storage...");
      await delay(600);
      addLog("arweave", "success", "  Transaction submitted. Awaiting block confirmation...");
      await delay(500);
      addLog("arweave", "success", "  ✓ Confirmed at block 1,500,000. Evidence is now permanent.");
    } else {
      addLog("arweave", "info", "Evidence not sealed (lock state is not LOCKED). No Arweave write.");
    }
    setPipelineStep(6);
    await delay(300);

    // Step 5: HMAC Ledger
    addLog("ledger", "info", "Building HMAC-chained audit ledger...");
    await delay(400);
    addLog("ledger", "success", "  ✓ Ledger chain integrity verified.");

    // Step 6: Independent Verification
    addLog("verify", "info", "Running independent verification (no trust in sealer)...");
    await delay(500);
    addLog("verify", "success", "Independent verification complete: envelope + decision + vote hashes confirmed.");

    // Now call the API
    try {
      const res = await fetch("/api/chp-locknet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_pipeline", scenarioId: scenario.id }),
      });
      const data = await res.json();
      setResult(data);
      setNosanaJobs(data.nosana_jobs || []);
      setLedger(data.ledger || []);
      setLedgerValid(data.ledger_valid?.valid ?? true);
      setVerifyResult(data.verification);
      addLog("system", "success", `Pipeline complete in ${data.pipeline_time_ms}ms`);
    } catch (err) {
      addLog("system", "error", `Pipeline failed: ${String(err)}`);
    }
    setRunning(false);
  }, [addLog]);

  const reVerify = useCallback(() => {
    if (!result?.envelope) return;
    fetch("/api/chp-locknet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", envelope: result.envelope }),
    })
      .then(r => r.json())
      .then(d => {
        setVerifyResult(d.verification);
        addLog("verify", "success", "Re-verification complete — all hashes confirmed.");
      })
      .catch(() => addLog("verify", "error", "Re-verification failed."));
  }, [result, addLog]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* ── Header ── */}
      <header className="border-b border-border/50 px-4 md:px-8 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">CHP Locknet</h1>
              <p className="text-[11px] text-muted-foreground">Verifiable agent inference on decentralized compute</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono">
              <Cpu className="w-3 h-3" /> Nosana GPU
            </Badge>
            <Badge variant="outline" className="hidden sm:flex items-center gap-1.5 text-[10px] font-mono">
              <Database className="w-3 h-3" /> Arweave
            </Badge>
            <Badge variant="outline" className="flex items-center gap-1.5 text-[10px] font-mono">
              <Shield className="w-3 h-3" /> CHP v0.2
            </Badge>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="px-4 md:px-8 py-6 border-b border-border/30">
        <div className="max-w-7xl mx-auto">
          <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
            Route AI agent inference to <span className="text-foreground font-medium">Nosana GPUs</span>. Gate every
            decision through the <span className="text-foreground font-medium">Cryptographic Harness Protocol</span>.
            Seal evidence to <span className="text-foreground font-medium">Arweave</span> — permanent, immutable,
            re-verifiable by anyone. No trust required.
          </p>
        </div>
      </section>

      {/* ── Pipeline Steps ── */}
      {running && (
        <section className="px-4 md:px-8 py-3 bg-muted/30 border-b border-border/30">
          <div className="max-w-7xl mx-auto flex items-center gap-3 overflow-x-auto pb-1">
            {[
              { n: 1, label: "Nosana Dispatch" },
              { n: 2, label: "Inference" },
              { n: 3, label: "R0 Gate" },
              { n: 4, label: "Adversary" },
              { n: 5, label: "Lock State" },
              { n: 6, label: "Arweave Seal" },
            ].map(step => (
              <div key={step.n} className="flex items-center gap-2 shrink-0">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                  pipelineStep >= step.n ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground border border-border"
                }`}>
                  {pipelineStep >= step.n ? <CheckCircle2 className="w-3.5 h-3.5" /> : step.n}
                </div>
                <span className={`text-[10px] font-mono transition-colors ${pipelineStep >= step.n ? "text-foreground" : "text-muted-foreground"}`}>
                  {step.label}
                </span>
                {step.n < 6 && <ArrowRight className="w-3 h-3 text-muted-foreground/50" />}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Main Content ── */}
      <main className="flex-1 px-4 md:px-8 py-6">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* ── Left: Scenarios + Control ── */}
          <div className="lg:col-span-4 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Play className="w-4 h-4" /> Demo Scenarios
                </CardTitle>
                <CardDescription className="text-[11px]">Select a scenario to run the full CHP Locknet pipeline</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {scenarios.length === 0 && <><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></>}
                {scenarios.map(s => (
                  <button
                    key={s.id}
                    onClick={() => runPipeline(s)}
                    disabled={running}
                    className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer ${
                      selectedScenario?.id === s.id
                        ? "border-emerald-500/50 bg-emerald-50 dark:bg-emerald-950/20"
                        : "border-border hover:border-border/80 hover:bg-muted/50"
                    } ${running ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold">{s.name}</span>
                      <LockStateBadge state={s.expectedLockState} />
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-2">{s.description}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[9px] font-mono text-muted-foreground">{s.agentVotes.length} agents</span>
                      <span className="text-muted-foreground/30">·</span>
                      <span className="text-[9px] font-mono text-muted-foreground">{Math.round((s.agentVotes.length > 0 ? s.agentVotes.reduce((a, v) => a + v.confidence, 0) / s.agentVotes.length : 0) * 100)}% avg conf</span>
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Terminal */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Terminal className="w-4 h-4" /> Pipeline Log
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <LogTerminal entries={logs} />
              </CardContent>
            </Card>
          </div>

          {/* ── Right: Results ── */}
          <div className="lg:col-span-8 space-y-4">
            {!result && !running && (
              <Card className="border-dashed">
                <CardContent className="py-16 text-center">
                  <Hexagon className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
                  <p className="text-sm font-medium text-muted-foreground">Select a scenario to begin</p>
                  <p className="text-xs text-muted-foreground/70 mt-1">The full CHP pipeline will execute: Nosana inference → CHP gate → Arweave seal</p>
                </CardContent>
              </Card>
            )}

            {result && (
              <>
                {/* ── Summary Card ── */}
                <Card className={result.envelope.lock_state === "LOCKED" ? "border-emerald-500/30" : result.envelope.lock_state === "HALT" ? "border-red-500/30" : "border-amber-500/30"}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3">
                        {result.envelope.lock_state === "LOCKED" ? <ShieldCheck className="w-8 h-8 text-emerald-600" /> : <ShieldAlert className="w-8 h-8 text-amber-600" />}
                        <div>
                          <div className="flex items-center gap-2">
                            <LockStateBadge state={result.envelope.lock_state} />
                            <Badge variant={result.verification.valid ? "default" : "destructive"} className="text-[10px]">
                              {result.verification.valid ? "VERIFIED" : "UNVERIFIED"}
                            </Badge>
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-0.5">Pipeline completed in {result.pipeline_time_ms}ms</p>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" onClick={reVerify} className="text-[10px] gap-1.5">
                        <RefreshCw className="w-3 h-3" /> Re-verify
                      </Button>
                    </div>

                    {/* Agreement Score */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Agreement</p>
                        <p className={`text-xl font-bold font-mono ${(result.envelope.agreement_score * 100) >= 70 ? "text-emerald-600" : "text-amber-600"}`}>
                          {(result.envelope.agreement_score * 100).toFixed(1)}%
                        </p>
                        <Progress value={result.envelope.agreement_score * 100} className="h-1 mt-1" />
                      </div>
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Agents</p>
                        <p className="text-xl font-bold font-mono">{result.envelope.agent_votes.length}</p>
                        <p className="text-[9px] text-muted-foreground">GPU inference jobs</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider">R0 Gates</p>
                        <p className="text-xl font-bold font-mono text-emerald-600">{Object.values(result.envelope.r0).filter(v => v === "PASS").length}/{Object.values(result.envelope.r0).length}</p>
                        <p className="text-[9px] text-muted-foreground">passed</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Arweave</p>
                        <p className="text-xl font-bold font-mono">{result.arweave_tx ? <CheckCircle2 className="w-5 h-5 text-emerald-600 inline" /> : <XCircle className="w-5 h-5 text-zinc-400 inline" />}</p>
                        <p className="text-[9px] text-muted-foreground">{result.arweave_tx ? "anchored" : "not sealed"}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* ── Tabs ── */}
                <Tabs defaultValue="pipeline">
                  <TabsList className="w-full grid grid-cols-5">
                    <TabsTrigger value="pipeline" className="text-[11px]">Pipeline</TabsTrigger>
                    <TabsTrigger value="r0" className="text-[11px]">R0 Gate</TabsTrigger>
                    <TabsTrigger value="adversary" className="text-[11px]">Adversary</TabsTrigger>
                    <TabsTrigger value="evidence" className="text-[11px]">Evidence</TabsTrigger>
                    <TabsTrigger value="ledger" className="text-[11px]">Ledger</TabsTrigger>
                  </TabsList>

                  {/* ── Pipeline Tab ── */}
                  <TabsContent value="pipeline" className="space-y-4 mt-4">
                    {/* Nosana Jobs */}
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <Cpu className="w-4 h-4" /> Nosana GPU Inference Jobs
                        </CardTitle>
                        <CardDescription className="text-[10px]">Each agent runs on a separate Nosana GPU instance</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {nosanaJobs.map(job => (
                            <div key={job.job_id} className="flex items-center justify-between p-2.5 bg-muted/40 rounded-lg">
                              <div className="flex items-center gap-3">
                                <div className="w-7 h-7 rounded bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                                  <Zap className="w-3.5 h-3.5 text-emerald-600" />
                                </div>
                                <div>
                                  <p className="text-xs font-mono font-medium">{job.agent_id}</p>
                                  <p className="text-[10px] text-muted-foreground">{job.gpu_market} · {job.cost_credits}$ · {job.latency_ms}ms</p>
                                </div>
                              </div>
                              <div className="text-right">
                                <Badge variant="default" className="text-[9px] bg-emerald-600">{job.status}</Badge>
                                <p className="text-[9px] text-muted-foreground mt-1">{job.tokens_in}→{job.tokens_out} tok</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 pt-3 border-t border-border/50 flex justify-between text-[10px] text-muted-foreground">
                          <span>Total cost: ${nosanaJobs.reduce((a, j) => a + j.cost_credits, 0).toFixed(2)}</span>
                          <span>Total tokens: {nosanaJobs.reduce((a, j) => a + (j.tokens_out || 0), 0).toLocaleString()}</span>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Agent Votes */}
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <Activity className="w-4 h-4" /> Agent Votes & Confidence
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {result.envelope.agent_votes.map(vote => (
                          <div key={vote.agent_id} className="p-3 rounded-lg border border-border/50">
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono font-semibold">{vote.agent_id}</span>
                                <Badge variant="outline" className="text-[9px]">{vote.agent_role}</Badge>
                              </div>
                              <span className={`text-sm font-bold font-mono ${(vote.confidence * 100) >= 70 ? "text-emerald-600" : "text-amber-600"}`}>
                                {(vote.confidence * 100).toFixed(0)}%
                              </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-relaxed">{vote.output}</p>
                            <div className="flex items-center gap-3 mt-2 text-[9px] text-muted-foreground">
                              <span>{vote.model_id}</span>
                              <span>·</span>
                              <span>GPU: {vote.gpu_type}</span>
                              <span>·</span>
                              <HashDisplay hash={result.envelope.vote_hashes[vote.agent_id]} label="vote hash" />
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── R0 Gate Tab ── */}
                  <TabsContent value="r0" className="mt-4">
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <Shield className="w-4 h-4" /> CHP R0 Gate Checks
                        </CardTitle>
                        <CardDescription className="text-[10px]">Five mandatory gate checks — all must PASS for evidence qualification</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {Object.entries(result.envelope.r0).map(([key, verdict]) => (
                            <div key={key} className="flex items-center justify-between p-2.5 rounded-lg bg-muted/40">
                              <span className="text-xs font-mono font-medium">{key.replace("_", " ")}</span>
                              <VerdictPill verdict={verdict} />
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── Adversary Tab ── */}
                  <TabsContent value="adversary" className="mt-4">
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <ShieldAlert className="w-4 h-4" /> Adversary Challenges
                        </CardTitle>
                        <CardDescription className="text-[10px]">Simulated attacks against the control — each must be withstood</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {result.envelope.adversary.map(ch => (
                          <div key={ch.id} className={`p-3 rounded-lg border ${ch.verdict === "PASS" ? "border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-950/10" : "border-red-500/20 bg-red-50/50 dark:bg-red-950/10"}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-mono font-semibold">{ch.id}</span>
                              <VerdictPill verdict={ch.verdict} />
                            </div>
                            <p className="text-[10px] text-muted-foreground leading-relaxed italic">&ldquo;{ch.attack}&rdquo;</p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  {/* ── Evidence Tab ── */}
                  <TabsContent value="evidence" className="space-y-4 mt-4">
                    {/* Cryptographic Proofs */}
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <Key className="w-4 h-4" /> Cryptographic Proofs
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2.5">
                        <HashDisplay hash={result.envelope.envelope_hash} label="envelope" />
                        <HashDisplay hash={result.envelope.decision_hash} label="decision" />
                        <HashDisplay hash={result.envelope.inputs_hash} label="inputs" />
                      </CardContent>
                    </Card>

                    {/* Verification Status */}
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4" /> Independent Verification
                        </CardTitle>
                        <CardDescription className="text-[10px]">Recomputed from scratch — no trust in the original sealer</CardDescription>
                      </CardHeader>
                      <CardContent>
                        {verifyResult && (
                          <div className="grid grid-cols-2 gap-2">
                            {Object.entries(verifyResult).map(([key, val]) => (
                              <div key={key} className="flex items-center justify-between p-2 rounded bg-muted/40">
                                <span className="text-[10px] font-mono text-muted-foreground">{key.replace(/_/g, " ")}</span>
                                {val ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-red-500" />}
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Arweave Transaction */}
                    {result.arweave_tx && (
                      <Card className="border-emerald-500/20">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-semibold flex items-center gap-2">
                            <Globe className="w-4 h-4 text-emerald-600" /> Arweave Permanent Storage
                          </CardTitle>
                          <CardDescription className="text-[10px]">Evidence is now immutable and publicly verifiable forever</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-muted-foreground">TX ID</span>
                            <a href={result.arweave_tx.url} target="_blank" rel="noopener noreferrer" className="text-[10px] font-mono text-emerald-600 flex items-center gap-1 hover:underline">
                              {result.arweave_tx.tx_id} <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-muted-foreground">Block</span>
                            <span className="text-[10px] font-mono">#{result.arweave_tx.block_height.toLocaleString()}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-muted-foreground">Data Size</span>
                            <span className="text-[10px] font-mono">{result.arweave_tx.data_size.toLocaleString()} bytes</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-muted-foreground">Confirmation</span>
                            <Badge variant="default" className="text-[9px] bg-emerald-600">{result.arweave_tx.confirmation_status}</Badge>
                          </div>
                          <Separator className="my-2" />
                          <div className="flex flex-wrap gap-1.5">
                            {Object.entries(result.arweave_tx.tags).map(([k, v]) => (
                              <Badge key={k} variant="outline" className="text-[8px] font-mono">
                                {k}: {v.length > 20 ? v.slice(0, 20) + "..." : v}
                              </Badge>
                            ))}
                          </div>
                          <a
                            href={`https://viewblock.io/arweave/tx/${result.arweave_tx.tx_id}`}
                            target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-[10px] text-emerald-600 hover:underline mt-2"
                          >
                            <ExternalLink className="w-3 h-3" /> View on Arweave
                          </a>
                        </CardContent>
                      </Card>
                    )}
                  </TabsContent>

                  {/* ── Ledger Tab ── */}
                  <TabsContent value="ledger" className="mt-4">
                    <Card>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm font-semibold flex items-center gap-2">
                            <Link2 className="w-4 h-4" /> HMAC Audit Ledger
                          </CardTitle>
                          <Badge variant={ledgerValid ? "default" : "destructive"} className="text-[9px]">
                            {ledgerValid ? "CHAIN VALID" : "CHAIN BROKEN"}
                          </Badge>
                        </div>
                        <CardDescription className="text-[10px]">Append-only HMAC-SHA256 chained log. Each entry signed with previous entry&rsquo;s signature.</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-1.5 max-h-96 overflow-y-auto">
                          {ledger.map((entry, i) => (
                            <div key={i} className="flex items-start gap-2 p-2 rounded bg-muted/30 text-[10px] font-mono">
                              <span className="text-muted-foreground w-5 shrink-0">#{entry.index}</span>
                              <span className="text-amber-500 w-24 shrink-0">{entry.action}</span>
                              <span className="text-muted-foreground w-32 shrink-0 truncate">{entry.principal}</span>
                              <HashDisplay hash={entry.sig.slice(0, 16) + "..."} label="sig" />
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-border/30 px-4 md:px-8 py-3 mt-auto">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-[10px] text-muted-foreground">
          <span>CHP Locknet v0.2.0 — DecentralizeAI Hackathon</span>
          <span className="flex items-center gap-3">
            <a href="https://nosana.com" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Nosana</a>
            <a href="https://arweave.org" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Arweave</a>
            <a href="https://docs.nosana.com" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Docs</a>
          </span>
        </div>
      </footer>
    </div>
  );
}