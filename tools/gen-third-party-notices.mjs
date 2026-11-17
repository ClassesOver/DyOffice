/** SaaS dependency inventory, not a certification of the final distributed artifacts.
 * Intentionally includes installed build/test packages: lock-path enumeration is a
 * conservative superset, unlike a source regex or package-name dependency closure.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { licenseText } from './license-text.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXTRA_NOTICE = { '@rhwp/core': 'tools/notices/rhwp-core.txt' }
const NOTE = {
  '@fluentui/react-icons':
    'Copyright (c) Microsoft Corporation. Licensed under the MIT License.\nhttps://github.com/microsoft/fluentui-system-icons',
  '@genspark/cli':
    'Copyright (c) Genspark. Licensed under the MIT License.\nhttps://www.npmjs.com/package/@genspark/cli',
}
const packageName = (path) => path.slice(path.lastIndexOf('node_modules/') + 13)
export function inventoryInstalledPackages(root, lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
    throw new Error('An npm v2/v3 package lock is required')
  const packages = [],
    errors = [],
    omittedOptional = []
  for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!path.includes('node_modules/') || entry.link || entry.extraneous) continue
    if (path.split('/').some((x) => x === '..') || path.startsWith('/'))
      throw new Error('Unsafe lock package path')
    const dir = join(root, path),
      manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) {
      if (entry.optional) omittedOptional.push(path)
      else errors.push(`Required package is not installed: ${path}@${entry.version}`)
      continue
    }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    // npm aliases may intentionally have a different manifest name.
    if (pkg.version !== entry.version) {
      errors.push(
        `Installed version differs from lock: ${path} (${pkg.version} != ${entry.version})`,
      )
      continue
    }
    const name = pkg.name || packageName(path)
    let text
    try {
      text = licenseText(name, dir)
      // Preserve published variants not recognized by the shared dot-only matcher.
      const extra = readdirSync(dir, { withFileTypes: true })
        .filter((file) => file.isFile() && /^(LICENSE|LICENCE|COPYING)[_-]/i.test(file.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => readFileSync(join(dir, file.name), 'utf8').trim())
        .filter(Boolean)
      text = [...new Set([text, ...extra].filter(Boolean))].join('\n\n') || null
    } catch (error) {
      errors.push(`Unreadable license text: ${path}: ${error.message}`)
    }
    const supplemental = NOTE[name]
    // A copyright/SPDX summary is supplementary, not a replacement license.
    if (!text) errors.push(`Missing license text: ${path}@${pkg.version}`)
    const notices = []
    for (const file of ['NOTICE', 'NOTICE.txt', 'NOTICE.md']) {
      if (existsSync(join(dir, file))) {
        notices.push(readFileSync(join(dir, file), 'utf8').trim())
        break
      }
    }
    if (EXTRA_NOTICE[name]) {
      const file = join(root, EXTRA_NOTICE[name])
      if (existsSync(file)) notices.push(readFileSync(file, 'utf8').trim())
      else errors.push(`Missing supplemental notice: ${EXTRA_NOTICE[name]}`)
    }
    packages.push({
      path,
      name,
      version: pkg.version,
      license: pkg.license ?? null,
      text: text ?? null,
      supplemental,
      notices,
    })
  }
  return { packages, errors, omittedOptional }
}

export function rustInventory(root, run = execFileSync) {
  try {
    const raw = run(
      'cargo',
      [
        'metadata',
        '--offline',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        join(root, 'apps/sheets/native/xlsx-engine/Cargo.toml'),
      ],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const metadata = JSON.parse(raw),
      packages = [],
      errors = []
    for (const pkg of metadata.packages.filter((p) => p.source)) {
      const text = licenseText(pkg.name, dirname(pkg.manifest_path))
      if (!text) errors.push(`Missing native license text: ${pkg.name}@${pkg.version}`)
      packages.push({
        name: pkg.name,
        version: pkg.version,
        source: pkg.source,
        license: pkg.license,
        text,
      })
    }
    return { status: errors.length ? 'incomplete' : 'metadata-only', packages, errors }
  } catch (error) {
    return {
      status: 'incomplete',
      packages: [],
      errors: [`Offline locked Cargo metadata unavailable: ${error.message}`],
    }
  }
}
const hr = (title) => `\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n`
const GOTHIC_KR_COPYRIGHT = [
  'Copyright (c) 2010, NHN Corporation (http://www.nhncorp.com),',
  'with Reserved Font Name Nanum, Naver Nanum, NanumGothic, Naver ',
  'NanumGothic, NanumMyeongjo, Naver NanumMyeongjo, NanumBrush, Naver',
  'NanumBrush, NanumPen, Naver NanumPen.',
].join('\n')

/**
 * Bundled web/document fonts. KaTeX code remains separately covered by its
 * npm-package MIT notice above; its webfonts carry OFL terms.
 */
const FONTS = [
  [
    'Liberation Sans / Serif / Mono 2.1.5',
    'SIL OFL 1.1',
    'Digitized data © 2010 Google Corporation with Reserved Font Names Arimo, Tinos and Cousine.\n© 2012 Red Hat, Inc. with Reserved Font Name Liberation.',
  ],
  [
    'Carlito',
    'SIL OFL 1.1',
    '© 2010-2013 tyPoland Lukasz Dziedzic with Reserved Font Name "Carlito".',
  ],
  [
    'Caladea',
    'Apache-2.0',
    '© Huerta Tipográfica. Licensed under the Apache License, Version 2.0.',
  ],
  [
    'Noto Sans CJK SC / Noto Serif CJK SC (subset)',
    'SIL OFL 1.1',
    '© Adobe / Google. This bundle ships a subset of the original fonts (reduced glyph coverage for size);\nno other modifications were made.',
  ],
  [
    'GenOffice UI Kana JP (Noto Sans JP derivative)',
    'SIL OFL 1.1',
    'Source: Noto Sans JP from https://github.com/notofonts/noto-cjk. Copyright 2014-2021 Adobe\n(http://www.adobe.com/), with Reserved Font Name "Source". This bundle ships Regular and Bold\ninstances subset to U+3000-30FF, with modified advances and horizontally condensed outlines to\nmatch Meiryo UI metrics and vertical metrics set to the Hiragino class. Renamed to GenOffice UI\nKana JP per OFL 1.1; the upstream Reserved Font Name is not used.',
  ],
  [
    'GenOffice Sans KR (Noto Sans CJK KR derivative)',
    'SIL OFL 1.1',
    'Copyright 2014-2021 Adobe (http://www.adobe.com/), Google LLC, Reserved Font Name "Source".\nSubset with modified advance widths and horizontally transformed Noto CJK outlines to match measured\nKorean Office-family metrics; renamed per OFL 1.1. No Microsoft font outlines are included.',
  ],
  [
    'GenOffice Serif KR (Noto Serif CJK KR derivative)',
    'SIL OFL 1.1',
    'Copyright 2017-2024 Adobe (http://www.adobe.com/), Reserved Font Name "Source".\nSubset with modified advance widths and horizontally transformed Noto CJK outlines to match measured\nKorean Office-family metrics; renamed per OFL 1.1. No Microsoft font outlines are included.',
  ],
  [
    'GenOffice Che Latin KR (Noto Sans CJK KR derivative)',
    'SIL OFL 1.1',
    'Copyright 2014-2021 Adobe (http://www.adobe.com/), Google LLC, Reserved Font Name "Source".\nASCII subset with fixed 0.5em advances and horizontally transformed Noto CJK outlines; Microsoft\nDotumChe is used only as a metric reference. Renamed per OFL 1.1. No Microsoft outlines are included.',
  ],
  [
    'Noto Naskh Arabic / Noto Sans Arabic (subset)',
    'SIL OFL 1.1',
    '© The Noto Project Authors. This bundle ships a subset of the original fonts;\nglyphs and metrics are unmodified.',
  ],
  [
    'GenOffice Gothic KR (NanumGothic derivative)',
    'SIL OFL 1.1',
    `${GOTHIC_KR_COPYRIGHT}\nSubset with unmodified metrics; renamed per OFL 1.1.`,
  ],
  [
    'GenOffice Poppins (Poppins derivative)',
    'SIL OFL 1.1',
    'Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins).\nLatin subset with unmodified metrics and advances; renamed.',
  ],
  [
    'GenOffice DM Sans (DM Sans derivative)',
    'SIL OFL 1.1',
    'Copyright 2014-2017 Indian Type Foundry (info@indiantypefoundry.com). Copyright 2019 Google LLC.\nLatin subset with unmodified metrics and advances; renamed.',
  ],
  [
    'GenOffice Tamil (Noto Sans Tamil derivative)',
    'SIL OFL 1.1',
    '© The Noto Project Authors, original Reserved Font Name "Noto". Modified advance widths;\nrenamed per OFL 1.1.',
  ],
  [
    'GenOffice Bengali (Noto Sans Bengali derivative)',
    'SIL OFL 1.1',
    '© The Noto Project Authors, original Reserved Font Name "Noto". Modified advance widths;\nrenamed per OFL 1.1.',
  ],
  [
    'KaTeX webfonts',
    'SIL OFL 1.1',
    'Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)\n' +
      'Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>),\n' +
      'with Reserved Font Names KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, ' +
      'KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1, ' +
      'KaTeX_Size2, KaTeX_Size3, KaTeX_Size4, and KaTeX_Typewriter.',
  ],
]

export function generate(root = ROOT) {
  const inventory = inventoryInstalledPackages(
    root,
    JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')),
  )
  const native = rustInventory(root)
  let out = `DyOffice SaaS — Third-Party Inventory Notices\n\nNOT A FINAL DISTRIBUTION COMPLIANCE ATTESTATION.\nThis is a conservative installed-lock inventory including build/test dependencies.\nNative binary linkage, runtime image/OS notices and final artifact coverage remain unverified.\nNo Electron or installer configuration is used to generate this inventory.\n`
  for (const pkg of inventory.packages) {
    out += hr(`${pkg.name} ${pkg.version} [${pkg.path}]`)
    out += `${pkg.text ?? 'INCOMPLETE: LICENSE TEXT NOT AVAILABLE'}\n`
    if (pkg.supplemental) out += `\n${pkg.supplemental}\n`
    for (const notice of pkg.notices) out += `\nNOTICE:\n${notice}\n`
  }
  out += hr('Bundled fonts — retained source inventory')
  for (const [name, spdx, copyright] of FONTS) out += hr(`${name} — ${spdx}`) + copyright + '\n'
  out += readFileSync(join(root, 'apps/docs/src/renderer/fonts/LICENSE-OFL.txt'), 'utf8')
  out += hr('Apache-2.0 full license (including Caladea terms)')
  out += readFileSync(join(root, 'LICENSE'), 'utf8')
  out += hr('Unicode Character Database data')
  out +=
    'Retained attribution for Unicode 17.0.0 EquivalentUnifiedIdeograph.txt (2025-08-01), including historical generated radical mappings.\n'
  out += readFileSync(join(root, 'LICENSE-UNICODE.txt'), 'utf8')
  out += hr('XLSX Rust crates — offline locked metadata inventory')
  out += `Status: ${native.status}. This is not a verified native binary linkage inventory.\n`
  for (const pkg of native.packages)
    out +=
      hr(`${pkg.name} ${pkg.version} — ${pkg.license}`) +
      (pkg.text ?? 'INCOMPLETE: LICENSE TEXT NOT AVAILABLE') +
      '\n'
  const errors = [...inventory.errors]
  for (const term of ['@embedpdf/pdfium', 'Copyright 2014 PDFium Authors', 'Apache License']) {
    if (!out.includes(term)) errors.push(`Required PDFium notice term missing: ${term}`)
  }
  const report = {
    schemaVersion: 1,
    scope: 'installed-lock-superset',
    distributionReady: false,
    javascriptStatus: errors.length ? 'incomplete' : 'inventoried',
    packages: inventory.packages.map(({ text, notices, supplemental, ...pkg }) => pkg),
    omittedOptional: inventory.omittedOptional,
    errors,
    native: { ...native, packages: native.packages.map(({ text, ...pkg }) => pkg) },
    outstanding: [
      'Map final shipped JavaScript/font/PDF assets to this inventory',
      'Verify all native binaries, Rust/WASM dependencies, runtime image and OS license notices',
    ],
  }
  const dest = join(root, 'artifacts/notices')
  mkdirSync(dest, { recursive: true })
  writeFileSync(join(dest, 'THIRD-PARTY-INVENTORY.txt'), out)
  writeFileSync(join(dest, 'inventory-status.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    `SaaS inventory written to artifacts/notices; JS=${report.javascriptStatus}; native=${native.status}; distributionReady=false`,
  )
  for (const error of errors) console.error(error)
  if (native.status === 'incomplete')
    console.warn(
      'Native inventory incomplete; see inventory-status.json. No final distribution approval is implied.',
    )
  return report
}
export function inventoryExitCode(report) {
  return report.errors.length || report.native.status === 'incomplete' ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = inventoryExitCode(generate())
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
