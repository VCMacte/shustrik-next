/**
 * Сторож копий логики (docs/superpowers/specs/2026-10-21-architecture.md,
 * раздел «Что переносится из run-game и как»).
 *
 * Файлы в `src/core` — побайтовые копии из `run-game`, и правка здесь
 * запрещена: математика проверена 3863 проверками и десятью журналами с
 * ребёнком, а хеш — единственный способ заметить, что копия и оригинал
 * разошлись, не читая оба файла целиком при каждой проверке.
 *
 * `--check` сверяет текущие файлы `src/core` с манифестом и падает с кодом
 * 1, если что-то разошлось — печатая, какие именно файлы, а не просто факт
 * расхождения: экономия часа на диагностику важнее краткости вывода.
 * `--from <путь>` перекопирует 23 файла из клона run-game и пересчитывает
 * манифест — используется, когда логика в run-game была осознанно изменена.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CORE_DIR = join(ROOT, 'src/core')
export const MANIFEST_PATH = join(CORE_DIR, 'logic.manifest.json')

// 23 файла: 21, названные в брифе, плюс view.js и preview.js — без них граф
// импортов не замыкается (level.js и train.js берут из них имена).
export const TRACKED_FILES = [
  'util.js',
  'config.js',
  'theme.js',
  'signals.js',
  'calibrate.js',
  'level.js',
  'difficulty.js',
  'awards.js',
  'text.js',
  'audio.js',
  'log.js',
  'players.js',
  'settings.js',
  'camera.js',
  'pose.js',
  'pose.camera.js',
  'pose.worker.js',
  'pose.engine.js',
  'pose.pack.js',
  'fake-pose.js',
  'train.js',
  'view.js',
  'preview.js',
]

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
}

/**
 * Сравнивает переданный манифест с фактическим содержимым `src/core`.
 * Расхождение бывает двух родов, и оба — расхождение: контент под известным
 * именем не совпадает по хешу, ИЛИ множество имён разъехалось (файл добавлен
 * в `core`, но не в манифест, либо наоборот) — молчаливая правка тоже может
 * выглядеть как «просто новый файл», и сторож обязан увидеть и это.
 */
export function checkAgainst(manifest) {
  const actualFiles = readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'))
  const manifestFiles = Object.keys(manifest)
  const drifted = new Set()

  for (const f of actualFiles) {
    if (!manifestFiles.includes(f)) {
      drifted.add(f) // файл есть в core, но манифест о нём не знает
      continue
    }
    let actualHash
    try {
      actualHash = sha256(readFileSync(join(CORE_DIR, f)))
    } catch {
      drifted.add(f)
      continue
    }
    if (actualHash !== manifest[f]) drifted.add(f)
  }
  for (const f of manifestFiles) {
    if (!actualFiles.includes(f)) drifted.add(f) // манифест знает файл, которого нет в core
  }

  return { ok: drifted.size === 0, drifted: [...drifted].sort() }
}

/** Перекопирует TRACKED_FILES из клона run-game байт в байт и пересчитывает манифест. */
function copyFrom(runGamePath) {
  mkdirSync(CORE_DIR, { recursive: true })
  const manifest = {}
  for (const f of TRACKED_FILES) {
    const src = join(runGamePath, 'js', f)
    const dest = join(CORE_DIR, f)
    copyFileSync(src, dest) // копия бинарного уровня — никаких текстовых трансформаций
    manifest[f] = sha256(readFileSync(dest))
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

function main() {
  const args = process.argv.slice(2)
  const fromIdx = args.indexOf('--from')

  if (fromIdx !== -1) {
    const runGamePath = args[fromIdx + 1]
    if (!runGamePath) {
      console.error('--from требует путь к клону run-game')
      process.exitCode = 1
      return
    }
    const manifest = copyFrom(runGamePath)
    console.log(`Скопировано файлов: ${Object.keys(manifest).length}`)
    return
  }

  if (args.includes('--check')) {
    const manifest = readManifest()
    const { ok, drifted } = checkAgainst(manifest)
    if (ok) {
      console.log('src/core совпадает с манифестом, расхождений нет')
      process.exitCode = 0
    } else {
      console.error('Расхождение с манифестом в файлах:')
      for (const f of drifted) console.error(`  - ${f}`)
      process.exitCode = 1
    }
    return
  }

  console.error('Использование: node tools/sync-logic.mjs --check | --from <путь к run-game>')
  process.exitCode = 1
}

// pathToFileURL кодирует путь (пробелы -> %20) так же, как делает Node для
// import.meta.url — прямая сборка строки `file://${argv[1]}` расходится с
// ней на путях с пробелами (частый случай на Windows) и main() не запускался.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
