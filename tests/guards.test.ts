/**
 * Сторож развилки «3D или 2.5D» (docs/superpowers/specs/2026-10-21-architecture.md).
 *
 * `src/core` и `src/render/compose.ts` — описание сцены, общее для обоих
 * способов вывода. Если туда проникнет `three`, описание перестанет быть
 * описанием: один из способов вывода станет приватной правдой другого, и
 * сравнивать их станет нечем.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

test('core и compose не знают про three', () => {
  const targets = [
    ...listFiles(join(ROOT, 'src/core')),
    join(ROOT, 'src/render/compose.ts'),
  ].filter((f) => statSync(f, { throwIfNoEntry: false })?.isFile())

  for (const f of targets) {
    expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+['"]three/)
  }
})

test('логика не переведена на TypeScript', () => {
  const core = readdirSync(join(ROOT, 'src/core'))
  expect(core.length).toBeGreaterThan(0)
  expect(core.every((f) => f.endsWith('.js') || f === '.gitkeep')).toBe(true)
})

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
  const renderFiles = listFiles(join(ROOT, 'src/render')).filter(
    (f) => f.endsWith('.ts') && f !== chokepoint,
  )

  const violations: string[] = []
  for (const file of renderFiles) {
    if (IMPORTS_OLD_RENDERER.test(readFileSync(file, 'utf8'))) {
      violations.push(file)
    }
  }

  expect(violations).toEqual([])
})
