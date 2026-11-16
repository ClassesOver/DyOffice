# T14 command disposal minimal extraction

Candidate base: b66f2516. Extracts only the command transport and its regression tests from #90/e16e90b2, retaining its evidence document as historical context. No #87 native experiment, T13 provider chain, recovery UI, migration or production registration is included. The existing #95 provider turns implementation and tests, and all migration bytes, remain unchanged.

Fresh checks: command transport 13/13, all Web unit-directory tests 169/169, focused strict TypeScript exit0. Independent reviewer reran13/13 and found no definite scoped blocker. Historical #90/#87 numbers are not this candidate's results.

Regression check: running new tests against current-target old implementation observed failures in stalled CSRF disposal and stalled execution fetch. The old suite did not finish its stalled final case before the tool interruption; not a completed red-suite run. Restored final implementation before green tests and review. An initial snapshot assembly exceeded the shell argument-size limit; safe chunked writes replaced it before tests.

Local disposal settles waiting but cannot roll back sent server mutations or force an uncooperative callback to stop. No automatic retry or production mount. Browser acceptance remains deferred, not passed. Further #88 requires the recovery/abandonment backend and #87 remains a separate restricted-template experiment.

Ordinary Web serial suite also completed: 268 passed, 1 optional-S3 skip, 0 failures (54.3s). This does not exercise the native release artifact or browser GUI.
