# Deploy

The dashboard is a static read of committed eval artifacts. It runs no server,
talks to no cluster, and needs no API key at runtime. Everything it shows is
baked into HTML at build time.

## The showcase artifact

`reports/model-matrix.json` is the headline artifact. It holds one cell per
(model, scenario) pair: symptom and cause accuracy, completion rate, and
evidence recall, each with a Wilson 95% confidence interval over the cell's N
runs, plus the root-cause judge mean and per-model cost. The dashboard renders
it as the model-by-scenario matrix.

Regenerate it with:

```
pnpm matrix                 # default model pair, all scenarios
pnpm matrix --runs 4        # fewer runs per cell
pnpm matrix --opus          # add Opus to the pair
```

`pnpm matrix` runs real models, so it needs `ANTHROPIC_API_KEY` and captured
fixtures for every scenario. It is the only step that costs money or needs
network. Once it writes `reports/model-matrix.json`, commit that file; the
deployed dashboard is a static read of it.

`reports/run-report.json` is a secondary, single-model view. It is produced by
`pnpm eval` with the deterministic fake client, so it is reproducible and needs
no cluster or key. The dashboard shows it below the matrix as one concrete run
per scenario, so a reader can see the tool-call sequence and the structured
diagnosis, not just the aggregate.

If `reports/model-matrix.json` is absent or has no cells, the page still builds
and renders a "reference run not yet generated" placeholder. The build never
fails on a missing artifact.

## Build

```
pnpm install
pnpm build          # next build -> static export in out/
```

`next.config.mjs` sets `output: "export"`, so `pnpm build` writes a fully static
site to `out/`. The reports are read once, at build time, and their data is
inlined into the generated HTML. JetBrains Mono is self-hosted by `next/font`,
so the deployed page makes no external font request.

## Vercel

The repo deploys to Vercel with zero configuration.

- Framework preset: Next.js (auto-detected)
- Build command: `pnpm build` (or `next build`, the default)
- Install command: `pnpm install`
- Output: static, served from `out/`

No environment variables are required at build or runtime. The committed
`reports/model-matrix.json` is what the deployed page shows; to update the live
showcase, regenerate it with `pnpm matrix`, commit, and push.

## Run locally

```
pnpm dev            # dev server at http://localhost:3000
```

To preview the exact static output that Vercel serves:

```
pnpm build
npx serve out       # or any static file server pointed at out/
```
