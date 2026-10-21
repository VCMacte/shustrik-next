/**
 * Таблица ассетов СЧИТАЕТСЯ из `.glb`, а не пишется руками (Task 4).
 *
 * Руками написанная таблица — это вторая копия того, что уже лежит в файле
 * модели, и расходится она МОЛЧА: художник добавил материал, вызовов стало
 * два, а бюджет по-прежнему считает один — и чем сложнее арт, тем сильнее
 * бюджет врёт ВНИЗ. Поэтому единственный владелец чисел — сам `.glb`, а
 * `assets/manifest.json` только пересчитывается из него.
 *
 * Читается ТОЛЬКО JSON-чанк: ни вершины, ни вызовы в двоичных данных не
 * лежат, а картинок на диске может ещё не быть вовсе.
 *
 * Запуск: `node tools/asset-stat.mjs` — перезаписывает `assets/manifest.json`.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const GLTF_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a

/**
 * Байты в видеопамяти под одну текстуру.
 *
 * Формат, а не файл: на устройстве текстура лежит РАСПАКОВАННОЙ, и 300 КБ
 * PNG занимают 16 МБ, если это 2048² RGBA. Именно это число упирается в
 * потолок «текстурная память ≤ 96 МБ» (спека, раздел бюджетов), а размер
 * файла — в другой потолок, офлайн-комплект ≤ 100 МБ.
 *
 * Множитель 1.34 — сумма геометрической прогрессии мип-пирамиды
 * (1 + 1/4 + 1/16 + …→ 4/3), округлённая вверх до двух знаков, как записано
 * в плане. Своего числа здесь не заводится.
 */
export function texBytesOf({ width, height, format, mipmaps }) {
  const perPixel = BYTES_PER_PIXEL[format]
  if (perPixel == null) {
    throw new Error(`неизвестный формат текстуры: ${format}`)
  }
  const base = width * height * perPixel
  return Math.round(mipmaps ? base * 1.34 : base)
}

/**
 * Байт на пиксель по формату. ASTC 4×4 — это 128 бит на блок 4×4 пикселя,
 * то есть ровно один байт на пиксель; несжатая RGBA — четыре.
 */
const BYTES_PER_PIXEL = {
  rgba8: 4,
  astc4x4: 1,
}

/**
 * JSON-чанк контейнера, разобранный и проверенный.
 *
 * Отдельно от `readGlbStats`, потому что про `.glb` нужно знать не только
 * бюджетное: сторож ссылок на картинки читает `images[].uri`, а второго
 * разборщика контейнера в проекте быть не должно — он разошёлся бы с первым
 * молча, как и всякая вторая копия здесь.
 *
 * @param {Buffer|Uint8Array} input
 */
export function readGlbJson(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)

  // Все отказы ниже — ЯВНЫЕ и названные. «Не glTF» молча, с нулём вершин,
  // сделало бы бюджет тем оптимистичнее, чем больше в сцене испорченных
  // файлов (Review Focus, Task 4).
  if (buf.length < 12) throw new Error('не glTF: файл короче заголовка')
  if (buf.readUInt32LE(0) !== GLTF_MAGIC) throw new Error('не glTF: нет подписи glTF')
  const version = buf.readUInt32LE(4)
  if (version !== 2) throw new Error(`не glTF 2.0: версия контейнера ${version}`)
  if (buf.readUInt32LE(8) !== buf.length) {
    throw new Error(
      `битый glTF: заявленная длина ${buf.readUInt32LE(8)} не совпала с размером файла ${buf.length}`,
    )
  }
  if (buf.length < 20) throw new Error('битый glTF: нет заголовка первого чанка')

  const chunkLen = buf.readUInt32LE(12)
  if (buf.readUInt32LE(16) !== CHUNK_JSON) {
    throw new Error('битый glTF: первый чанк обязан быть JSON')
  }
  if (20 + chunkLen > buf.length) {
    throw new Error(`битый glTF: JSON-чанк длиной ${chunkLen} не влезает в файл`)
  }

  try {
    return JSON.parse(buf.toString('utf8', 20, 20 + chunkLen))
  } catch (e) {
    throw new Error(`битый glTF: JSON-чанк не разбирается (${e.message})`)
  }
}

/**
 * Разбирает `.glb` и отдаёт то, и только то, по чему судит бюджет.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{
 *   primitives: {material: string, verts: number}[],
 *   textures: {name: string, width: number, height: number, format: string, mipmaps: boolean}[],
 * }}
 */
export function readGlbStats(input) {
  const json = readGlbJson(input)

  const accessors = json.accessors ?? []
  const materials = json.materials ?? []

  const primitives = []
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      const pos = p.attributes?.POSITION
      if (pos == null || accessors[pos] == null) {
        throw new Error(`битый glTF: у примитива меша ${mesh.name ?? '?'} нет POSITION`)
      }
      primitives.push({
        // Имя материала, а не его индекс: манифест читают глазами, и
        // «body/glow» объясняет два вызова, а «0/1» — нет.
        material: materials[p.material]?.name ?? '',
        verts: accessors[pos].count,
      })
    }
  }

  const textures = (json.images ?? []).map((img) => {
    const x = img.extras
    if (!x || x.width == null || x.height == null || x.format == null) {
      throw new Error(
        `битый glTF: у картинки ${img.name ?? img.uri ?? '?'} нет метаданных формата`,
      )
    }
    return {
      name: img.name ?? img.uri,
      width: x.width,
      height: x.height,
      format: x.format,
      mipmaps: !!x.mipmaps,
    }
  })

  return { primitives, textures }
}

/**
 * Статистика → строка манифеста. `calls` — число ПРИМИТИВОВ, а не мешей:
 * каждый примитив со своим материалом — отдельный вызов отрисовки, и именно
 * на этом счёт мешей врал бы вниз.
 */
export function manifestEntry(stats) {
  return {
    calls: stats.primitives.length,
    verts: stats.primitives.reduce((sum, p) => sum + p.verts, 0),
    texBytes: stats.textures.reduce((sum, t) => sum + texBytesOf(t), 0),
  }
}

/**
 * Все `.glb` под `dir`, рекурсивно. Возвращает имена ассетов (без `.glb`).
 *
 * Экспортируется затем, чтобы сторож ссылок обходил ФАЙЛЫ НА ДИСКЕ, а не
 * таблицу в коде: таблица один раз уже была неправа (44 битые ссылки из 44),
 * и тест, выведенный из неё, повторил бы ту же ошибку.
 */
export function listGlb(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listGlb(full, prefix ? posix.join(prefix, entry) : entry))
    } else if (entry.endsWith('.glb')) {
      const id = entry.slice(0, -'.glb'.length)
      out.push({ id: prefix ? posix.join(prefix, id) : id, file: full })
    }
  }
  return out
}

/**
 * Манифест по папке с заглушками. Ключи отсортированы: манифест лежит под
 * гитом, и порядок обхода файловой системы не должен давать диff.
 *
 * @returns {Record<string, {calls: number, verts: number, texBytes: number}>}
 */
export function buildManifest(dir = join(ROOT, 'assets')) {
  const manifest = {}
  for (const { id, file } of listGlb(dir)) {
    try {
      manifest[id] = manifestEntry(readGlbStats(readFileSync(file)))
    } catch (e) {
      // Имя файла в сообщении: «битый glTF» без имени стоит час поиска.
      throw new Error(`${file.split(sep).join('/')}: ${e.message}`)
    }
  }
  return Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(ROOT, 'assets')
  const manifest = buildManifest(dir)
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const total = Object.values(manifest).reduce(
    (a, e) => ({
      calls: a.calls + e.calls,
      verts: a.verts + e.verts,
      texBytes: a.texBytes + e.texBytes,
    }),
    { calls: 0, verts: 0, texBytes: 0 },
  )
  console.log(
    `ассетов: ${Object.keys(manifest).length}; суммарно вызовов ${total.calls}, ` +
      `вершин ${total.verts}, текстур ${(total.texBytes / 1024 / 1024).toFixed(1)} МБ`,
  )
}
