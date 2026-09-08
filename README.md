# Kyron Evaluation Platform

> **A Full-Stack Evaluation Platform for Healthcare Voice Agents**  
> Evaluates the reasoning, tool-use, safety policy compliance, and conversational state transitions of healthcare agents without placing live telephone calls.

---

## Quickstart (The Zero-Key Story)

**A reviewer does not need an OpenAI API key to run, test, or inspect this platform.**

All 55 traces and 700+ recorded model interactions are committed under `traces/` and `cache/llm/`. Every unit test, integration test, dataset validator, evaluator report, and UI inspection view runs **100% offline** with zero network calls and deterministic byte-for-byte reproducibility.

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Test Suites
Run all tests (unit, integration, e2e, dataset validation, discrimination matrix):
```bash
npm test
```

### 3. Launch the Evaluation Inspector UI
Start the local evaluation web server:
```bash
npm start
```
Open your browser to: **[http://localhost:3000](http://localhost:3000)**

---

## Start Here

```bash
npm run demo
```

One command, no API key. It walks a single run end to end — the scenario and the fault
injected into it, the recorded conversation, the tool that returned `ok`, the database
that never changed, the agent telling the patient it was all set, and the metrics that
caught it with the exact events they rest on.

That is the whole product in about forty lines of output.

---

## What to Look at First

When you open the web UI at **[http://localhost:3000](http://localhost:3000)**:

1. **Dashboard Overview (`/`):**
   * Review run status cards, overall pass/fail verdicts, and critical policy violation alerts across evaluated runs.
2. **The Headline Run Inspector (`/api/runs/:id` via UI):**
   * Open `sched-reschedule-clean-001__llm-v2__s1` — the write-oscillation loop. (Seed 0 is the one seed that does *not* loop; it reproduces on 4 of 5.)
   * **Left Column:** Inspect the evaluated metrics. Click on any failing metric badge (e.g. `redundant_writes` or `must_not_assert_completion_unless_state_confirms`) to see the **highlighted trace turns** cited under `evidence_events`.
   * **Right Column:** Review the turn-by-turn dialogue, tool call parameters/results, and clinic world state diffs.
3. **v1 vs. v2 Regression Comparison:**
   * Navigate to the comparison view to see **Agent v1** (clean control pass) vs. **Agent v2** (write-oscillation thrashing loop).
4. **Human Review Overrides:**
   * Use the review drawer to add human QA annotations and override automated verdicts. Edits persist to `reviews/<run_id>.json`.

---

## CLI Commands & Workflows

| Command | Description |
|---|---|
| `npm test` | Complete offline test suite (typecheck + dataset validation + unit + integration + e2e). |
| `npm start` | Launches the REST API and web inspector UI at `http://localhost:3000`. |
| `npm run eval` | Executes the evaluation runner across all scenarios and agents in replay mode. |
| `npm run compare` | Runs the two-arm comparison (reactive vs. controlled) for Agent v1 vs. v2. |
| `npm run validate` | Validates scenario YAML definitions, policy linkages, and hidden fact integrity. |
| `npm run test:discriminate` | Verifies scenarios cleanly separate oracle, naive, and panicky agent stubs. |
| `npm run traces` | Regenerates committed deterministic stub traces. |
| `npm run demo` | Walks the whole loop in one command — scenario, trace, evaluation, evidence. **Start here.** |
| `npm run fixtures` | Regenerates the per-metric discrimination fixtures (see below). |
| `npm run acceptance` | Runs Parts 1+2 with a real model, separating invariants from observations. |

### Optional: Running Live LLM Evaluations
To run live models against novel scenarios or prompts:
1. Copy `.env.example` to `.env` and configure `OPENAI_API_KEY=your_key`.
2. Run with `LLM_MODE=live`:
   ```bash
   LLM_MODE=live npm run eval -- --scenarios sched-reschedule-clean-001 --agents llm:v1
   ```

---

## Key Architecture Decisions

```
scenarios/*.yaml   policies/policies.yaml        <- Part 1: Scenario Dataset & Clinical Policies
        │
lib/dataset/load.ts                              <- Schema validation, inheritance, and cross-checks
        │
lib/world/      lib/harness/    lib/caller/      <- Part 2: Isolated contexts, clinic DB, turn loop
lib/agents/     lib/llm/        lib/store/
        │
   traces/*.json                                 <- The Trace Artifact (committed, reproducible)
        │
lib/eval/{outcome,process,judged}  registry.ts   <- Part 3: 19 metrics + Startup Registry Guard
        │
lib/server/index.ts  +  public/                  <- Part 4: Zero-dependency REST API & Inspector UI
```

* **Zero Telepathy via Context Isolation:** Caller and agent execution contexts are structurally separated. The agent cannot see caller hidden facts or world state except through explicit conversation and tool calls.
* **Startup Registry Guard:** Asserts that every policy defined in `policies.yaml` and every expectation declared in scenario YAMLs maps to an active evaluator. Eliminates silent vacuous passes.
* **Process Metrics Over Outcome-Only Checks:** Caught the project's headline finding—an agent that oscillated between candidate appointment slots 5 times in a loop, where final database state was determined purely by arbitrary harness tool limits.
* **Calibrated LLM Judge with Fingerprint Guards:** Qualitative capability evaluation uses an LLM judge calibrated against human labels, guarded by trace fingerprints so a label written against an older recording is reported as stale rather than counted as a judge error.
* **Per-Metric Discrimination Fixtures:** Every metric is pinned to a run it must fail and a run it must pass — the same contract the dataset already enforces for scenarios. Three evaluator bugs were found during the build by reading output rather than by any test; this is the net that catches the next one. Four metrics the corpus cannot exercise in both directions are *declared unprovable* rather than assumed correct.
* **ASR Fault Injection (Speech-Layer Proxy):** Transcription errors are injected between the caller and the agent, recording both what was said and what was heard. This is **not audio** — there is no acoustic model anywhere in this system. It simulates the one thing a transcription layer does to the reasoning layer: hand the agent a plausible sentence containing the wrong entity.

---

## Full Documentation

For the complete technical writeup, detailed specifications of all 19 metrics, manual label calibration, experimental findings, product recommendations, and production architecture design, see:

📄 **[report.md](report.md)**
