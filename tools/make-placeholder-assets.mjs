/**
 * Программные ЗАГЛУШКИ арта: валидные `.glb` нужной сложности, без картинок.
 *
 * ПОЧЕМУ они вообще есть. Task 4 (таблица ассетов) и Task 5 (бюджет кадра)
 * без хотя бы одного `.glb` не делаются, а настоящего арта ещё нет и до
 * ответа на развилку «3D или 2.5D» он не нужен: Easy Diffusion отдаёт PNG и
 * мешей не умеет, а TRELLIS 2 и Hunyuan3D просят 24 ГБ видеопамяти против 12
 * у этой машины. При этом `estimate` и `renderer.stats()` читают РОВНО три
 * вещи: число примитивов, `accessors[POSITION].count` и метаданные формата
 * текстуры. Значит заглушка нужной сложности даёт бюджету именно то, что он
 * считает, — а цена допущения записана в `docs/art-placeholders.md` и не
 * замалчивается: бюджет до прихода настоящего арта ПРЕДВАРИТЕЛЕН.
 *
 * ПОЧЕМУ список ассетов выводится из данных, а не пишется руками. В этом
 * проекте руками написанный второй список разъезжался уже дважды (разбор — у
 * `LOOKS` в `src/core/level.js` и у `kindsFor` в `src/core/theme.js`, где по
 * той же причине перечни ВЫВОДЯТСЯ). Имена берутся из `LOOKS`, `WORLDS` и
 * `THEME[zone].decor.kinds`, то есть из тех же данных, по которым
 * `composeScene` строит имя ассета, — разъехаться им негде.
 *
 * ПОЧЕМУ писатель побайтово повторяем. `.glb` лежат под гитом. Любая
 * временная метка или неустойчивое форматирование числа дали бы шумный диff
 * по двоичным файлам при каждом перезапуске, и настоящее изменение геометрии
 * в нём было бы не видно.
 *
 * Запуск: `node tools/make-placeholder-assets.mjs`
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOOKS } from '../src/core/level.js'
import { THEME, WORLDS } from '../src/core/theme.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// ─────────────────────────── генераторы геометрии ─────────────────────────
//
// Все они нормированы в ЕДИНИЦУ по каждой оси и ставят начало координат в
// ОСНОВАНИЕ — ровно так, как это записано договором об именах в
// `src/render/types.ts`. Отступление от договора здесь означало бы, что
// `size` размещения растягивает модель не туда, и заметно это стало бы
// только на телевизоре.

/** Коробка: 24 вершины (по четыре на грань — чтобы нормали были плоскими). */
export function box({ w = 1, h = 1, d = 1 } = {}) {
  const x = w / 2
  const z = d / 2
  const faces = [
    // [нормаль, четыре угла по часовой от нижнего левого]
    [[0, 0, 1], [[-x, 0, z], [x, 0, z], [x, h, z], [-x, h, z]]],
    [[0, 0, -1], [[x, 0, -z], [-x, 0, -z], [-x, h, -z], [x, h, -z]]],
    [[1, 0, 0], [[x, 0, z], [x, 0, -z], [x, h, -z], [x, h, z]]],
    [[-1, 0, 0], [[-x, 0, -z], [-x, 0, z], [-x, h, z], [-x, h, -z]]],
    [[0, 1, 0], [[-x, h, z], [x, h, z], [x, h, -z], [-x, h, -z]]],
    [[0, -1, 0], [[-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z]]],
  ]
  return fromQuads(faces)
}

/**
 * Призма с правильным основанием: `sides` граней плюс две крышки.
 * Трёхгранная — самая дешёвая объёмная форма, которой Miracast не портит
 * силуэт: грани различаются светлотой, а не рамкой.
 */
export function prism({ sides = 3, r = 0.5, h = 1 } = {}) {
  const ring = []
  for (let i = 0; i < sides; i++) {
    // Фаза −90° — чтобы одна грань смотрела на игрока, а не ребро.
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2
    ring.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  const quads = []
  for (let i = 0; i < sides; i++) {
    const [ax, az] = ring[i]
    const [bx, bz] = ring[(i + 1) % sides]
    const nx = (ax + bx) / 2
    const nz = (az + bz) / 2
    const len = Math.hypot(nx, nz) || 1
    quads.push([
      [nx / len, 0, nz / len],
      [[ax, 0, az], [bx, 0, bz], [bx, h, bz], [ax, h, az]],
    ])
  }
  const g = fromQuads(quads)
  // Крышки — веером от первой вершины: `sides` вершин, а не `sides * 3`.
  for (const [y, ny] of [[h, 1], [0, -1]]) {
    const base = g.positions.length / 3
    for (let i = 0; i < sides; i++) {
      const [px, pz] = ring[i]
      g.positions.push(px, y, pz)
      g.normals.push(0, ny, 0)
      g.uv.push(px + 0.5, pz + 0.5)
    }
    for (let i = 1; i < sides - 1; i++) {
      if (ny > 0) g.indices.push(base, base + i, base + i + 1)
      else g.indices.push(base, base + i + 1, base + i)
    }
  }
  return g
}

/**
 * Плоскость в единицу. `plane: 'xy'` — стоячая (основание на полу),
 * `'xz'` — лежачая (пол коридора).
 */
export function quad({ plane = 'xy', w = 1, h = 1, yaw = 0 } = {}) {
  const x = w / 2
  if (plane === 'xz') {
    const z = h / 2
    return fromQuads([[[0, 1, 0], [[-x, 0, z], [x, 0, z], [x, 0, -z], [-x, 0, -z]]]])
  }
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const rot = (px, pz) => [px * c + pz * s, -px * s + pz * c]
  const [l0, l1] = rot(-x, 0)
  const [r0, r1] = rot(x, 0)
  const [n0, n1] = rot(0, 1)
  return fromQuads([
    [[n0, 0, n1], [[l0, 0, l1], [r0, 0, r1], [r0, h, r1], [l0, h, l1]]],
  ])
}

/**
 * Скрещённые плоскости — обычный приём для растительности: две вертикальные
 * плоскости под 90°, восемь вершин на весь куст. Дешевле любой объёмной
 * формы и через сжатие Miracast читается не хуже.
 */
export function crossQuads({ w = 1, h = 1 } = {}) {
  return merge([quad({ w, h, yaw: 0 }), quad({ w, h, yaw: Math.PI / 2 })])
}

/** Тор: кольцо. `(radial + 1) * (tubular + 1)` вершин, шов продублирован. */
export function torus({ radial = 12, tubular = 6, r = 0.4, tube = 0.1 } = {}) {
  const positions = []
  const normals = []
  const uv = []
  const indices = []
  for (let i = 0; i <= radial; i++) {
    const u = (i / radial) * Math.PI * 2
    for (let j = 0; j <= tubular; j++) {
      const v = (j / tubular) * Math.PI * 2
      const cu = Math.cos(u)
      const su = Math.sin(u)
      const cv = Math.cos(v)
      // Кольцо стоит В ПЛОСКОСТИ XY: ребёнок пролетает СКВОЗЬ него, а не
      // над ним, значит дырка смотрит вдоль коридора.
      positions.push((r + tube * cv) * cu, (r + tube * cv) * su + r + tube, tube * Math.sin(v))
      normals.push(cv * cu, cv * su, Math.sin(v))
      uv.push(i / radial, j / tubular)
    }
  }
  for (let i = 0; i < radial; i++) {
    for (let j = 0; j < tubular; j++) {
      const a = i * (tubular + 1) + j
      const b = a + tubular + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return { positions, normals, uv, indices }
}

/** Полусфера, основанием на полу: светлячок, купол. */
export function dome({ segments = 8, rings = 4, r = 0.5 } = {}) {
  const positions = []
  const normals = []
  const uv = []
  const indices = []
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * (Math.PI / 2)
    for (let j = 0; j <= segments; j++) {
      const th = (j / segments) * Math.PI * 2
      const nx = Math.cos(phi) * Math.cos(th)
      const ny = Math.sin(phi)
      const nz = Math.cos(phi) * Math.sin(th)
      positions.push(nx * r, ny * r, nz * r)
      normals.push(nx, ny, nz)
      uv.push(j / segments, i / rings)
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j
      const b = a + segments + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return { positions, normals, uv, indices }
}

/**
 * Перевёрнутая цилиндрическая полоса — небо. Нормали внутрь: смотрят на
 * игрока, который стоит в середине. Две вершины на сегмент, то есть всё
 * небо — пятьдесят вершин при 24 сегментах.
 */
export function cylinderBand({ segments = 24, r = 0.5, h = 1 } = {}) {
  const positions = []
  const normals = []
  const uv = []
  const indices = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const cx = Math.cos(a)
    const cz = Math.sin(a)
    for (const y of [0, h]) {
      positions.push(cx * r, y, cz * r)
      normals.push(-cx, 0, -cz)
      uv.push(i / segments, y === 0 ? 1 : 0)
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2
    // Порядок обхода вывернут вместе с нормалями: иначе полоса видна только
    // снаружи, а изнутри её отсекает back-face culling — то есть небо есть,
    // но его нет.
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  return { positions, normals, uv, indices }
}

/** Четырёхугольники → геометрия: по четыре вершины на грань, две тройки. */
function fromQuads(faces) {
  const positions = []
  const normals = []
  const uv = []
  const indices = []
  const CORNER_UV = [[0, 1], [1, 1], [1, 0], [0, 0]]
  for (const [n, corners] of faces) {
    const base = positions.length / 3
    for (let i = 0; i < 4; i++) {
      positions.push(...corners[i])
      normals.push(...n)
      uv.push(...CORNER_UV[i])
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return { positions, normals, uv, indices }
}

/** Склейка геометрий в ОДИН примитив: один материал — один вызов. */
function merge(parts) {
  const out = { positions: [], normals: [], uv: [], indices: [] }
  for (const p of parts) {
    const base = out.positions.length / 3
    out.positions.push(...p.positions)
    out.normals.push(...p.normals)
    out.uv.push(...p.uv)
    for (const i of p.indices) out.indices.push(base + i)
  }
  return out
}

// ──────────────────────── сложность, одной строкой на класс ───────────────
//
// Правка бюджета — правка ОДНОЙ строки этой таблицы. Числа выбраны низкими
// нарочно: потолки «вызовы < 150, вершины < 100 000» записаны ЗАРАНЕЕ
// (CLAUDE.md), и менять их под полученный результат запрещено — значит
// укладываться должна геометрия.
//
// `tex` — размер и формат ТЕКСТУРЫ, которую положит автор генератором.
// Формат честно `rgba8`, а не `astc4x4`: KTX2-сжатие отложено за замер
// (отдельная установка `@gltf-transform/cli`), и несжатый формат — сторона
// ПЕССИМИСТИЧНАЯ, то есть для потолка безопасная.

/** @typedef {{width:number,height:number,format:'rgba8'|'astc4x4',mipmaps:boolean}} TexSpec */

const TEX = {
  /* Числа НЕ выбраны здесь: это размеры текстур, которые автор уже
     сгенерировал, — небо 1024×512, предметы 512×512. Таблица их
     ОБЪЯВЛЯЕТ, а сторож в `tests/asset-stat.test.ts` сверяет объявленное с
     заголовком IHDR каждого PNG, который лежит на диске. Поэтому вторым
     местом правды она не становится: разойдётся — упадёт. */
  object: { width: 512, height: 512, format: 'rgba8', mipmaps: true },
  sky: { width: 1024, height: 512, format: 'rgba8', mipmaps: true },
}

export const ASSET_CLASSES = {
  /** Боковая плита и всё, что стоит сбоку: коробка, один материал. */
  obstacleSide: { geometry: () => box(), tex: TEX.object },
  /**
   * Полотно поперёк коридора. Призма, а не коробка: у висящего полотна
   * ребёнок читает нижнюю кромку, и скошенная грань даёт ей светлоту.
   */
  obstacleDuck: { geometry: () => prism({ sides: 3, h: 1 }), tex: TEX.object },
  /**
   * НАМЕРЕННО самый дорогой ассет: тело плюс оболочка свечения, два
   * материала — то есть ДВА вызова с одного меша. Он здесь ровно затем,
   * чтобы поймать счётчик, который считает меши вместо примитивов: такой
   * счётчик врёт вниз именно на сложном арте (Review Focus, Task 4).
   */
  obstacleJelly: {
    geometry: () => box(),
    glow: () => box({ w: 1.08, h: 1.04, d: 1.08 }),
    tex: TEX.object,
  },
  /** Обычное кольцо. */
  starRing: { geometry: () => torus({ radial: 12, tubular: 6 }), tex: TEX.object },
  /** Большое кольцо: отдельный ассет, форма различима, сегментов больше. */
  starBig: { geometry: () => torus({ radial: 16, tubular: 8, r: 0.44, tube: 0.13 }), tex: TEX.object },
  /** Растительность: скрещённые плоскости, восемь вершин. */
  decorPlant: { geometry: () => crossQuads(), tex: TEX.object },
  /** Камни, кристаллы, столбы: призма. */
  decorSolid: { geometry: () => prism({ sides: 5 }), tex: TEX.object },
  /** Светлячок: маленький купол. */
  decorGlow: { geometry: () => dome({ segments: 8, rings: 3 }), tex: TEX.object },
  /** Пол коридора: одна лежачая плоскость, тайлится текстурой. */
  corridorFloor: { geometry: () => quad({ plane: 'xz' }), tex: TEX.object },
  /** Две стены — один примитив: один материал, один вызов. */
  corridorWalls: {
    geometry: () =>
      merge([
        quad({ plane: 'xy', yaw: Math.PI / 2 }),
        quad({ plane: 'xy', yaw: -Math.PI / 2 }),
      ]),
    tex: TEX.object,
  },
  /** Небо: перевёрнутая полоса. */
  sky: { geometry: () => cylinderBand({ segments: 24 }), tex: TEX.sky },
}

/**
 * Какой вид обочины какой формы. Перечислены ВСЕ шестнадцать, а не только
 * исключения, — по тому же правилу, что `DECOR_TINT_KEY` в `compose.ts`:
 * список вида и список формы тогда видно рядом, а полноту сторожит тест,
 * который берёт виды из `theme.js`.
 */
const DECOR_SHAPE = {
  palm: 'decorPlant',
  bush: 'decorPlant',
  flower: 'decorPlant',
  kelp: 'decorPlant',
  anemone: 'decorPlant',
  coral: 'decorPlant',
  spruce: 'decorPlant',
  cactus: 'decorSolid',
  rock: 'decorSolid',
  post: 'decorSolid',
  totem: 'decorSolid',
  spire: 'decorSolid',
  drift: 'decorSolid',
  crystal: 'decorSolid',
  shard: 'decorSolid',
  firefly: 'decorGlow',
}

/**
 * `beam` — живой вид, которого в реестре `LOOKS` нет и не будет
 * (`src/core/level.js:53-57`: «простая и скучная красная стена»), но имя
 * живёт в снятых журналах, а повтор журнала обязан работать. Значит таблица
 * ассетов обязана его знать — иначе `estimate` упадёт на повторе.
 */
const EXTRA_LOOKS = ['beam']

/** Класс сложности по имени ассета. Единственный владелец соответствия. */
export function ASSET_CLASS_OF(id) {
  const [group, rest] = splitId(id)
  if (group === 'obstacle') {
    if (rest === 'jelly') return 'obstacleJelly'
    return LOOKS.duck.includes(rest) ? 'obstacleDuck' : 'obstacleSide'
  }
  if (group === 'star') return rest === 'big' ? 'starBig' : 'starRing'
  if (group === 'decor') return DECOR_SHAPE[rest]
  if (group === 'corridor') return rest === 'floor' ? 'corridorFloor' : 'corridorWalls'
  if (group === 'sky') return 'sky'
  return undefined
}

function splitId(id) {
  const i = id.indexOf('/')
  return [id.slice(0, i), id.slice(i + 1)]
}

/** Все зоны всех миров — источник имён `sky/<zone>`. */
function allZones() {
  return Object.values(WORLDS).flatMap((w) => w.zones)
}

/** Все виды обочины всех зон — источник имён `decor/<kind>`. */
function allDecorKinds() {
  const kinds = new Set()
  for (const zone of allZones()) {
    for (const k of THEME[zone]?.decor?.kinds ?? []) kinds.add(k.kind)
  }
  return [...kinds]
}

/** Полный перечень имён ассетов, ВЫВЕДЕННЫЙ из данных игры. */
export function assetIds() {
  return [
    ...[...LOOKS.duck, ...LOOKS.side, ...EXTRA_LOOKS].map((l) => `obstacle/${l}`),
    'star/ring',
    'star/big',
    ...allDecorKinds().map((k) => `decor/${k}`),
    'corridor/floor',
    'corridor/walls',
    ...allZones().map((z) => `sky/${z}`),
  ]
}

/**
 * Ссылка на картинку ИЗ `.glb`, а не из корня проекта.
 *
 * Тонкость, которая уже один раз стоила 44 битых ссылок из 44: `uri` в glTF
 * разрешается относительно каталога САМОГО `.glb`, а не относительно корня
 * комплекта. `assets/obstacle/jelly.glb` лежит на уровень глубже, чем
 * `assets/tex/`, значит ссылка обязана начинаться с `../` — иначе загрузчик
 * ищет `assets/obstacle/tex/obstacle/jelly.png`. Число `../` выводится из
 * самого имени: сколько в имени косых черт, столько уровней вглубь.
 *
 * Своей проверки это не заменяет: сторож в тесте обходит РЕАЛЬНЫЕ `.glb` на
 * диске и разрешает каждую ссылку файловой системой. Круговой тест такое не
 * ловит в принципе — писатель и счётчик ошибаются одинаково и сходятся.
 */
function texUri(imageId) {
  const depth = imageId.split('/').length - 1
  return `${'../'.repeat(depth)}tex/${imageId}.png`
}

/** Имя ассета → вход для `buildGlb`. */
export function specFor(id) {
  const cls = ASSET_CLASSES[ASSET_CLASS_OF(id)]
  if (!cls) throw new Error(`нет класса сложности у ассета ${id}`)

  const images = [{ name: id, uri: texUri(id), ...cls.tex }]
  const materials = [{ name: 'body', image: 0 }]
  const primitives = [{ geometry: cls.geometry(), material: 0 }]

  if (cls.glow) {
    images.push({ name: `${id}-glow`, uri: texUri(`${id}-glow`), ...cls.tex })
    materials.push({ name: 'glow', image: 1 })
    primitives.push({ geometry: cls.glow(), material: 1 })
  }

  return { images, materials, meshes: [{ name: id, primitives }] }
}

/** Пары «имя → вход писателя» для всех ассетов. */
export function assetSpecs() {
  return assetIds().map((id) => ({ id, spec: specFor(id) }))
}

// ──────────────────────────── писатель `.glb` ─────────────────────────────

const GLTF_MAGIC = 0x46546c67 // 'glTF'
const CHUNK_JSON = 0x4e4f534a // 'JSON'
const CHUNK_BIN = 0x004e4942 // 'BIN\0'

const COMPONENT_FLOAT = 5126
const COMPONENT_USHORT = 5123
const COMPONENT_UINT = 5125
const TARGET_ARRAY = 34962
const TARGET_ELEMENT = 34963

/** Добивка до кратности четырём — требование формата к обоим чанкам. */
function pad4(n) {
  return (4 - (n % 4)) % 4
}

/**
 * Валидный glTF 2.0 binary из описания. Чистая функция: тот же вход — тот
 * же байт, и поэтому `.glb` можно держать под гитом.
 *
 * @param {{
 *   meshes: {name: string, primitives: {geometry: object, material: number}[]}[],
 *   materials: {name: string, image?: number}[],
 *   images: ({name: string, uri: string} & TexSpec)[],
 * }} spec
 * @returns {Buffer}
 */
export function buildGlb(spec) {
  const accessors = []
  const bufferViews = []
  const chunks = []
  let offset = 0

  /** Кладёт массив в BIN и возвращает индекс accessor. */
  function pushAccessor(data, { component, type, count, minMax = false }) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const padding = pad4(bytes.length)
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
      target: component === COMPONENT_FLOAT ? TARGET_ARRAY : TARGET_ELEMENT,
    })
    chunks.push(bytes)
    if (padding) chunks.push(Buffer.alloc(padding))
    offset += bytes.length + padding

    const accessor = {
      bufferView: bufferViews.length - 1,
      componentType: component,
      count,
      type,
    }
    if (minMax) {
      // min/max обязательны именно у POSITION: без них загрузчик не знает
      // габарита и не может ни отсечь, ни выбрать уровень детализации.
      // Считаются ПО СОДЕРЖИМОМУ Float32Array, а не по входным double:
      // иначе объявленный габарит не совпал бы с записанными байтами.
      const n = type === 'VEC3' ? 3 : 2
      const min = new Array(n).fill(Infinity)
      const max = new Array(n).fill(-Infinity)
      for (let i = 0; i < data.length; i++) {
        const k = i % n
        if (data[i] < min[k]) min[k] = data[i]
        if (data[i] > max[k]) max[k] = data[i]
      }
      accessor.min = min
      accessor.max = max
    }
    accessors.push(accessor)
    return accessors.length - 1
  }

  const meshes = spec.meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((p) => {
      const g = p.geometry
      const verts = g.positions.length / 3
      const attributes = {
        POSITION: pushAccessor(new Float32Array(g.positions), {
          component: COMPONENT_FLOAT,
          type: 'VEC3',
          count: verts,
          minMax: true,
        }),
        NORMAL: pushAccessor(new Float32Array(g.normals), {
          component: COMPONENT_FLOAT,
          type: 'VEC3',
          count: verts,
        }),
        TEXCOORD_0: pushAccessor(new Float32Array(g.uv), {
          component: COMPONENT_FLOAT,
          type: 'VEC2',
          count: g.uv.length / 2,
        }),
      }
      // uint16 хватает заглушкам с запасом, но порог проверяется, а не
      // предполагается: молчаливое переполнение дало бы мусорную геометрию.
      const wide = verts > 65535
      const indices = pushAccessor(
        wide ? new Uint32Array(g.indices) : new Uint16Array(g.indices),
        {
          component: wide ? COMPONENT_UINT : COMPONENT_USHORT,
          type: 'SCALAR',
          count: g.indices.length,
        },
      )
      return { attributes, indices, material: p.material }
    }),
  }))

  const bin = Buffer.concat(chunks)

  const json = {
    // Ни версии инструмента, ни даты: обе сделали бы файл невоспроизводимым,
    // и каждый перезапуск давал бы шумный диff по двоичным файлам.
    asset: { version: '2.0', generator: 'shustrik-next placeholder' },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((m, i) => ({ name: m.name, mesh: i })),
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  }

  if (spec.materials.length) {
    json.materials = spec.materials.map((m) => {
      const material = { name: m.name, pbrMetallicRoughness: { metallicFactor: 0 } }
      if (m.image != null) {
        material.pbrMetallicRoughness.baseColorTexture = { index: m.image }
      }
      return material
    })
  }
  if (spec.images.length) {
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }]
    json.textures = spec.images.map((_, i) => ({ sampler: 0, source: i }))
    json.images = spec.images.map((img) => ({
      name: img.name,
      // Ссылка на картинку, которой ещё нет. Это законно: по спецификации
      // `uri` — просто относительная ссылка, и ни парсер JSON-чанка, ни
      // `GLTFLoader` при `parse()` без запроса текстуры на ней не спотыкаются.
      uri: img.uri,
      mimeType: 'image/png',
      /* Размер и формат живут в `extras`, потому что в самом glTF их нет:
         ширину и высоту загрузчик узнаёт из ДЕКОДИРОВАННОЙ картинки. А
         текстурную память надо посчитать ДО того, как появится хоть один
         PNG, — иначе потолок 96 МБ проверять нечем. Когда приедет KTX2,
         те же числа будут лежать в заголовке контейнера, и счётчик
         прочтёт их оттуда; `extras` — переходная, честно помеченная
         ступень, а не постоянная подмена. */
      extras: {
        width: img.width,
        height: img.height,
        format: img.format,
        mipmaps: img.mipmaps,
      },
    }))
  }

  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  // JSON добивается ПРОБЕЛАМИ, BIN — нулями: так требует спецификация, и
  // строгие парсеры на `\0` внутри JSON-чанка спотыкаются.
  const jsonPad = Buffer.alloc(pad4(jsonBytes.length), 0x20)
  const binPad = Buffer.alloc(pad4(bin.length), 0x00)

  const jsonLen = jsonBytes.length + jsonPad.length
  const binLen = bin.length + binPad.length
  const total = 12 + 8 + jsonLen + 8 + binLen

  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLTF_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)

  const jsonHead = Buffer.alloc(8)
  jsonHead.writeUInt32LE(jsonLen, 0)
  jsonHead.writeUInt32LE(CHUNK_JSON, 4)

  const binHead = Buffer.alloc(8)
  binHead.writeUInt32LE(binLen, 0)
  binHead.writeUInt32LE(CHUNK_BIN, 4)

  return Buffer.concat([header, jsonHead, jsonBytes, jsonPad, binHead, bin, binPad])
}

// ──────────────────────────────── запуск ──────────────────────────────────

/** Пишет все заглушки в `dir`. Возвращает список записанных путей. */
export function writeAll(dir = join(ROOT, 'assets')) {
  const written = []
  for (const { id, spec } of assetSpecs()) {
    const file = join(dir, `${id}.glb`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, buildGlb(spec))
    written.push(file)
  }
  return written
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const written = writeAll()
  console.log(`записано заглушек: ${written.length}`)
}
