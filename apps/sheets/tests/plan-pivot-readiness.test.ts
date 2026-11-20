import {expect,it,vi} from 'vitest'
import {proposeOperations,type PlanContext} from '../src/renderer/plan-operations'

function context(definitions:Map<string,unknown>){
 const worksheet={getSheetId:()=> 'sheet-1',getSheetName:()=> 'Data',getMaxRows:()=>20,getMaxColumns:()=>10,getRange:()=>({getValue:()=>null,getRawValue:()=>null,getFormula:()=>null,getCellDatas:()=>[[null]]})}
 const workbook={getActiveSheet:()=>worksheet,getSheetBySheetId:(id:string)=>id==='sheet-1'?worksheet:null,getSheets:()=>[worksheet]}
 const apply=vi.fn().mockResolvedValue({ok:true})
 const state={file:{sessionId:'session',sheets:[{id:'sheet-1',name:'Data',rowCount:20,columnCount:10,pivotRanges:[],pivotTables:[{path:'pivot1',cachePath:'cache1'},{path:'pivot2',cachePath:'cache2'}]}],visuals:[]},formulaMode:true,flags:{preloadComplete:true},pivotDefinitions:definitions,editJournal:{cells:new Map(),structuralOps:new Map(),sheets:{added:new Set(),removed:new Set()},visualAdds:[],tableAdds:[]},loadedRanges:new Map(),filterOrigins:new Map(),appliedDvSheets:new Set()}
 return {apply,ctx:{adapterRef:{current:{getSnapshot:()=>({revision:0,sheets:[]})}},univerRef:{current:{univerAPI:{getActiveWorkbook:()=>workbook}}},lazyWorkbookRef:{current:state},lazyPreviewRef:{current:null},setPreview:vi.fn(),autoApplySafePlan:apply} as unknown as PlanContext}
}
it('rejects a mixed edit/refresh before applying when any pivot definition is still loading',()=>{
 const {ctx,apply}=context(new Map([['pivot1',{sourceSheet:'Data',unsupported:[]}]]))
 const result=proposeOperations(ctx,[{op:'set_cell',sheetId:'sheet-1',address:'A1',value:'changed'},{op:'refresh_pivot',sheetId:'sheet-1'}],'edit and refresh')
 expect(result.ok).toBe(false)
 if(!result.ok)expect(result.error).toMatch(/definition.*load/i)
 expect(apply).not.toHaveBeenCalled()
})
it('rejects a missing pivot source worksheet before applying any refresh',()=>{
 const {ctx,apply}=context(new Map([['pivot1',{sourceSheet:'Data',unsupported:[]}],['pivot2',{sourceSheet:'Missing',unsupported:[]}]]))
 const result=proposeOperations(ctx,[{op:'refresh_pivot',sheetId:'sheet-1'}],'refresh')
 expect(result.ok).toBe(false)
 if(!result.ok)expect(result.error).toContain('Missing')
 expect(apply).not.toHaveBeenCalled()
})
it('valid loaded definitions still produce an applyable refresh plan',()=>{
 const {ctx}=context(new Map([['pivot1',{sourceSheet:'Data',unsupported:[]}],['pivot2',{sourceSheet:'Data',unsupported:[]}]]))
 const result=proposeOperations(ctx,[{op:'refresh_pivot',sheetId:'sheet-1'}],'refresh')
 expect(result.ok).toBe(true)
})
it.each([
 ['missing definition',undefined,/definition.*load|定义.*加载/i],
 ['missing source',{sourceSheet:'Missing',unsupported:[]},/Missing/],
 ['unsupported definition',{sourceSheet:'Data',unsupported:['unsupported layout']},/unsupported layout/],
] as const)('direct UI refresh checks %s before reading or writing the first pivot',async(_name,secondDefinition,error)=>{
 const {refreshPivotTables}=await import('../src/renderer/pivot-actions')
 const range=vi.fn(()=>{throw Error('first pivot was already accessed')})
 const worksheet={getSheetName:()=> 'Data',getRange:range}
 const definitions=new Map<string,unknown>([['pivot1',{sourceSheet:'Data',unsupported:[]}]])
 if(secondDefinition)definitions.set('pivot2',secondDefinition)
 const {ctx}=context(definitions)
 const state=ctx.lazyWorkbookRef.current!
 const pivotContext={lazyWorkbookRef:{current:state},univerRef:{current:{univerAPI:{getActiveWorkbook:()=>({getSheetBySheetId:()=>worksheet,getSheets:()=>[worksheet]})}}},setPendingEdits:vi.fn()}
 expect(()=>refreshPivotTables(pivotContext as never,'sheet-1')).toThrow(error)
 expect(range).not.toHaveBeenCalled()
})
