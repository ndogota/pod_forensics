# fixtures

Captured read-only tool output, committed so eval and the deployed demo are
reproducible and need no live cluster. One directory per scenario:

```
<scenario-id>/
  <tool>-<argshash>.json
```

Each file holds the structured tool output and a capture timestamp. The argshash
is a stable short hash of the tool call arguments, computed by the
FixtureProvider so a call resolves to exactly one file.

Empty for now. Fixtures are produced by the offline capture harness in a later
quest. Because get_secret_meta returns key names only, no secret values ever
land here.
