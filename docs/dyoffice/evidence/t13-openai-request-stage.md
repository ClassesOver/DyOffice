# T13 strict OpenAI request builder (unmounted stage)

This is only a pure wire-body builder. It does not authorize, reserve budget, resolve
credentials, send requests, approve tools or execute tool calls. Server orchestration
must derive the configured model and output cap from trusted configuration, construct
this body once, then bind its exact bytes/digest to the durable reservation and pinned
transport. Do not hash a logical request and transform it again before dispatch.

## Accepted subset
- system text is exclusively request.system. History accepts text user/assistant
  messages and complete assistant tool-call / tool-result batches.
- Tools are name, description and an object containing plain JSON Schema data.
  This builder does not compile, approve or semantically validate tool schemas;
  the trusted registry must do that separately. Names are unique ASCII
  function identifiers (1..64); call IDs are unique across history (1..128).
- Every call names a declared tool and has plain JSON-object arguments. The next
  message must contain exactly the outstanding result batch, matching both IDs and
  tool names. No unmatched result, reused ID, missing result or intervening message.
- OpenAI tool messages have no native isError field. The builder deliberately maps
  each result to compact JSON content {output,isError?}; false is preserved when
  explicitly supplied. The redundant result name is checked against the call rather
  than sent as a nonstandard tool-message field.
- Images, reasoning (including opaque vendor thinking), signatures, inputError,
  truncated and other unsupported fields are rejected, not silently removed. Even
  explicit empty unsupported fields are outside this subset. Models requiring
  interleaved reasoning/signatures must use a separately reviewed adapter.
- Nested schema/arguments accept only bounded plain JSON data, with deterministic
  key ordering. Nonfinite numbers, undefined, bigint, functions, symbols, cycles,
  accessors, dangerous object keys and malformed Unicode are rejected.

## Fixed wire choices and limits
The only profile fields are trusted model and maxOutputTokens. The payload uses
model, max_tokens, stream:true and stream_options.include_usage:true. No caller
routing, Authorization, headers or provider options can override them. Output cap
is a positive integer no greater than 32768; this is a conservative protocol limit,
not a token count or vendor price guarantee. Histories have at most 512 messages,
tools/calls at most 64, text fields at most 256KiB and the final body at most 1MiB.
Nested data has bounded depth/node count and per-object serialized size.

Returned metadata is frozen, but Buffer cannot be made immutable with Object.freeze.
The pipeline must retain its own private byte snapshot and never return/reconstruct
it before dispatch. The transport must copy and recompute SHA256 before any DNS or
network work; changed bytes must reject. This builder detaches all source values.

## Verification
RED: the initial 9 test groups failed before implementation because the builder
export did not exist (builder-red.log). GREEN: all 11 test groups passed after
implementation, including two additional boundary groups (builder-green.log;
11 passed, 0 failed). Targeted TypeScript strict checking of openai-request.ts
passed with no diagnostics (builder-types.log). Tests do not access PostgreSQL
or any network. This is not full-repository or real-provider acceptance.
