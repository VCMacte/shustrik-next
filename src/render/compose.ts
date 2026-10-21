/**
 * `RunState` → `FrameScene`: кадр как ОПИСАНИЕ.
 *
 * Чистая функция без побочных эффектов и без единого слова про отрисовку —
 * этим и только этим держится открытой развилка «3D или 2.5D»
 * (docs/superpowers/specs/2026-10-21-architecture.md). Импорт `three` сюда
 * закрыт сторожем `tests/guards.test.ts`, и это смысл файла, а не помеха ему.
 */
import { OBSTACLES, VIEW } from '../core/config.js'
import { tuneFor } from '../core/difficulty.js'
import { THEME, zonesOf } from '../core/theme.js'
import { obstacleEdge } from './numbers'
import { CORRIDOR_H_M, CROUCH_PITCH_GAIN, DRAW_FAR_M } from './types'
import type { Decor, FrameScene, Obstacle, Placement, RunState, Star } from './types'

/**
 * Полуширина коридора. Выводится из `VIEW.corridorWidth`, а не записана
 * числом: ширина коридора — чужая собственность, и её правка обязана
 * доехать сюда сама.
 */
const HALF_M = VIEW.corridorWidth / 2

/**
 * Щель под верхним препятствием. Берётся у `OBSTACLES`, а не записывается
 * здесь: ниже этой высоты присед считается засчитанным, и разъехаться с
 * приговором картинке нельзя — ребёнок присел бы под полотном, которое
 * нарисовано ниже, чем судят.
 */
const DUCK_H_M = OBSTACLES.duckHeight

/**
 * Насколько далеко от горизонта размещение начинает растворяться. Дымка —
 * решение нового вывода, но её начало привязано к `DRAW_FAR_M`: второго
 * числа про дальность в проекте быть не должно.
 */
const FADE_BAND_M = DRAW_FAR_M * 0.25

/**
 * Обочина отсекается БЛИЖЕ остального, доля от общей дальности.
 *
 * Не вкус и не экономия на глаз: старый вывод рисовал её до `far * 0.75`,
 * то есть до 22 метров (`view.js:866`), и именно на этой дальности считаны
 * обещания про границу зон. Полная дальность дала бы на треть больше
 * обочины в кадре — а это прямо в потолок «вызовов < 150», и обнаружил бы
 * его бюджет, а не этот файл. Доля от `DRAW_FAR_M`, а не второе число:
 * владелец дальности один.
 *
 * Чего здесь НЕТ: потолка в 18 элементов (`DECOR_MAX`, `view.js:854`). Это
 * потолок Canvas2D-отрисовки, и нужен ли он новому выводу — спрашивал этот
 * комментарий у Task 5.
 *
 * ОТВЕТ ПОЛУЧЕН, и он «не нужен»: `npm run budget` перебрал 96 000 кадров
 * (четыре мира, четыре посева, пять ступеней, весь забег шагом 0.25 с), и
 * МАКСИМУМ обочины в кадре — 11 элементов при том потолке 18. Порог не
 * достигается никогда, то есть переносить его значило бы завести ветку,
 * которая не исполняется. Причина, по которой 11, а не 18: шаг обочины
 * `DECOR.gapS` = 1.22 с при ходе коридора 2–2.6 м/с даёт около 2.5–3.2 м
 * между элементами, а `DECOR_FAR_M` = 22.5 м — значит в кадр их физически
 * входит около девяти, и 11 — редкий край. Весь худший кадр при этом — 21
 * размещение и 15 вызовов при потолке 150 (`docs/art-placeholders.md`).
 *
 * Что это НЕ значит: что потолок не понадобится никогда. Он вернётся в тот
 * день, когда обочину сделают плотнее или дальность поднимут, — и тогда он
 * приедет С ЗАМЕРОМ, как приехал этот ответ, а не по памяти о Canvas2D.
 */
const DECOR_FAR_M = DRAW_FAR_M * 0.75

/** 1 у ног, 0 на горизонте. Обоим способам вывода подходит одинаково. */
function fadeAt(z: number): number {
  if (z <= DRAW_FAR_M - FADE_BAND_M) return 1
  return Math.max(0, (DRAW_FAR_M - z) / FADE_BAND_M)
}

/**
 * Где элемент расписания находится СЕЙЧАС, метры вперёд.
 *
 * Расписание задано в СЕКУНДАХ (`level.js:169`, `view.js:2973`), и в метры
 * оно переводится только здесь и только скоростью уровня — правило
 * `run-game`: у каждого уровня своя скорость, и расписание в секундах её
 * правку переживает. Формула дословно та же, что у старого вывода
 * (`view.js:2539`, `zRaw = (ob.at - elapsed) * speed`): две копии разошлись
 * бы, и ребёнок бился бы о то, чего не видит.
 */
function depthOf(at: number, elapsed: number, speed: number): number {
  return (at - elapsed) * speed
}

/**
 * Попадает ли глубина в кадр.
 *
 * Дальняя граница — `DRAW_FAR_M`, ближняя — ноль: уехавшее за спину
 * проецируется с отрицательной глубиной и растягивается на весь экран
 * (разбор — у `obstacleDepth`, `view.js:2526`).
 *
 * Старый вывод резал ближе — с `NEAR = 0.7` для обочины (`view.js:866`) и с
 * `drawNear()` для препятствий. Здесь этого НЕТ намеренно: ближний порог
 * Canvas2D лечил вырожденную проекцию его собственной камеры, а у нового
 * вывода камера своя и ещё не выбрана. Понадобится — приедет с замером, а
 * не по привычке.
 */
function visible(z: number): boolean {
  return z >= 0 && z <= DRAW_FAR_M
}

function placeObstacle(ob: Obstacle, elapsed: number, speed: number): Placement | null {
  const z = depthOf(ob.at, elapsed, speed)
  if (!visible(z) || ob.passed) return null

  /* Край едет С препятствием; запасной путь — для препятствий, собранных
     руками в тестах и инструментах, как и в `view.js:1201`. */
  const edge = ob.edge ?? obstacleEdge()

  if (ob.kind === 'duck') {
    /* Верхнее препятствие висит поперёк всего коридора: уклоняться некуда,
       проводит под ним присед. Полотно идёт от щели (`duckHeight`) до верха
       стены, его высота — ровно `CORRIDOR_H_M − duckHeight` (так и в
       `view.js:1428`), а `y` — середина полотна, потому что оно висит, а не
       стоит на полу. */
    return {
      asset: `obstacle/${ob.look}`,
      x: 0,
      y: DUCK_H_M + (CORRIDOR_H_M - DUCK_H_M) / 2,
      z,
      size: {
        w: VIEW.corridorWidth,
        h: CORRIDOR_H_M - DUCK_H_M,
        d: OBSTACLES.thickness,
      },
      fade: fadeAt(z),
    }
  }

  /* Боковая плита стоит от стены до кромки проёма, значит её середина —
     ровно посередине между ними, а знак берётся у стороны. Ширина — остаток
     полукоридора, и она МЕНЯЕТСЯ СО СЛОЖНОСТЬЮ вместе с `edge`: по этой же
     кромке судит `isSafe`, так что нарисованное и засчитанное обязаны быть
     одним числом. */
  return {
    asset: `obstacle/${ob.look}`,
    x: ob.side * ((HALF_M + edge) / 2),
    y: 0,
    z,
    size: { w: HALF_M - edge, h: CORRIDOR_H_M, d: OBSTACLES.thickness },
    fade: fadeAt(z),
  }
}

function placeStar(s: Star, elapsed: number, speed: number): Placement | null {
  const z = depthOf(s.at, elapsed, speed)
  if (!visible(z) || s.taken) return null
  return {
    /* Большое кольцо — отдельный ассет, а не то же самое покрупнее: по
       `worth` оно и считается, и Miracast различает формы, а не размеры. */
    asset: s.worth > 1 ? 'star/big' : 'star/ring',
    x: s.x,
    y: VIEW.starY,
    z,
    fade: fadeAt(z),
  }
}

/**
 * Ключи палитры, которые читает описание сцены. Перечислены ОДНИМ списком:
 * `theme.js` — копия логики без типов, и без этого перечня опечатка в ключе
 * прошла бы проверку типов молча и всплыла бы цветом «никакой» на телевизоре.
 */
type DecorTintKey =
  | 'palmLeaf'
  | 'flower'
  | 'cactus'
  | 'rock'
  | 'firefly'
  | 'spruce'
  | 'post'
  | 'totem'
  | 'kelp'
  | 'coral'
  | 'anemone'
  | 'spire'
  | 'drift'
  | 'crystal'
  | 'shard'
  | 'grassDark'

/**
 * Каким ключом палитры красится вид обочины.
 *
 * Таблица живёт ЗДЕСЬ, в единственном экземпляре, и это прямое следствие
 * того, что `tint` несёт готовый цвет: иначе разбирать `THEME[zone]` пришлось
 * бы каждому способу вывода отдельно, а две копии одной таблицы — ровно та
 * протечка, от которой заведено «одно описание, два вывода».
 *
 * Перечислены ВСЕ шестнадцать видов, а не только те, у кого ключ не совпал с
 * именем: список вида и список ключа тогда видно рядом. Полноту сторожит
 * тест — он берёт виды ИЗ `theme.js` и падает, называя тот, что приехал
 * синхронизацией и остался без своего цвета. Отсюда и `export`: другой
 * надобности в нём нет.
 *
 * ЦЕНА, и она принимается осознанно: старый Canvas2D-вывод красил вид
 * НЕСКОЛЬКИМИ цветами — у пальмы ствол `palmTrunk` и крона `palmLeaf`, у
 * столба тело `post` и метка `postMark`, у цветка стебель `grassDark` и
 * венчик `flower`. Здесь берётся ОДИН, главный, и второстепенный цвет
 * теряется. Это не недосмотр: Miracast режет цветность сильнее светлоты, и
 * тонкая двухцветная деталь на 55 дюймах через сжатие всё равно не доживает
 * (CLAUDE.md, «Miracast сжимает картинку»). Понадобится второй цвет — он
 * приедет вторым полем размещения, а не разбором палитры в каждом выводе.
 */
export const DECOR_TINT_KEY: Record<string, DecorTintKey> = {
  // Крона больше ствола и первой говорит «пальма»; у куста своего ключа в
  // палитре нет вовсе — он тоже красится листвой.
  palm: 'palmLeaf',
  bush: 'palmLeaf',
  flower: 'flower',
  cactus: 'cactus',
  rock: 'rock',
  firefly: 'firefly',
  spruce: 'spruce',
  post: 'post',
  totem: 'totem',
  kelp: 'kelp',
  coral: 'coral',
  anemone: 'anemone',
  spire: 'spire',
  drift: 'drift',
  crystal: 'crystal',
  shard: 'shard',
}

/**
 * Запасной цвет — тот же, которым старый вывод красит основания и стебли.
 * Он есть во всех двенадцати палитрах, то есть запасной путь не может
 * упереться в ещё одну дыру.
 */
const DECOR_TINT_FALLBACK: DecorTintKey = 'grassDark'

/* Приведение, а не типизация `theme.js`: копии логики живут под `allowJs` и
   типов не несут, а править их здесь запрещено. Сужено до того, что отсюда
   читается, — только ключи обочины, и каждый назван в `DecorTintKey`. */
const PALETTES = THEME as unknown as Record<
  string,
  Partial<Record<DecorTintKey, string>> | undefined
>

/** Палитра по умолчанию: первая зона мира по умолчанию, как в `zoneAt`. */
const DEFAULT_ZONE: string = zonesOf()[0]

/**
 * Цвет элемента обочины: палитра ЕГО зоны, ключ — по его виду.
 *
 * Ни одна из двух неизвестностей не отдаёт «ничего». Так же поступает старый
 * вывод (`const C = THEME[d.zone] || COLORS`, `view.js:891`), и по той же
 * причине, что записана у `zoneAt` (`theme.js:900`): функция, решающая цвет
 * КАЖДОГО кадра, не вправе отвечать «никакой» — Canvas на `undefined` молча
 * оставляет прежний цвет, а новый вывод оставит дыру. И не бросок:
 * `composeScene` зовётся каждый кадр, исключение здесь — чёрный экран
 * посреди забега у семилетнего, а это хуже правдоподобно неверного цвета.
 */
function decorTint(d: Decor): string {
  const palette = PALETTES[d.zone] ?? PALETTES[DEFAULT_ZONE] ?? {}
  const key = DECOR_TINT_KEY[d.kind] ?? DECOR_TINT_FALLBACK
  return palette[key] ?? palette[DECOR_TINT_FALLBACK] ?? ''
}

function placeDecor(d: Decor, elapsed: number, speed: number): Placement | null {
  const z = depthOf(d.at, elapsed, speed)
  if (z < 0 || z > DECOR_FAR_M) return null
  return {
    /* Имя — только вид, без зоны: один и тот же `kind` живёт в нескольких
       зонах с той же геометрией, а различается палитрой (разбор — в договоре
       об именах у `AssetId`). */
    asset: `decor/${d.kind}`,
    x: d.x,
    y: d.y,
    z,
    size: { h: d.h },
    /* Зона берётся у САМОГО элемента, а не у кадра: иначе на границе зон
       обочина следующей зоны видна в цветах предыдущей (разбор — у
       `makeDecor`, `view.js:2480`). */
    tint: decorTint(d),
    fade: fadeAt(z),
  }
}

/**
 * Кадр из состояния забега. Чистая функция: тот же `state` — тот же
 * `FrameScene`, и ни один из двух способов вывода не узнает о другом.
 */
export function composeScene(state: RunState): FrameScene {
  /* Скорость КОРИДОРА — у уровня. `state.speed` — боковая скорость тела
     (`train.js:710`), по ней заикаются бадники; составить из неё глубину
     значило бы гнать коридор не с той скоростью. */
  const speed = tuneFor(state.step).speed
  const elapsed = state.elapsed

  const placements: Placement[] = []
  for (const ob of state.obstacles) {
    const p = placeObstacle(ob, elapsed, speed)
    if (p) placements.push(p)
  }
  for (const s of state.stars) {
    const p = placeStar(s, elapsed, speed)
    if (p) placements.push(p)
  }
  for (const d of state.decor) {
    const p = placeDecor(d, elapsed, speed)
    if (p) placements.push(p)
  }

  return {
    zone: state.zone,
    world: state.world,
    /* Доля, а не градусы: чем именно ответит камера — опусканием глаз или
       наклоном, — решает способ вывода. Множитель СВОЙ (`CROUCH_PITCH_GAIN`),
       а не `VIEW.pitchGain`: у того чужой смысл — он масштабирует высоту
       глаз (`view.js:125`). */
    camera: { u: state.u, pitch: state.v * CROUCH_PITCH_GAIN },
    placements,
  }
}
