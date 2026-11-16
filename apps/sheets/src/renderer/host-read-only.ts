import {CommandType,ICommandService} from '@univerjs/core'
import {journalSuppression} from './univer-state'
import {vetoUniverCommand} from './very-hidden-sheets'
import type {UniverRuntime} from './univer-state'

/** Import commands share the undoable user command path. A workbook-wide
 * permission bit rejects both, so gate user commands at their entry instead.
 * Operations (selection/scroll) and engine result mutations remain available. */
export function blocksHostCommand(readOnly:boolean,importing:boolean,type:CommandType|undefined,id:string):boolean {
  return readOnly && !importing && type===CommandType.COMMAND && !['sheet.command.copy','doc.command.copy'].includes(id)
}
export function installHostReadOnlyGuard(runtime:UniverRuntime,readOnly:()=>boolean):void {
 const service=runtime.univer.__getInjector().get(ICommandService)
 service.beforeCommandExecuted(command=>{
  if(blocksHostCommand(readOnly(),journalSuppression.active,command.type,command.id))vetoUniverCommand(service,command,'Read only workbook')
 })
}
