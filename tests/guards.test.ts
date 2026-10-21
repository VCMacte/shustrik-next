/**
 * Сторож развилки «3D или 2.5D» (docs/superpowers/specs/2026-10-21-architecture.md).
 *
 * `src/core` и `src/render/compose.ts` — описание сцены, общее для обоих
 * способов вывода. Если туда проникнет `three` — хоть прямо, хоть транзитом
 * через локальный модуль, который сам тянет `three` — описание перестанет
 * быть описанием: один из способов вывода станет приватной правдой другого,
 * и сравнивать их станет нечем.
 */
import { dirname, join, sep } from 'node:path'
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
  // logic.manifest.json (Task 2, tools/sync-logic.mjs) — не логика и не её
  // перевод на TypeScript, а хеши самих .js-копий; исключение того же рода,
  // что .gitkeep до их приезда, а не ослабление проверки.
  expect(
    core.every((f) => f.endsWith('.js') || f === '.gitkeep' || f === 'logic.manifest.json'),
  ).toBe(true)
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
 * Task 2 только потому, что от него зависят `level.js` и `train.js`. Ничто
 * под `src/` не должно знать об этих файлах НИГДЕ, кроме одного стыка —
 * `src/render/numbers.ts` (решение и его стоимость — в разделе «Что
 * переносится...» спеки), которого пока не существует.
 *
 * Матчер строгости не ниже, чем у `three`-стража выше: та же
 * `extractImportSpecifiers`, а не вторая, более слабая регулярка на одну
 * форму импорта. Старый матчер ловил только `from '…/view'` и пропускал
 * безэффектный `import '…/view.js'` и динамический `import('…/view.js')`.
 */
function isOldRendererSpecifier(spec: string): boolean {
  return /\/(view|preview)(\.js)?$/.test(spec)
}

test('матчер стыка со старым рендерером ловит все формы импорта и не путает созвучные имена', () => {
  expect(extractImportSpecifiers("import { draw } from '../core/view.js'")).toContain(
    '../core/view.js',
  )
  expect(extractImportSpecifiers("import '../core/view.js'")).toContain('../core/view.js')
  expect(extractImportSpecifiers("await import('../core/preview.js')")).toContain(
    '../core/preview.js',
  )
  expect(extractImportSpecifiers("require('./preview.js')")).toContain('./preview.js')

  expect(isOldRendererSpecifier('../core/view.js')).toBe(true)
  expect(isOldRendererSpecifier('../core/view')).toBe(true)
  expect(isOldRendererSpecifier('./preview.js')).toBe(true)
  // Похожие имена не должны ловиться по совпадению подстроки.
  expect(isOldRendererSpecifier('../core/viewport.js')).toBe(false)
  expect(isOldRendererSpecifier('./previewCard')).toBe(false)
})

test('только src/render/numbers.ts может знать про старый рендерер view.js и preview.js', () => {
  const chokepoint = join(ROOT, 'src/render/numbers.ts')
  // src/core исключён намеренно, а не по забывчивости: это старая логика
  // run-game, и level.js/train.js уже напрямую импортируют view.js/preview.js
  // в самом run-game — та же проводка приезжает сюда копией и остаётся
  // законной (решение и его цена — в спеке, раздел «Что переносится...»).
  // Стык закрывает НОВЫЙ код: comment и решение говорят «нигде», и раньше
  // область была уже src/render, хотя src/shell/** и src/adapters/** ничем
  // не были защищены — область расширена на весь src/ кроме src/core.
  const core = join(ROOT, 'src/core')
  const SCOPED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs']
  const scopedFiles = listFiles(join(ROOT, 'src')).filter(
    (f) =>
      SCOPED_EXTENSIONS.some((ext) => f.endsWith(ext)) &&
      f !== chokepoint &&
      !f.startsWith(core + sep),
  )

  const violations: string[] = []
  for (const file of scopedFiles) {
    const specs = extractImportSpecifiers(readFileSync(file, 'utf8'))
    if (specs.some(isOldRendererSpecifier)) {
      violations.push(file)
    }
  }

  expect(violations).toEqual([])
})

// ───────── числа, скопированные из копий логики в src/render ─────────────

/**
 * Два числа нового вывода объявлены в `src/render/types.ts` своими, но взяты
 * из `run-game`: высота стен (`CORRIDOR_H_M`, в копии это НЕэкспортируемая
 * `const WALL = 2.6`) и выверенный на ребёнке множитель приседа
 * (`CROUCH_PITCH_GAIN`, в копии — `VIEW.pitchGain`).
 *
 * Своими они стали осознанно: `WALL` наружу не отдаётся вовсе, а `pitchGain`
 * в старом выводе значит ДРУГОЕ — он масштабирует высоту глаз
 * (`view.js:125`), а не наклон. Но «владелец теперь здесь» не значит «пусть
 * расходятся молча»: `tools/sync-logic.mjs` однажды привезёт копию с другими
 * числами, и узнать об этом нужно в тот же день, а не на телевизоре.
 *
 * Проверка нарочно дешёвая: текст копии и значение из неё же. Соседний клон
 * `run-game` и доступ в CI ей не нужны.
 */
test('числа, продублированные в src/render, ещё совпадают с копиями логики', async () => {
  const view = readFileSync(join(ROOT, 'src/core/view.js'), 'utf8')
  const types = readFileSync(join(ROOT, 'src/render/types.ts'), 'utf8')

  // Высота стен: в копии — литерал, наружу не экспортируется.
  expect(view).toMatch(/^const WALL = 2\.6;/m)
  expect(types).toMatch(/^export const CORRIDOR_H_M = 2\.6$/m)

  const { VIEW } = await import('../src/core/config.js')
  expect(VIEW.pitchGain).toBe(0.55)
  expect(types).toMatch(/^export const CROUCH_PITCH_GAIN = 0\.55$/m)
})
