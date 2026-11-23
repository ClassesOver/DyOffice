import test from 'node:test'
import assert from 'node:assert/strict'
import * as responses from '../../server/src/modules/providers/responses-stream.ts'

const signal = () => new AbortController().signal
const frame = event => 'data: ' + JSON.stringify(event) + '\n\n'
const done = (item, output_index) => ({type: 'response.output_item.done', output_index, item})
const terminal = response => ({type: 'response.' + response.status, response})
async function* bytes(body) { yield Buffer.from(body) }
const sse = (...events) => bytes(events.map(frame).join(''))
const collect = async (source, decode = responses.parseResponsesStream) => {
  const events = []
  for await (const event of decode(source, {signal: signal()})) events.push(event)
  return events
}
const reasoning = {type: 'reasoning', id: 'rs_1', encrypted_content: 'sealed', summary: []}
const tool = {type: 'function_call', id: 'fc_1', call_id: 'lookup', name: 'read_pages', arguments: '{"page":1}'}
const call = {type: 'tool_call', id: 'lookup', name: 'read_pages', input: {page: 1}}
const usage = {input_tokens: 7, output_tokens: 4}
const billed = {type: 'usage', inputTokens: 7, outputTokens: 4}

test('completed item events supply ordered tool calls and reasoning when the terminal omits or repeats output', async () => {
  const secondTool = {...tool, id: 'fc_2', call_id: 'next'}
  const items = [reasoning, tool, secondTool]
  for (const output of [undefined, [], items]) {
    const source = sse(
      {type: 'response.created'},
      {type: 'response.reasoning_summary_text.delta', delta: 'Checking pages'},
      ...items.map(item => done(item)),
      terminal({status: 'completed', output, usage}),
    )
    assert.deepEqual(await collect(source), [
      {type: 'reasoning', text: 'Checking pages'},
      {...call, signature: 'oai-rs:{"id":"rs_1","encrypted":"sealed"}'},
      {...call, id: 'next'},
      billed,
    ])
  }
})

test('output indices order calls and associate each encrypted reasoning item with its following call', async () => {
  const secondReasoning = {...reasoning, id: 'rs_2', encrypted_content: 'other'}
  const secondTool = {...tool, id: 'fc_2', call_id: 'second'}
  const source = sse(done(tool, 1), done(secondTool, 3), done(reasoning, 0), done(secondReasoning, 2),
    terminal({status: 'completed', output: []}))
  assert.deepEqual(await collect(source), [
    {...call, signature: 'oai-rs:{"id":"rs_1","encrypted":"sealed"}'},
    {...call, id: 'second', signature: 'oai-rs:{"id":"rs_2","encrypted":"other"}'},
  ])
})

test('optional item IDs in a terminal snapshot can be matched by the stable call ID', async () => {
  const {id: itemId, ...shortCall} = tool
  for (const completed of [[], [done(tool)]]) {
    const source = sse(
      {type: 'response.output_item.added', item: {...tool, arguments: ''}},
      {type: 'response.function_call_arguments.delta', item_id: itemId, delta: '{"page":1}'},
      ...completed, terminal({status: 'completed', output: [reasoning, shortCall]}),
    )
    assert.deepEqual(await collect(source), [{...call, signature: 'oai-rs:{"id":"rs_1","encrypted":"sealed"}'}])
  }
})

test('live text and refusals are reconciled with each message part independently', async () => {
  const first = {type: 'message', id: 'msg_a', content: [
    {type: 'output_text', text: 'Hello.'}, {type: 'refusal', refusal: 'I cannot do that.'},
    {type: 'output_text', text: ' Next.'},
  ]}
  const second = {type: 'message', id: 'msg_b', content: [{type: 'refusal', refusal: 'Another reason.'}]}
  const source = sse(
    {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello.'},
    {type: 'response.refusal.delta', item_id: 'msg_a', content_index: 1, delta: 'I cannot '},
    done(first, 0), done(second, 1), terminal({status: 'completed', output: [first, second], usage}),
  )
  assert.deepEqual(await collect(source), [
    {type: 'delta', text: 'Hello.'}, {type: 'delta', text: 'I cannot '}, {type: 'delta', text: 'do that.'},
    {type: 'delta', text: ' Next.'}, {type: 'delta', text: 'Another reason.'}, billed,
  ])
})

test('a delta from a different item cannot suppress matching terminal text', async () => {
  const other = {type: 'message', id: 'msg_b', content: [{type: 'output_text', text: 'Yes.'}]}
  const source = sse({type: 'response.output_text.delta', item_id: 'msg_a', delta: 'Yes.'},
    terminal({status: 'completed', output: [other]}))
  assert.deepEqual(await collect(source), [{type: 'delta', text: 'Yes.'}, {type: 'delta', text: 'Yes.'}])
})

test('empty terminal text leaves an already streamed part intact', async () => {
  const item = {type: 'message', id: 'msg_a', content: [{type: 'refusal', refusal: ''}]}
  const source = sse({type: 'response.refusal.delta', item_id: 'msg_a', delta: 'Declined.'},
    terminal({status: 'completed', output: [item]}))
  assert.deepEqual(await collect(source), [{type: 'delta', text: 'Declined.'}])
})

test('unindexed text and refusal deltas cover all matching parts of their own item', async () => {
  for (const [kind, field, type] of [['output_text', 'text', 'response.output_text.delta'], ['refusal', 'refusal', 'response.refusal.delta']]) {
    const item = {type: 'message', id: 'msg_a', content: [
      {type: kind, [field]: 'First.'}, {type: kind, [field]: 'Second.'},
    ]}
    const source = sse({type, item_id: 'msg_a', delta: 'First.'}, {type, item_id: 'msg_a', delta: 'Second.'},
      terminal({status: 'completed', output: [item]}))
    assert.deepEqual(await collect(source), [{type: 'delta', text: 'First.'}, {type: 'delta', text: 'Second.'}])
  }
})

test('a terminal part consumes both anonymous and addressed deltas in wire order', async () => {
  const item = {id: 'm1', type: 'message', content: [{type: 'output_text', text: 'First sentence.'}]}
  const delta = (text, address) => ({type: 'response.output_text.delta', delta: text, ...address})
  for (const locations of [[{}, {item_id: 'm1'}], [{item_id: 'm1', content_index: 0}, {}], [{output_index: 0}, {item_id: 'm1'}]]) {
    const source = sse(delta('First', locations[0]), delta(' sentence.', locations[1]), terminal({status: 'completed', output: [item]}))
    assert.deepEqual(await collect(source), [{type: 'delta', text: 'First'}, {type: 'delta', text: ' sentence.'}])
  }
})

test('a text.done event can finish deltas identified by either item ID or output index', async () => {
  const item = {id: 'm1', type: 'message', content: [{type: 'output_text', text: 'First sentence.'}]}
  const delta = address => ({type: 'response.output_text.delta', delta: 'First', ...address})
  const end = address => ({type: 'response.output_text.done', text: 'First sentence.', ...address})
  for (const [started, finished] of [
    [{item_id: 'm1', output_index: 0, content_index: 0}, {item_id: 'm1'}],
    [{item_id: 'm1'}, {output_index: 0, content_index: 0}],
    [{output_index: 0, content_index: 0}, {}],
  ]) {
    const source = sse({type: 'response.output_item.added', item, output_index: 0}, delta(started), end(finished),
      terminal({status: 'completed', output: [item]}))
    assert.deepEqual(await collect(source), [{type: 'delta', text: 'First'}, {type: 'delta', text: ' sentence.'}])
  }
})

test('refusal.done completes a partial or unstreamed refusal once, including compact terminal responses', async () => {
  const refusal = {type: 'refusal', refusal: 'Cannot do that.'}
  const item = {type: 'message', id: 'msg_a', content: [refusal]}
  const end = {type: 'response.refusal.done', item_id: 'msg_a', content_index: 0, refusal: refusal.refusal}
  for (const output of [[], [item]]) {
    assert.deepEqual(await collect(sse(end, terminal({status: 'completed', output}))), [{type: 'delta', text: 'Cannot do that.'}])
    const partial = {type: 'response.refusal.delta', item_id: 'msg_a', content_index: 0, delta: 'Cannot '}
    assert.deepEqual(await collect(sse(partial, end, terminal({status: 'completed', output}))), [
      {type: 'delta', text: 'Cannot '}, {type: 'delta', text: 'do that.'},
    ])
  }
})

test('sparse terminal items preserve completed reasoning, message text and function arguments', async () => {
  const thought = {...reasoning, summary: [{type: 'summary_text', text: 'Checked.'}]}
  const message = {type: 'message', id: 'msg_a', content: [{type: 'output_text', text: 'Looking it up.'}]}
  const output = [{...reasoning, encrypted_content: null, summary: []}, {...message, content: [{type: 'output_text', text: ''}]}, {...tool, arguments: ''}]
  const source = sse(done(thought), done(message), done(tool), terminal({status: 'completed', output}))
  assert.deepEqual(await collect(source), [
    {type: 'reasoning', text: 'Checked.'}, {type: 'delta', text: 'Looking it up.'},
    {...call, signature: 'oai-rs:{"id":"rs_1","encrypted":"sealed"}'},
  ])
})

test('a compact terminal array can echo one call at a different array offset', async () => {
  for (const indexed of [true, false]) {
    const source = sse(done(reasoning, indexed ? 0 : undefined), done(tool, indexed ? 1 : undefined),
      terminal({status: 'completed', output: [tool]}))
    assert.deepEqual(await collect(source), [{...call, signature: 'oai-rs:{"id":"rs_1","encrypted":"sealed"}'}])
  }
})

test('a refusal is streamed even before a terminal response arrives', async () => {
  const iterator = responses.parseResponsesStream(sse({type: 'response.refusal.delta', delta: 'Declined.'}), {signal: signal()})
  assert.deepEqual((await iterator.next()).value, {type: 'delta', text: 'Declined.'})
  await assert.rejects(() => iterator.next(), /Invalid Responses stream/)
})

test('gateway keepalives can surround complete newline-only data frames', async () => {
  const message = {type: 'message', content: [{type: 'output_text', text: 'Hello'}]}
  const body = ': heartbeat\n\ndata: ping\n' +
    [ {type: 'response.output_text.delta', delta: 'Hel'}, {type: 'response.output_text.delta', delta: 'lo'},
      done(message), terminal({status: 'completed'}) ].map(event => frame(event).trimEnd() + '\n').join('') +
    'data: ping\ndata: [DONE]\n'
  assert.deepEqual(await collect(bytes(body)), [{type: 'delta', text: 'Hel'}, {type: 'delta', text: 'lo'}])
})

test('max_output_tokens preserves available text and usage and discards every call, including malformed arguments', async () => {
  for (const status of ['incomplete', 'completed']) {
    const message = {type: 'message', content: [{type: 'output_text', text: 'Partial.'}]}
    const partial = {...tool, id: 'fc_2', call_id: 'partial', arguments: '{'}
    const source = sse(done(tool), done(partial), done(message), terminal({
      status, incomplete_details: {reason: 'max_output_tokens'}, usage,
    }))
    assert.deepEqual(await collect(source), [
      {type: 'delta', text: 'Partial.'}, {type: 'stop_reason', reason: 'max_tokens'}, billed,
    ])
  }
})

test('metadata, usage, and empty message parts alone cannot complete a turn', async () => {
  for (const output of [[], [{type: 'metadata'}], [reasoning], [{type: 'message', content: [{type: 'refusal', refusal: ''}]}]]) {
    const body = {status: 'completed', output, usage}
    await assert.rejects(() => collect(sse(terminal(body))), /Invalid Responses stream/)
    await assert.rejects(() => collect(bytes(JSON.stringify(body)), responses.parseResponsesJson), /Invalid Responses stream/)
  }
  assert.deepEqual(await collect(sse(terminal({status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}}))), [
    {type: 'stop_reason', reason: 'max_tokens'},
  ])
})

test('failed, missing or malformed completion never releases a buffered tool batch', async () => {
  const prefix = frame(done(tool, 0))
  const completed = frame(terminal({status: 'completed', output: []}))
  const invalid = [
    '', 'data: [DONE]\n\n', 'data: {broken\n\n' + completed,
    frame(terminal({status: 'failed', error: {message: 'private'}})),
    frame(terminal({status: 'incomplete', incomplete_details: {reason: 'content_filter'}})),
    frame({type: 'response.completed', response: {status: 'in_progress', output: []}}),
    frame({type: 'response.completed', response: {status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}}}),
    frame({type: 'response.incomplete', response: {status: 'completed', output: [tool]}}),
    frame(terminal({status: 'completed', output: [tool], error: {message: 'private'}})),
    frame(terminal({status: 'completed', output: [tool], usage: {input_tokens: -1}})),
    frame(done({...tool, id: 'fc_2', call_id: 'second', arguments: '[]'}, 1)) + completed,
    frame(done({...tool, id: 'fc_2'}, 1)) + completed,
    frame({type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 42}) + completed,
    frame({type: 'response.output_item.added', item: {...tool, id: 'fc_2', call_id: 'unfinished', arguments: ''}}) + completed,
    frame(done({...tool, id: 'fc_2', call_id: 'second', status: 'in_progress'}, 1)) + completed,
    frame(terminal({status: 'completed', output: [{...tool, name: 'write_pages'}]})),
    completed + frame(terminal({status: 'failed'})),
  ]
  const disconnected = (async function* () { yield Buffer.from(prefix + completed); throw Error('socket lost') })()
  for (const source of [...invalid.map(tail => bytes(prefix + tail)), disconnected]) {
    const events = []
    await assert.rejects(async () => {
      for await (const event of responses.parseResponsesStream(source, {signal: signal()})) events.push(event)
    }, /^Error: Invalid Responses stream$/)
    assert.deepEqual(events, [])
  }
})

test('invalid UTF-8 cannot be silently substituted into executable tool arguments', async () => {
  const body = frame(terminal({status: 'completed', output: [{...tool, arguments: '{"value":"X"}'}]}))
  const wire = Buffer.from(body)
  wire[wire.indexOf('X')] = 0xff
  await assert.rejects(() => collect(bytes(wire)), /Invalid Responses stream/)
})

test('tool count and cancellation apply to completed items as well as terminal snapshots', async () => {
  const all = Array.from({length: 65}, (_, index) => done({...tool, id: 'fc_' + index, call_id: 'call_' + index}))
  await assert.rejects(() => collect(sse(...all, terminal({status: 'completed', output: []}))), /Invalid Responses stream/)

  const control = new AbortController()
  const iterator = responses.parseResponsesStream(sse(terminal({status: 'completed', output: [tool], usage})), {signal: control.signal})
  assert.deepEqual((await iterator.next()).value, call)
  control.abort()
  await assert.rejects(() => iterator.next(), /Invalid Responses stream/)
})

test('a complete JSON response uses the same text, refusal, reasoning, tool and usage semantics', async () => {
  const message = {type: 'message', content: [{type: 'refusal', refusal: 'Declined.'}]}
  const body = {object: 'response', status: 'completed', output: [
    {...reasoning, summary: [{type: 'summary_text', text: 'Checked.'}]}, message, tool,
  ], usage}
  const expected = [
    {type: 'reasoning', text: 'Checked.'}, {type: 'delta', text: 'Declined.'},
    {...call, signature: 'oai-rs:{"id":"rs_1","encrypted":"sealed"}'}, billed,
  ]
  assert.deepEqual(await collect(sse(terminal(body))), expected)
  assert.equal(typeof responses.parseResponsesJson, 'function')
  assert.deepEqual(await collect(bytes(JSON.stringify(body)), responses.parseResponsesJson), expected)
  assert.deepEqual(await collect(bytes(JSON.stringify({...body, status: 'incomplete', incomplete_details: {reason: 'max_output_tokens'}})), responses.parseResponsesJson), [
    ...expected.slice(0, 2), {type: 'stop_reason', reason: 'max_tokens'}, billed,
  ])
})

test('bounded JSON is validated through clean EOF before any tool or text is exposed', async () => {
  assert.equal(typeof responses.parseResponsesJson, 'function')
  const okay = JSON.stringify({status: 'completed', output: [tool]})
  const failed = JSON.stringify({status: 'failed', output: [tool]})
  const disconnected = (async function* () { yield Buffer.from(okay); throw Error('socket lost') })()
  const malformedUtf8 = (async function* () {
    yield Buffer.from(okay.slice(0, -1) + ',"x":"'); yield Uint8Array.of(0xff); yield Buffer.from('"}')
  })()
  for (const source of [bytes(failed), bytes(okay + '{}'), bytes(okay.slice(0, -1)),
    bytes(okay.padEnd(4 * 1024 * 1024 + 1)), disconnected, malformedUtf8]) {
    const events = []
    await assert.rejects(async () => {
      for await (const event of responses.parseResponsesJson(source, {signal: signal()})) events.push(event)
    }, /^Error: Invalid Responses stream$/)
    assert.deepEqual(events, [])
  }
})
