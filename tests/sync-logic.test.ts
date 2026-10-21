/**
 * Сторож синхронизации логики (docs/superpowers/specs/2026-10-21-architecture.md,
 * раздел «Что переносится из run-game и как»).
 *
 * Манифест — единственный источник правды о том, какие файлы в `src/core`
 * считаются перенесёнными и какой у них должен быть хеш. Три проверки ниже
 * ловят три разных способа разъехаться: файл в `core`, которого манифест не
 * знает (или наоборот); хеш, не совпадающий с содержимым; и явную правку
 * скопированного файла.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { checkAgainst } from '../tools/sync-logic.mjs'

const ROOT = join(__dirname, '..')
const CORE_DIR = join(ROOT, 'src/core')
const MANIFEST_PATH = join(CORE_DIR, 'logic.manifest.json')

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

const manifest: Record<string, string> = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

test('манифест перечисляет все файлы core', () => {
  expect(Object.keys(manifest).sort()).toEqual(
    readdirSync(CORE_DIR).filter((f) => f.endsWith('.js')).sort(),
  )
})

test('хеши совпадают с содержимым', () => {
  for (const [f, hash] of Object.entries(manifest)) {
    expect(sha256(readFileSync(join(CORE_DIR, f)))).toBe(hash)
  }
})

test('правка копии ловится проверкой', () => {
  expect(checkAgainst({ 'util.js': 'deadbeef' }).ok).toBe(false)
})
