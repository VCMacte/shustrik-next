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
 * программы вместе с контекстом становятся недействительными, и переиспользовать
 * материал, который помнит мёртвую программу, нельзя.
 */
export function forgetMaterials(): void {
  for (const m of unlitCache.values()) m.dispose()
  unlitCache.clear()
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
    /* Туман — это и есть дымка описания (см. `applyPlacement`), поэтому
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

/** Складывает размещения ОДНОГО ассета в инстанс-наборы, по одному на примитив. */
function addInstanced(
  group: THREE.Group,
  id: AssetId,
  list: Placement[],
  assets: LoadedAssets,
): void {
  const prims = primitivesOf(id, protoOf(id, assets))
  /* Цвет заводится только если он кому-то нужен: `instanceColor` — лишний
     буфер на GPU, а у препятствий и колец `tint` не бывает вовсе. */
  const tinted = list.some((p) => p.tint)

  for (const prim of prims) {
    const mesh = new THREE.InstancedMesh(prim.geometry, unlit(prim.material), list.length)
    mesh.name = id
    for (let i = 0; i < list.length; i++) {
      mesh.setMatrixAt(i, placementMatrix(list[i], prim.local))
      if (tinted) {
        const tint = list[i].tint
        mesh.setColorAt(i, tint ? tmpColor.set(tint) : WHITE)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
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
  for (const id of backdropAssets(scene)) {
    addInstanced(group, id, [{ asset: id, x: 0, y: 0, z: 0 }], assets)
  }
  return group
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
 * Где лежит текстура ассета.
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
