import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createCodingTaskRecovery } from '../../server/src/modules/coding/task-recovery.ts'

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function harness(renewResults) {
  let aborted = false, release
  const done = new Promise(resolve => { release = resolve })
  const turns = {
    async run(input) {
      input.signal.addEventListener('abort', () => { aborted = true; release() }, { once: true })
      await done
    },
    cancel: async () => false,
  }
  let renews = 0
  const store = {
    start: async () => {},
    renew: async () => { const next = renewResults[Math.min(renews++, renewResults.length - 1)]; if (next instanceof Error) throw next; return next },
    finish: async (_t, _d, _id, task) => task,
    cancel: async () => false,
  }
  const recovery = createCodingTaskRecovery(turns, async () => ({ deploymentId: 'd', userId: 'u', sessionId: 's' }), async () => ({ file: { revision: 'r' } }), store)
  const running = recovery.runner.run({ token: 't', turnId: 'turn-1', documentId: 'doc', modelId: 'm', request: { messages: [] } }, async () => {})
  return { running, release, aborted: () => aborted, renews: () => renews }
}

test('one failed lease renewal is retried instead of killing a healthy Harness task', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  try {
    const h = harness([new Error('connection reset'), true, true, true])
    await flush()
    for (let i = 0; i < 4; i++) { mock.timers.tick(10_000); await flush() }
    assert.equal(h.aborted(), false)
    assert.ok(h.renews() >= 3)
    h.release(); await h.running.catch(() => {})
  } finally { mock.timers.reset() }
})

test('renewals that keep failing stop the task before the 30 s lease can lapse unnoticed', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  try {
    const h = harness([new Error('db down')])
    await flush()
    mock.timers.tick(10_000); await flush()
    mock.timers.tick(10_000); await flush()
    assert.equal(h.aborted(), false)
    mock.timers.tick(10_000); await flush()
    assert.equal(h.aborted(), true)
    await h.running.catch(() => {})
  } finally { mock.timers.reset() }
})

test('a lost lease (renew returns false) still stops the task at once', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  try {
    const h = harness([false])
    await flush()
    mock.timers.tick(10_000); await flush()
    assert.equal(h.aborted(), true)
    await h.running.catch(() => {})
  } finally { mock.timers.reset() }
})

test('a stalled renewal cannot carry execution past the last confirmed lease', async()=>{
  const {maintainTaskLease}=await import('../../server/src/modules/tasks/lease.ts')
  mock.timers.enable({apis:['setInterval','setTimeout','Date']})
  try{
    const controller=new AbortController()
    let release, renewals=0
    const stop=maintainTaskLease(controller,5000,()=>{renewals++;return new Promise(resolve=>{release=resolve})})
    mock.timers.tick(5000);await flush()
    mock.timers.tick(19_999);await flush()
    assert.equal(controller.signal.aborted,false)
    mock.timers.tick(1);await flush()
    assert.equal(controller.signal.aborted,true)
    assert.equal(renewals,1)
    release(true);await stop()
  }finally{mock.timers.reset()}
})
