# pod_forensics

An experimental tool. Agentic root cause analysis for Kubernetes failures, with
a reproducible eval harness.

Given a failing workload, an agent runs read-only diagnostic tools, forms a root
cause hypothesis in a reasoning loop, and emits a structured diagnosis. Every
diagnosis is scored against known ground truth across a fixed set of seeded
failures. The whole system runs against captured fixtures, so it is reproducible
and costs nothing to host.

## What this is and is not

This is a controlled demonstration of an agentic diagnosis loop and an eval
methodology over a finite, known failure taxonomy. It is not a production SRE
tool. Production tools already occupy that space, which is a signal that the
problem is real, not a reason to dress this up as a novel product. The value on
show is the reasoning loop, the eval rigor, and the systems hygiene, not the
breadth of coverage.

## Safety posture

- Read only. The tools are read-only equivalents of common kubectl reads. There
  is no mutation, no remediation, no apply or patch. Diagnosis only.
- Secrets are never read by value. The secret tool returns existence and key
  names only, so nothing sensitive lands in fixtures or traces.
- The deployed demo serves committed artifacts. It has no cluster access.

## How it fits together

The agent never talks to Kubernetes directly. It depends on a `ToolProvider`
interface that resolves tool calls to data, and it cannot tell which
implementation is behind it.

- `FixtureProvider` reads captured JSON. Used in eval and in the deployed demo.
- `LiveProvider` talks to a real cluster. Used in local development only.

This seam is what makes the eval reproducible, the demo free to host, and data
collection cleanly separated from agent logic.

## Status

Early skeleton. This commit lands the frozen contracts, the read-only tool
definitions, and the provider seam. The agent loop, the eval runner, the
scenarios, the fixtures, and the dashboard pages come in later quests.

## Layout

```
src/
  core/
    types.ts                 frozen contracts
    tools/                   read-only tool definitions, no execution
    providers/               the ToolProvider seam and its implementations
  scenarios/                 seeded failures as data (later)
  fixtures/                  captured tool output (later)
  app/                       dashboard shell (Next.js App Router)
reports/                     committed eval artifacts (later)
```

## Develop

```
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm dev         # dashboard shell
```

## Known limits

These are stated up front because a careful reader will find them.

- The taxonomy is finite and clean. Real incidents are messier, multi-cause, and
  ambiguous. This is a controlled demonstration, not a production tool.
- Eval scoring uses a model as a judge for root-cause prose, which introduces
  non-determinism into the eval itself. Runs are repeated N times and reported as
  a success rate, never a single pass or fail.
