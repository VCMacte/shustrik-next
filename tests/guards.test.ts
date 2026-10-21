/**
 * Сторож развилки «3D или 2.5D» (docs/superpowers/specs/2026-10-21-architecture.md).
 *
 * `src/core` и `src/render/compose.ts` — описание сцены, общее для обоих
 * способов вывода. Если туда проникнет `three` — хоть прямо, хоть транзитом
 * через локальный модуль, который сам тянет `three` — описание перестанет
 * быть описанием: один из способов вывода станет приватной правдой другого,
 * и сравнивать их станет нечем.
 */
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { expect, test } from 'vitest'

const ROOT = join(__dirname, '..')

/** Рекурсивно собирает пути всех файлов под `dir` (пустой список, если нет). */
function listFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      files.push(...listFiles(full))
    } else {
      files.push(full)
    }
  }
  return files
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false
}

// ───────────────────── «core и compose не знают про three» ─────────────────

/**
 * Собирает спецификаторы импорта из файла: обычный `import ... from 'x'`,
 * `export ... from 'x'`, безэффектный `import 'x'`, динамический
 * `import('x')` и `require('x')`. Константа «ни прямо, ни транзитивно»
 * требует ловить все формы, которыми `three` может попасть в файл, а не
 * только самую частую.
 */
function extractImportSpecifiers(content: string): string[] {
  const specs: string[] = []
  const staticImport = /\b(?:import|export)\b[^'";]*?\sfrom\s+['"]([^'"]+)['"]/g
  const sideEffectImport = /\bimport\s+['"]([^'"]+)['"]/g
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  const requireCall = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [staticImport, sideEffectImport, dynamicImport, requireCall]) {
    for (const m of content.matchAll(re)) specs.push(m[1])
  }
  return specs
}

/** `three` сам и любой его подпуть (`three/examples/...`), но не похожие имена. */
function isThreeSpecifier(spec: string): boolean {
  return spec === 'three' || spec.startsWith('three/')
}

test('детектор импортов three: прямые формы и созвучные имена не путаются', () => {
  expect(extractImportSpecifiers("import * as THREE from 'three'")).toContain('three')
  expect(extractImportSpecifiers("import 'three'")).toContain('three')
  expect(extractImportSpecifiers("const t = await import('three')")).toContain('three')
  expect(extractImportSpecifiers("const t = require('three')")).toContain('three')
  expect(
    extractImportSpecifiers("export { Scene } from 'three/examples/jsm/Scene.js'"),
  ).toContain('three/examples/jsm/Scene.js')
  // Комментарий и созвучный пакет не должны давать ложного срабатывания.
  expect(extractImportSpecifiers('// про three тут только слова')).toEqual([])
  expect(extractImportSpecifiers("import x from 'threejs-helpers'")).toContain(
    'threejs-helpers',
  )

  expect(isThreeSpecifier('three')).toBe(true)
  expect(isThreeSpecifier('three/examples/jsm/loaders/GLTFLoader.js')).toBe(true)
  expect(isThreeSpecifier('threejs-helpers')).toBe(false)
  expect(isThreeSpecifier('./three-helpers')).toBe(false)
})

/** Разрешает относительный спецификатор в существующий файл (как Node/ESM, но без node_modules). */
function resolveRelativeImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = join(dirname(fromFile), spec)
  const candidates = [base, `${base}.js`, `${base}.ts`, join(base, 'index.js'), join(base, 'index.ts')]
  return candidates.find(isFile)
}

/**
 * Обходит граф импортов от `entry` и возвращает цепочку файлов/спецификаторов
 * до первого найденного `three`, либо `undefined`, если `three` недостижим.
 * Цепочка нужна в сообщении об ошибке: «где-то импортируется three» не
 * экономит час на поиск — конкретный путь экономит.
 */
function findThreeImportChain(entry: string): string[] | undefined {
  const visited = new Set<string>()

  function walk(file: string, path: string[]): string[] | undefined {
    if (visited.has(file)) return undefined
    visited.add(file)
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
    for (const spec of extractImportSpecifiers(content)) {
      if (isThreeSpecifier(spec)) return [...path, file, spec]
      const resolved = resolveRelativeImport(file, spec)
      if (resolved) {
        const deeper = walk(resolved, [...path, file])
        if (deeper) return deeper
      }
    }
    return undefined
  }

  return walk(entry, [])
}

test('core и compose не знают про three — ни прямо, ни транзитивно', () => {
  const entryPoints = [
    ...listFiles(join(ROOT, 'src/core')),
    join(ROOT, 'src/render/compose.ts'),
  ].filter(isFile)

  for (const entry of entryPoints) {
    const chain = findThreeImportChain(entry)
    if (chain) {
      // Бросаем явно, а не через expect(...).toBeUndefined(): сообщение
      // должно нести цепочку файлов, а не только факт «что-то не так».
      throw new Error(`three достижим из ${entry} по цепочке: ${chain.join(' -> ')}`)
    }
  }
})

test('логика не переведена на TypeScript', () => {
  const core = readdirSync(join(ROOT, 'src/core'))
  expect(core.length).toBeGreaterThan(0)
  expect(core.every((f) => f.endsWith('.js') || f === '.gitkeep')).toBe(true)
})

/**
 * Без этой проверки предыдущий тест вечнозелен впустую: пока `src/render`
 * не существует, `compose.ts` в списке целей выше отфильтровывается, и
 * «core и compose не знают про three» в своей compose-половине проверяет
 * один `.gitkeep`. Если `compose.ts` когда-нибудь появится под другим именем
 * (например `src/render/compose/index.ts`), страж об этом не узнает НИКОГДА
 * — зелёный тест при нулевом покрытии неотличим от зелёного теста при
 * полном. Эта проверка привязывает факт к родительской папке: пока
 * `src/render` не существует — ждать нечего; если он уже существует —
 * `compose.ts` обязан быть на месте.
 */
test('src/render/compose.ts существует, если уже существует src/render', () => {
  const renderDirExists = statSync(join(ROOT, 'src/render'), { throwIfNoEntry: false })?.isDirectory() ?? false
  if (!renderDirExists) return
  expect(isFile(join(ROOT, 'src/render/compose.ts'))).toBe(true)
})

// ───────────────── стык со старым Canvas2D-рендерером (view/preview) ──────

/**
 * `view.js` и `preview.js` — старый Canvas2D-рендерер, который приедет в
 * Task 2 только потому, что от него зависят `level.js` и `train.js`. Новая
 * отрисовка не должна знать об этих файлах НИГДЕ, кроме одного стыка —
 * `src/render/numbers.ts`, которого пока не существует.
 *
 * Разовая проверка файлом-нарушителем от регресса самой регулярки не
 * защищает: сторож, который ничего не ловит, выглядит как зелёный тест
 * («всё сошлось» при нуле новых проверок выглядит так же, как при восьми).
 */
const IMPORTS_OLD_RENDERER = /from\s+['"][^'"]*\/(view|preview)(\.js)?['"]/

test('регулярка стыка со старым рендерером ловит настоящую строку импорта', () => {
  expect(IMPORTS_OLD_RENDERER.test("import { draw } from '../core/view.js'")).toBe(true)
  expect(IMPORTS_OLD_RENDERER.test("import { draw } from '../core/view'")).toBe(true)
  expect(IMPORTS_OLD_RENDERER.test("import { paint } from './preview.js'")).toBe(true)
  // Похожие имена не должны ловиться по совпадению подстроки.
  expect(IMPORTS_OLD_RENDERER.test("import { x } from '../core/viewport.js'")).toBe(false)
  expect(IMPORTS_OLD_RENDERER.test("import { x } from './previewCard'")).toBe(false)
  expect(IMPORTS_OLD_RENDERER.test("// про view и preview здесь только слова")).toBe(false)
})

test('только src/render/numbers.ts может знать про старый рендерер view.js и preview.js', () => {
  const chokepoint = join(ROOT, 'src/render/numbers.ts')
  // .js/.mjs — потому что Task 2 привозит копии логики как .js, и файл под
  // src/render тоже может оказаться .js/.mjs, а не только .ts/.tsx.
  const RENDER_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs']
  const renderFiles = listFiles(join(ROOT, 'src/render')).filter(
    (f) => RENDER_EXTENSIONS.some((ext) => f.endsWith(ext)) && f !== chokepoint,
  )

  const violations: string[] = []
  for (const file of renderFiles) {
    if (IMPORTS_OLD_RENDERER.test(readFileSync(file, 'utf8'))) {
      violations.push(file)
    }
  }

  expect(violations).toEqual([])
})
