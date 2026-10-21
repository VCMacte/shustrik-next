/**
 * Таблица ассетов СЧИТАЕТСЯ из `.glb`, а не пишется руками (Task 4).
 *
 * Проверки здесь ДВУХ РАЗНЫХ РОДОВ, и путать их нельзя: этот этап заплатил за
 * урок 44 битыми ссылками из 44.
 *
 * 1. **Круговая** (`readGlbStats(buildGlb(spec))`) проверяет СОГЛАСОВАННОСТЬ
 *    писателя (`tools/make-placeholder-assets.mjs`) и читателя
 *    (`tools/asset-stat.mjs`) — и только её. Про внешний мир она не знает
 *    ничего: существует ли файл, на который указывает `uri`, и разрешается ли
 *    путь от того каталога, от которого его разрешает загрузчик, — всё это вне
 *    её. Так и вышло: `buildGlb` писал `uri` от корня комплекта,
 *    `readGlbStats` их не читал вовсе, обе половины оказались СОГЛАСОВАННО
 *    СЛЕПЫ, и круговая осталась зелёной при ста процентах битых ссылок.
 *    Никакой «нарочно написанной подделки» для этого не потребовалось.
 * 2. **Дисковые сторожа** (три, в конце файла) обходят файлы в `assets/` и
 *    спрашивают файловую систему. Дыру закрывают они, а не круговая.
 *
 * Следующему, кто захочет положиться на круговую вместо дискового сторожа:
 * согласованность — не существование. Круговая остаётся полезной — она ловит
 * расхождение двух половин одной строкой, — но доказывает ровно столько.
 *
 * Фикстуры строятся В ТЕСТЕ: двоичных файлов под гитом быть не должно, кроме
 * самих заглушек `assets/**.glb` и текстур `assets/tex/**.png`, которые и есть
 * предмет проверки.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { expect, test } from 'vitest'

import {
  ASSET_CLASS_OF,
  assetSpecs,
  box,
  buildGlb,
  torus,
} from '../tools/make-placeholder-assets.mjs'
import {
  buildManifest,
  listGlb,
  readGlbJson,
  readGlbStats,
  texBytesOf,
} from '../tools/asset-stat.mjs'

import { composeScene } from '../src/render/compose'
import type { Decor, Obstacle, RunState, Star } from '../src/render/types'
import { LOOKS } from '../src/core/level.js'
import { THEME, WORLDS } from '../src/core/theme.js'

const ROOT = join(__dirname, '..')
const ASSETS = join(ROOT, 'assets')

/** Геометрия с ЗАДАННЫМ числом вершин: счётчик обязан брать именно его. */
function geometryWith(verts: number) {
  return {
    positions: new Array(verts * 3).fill(0),
    normals: new Array(verts * 3).fill(0),
    uv: new Array(verts * 2).fill(0),
    indices: new Array(verts).fill(0),
  }
}

// ───────────────────────────── чтение `.glb` ──────────────────────────────

test('вершины считаются по accessor POSITION', () => {
  const glb = buildGlb({
    images: [],
    materials: [{ name: 'body' }],
    meshes: [{ name: 'm', primitives: [{ geometry: geometryWith(36), material: 0 }] }],
  })
  const stats = readGlbStats(glb)
  expect(stats.primitives).toHaveLength(1)
  expect(stats.primitives[0].verts).toBe(36)
})

test('два примитива с разными материалами — два вызова', () => {
  const glb = buildGlb({
    images: [],
    materials: [{ name: 'body' }, { name: 'glow' }],
    meshes: [
      {
        name: 'm',
        primitives: [
          { geometry: geometryWith(8), material: 0 },
          { geometry: geometryWith(12), material: 1 },
        ],
      },
    ],
  })
  const stats = readGlbStats(glb)
  expect(stats.primitives).toHaveLength(2)
  expect(stats.primitives.map((p) => p.material)).toEqual(['body', 'glow'])
  expect(stats.primitives.map((p) => p.verts)).toEqual([8, 12])
})

test('битый glb падает с внятной ошибкой, а не молча', () => {
  expect(() => readGlbStats(Buffer.from('nope'))).toThrow(/не glTF/)
  /* Отдельно — ДОСТАТОЧНО ДЛИННЫЙ файл с чужой подписью. Без этой строки
     проверка подписи вечнозелена впустую: `nope` всего четыре байта, и его
     отвергает проверка длины, а не подписи. Проверено мутацией — с удалённой
     проверкой подписи строка выше проходила. */
  const alien = Buffer.alloc(32)
  /* Подпись пишется ЧИСЛОМ, а не строковым литералом с нулевым байтом:
     настоящий NUL в исходнике делает файл ДВОИЧНЫМ для гита, и тогда по нему
     не работают ни `git diff`, ни `grep`. А невидимая в ревью правка теста —
     ровно тот способ, которым сторож тихо перестаёт сторожить. */
  alien.writeUInt32LE(0x04034b50, 0) // подпись локального заголовка ZIP
  alien.writeUInt32LE(2, 4)
  alien.writeUInt32LE(32, 8)
  expect(() => readGlbStats(alien)).toThrow(/не glTF/)
  // Обрезанный файл — тоже «внятно», а не `undefined` где-то дальше.
  const good = buildGlb({
    images: [],
    materials: [{ name: 'body' }],
    meshes: [{ name: 'm', primitives: [{ geometry: box(), material: 0 }] }],
  })
  expect(() => readGlbStats(good.subarray(0, 20))).toThrow(/glTF|чанк|длин/i)
})

test('текстурная память считается по формату и мип-уровням', () => {
  expect(texBytesOf({ width: 256, height: 256, format: 'rgba8', mipmaps: false })).toBe(
    256 * 256 * 4,
  )
  expect(texBytesOf({ width: 256, height: 256, format: 'astc4x4', mipmaps: false })).toBe(
    256 * 256,
  )
  expect(texBytesOf({ width: 256, height: 256, format: 'rgba8', mipmaps: true })).toBe(
    Math.round(256 * 256 * 4 * 1.34),
  )
})

// ───────────────────── круговая проверка писателя и счётчика ──────────────
//
// Она проверяет согласованность писателя и читателя и НИЧЕГО не говорит о
// том, существует ли то, на что они ссылаются. Разбор — в шапке файла;
// существование проверяют дисковые сторожа в конце.

test('круговая: что записал писатель, то и прочёл счётчик — но не что ссылки живые', () => {
  const spec = {
    images: [
      { name: 'telo', uri: 'tex/telo.png', width: 512, height: 512, format: 'rgba8' as const, mipmaps: true },
      { name: 'svet', uri: 'tex/svet.png', width: 128, height: 64, format: 'astc4x4' as const, mipmaps: false },
    ],
    materials: [
      { name: 'body', image: 0 },
      { name: 'glow', image: 1 },
    ],
    meshes: [
      {
        name: 'jelly',
        primitives: [
          { geometry: box({ w: 1, h: 2, d: 0.5 }), material: 0 },
          { geometry: torus({ radial: 8, tubular: 5 }), material: 1 },
        ],
      },
    ],
  }
  const stats = readGlbStats(buildGlb(spec))
  expect(stats.primitives).toEqual([
    { material: 'body', verts: box({ w: 1, h: 2, d: 0.5 }).positions.length / 3 },
    { material: 'glow', verts: torus({ radial: 8, tubular: 5 }).positions.length / 3 },
  ])
  expect(stats.textures).toEqual([
    { name: 'telo', width: 512, height: 512, format: 'rgba8', mipmaps: true },
    { name: 'svet', width: 128, height: 64, format: 'astc4x4', mipmaps: false },
  ])
})

test('писатель побайтово повторяем: пересборка совпадает с тем, что под гитом', () => {
  /* Сравнение идёт с ФАЙЛАМИ НА ДИСКЕ, а не с двумя вызовами подряд. Это не
     придирка: два вызова подряд совпали бы и у писателя, который пишет в
     generator `Date.now()`, — оба попадают в одну миллисекунду. Проверено
     мутацией: такая подделка проходила «buildGlb === buildGlb» и падает
     здесь. А именно от неё правило и заведено: `.glb` лежат под гитом, и
     шумный диff по двоичным при каждом перезапуске скрыл бы настоящую
     правку геометрии. */
  for (const { id, spec } of assetSpecs()) {
    const onDisk = readFileSync(join(ASSETS, `${id}.glb`))
    expect(buildGlb(spec).equals(onDisk), `разошлось с ${id}.glb`).toBe(true)
  }
})

test('контейнер glb собран по спецификации: заголовок, длины и выравнивание', () => {
  const glb = buildGlb({
    // Нечётная длина имени — чтобы JSON-чанк заведомо требовал добивки.
    images: [{ name: 'x', uri: 'tex/x.png', width: 8, height: 8, format: 'rgba8' as const, mipmaps: false }],
    materials: [{ name: 'body', image: 0 }],
    meshes: [{ name: 'abc', primitives: [{ geometry: box(), material: 0 }] }],
  })

  expect(glb.toString('ascii', 0, 4)).toBe('glTF')
  expect(glb.readUInt32LE(4)).toBe(2)
  expect(glb.readUInt32LE(8)).toBe(glb.length)
  expect(glb.length % 4).toBe(0)

  const jsonLen = glb.readUInt32LE(12)
  expect(jsonLen % 4).toBe(0)
  expect(glb.toString('ascii', 16, 20)).toBe('JSON')
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen))
  // Добивка JSON-чанка — ПРОБЕЛЫ: иначе строгий парсер споткнётся о \0.
  const tail = glb.toString('utf8', 20 + jsonLen - 1, 20 + jsonLen)
  expect(tail === ' ' || tail === '}').toBe(true)

  const binOff = 20 + jsonLen
  const binLen = glb.readUInt32LE(binOff)
  expect(binLen % 4).toBe(0)
  expect(glb.readUInt32LE(binOff + 4)).toBe(0x004e4942)
  expect(binOff + 8 + binLen).toBe(glb.length)

  // Буфер объявлен ровно тем, что лежит в BIN-чанке, и каждый bufferView
  // в него укладывается: иначе GLTFLoader прочтёт мусор за краем.
  expect(json.buffers).toHaveLength(1)
  expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLen)
  for (const v of json.bufferViews) {
    expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength)
  }
  // POSITION обязан нести min/max — без них загрузчик не считает габарит.
  const posIndex = json.meshes[0].primitives[0].attributes.POSITION
  expect(json.accessors[posIndex].min).toHaveLength(3)
  expect(json.accessors[posIndex].max).toHaveLength(3)
})

// ─────────────────────── список ассетов выведен из данных ─────────────────

test('список ассетов выведен из данных, а не написан руками', () => {
  const ids = assetSpecs().map((a) => a.id)
  expect(new Set(ids).size).toBe(ids.length)

  const zones: string[] = Object.values(WORLDS).flatMap((w: any) => w.zones)
  const kinds = new Set<string>()
  for (const z of zones) for (const k of (THEME as any)[z]?.decor?.kinds ?? []) kinds.add(k.kind)

  for (const look of [...LOOKS.duck, ...LOOKS.side]) expect(ids).toContain(`obstacle/${look}`)
  // `beam` в реестре LOOKS нет и не будет (`level.js:53-57`), но имя живёт в
  // снятых журналах, а повтор журнала обязан работать.
  expect(ids).toContain('obstacle/beam')
  for (const kind of kinds) expect(ids).toContain(`decor/${kind}`)
  for (const zone of zones) expect(ids).toContain(`sky/${zone}`)
  expect(ids).toContain('star/ring')
  expect(ids).toContain('star/big')
  expect(ids).toContain('corridor/floor')
  expect(ids).toContain('corridor/walls')

  const expected =
    LOOKS.duck.length + LOOKS.side.length + 1 + 2 + kinds.size + 2 + zones.length
  expect(ids.length).toBe(expected)
  // Число названо и здесь: если сами данные поедут, разойдутся не только
  // списки, но и запись в докуменации про предварительность бюджета.
  expect(ids.length).toBe(43)
})

test('у каждого ассета есть класс сложности, и класс не выдуман на ходу', () => {
  for (const { id } of assetSpecs()) {
    expect(ASSET_CLASS_OF(id), `нет класса сложности у ${id}`).toBeTruthy()
  }
})

test('obstacle/jelly намеренно двухматериальный: бюджет не вправе врать вниз', () => {
  const jelly = assetSpecs().find((a) => a.id === 'obstacle/jelly')
  expect(jelly).toBeTruthy()
  const stats = readGlbStats(buildGlb(jelly!.spec))
  expect(stats.primitives.length).toBe(2)
  expect(new Set(stats.primitives.map((p) => p.material)).size).toBe(2)

  /* И отдельно — что в манифест это доехало ВЫЗОВАМИ. Без этой строки
     `calls` мог бы считать меши (их один) вместо примитивов, и проверка
     выше прошла бы как есть: она про `readGlbStats`, а не про манифест. */
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
  expect(manifest['obstacle/jelly'].calls).toBe(2)
})

// ───────────────────────────── манифест ──────────────────────────────────

test('манифест в репозитории совпадает с пересчётом по .glb', () => {
  const onDisk = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
  expect(buildManifest(ASSETS)).toEqual(onDisk)
})

test('манифест знает каждое имя, которое выдаёт composeScene', () => {
  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))

  const obstacles: Obstacle[] = [...LOOKS.duck, ...LOOKS.side, 'beam'].map((look, i) => ({
    at: 1 + i * 0.05,
    kind: LOOKS.duck.includes(look) ? 'duck' : 'side',
    look,
    side: -1,
    edge: 0.16296,
    passed: false,
    hit: false,
    verdictAt: null,
  }))
  const kinds = new Set<string>()
  for (const w of Object.values(WORLDS) as any[])
    for (const z of w.zones) for (const k of (THEME as any)[z]?.decor?.kinds ?? []) kinds.add(k.kind)
  const decor: Decor[] = [...kinds].map((kind, i) => ({
    kind,
    zone: 'greenHill',
    side: 1,
    x: 1.55,
    y: 0,
    h: 1.1,
    z: 0,
    at: 1 + i * 0.05,
    phase: 0,
  }))
  const stars: Star[] = [1, 3].map((worth, i) => ({
    x: 0,
    z: 0,
    side: 0,
    at: 1 + i * 0.05,
    taken: false,
    worth,
  }))

  const state: RunState = {
    decor,
    speed: 0,
    u: 0,
    v: 0,
    travel: 0,
    stars,
    obstacles,
    elapsed: 0,
    zone: 'greenHill',
    prizes: {},
    finishIn: null,
    safe: true,
    pulse: 0,
    dim: 0,
    world: 'hills',
    durationS: 60,
    step: 1,
  }

  const scene = composeScene(state)
  // Без этой строки проверка ниже вечнозелена: пустой список размещений
  // «не содержит неизвестных имён» ровно так же, как полный.
  expect(scene.placements.length).toBe(
    obstacles.length + stars.length + decor.length,
  )
  for (const p of scene.placements) {
    expect(manifest, `нет в манифесте: ${p.asset}`).toHaveProperty([p.asset])
  }
})

test('манифест не обещает текстур там, где картинки ещё нет: ссылка не ломает чтение', () => {
  // PNG кладёт автор генератором, и на момент этого прогона их может не быть
  // вовсе. Чтение `.glb` обязано работать всё равно: счётчик читает только
  // JSON-чанк, а не картинки.
  for (const { id, spec } of assetSpecs()) {
    const stats = readGlbStats(buildGlb(spec))
    expect(stats.textures.length, `нет текстуры у ${id}`).toBeGreaterThan(0)
    for (const t of stats.textures) expect(t.width).toBeGreaterThan(0)
  }
})

/**
 * Настоящий загрузчик, а не только свой парсер.
 *
 * Своя `readGlbStats` читает только JSON-чанк, поэтому она прошла бы и на
 * файле, который `GLTFLoader` отвергает: ни выравнивания чанков, ни границ
 * bufferView, ни ссылок на accessor она строго не требует. А на устройстве
 * файл грузит именно `GLTFLoader` — значит хотя бы один ассет обязан пройти
 * ЧЕРЕЗ него, и пройти БЕЗ картинок: PNG кладёт автор генератором позже, и
 * ссылка на отсутствующий файл не вправе уронить загрузку.
 *
 * `three` здесь законен: сторож развилки закрывает `src/core` и
 * `src/render/compose.ts`, а не тесты.
 */
test('GLTFLoader грузит заглушку и без картинок, и считает те же вызовы', async () => {
  // GLTFLoader — модуль для браузера и ждёт `self`. Node его не даёт.
  ;(globalThis as any).self ??= globalThis
  // Спецификатор переменной, а не литералом: у аддонов `three` в этой версии
  // нет `.d.ts`, и литерал дал бы TS7016 при `tsc --noEmit`. Ставить
  // `@types/three` ради одного теста — лишняя зависимость; `@vite-ignore`
  // оставляет импорт нативному Node, который разрешает его по exports-карте.
  const ADDON = 'three/examples/jsm/loaders/GLTFLoader.js'
  const { GLTFLoader } = (await import(/* @vite-ignore */ ADDON)) as any

  const file = join(ASSETS, 'obstacle', 'jelly.glb')
  const buf = readFileSync(file)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

  const gltf = await new Promise<any>((resolve, reject) =>
    new GLTFLoader().parse(ab as ArrayBuffer, '', resolve, reject),
  )

  let calls = 0
  let verts = 0
  gltf.scene.traverse((o: any) => {
    if (o.isMesh) {
      calls += 1
      verts += o.geometry.attributes.position.count
    }
  })

  const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))
  expect({ calls, verts }).toEqual({
    calls: manifest['obstacle/jelly'].calls,
    verts: manifest['obstacle/jelly'].verts,
  })
})

// ──────────────── сторож ссылок на картинки (найдено ревью) ───────────────
//
// Два дефекта прошли мимо всего, что написано выше, и прошли по одной
// причине: КРУГОВОЙ тест проверяет, что мы прочитали то, что записали, и
// остаётся зелёным, даже если ссылка указывает в пустоту — обе половины
// ошибаются одинаково и сходятся. `uri` в glTF разрешается относительно
// каталога САМОГО `.glb`, а заглушки лежали на уровень глубже, чем `tex/`:
// не разрешалось 44 ссылки из 44.
//
// Поэтому обход здесь — по ФАЙЛАМ НА ДИСКЕ и по файловой системе, а не по
// таблице в коде: таблица и была неправа, и тест, выведенный из неё,
// повторил бы ту же ошибку.

/** Ссылки на картинки всех `.glb`, что реально лежат в `assets/`. */
function imageRefsOnDisk(): {
  asset: string
  glb: string
  uri: string
  resolved: string
  declared: { width: number; height: number }
}[] {
  const refs = []
  for (const { id, file } of listGlb(ASSETS)) {
    const json = readGlbJson(readFileSync(file))
    for (const img of json.images ?? []) {
      refs.push({
        asset: id,
        glb: file,
        uri: img.uri,
        // Разрешение — РОВНО как у загрузчика: от каталога самого `.glb`.
        resolved: resolve(dirname(file), img.uri),
        declared: { width: img.extras.width, height: img.extras.height },
      })
    }
  }
  return refs
}

/**
 * Все PNG под `dir`, рекурсивно. Обход ДИСКА, а не таблицы: число картинок
 * обязано приходить оттуда же, откуда приходят сами картинки.
 */
function listPngOnDisk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listPngOnDisk(full))
    else if (entry.name.endsWith('.png')) out.push(full)
  }
  return out
}

/** Ширина и высота PNG из заголовка IHDR: он всегда первый чанк. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file)
  if (b.length < 24 || b.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(`не PNG или нет IHDR: ${file}`)
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

test('каждая ссылка на картинку разрешается от каталога самого .glb', () => {
  const refs = imageRefsOnDisk()
  // Без этой строки проверка вечнозелена: ноль ссылок «все разрешаются».
  expect(refs.length).toBe(44)

  const wrongShape: string[] = []
  for (const r of refs) {
    // Куда ссылка ОБЯЗАНА привести: `assets/tex/<имя картинки>.png`, и имя
    // картинки — это имя ассета (у второй карты плюс суффикс). Проверяется
    // форма, а не только существование файла: форма не зависит от того,
    // успел ли автор положить PNG, и держит дефект пойманным навсегда.
    const want = resolve(ASSETS, 'tex', `${r.asset}.png`)
    const wantGlow = resolve(ASSETS, 'tex', `${r.asset}-glow.png`)
    if (r.resolved !== want && r.resolved !== wantGlow) {
      wrongShape.push(
        `${relative(ROOT, r.glb).split(sep).join('/')} ссылается на «${r.uri}», ` +
          `это ${relative(ROOT, r.resolved).split(sep).join('/')}, ` +
          `а должно быть assets/tex/${r.asset}.png`,
      )
    }
  }
  expect(wrongShape).toEqual([])
})

test('ни одна ссылка не висит в пустоте, и ни одна картинка не осиротела', () => {
  const refs = imageRefsOnDisk()

  /* Порог БЕЗУСЛОВНЫЙ, и это вторая его редакция. Пока картинок не было под
     гитом, сторож пропускал состояние «ни одной»: заглушки заведены для жизни
     без арта. Теперь все 44 PNG в репозитории, и то окно стало дырой — удали
     их все, и сторож остался бы зелёным. Условия больше нет.

     Число 44 здесь НЕ записано: оно выводится из диска с двух сторон — сколько
     ссылок в `.glb` и сколько картинок лежит. Равенство ловит обе беды сразу:
     ссылку без файла (на устройстве это не отказ, а БЕЛАЯ текстура, то есть
     молча неверная картинка) и файл, на который никто не ссылается — опечатку
     в имени при генерации. */
  const pngs = listPngOnDisk(join(ASSETS, 'tex'))
  expect(pngs.length).toBeGreaterThan(0)
  expect(refs.length).toBe(pngs.length)

  const missing = refs
    .filter((r) => !existsSync(r.resolved))
    .map(
      (r) =>
        `нет ${relative(ROOT, r.resolved).split(sep).join('/')}, ` +
        `а на него ссылается ${relative(ROOT, r.glb).split(sep).join('/')}`,
    )
  expect(missing).toEqual([])
})

test('объявленный размер текстуры совпадает с PNG на диске', () => {
  /* Число, по которому СУДЯТ (texBytes манифеста), и число, которое лежит в
     картинке, обязаны быть одним числом — инвариант проекта. Таблица `TEX` в
     писателе объявляет размер, и если автор отдал другой, бюджет врёт вчетверо
     на небе и не говорит об этом. */
  const refs = imageRefsOnDisk()
  const checked: string[] = []
  for (const r of refs) {
    // Оба файла в сообщении, а не только недостающий: «нет такого PNG» без
    // имени `.glb`, который на него ссылается, стоит получаса поиска. Для
    // сторожа существования выше это сделано сразу, здесь — довезено.
    const where =
      `${relative(ROOT, r.resolved).split(sep).join('/')} ` +
      `(ссылается ${relative(ROOT, r.glb).split(sep).join('/')})`
    let actual
    try {
      actual = pngSize(r.resolved)
    } catch (e) {
      throw new Error(`${where}: ${(e as Error).message}`)
    }
    expect(actual, where).toEqual(r.declared)
    checked.push(r.resolved)
  }
  /* Счёт проверенного сверяется с ЛИСТИНГОМ КАТАЛОГА, а не с длиной того же
     списка, по которому шёл цикл. Разница не придирка: `checked` набирается в
     цикле по одному элементу на итерацию без исключений, поэтому
     `checked.length === refs.length` истинно ПО ПОСТРОЕНИЮ — это сверка
     источника с самим собой, то есть ровно та ошибка, от которой шапка этого
     файла предупреждает про круговую проверку. Здесь вторая сторона своя:
     одна приходит из разбора `.glb`, другая из `readdirSync`. */
  expect(checked.length).toBe(listPngOnDisk(join(ASSETS, 'tex')).length)
})

test('больше одной карты — только у obstacle/jelly, и это ревизуется', () => {
  const perAsset = new Map<string, number>()
  for (const r of imageRefsOnDisk()) {
    perAsset.set(r.asset, (perAsset.get(r.asset) ?? 0) + 1)
  }
  const multi = [...perAsset].filter(([, n]) => n > 1).map(([id]) => id)
  /* Перечень, а не «не больше одной»: каждый ассет с двумя картами — это
     картинка, которую автору надо нарисовать отдельно, и появиться такой
     ассет не вправе молча. Сейчас он один, и он намеренный. */
  expect(multi).toEqual(['obstacle/jelly'])
})
