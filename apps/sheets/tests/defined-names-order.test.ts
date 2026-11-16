import { afterEach, describe, expect, it } from 'vitest'

import { applyDefinedNames, formulaKeepsCache, setEvaluableDefinedNames } from '../src/renderer/univer-sync'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'

/// Univer's defined-name table is keyed by name alone (first insert
/// wins), so the loader must feed each name's live workbook-level definition
/// before Excel's #REF! sheet-scoped residues.
describe('applyDefinedNames ordering', () => {
  it('loads live workbook-level definitions before #REF! residues', () => {
    const inserted: Array<{ name: string; formulaOrRefString: string; localSheetId: string }> = []
    const workbook = {
      newDefinedNameBuilder() {
        let param: Record<string, unknown> = {}
        return {
          load(next: Record<string, unknown>) {
            param = next
            return { build: () => param }
          },
        }
      },
      insertDefinedNameBuilder(param: unknown) {
        inserted.push(param as (typeof inserted)[number])
      },
    }
    const runtime = {
      univerAPI: { getActiveWorkbook: () => workbook },
    } as unknown as UniverRuntime
    const file = {
      definedNames: [
        { name: 'Excel_Version', formula: '#REF!', sheetIndex: 0 },
        { name: 'Excel_Version', formula: '#REF!', sheetIndex: 1 },
        { name: 'Excel_Version', formula: 'WELCOME!$H$9' },
        { name: 'Version', formula: '#REF!', sheetIndex: 0 },
        { name: 'Version', formula: 'WELCOME!$S$5' },
        { name: 'Unrelated', formula: 'Sheet1!$A$1' },
      ],
      sheets: [
        { id: 'sheet-1', name: 'Sheet1' },
        { id: 'sheet-2', name: 'Sheet2' },
      ],
    } as never
    const state = { uninstalledDefinedNames: new Set<string>() } as unknown as LazyWorkbookState

    applyDefinedNames(runtime, file, state)

    const excelVersion = inserted.filter((entry) => entry.name === 'Excel_Version')
    expect(excelVersion[0]).toMatchObject({
      formulaOrRefString: 'WELCOME!$H$9',
      localSheetId: 'AllDefaultWorkbook',
    })
    expect(excelVersion.slice(1).map((entry) => entry.formulaOrRefString)).toEqual([
      '#REF!',
      '#REF!',
    ])
    const version = inserted.filter((entry) => entry.name === 'Version')
    expect(version[0]?.formulaOrRefString).toBe('WELCOME!$S$5')
    // A live sheet-scoped definition still outranks a #REF! one but follows
    // the workbook-level entry; unrelated names are untouched.
    expect(inserted.some((entry) => entry.name === 'Unrelated')).toBe(true)
  })
})

afterEach(()=>setEvaluableDefinedNames([]))
it('Web evaluates installed unambiguous references and retains failed or scoped names',()=>{
 const workbook={newDefinedNameBuilder:()=>({load:(value:unknown)=>({build:()=>value})}),insertDefinedNameBuilder:(value:any)=>{if(value.name==='Rejected')throw new Error('cannot install')}}
 const runtime={univerAPI:{getActiveWorkbook:()=>workbook}} as unknown as UniverRuntime
 const file={sheets:[{id:'s',name:'Sheet1'}],definedNames:[
  {name:'Revenue',formula:'Sheet1!$A$2:$A$3'},
  {name:'Rejected',formula:'Sheet1!$A$2'},
  {name:'Scoped',formula:'Sheet1!$A$2',sheetIndex:0},
  {name:'Collision',formula:'Sheet1!$A$2'},
  {name:'collision',formula:'Sheet1!$A$3'},
  {name:'External',formula:'[1]Sheet1!$A$2'},
 ]} as never
 const state={uninstalledDefinedNames:new Set<string>()} as unknown as LazyWorkbookState
 applyDefinedNames(runtime,file,state,true)
 expect(formulaKeepsCache('SUM(Revenue)')).toBe(false)
 for(const name of ['Rejected','Scoped','Collision','External'])expect(formulaKeepsCache(`SUM(${name})`)).toBe(true)
 expect(state.uninstalledDefinedNames.has('Rejected')).toBe(true)
 applyDefinedNames(runtime,file,state)
 expect(formulaKeepsCache('SUM(Revenue)')).toBe(true)
})
