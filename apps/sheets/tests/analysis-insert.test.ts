import {it,expect} from 'vitest'
import {analysisCellOperations} from '../src/renderer/analysis-insert'
import {planFromOps} from '../src/renderer/op-executor'
it('analysis table remains string values through the original workbook planner',()=>{
 const ops=analysisCellOperations({kind:'table',rows:[['=1+1','0012'],['<script>x</script>','@SUM(A1)']]},'s',1,2)
 expect(ops.map(op=>op.op)).toEqual(['set_cell','set_cell','set_cell','set_cell'])
 const workbook={getSheetBySheetId:()=>({getSheetName:()=> 'Data',getRange:()=>({getValue:()=>null,getFormula:()=>'',getCellData:()=>({}),getCellDatas:()=>[[{}]]})})} as unknown as Parameters<typeof planFromOps>[1]
 const plan=planFromOps(ops,workbook,'analysis')
 expect(plan.cellChanges.map(change=>change.after.value)).toEqual(['=1+1','0012','<script>x</script>','@SUM(A1)'])
 expect(plan.cellChanges.every(change=>!change.after.formula)).toBe(true)
 expect(plan.cellChanges.map(change=>change.address)).toEqual(['C2','D2','C3','D3'])
})
it('rejects oversized and out of bounds matrices before any original operation',()=>{
 expect(()=>analysisCellOperations({kind:'table',rows:[['a','b']]},'s',0,16383)).toThrow()
 expect(()=>analysisCellOperations({kind:'text',text:'a\n'.repeat(501)},'s',0,0)).toThrow()
 expect(()=>analysisCellOperations({kind:'table',rows:[['a'],['b','c']]},'s',0,0)).toThrow()
})

it('queued analysis rechecks selection, journal, epoch and UI authority before the original write',async()=>{
 const {captureSheetAnalysis}=await import('../src/renderer/analysis-insert')
 for(const drift of ['selection','fingerprint','epoch','identity','authority'] as const){
  const current={identity:{},runtime:{},workbookId:'book',sheetId:'s',row:0,column:0,selection:'A1',epoch:0,fingerprint:'clean'}
  let allowed=true,writes=0,holds=0
  const capture=captureSheetAnalysis({current:()=>current,hold:()=>{holds++},run:async(_ops,check)=>{
   await Promise.resolve()
   if(drift==='authority')allowed=false
   else if(drift==='epoch')current.epoch++
   else if(drift==='identity')current.identity={}
   else current[drift]='changed'
   if(!check())return false;writes++;return true
  }})
  expect(await capture.apply({kind:'text',text:'=1+1'},()=>allowed)).toBe(false)
  expect(writes).toBe(0);expect(holds).toBe(1)
 }
})
it('unchanged native capture enters the original operation queue without saving',async()=>{
 const {captureSheetAnalysis}=await import('../src/renderer/analysis-insert')
 const current={identity:{},runtime:{},workbookId:'book',sheetId:'s',row:1,column:1,selection:'B2',epoch:0,fingerprint:'clean'}
 let applied:unknown
 const capture=captureSheetAnalysis({current:()=>current,hold:()=>{},run:async(ops,check)=>{expect(check()).toBe(true);applied=ops;return true}})
 expect(await capture.apply({kind:'text',text:'=HYPERLINK("x")'},()=>true)).toBe(true)
 expect(applied).toEqual([{op:'set_cell',sheetId:'s',address:'B2',value:'=HYPERLINK("x")'}])
})

it('real Univer core write keeps the original executor literal payload non-formula',async()=>{
 const {Univer,UniverInstanceType,LocaleType,LogLevel,ICommandService}=await import('@univerjs/core')
 const {UniverSheetsPlugin}=await import('@univerjs/sheets')
 const {plannedCellValue}=await import('../src/renderer/op-executor')
 const univer=new Univer({locale:LocaleType.EN_US,logLevel:LogLevel.ERROR,locales:{}})
 try{
  univer.registerPlugin(UniverSheetsPlugin)
  const workbook=univer.createUnit(UniverInstanceType.UNIVER_SHEET,{id:'analysis-book',sheetOrder:['s'],sheets:{s:{id:'s',name:'Data',rowCount:10,columnCount:10,cellData:{0:{0:{f:'=2+2',v:4}}}}}})
  const commands=univer.__getInjector().get(ICommandService)
  // op-executor uses object cells with f/si=null, never raw strings interpreted
  // as formulas. Exercise that exact data shape in the real core command.
  await commands.executeCommand('sheet.command.set-range-values',{unitId:'analysis-book',subUnitId:'s',range:{startRow:0,endRow:0,startColumn:0,endColumn:1},value:[[plannedCellValue('=1+1',true),plannedCellValue('0012',true)]]})
  const sheet=(workbook as unknown as {getSheetBySheetId(id:string):{getCellRaw(r:number,c:number):{v?:unknown;f?:unknown}}}).getSheetBySheetId('s')
  expect(sheet.getCellRaw(0,0).v).toBe('=1+1');expect(sheet.getCellRaw(0,0).f).toBeFalsy()
  expect(sheet.getCellRaw(0,1).v).toBe('0012');expect(sheet.getCellRaw(0,1).f).toBeFalsy()
 }finally{univer.dispose()}
})
it('save-owned readonly/queue state permits only unchanged-content receipt recovery',async()=>{
 const {captureSheetAnalysis}=await import('../src/renderer/analysis-insert')
 let locked=false
 const state={identity:{},runtime:{},workbookId:'book',sheetId:'s',row:0,column:0,selection:'A1',epoch:0,fingerprint:'before'}
 const capture=captureSheetAnalysis({current:forSave=>locked&&!forSave?null:state,hold:()=>{},run:async()=>true})
 locked=true;expect(capture.matches()).toBe(false);expect(capture.matchesForSave()).toBe(true)
 state.fingerprint='newer';expect(capture.matchesForSave()).toBe(false)
})
it('frozen query results write numeric and boolean columns as typed cells, keeping header and notes as text',()=>{
 const ops=analysisCellOperations({kind:'table',headerRows:1,columnTypes:['string','number','boolean'],rows:[['month','paid (CNY)','closed'],['2026-01','30','TRUE'],['2026-02','-1.5e3','FALSE'],['Source: s v1','','']]},'s',0,0)
 expect(ops.map(op=>(op as {value:unknown}).value)).toEqual(['month','paid (CNY)','closed','2026-01',30,true,'2026-02',-1500,false,'Source: s v1','',''])
})
it('refuses images instead of writing them into cells',()=>{
 expect(()=>analysisCellOperations({kind:'image',mediaType:'image/png',base64:'',width:1,height:1,alt:''},'s',0,0)).toThrow(/native chart/)
})
