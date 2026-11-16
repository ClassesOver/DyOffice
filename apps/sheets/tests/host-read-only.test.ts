import {describe,it,expect} from 'vitest'
import {CommandType} from '@univerjs/core'
import {blocksHostCommand} from '../src/renderer/host-read-only'
describe('host read-only command boundary',()=>{
 it('blocks user edits while allowing suppressed file installs and engine results',()=>{
  expect(blocksHostCommand(true,false,CommandType.COMMAND,'sheet.command.set-range-values')).toBe(true)
  expect(blocksHostCommand(true,true,CommandType.COMMAND,'sheet.command.set-range-values')).toBe(false)
  expect(blocksHostCommand(false,false,CommandType.COMMAND,'sheet.command.set-range-values')).toBe(false)
  expect(blocksHostCommand(true,false,CommandType.MUTATION,'formula.mutation.set-formula-calculation-result')).toBe(false)
  expect(blocksHostCommand(true,false,CommandType.OPERATION,'sheet.operation.set-selections')).toBe(false)
  expect(blocksHostCommand(true,false,CommandType.COMMAND,'sheet.command.copy')).toBe(false)
 })
})
