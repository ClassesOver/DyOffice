import { Readable } from 'node:stream'
import {
  isPlainObject, MAX_RESPONSE_BODY_BYTES, MAX_TOOL_JSON_CHARS, sseDataEvents,
} from '../../../../../../packages/ai-provider/src/protocols/shared.ts'
import { reasoningSignature } from '../../../../../../packages/ai-provider/src/protocols/openai-responses.ts'
import type { TurnEvent } from './turns.ts'

type ObjectValue = Record<string, unknown>
type PartKind = 'output_text' | 'refusal' | 'summary_text'
interface TextDelta {
  kind: PartKind; text: string; itemId?: string; outputIndex?: number; partIndex?: number
}
interface StreamOutput {
  items: { index?: number; item: unknown }[]
  deltas: TextDelta[]
  startedCalls: Set<string | number>
}
const invalid = () => new Error('Invalid Responses stream')
const utf8 = () => new TextDecoder('utf-8', {fatal: true})
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const emptyOutput = (): StreamOutput => ({items: [], deltas: [], startedCalls: new Set()})

function position(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid()
  return value
}

function textPart(event: ObjectValue, kind: PartKind, text: unknown): TextDelta {
  const {item_id} = event
  if (typeof text !== 'string' || (item_id !== undefined && typeof item_id !== 'string')) throw invalid()
  return {
    kind, text, itemId: item_id, outputIndex: position(event.output_index),
    partIndex: position(kind === 'summary_text' ? event.summary_index : event.content_index),
  }
}

function mergeItem(final: ObjectValue, done: ObjectValue): ObjectValue {
  if (final.type !== done.type || (final.id !== undefined && done.id !== undefined && final.id !== done.id)) throw invalid()
  const item = {...done, ...final}
  if (item.type === 'function_call') {
    for (const field of ['call_id', 'name', 'arguments']) {
      if (final[field] == null || final[field] === '') item[field] = done[field]
      else if (done[field] && done[field] !== final[field]) throw invalid()
    }
  } else if (item.type === 'message' || item.type === 'reasoning') {
    if (!item.encrypted_content) item.encrypted_content = done.encrypted_content
    const field = item.type === 'message' ? 'content' : 'summary'
    const earlier = done[field], later = final[field]
    if (Array.isArray(earlier) && (later == null || Array.isArray(later))) {
      const parts = [...earlier]
      for (const [index, part] of (later ?? []).entries()) {
        const previous = earlier[index]
        const key = part?.type === 'refusal' ? 'refusal' : 'text'
        parts[index] = isPlainObject(part) && isPlainObject(previous) && part.type === previous.type &&
          (part[key] == null || part[key] === '') ? {...part, [key]: previous[key]} : part
      }
      item[field] = parts
    }
  }
  return item
}

// Explicit stream indices locate repeated items even when a terminal array is compact.
function completedItems(output: unknown[], done: StreamOutput['items'], cut: boolean) {
  const items = new Map<number, ObjectValue>()
  const indices = new Map<string, number>()
  const callIndices = new Map<string, number>()
  // The terminal can also echo only a subsequence of unindexed done items. In
  // that case their encounter order supplies positions for the compact array.
  let matched = 0
  for (const {item} of done) {
    const echoed = output[matched]
    if (isPlainObject(item) && isPlainObject(echoed) && item.type === echoed.type &&
        ((typeof item.id === 'string' && item.id === echoed.id) ||
         (item.type === 'function_call' && typeof item.call_id === 'string' && item.call_id === echoed.call_id))) matched++
  }
  const compact = output.length > 0 && output.length < done.length && matched === output.length
  for (const [ordinal, entry] of done.entries()) {
    const {item} = entry, index = entry.index ?? (compact ? ordinal : undefined)
    if (index === undefined || !isPlainObject(item)) continue
    if (typeof item.id === 'string') indices.set(item.id, index)
    if (item.type === 'function_call' && typeof item.call_id === 'string') callIndices.set(item.call_id, index)
  }
  function add(raw: unknown, explicit: number | undefined, fallback: number, terminal = false) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') throw invalid()
    if (cut && raw.type === 'function_call') return
    if (raw.id !== undefined && typeof raw.id !== 'string') throw invalid()
    const known = raw.id === undefined ? undefined : indices.get(raw.id)
    const callId = raw.type === 'function_call' && typeof raw.call_id === 'string' ? raw.call_id : undefined
    const callIndex = callId === undefined ? undefined : callIndices.get(callId)
    const index = explicit ?? known ?? callIndex ?? fallback
    if ((known !== undefined && known !== index) || (callIndex !== undefined && callIndex !== index)) throw invalid()
    if (raw.id !== undefined) indices.set(raw.id, index)
    if (callId !== undefined) callIndices.set(callId, index)
    if (raw.type === 'function_call' && raw.status !== undefined && raw.status !== 'completed') throw invalid()
    const before = items.get(index)
    if (terminal && before) throw invalid()
    items.set(index, before ? mergeItem(before, raw) : raw)
  }
  output.forEach((item, index) => add(item, undefined, index, true))
  done.forEach(({item, index}, ordinal) => add(item, index, ordinal))
  return {items: [...items].sort(([a], [b]) => a - b), indices}
}

interface TextFragment extends TextDelta { sequence: number }

function textPrefixes(indices = new Map<string, number>()) {
  const ids = new Map([...indices].map(([id, index]) => [index, id]))
  type Item = string | number | undefined
  const groups = new Map<PartKind, Map<Item, Map<number | undefined, Set<TextFragment>>>>()
  let sequence = 0
  function locate(id?: string, index?: number) {
    if (id === undefined || index === undefined) return
    if ((indices.has(id) && indices.get(id) !== index) || (ids.has(index) && ids.get(index) !== id)) throw invalid()
    indices.set(id, index)
    ids.set(index, id)
  }
  return {
    locate,
    add(delta: TextDelta) {
      if (!delta.text) return
      locate(delta.itemId, delta.outputIndex)
      const byItem = groups.get(delta.kind) ?? new Map<Item, Map<number | undefined, Set<TextFragment>>>()
      groups.set(delta.kind, byItem)
      const item = delta.outputIndex ?? delta.itemId
      const byPart = byItem.get(item) ?? new Map<number | undefined, Set<TextFragment>>()
      byItem.set(item, byPart)
      const fragments = byPart.get(delta.partIndex) ?? new Set<TextFragment>()
      byPart.set(delta.partIndex, fragments)
      fragments.add({...delta, sequence: sequence++})
    },
    remaining(part: TextDelta) {
      locate(part.itemId, part.outputIndex)
      const byItem = groups.get(part.kind)
      if (!part.text || !byItem) return part.text
      const index = part.outputIndex ?? (part.itemId === undefined ? undefined : indices.get(part.itemId))
      const id = part.itemId ?? (index === undefined ? undefined : ids.get(index))
      const items = index === undefined && id === undefined ? byItem.keys() : new Set<Item>([index, id, undefined])
      const queues: {group: Set<TextFragment>; iterator: SetIterator<TextFragment>; first: TextFragment}[] = []
      for (const item of items) {
        const byPart = byItem.get(item)
        if (!byPart) continue
        const slots = part.partIndex === undefined ? byPart.keys() : [part.partIndex, undefined]
        for (const slot of slots) {
          const group = byPart.get(slot)
          if (!group?.size) continue
          const iterator = group.values()
          queues.push({group, iterator, first: iterator.next().value!})
        }
      }
      // Fragments of a single part can alternate between explicit and missing
      // locators. Read the compatible queues in their original wire order.
      let offset = 0
      while (queues.length && offset < part.text.length) {
        const queue = queues.reduce((a, b) => a.first.sequence < b.first.sequence ? a : b)
        const fragment = queue.first
        if (part.text.startsWith(fragment.text, offset)) {
          offset += fragment.text.length
          queue.group.delete(fragment)
        } else if (fragment.text.startsWith(part.text.slice(offset))) {
          fragment.text = fragment.text.slice(part.text.length - offset)
          return ''
        } else if (fragment.partIndex !== undefined && part.partIndex !== undefined &&
                   (fragment.outputIndex !== undefined || fragment.itemId !== undefined) &&
                   (index !== undefined || id !== undefined)) throw invalid()
        const next = queue.iterator.next()
        if (next.done) queues.splice(queues.indexOf(queue), 1)
        else queue.first = next.value
      }
      return part.text.slice(offset)
    }
  }
}

function usageEvent(value: unknown): TurnEvent | undefined {
  if (value == null) return undefined
  if (!isPlainObject(value)) throw invalid()
  const usage: Extract<TurnEvent, {type:'usage'}> = {type: 'usage'}
  for (const [field, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
    const count = value[field]
    if (count === undefined) continue
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw invalid()
    usage[target] = count
  }
  return usage
}

/** Build and validate the entire tool batch before the caller can observe any candidate. */
function finishResponse(response: unknown, stream: StreamOutput, expectedStatus?: string): TurnEvent[] {
  if (!isPlainObject(response) || response.error != null ||
      (response.object !== undefined && response.object !== 'response') ||
      (expectedStatus !== undefined && response.status !== expectedStatus) ||
      (response.status !== 'completed' && response.status !== 'incomplete')) throw invalid()
  const cut = isPlainObject(response.incomplete_details) && response.incomplete_details.reason === 'max_output_tokens'
  if (!cut && (response.status === 'incomplete' || response.incomplete_details != null)) throw invalid()
  const {output} = response
  if (output !== undefined && !Array.isArray(output)) throw invalid()
  const {items, indices} = completedItems(output ?? [], stream.items, cut)
  const streamedText = textPrefixes(indices)
  for (const delta of stream.deltas) streamedText.add(delta)
  const events: TurnEvent[] = []
  const ids = new Set<string>()
  let signature: string | undefined
  for (const [index, item] of items) {
    if (item.type === 'function_call') {
      const {call_id: id, name, arguments: args} = item
      if (!identifier(id) || !identifier(name) || ids.has(id) || ids.size >= 64 ||
          typeof args !== 'string' || args.length > MAX_TOOL_JSON_CHARS) throw invalid()
      const input: unknown = JSON.parse(args)
      if (!isPlainObject(input)) throw invalid()
      ids.add(id)
      stream.startedCalls.delete(index)
      stream.startedCalls.delete('call:' + id)
      if (typeof item.id === 'string') stream.startedCalls.delete('item:' + item.id)
      events.push({type: 'tool_call', id, name, input, ...(signature ? {signature} : {})})
      signature = undefined
      continue
    }
    if (item.type !== 'reasoning' && item.type !== 'message') continue
    if (item.type === 'reasoning' && typeof item.id === 'string' && typeof item.encrypted_content === 'string') {
      signature = reasoningSignature(item.id, item.encrypted_content)
    }
    const parts = item.type === 'reasoning' ? item.summary ?? [] : item.content
    if (!Array.isArray(parts)) throw invalid()
    for (const [partIndex, part] of parts.entries()) {
      if (!isPlainObject(part)) throw invalid()
      const kind = part.type
      if (kind !== 'summary_text' && kind !== 'output_text' && kind !== 'refusal') continue
      const full = kind === 'refusal' ? part.refusal : part.text
      if (typeof full !== 'string') throw invalid()
      const text = streamedText.remaining({outputIndex: index, itemId: typeof item.id === 'string' ? item.id : undefined, kind, partIndex, text: full})
      if (text) events.push({type: kind === 'summary_text' ? 'reasoning' : 'delta', text})
    }
  }
  if (!cut && stream.startedCalls.size) throw invalid()
  if (cut) events.push({type: 'stop_reason', reason: 'max_tokens'})
  if (!stream.deltas.length && !events.length) throw invalid()
  const usage = usageEvent(response.usage)
  if (usage) events.push(usage)
  return events
}

function* deliver(events: TurnEvent[], signal: AbortSignal) {
  for (const event of events) {
    signal.throwIfAborted()
    yield event
  }
  signal.throwIfAborted()
}

export async function* parseResponsesStream(source: AsyncIterable<Uint8Array>, {signal}: {signal: AbortSignal}): AsyncGenerator<TurnEvent> {
  if (signal.aborted) throw invalid()
  const body = Readable.from(source, {signal})
  const stream = emptyOutput()
  const callIds = new Map<string, string>()
  const live = textPrefixes()
  let terminal: TurnEvent[] | undefined
  try {
    for await (const frame of sseDataEvents(Readable.toWeb(body) as ReadableStream<Uint8Array>, undefined, utf8())) {
      signal.throwIfAborted()
      if (frame.raw === 'ping') continue
      if (frame.raw === '[DONE]' && terminal) continue
      const event = frame.json
      if (!isPlainObject(event) || typeof event.type !== 'string' || event.error != null || terminal) throw invalid()
      if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') &&
          isPlainObject(event.item) && typeof event.item.id === 'string') {
        live.locate(event.item.id, position(event.output_index))
      }
      switch (event.type) {
        case 'error':
        case 'response.failed':
          throw invalid()
        case 'response.output_text.delta':
        case 'response.output_text.done':
        case 'response.refusal.delta':
        case 'response.refusal.done':
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_summary_text.done': {
          const kind = event.type.startsWith('response.output_text.') ? 'output_text' :
            event.type.startsWith('response.refusal.') ? 'refusal' : 'summary_text'
          const done = event.type.endsWith('.done')
          const part = textPart(event, kind, done ? (kind === 'refusal' ? event.refusal : event.text) : event.delta)
          const text = done ? live.remaining(part) : part.text
          if (!done) live.add(part)
          if (text) {
            stream.deltas.push({...part, text})
            yield {type: kind === 'summary_text' ? 'reasoning' : 'delta', text}
          }
          break
        }
        case 'response.output_item.added':
        case 'response.function_call_arguments.delta': {
          const item = event.item
          if (event.type === 'response.function_call_arguments.delta' && typeof event.delta !== 'string') throw invalid()
          if (event.type === 'response.output_item.added' && (!isPlainObject(item) || item.type !== 'function_call')) break
          const index = position(event.output_index)
          const id = event.item_id ?? (isPlainObject(item) ? item.id : undefined)
          const callId = isPlainObject(item) ? item.call_id : typeof id === 'string' ? callIds.get(id) : undefined
          if (typeof id === 'string' && typeof callId === 'string') callIds.set(id, callId)
          if (index !== undefined) stream.startedCalls.add(index)
          else if (typeof callId === 'string') stream.startedCalls.add('call:' + callId)
          else if (typeof id === 'string') stream.startedCalls.add('item:' + id)
          break
        }
        case 'response.output_item.done':
          stream.items.push({index: position(event.output_index), item: event.item})
          break
        case 'response.completed':
        case 'response.incomplete':
          terminal = finishResponse(event.response, stream, event.type.slice('response.'.length))
          break
      }
    }
    if (!terminal) throw invalid()
    yield* deliver(terminal, signal)
  } catch { throw invalid() }
  finally { body.destroy() }
}

export async function* parseResponsesJson(source: AsyncIterable<Uint8Array>, {signal}: {signal: AbortSignal}): AsyncGenerator<TurnEvent> {
  if (signal.aborted) throw invalid()
  const body = Readable.from(source, {signal})
  const decoder = utf8()
  let bytes = 0, text = ''
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) throw invalid()
      bytes += chunk.byteLength
      if (bytes > MAX_RESPONSE_BODY_BYTES) throw invalid()
      text += decoder.decode(chunk, {stream: true})
    }
    const response: unknown = JSON.parse(text + decoder.decode())
    if (!isPlainObject(response) || !Array.isArray(response.output)) throw invalid()
    yield* deliver(finishResponse(response, emptyOutput()), signal)
  } catch { throw invalid() }
  finally { body.destroy() }
}
