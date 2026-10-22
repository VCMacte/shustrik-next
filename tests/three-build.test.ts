/**
 * Трёхмерный вывод: граф three.js собирается в `node`, без WebGL.
 *
 * Главное здесь — ОДНА проверка, ради которой написан весь файл: **число, по
 * которому СУДЯТ, и число, которое РИСУЮТ, берутся из одного места**
 * (CLAUDE.md; спека, «Бюджет считается по описанию, а не по устройству»).
 * Слева — `stats3D` живого графа three.js, собранного из НАСТОЯЩИХ `.glb`
 * настоящим `GLTFLoader`; справа — `estimate` по `assets/manifest.json`.
 * Две дороги к одному числу, и ни одна не проходит через другую: файл
 * разбирают РАЗНЫЕ разборщики (`GLTFLoader` против `tools/asset-stat.mjs`),
 * и арифметику группировки каждая сторона делает свою. Разойдутся — значит
 * одно из двух врёт.
 *
 * Чего это НЕ доказывает: что в двоичном чанке лежит ровно столько вершин,
 * сколько объявлено. Оба пути берут `count` у аккуратора в JSON-чанке, а
 * двоичный лишь ограничивает диапазон.
 *
 * Каждая проверка здесь отвечает на вопрос «прошла бы она, если убрать то,
 * что она проверяет?» — ответ записан рядом с ней, потому что за прошлые
 * этапы трижды находился тест, зелёный по построению.
 *
 * `three` в тестах законен: сторож развилки (`tests/guards.test.ts`)
 * закрывает `src/core`, `src/render/compose.ts` и `src/render/estimate.ts`,
 * а не тесты и не `src/render/three/**`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import * as THREE from 'three'

import {
  build3D,
  buildBackdrop,
  forgetMaterials,
  refill3D,
  stats3D,
  textureUrlFor,
} from '../src/render/three/build'
import type { LoadedAssets } from '../src/render/three/build'
import { EYE_H_M, HFOV_RAD, RENDER_SCALE, makeThreeRenderer } from '../src/render/three/renderer'
import type { GLLike } from '../src/render/three/renderer'
import { estimate, estimateFrame } from '../src/render/estimate'
import type { AssetTable } from '../src/render/estimate'
import type { FrameScene, Placement } from '../src/render/types'
import { DRAW_FAR_M } from '../src/render/types'
import { cameraX } from '../src/render/numbers'
import { measuredWorlds, sceneAt, worstFrame } from '../tools/budget.mjs'

const ROOT = join(__dirname, '..')
const ASSETS = join(ROOT, 'assets')

/** Таблица ассетов — та самая, которую считает `tools/asset-stat.mjs`. */
const table: AssetTable = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8'))

// ───────────────────────── настоящие ассеты с диска ───────────────────────

/**
 * Загружает ВСЕ 43 заглушки настоящим `GLTFLoader`.
 *
 * Не фикстура: это те же файлы, которые уедут на устройство, и геометрию из
 * них строит тот же загрузчик, что на телефоне. Именно поэтому сверка ниже
 * не круговая: слева число приходит через `GLTFLoader`, справа — через
 * собственный разборщик `tools/asset-stat.mjs`, и совпасть им неоткуда,
 * кроме как по правде.
 */
async function loadRealAssets(): Promise<LoadedAssets> {
  // GLTFLoader — модуль для браузера и ждёт `self`. Node его не даёт.
  ;(globalThis as any).self ??= globalThis
  // Спецификатор переменной, а не литералом: у аддонов `three` в этой версии
  // нет `.d.ts` (приём взят у `tests/asset-stat.test.ts`).
  const ADDON = 'three/examples/jsm/loaders/GLTFLoader.js'
  const { GLTFLoader } = (await import(/* @vite-ignore */ ADDON)) as any
  const loader = new GLTFLoader()

  const assets: LoadedAssets = {}
  for (const id of Object.keys(table)) {
    const buf = readFileSync(join(ASSETS, `${id}.glb`))
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const gltf = await new Promise<any>((resolve, reject) =>
      loader.parse(ab as ArrayBuffer, '', resolve, reject),
    )
    assets[id] = gltf.scene
  }
  return assets
}

let realAssetsCache: LoadedAssets | null = null
async function realAssets(): Promise<LoadedAssets> {
  if (!realAssetsCache) realAssetsCache = await loadRealAssets()
  return realAssetsCache
}

// ─────────────────────────── подделки, где нужна управляемость ────────────

/**
 * Ассет-подделка: заданное число примитивов с заданным числом вершин.
 *
 * Подделка нужна там, где важна УПРАВЛЯЕМОСТЬ, а не правдоподобие: проверить
 * перенос габарита в метрах проще на кубе, у которого известна каждая
 * вершина, чем на заглушке художника.
 */
function fakeAsset(prims: number[]): THREE.Object3D {
  const root = new THREE.Group()
  for (const verts of prims) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3))
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()))
  }
  return root
}

const emptyScene: FrameScene = {
  zone: 'greenHill',
  world: 'hills',
  camera: { u: 0, pitch: 0 },
  placements: [],
}

function sceneWith(items: Array<Partial<Placement> & Pick<Placement, 'asset'>>): FrameScene {
  return {
    ...emptyScene,
    placements: items.map((it) => ({ x: 0, y: 0, z: 1, ...it })),
  }
}

// ════════════════ ГЛАВНОЕ: живой счёт против оценки ════════════════════════

/**
 * Прошла бы вхолостую? НЕТ, и ни одной из двух половин.
 *
 * Левая половина — граф three.js из настоящих `.glb`: забудь `build3D`
 * инстансирование, и вызовов станет 18 вместо 12; посчитай `stats3D` меши
 * вместо примитивов — и `obstacle/jelly` недосчитается своего второго
 * материала. Правая — `estimate` по таблице, в которой числа прочитаны из
 * тех же файлов ДРУГИМ путём (`tools/asset-stat.mjs`, JSON-чанк glTF).
 *
 * Кадр не выдуман: это ХУДШИЙ кадр прогона `npm run budget` — тот самый, по
 * которому судится потолок. Что он именно тот, доказано здесь же сверкой
 * восстановленного кадра с числами перебора.
 */
test(
  'живой счёт совпадает с оценкой — судят и рисуют по одному числу',
  async () => {
    const worlds: string[] = measuredWorlds()
    const byWorld: Record<string, any> = {}
    for (const world of worlds) byWorld[world] = await worstFrame(world, table)
    const w = Object.values(byWorld).reduce((a: any, b: any) => (b.calls > a.calls ? b : a))

    /* Восстановление худшего кадра обязано попасть В ТОТ ЖЕ кадр, иначе
       сверка ниже верна, но говорит не о том кадре, о котором заявлено. */
    const scene = await sceneAt(w)
    expect(estimateFrame(scene, table).calls).toBe(w.calls)
    expect(scene.placements.length).toBe(w.placementCount)

    const assets = await realAssets()
    const est = estimate(scene, table)
    const live = stats3D(build3D(scene, assets))
    console.log(
      `  худший кадр (мир ${w.world}, зона ${w.zone}, посев ${w.seed},` +
        ` ступень ${w.step}, ${w.atS.toFixed(1)} с): размещений` +
        ` ${scene.placements.length}; живой счёт ${live.calls} вызовов,` +
        ` ${live.verts} вершин; оценка ${est.calls} и ${est.verts}`,
    )
    expect(live).toEqual({ calls: est.calls, verts: est.verts })

    /* Обратная сторона: пустой счёт сошёлся бы с пустой оценкой молча. */
    expect(live.calls).toBeGreaterThan(1)
    expect(live.verts).toBeGreaterThan(1)
  },
  600_000,
)

/**
 * КАДР целиком, а не только размещения.
 *
 * `estimate` — чистая сумма по списку размещений, и постоянную часть кадра
 * (пол, стены, небо зоны) он НЕ содержит по своему устройству
 * (`estimate.ts`). Вывод же её рисует, иначе коридора на экране нет. Значит
 * сверять `renderer.stats()` надо с `estimateFrame`, и это не придирка:
 * забудь вывод небо — и расхождение было бы ровно в постоянную часть, то
 * есть бюджет судил бы кадр, которого не рисуют.
 *
 * Прошла бы вхолостую? НЕТ: убери `buildBackdrop` из сборки кадра — и слева
 * станет на три вызова меньше, чем справа.
 */
test('кадр целиком: постоянная часть посчитана и нарисована', async () => {
  const assets = await realAssets()
  const scene = sceneWith([{ asset: 'decor/kelp' }, { asset: 'obstacle/jelly' }])
  const frame = new THREE.Group()
  frame.add(buildBackdrop(scene, assets))
  frame.add(build3D(scene, assets))

  const whole = estimateFrame(scene, table)
  expect(stats3D(frame)).toEqual({ calls: whole.calls, verts: whole.verts })
  // И та самая разница, ради которой это отдельная проверка.
  expect(whole.calls - estimate(scene, table).calls).toBe(whole.backdrop.calls)
})

// ─────────────────────────── инстансирование ──────────────────────────────

/**
 * Прошла бы вхолостую? НЕТ: вывод без инстансирования дал бы два меша и два
 * вызова — это и показано второй половиной, где счёт сверяется с `estimate`,
 * который группирует по имени ассета.
 */
test('повторяющийся ассет собран в один InstancedMesh', async () => {
  const assets = await realAssets()
  const scene = sceneWith([{ asset: 'decor/kelp' }, { asset: 'decor/kelp' }])
  const g = build3D(scene, assets)

  const meshes = g.children.filter((c) => c.type === 'Mesh' || c.type === 'InstancedMesh')
  expect(meshes).toHaveLength(1)
  expect((meshes[0] as THREE.InstancedMesh).count).toBe(2)
  // Вершины при этом НЕ сливаются: вторая водоросль стоит вершинному
  // конвейеру столько же, сколько первая.
  expect(stats3D(g)).toEqual({ calls: 1, verts: table['decor/kelp'].verts * 2 })
})

/**
 * Прошла бы вхолостую? НЕТ, и это единственная проверка, которая ловит
 * счётчик мешей вместо счётчика примитивов: `obstacle/jelly` нарочно собран
 * из двух материалов (`docs/art-placeholders.md`), и ронять его сложность
 * нельзя. Ассет взят НАСТОЯЩИЙ — два материала приходят из файла, а не из
 * подделки, написанной под ответ.
 */
test('а ассет из двух материалов даёт два меша на один инстанс-набор', async () => {
  const assets = await realAssets()
  const one = build3D(sceneWith([{ asset: 'obstacle/jelly' }]), assets)
  expect(stats3D(one).calls).toBe(2)
  expect(table['obstacle/jelly'].calls).toBe(2)

  /* Три медузы — по-прежнему два вызова (по одному на материал), но втрое
     больше вершин. Без этой половины первая строка зелена и у вывода,
     который инстансирование забыл: на одном размещении их не отличить. */
  const three = build3D(
    sceneWith([
      { asset: 'obstacle/jelly' },
      { asset: 'obstacle/jelly' },
      { asset: 'obstacle/jelly' },
    ]),
    assets,
  )
  expect(stats3D(three)).toEqual({
    calls: 2,
    verts: table['obstacle/jelly'].verts * 3,
  })
})

/**
 * Молчаливый пропуск незнакомого ассета — то же, от чего в `estimate.ts`
 * заведён громкий `costOf`: на устройстве он даёт дыру в кадре, а в счёте —
 * заниженное число. Прошла бы вхолостую? НЕТ: верни `build3D` пустую группу
 * вместо броска — и проверка упадёт.
 */
test('незнакомый ассет падает громко, а не рисуется дырой', () => {
  const assets: LoadedAssets = { 'decor/kelp': fakeAsset([3]) }
  expect(() => build3D(sceneWith([{ asset: 'decor/неттакого' }]), assets)).toThrow(
    /нет среди загруженных/,
  )
})

// ──────────────────── размещение: метры, поворот, цвет ────────────────────

/**
 * `size` — ГАБАРИТ В МЕТРАХ по каждой оси, а отсутствующее измерение значит
 * «свой натуральный метр» (`types.ts`, договор об именах). Равномерный
 * `scale` сжал бы боковую плиту по высоте вместе с шириной, то есть ступень
 * сложности меняла бы высоту препятствия.
 *
 * Прошла бы вхолостую? НЕТ: игнорируй `build3D` поле `size` — и масштаб
 * останется единичным по всем трём осям.
 */
test('габарит в метрах и поворот доезжают до матрицы размещения', () => {
  const assets: LoadedAssets = { 'obstacle/plate': fakeAsset([3]) }
  const g = build3D(
    sceneWith([
      { asset: 'obstacle/plate', x: -0.75, y: 0, z: 4, yaw: Math.PI / 2, size: { w: 0.5, h: 2.6 } },
    ]),
    assets,
  )
  const mesh = g.children[0] as THREE.InstancedMesh
  const m = new THREE.Matrix4()
  mesh.getMatrixAt(0, m)
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  m.decompose(pos, quat, scale)

  /* `z` уезжает со знаком минус: описание держит «вперёд» положительным
     (левая система), three.js смотрит в −Z. Подробности — в
     `placementMatrix`. */
  expect([pos.x, pos.y, pos.z]).toEqual([-0.75, 0, -4])
  expect(scale.x).toBeCloseTo(0.5, 6)
  expect(scale.y).toBeCloseTo(2.6, 6)
  // Отсутствующее измерение — свой натуральный метр, а не ноль и не копия соседа.
  expect(scale.z).toBeCloseTo(1, 6)
  const euler = new THREE.Euler().setFromQuaternion(quat, 'YXZ')
  // Отражение по одной оси меняет закрутку, поэтому и `yaw` со знаком минус.
  expect(euler.y).toBeCloseTo(-Math.PI / 2, 6)
})

/**
 * `tint` — ГОТОВЫЙ цвет, и обочина без него не остаётся (`types.ts`).
 * Прошла бы вхолостую? НЕТ: выброси `build3D` цвет — и `instanceColor`
 * останется пустым.
 */
test('готовый цвет размещения доезжает до инстанса', () => {
  const assets: LoadedAssets = { 'decor/kelp': fakeAsset([3]) }
  const g = build3D(
    sceneWith([
      { asset: 'decor/kelp', tint: '#204080' },
      { asset: 'decor/kelp', tint: '#ffffff' },
    ]),
    assets,
  )
  const mesh = g.children[0] as THREE.InstancedMesh
  expect(mesh.instanceColor).not.toBeNull()
  const c = new THREE.Color()
  mesh.getColorAt(0, c)
  expect(c.getHexString()).toBe('204080')
  mesh.getColorAt(1, c)
  expect(c.getHexString()).toBe('ffffff')
})

/**
 * Дымка исполняется ТУМАНОМ, а не прозрачностью, и это прямое следствие
 * правила «судят и рисуют по одному числу»: `estimate` считает один вызов на
 * примитив, то есть ОДИН проход. Полупрозрачное размещение добавляет
 * сортировку и перерисовку, а любой второй проход на то же размещение
 * (контур, свечение) ломает равенство сверху молча — именно об этом
 * предупредило ревью прошлого этапа.
 *
 * Прошла бы вхолостую? НЕТ: сделай `fade` прозрачностью — и материал станет
 * `transparent`.
 */
test('дымка не становится прозрачностью: лишних проходов на размещение нет', () => {
  const assets: LoadedAssets = { 'decor/kelp': fakeAsset([3]) }
  const g = build3D(sceneWith([{ asset: 'decor/kelp', fade: 0.2 }]), assets)
  let seen = 0
  g.traverse((o: any) => {
    if (!o.isMesh) return
    seen += 1
    expect(Array.isArray(o.material)).toBe(false)
    expect(o.material.transparent).toBe(false)
    expect(o.material.fog).toBe(true)
  })
  expect(seen).toBe(1)
})

// ──────────────────────── текстуры: откат без ASTC и ETC2 ─────────────────

/**
 * Устройство без ASTC и ETC2 обязано получить НЕсжатую текстуру, а не
 * ничего: молча не загрузившийся арт — это белая заглушка на телевизоре.
 *
 * Прошла бы вхолостую? Первая строка — ДА, у функции, которая всегда отдаёт
 * `.png` и про поддержку не знает вовсе. Поэтому рядом вторая: при живой
 * поддержке и ГОТОВОМ `.ktx2` та же функция обязана отдать сжатый путь, а
 * при живой поддержке, но без файла — снова `.png`. Три ветки, ни одна не
 * выводится из другой.
 */
test('без ASTC и ETC2 текстуры грузятся несжатыми, а не молча никак', () => {
  expect(textureUrlFor('decor/kelp', { astc: false, etc2: false })).toMatch(/\.png$/)
  // Поддержка есть и файл есть — сжатый путь.
  expect(
    textureUrlFor('decor/kelp', { astc: true, etc2: false }, new Set(['decor/kelp'])),
  ).toMatch(/\.ktx2$/)
  // Поддержка есть, а файла нет — снова несжатая, а не ссылка в пустоту.
  expect(textureUrlFor('decor/kelp', { astc: true, etc2: true }, new Set())).toMatch(/\.png$/)
})

/**
 * А вот то же самое, привязанное к ДИСКУ, а не к коду.
 *
 * Сжатие отложено за замер, и сегодня в `assets/tex/` нет ни одного
 * `.ktx2` (`docs/art-placeholders.md`, «Чего в заглушках НЕТ»). Значит откат
 * — не запасной путь, а ОСНОВНОЙ, и проверка обязана это говорить честно:
 * пока сжатых файлов нет, `textureUrlFor` отдаёт `.png` КАЖДОМУ ассету даже
 * на устройстве, которое умеет всё.
 *
 * Прошла бы вхолостую? НЕТ, и день, когда она упадёт, — это день прихода
 * первого `.ktx2`: тогда список доступных сжатых текстур обязан перестать
 * быть пустым, а не остаться им молча. Сторож ходит по файлам на диске,
 * потому что таблица в коде и была бы неправа (тот же урок, что у ссылок на
 * картинки в `art-placeholders.md`).
 */
test('пока .ktx2 нет на диске, откат на .png — основной путь для всех ассетов', () => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full)
      else if (e.endsWith('.ktx2')) found.push(full)
    }
  }
  walk(ASSETS)
  expect(found).toEqual([])

  for (const id of Object.keys(table)) {
    expect(textureUrlFor(id, { astc: true, etc2: true })).toBe(`assets/tex/${id}.png`)
  }

  /* И вторая опора, тоже с диска: сами `.glb` сегодня ссылаются только на
     `.png`. Если бы ссылка внутри контейнера уже вела на `.ktx2`, откат
     выше был бы верен, но бесполезен — загрузчик пошёл бы мимо него. */
  for (const id of Object.keys(table)) {
    const glb = readFileSync(join(ASSETS, `${id}.glb`))
    const jsonLen = glb.readUInt32LE(12)
    const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen))
    for (const img of json.images ?? []) expect(img.uri).toMatch(/\.png$/)
  }
})

// ────────────────────────────── вывод и контекст ──────────────────────────

/** Поддельный `WebGLRenderer`: всё, чем вывод его трогает, и ничего больше. */
function fakeGL() {
  const calls = { pixelRatio: 0, size: [0, 0, true] as [number, number, boolean], renders: 0, disposed: 0 }
  const gl: GLLike & { calls: typeof calls } = {
    calls,
    setPixelRatio(v: number) {
      calls.pixelRatio = v
    },
    setSize(w: number, h: number, updateStyle?: boolean) {
      calls.size = [w, h, updateStyle ?? true]
    },
    render() {
      calls.renders += 1
    },
    dispose() {
      calls.disposed += 1
    },
  }
  return gl
}

/** Поддельный холст: только подписка на события и способ их послать. */
function stubCanvas() {
  const handlers: Record<string, Array<(e: any) => void>> = {}
  return {
    addEventListener(type: string, fn: (e: any) => void) {
      ;(handlers[type] ??= []).push(fn)
    },
    removeEventListener(type: string, fn: (e: any) => void) {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== fn)
    },
    emit(type: string) {
      const e = { type, defaultPrevented: false, preventDefault() { e.defaultPrevented = true } }
      for (const h of handlers[type] ?? []) h(e)
      return e
    },
    listeners(type: string) {
      return (handlers[type] ?? []).length
    },
  }
}

async function makeTestRenderer(extra: Record<string, unknown> = {}) {
  const gl = fakeGL()
  const canvas = stubCanvas()
  const assets = await realAssets()
  const renderer = await makeThreeRenderer(canvas as unknown as HTMLCanvasElement, {
    makeGL: () => gl,
    assets,
    /* Настоящий `KTX2Loader.detectSupport` читает `renderer.extensions`
       живого контекста, и поддельному выводу такого не отдать. Опрос
       поддержки проверяется отдельным тестом со шпионом — здесь он только
       мешал бы. */
    makeKtx2: () => ({ detectSupport() {}, dispose() {} }),
    ...extra,
  })
  return { gl, canvas, renderer }
}

/**
 * Живой счёт ВЫВОДА против оценки КАДРА. Та же сверка, что в головном тесте,
 * но через интерфейс `Renderer`: именно это число отдаст `stats()` на
 * устройстве.
 *
 * Прошла бы вхолостую? НЕТ: забудь `draw` постоянную часть или
 * инстансирование — и числа разойдутся.
 */
test('renderer.stats() равен оценке кадра целиком', async () => {
  const { renderer, gl } = await makeTestRenderer()
  const scene = sceneWith([
    { asset: 'decor/kelp' },
    { asset: 'decor/kelp' },
    { asset: 'obstacle/jelly' },
    { asset: 'star/ring' },
  ])
  renderer.draw(scene)
  const whole = estimateFrame(scene, table)
  expect(renderer.stats()).toEqual({ calls: whole.calls, verts: whole.verts })
  expect(gl.calls.renders).toBe(1)
  renderer.dispose()
})

/**
 * Кадр не пересобирается, пока не изменился НАБОР ассетов.
 *
 * Это не оптимизация «на потом», а условие следующего этапа. Весь проект
 * существует ради одного числа — `gap95` ≤ 40 мс при позах ≥ 10 Гц, — и по
 * нему решается развилка «3D или 2.5D». Вывод, который шестьдесят раз в
 * секунду создаёт новые `InstancedMesh`, новые инстанс-буферы и новые VAO,
 * дал бы замер сборщика мусора, а не трёхмерного вывода, и развилка
 * решилась бы по причине, которой в замысле нет.
 *
 * Прошла бы вхолостую? НЕТ, и это проверено мутацией: верни безусловную
 * пересборку каждого кадра — и первая половина падает (объекты другие).
 * Вторая половина не даёт «переиспользовать» превратиться в «не заметить
 * смену кадра»: при другом наборе ассетов граф ОБЯЗАН пересобраться, и
 * счёт обязан стать другим.
 */
test('два кадра с одним набором ассетов идут по одним и тем же мешам', async () => {
  const { renderer } = await makeTestRenderer()
  const first = sceneWith([
    { asset: 'decor/kelp', z: 5 },
    { asset: 'decor/kelp', z: 9 },
    { asset: 'obstacle/jelly', z: 7 },
  ])
  renderer.draw(first)
  const meshesOf = () => {
    const out: THREE.InstancedMesh[] = []
    renderer.root().traverse((o: any) => {
      if (o.isMesh) out.push(o)
    })
    return out
  }
  const before = meshesOf()
  const uuidsBefore = before.map((m: any) => m.uuid)
  expect(before.length).toBeGreaterThan(1)

  /* Тот же набор, другие координаты — ровно то, что происходит каждый кадр:
     коридор едет, состав кадра не меняется. */
  const moved = sceneWith([
    { asset: 'decor/kelp', z: 4.5 },
    { asset: 'decor/kelp', z: 8.5 },
    { asset: 'obstacle/jelly', z: 6.5 },
  ])
  renderer.draw(moved)
  const after = meshesOf()
  expect(after.map((m: any) => m.uuid)).toEqual(uuidsBefore)
  for (let i = 0; i < after.length; i++) expect(after[i]).toBe(before[i])

  // Но координаты переложены, а не остались от прошлого кадра.
  const m = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const kelp = after.find((x) => x.name === 'decor/kelp')!
  kelp.getMatrixAt(0, m)
  m.decompose(pos, new THREE.Quaternion(), new THREE.Vector3())
  // Со знаком минус: см. `placementMatrix` — описание левое, three.js правый.
  expect(pos.z).toBeCloseTo(-4.5, 6)

  /* ТЕ ЖЕ ассеты, но ДРУГОЕ их число — случай, на котором «переиспользуем»
     опаснее всего: ёмкость `InstancedMesh` задана при создании, и подправить
     у него `count` вместо пересборки значит читать за краем буфера. Найдено
     мутацией: без этой половины проверка проходила у `refill3D`, который
     число размещений не сверяет. */
  const denser = sceneWith([
    { asset: 'decor/kelp', z: 4 },
    { asset: 'decor/kelp', z: 8 },
    { asset: 'decor/kelp', z: 12 },
    { asset: 'obstacle/jelly', z: 6 },
  ])
  renderer.draw(denser)
  const dense = meshesOf()
  expect(dense.map((x: any) => x.uuid)).not.toEqual(uuidsBefore)
  const denseKelp = dense.find((x) => x.name === 'decor/kelp')!
  expect(denseKelp.count).toBe(3)
  expect(renderer.stats()).toEqual({
    calls: estimateFrame(denser, table).calls,
    verts: estimateFrame(denser, table).verts,
  })

  /* А смена набора пересобирает: иначе «переиспользуем» значило бы
     «рисуем прошлый кадр». */
  const other = sceneWith([{ asset: 'decor/kelp', z: 3 }, { asset: 'star/ring', z: 6 }])
  renderer.draw(other)
  const rebuilt = meshesOf()
  expect(rebuilt.map((x: any) => x.uuid)).not.toEqual(uuidsBefore)
  expect(renderer.stats()).toEqual({
    calls: estimateFrame(other, table).calls,
    verts: estimateFrame(other, table).verts,
  })
  renderer.dispose()
})

/**
 * Переложенные координаты ПОМЕЧЕНЫ К ПЕРЕЗАЛИВКЕ.
 *
 * Самая тихая из возможных поломок, и найдена она ревью, а не прогоном:
 * `setMatrixAt` пишет в оперативную память, а на видеокарту буфер заливает
 * `WebGLRenderer` — и только если выставлен `instanceMatrix.needsUpdate`.
 * Убери эту строку, и на поддельном выводе НЕ изменится ничего (никто
 * ничего не заливает), а на устройстве кадр замрёт на первом. Замерший
 * кадр покажет прекрасный `gap95` и ложно выиграет развилку «3D или 2.5D» —
 * то есть соврёт ровно тому замеру, ради которого всё строится.
 *
 * Проверяется `version`, а не `needsUpdate`: у `BufferAttribute` в three
 * `needsUpdate` — свойство ТОЛЬКО НА ЗАПИСЬ (сеттер поднимает `version`),
 * и прочитать его нельзя, вернётся `undefined`. Сравнивать надо то, на что
 * смотрит сам `WebGLRenderer`, — номер версии буфера.
 *
 * Прошла бы вхолостую? НЕТ, проверено мутацией: удали
 * `instanceMatrix.needsUpdate = true` из `fillInstances` — падает.
 */
test('переложенные координаты помечены к перезаливке на видеокарту', async () => {
  const { renderer } = await makeTestRenderer()
  const at = (z: number) => sceneWith([{ asset: 'decor/kelp', z }, { asset: 'decor/kelp', z: z + 4 }])
  renderer.draw(at(5))

  const kelp = () => {
    let found: THREE.InstancedMesh | null = null
    renderer.root().traverse((o: any) => {
      if (o.isMesh && o.name === 'decor/kelp') found = o
    })
    return found as unknown as THREE.InstancedMesh
  }
  const mesh = kelp()
  const before = mesh.instanceMatrix.version

  renderer.draw(at(4.5))
  // Меш тот же самый — значит перезаливка и есть единственный способ, каким
  // новые координаты попадут на видеокарту.
  expect(kelp()).toBe(mesh)
  expect(mesh.instanceMatrix.version).toBeGreaterThan(before)
  renderer.dispose()
})

/**
 * Цвет не остаётся от прошлого кадра, когда в новом его нет.
 *
 * Зазор латентный: сегодня `tint` у обочины есть всегда (`decorTint` отдаёт
 * `grassDark`, который есть во всех двенадцати палитрах), и кадра без него
 * не бывает. Но «не бывает сегодня» — свойство ДАННЫХ, а не кода: появится
 * размещение с необязательным `tint`, и переиспользованный меш покажет цвет
 * прошлого кадра там, где свежесобранный дал бы белый.
 *
 * Прошла бы вхолостую? НЕТ: верни условие записи цвета к `tinted` — и
 * второй кадр останется синим.
 */
test('исчезнувший цвет не остаётся от прошлого кадра', () => {
  const assets: LoadedAssets = { 'decor/kelp': fakeAsset([3]) }
  const tinted = sceneWith([{ asset: 'decor/kelp', tint: '#204080' }])
  const group = build3D(tinted, assets)
  const mesh = group.children[0] as THREE.InstancedMesh
  const c = new THREE.Color()
  mesh.getColorAt(0, c)
  expect(c.getHexString()).toBe('204080')

  // Тот же набор и то же число размещений, но цвета в описании больше нет.
  const plain = sceneWith([{ asset: 'decor/kelp' }])
  expect(refill3D(group, plain.placements, assets)).toBe(true)
  mesh.getColorAt(0, c)
  expect(c.getHexString()).toBe('ffffff')

  // И ровно то же самое даёт сборка с нуля — два пути, один кадр.
  const fresh = build3D(plain, assets) as THREE.Group
  const freshMesh = fresh.children[0] as THREE.InstancedMesh
  expect(freshMesh.instanceColor).toBeNull()
})

/**
 * Смена ЗОНЫ пересобирает постоянную часть: небо у каждой зоны своё, и
 * оставить прошлое значило бы ехать по новой зоне под старым небом.
 *
 * Прошла бы вхолостую? НЕТ: сравниваются живой счёт и оценка КАДРА, а у
 * разных зон небо — разный ассет с разным числом вершин.
 */
test('смена зоны меняет небо, а не оставляет прошлое', async () => {
  const { renderer } = await makeTestRenderer()
  const here = sceneWith([{ asset: 'decor/kelp' }])
  renderer.draw(here)
  const sky = () => {
    const names: string[] = []
    renderer.root().traverse((o: any) => {
      if (o.isMesh && o.name.startsWith('sky/')) names.push(o.name)
    })
    return names
  }
  expect(sky()).toEqual(['sky/greenHill'])

  const there = { ...here, zone: 'nebula' }
  renderer.draw(there)
  expect(sky()).toEqual(['sky/nebula'])
  const whole = estimateFrame(there, table)
  expect(renderer.stats()).toEqual({ calls: whole.calls, verts: whole.verts })
  renderer.dispose()
})

/**
 * Внутреннее разрешение 0.7 и очистка за собой.
 *
 * Прошла бы вхолостую? НЕТ: ожидание записано ЛИТЕРАЛОМ (2 × 0.7), а не
 * через `RENDER_SCALE`, иначе проверка сверяла бы константу сама с собой —
 * ровно тот род зелёной по построению сверки, за который этот проект уже
 * платил трижды.
 */
test('внутреннее разрешение 0.7 и собственный размер буфера', async () => {
  const { renderer, gl } = await makeTestRenderer()
  renderer.resize(1280, 720, 2)
  expect(gl.calls.pixelRatio).toBeCloseTo(1.4, 6)
  // Стиль холста вывод не трогает: размер на странице — дело оболочки.
  expect(gl.calls.size).toEqual([1280, 720, false])
  expect(RENDER_SCALE).toBe(0.7)
  renderer.dispose()
})

/**
 * Потеря контекста. Chrome на этом телефоне выгружает контекст, и без
 * пересборки ребёнок видит ЧЁРНЫЙ ЭКРАН до перезапуска приложения.
 *
 * Прошла бы вхолостую? Строка из брифа (`stats().calls > 0`) — ДА, и это
 * найдено МУТАЦИЕЙ, а не рассуждением: кадр собран до потери, и счёт остался
 * бы прежним у вывода, который на событие не подписан вовсе. Больше того,
 * первая написанная здесь версия пересобирала граф уже на `lost`, и тогда
 * проверка проходила даже без подписки на `webglcontextrestored` — зелёная
 * по построению. Поэтому проверяются ТРИ вещи, и каждая убивает свою мутацию:
 *   1. `preventDefault` на `webglcontextlost` — без него браузер контекст
 *      НЕ восстанавливает никогда, и всё остальное бессмысленно;
 *   2. пока контекст потерян, `draw` в него не рисует (на части драйверов
 *      вызов в мёртвый контекст — ошибка, а не пустая операция), но описание
 *      запоминает;
 *   3. после `webglcontextrestored` в графе стоят ДРУГИЕ объекты (собранные
 *      заново) при том же счёте, и нарисован ПОСЛЕДНИЙ кадр, а не позапрошлый.
 */
test('потеря контекста пересобирает вывод', async () => {
  const { renderer, canvas, gl } = await makeTestRenderer()
  const scene = sceneWith([{ asset: 'decor/kelp' }, { asset: 'obstacle/jelly' }])
  renderer.draw(scene)
  const before = renderer.stats()
  const beforeMeshes: unknown[] = []
  renderer.root().traverse((o: any) => {
    if (o.isMesh) beforeMeshes.push(o)
  })
  expect(beforeMeshes.length).toBeGreaterThan(0)

  const lost = canvas.emit('webglcontextlost')
  expect(lost.defaultPrevented).toBe(true)
  expect(renderer.stats().calls).toBeGreaterThan(0)

  /* Пока контекста нет, рисовать нельзя, а помнить — нужно. Кадр взят
     ДРУГОЙ (тело ушло вбок): так видно, что после восстановления рисуется
     последний кадр, а не позапрошлый. */
  const rendersAfterLoss = gl.calls.renders
  const moved = { ...scene, camera: { u: 1, pitch: 0 } }
  renderer.draw(moved)
  expect(gl.calls.renders).toBe(rendersAfterLoss)

  canvas.emit('webglcontextrestored')
  const afterMeshes: unknown[] = []
  renderer.root().traverse((o: any) => {
    if (o.isMesh) afterMeshes.push(o)
  })
  expect(renderer.stats()).toEqual(before)
  expect(afterMeshes).toHaveLength(beforeMeshes.length)
  for (const m of afterMeshes) expect(beforeMeshes).not.toContain(m)
  // Вернулся контекст — вернулась и картинка, а не чёрный экран до
  // следующего вызова `draw`.
  expect(gl.calls.renders).toBe(rendersAfterLoss + 1)
  /* И камера стоит там, где её оставил ПОСЛЕДНИЙ кадр, а не предпоследний:
     первый кадр после восстановления рисуется явной установкой камеры, а не
     тем, что в ней случайно осталось. Найдено мутацией — без этой строки
     пропажа `placeCamera` из обработчика проходила молча. */
  expect(renderer.camera().position.x).toBeCloseTo(cameraX(1), 9)

  // И за собой вывод убирает: после `dispose` подписок не остаётся.
  renderer.dispose()
  expect(canvas.listeners('webglcontextlost')).toBe(0)
  expect(canvas.listeners('webglcontextrestored')).toBe(0)
})

/**
 * `KTX2Loader.detectSupport` — не украшение: без него загрузчик не знает,
 * какой формат просить, и на устройстве без ASTC/ETC2 арт молча не
 * загрузится.
 *
 * Прошла бы вхолостую? НЕТ: выброси вызов — и шпион не сработает.
 */
test('KTX2Loader спрашивает устройство о поддержке, и спрашивает ИМЕННО вывод', async () => {
  const asked: unknown[] = []
  const gl = fakeGL()
  const canvas = stubCanvas()
  const assets = await realAssets()
  const renderer = await makeThreeRenderer(canvas as unknown as HTMLCanvasElement, {
    makeGL: () => gl,
    assets,
    makeKtx2: () => ({
      detectSupport(r: unknown) {
        asked.push(r)
        return this
      },
      dispose() {},
    }),
  })
  // Спрошен именно тот вывод, который будет рисовать: поддержка формата —
  // свойство контекста, а не догадка.
  expect(asked).toEqual([gl])
  renderer.dispose()
})

// ───────────────── `three` живёт только в одной папке ────────────────────

/**
 * Сторож развилки, расширенный на ВСЁ дерево.
 *
 * `tests/guards.test.ts` закрывает `src/core`, `compose.ts` и `estimate.ts` —
 * те файлы, которые существовали, когда он писался. С этого этапа в проекте
 * появился `three`, и дыра стала видна: `src/shell/**` и `src/adapters/**`
 * не защищены ничем, а импорт `three` из главного цикла сделал бы
 * спрайтовый вывод невозможным так же надёжно, как импорт из описания.
 *
 * Прошла бы вхолостую? НЕТ: проверка требует, чтобы `three` нашёлся хотя бы
 * в одном файле разрешённой папки. Без этой половины она была бы зелена и в
 * проекте, где `three` не упоминается вовсе, — то есть при нулевом покрытии
 * выглядела бы так же, как при полном.
 */
test('three импортируется только из src/render/three', () => {
  const ALLOWED = join(ROOT, 'src', 'render', 'three')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx|js|mjs)$/.test(e)) files.push(full)
    }
  }
  walk(join(ROOT, 'src'))

  const importsThree = (file: string) =>
    /(?:from|import|require)\s*\(?\s*['"]three(?:\/[^'"]*)?['"]/.test(readFileSync(file, 'utf8'))

  const outside = files.filter((f) => !f.startsWith(ALLOWED) && importsThree(f))
  expect(outside).toEqual([])
  const inside = files.filter((f) => f.startsWith(ALLOWED) && importsThree(f))
  expect(inside.length).toBeGreaterThan(0)
})

// ───────────── числа, продублированные из копий логики ────────────────────

/**
 * Два числа старого вывода нужны и новому: высота глаз и угол обзора. Оба в
 * копии НЕэкспортируемые (`const EYE = 1.2`, `const FOV = 75 * …`), значит
 * подсмотреть их — завести вторую копию молча. Приём и его обоснование взяты
 * у `tests/guards.test.ts` («числа, продублированные в src/render»).
 *
 * Прошла бы вхолостую? НЕТ: привези синхронизация другой `EYE` — и строка
 * упадёт, назвав обе стороны.
 */
test('высота глаз и угол обзора ещё совпадают с копиями логики', () => {
  const view = readFileSync(join(ROOT, 'src/core/view.js'), 'utf8')
  expect(view).toMatch(/^const EYE = 1\.2;/m)
  expect(EYE_H_M).toBe(1.2)
  expect(view).toMatch(/^const FOV = 75 \* Math\.PI \/ 180;/m)
  expect(HFOV_RAD).toBeCloseTo((75 * Math.PI) / 180, 12)
})

/**
 * Камера читает описание, а не придумывает своё: боковой ход берётся у
 * `cameraX` — ЕДИНСТВЕННОГО владельца этого числа (`src/render/numbers.ts`),
 * того самого, по которому судит `canReach`. Разойдись они — ребёнок тянулся
 * бы к кольцу, которое нарисовано в другом месте.
 *
 * Прошла бы вхолостую? НЕТ: ход камеры при `u = 1` не ноль (0.48 м), и
 * вывод, который `camera.u` игнорирует, оставит камеру в нуле.
 */
test('камера идёт за телом тем же числом, по которому судит игра', async () => {
  const { renderer } = await makeTestRenderer()
  renderer.draw({ ...emptyScene, camera: { u: 1, pitch: 0 } })
  const cam = renderer.camera()
  expect(cameraX(1)).not.toBe(0)
  expect(cam.position.x).toBeCloseTo(cameraX(1), 9)
  expect(cam.position.y).toBeCloseTo(EYE_H_M, 9)

  /* Присед уводит взгляд ВНИЗ: доля из описания становится наклоном здесь, и
     знак у наклона один-единственный верный. */
  renderer.draw({ ...emptyScene, camera: { u: 0, pitch: 1 } })
  expect(renderer.camera().rotation.x).toBeLessThan(0)
  renderer.dispose()
})

/**
 * Дымка — это дальность отсечения, и владелец у неё один: `DRAW_FAR_M`.
 * Прошла бы вхолостую? НЕТ: запиши вывод своё число — и дальний край тумана
 * перестанет совпадать с горизонтом описания.
 */
test('туман кончается там же, где кончается описание', async () => {
  const { renderer } = await makeTestRenderer()
  const fog = renderer.scene().fog as THREE.Fog
  expect(fog.far).toBe(DRAW_FAR_M)
  expect(fog.near).toBeLessThan(fog.far)
  renderer.dispose()
})

/**
 * Запечённый свет: источников света в сцене НЕТ ни одного, и материалы
 * неосвещаемые. Это не экономия, а условие арта (спека: «glTF с запечённым
 * светом»): динамический свет и стоил бы кадров, и осветил бы второй раз то,
 * что уже запечено в текстуре.
 *
 * Прошла бы вхолостую? НЕТ: добавь вывод хоть один `DirectionalLight` — и
 * первая строка упадёт; оставь материал `MeshStandardMaterial` — вторая.
 */
test('свет запечён: источников нет, материалы неосвещаемые', async () => {
  const { renderer } = await makeTestRenderer()
  renderer.draw(sceneWith([{ asset: 'decor/kelp' }]))
  let lights = 0
  let standard = 0
  let basic = 0
  renderer.scene().traverse((o: any) => {
    if (o.isLight) lights += 1
    if (!o.isMesh) return
    if (o.material.isMeshStandardMaterial) standard += 1
    if (o.material.isMeshBasicMaterial) basic += 1
  })
  expect(lights).toBe(0)
  expect(standard).toBe(0)
  expect(basic).toBeGreaterThan(0)
  renderer.dispose()
  forgetMaterials()
})

/**
 * Кадр обязан оказаться ПЕРЕД камерой, а не у неё за спиной.
 *
 * Куплено браузером. Описание держит «вперёд» положительным `z` (левая
 * система, `types.ts`), three.js — правый и смотрит в −Z; без знака минус в
 * `placementMatrix` весь кадр уезжал камере за спину. Ни одна из
 * восьмидесяти проверок этого не видела: `stats3D` считает граф, а не
 * видимость, и `renderer.stats() === estimate` сходилось в точности — при
 * чёрном экране.
 *
 * Прошла бы вхолостую? НЕТ: убери минус — пирамида видимости перестаёт
 * содержать размещение, и первое же `expect` падает. Проверяется именно
 * ВИДИМОСТЬ (пирамида настоящей камеры вывода), а не знак координаты:
 * знак — это та же формула, только переписанная в тест.
 */
test('содержимое кадра стоит перед камерой, а не за спиной', async () => {
  const { renderer } = await makeTestRenderer()
  renderer.resize(1280, 720, 1)
  /* Кольцо на восьми метрах прямо по курсу — такое же, какое отдаёт
     `composeScene` на первой секунде забега. */
  renderer.draw(sceneWith([{ asset: 'star/ring', x: 0, y: 0.55, z: 8 }]))

  /* `any`: `three@0.186` не поставляет типов вовсе, и TypeScript выводит их
     из исходника сам — до половины полей камеры он при этом не добирается.
     Проверяются здесь ЗНАЧЕНИЯ, а не типы. */
  const camera = renderer.camera() as any
  camera.updateMatrixWorld(true)
  const toCamera = (new THREE.Matrix4() as any).copy(camera.matrixWorld).invert()
  const halfV = ((camera.fov * Math.PI) / 180) / 2
  const halfH = HFOV_RAD / 2

  /** Центры всех инстансов кадра в системе координат КАМЕРЫ. */
  const seen: Array<{ x: number; y: number; z: number }> = []
  renderer.root().traverse((o) => {
    const mesh = o as any
    if (!mesh.isInstancedMesh) return
    mesh.updateMatrixWorld(true)
    const m = new THREE.Matrix4()
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m)
      const e = (m as any).elements
      const p = (new THREE.Vector3(e[12], e[13], e[14]) as any)
        .applyMatrix4(mesh.matrixWorld)
        .applyMatrix4(toCamera)
      seen.push({ x: p.x, y: p.y, z: p.z })
    }
  })

  expect(seen.length).toBeGreaterThan(0)
  /* Постоянная часть кадра (пол, стены, небо) стоит в начале координат по
     построению — `backdropPlacements` отдаёт всем `x: 0, y: 0, z: 0`, а
     вперёд её тянет собственная геометрия ассета. Судить о направлении
     взгляда по ней нельзя, поэтому берутся РАЗМЕЩЕНИЯ. */
  const placed = seen.filter((p) => p.z !== 0)
  expect(placed).toHaveLength(1)

  /* Перед камерой — это ОТРИЦАТЕЛЬНЫЙ `z` в её системе: three.js смотрит в
     −Z, а описание держит «вперёд» положительным. */
  expect(placed[0].z).toBeCloseTo(-8, 6)
  // И кольцо попадает в поле зрения, а не уезжает за край кадра.
  expect(Math.abs(placed[0].x)).toBeLessThanOrEqual(-placed[0].z * Math.tan(halfH))
  expect(Math.abs(placed[0].y)).toBeLessThanOrEqual(-placed[0].z * Math.tan(halfV))

  renderer.dispose()
})
