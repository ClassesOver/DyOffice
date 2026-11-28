import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionCtx } from '../src/renderer/action-context'
import { saveRehearseTimings } from '../src/renderer/show-actions'
import { toggleScreenRecord } from '../src/renderer/insert-actions'

afterEach(() => {
  vi.unstubAllGlobals()
})

function context(setPendingRehearse: ReturnType<typeof vi.fn>, setDirty = vi.fn(), setStatus = vi.fn()) {
  return {
    pendingRehearse: [2, 0, 4],
    setPendingRehearse,
    setDirty,
    setStatus,
  } as unknown as ActionCtx
}

describe('saveRehearseTimings', () => {
  it('keeps failed timings and reports failure so the user can retry', async () => {
    const setPendingRehearse = vi.fn()
    const setDirty = vi.fn()
    const setStatus = vi.fn()
    const setAdvanceTimes = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', { slidesApi: { setAdvanceTimes } })
    const ctx = context(setPendingRehearse, setDirty, setStatus)

    await saveRehearseTimings(ctx)

    expect(setAdvanceTimes).toHaveBeenCalledWith({
      times: [
        { slideIndex: 0, ms: 2000 },
        { slideIndex: 2, ms: 4000 },
      ],
    })
    expect(setPendingRehearse).not.toHaveBeenCalled()
    expect(setDirty).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/save failed|保存失败/i))
  })

  it('keeps timings after an exception and clears them only after a successful retry', async () => {
    const setPendingRehearse = vi.fn()
    const setDirty = vi.fn()
    const setStatus = vi.fn()
    const setAdvanceTimes = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(true)
    vi.stubGlobal('window', { slidesApi: { setAdvanceTimes } })
    const ctx = context(setPendingRehearse, setDirty, setStatus)

    await saveRehearseTimings(ctx)
    expect(setPendingRehearse).not.toHaveBeenCalled()
    expect(setDirty).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith(expect.stringMatching(/save failed|保存失败/i))

    await saveRehearseTimings(ctx)
    expect(setAdvanceTimes).toHaveBeenCalledTimes(2)
    expect(setPendingRehearse).toHaveBeenCalledWith(null)
    expect(setDirty).toHaveBeenCalledWith(true)
  })
})

describe('screen recording', () => {
  class Recorder {
    static isTypeSupported() { return true }
    state = 'inactive'
    ondataavailable?: (event: { data: Blob }) => void
    onstop?: () => void
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; this.onstop?.() }
  }
  function captureContext() {
    return {
      slide: {partPath:'ppt/slides/slide1.xml'}, current:0, recorderRef:{current:null},
      setRecording:vi.fn(), setStatus:vi.fn(),
    } as unknown as ActionCtx
  }
  function fakeStream() {
    const track = {readyState:'live',getSettings:()=>({}),stop:vi.fn(),addEventListener:vi.fn()}
    return {track,stream:{getVideoTracks:()=>[track],getTracks:()=>[track]}}
  }

  it('releases a picker result that arrives after cancellation without starting recording',async()=>{
    const ctx=captureContext(),{track,stream}=fakeStream(),onActive=vi.fn()
    let picked!:(value:typeof stream)=>void
    const getDisplayMedia=vi.fn(()=>new Promise<typeof stream>(resolve=>{picked=resolve}))
    vi.stubGlobal('navigator',{mediaDevices:{getDisplayMedia}})
    vi.stubGlobal('MediaRecorder',Recorder)
    const pending=toggleScreenRecord(ctx,{onActive})
    await toggleScreenRecord(ctx,{onActive})
    ctx.recorderRef.current?.cancel()
    picked(stream)
    await pending
    expect(getDisplayMedia).toHaveBeenCalledOnce()
    expect(onActive.mock.calls).toEqual([[true],[false]])
    expect(ctx.setRecording).not.toHaveBeenCalledWith(true)
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('stops and releases an oversized capture without inserting a partial clip',async()=>{
    const ctx=captureContext(),{track,stream}=fakeStream(),onActive=vi.fn()
    let recorder:Recorder|undefined
    const addMediaBytes=vi.fn()
    vi.stubGlobal('window',{slidesApi:{addMediaBytes}})
    vi.stubGlobal('navigator',{mediaDevices:{getDisplayMedia:async()=>stream}})
    vi.stubGlobal('MediaRecorder',class extends Recorder { constructor(){super();recorder=this} })
    await toggleScreenRecord(ctx,{maxBytes:8,onActive})
    recorder?.ondataavailable?.({data:new Blob(['123456789'])})
    expect(recorder?.state).toBe('inactive')
    expect(track.stop).toHaveBeenCalled()
    expect(onActive.mock.calls).toEqual([[true],[false]])
    expect(ctx.recorderRef.current).toBeNull()
    expect(addMediaBytes).not.toHaveBeenCalled()
  })
})
