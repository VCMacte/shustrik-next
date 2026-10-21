/**
 * Описание кадра → граф three.js. БЕЗ WebGL: это чистая сборка объектов, и
 * контекст ей не нужен вовсе.
 *
 * Зачем так. Правило проекта — **число, по которому СУДЯТ, и число, которое
 * РИСУЮТ, берутся из одного места** (CLAUDE.md). Справа `estimate(scene,
 * table)` считает кадр в `node`; чтобы сверить с ним ЖИВОЙ счёт, живой счёт
 * тоже обязан получаться в `node`. Поэтому граф собирается здесь, а
 * `WebGLRenderer` живёт в `renderer.ts` и в сверке не участвует: он
 * ПОКАЗЫВАЕТ то, что собрано, а не решает, сколько этого.
 *
 * Это единственное место (вместе с `renderer.ts`), где `three` разрешён:
 * `src/core/**`, `src/render/compose.ts` и `src/render/estimate.ts` не
 * вправе его знать, и это сторожит `tests/guards.test.ts`. Развилка «3D или
 * 2.5D» держится открытой именно тем, что описание не знает о выводе.
 */
import * as THREE from 'three'

import { backdropAssets } from '../estimate'
import type { AssetId, FrameScene, Placement } from '../types'

/**
 * Загруженные ассеты: имя → корень разобранного `.glb`.
 *
 * Именно узел glTF, а не «геометрия»: у ассета может быть несколько
 * примитивов (у `obstacle/jelly` их два — тело и оболочка свечения), и
 * каждый несёт свой материал. Свести их к одной геометрии значило бы
 * потерять второй вызов отрисовки — ровно ту ошибку, которую этот ассет
 * нарочно и ловит (`docs/art-placeholders.md`).
 */
export type LoadedAssets = Record<AssetId, THREE.Object3D>

/** Один примитив ассета: что рисовать, чем и с каким своим смещением. */
type Primitive = {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  /** Матрица меша ВНУТРИ своего `.glb`: у ассета бывает своя иерархия. */
  local: THREE.Matrix4
}

/*
 * Два кэша, и оба — не оптимизация ради оптимизации, а условие того, чтобы
 * `draw` можно было звать каждый кадр.
 *
 * РАЗБОР ПРОТОТИПА. Обход `traverse` по узлу glTF даёт один и тот же ответ
 * всю жизнь приложения: ассет загружен один раз и не меняется.
 *
 * МАТЕРИАЛЫ. Новый `MeshBasicMaterial` на каждый кадр — это перекомпиляция
 * шейдерной программы на каждом кадре, то есть провал ровно того замера,
 * ради которого проект и затеян. Кэш держит по одному неосвещаемому
 * материалу на каждый исходный материал ассета.
 */
const primitivesCache = new Map<THREE.Object3D, Primitive[]>()
const unlitCache = new Map<THREE.Material, THREE.MeshBasicMaterial>()

/**
 * Выбрасывает кэш материалов, уничтожая их.
 *
 * Нужен в одном месте — при потере контекста WebGL: скомпилированные
 * программы вместе с контекстом становятся недействительными, и
 * переиспользовать материал, который помнит мёртвую программу, нельзя.
 *
 * `assets` — ЧЬИ материалы забыть, и этот параметр не для удобства. Кэш
 * модульный (ключ — сам материал ассета, то есть объект), и забыть всё
 * означало бы уничтожить материалы ЧУЖОГО вывода: сегодня вывод один, но
 * потеря контекста у одного не повод ронять картинку у другого. Без
 * аргумента забывается всё — это для прогонов, которым кэш надо обнулить
 * целиком.
 */
export function forgetMaterials(assets?: LoadedAssets): void {
  const sources = assets ? sourceMaterialsOf(assets) : null
  for (const [src, made] of unlitCache) {
    if (sources && !sources.has(src)) continue
    made.dispose()
    unlitCache.delete(src)
  }
}

/** Все исходные материалы набора ассетов — ключи, по которым живёт кэш. */
function sourceMaterialsOf(assets: LoadedAssets): Set<THREE.Material> {
  const out = new Set<THREE.Material>()
  for (const [id, proto] of Object.entries(assets)) {
    for (const prim of primitivesOf(id, proto)) out.add(prim.material)
  }
  return out
}

/**
 * Неосвещаемый материал вместо того, что пришёл из glTF.
 *
 * Свет ЗАПЕЧЁН в текстуру (спека: «Источник — glTF с запечённым светом»),
 * значит сцене не нужен ни один источник света, а `MeshStandardMaterial`,
 * который отдаёт `GLTFLoader`, без источников был бы просто чёрным. Замена
 * на неосвещаемый материал — не упрощение картинки, а единственный способ
 * показать ровно то, что запёк художник, и не платить за второй свет поверх
 * первого.
 *
 * Число вызовов от замены не меняется: материалов столько же, сколько было.
 */
function unlit(src: THREE.Material): THREE.MeshBasicMaterial {
  const cached = unlitCache.get(src)
  if (cached) return cached
  const loose = src as unknown as { map?: unknown; color?: THREE.Color }
  const made = new THREE.MeshBasicMaterial({
    map: loose.map,
    /* Туман — это и есть дымка описания (см. `placementMatrix`), поэтому
       материал обязан его слушать. */
    fog: true,
  })
  if (loose.color) made.color.copy(loose.color)
  made.name = src.name
  unlitCache.set(src, made)
  return made
}

/** Примитивы ассета: по одному на каждый меш его иерархии. */
function primitivesOf(id: AssetId, root: THREE.Object3D): Primitive[] {
  const cached = primitivesCache.get(root)
  if (cached) return cached

  /* Матрицы считаются от корня ассета: у `.glb` бывает своя иерархия, и
     меш внутри неё может стоять со смещением. Потерять его значило бы
     собрать ассет развалившимся. */
  root.updateMatrixWorld(true)

  const prims: Primitive[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!(mesh as { isMesh?: boolean }).isMesh) return
    if (Array.isArray(mesh.material)) {
      /* Меш с МАССИВОМ материалов рисуется по группам одной геометрии, и
         его вершины посчитались бы по разу на каждую группу — то есть
         живой счёт разошёлся бы с оценкой, которая считает вершины по
         примитивам. `GLTFLoader` такого не отдаёт (каждый примитив
         приезжает отдельным мешем), поэтому это не запрет возможности, а
         громкий отказ на случай, который сломал бы сверку молча. */
      throw new Error(
        `ассет ${id}: меш с массивом материалов не поддерживается — ` +
          'живой счёт вершин разошёлся бы с оценкой',
      )
    }
    prims.push({
      geometry: mesh.geometry,
      material: mesh.material,
      local: mesh.matrixWorld.clone(),
    })
  })

  if (prims.length === 0) {
    throw new Error(`ассет ${id} не несёт ни одного меша: на экране он был бы дырой`)
  }
  primitivesCache.set(root, prims)
  return prims
}

function protoOf(id: AssetId, assets: LoadedAssets): THREE.Object3D {
  const proto = assets[id]
  /* Громко, а не молча, и по той же причине, что у `costOf` в `estimate.ts`:
     пропущенный ассет — это либо разъехавшиеся имена, либо дыра в кадре на
     телевизоре, и узнать об этом надо на сборке, а не глазами ребёнка. */
  if (!proto) throw new Error(`ассета ${id} нет среди загруженных`)
  return proto
}

/* Переиспользуемые болванки: `build3D` зовётся каждый кадр, и три новых
   вектора на каждое размещение — это мусор, который соберёт сборщик ровно
   в тот момент, когда нужен ровный кадр. */
const tmpPos = new THREE.Vector3()
const tmpQuat = new THREE.Quaternion()
const tmpScale = new THREE.Vector3()
const tmpEuler = new THREE.Euler()
const tmpMatrix = new THREE.Matrix4()
const tmpPlaced = new THREE.Matrix4()
const tmpColor = new THREE.Color()
const WHITE = new THREE.Color('#ffffff')

/**
 * Матрица одного размещения.
 *
 * `size` — ГАБАРИТ В МЕТРАХ по каждой оси, а не множитель: ассеты нормированы
 * в единицу, отсутствующее измерение значит «свой натуральный метр»
 * (`types.ts`, договор об именах). Равномерный `scale` сжал бы боковую плиту
 * по высоте вместе с шириной, то есть ступень сложности меняла бы высоту
 * препятствия.
 *
 * Чего здесь НЕТ: `fade`. Дымка исполняется ТУМАНОМ сцены (`renderer.ts`), а
 * не прозрачностью, и это следствие правила «судят и рисуют по одному
 * числу»: `estimate` считает один вызов на примитив, то есть один проход.
 * Прозрачность добавила бы сортировку и перерисовку, а любой второй проход
 * на то же размещение сломал бы равенство сверху молча — именно об этом
 * предупредило ревью прошлого этапа. Туман же берёт ту же глубину `z` и
 * стоит ноль вызовов.
 */
function placementMatrix(p: Placement, local: THREE.Matrix4): THREE.Matrix4 {
  tmpPos.set(p.x, p.y, p.z)
  tmpEuler.set(0, p.yaw ?? 0, 0)
  tmpQuat.setFromEuler(tmpEuler)
  tmpScale.set(p.size?.w ?? 1, p.size?.h ?? 1, p.size?.d ?? 1)
  tmpPlaced.compose(tmpPos, tmpQuat, tmpScale)
  return tmpMatrix.multiplyMatrices(tmpPlaced, local)
}

/**
 * Раскладывает размещения по инстансам УЖЕ СУЩЕСТВУЮЩЕГО меша.
 *
 * Отдельно от создания меша, потому что это и есть работа каждого кадра:
 * координаты меняются шестьдесят раз в секунду, а набор мешей — нет.
 */
function fillInstances(mesh: THREE.InstancedMesh, prim: Primitive, list: Placement[]): void {
  /* Цвет заводится только если он кому-то нужен: `instanceColor` — лишний
     буфер на GPU, а у препятствий и колец `tint` не бывает вовсе.
     НО: если буфер цвета у меша УЖЕ есть, писать в него надо и тогда, когда
     в новом кадре цвета ни у кого нет. Иначе в переиспользованном меше
     остался бы цвет прошлого кадра, а свежесобранный дал бы белый — два
     разных кадра из одного описания, и расходились бы они молча. Сегодня
     такой кадр недостижим (`decorTint` всегда что-то возвращает: `grassDark`
     есть во всех двенадцати палитрах), но «недостижимо сегодня» — это не
     свойство кода, а свойство данных, и держать на нём правильность
     отрисовки нельзя. */
  const tinted = list.some((p) => p.tint)
  const colored = tinted || mesh.instanceColor !== null
  for (let i = 0; i < list.length; i++) {
    mesh.setMatrixAt(i, placementMatrix(list[i], prim.local))
    if (colored) {
      const tint = list[i].tint
      mesh.setColorAt(i, tint ? tmpColor.set(tint) : WHITE)
    }
  }
  /* БЕЗ этих двух строк буфер не уедет на видеокарту, и кадр ЗАМРЁТ на
     первом: `setMatrixAt` пишет в оперативную память, а заливает её
     `WebGLRenderer`, и только по этому флагу. На поддельном выводе такого не
     видно вовсе — никто ничего не заливает, — поэтому флаг требует
     отдельная проверка. Из всех способов соврать замеру этот самый тихий:
     замерший кадр покажет прекрасный `gap95` и ложно выиграет развилку. */
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

/** Складывает размещения ОДНОГО ассета в инстанс-наборы, по одному на примитив. */
function addInstanced(
  group: THREE.Group,
  id: AssetId,
  list: Placement[],
  assets: LoadedAssets,
): void {
  const prims = primitivesOf(id, protoOf(id, assets))
  for (const prim of prims) {
    const mesh = new THREE.InstancedMesh(prim.geometry, unlit(prim.material), list.length)
    mesh.name = id
    fillInstances(mesh, prim, list)
    group.add(mesh)
  }
}

/** Группирует размещения по имени ассета, сохраняя порядок первого появления. */
function byAsset(placements: Placement[]): Map<AssetId, Placement[]> {
  const groups = new Map<AssetId, Placement[]>()
  for (const p of placements) {
    const list = groups.get(p.asset)
    if (list) list.push(p)
    else groups.set(p.asset, [p])
  }
  return groups
}

/**
 * Размещения кадра → граф three.js.
 *
 * ИНСТАНСИРОВАНИЕ — главное правило сборки, и оно то же самое, по которому
 * считает `estimate`: размещения с ОДНИМ именем ассета сливаются в один
 * `InstancedMesh` на примитив. Не украшение и не оптимизация «на всякий
 * случай»: разойдись сборка с этим правилом — и живой счёт разойдётся с
 * оценкой, то есть бюджет начнёт врать уверенно.
 *
 * Постоянной части кадра (пол, стены, небо зоны) здесь НЕТ, и это не
 * забывчивость: `estimate` — чистая сумма по списку размещений, и `build3D`
 * обязан быть его ровней. Кадр целиком собирает `renderer.draw`, добавляя
 * `buildBackdrop`, и сверяется он с `estimateFrame`.
 */
export function build3D(scene: FrameScene, assets: LoadedAssets): THREE.Group {
  const group = new THREE.Group()
  group.name = 'placements'
  for (const [id, list] of byAsset(scene.placements)) addInstanced(group, id, list, assets)
  return group
}

/**
 * Постоянная часть кадра: пол, стены и небо ЗОНЫ.
 *
 * Список берётся у `backdropAssets` — единственного владельца (`estimate.ts`),
 * а не собирается здесь вторично: два списка разъехались бы, и вывод рисовал
 * бы не то, что посчитано. Небо — по зоне кадра, а не одно на игру: небес
 * двенадцать, и все разом это 32 МБ из 75.
 */
export function buildBackdrop(scene: FrameScene, assets: LoadedAssets): THREE.Group {
  const group = new THREE.Group()
  group.name = 'backdrop'
  for (const p of backdropPlacements(scene)) addInstanced(group, p.asset, [p], assets)
  return group
}

/** Постоянная часть кадра как список размещений — по одному на ассет. */
export function backdropPlacements(scene: FrameScene): Placement[] {
  return backdropAssets(scene).map((asset) => ({ asset, x: 0, y: 0, z: 0 }))
}

/**
 * Переложить НОВЫЕ координаты в УЖЕ СОБРАННЫЙ граф, не пересобирая его.
 *
 * Это главный путь кадра, и он не оптимизация «на потом». Полная пересборка
 * шестьдесят раз в секунду — это шестьдесят раз в секунду новые
 * `InstancedMesh`, новые инстанс-буферы и новые VAO, то есть мусор, который
 * сборщик придёт убирать ровно посреди забега. Следующий этап — ЗАМЕР
 * (`gap95` ≤ 40 мс при позах ≥ 10 Гц), и по нему решается развилка «3D или
 * 2.5D»: вывод, пересобирающий сцену каждый кадр, измерил бы сборщик мусора,
 * а не трёхмерный вывод, и развилка решилась бы по причине, которой в
 * замысле нет.
 *
 * Отдаёт `false`, когда переложить нельзя — изменился САМ НАБОР: другие
 * ассеты в кадре, другое их число или другое количество размещений у
 * ассета. Тогда зовущий пересобирает (`build3D`), и это законно: смена
 * набора в кадре случается не каждый кадр, а при въезде нового препятствия
 * или смене зоны.
 *
 * Порядок сравнения тот же, что у сборки (`byAsset` хранит порядок первого
 * появления), поэтому совпадение имён по позициям — не совпадение, а то же
 * самое правило, прочитанное дважды.
 */
export function refill3D(
  group: THREE.Group,
  placements: Placement[],
  assets: LoadedAssets,
): boolean {
  const groups = byAsset(placements)

  /* Сначала СВЕРКА целиком и только потом запись: наполовину переложенный
     граф — это кадр, в котором часть предметов из прошлого кадра, и
     отличить его от правильного на глаз нельзя. */
  let at = 0
  const plan: Array<{ mesh: THREE.InstancedMesh; prim: Primitive; list: Placement[] }> = []
  for (const [id, list] of groups) {
    const prims = primitivesOf(id, protoOf(id, assets))
    for (const prim of prims) {
      const mesh = group.children[at] as THREE.InstancedMesh | undefined
      at += 1
      if (!mesh || mesh.name !== id || mesh.count !== list.length) return false
      if (mesh.geometry !== prim.geometry) return false
      plan.push({ mesh, prim, list })
    }
  }
  if (at !== group.children.length) return false

  for (const step of plan) fillInstances(step.mesh, step.prim, step.list)
  return true
}

/**
 * ЖИВОЙ счёт собранного графа: вызовы и вершины.
 *
 * Считается по тому же правилу, что и оценка, но С ДРУГОЙ СТОРОНЫ: вызовы —
 * по мешам графа (меш на примитив), вершины — по `position.count` настоящей
 * геометрии, умноженному на число инстансов. Ни одно из двух чисел не
 * приходит из `assets/manifest.json`, поэтому сверка с `estimate` не
 * круговая: слева двоичная геометрия `.glb`, справа строка таблицы.
 *
 * Чего это число НЕ учитывает — и это honest-оговорка, а не недосмотр:
 * отсечения по пирамиде видимости. `WebGLRenderer.info.render.calls` на
 * устройстве будет НЕ БОЛЬШЕ: three.js не рисует то, что за кадром. То есть
 * `stats3D` — оценка сверху для живого GPU, и расходиться с `estimate` она
 * не вправе, а `info` вправе быть меньше их обоих.
 */
export function stats3D(group: THREE.Object3D): { calls: number; verts: number } {
  let calls = 0
  let verts = 0
  group.traverse((o) => {
    const mesh = o as THREE.Mesh & { isMesh?: boolean; isInstancedMesh?: boolean; count?: number }
    if (!mesh.isMesh) return
    const position = mesh.geometry.attributes.position
    if (!position) {
      throw new Error(`меш ${mesh.name || '?'} без атрибута position: нарисовать его нечем`)
    }
    /* Инстансы — это ОДИН вызов, но вершины по каждому: слияние в один батч
       не делает вторую пальму бесплатной для вершинного конвейера. */
    const instances = mesh.isInstancedMesh ? (mesh.count ?? 1) : 1
    calls += 1
    verts += position.count * instances
  })
  return { calls, verts }
}

// ───────────────────────────── текстуры ──────────────────────────────────

/** Что умеет устройство. Ровно то, о чём спрашивает `KTX2Loader.detectSupport`. */
export type TextureSupport = { astc: boolean; etc2: boolean }

/**
 * Где лежит текстура ассета. **ЗАГОТОВКА, которая сегодня НЕ в пути
 * загрузки, и это надо знать, читая тесты на неё.**
 *
 * Настоящие текстуры приезжают ссылкой `images[].uri` ВНУТРИ `.glb`, и
 * разрешает её `GLTFLoader` сам: ни один производственный файл эту функцию
 * не зовёт. Значит тест на неё проверяет ФУНКЦИЮ, а не путь загрузки, и
 * называть это «откат текстур работает» нельзя — работает правило выбора.
 * Оживёт она вместе с KTX2, то есть после замера: тогда загрузчику
 * понадобится спросить «сжатая или нет», и спросить он обязан в одном месте.
 *
 * Сегодня ответ всегда один — `.png`, и это не запасной путь, а ОСНОВНОЙ:
 * KTX2/Basis-сжатие отложено за замер, и в `assets/tex/` нет ни одного
 * `.ktx2` (`docs/art-placeholders.md`, «Чего в заглушках НЕТ»). Поэтому
 * третий параметр по умолчанию пуст: сжатых текстур не существует, и
 * спрашивать устройство не о чем.
 *
 * Почему функция всё равно есть и почему правило выбора записано ОДИН раз.
 * Когда `.ktx2` появятся, выбор «сжатая или нет» будет нужен и трёхмерному
 * выводу, и спрайтовому. Две копии этого правила означали бы, что на
 * устройстве без ASTC и ETC2 один из выводов молча не загрузит арт — а
 * молчание здесь выглядит как белая заглушка на телевизоре, а не как ошибка.
 *
 * `available` — список ассетов, у которых сжатая текстура ДЕЙСТВИТЕЛЬНО
 * есть. Без него функция отдавала бы ссылку в пустоту на всё подряд, стоит
 * устройству заявить поддержку: отсутствующий файл не роняет загрузку, он
 * даёт БЕЛУЮ текстуру, то есть молча неверную картинку.
 */
export function textureUrlFor(
  id: AssetId,
  support: TextureSupport,
  available: ReadonlySet<AssetId> = NO_COMPRESSED_TEXTURES,
): string {
  const compressed = (support.astc || support.etc2) && available.has(id)
  return compressed ? `assets/tex/${id}.ktx2` : `assets/tex/${id}.png`
}

/** Сжатых текстур пока нет ни одной; сторож на диске это проверяет. */
const NO_COMPRESSED_TEXTURES: ReadonlySet<AssetId> = new Set<AssetId>()
