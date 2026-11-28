import {expect,test,vi} from 'vitest'
import {createBrowserSlideFullscreen} from '../../src/editors/slides-browser-fullscreen'

function browserDocument() {
  let grant!: () => void
  const root = {requestFullscreen:vi.fn(() => new Promise<void>(resolve => {
    grant=()=>{document.fullscreenElement=root;resolve()}
  }))}
  const document = {
    documentElement:root,
    fullscreenEnabled:true,
    fullscreenElement:null as typeof root|null,
    exitFullscreen:vi.fn(async()=>{document.fullscreenElement=null}),
  }
  return {document,root,grant:()=>grant(),controller:createBrowserSlideFullscreen(document as unknown as Document)}
}

test('closing a show releases fullscreen granted after its renderer has exited',async()=>{
  const {document,root,grant,controller}=browserDocument()
  controller.requestShowFullScreen()
  expect(root.requestFullscreen).toHaveBeenCalledOnce()
  const exit=controller.setShowFullScreen(false)
  grant()
  await exit
  expect(document.exitFullscreen).toHaveBeenCalledOnce()
  expect(document.fullscreenElement).toBeNull()
})

test('a newer show can keep the fullscreen request shared with the previous show',async()=>{
  const {document,root,grant,controller}=browserDocument()
  controller.requestShowFullScreen()
  const previousExit=controller.setShowFullScreen(false)
  controller.requestShowFullScreen()
  grant()
  await previousExit
  await controller.setShowFullScreen(true)
  expect(root.requestFullscreen).toHaveBeenCalledOnce()
  expect(document.fullscreenElement).toBe(root)
  await controller.setShowFullScreen(false)
  expect(document.fullscreenElement).toBeNull()
})
