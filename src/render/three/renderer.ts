/**
 * Трёхмерный вывод за интерфейсом: единственное место, которому нужен WebGL.
 *
 * Разделение с `build.ts` не косметическое. Сборка графа и его счёт обязаны
 * работать в `node`, иначе сверить живой счёт с `estimate` можно было бы
 * только на телефоне — то есть никогда в прогоне. Поэтому здесь остаётся
 * ровно то, что без контекста не бывает: `WebGLRenderer`, загрузка ассетов,
 * опрос устройства о форматах текстур и подписка на потерю контекста.
 *
 * Интерфейс `Renderer` намеренно узкий и ничего не говорит про three.js:
 * развилка «3D или 2.5D» ещё не решена, и спрайтовый вывод обязан встать на
 * то же место без правки оболочки.
 */
import * as THREE from 'three'

import { VIEW } from '../../core/config.js'
import { CROUCH_PITCH_GAIN, DRAW_FAR_M } from '../types'
import type { FrameScene } from '../types'
import { cameraX } from '../numbers'
import { backdropPlacements } from '../estimate'
import {
  build3D,
  buildBackdrop,
  forgetMaterials,
  refill3D,
  stats3D,
} from './build'
import type { LoadedAssets } from './build'
import manifest from '../../../assets/manifest.json'

/**
 * Вывод кадра. Ровно четыре действия, и ни одно из них не называет three.js.
 */
export interface Renderer {
  resize(w: number, h: number, dpr: number): void
  draw(scene: FrameScene): void
  stats(): { calls: number; verts: number }
  dispose(): void
}

/**
 * То же самое плюс три окна внутрь — для проверок.
 *
 * Без них «света в сцене нет», «камера пошла за телом» и «туман кончается на
 * горизонте описания» проверялись бы только глазами на телевизоре, то есть
 * никак. Окна отданы ТОЛЬКО на чтение и в `Renderer` не входят: оболочка
 * работает с узким интерфейсом, а спрайтовый вывод ничего из этого иметь не
 * обязан.
 */
export interface ThreeRenderer extends Renderer {
  scene(): THREE.Scene
  camera(): THREE.PerspectiveCamera
  root(): THREE.Group
}

/**
 * Внутреннее разрешение: рисуем в 0.7 от плотности экрана.
 *
 * ЧИСЛО ВЫБРАНО НАМИ И НИЧЕМ ПОКА НЕ ОБОСНОВАНО, кроме здравого смысла.
 * Говорится это прямо, потому что первая версия этого комментария выводила
 * 0.7 из старого вывода, и вывод был натянут: `VIEW.width`/`VIEW.height`
 * фиксируют буфер 1280×720 и игнорируют DPR вовсе («Miracast всё равно
 * пережимает в 720p, рисовать выше — чистый нагрев на GPU, который уже
 * делят распознавание и кодировщик», `src/core/config.js:377`), а
 * `min(dpr, 2) × 0.7` никакого потолка в 720p НЕ ставит: на плотном экране
 * буфер уедет выше. Это не «та же мысль, выраженная долей» — это другая
 * мысль, и притворяться иначе нельзя.
 *
 * В спеке этого числа тоже нет: план и бриф этапа говорят «0.7 из спеки», но
 * в тексте `docs/superpowers/specs/2026-10-21-architecture.md` его нет ни
 * разу — проверено поиском.
 *
 * Чем оно станет: ЗАМЕРОМ. Следующий этап — спайк (`gap95` ≤ 40 мс при позах
 * ≥ 10 Гц), и внутреннее разрешение — первая ручка, которой этот порог
 * берут. Либо замер подтвердит долю, либо на её место встанет абсолютный
 * потолок по числу пикселей буфера, как у старого вывода. До замера менять
 * его по вкусу нельзя — ровно так потолки и уползают.
 */
export const RENDER_SCALE = 0.7

/**
 * Потолок плотности экрана. Выше двух множить незачем: 0.7 от тройной
 * плотности — это втрое больше пикселей ради картинки, которую Miracast
 * всё равно пережмёт в 720p.
 */
export const MAX_DPR = 2

/**
 * Высота глаз ребёнка, метры. Число СТАРОГО вывода (`view.js:28`, `const EYE
 * = 1.2`), наружу оно оттуда не экспортируется, значит подсмотреть его —
 * завести вторую копию молча. Записано здесь с указанием источника, и
 * совпадение сторожит тест, как у `CORRIDOR_H_M` в `types.ts`.
 */
export const EYE_H_M = 1.2

/**
 * Угол обзора ПО ГОРИЗОНТАЛИ. Тоже число старого вывода (`view.js:52`,
 * `const FOV = 75 * Math.PI / 180`), и тоже неэкспортируемое.
 *
 * Горизонтальный, а не вертикальный, хотя three.js просит вертикальный:
 * коридор узкий и длинный, и постоянной обязана оставаться именно
 * ГОРИЗОНТАЛЬНАЯ ширина взгляда — иначе на экране другой пропорции стены
 * разъедутся, а расписание препятствий считано под эту ширину. Вертикальный
 * пересчитывается из него под текущее отношение сторон в `resize`.
 */
export const HFOV_RAD = (75 * Math.PI) / 180

/**
 * Наклон камеры при ПОЛНОМ приседе, радианы.
 *
 * Выведен, а не выбран: старый вывод поднимал горизонт на `VIEW.pitchPx`
 * пикселей при фокусном расстоянии `F = (W/2) / tan(FOV/2)` (`view.js:82`),
 * то есть ровно на `atan(pitchPx / F)`. В трёхмерном выводе подъём горизонта
 * — это и есть наклон камеры вниз, и переносится он этой формулой, а не
 * новым числом на глаз.
 *
 * Делится на `CROUCH_PITCH_GAIN`, потому что описание отдаёт ДОЛЮ, максимум
 * которой при полном приседе равен как раз `CROUCH_PITCH_GAIN` (`compose.ts`:
 * `pitch: state.v * CROUCH_PITCH_GAIN`). Так полный присед даёт в точности
 * старый наклон, а не его половину.
 */
const FOCAL_PX = VIEW.width / 2 / Math.tan(HFOV_RAD / 2)
const CROUCH_TILT_RAD = Math.atan(VIEW.pitchPx / FOCAL_PX) / CROUCH_PITCH_GAIN

/**
 * Где начинается дымка. Дальний край — `DRAW_FAR_M`, ЕДИНСТВЕННЫЙ владелец
 * дальности: по нему `composeScene` выбрасывает дальнее, по нему же судит
 * бюджет, и третьего числа про горизонт в проекте быть не должно.
 *
 * Ширина полосы (четверть дальности) повторяет `FADE_BAND_M` из
 * `compose.ts`, где она приватна. Это ОСОЗНАННЫЙ повтор доли, а не второй
 * владелец дальности: разойдись они, картинка начнёт растворяться чуть
 * раньше или чуть позже, чем обещает `fade` описания, — расхождение
 * косметическое и ни одного судейского числа не трогает.
 */
const FOG_NEAR_M = DRAW_FAR_M - DRAW_FAR_M * 0.25

/**
 * Цвет дымки.
 *
 * Нейтральный, и это ЗАМЕЧЕННАЯ дыра, а не решение: правильный цвет дымки —
 * цвет неба зоны, но описание кадра его не несёт. Разбирать `THEME[zone]`
 * здесь нельзя: тогда таблица палитры завелась бы в каждом способе вывода
 * второй копией — ровно та протечка, от которой в `types.ts` заведено
 * «`tint` несёт ГОТОВЫЙ цвет». Когда дымке понадобится цвет зоны, он
 * приедет полем описания, как приехал `tint`.
 */
const HAZE = '#9fb3c8'

/** Поддельный и настоящий `WebGLRenderer` — то, чем вывод его трогает. */
export type GLLike = {
  setPixelRatio(value: number): void
  setSize(width: number, height: number, updateStyle?: boolean): void
  render(scene: THREE.Object3D, camera: THREE.Object3D): void
  dispose(): void
}

/** То, чем вывод трогает `KTX2Loader`. */
export type Ktx2Like = {
  detectSupport(renderer: unknown): unknown
  dispose?(): void
}

/**
 * Подмены для прогона. Не отладочный ход, а единственный способ проверить
 * вывод там, где WebGL нет: приём взят у `tools/budget.mjs`, где `deps`
 * заведены ровно затем, чтобы прогнать перебор подменённым счётчиком.
 */
export type ThreeRendererDeps = {
  makeGL?: (canvas: HTMLCanvasElement) => GLLike
  makeKtx2?: () => Ktx2Like | null | Promise<Ktx2Like | null>
  assets?: LoadedAssets
  loadAssets?: (ktx2: Ktx2Like | null) => Promise<LoadedAssets>
}

/**
 * Путь к транскодеру Basis. Файлов там пока нет, и это не упущение:
 * `.ktx2` в комплекте тоже нет ни одного (сжатие отложено за замер,
 * `docs/art-placeholders.md`). `detectSupport` при этом зовётся всё равно —
 * без него загрузчик не знает, какой формат просить, и в день прихода
 * первого `.ktx2` устройство без ASTC и ETC2 молча не получило бы арт.
 */
const TRANSCODER_PATH = 'assets/basis/'

async function defaultKtx2(): Promise<Ktx2Like | null> {
  /* Спецификатор ЛИТЕРАЛОМ, и это не косметика. Прежняя форма — строка в
     переменной плюс `@vite-ignore` — обходила отсутствие `.d.ts` у аддонов
     (TS7016), но ценой того, что сборщик путь не переписывал: в браузер
     уезжало голое `three/examples/...`, и страница падала с «Failed to
     resolve module specifier». Типы теперь объявлены рядом (`addons.d.ts`),
     и обход не нужен. */
  const { KTX2Loader } = await import('three/examples/jsm/loaders/KTX2Loader.js')
  return new KTX2Loader().setTranscoderPath(TRANSCODER_PATH) as Ktx2Like
}

/**
 * Загрузка всех ассетов комплекта.
 *
 * Список имён берётся из `assets/manifest.json` — того же файла, по которому
 * считает бюджет. Второй список имён в коде означал бы ассет, который
 * посчитан, но не загружен (или наоборот), и обнаружилось бы это белой
 * дырой в кадре.
 */
async function defaultLoadAssets(ktx2: Ktx2Like | null): Promise<LoadedAssets> {
  /* Литералом, по той же причине, что и у `KTX2Loader` выше. */
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const loader = new GLTFLoader()
  if (ktx2) loader.setKTX2Loader(ktx2)

  const assets: LoadedAssets = {}
  for (const id of Object.keys(manifest)) {
    const gltf = await loader.loadAsync(`assets/${id}.glb`)
    assets[id] = gltf.scene
  }
  return assets
}

function defaultGL(canvas: HTMLCanvasElement): GLLike {
  return new THREE.WebGLRenderer({
    canvas,
    /* Сглаживание выключено намеренно: Miracast пережимает картинку в 720p,
       и тонкая разница на кромке через это сжатие не доживает, а кадры
       стоит. Крупные формы и заливка — правило CLAUDE.md про Miracast. */
    antialias: false,
    powerPreference: 'high-performance',
  }) as unknown as GLLike
}

/**
 * Трёхмерный вывод.
 *
 * Асинхронный ровно по одной причине: до первого кадра надо спросить
 * устройство о форматах текстур и загрузить ассеты, а и то и другое —
 * обещания.
 */
export async function makeThreeRenderer(
  canvas: HTMLCanvasElement,
  deps: ThreeRendererDeps = {},
): Promise<ThreeRenderer> {
  const gl = (deps.makeGL ?? defaultGL)(canvas)

  /* Порядок важен: сначала контекст, потом опрос поддержки, и только потом
     загрузка. `detectSupport` читает расширения ИМЕННО этого контекста —
     спросить раньше не у кого, спросить позже значит грузить вслепую. */
  const ktx2 = (await (deps.makeKtx2 ?? defaultKtx2)()) ?? null
  if (ktx2) ktx2.detectSupport(gl)

  const assets = deps.assets ?? (await (deps.loadAssets ?? defaultLoadAssets)(ktx2))

  const scene = new THREE.Scene()
  /* Света в сцене нет ни одного источника: он ЗАПЕЧЁН в текстуры (спека,
     «Арт делается один раз и годится обоим»). Динамический свет и стоил бы
     кадров, и осветил бы второй раз то, что уже нарисовано. */
  scene.fog = new THREE.Fog(HAZE, FOG_NEAR_M, DRAW_FAR_M)

  const camera = new THREE.PerspectiveCamera(1, 16 / 9, 0.05, DRAW_FAR_M * 1.5)
  const root = new THREE.Group()
  root.name = 'frame'
  scene.add(root)

  /** Последнее описание: по нему пересобирается кадр после потери контекста. */
  let last: FrameScene | null = null
  let disposed = false
  /** Контекст выгружен браузером: рисовать некуда, пока его не вернут. */
  let contextLost = false
  /* Две группы кадра держатся по ссылке, а не ищутся в корне каждый кадр:
     меняются они по разным поводам (небо — раз в зону, размещения — когда
     въезжает препятствие), и переложить координаты можно только в ту, что
     уже стоит. */
  let backdrop: THREE.Group | null = null
  let placements: THREE.Group | null = null

  /** Применяет угол обзора под текущее отношение сторон. */
  function applyFov(aspect: number): void {
    camera.aspect = aspect
    /* Постоянной держится ГОРИЗОНТАЛЬНАЯ ширина взгляда (см. `HFOV_RAD`), а
       three.js просит вертикальный угол — отсюда пересчёт, а не константа. */
    const vfov = 2 * Math.atan(Math.tan(HFOV_RAD / 2) / aspect)
    camera.fov = (vfov * 180) / Math.PI
    camera.updateProjectionMatrix()
  }
  applyFov(16 / 9)

  /**
   * Разбирает кадр.
   *
   * Уничтожаются ТОЛЬКО инстанс-буферы: геометрия принадлежит загруженному
   * ассету и переживает кадр, материалы лежат в кэше `build.ts` и
   * переиспользуются — иначе шейдерная программа компилировалась бы заново
   * каждый кадр.
   */
  function disposeInstances(group: THREE.Object3D): void {
    group.traverse((o) => {
      const mesh = o as THREE.InstancedMesh & { isInstancedMesh?: boolean }
      if (mesh.isInstancedMesh) mesh.dispose()
    })
  }

  function teardown(): void {
    disposeInstances(root)
    root.clear()
    backdrop = null
    placements = null
  }

  /**
   * Готовит кадр к отрисовке.
   *
   * ГЛАВНЫЙ ПУТЬ — переложить координаты в уже собранный граф (`refill3D`),
   * и пересобрать только если изменился САМ НАБОР ассетов в кадре. Полная
   * пересборка шестьдесят раз в секунду создавала бы шестьдесят раз в
   * секунду новые меши, инстанс-буферы и VAO — мусор, который сборщик
   * придёт убирать посреди забега, и следующий этап (замер `gap95`) измерил
   * бы его, а не трёхмерный вывод.
   *
   * Постоянная часть и размещения живут в двух отдельных группах, потому
   * что меняются они по-разному: небо — раз в зону, размещения — когда
   * въезжает новое препятствие. Общий корень у них один, потому что судятся
   * они вместе: `renderer.stats()` сверяется с `estimateFrame`.
   */
  function sync(): void {
    if (!last) return
    if (!backdrop || !refill3D(backdrop, backdropPlacements(last), assets)) {
      backdrop = replace(backdrop, buildBackdrop(last, assets))
    }
    if (!placements || !refill3D(placements, last.placements, assets)) {
      placements = replace(placements, build3D(last, assets))
    }
  }

  /** Меняет одну группу корня на другую, уничтожая инстанс-буферы старой. */
  function replace(old: THREE.Group | null, made: THREE.Group): THREE.Group {
    if (old) {
      disposeInstances(old)
      root.remove(old)
    }
    root.add(made)
    return made
  }

  /** Пересборка с нуля: после восстановления контекста старые буферы мертвы. */
  function rebuild(): void {
    teardown()
    sync()
  }

  function placeCamera(view: FrameScene['camera']): void {
    /* Боковой ход берётся у `cameraX` — того же числа, по которому судит
       `canReach`. Своя формула здесь означала бы, что ребёнок тянется к
       кольцу, которое нарисовано в другом месте. */
    camera.position.set(cameraX(view.u), EYE_H_M * (1 - view.pitch), 0)
    /* Присед уводит взгляд ВНИЗ: в старом выводе это подъём горизонта на
       `VIEW.pitchPx`, здесь — наклон на тот же угол (см. `CROUCH_TILT_RAD`).
       Крена нет и не будет: наклон горизонта — главный источник укачивания
       (`config.js:394`). */
    camera.rotation.set(-view.pitch * CROUCH_TILT_RAD, 0, 0)
  }

  /**
   * Потеря контекста.
   *
   * Разделение работы между двумя обработчиками не формальное. На `lost`
   * делать с графом нечего — контекста уже нет, — но сделать НАДО две вещи:
   *
   *   1. `preventDefault`. Без него браузер контекст не восстанавливает
   *      НИКОГДА, и ребёнок видит чёрный экран до перезапуска приложения.
   *      Chrome на этом телефоне контекст выгружает — это не редкость.
   *   2. выбросить кэш материалов: скомпилированные шейдерные программы
   *      умерли вместе с контекстом, и переиспользовать материал, который
   *      помнит мёртвую программу, нельзя.
   *
   * А пересборка — на `restored`, и только там: собирать граф в мёртвый
   * контекст бессмысленно. Между двумя событиями вывод не рисует вовсе
   * (`draw` запоминает описание и выходит): вызов в потерянный контекст на
   * части драйверов — не пустая операция, а ошибка.
   */
  const onLost = (e: Event): void => {
    e.preventDefault()
    contextLost = true
    forgetMaterials(assets)
  }

  const onRestored = (): void => {
    contextLost = false
    rebuild()
    if (!last) return
    /* Камера ставится и здесь: первый кадр после восстановления обязан быть
       тем же, что был до потери, а не нарисованным мимо явной установки. */
    placeCamera(last.camera)
    gl.render(scene, camera)
  }

  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    resize(w: number, h: number, dpr: number): void {
      gl.setPixelRatio(Math.min(dpr, MAX_DPR) * RENDER_SCALE)
      /* `updateStyle = false`: размер холста НА СТРАНИЦЕ — дело оболочки,
         вывод распоряжается только буфером. */
      gl.setSize(w, h, false)
      applyFov(w / h)
    },

    draw(frame: FrameScene): void {
      if (disposed) return
      /* Описание запоминается ВСЕГДА, даже без контекста: когда он
         вернётся, пересобирать надо последний кадр, а не позапрошлый. */
      last = frame
      if (contextLost) return
      sync()
      placeCamera(frame.camera)
      gl.render(scene, camera)
    },

    /**
     * Живой счёт — тот самый, который сверяется с `estimateFrame` того же
     * кадра. Считается по собранному графу (`stats3D`), а не по
     * `WebGLRenderer.info`: `info` врёт в меньшую сторону на всём, что
     * отсекла пирамида видимости, и сверять с оценкой надо то, что ОТДАНО
     * на отрисовку.
     */
    stats(): { calls: number; verts: number } {
      return stats3D(root)
    },

    dispose(): void {
      disposed = true
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      teardown()
      ktx2?.dispose?.()
      gl.dispose()
    },

    scene: () => scene,
    camera: () => camera,
    root: () => root,
  }
}
