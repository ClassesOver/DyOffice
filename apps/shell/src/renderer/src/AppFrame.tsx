import { useEffect, useState } from 'react'
import { Home, type HomeProps } from './Home'
import type {ReactNode} from 'react'
import type {TabSummary} from '../../shared/tabs-api'
import { Onboarding } from './Onboarding'
import { StarPromptCard } from './StarPromptCard'
import { TabBar } from './TabBar'

interface AppFrameProps {
  /** resolved before first paint (main.tsx) so home never flashes under the overlay */
  initialOnboardingSeen: boolean
  hideSingleTabList?: boolean
  allowHomeTabMenu?: boolean
  renameTabFile?:(id:string,name:string)=>Promise<void>
  closeTabWithKeyboard?:(id:string)=>Promise<boolean>
  detachTabOnDrop?:(id:string)=>void
  homeBeside?: 'left' | 'right'
  hideAppMenu?: boolean
  homeProps?:HomeProps
  renderEditor?:(tab:TabSummary)=>ReactNode
  editorContent?:ReactNode
}

export function AppFrame({ initialOnboardingSeen, homeProps, renderEditor, editorContent, hideSingleTabList, hideAppMenu, allowHomeTabMenu, renameTabFile, closeTabWithKeyboard, detachTabOnDrop, homeBeside }: AppFrameProps) {
  const [activeTab,setActiveTab] = useState<TabSummary | undefined>()
  const [homeActive, setHomeActive] = useState(true)
  const [showOnboarding, setShowOnboarding] = useState(!initialOnboardingSeen)
  const [starPromptDocOpens, setStarPromptDocOpens] = useState<number | null>(null)

  useEffect(() => {
    const applyTabs = (tabs: Awaited<ReturnType<typeof window.aiOfficeTabs.list>>) => {
      const active = tabs.find((tab) => tab.active)
      setActiveTab(active)
      setHomeActive(!active || active.kind === 'home')
    }
    void window.aiOfficeTabs.list().then(applyTabs)
    return window.aiOfficeTabs.onChanged(applyTabs)
  }, [])

  // The "star us" invitation is decided (and counted as shown) by the main
  // process; ask once per session, and never while onboarding is up — a
  // first-run user can't have met the value threshold anyway.
  useEffect(() => {
    if (showOnboarding) return
    let alive = true
    void window.aiOffice.starPromptShouldShow?.().then((result) => {
      if (alive && result.show) setStarPromptDocOpens(result.docOpens)
    })
    return () => {
      alive = false
    }
  }, [showOnboarding])

  const finishOnboarding = async (): Promise<boolean> => {
    try {
      const persisted = await window.aiOffice.setOnboardingSeen()
      if (!persisted) return false
      setShowOnboarding(false)
      return true
    } catch {
      return false
    }
  }

  return (
    <div className="app-frame">
      <TabBar hideSingleTabList={hideSingleTabList} hideAppMenu={hideAppMenu} allowHomeTabMenu={allowHomeTabMenu} renameTabFile={renameTabFile} closeTabWithKeyboard={closeTabWithKeyboard} detachTabOnDrop={detachTabOnDrop}/>
      {/* docs/sheets tabs render as WebContentsView children of this window, positioned
       * by the main process to cover this area — only Home paints its own content here. */}
      <div className="app-frame-content" data-workspace-pane={homeBeside}
        style={{ visibility: homeActive || homeBeside ? 'visible' : 'hidden' }}
        onPointerDown={homeBeside&&!homeActive?()=>{void window.aiOfficeTabs.activate('home')}:undefined}
        onFocusCapture={homeBeside&&!homeActive?()=>{void window.aiOfficeTabs.activate('home')}:undefined}>
        <Home {...homeProps} active={homeActive}/>
      </div>
      {editorContent}
      {!homeActive && activeTab && renderEditor?.(activeTab)}
      {/* editor WebContentsViews paint above ALL shell DOM, so the overlay only
       * renders while the home tab is active — it comes back when home does */}
      {showOnboarding && homeActive && <Onboarding onDone={finishOnboarding} />}
      {starPromptDocOpens !== null && !showOnboarding && homeActive && (
        <StarPromptCard docOpens={starPromptDocOpens} onClose={() => setStarPromptDocOpens(null)} />
      )}
    </div>
  )
}
