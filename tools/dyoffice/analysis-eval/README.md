# Office analysis evaluation (real model)

Measures how often a real model completes multi-turn data-analysis tasks
end to end, instead of relying on one hand-run conversation.

What is real and what is not:

| Part | Used here |
|---|---|
| Model | Real, any OpenAI-compatible chat endpoint |
| Agent loop, source skill, insert skill, system prompts, tool schemas | Production code (`packages/agent-core`, `packages/browser-host`) |
| SQL policy, read-only role checks, row/byte limits, snapshots, truncation notices | Production code (`querySqlSource`, `snapshotFor`, `truncatedNotice`) |
| Database | Disposable PostgreSQL seeded by `seed.sql` (synthetic sales data, 24k orders) |
| Document | In-memory target that records what `insert_data_result` would insert |

Editor-native tools, the browser UI and the server's HTTP layer are not
exercised; the browser suites cover those. Every check compares the answer or
the inserted table against ground truth computed directly in PostgreSQL.

## Run

```bash
# 1. Disposable PostgreSQL 17 on 127.0.0.1:55432 (same as CI's test cluster)
createdb -h 127.0.0.1 -p 55432 -U postgres sales_eval
psql -h 127.0.0.1 -p 55432 -U postgres -d sales_eval -v ON_ERROR_STOP=1 -f tools/dyoffice/analysis-eval/seed.sql

# 2. Run the scenarios; the key may also come from an egress proxy
DYOFFICE_EVAL_BASE_URL=https://<gateway>/v1 DYOFFICE_EVAL_API_KEY=<key> \
  node --import tsx tools/dyoffice/analysis-eval/run.ts --model <model-id> --trials 3
```

Options: `--only <id,id>` selects scenarios, `--out <dir>` (default
`test-results/analysis-eval`) receives `report.md` and `report.json` with every
answer, SQL statement and failed check. Behind an HTTPS proxy, set
`NODE_USE_ENV_PROXY=1`. Gateway rate limits (429/502/503 before any output)
are retried with backoff and are not counted against the model.

## Scenarios

See `scenarios.ts`: table discovery plus quarterly totals (two turns), a
detail request that hits the row limit and must be re-asked as an aggregate,
inserting a channel summary into Word, a join ranking with a follow-up turn
that must keep the same definition, and monthly values written into Excel.

StarRocks is not covered: it needs a reachable StarRocks endpoint and a
read-only account; the harness only drives PostgreSQL today.
