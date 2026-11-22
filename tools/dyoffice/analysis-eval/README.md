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

## Native editor tool selection

Run `node tools/dyoffice/analysis-eval/editor-selection.mjs --check-catalog` to load the four renderer tool-definition arrays in an offline Chromium page. The measurement covers native tools from these arrays. Shared channel, source and attachment skills are outside this sample.

With `DYOFFICE_EVAL_BASE_URL` and the gateway's `DYOFFICE_EVAL_API_KEY` configured, run:

```sh
node tools/dyoffice/analysis-eval/editor-selection.mjs --model MODEL_ID --trials 3
```

The four synthetic prompts ask for a Word comment, scattered spreadsheet cells, slide style templates and a PDF text search. Each format also sends the same prompt once without tools. The report at `test-results/editor-selection/report.json` records the selected tool names, first-turn selection rate, and the difference between provider-reported input tokens with and without the tool definitions. This sample measures selection and input cost. It does not execute editor operations.

## DSH delegation and recovery

With a disposable PostgreSQL administrator connection in `DYOFFICE_TEST_DATABASE_URL`, build the Word renderer and shell and run the Word sample:

```sh
npm run build:web:docs && npm run build:web:shell
node tools/dyoffice/analysis-eval/dsh-recovery.mjs
```

The browser delegates to an external fixture process, resumes the parent conversation, recovers the delivery from history and inserts it. The test checks the saved document for the report and its hash, then reopens it. The JSON report records the outcome and any failed assertion. Use `--format xlsx|pptx|pdf` with the corresponding native test assets to select another format.
