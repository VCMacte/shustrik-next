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
import { obstacleEdge } from './numbers'
import { DRAW_FAR_M } from './types'
import type { Decor, FrameScene, Obstacle, Placement, RunState, Star } from './types'

/**
 * Полуширина коридора. Выводится из `VIEW.corridorWidth`, а не записана
 * числом: ширина коридора — чужая собственность, и её правка обязана
 * доехать сюда сама.
 */
const HALF_M = VIEW.corridorWidth / 2

/** Высота щели под верхним препятствием (`OBSTACLES.duckHeight`). */
const DUCK_H_M = OBSTACLES.duckHeight

/**
 * Насколько далеко от горизонта размещение начинает растворяться. Дымка —
 * решение нового вывода, но её начало привязано к `DRAW_FAR_M`: второго
 * числа про дальность в проекте быть не должно.
 */
const FADE_BAND_M = DRAW_FAR_M * 0.25

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

/** Попадает ли глубина в кадр: за спиной не рисуем, за горизонтом тоже. */
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
       проводит под ним присед. Середина полотна — между щелью и потолком. */
    return {
      asset: `obstacle/${ob.look}`,
      x: 0,
      y: DUCK_H_M + (VIEW.corridorWidth - DUCK_H_M) / 2,
      z,
      fade: fadeAt(z),
    }
  }

  /* Боковая плита стоит от стены до кромки проёма, значит её середина —
     ровно посередине между ними, а знак берётся у стороны. */
  return {
    asset: `obstacle/${ob.look}`,
    x: ob.side * ((HALF_M + edge) / 2),
    y: 0,
    z,
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

function placeDecor(d: Decor, elapsed: number, speed: number): Placement | null {
  const z = depthOf(d.at, elapsed, speed)
  if (!visible(z)) return null
  return {
    /* Зона хранится у САМОГО элемента, а не берётся у кадра: иначе на
       границе зон обочина следующей зоны пять секунд видна в цветах
       предыдущей (разбор — у `makeDecor`, `view.js:2478`). */
    asset: `decor/${d.zone}/${d.kind}`,
    x: d.x,
    y: d.y,
    z,
    scale: d.h,
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
    /* Наклон взгляда — доля приседа, а не градусы: чем именно повернётся
       камера, решает способ вывода, а описание говорит только «насколько». */
    camera: { u: state.u, pitch: state.v * VIEW.pitchGain },
    placements,
  }
}
