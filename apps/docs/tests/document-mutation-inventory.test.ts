import { test, expect } from 'vitest'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
// Any new save input requires an explicit ownership/entry-path review, not an automatic snapshot update.
const reviewedInputs = [
  'comments',
  'commentsDirty',
  'defaultFonts',
  'doc',
  'editor',
  'endnotes',
  'evenOddHf',
  'evenOddHfDirty',
  'footnotes',
  'hfLinks',
  'inkAnnotations',
  'inksDirty',
  'mirrorMargins',
  'mirrorMarginsDirty',
  'notesDirty',
  'numberingDirty',
  'pageColor',
  'pageColorDirty',
  'pageCount',
  'pendingNumbering',
  'pgNumDirtySections',
  'pgNumEdit',
  'protection',
  'protectionDirty',
  'removePersonalInfo',
  'removePersonalInfoDirty',
  'section',
  'sectionDirty',
  'sectionHfEdits',
  'sections',
  'sectionsDirty',
  'settleFontSettings',
  'sources',
  'sourcesDirty',
  'styleUpserts',
  'themeColors',
  'themeColorsDirty',
  'themeFonts',
  'themeFontsDirty',
  'titlePg',
  'titlePgDirty',
  'trackChanges',
  'trackRevisionsDirty',
  'trailingStartType',
  'watermark',
  'watermarkDirty',
  'watermarkPicture',
  'watermarkStyle',
  'writeProtection',
  'writeProtectionDirty',
  'zoteroDocumentData',
  'zoteroDocumentDataDirty',
]
test('native byte serializer input inventory stays explicit', () => {
  const source = ts.createSourceFile(
    'file-actions.ts',
    readFileSync(resolve(process.cwd(), 'src/renderer/file-actions.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  let root: ts.FunctionDeclaration | undefined
  function find(n: ts.Node) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'buildDocBytes') root = n
    ts.forEachChild(n, find)
  }
  find(source)
  expect(root).toBeDefined()
  const found = new Set<string>()
  function scan(n: ts.Node) {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'ctx'
    )
      found.add(n.name.text)
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer?.getText(source) === 'ctx' &&
      ts.isObjectBindingPattern(n.name)
    )
      for (const e of n.name.elements)
        found.add(e.propertyName?.getText(source) ?? e.name.getText(source))
    ts.forEachChild(n, scan)
  }
  scan(root!)
  expect([...found].sort()).toEqual(reviewedInputs)
})
