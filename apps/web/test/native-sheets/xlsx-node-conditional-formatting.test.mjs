import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import JSZip from 'jszip'
import { buildSheetsGateway } from '../../server/sheets/build.mjs'
import { configuredSheetsRuntime } from '../../server/src/modules/sheets/runtime.ts'
import { sheetsSaveRequest } from '../helpers/sheets-request.mjs'

const sheetPath = 'xl/worksheets/sheet1.xml'
const stylesPath = 'xl/styles.xml'
const area = (startRow, endRow, column) => ({
  startRow,
  endRow,
  startColumn: column,
  endColumn: column,
})

test('Web Node imports conditional formatting and preserves rules outside the editable snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dyoffice-sheets-cf-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await buildSheetsGateway(join(directory, 'gateway.mjs'))
  const runtime = await configuredSheetsRuntime(
    {
      DYOFFICE_AUTH_MODE: 'local',
      DYOFFICE_SANDBOX_MODE: 'subprocess',
      DYOFFICE_DEPLOYMENT_ID: randomUUID(),
      DYOFFICE_XLSX_NODE_ENGINE: join(directory, 'xlsx-node-engine.mjs'),
      DYOFFICE_XLSX_GATEWAY_RUNNER: join(directory, 'gateway-process.mjs'),
    },
    { enabled: true },
  )
  t.after(() => runtime.close())
  const native = runtime.sheetsNative

  const zip = await JSZip.loadAsync(
    await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)),
  )
  const dxf =
    '<dxf><font><b/><color rgb="FFFFFFFF"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill></dxf>'
  const styles = await zip.file(stylesPath).async('string')
  const dxfs = '<dxfs count="1">' + dxf + '</dxfs>'
  zip.file(
    stylesPath,
    /<dxfs\b/.test(styles)
      ? styles.replace(/<dxfs\b[^>]*?(?:\/>|>[\s\S]*?<\/dxfs>)/, dxfs)
      : styles.replace('</styleSheet>', dxfs + '</styleSheet>'),
  )
  const unsupported =
    '<cfRule type="timePeriod" priority="2" timePeriod="today" dxfId="0"><formula>FLOOR(A2,1)=TODAY()</formula></cfRule>'
  const bar =
    '<cfRule type="dataBar" priority="4"><dataBar minLength="0" maxLength="100" showValue="0"><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule>'
  const dynamic =
    '<cfRule type="iconSet" priority="5"><iconSet iconSet="3Arrows"><cfvo type="min"/><cfvo type="formula" val="$D$1"/><cfvo type="percent" val="67"/></iconSet></cfRule>'
  const worksheet = await zip.file(sheetPath).async('string')
  zip.file(
    sheetPath,
    worksheet.replace(
      '</sheetData>',
      '</sheetData>' +
        '<conditionalFormatting sqref="A2:A4"><cfRule type="cellIs" dxfId="0" priority="1" stopIfTrue="1" operator="greaterThan"><formula>15</formula></cfRule>' +
        unsupported +
        '</conditionalFormatting>' +
        '<s:conditionalFormatting xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main" sqref="B2:B4"><s:cfRule type="colorScale" priority="3"><s:colorScale><s:cfvo type="min"/><s:cfvo type="max"/><s:color rgb="FFFFFFFF"/><s:color rgb="FF00FF00"/></s:colorScale></s:cfRule></s:conditionalFormatting>' +
        '<conditionalFormatting sqref="A1">' +
        bar +
        '</conditionalFormatting>' +
        '<conditionalFormatting sqref="B1">' +
        dynamic +
        '</conditionalFormatting>',
    ),
  )
  const source = await zip.generateAsync({ type: 'nodebuffer' })
  const range = { startRow: 0, endRow: 3, startColumn: 0, endColumn: 2 }

  await t.test('reads comparison operators, formulas and differential colors', async () => {
    const meta = await native.inspect(source, undefined, true)
    const read = await native.readRange(source, 'Acceptance', range)
    assert.deepEqual(
      read.conditionalRules.map((rule) => rule.ruleType),
      ['cellIs', 'timePeriod', 'colorScale', 'dataBar', 'iconSet'],
    )
    assert.equal(read.conditionalRules.at(-1).cfvos[1].value, '$D$1')
    const { minLength, maxLength, showValue } = read.conditionalRules.find(
      (rule) => rule.ruleType === 'dataBar',
    )
    assert.deepEqual([minLength, maxLength, showValue], [0, 100, false])
    const rule = read.conditionalRules.find((rule) => rule.ruleType === 'cellIs')
    assert.deepEqual(
      {
        ranges: rule.ranges,
        operator: rule.operator,
        formulas: rule.formulas,
        dxfIndex: rule.dxfIndex,
        priority: rule.priority,
        stopIfTrue: rule.stopIfTrue,
      },
      {
        ranges: [area(1, 3, 0)],
        operator: 'greaterThan',
        formulas: ['15'],
        dxfIndex: 0,
        priority: 1,
        stopIfTrue: true,
      },
    )
    const { bold, fontColor, fillColor } = meta.dxfStyles[rule.dxfIndex]
    assert.deepEqual(
      { bold, fontColor, fillColor },
      { bold: true, fontColor: '#FFFFFF', fillColor: '#FF0000' },
    )
  })

  await t.test(
    'adding C1 keeps existing rules and an omitted editable rule is deleted',
    async () => {
      const compare = (ranges, value, style, stopIfTrue = false) => ({
        ranges,
        stopIfTrue,
        rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value, style },
      })
      const original = compare(
        [area(1, 3, 0)],
        15,
        { bl: 1, cl: { rgb: '#FFFFFF' }, bg: { rgb: '#FF0000' } },
        true,
      )
      const colorScale = {
        ranges: [area(1, 3, 1)],
        stopIfTrue: false,
        rule: {
          type: 'colorScale',
          config: [
            { index: 0, color: '#FFFFFF', value: { type: 'min' } },
            { index: 1, color: '#00FF00', value: { type: 'max' } },
          ],
        },
      }
      const added = compare([area(0, 0, 2)], 5, { bg: { rgb: '#FFF2CC' } })
      const save = async (bytes, rules, removedSourcePriorities) => {
        const request = sheetsSaveRequest('sheet-1', [])
        request.cfStates = [{ sheetId: 'sheet-1', rules, removedSourcePriorities }]
        const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
        return (await native.savePlan(bytes, plan)).bytes
      }
      const originalBar = {
        ranges: [area(0, 0, 0)],
        stopIfTrue: false,
        source: { priority: 4, unchanged: true },
        rule: {
          type: 'dataBar',
          config: {
            min: { type: 'num', value: 0 },
            max: { type: 'num', value: 25 },
            positiveColor: '#638EC6',
          },
        },
      }
      const originalIconSet = {
        ranges: [area(0, 0, 1)],
        stopIfTrue: false,
        source: { priority: 5, unchanged: true },
        rule: { type: 'iconSet' },
      }
      const saved = await save(source, [original, colorScale, originalBar, originalIconSet, added])
      await assert.rejects(
        () => save(source, [original, colorScale, originalIconSet, originalBar, added]),
        /Invalid workbook input/,
      )
      const output = await JSZip.loadAsync(saved)
      const xml = await output.file(sheetPath).async('string')
      assert.ok(xml.includes(unsupported))
      assert.ok(xml.includes(bar))
      assert.ok(xml.includes(dynamic))
      const rules = (await native.readRange(saved, 'Acceptance', range)).conditionalRules
      assert.deepEqual(
        rules
          .filter((rule) => rule.ruleType === 'cellIs')
          .map((rule) => [rule.ranges, rule.formulas]),
        [
          [[area(1, 3, 0)], ['15']],
          [[area(0, 0, 2)], ['5']],
        ],
      )
      assert.deepEqual(
        [...rules]
          .sort((a, b) => a.priority - b.priority)
          .map((rule) => [rule.ruleType, rule.priority]),
        [
          ['cellIs', 1],
          ['timePeriod', 2],
          ['colorScale', 3],
          ['dataBar', 4],
          ['iconSet', 5],
          ['cellIs', 6],
        ],
      )
      const { dxfStyles } = await native.inspect(saved)
      const fills = rules
        .filter((rule) => rule.ruleType === 'cellIs')
        .map((rule) => dxfStyles[rule.dxfIndex].fillColor)
      assert.deepEqual(fills, ['#FF0000', '#FFF2CC'])
      await assert.rejects(
        () =>
          save(source, [
            original,
            colorScale,
            added,
            {
              ranges: [area(0, 0, 1)],
              stopIfTrue: false,
              rule: {
                type: 'iconSet',
                config: [
                  { iconType: '3Arrows', iconId: '0', value: { type: 'percent', value: 67 } },
                  { iconType: '3Arrows', iconId: '1', value: { type: 'num', value: 42 } },
                  { iconType: '3Arrows', iconId: '2', value: { type: 'min' } },
                ],
              },
            },
          ]),
        /Invalid workbook input/,
      )
      await assert.rejects(
        () =>
          save(source, [
            original,
            colorScale,
            added,
            {
              ...originalBar,
              ranges: [area(0, 0, 2)],
              source: { priority: 4, unchanged: false },
            },
          ]),
        /Invalid workbook input/,
      )
      const removed = await save(saved, [colorScale, originalIconSet, added], [4])
      const removedZip = await JSZip.loadAsync(removed)
      assert.ok((await removedZip.file(sheetPath).async('string')).includes(unsupported))
      const remaining = (await native.readRange(removed, 'Acceptance', range)).conditionalRules
      assert.ok(!remaining.some((rule) => rule.ruleType === 'dataBar'))
      assert.ok(remaining.some((rule) => rule.ruleType === 'iconSet'))
      assert.deepEqual(
        remaining.filter((rule) => rule.ruleType === 'cellIs').map((rule) => rule.ranges),
        [[area(0, 0, 2)]],
      )
    },
  )

  await t.test(
    'merges enhanced data bars by extension ID and preserves both XML records on save',
    async () => {
      const guid = '{11111111-1111-1111-1111-111111111111}'
      const fx = '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}'
      const base =
        '<conditionalFormatting sqref="A2:A3"><cfRule type="dataBar" priority="1">' +
        '<dataBar showValue="0"><cfvo type="min"/><cfvo type="max"/><color rgb="FF0000FF"/></dataBar>' +
        `<extLst><ext uri="${fx}"><ex:id>${guid}</ex:id></ext></extLst></cfRule></conditionalFormatting>`
      const extension =
        '<s:extLst xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        "<s:ext uri='{78C0D931-6437-407d-A8EE-F0AAD7539E65}'>" +
        '<ex:conditionalFormattings><ex:conditionalFormatting>' +
        '<ex:cfRule type="dataBar" id="{22222222-2222-2222-2222-222222222222}"><ex:dataBar axisPosition="none"/></ex:cfRule>' +
        `<ex:cfRule type="dataBar" id="${guid}"><ex:dataBar axisPosition="middle" minLength="0" maxLength="100" gradient="0" negativeBarColorSameAsPositive="0">` +
        '<ex:cfvo type="autoMin"/><ex:cfvo type="autoMax"/><ex:negativeFillColor rgb="FFFFFF00"/><ex:axisColor rgb="FF000080"/>' +
        '</ex:dataBar></ex:cfRule><xm:sqref>A2:A3</xm:sqref></ex:conditionalFormatting></ex:conditionalFormattings></s:ext></s:extLst>'
      const enhanced = await JSZip.loadAsync(
        await readFile(new URL('../fixtures/sheets/acceptance.xlsx', import.meta.url)),
      )
      enhanced.file(
        sheetPath,
        worksheet
          .replace(
            '<worksheet ',
            '<worksheet xmlns:ex="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" ',
          )
          .replace('</sheetData>', '</sheetData>' + base)
          .replace('</worksheet>', extension + '</worksheet>'),
      )
      const bytes = await enhanced.generateAsync({ type: 'nodebuffer' })
      const readBar = async (input) => {
        const { conditionalRules: rules } = await native.readRange(input, 'Acceptance', range)
        const bars = rules.filter((rule) => rule.ruleType === 'dataBar')
        assert.equal(bars.length, 1)
        const {
          ruleType,
          ranges,
          colors,
          cfvos,
          axisPosition,
          axisColor,
          gradient,
          negativeColor,
          negativeSameAsPositive,
          minLength,
          maxLength,
          showValue,
        } = bars[0]
        return {
          ruleType,
          ranges,
          colors,
          cfvos,
          axisPosition,
          axisColor,
          gradient,
          negativeColor,
          negativeSameAsPositive,
          minLength,
          maxLength,
          showValue,
        }
      }
      const expected = {
        ruleType: 'dataBar',
        ranges: [area(1, 2, 0)],
        colors: ['#0000FF'],
        cfvos: [{ kind: 'autoMin' }, { kind: 'autoMax' }],
        axisPosition: 'middle',
        axisColor: '#000080',
        gradient: false,
        negativeColor: '#FFFF00',
        negativeSameAsPositive: false,
        minLength: 0,
        maxLength: 100,
        showValue: false,
      }
      assert.deepEqual(await readBar(bytes), expected)

      const request = sheetsSaveRequest('sheet-1', [
        { row: 1, column: 0, writeValue: true, value: -5 },
      ])
      request.cfStates = [
        {
          sheetId: 'sheet-1',
          rules: [
            {
              ranges: [area(0, 0, 2)],
              stopIfTrue: false,
              rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 5 },
            },
            {
              ranges: [area(1, 2, 0)],
              stopIfTrue: false,
              source: { priority: 1, unchanged: true },
              rule: {
                type: 'dataBar',
                config: {
                  min: { type: 'num', value: -5 },
                  max: { type: 'num', value: 25 },
                  positiveColor: '#0000FF',
                },
              },
            },
          ],
        },
      ]
      const plan = await runtime.sheetsWorkbookPlanner(bytes, request)
      const saved = (await native.savePlan(bytes, plan)).bytes
      const savedFile = await JSZip.loadAsync(saved)
      const savedWorksheet = await savedFile.file(sheetPath).async('string')
      assert.ok(savedWorksheet.includes(base))
      assert.ok(savedWorksheet.includes(extension))
      assert.deepEqual(await readBar(saved), expected)
      const { cells, conditionalRules } = await native.readRange(saved, 'Acceptance', range)
      assert.equal(cells.find((cell) => cell.row === 1 && cell.column === 0).value, -5)
      assert.deepEqual(conditionalRules.find((rule) => rule.ruleType === 'cellIs').ranges, [
        area(0, 0, 2),
      ])

      const remove = sheetsSaveRequest('sheet-1', [])
      remove.cfStates = [{ sheetId: 'sheet-1', rules: [], removedSourcePriorities: [1] }]
      const removed = (
        await native.savePlan(saved, await runtime.sheetsWorkbookPlanner(saved, remove))
      ).bytes
      const removedXml = await (await JSZip.loadAsync(removed)).file(sheetPath).async('string')
      assert.ok(!removedXml.includes(guid))
      assert.ok(removedXml.includes('{22222222-2222-2222-2222-222222222222}'))
      assert.deepEqual((await native.readRange(removed, 'Acceptance', range)).conditionalRules, [])
    },
  )
})
