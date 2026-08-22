"""Nosana decentralized GPU compute client.

Submits inference jobs to Nosana's GPU marketplace,
polls for completion, retrieves results.

API docs: https://docs.nosana.com
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError


NOSANA_API = "https://api.nosana.io/v1"
DEPLOY_URL = "https://deploy.nosana.com"


@dataclass
class NosanaJob:
    """A submitted Nosana GPU job."""
    job_id: str
    status: str = "pending"
    result: dict[str, Any] = field(default_factory=dict)
    container_image: str = ""
    gpu_market: str = ""
    started_at: str = ""
    completed_at: str = ""
    cost_credits: float = 0.0
    logs: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id, "status": self.status,
            "container_image": self.container_image,
            "gpu_market": self.gpu_market,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "cost_credits": self.cost_credits,
            "result": self.result,
        }


class NosanaClient:
    """Client for Nosana decentralized GPU marketplace.

    In production, uses real Nosana API.
    In demo mode, simulates GPU inference with realistic timing.
    """

    def __init__(self, api_key: str = "", demo: bool = False):
        self.api_key = api_key
        self.demo = demo
        self._jobs: dict[str, NosanaJob] = {}

    def submit_job(
        self,
        *,
        container_image: str,
        command: str = "",
        env_vars: dict[str, str] | None = None,
        gpu_type: str = "RTX_4090",
        timeout_minutes: int = 10,
        label: str = "",
    ) -> NosanaJob:
        """Submit an inference job to Nosana GPU marketplace."""
        if self.demo:
            return self._demo_submit(container_image, command, env_vars, gpu_type, timeout_minutes, label)

        # Real Nosana API call
        payload = {
            "container_image": container_image,
            "command": command.split() if command else [],
            "env": env_vars or {},
            "gpu_type": gpu_type,
            "timeout_minutes": timeout_minutes,
            "label": label,
            "strategy": "simple",
            "replica_count": 1,
        }
        req = Request(
            f"{NOSANA_API}/jobs",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urlopen(req) as resp:
                data = json.loads(resp.read())
        except HTTPError as e:
            raise RuntimeError(f"Nosana API error {e.code}: {e.read().decode()}") from e

        job = NosanaJob(
            job_id=data["id"],
            container_image=container_image,
            gpu_market=gpu_type,
            status=data.get("status", "pending"),
        )
        self._jobs[job.job_id] = job
        return job

    def get_job(self, job_id: str) -> NosanaJob:
        """Poll job status."""
        if self.demo:
            return self._jobs.get(job_id, NosanaJob(job_id=job_id))

        req = Request(
            f"{NOSANA_API}/jobs/{job_id}",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        with urlopen(req) as resp:
            data = json.loads(resp.read())
        job = self._jobs.get(job_id, NosanaJob(job_id=job_id))
        job.status = data.get("status", job.status)
        job.result = data.get("result", {})
        job.logs = data.get("logs", "")
        return job

    def wait_for_job(self, job_id: str, poll_interval: float = 2.0, timeout: float = 300.0) -> NosanaJob:
        """Block until job completes."""
        start = time.time()
        while time.time() - start < timeout:
            job = self.get_job(job_id)
            if job.status in ("completed", "failed", "timeout"):
                return job
            time.sleep(poll_interval)
        raise TimeoutError(f"Nosana job {job_id} did not complete within {timeout}s")

    def _demo_submit(
        self,
        container_image: str,
        command: str,
        env_vars: dict[str, str] | None,
        gpu_type: str,
        timeout_minutes: int,
        label: str,
    ) -> NosanaJob:
        """Simulate a Nosana job submission."""
        import uuid
        job_id = f"nosana-demo-{uuid.uuid4().hex[:12]}"
        job = NosanaJob(
            job_id=job_id,
            container_image=container_image,
            gpu_market=gpu_type,
            status="running",
            started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            cost_credits=round(0.48 * (timeout_minutes / 60), 2),
        )
        self._jobs[job_id] = job
        # Simulate completion after a short delay
        import threading
        def _complete():
            time.sleep(1.5)  # Simulate GPU inference time
            job.status = "completed"
            job.completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ")
            job.result = {
                "output": f"[DEMO] Inference on {gpu_type} complete for {container_image}",
                "tokens_in": 128,
                "tokens_out": 512,
                "latency_ms": 1200,
            }
            job.logs = f"Pulling {container_image}...\nGPU allocated: {gpu_type}\nRunning inference...\nDone."
        threading.Thread(target=_complete, daemon=True).start()
        return job
