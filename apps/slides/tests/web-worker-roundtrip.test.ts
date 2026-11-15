// @vitest-environment node
/** Node-side reuse gate, not browser UI, authorization or visual-fidelity acceptance.
 * Unlike edit-flow's direct model mutation, this crosses runTxn + native render + disk IO.
 */
import {afterEach, describe, expect, it} from 'vitest'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {addElement, createBlankPptx, openPptx, savePptx, type OpenedPptx, type TextElement} from '@genoffice/pptx-engine'
import {runTxn} from '@genoffice/pptx-ops'
import {buildRenderSlide} from '@genoffice/pptx-render'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, {recursive:true, force:true}) })

function firstText(opened: OpenedPptx): TextElement {
  const element=opened.deck.slides[0]!.elements.find(item => item.type==='text' || item.type==='shape')
  if (!element) throw new Error('Fixture text element missing')
  return element as TextElement
}

async function diskFixture() {
  const directory=await mkdtemp(join(tmpdir(),'dyoffice-pptx-reuse-'))
  directories.push(directory)
  const seed=await openPptx(await createBlankPptx())
  addElement(seed.deck.slides[0]!, {kind:'textbox',offset:{x:914400,y:914400,cx:7315200,cy:1828800},paragraphs:[{runs:[{text:'Before native edit',bold:true}]}]})
  const bytes=await savePptx(seed)
  const input=join(directory,'input.pptx')
  await writeFile(input,bytes)
  return {directory,bytes,opened:await openPptx(new Uint8Array(await readFile(input)))}
}

describe('Web worker reuse: native PPTX engine + ops + render', () => {
  it('persists a real native op edit and reopens it while preserving untouched package parts', async () => {
    const {directory,opened}=await diskFixture()
    const preserved=['ppt/theme/theme1.xml','ppt/slideMasters/slideMaster1.xml','ppt/slideLayouts/slideLayout1.xml']
      .map(path => ({path,xml:opened.archive.readText(path)}))
    expect(preserved.every(part => part.xml)).toBe(true)
    const element=firstText(opened)
    const applied=runTxn(opened,{ops:[{op:'setText',target:{slide:0,el:element.id},paragraphs:[{runs:[{text:'DyOffice 原生写回',bold:true}]},{runs:[{text:'Edited and reopened without Electron.'}]}]}]})
    expect(applied.applied).toBe(true)
    const output=join(directory,'edited.pptx')
    const edited=await savePptx(opened)
    await writeFile(output,edited)
    const reopened=await openPptx(new Uint8Array(await readFile(output)))
    const saved=firstText(reopened)
    expect(saved.text!.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['DyOffice 原生写回','Edited and reopened without Electron.'])
    expect(saved.text!.paragraphs[0]!.runs[0]!.bold).toBe(true)
    const render=buildRenderSlide(reopened.deck.slides[0]!,reopened.deck.size,{fitWidthPx:960,slideNo:1})
    expect(render.widthPx).toBe(960)
    expect(JSON.stringify(render)).toContain('DyOffice')
    for (const {path,xml} of preserved) expect(reopened.archive.readText(path),path).toBe(xml)
    expect(await savePptx(reopened)).toEqual(edited)
    // Heuristic metrics suffice for this data-flow check, not a font/layout fidelity claim.
  })

  it('rejects an invalid native op batch without changing bytes or a separately opened model', async () => {
    const {opened,bytes}=await diskFixture()
    const other=await openPptx(bytes)
    const before=await savePptx(opened)
    const rejected=runTxn(opened,{ops:[
      {op:'setText',target:{slide:0,el:firstText(opened).id},paragraphs:[{runs:[{text:'must not persist'}]}]},
      {op:'setText',target:{slide:999,el:'missing'},paragraphs:[{runs:[{text:'invalid'}]}]},
    ]})
    expect(rejected.applied).toBe(false)
    expect(rejected.failures?.length).toBeGreaterThan(0)
    expect(await savePptx(opened)).toEqual(before)
    expect(await savePptx(other)).toEqual(bytes)
    // Separate model state is not a substitute for server principal/session authorization.
  })
})
