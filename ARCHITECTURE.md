# Architecture

How this platform is built, and the constraint each choice answers.

---

## 1. The problem the architecture is shaped around

A voice agent can complete a call that reads flawlessly and still fail:

```
agent  : "You're all set — I've moved your prescription to Walgreens."
tool   : { ok: true }
database: preferred_pharmacy unchanged
```

Every signal available *inside the conversation* says success. Only the world disagrees.
That single observation drives almost every decision below: **ground truth lives in
state, not in dialogue**, and the system is built so that the two can be compared.

---

## 2. Data flow

```
scenarios/*.yaml   policies/policies.yaml
        │                    ground truth: what should be true when the call ends
        ▼
lib/dataset/load.ts          validation, inheritance, cross-checks
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  lib/harness/orchestrator.ts        the turn loop          │
│                                                            │
│   lib/caller/   ◄── speech only ──►   lib/agents/          │
│   (the patient)                       (the system under test)
│                                              │             │
│                                        tool calls          │
│                                              ▼             │
│                                       lib/world/           │
│                                       (mock clinic, ground truth)
└───────────────────────────────────────────────────────────┘
        │
        ▼
   traces/*.json               the artefact — committed, replayable
        │
        ▼
lib/eval/{outcome,process,judged} + registry.ts
        │
        ▼
lib/server/ + public/          the inspector
```

**The harness and the application never call each other.** They are joined by files on
disk. This is why the demo does not depend on a live run: traces already exist, so every
screen is populated before anything executes.

---

## 3. Components

### `lib/types/` — the contracts

Zod schemas for scenarios, world state, tools, traces and policies. Written before any
runtime code, because they are the boundaries between the dataset, the harness and the
app.

Every object is `.strict()`. This is not stylistic. Consider:

```ts
const expected = scenario.expected_outcome?.critical_entities ?? {};
Object.entries(expected).every(check)      // [].every(...) === true
```

A misspelled key produces an empty expectation set, which satisfies every expectation.
The metric reports **PASS**, having compared nothing. `.strict()` turns that typo into a
load-time error. Expectation sets are additionally refined non-empty, because a
correctly-spelled but empty block fails the same way.

### `lib/world/` — the mock clinic, and the ground truth

Eleven clinic tools over an in-memory database: patients, appointments, availability,
medications, pharmacies, refill requests, escalations. A twelfth, `memory.write`, is agent
state rather than clinic state and is intercepted by the orchestrator before it reaches
the World.

**It enforces no policy.** It will disclose a medication list to a caller who was never
verified. That is deliberate: a backend that refused would make the privacy violation
*impossible*, so the metric would score perfectly on every run and we would be measuring
the mock rather than the agent. It enforces physical constraints only — you cannot book a
slot that does not exist, or refill a prescription with none remaining. Everything else is
evaluated after the fact.

**Fault injection** is middleware. The important mode is `silent_no_op`: the real handler
runs against a throwaway copy of state, its result is returned, and every mutation is
discarded. The response is byte-for-byte what genuine success produces, so the agent has
exactly one way to detect it — read the record back.

Generated ids are **deterministic and sequential** (`RQ-1`, `ESC-1`), because scenarios
declare expected final state that references them. UUIDs would make state comparison
inexpressible.

### `lib/harness/` — the turn loop

Drives a caller and an agent against a world, and assembles the trace. It knows nothing
about LLMs, prompts, or scoring.

**Ids and clock are derived, not random or wall-clock.** `trace_id` hashes the run id,
span ids come from a counter, and time advances by a fixed step plus any declared pause.
Two runs of the same configuration produce byte-identical traces, which is what makes
diffing and regression detection possible. The cost, stated plainly: durations describe
*simulated conversation time*, not real latency.

**The trace records the limits it ran under.** A verdict that depends on a constant must
travel with that constant — in the v1/v2 experiment the final appointment state is decided
by where the tool-call cap falls, and without `trace.limits` that finding is unverifiable
from its own artefact.

`max_turns` and `max_tool_calls` are **termination outcomes**, not errors. An agent
thrashing against a failing tool is a real production behaviour worth catching, not noise
to swallow.

### `lib/caller/` — the simulated patient

Split by responsibility: `director.ts` (beat sequencing), `scripted.ts` (deterministic
templates), `llm.ts` (a model for wording), `asr.ts` (transcription-fault injection). The Director is shared, so the two callers cannot disagree about *when* a
correction lands or *whether* a fact was disclosed.

Scenarios declare **beats** — state your goal, correct yourself here, reveal this only if
asked — and the Director fires them on schedule. A pure LLM patient is relentlessly
cooperative and non-reproducible; a pure scripted patient cannot react, so it cannot test
recovery. The hybrid *guarantees* the difficult behaviour and lets the model decide only
how it sounds.

**Hidden facts are withheld, not instructed away.** `hidden_facts` never enters the
caller's system prompt; a value reaches it only on the turn the Director discloses it.
Handed the full persona and told to withhold, a model eventually volunteers the answer —
and the ambiguity trap dies silently while every scenario still runs and reports.

`asr.ts` corrupts an utterance **between the caller and the agent**, so the caller is
unaware of it — the same isolation argument, applied to noise. The trace records both
`text` (what the agent received) and `text_intended` (what the caller said); without both,
ground truth is corrupted along with the input and the evaluator ends up comparing against
the very error it is meant to detect.

### `lib/agents/` — the system under test

Tool definitions are **derived from the World's own zod schemas** via `zodToJsonSchema`. A
hand-written second copy would drift, and the failure would be quiet: the model would be
told a tool takes arguments the World rejects, every call would return invalid, and the
run would read as an incompetent agent rather than a broken definition.

Malformed arguments and invented tool names pass through to the World, which returns a
usable error. Throwing in the adapter would destroy exactly the evidence this platform
exists to capture.

Agents are addressed by string spec — `stub:oracle`, `llm:v1` — so the runner, the
acceptance script and the UI cannot drift about what a version means.

### `lib/llm/` — provider adapter and replay cache

Plain `fetch`, no SDK: no version drift between what is committed and what a reviewer
installs, and the wire format stays visible.

**The cache is the determinism mechanism, not a cost optimisation.** Everything below it
is deterministic; a model ends that. Recording and replaying restores it.

Stated plainly: **temperature 0 is not a determinism guarantee.** Providers do not promise
identical outputs for identical inputs. Reproducibility here is a claim about *our
recorded runs*, never about the model.

Everything that can change a response is in the cache key — model, temperature, system
prompt, full history, tool definitions, seed — canonicalised with keys sorted at every
depth. Hashing only the newest message would let two conversations collide, and replay
would return a fluent response *from the wrong context*: worse than a crash, because
nothing about it looks wrong.

**A replay miss is a hard error.** If it fell through to a live call, "replay" would
silently become "live". The default mode is `replay`, because a missing `LLM_MODE` must
never mean "spend money".

### `lib/eval/` — the metrics

Three tiers, because the questions are different in kind:

| Tier | Asks | Evidence |
|---|---|---|
| **outcome** | did the work happen? | final world state |
| **process** | was it done safely and efficiently? | tool ordering, counts, timing |
| **judged** | did the agent mislead the patient? | transcript, via a model + human labels |

Outcome and process are not alternatives. The v1/v2 experiment produced a run whose
*final state was correct* while the agent wrote five times and abandoned the caller
mid-call — and the final state was correct only because of where an arbitrary cap fell. An
outcome-only evaluator returns a **random verdict** on that run, confidently.

Every failing metric carries `evidence_events`: the trace event ids the verdict rests on.
A message explains a verdict in prose; ids let a reviewer jump to the exact turns and
check the reasoning instead of trusting it. Enforced by test across every scenario, agent
and committed trace.

### `lib/server/` + `public/` — the inspector

Zero-dependency Node HTTP server and vanilla browser client. Reads the committed
artefacts; the "run" path is a convenience, not a prerequisite. Runs dashboard, trace
inspector with evidence highlighting and world-state diffs, v1-vs-v2 comparison, a
scenarios tab that explains what each scenario makes hard, and human verdict overrides
persisted to `reviews/`.

---

## 4. Cross-cutting design decisions

### Actor isolation is structural, not conventional

The caller's context type has no field that could carry a tool result, and the
orchestrator filters history before handing it over. A caller that saw tool results would
give the agent telepathy — it would "know" hidden facts without asking, every entity
metric would read perfect, and **nothing in the transcript would reveal it**.

Symmetrically, the caller never sees tool results. A real patient does not know the
booking API returned a 500; they only know the agent said "you're all set". That asymmetry
*is* the hallucinated-completion scenario.

### Scenarios are files, not database rows

Version-controlled next to the prompts they test, reviewed in a diff. There is no
scenario-authoring UI, deliberately: it would have cost hours and added nothing a reviewer
values. The database holds only what execution produces — traces, evaluations, labels.

Scenarios declare **intent, never dialogue**. A beat says `correct_medication`, not a
quoted line, so a scripted caller, an LLM caller or a future speech layer can all render
the same file without the dataset being rewritten.

### Ablations, because stacked traps mask each other

The headline scenario stacks three traps. If the agent trips the first, it never
meaningfully reaches the others, and the run reports a failure that says nothing about two
capabilities the agent may well have. Single-variable ablations (`rx-002-b`, `-c`, `-d`)
make a failure attributable rather than merely observed. This is the difference between an
integration test and a unit test, applied to evaluation data.

### The speech layer is out of scope, and named as such

There is no acoustic model anywhere: no VAD, endpointing, barge-in, packet loss or
latency. One *consequence* of transcription failure is simulated in text — a drug name
swapped for a documented sound-alike before the agent sees it, recording both what was said
and what was heard.

Browser speech playback and per-turn TTS were considered and **rejected**: the agent never
hears audio, so synthesising speech from a transcript we already have adds presentation
rather than measurement, and invites a claim of speech coverage this platform does not
have.

### Verifying the verifier

An evaluation platform can produce a confident, well-formed verdict while checking
nothing, and a passing test suite does not distinguish that from a working metric. Three
defenses:

1. **Startup registry guard** — every policy and declared expectation must resolve to a
   registered evaluator, or the process refuses to start.
2. **A metric never observed failing fails the suite** — across a corpus that deliberately
   contains careless and over-cautious agents. Exemptions are individual and justified.
3. **Per-metric discrimination fixtures** — every metric pinned to a run it must fail and
   one it must pass, the same contract the dataset already enforces for scenarios. 15 of 19
   are provable from this corpus; 4 are declared unprovable rather than assumed correct.

Verified by mutation in both directions: an evaluator stuck on "always fail" is as broken
as one stuck on "always pass".

**Limit:** the fixtures pin current behaviour, so they are a regression net rather than a
proof of correctness.

---

## 5. What is deliberately absent

| | Why |
|---|---|
| A database | 55 traces do not justify a schema and migrations, and committed JSON is readable in a diff |
| A frontend framework | The UI is a viewer over static artefacts |
| An LLM SDK | Plain `fetch` avoids version drift between what is committed and what is installed |
| A scenario editor | Scenarios are code, reviewed in a diff |
| Audio | See above — presentation, not measurement |

---

## 6. Extending it

```bash
# add scenarios/<id>.yaml   (filename must equal the id)
npm run validate            # rejects typos, dead hidden facts, unimplemented policies
LLM_MODE=live npm run eval -- --scenarios <id> --agents llm:v1
npm start                   # it appears, scored, with its trace committed
```

A new metric registers in `lib/eval/registry.ts` and needs a fixture pair
(`npm run fixtures`) — the registry guard and the discrimination test will both refuse a
metric that cannot be shown to do its job.
