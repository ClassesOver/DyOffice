/**
 * Rendering layer for animation playback — shared by the show view and the edit-area "Preview".
 *
 * - useAnimPlayer: holds the playback cursor (steps played + current step's rAF progress) and
 *   outputs each node's NodeAnimState; advance() moves one step (if playing, completes the
 *   current step immediately).
 * - AnimatedSlideStage: static whole-page rendering same as SlideThumb, but each node is wrapped
 *   in a Konva Group driven by NodeAnimState (opacity/scale/rotation/offset/wipe clip,
 *   transformed around the node center).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Stage, Layer, Rect, Group } from 'react-konva'
import type Konva from 'konva'
import type { Context } from 'konva/lib/Context'
import type { RenderNode, RenderSlide } from '@genoffice/pptx-render'
import type { AnimationItem } from '../../shared/ipc'
import {
  buildSteps,
  computeMediaCommands,
  computeNodeStates,
  type AnimStep,
  type MediaCommand,
  type NodeAnimState,
} from '../animation-play'
import { useI18n } from '../i18n/locale'
import { fillToKonva } from '../konva-adapter'
import { StaticNode } from '../NodeBody'
import { animatedNodeLayout, groupParagraphStates } from '../animated-node-layout'

export interface AnimPlayer {
  /** animStateKey (sourceId or sourceId+paragraph index) → current visual state (targets without animation aren't in the Map) */
  states: Map<string, NodeAnimState>
  /** Media commands (play/pause/stop) reached so far on this page, in fire order; the media layer applies the tail it has not seen */
  mediaCmds: MediaCommand[]
  /** How many of mediaCmds the last load/seek treated as already fired (landing on a played state must not replay them) */
  mediaBase: number
  /** Whether the current step is playing */
  playing: boolean
  /** Whether there are steps left to play */
  pending: boolean
  /** Number of steps played (broadcast by the presenter to the audience window) */
  played: number
  /** Generation number of load/seek: incremented after a page loads; broadcasters use it to tell "the new page is in place" */
  epoch: number
  /** Advance: playing → complete the current step immediately; otherwise play the next step. Returns false when nothing to play */
  advance: () => boolean
  /** Load a page's animations; 'fresh' = initial state (auto steps auto-play), 'all' = everything-played state */
  load: (items: AnimationItem[], mode: 'fresh' | 'all') => void
  /**
   * Jump to an absolute cursor (audience window mirroring the presenter); playing=true plays the
   * current step pointed by played from its start. media: 'keep' = same page, commands reached
   * since the last seek still fire; 'fresh' = new page entered forward, everything fires as reached;
   * 'all' = landed on a played state, nothing fires.
   */
  seek: (
    items: AnimationItem[],
    played: number,
    playing: boolean,
    media?: 'keep' | 'fresh' | 'all',
  ) => void
}

export function useAnimPlayer(canvasHpx: number, canvasWpx?: number): AnimPlayer {
  const [state, setState] = useState<{
    steps: AnimStep[]
    played: number
    startedAt: number | null
    epoch: number
    mediaBase: number
  }>({ steps: [], played: 0, startedAt: null, epoch: 0, mediaBase: 0 })
  const [elapsed, setElapsed] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state

  // rAF drives the current step's progress; when finished, stops at step end automatically (awaiting the next trigger)
  useEffect(() => {
    if (state.startedAt == null) return
    let raf = 0
    const tick = () => {
      const t = performance.now() - state.startedAt!
      const total = state.steps[state.played]?.totalMs ?? 0
      if (t >= total) {
        setState((s) => ({ ...s, played: s.played + 1, startedAt: null }))
      } else {
        setElapsed(t)
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state])

  const load = useCallback((items: AnimationItem[], mode: 'fresh' | 'all') => {
    const steps = buildSteps(items)
    setElapsed(0)
    setState((s) =>
      mode === 'all'
        ? {
            steps,
            played: steps.length,
            startedAt: null,
            epoch: s.epoch + 1,
            mediaBase: computeMediaCommands(steps, steps.length, null).length,
          }
        : {
            steps,
            played: 0,
            startedAt: steps[0]?.auto ? performance.now() : null,
            epoch: s.epoch + 1,
            mediaBase: 0,
          },
    )
  }, [])

  const seek = useCallback(
    (
      items: AnimationItem[],
      played: number,
      playing: boolean,
      media: 'keep' | 'fresh' | 'all' = 'all',
    ) => {
      const steps = buildSteps(items)
      setElapsed(0)
      setState((s) => {
        const p = Math.max(0, Math.min(played, steps.length))
        return {
          steps,
          played: p,
          startedAt: playing && p < steps.length ? performance.now() : null,
          epoch: s.epoch + 1,
          mediaBase:
            media === 'keep'
              ? s.mediaBase
              : media === 'fresh'
                ? 0
                : computeMediaCommands(steps, p, null).length,
        }
      })
    },
    [],
  )

  const advance = useCallback((): boolean => {
    const s = stateRef.current
    if (s.startedAt != null) {
      // Playing: complete the current step immediately
      setState({ ...s, played: s.played + 1, startedAt: null })
      return true
    }
    if (s.played < s.steps.length) {
      setElapsed(0)
      setState({ ...s, startedAt: performance.now() })
      return true
    }
    return false
  }, [])

  const states = useMemo(
    () =>
      computeNodeStates(
        state.steps,
        state.played,
        state.startedAt != null ? elapsed : null,
        canvasHpx,
        canvasWpx ?? (canvasHpx * 16) / 9,
      ),
    [state, elapsed, canvasHpx, canvasWpx],
  )

  const mediaCmds = useMemo(
    () => computeMediaCommands(state.steps, state.played, state.startedAt != null ? elapsed : null),
    [state, elapsed],
  )

  return {
    states,
    mediaCmds,
    mediaBase: state.mediaBase,
    playing: state.startedAt != null,
    pending: state.played < state.steps.length,
    played: state.played,
    epoch: state.epoch,
    advance,
    load,
    seek,
  }
}

/** Whole-page rendering (with animation state); with an empty states Map it's equivalent to SlideThumb. */
export function AnimatedSlideStage({
  slide,
  images,
  width,
  states,
  stageRef,
}: {
  slide: RenderSlide
  images: Map<string, HTMLImageElement>
  width: number
  states: Map<string, NodeAnimState>
  /** Offscreen capture (video export) grabs the stage through this */
  stageRef?: (stage: Konva.Stage | null) => void
}) {
  const scale = width / slide.widthPx
  const h = slide.heightPx * scale
  const bg = fillToKonva(slide.background, slide.widthPx, slide.heightPx, images)
  const paraStates = groupParagraphStates(states)
  return (
    <Stage
      width={width}
      height={h}
      listening={false}
      style={{ pointerEvents: 'none' }}
      ref={stageRef}
    >
      <Layer scaleX={scale} scaleY={scale} listening={false}>
        <Rect
          x={0}
          y={0}
          width={slide.widthPx}
          height={slide.heightPx}
          {...(Object.keys(bg).length ? bg : { fill: '#ffffff' })}
        />
        {slide.nodes.map((n) => (
          <AnimNode
            key={n.id}
            node={n}
            images={images}
            st={n.decoration ? undefined : states.get(n.sourceId)}
            paraSts={n.decoration ? undefined : paraStates.get(n.sourceId)}
          />
        ))}
      </Layer>
    </Stage>
  )
}

/**
 * Animation preview overlay on the edit canvas (ribbon "Preview" / animation pane ▶):
 * covers .stage-rel and plays all steps at 1:1 size (350ms between steps),
 * exiting when finished or on click.
 */
export function AnimPreviewOverlay({
  slide,
  images,
  items,
  onDone,
}: {
  slide: RenderSlide
  images: Map<string, HTMLImageElement>
  items: AnimationItem[]
  onDone: () => void
}) {
  const { t } = useI18n()
  const player = useAnimPlayer(slide.heightPx, slide.widthPx)
  const loadRef = useRef(player.load)
  loadRef.current = player.load
  useEffect(() => {
    loadRef.current(items, 'fresh')
    // Loaded only once on mount (App remounts with key=nonce to replay)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-advance: 350ms pause between steps; after everything plays, exit after 600ms
  useEffect(() => {
    if (player.playing) return
    const t = window.setTimeout(
      () => {
        if (!player.advance()) onDone()
      },
      player.pending ? 350 : 600,
    )
    return () => window.clearTimeout(t)
  }, [player.playing, player.pending, player.advance, onDone]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="anim-preview-overlay" onClick={onDone} data-tip={t('paneAnimClickToEnd')}>
      <AnimatedSlideStage
        slide={slide}
        images={images}
        width={slide.widthPx}
        states={player.states}
      />
    </div>
  )
}

function AnimNode({
  node,
  images,
  st,
  paraSts,
}: {
  node: RenderNode
  images: Map<string, HTMLImageElement>
  st?: NodeAnimState
  /** Per-paragraph animation states for this node. */
  paraSts?: Array<{ para: number; st: NodeAnimState }>
}) {
  if (!st && !paraSts?.length) return <StaticNode node={node} images={images} />
  const { transform, layers } = animatedNodeLayout(node, st, paraSts)
  if (!layers.length) return null
  return (
    <Group {...transform} listening={false}>
      {layers.map(({ key, transform: placement, clips }) => {
        if (!placement && !clips) return <StaticNode key={key} node={node} images={images} />
        return (
          <Group
            key={key}
            {...placement}
            listening={false}
            clipFunc={
              clips &&
              ((ctx: Context) => {
                for (const { x, y, w, h } of clips) ctx.rect(x, y, w, h)
              })
            }
          >
            <StaticNode node={node} images={images} />
          </Group>
        )
      })}
    </Group>
  )
}
