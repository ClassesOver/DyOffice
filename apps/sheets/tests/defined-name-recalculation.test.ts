import { installDefinedNameDependencies } from '../src/renderer/defined-name-dependencies'
import {
  IUniverInstanceService,
  LocaleType,
  LogLevel,
  Univer,
  UniverInstanceType,
} from '@univerjs/core'
import { FUniver } from '@univerjs/core/facade'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula'
import '@univerjs/sheets-formula/facade'
import { it, expect } from 'vitest'
it.each(['direct', 'nested'])(
  'recalculates a real engine formula after its %s defined range changes',
  async (mode) => {
    installDefinedNameDependencies()
    const univer = new Univer({
      locale: LocaleType.EN_US,
      locales: { [LocaleType.EN_US]: {} },
      logLevel: LogLevel.ERROR,
    })
    try {
      univer.registerPlugin(UniverFormulaEnginePlugin)
      univer.registerPlugin(UniverSheetsPlugin)
      univer.registerPlugin(UniverSheetsFormulaPlugin)
      univer.createUnit(UniverInstanceType.UNIVER_SHEET, {
        id: 'names-wb',
        sheetOrder: ['s'],
        sheets: {
          s: {
            id: 's',
            name: 'Acceptance',
            rowCount: 20,
            columnCount: 10,
            cellData: { 1: { 0: { v: 12.5 } }, 2: { 0: { v: 7.5 } } },
          },
        },
      })
      const api = FUniver.newAPI(univer),
        workbook = api.getActiveWorkbook()!,
        sheet = workbook.getActiveSheet()!
      if (mode === 'nested')
        workbook.insertDefinedNameBuilder(
          workbook
            .newDefinedNameBuilder()
            .setName('BaseRange')
            .setRef('Acceptance!$A$2:$A$3')
            .build(),
        )
      workbook.insertDefinedNameBuilder(
        workbook
          .newDefinedNameBuilder()
          .setName('Revenue')
          .setRef(mode === 'nested' ? 'BaseRange' : 'Acceptance!$A$2:$A$3')
          .build(),
      )
      sheet.getRange('F2').setFormula('=SUM(Revenue)')
      await expect
        .poll(() => sheet.getRange('F2').getCellDatas()[0]?.[0]?.v, { timeout: 5000 })
        .toBe(20)
      workbook
        .getDefinedNames()
        .find((n) => n.getName() === (mode === 'nested' ? 'BaseRange' : 'Revenue'))!
        .setRef('Acceptance!$A$2')
      await expect
        .poll(() => sheet.getRange('F2').getCellDatas()[0]?.[0]?.v, { timeout: 5000 })
        .toBe(12.5)
      univer.__getInjector().get(IUniverInstanceService).focusUnit(workbook.getId())
      expect(await api.undo()).toBe(true)
      await expect
        .poll(() => sheet.getRange('F2').getCellDatas()[0]?.[0]?.v, { timeout: 5000 })
        .toBe(20)
      expect(await api.redo()).toBe(true)
      await expect
        .poll(() => sheet.getRange('F2').getCellDatas()[0]?.[0]?.v, { timeout: 5000 })
        .toBe(12.5)
      expect(sheet.getRange('F2').getFormula()).toBe('=SUM(Revenue)')
    } finally {
      univer.dispose()
    }
  },
  15000,
)
