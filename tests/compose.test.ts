/**
 * Сцена — ОПИСАНИЕ, а не отрисовка (docs/superpowers/specs/2026-10-21-architecture.md,
 * раздел «Чем развилка удерживается поздней»).
 *
 * Здесь проверяется ровно то, ради чего развилка «3D или 2.5D» держится
 * открытой: `composeScene` отдаёт список размещений в метрах, и ни одно из
 * трёх чисел ниже не зависит от того, чем кадр будет нарисован.
 */
import { expect, test } from 'vitest'
import { composeScene } from '../src/render/compose'
import { DRAW_FAR_M } from '../src/render/types'
import type { Decor, Obstacle, RunState, Star } from '../src/render/types'
import { tuneFor } from '../src/core/difficulty.js'
import { OBSTACLES, VIEW } from '../src/core/config.js'
import { THEME } from '../src/core/theme.js'
import { obstacleEdge } from '../src/render/numbers'

/** Ступень сложности образца. Скорость коридора берётся по ней, и только по ней. */
const STEP = 1

/**
 * Скорость КОРИДОРА, а не тела. `state.speed` в полезной нагрузке
 * (`src/core/train.js:710`) — боковая скорость ребёнка, по ней заикаются
 * бадники; ход коридора задаёт уровень.
 */
const speedOf = (step: number): number => tuneFor(step).speed

/**
 * Препятствие с реальными умолчаниями `makeLevel` (`src/core/level.js:169`).
 * Поля `edge`, `passed`, `hit`, `verdictAt` дозаполняются здесь, а не
 * вычёркиваются из типа: тип обязан описывать настоящее препятствие, иначе
 * тест разойдётся с игрой и этого никто не заметит.
 */
function obstacle(
  o: Pick<Obstacle, 'at' | 'kind' | 'side' | 'look'> & Partial<Obstacle>,
): Obstacle {
  return { edge: 0.16296, passed: false, hit: false, verdictAt: null, ...o }
}

/** Элемент обочины с умолчаниями `makeDecor` (`src/core/view.js:2478`). */
function decor(d: Pick<Decor, 'kind' | 'zone' | 'at'> & Partial<Decor>): Decor {
  return { side: 1, x: 1.55, y: 2.6, h: 1.1, z: 0, phase: 0, ...d }
}

/** Кольцо с умолчаниями `makeStars` (`src/core/view.js:2973`). */
function star(s: Pick<Star, 'at'> & Partial<Star>): Star {
  return { x: 0, z: 0, side: 0, taken: false, worth: 1, ...s }
}

/** Состояние забега образца: пусто всё, кроме того, что просит сам тест. */
function stateWith(patch: Partial<RunState>): RunState {
  return {
    decor: [] as Decor[],
    speed: 0,
    u: 0,
    v: 0,
    travel: 0,
    stars: [],
    obstacles: [],
    elapsed: 0,
    zone: 'greenHill',
    prizes: {},
    finishIn: null,
    safe: true,
    pulse: 0,
    dim: 0,
    world: 'hills',
    durationS: 60,
    step: STEP,
    ...patch,
  }
}

test('препятствие стоит на своей стороне и на своём расстоянии', () => {
  const s = composeScene(
    stateWith({
      obstacles: [obstacle({ at: 12, kind: 'side', side: -1, look: 'plate' })],
      elapsed: 2,
    }),
  )
  const p = s.placements.find((p) => p.asset === 'obstacle/plate')
  expect(p).toBeDefined()
  /* Расстояние = оставшееся ВРЕМЯ × скорость уровня, ровно как в
     `obstacleDepth` (`src/core/view.js:2539`: `zRaw = (ob.at - elapsed) * speed`).
     Бриф писал здесь `12 - 2 * speedOf(1)`, то есть вычитал метры из секунд;
     ход коридора у обеих формул одинаковый, а вот место препятствия — нет. */
  expect(p!.z).toBeCloseTo((12 - 2) * speedOf(STEP), 2)
  expect(Math.sign(p!.x)).toBe(-1)
})

test('верхнее препятствие висит от щели до верха стены', () => {
  const s = composeScene(
    stateWith({
      obstacles: [obstacle({ at: 4, kind: 'duck', side: 0, look: 'beam' })],
      elapsed: 0,
    }),
  )
  const p = s.placements.find((p) => p.asset === 'obstacle/beam')
  expect(p).toBeDefined()
  // Уклоняться некуда: полотно идёт поперёк всего коридора.
  expect(p!.x).toBe(0)
  /* Проверяются КРАЯ полотна, а не его середина: середину легко повторить
     той же формулой, что в коде, и тогда проверка перестанет что-либо знать.
     Низ обязан совпасть со щелью, под которой проходит присед
     (`OBSTACLES.duckHeight`), верх — с верхом стены (`view.js:29`, WALL = 2.6).
     Прежняя редакция брала за потолок ШИРИНУ коридора (2.4) и давала верх
     1.725 + 0.675 = 2.4 — вот ровно это здесь и ловится. */
  const half = (p!.size?.h ?? 1) / 2
  expect(p!.y - half).toBeCloseTo(OBSTACLES.duckHeight, 3)
  expect(p!.y + half).toBeCloseTo(2.6, 3)
})

test('кольцо дальше горизонта не размещается вовсе', () => {
  expect(
    composeScene(stateWith({ stars: [star({ at: 400 })], elapsed: 0 })).placements,
  ).toHaveLength(0)
  /* Опора, без которой проверка выше вечнозелёная: то же кольцо, но в
     пределах горизонта, размещается. Пустой список — это отсечение, а не
     «composeScene не умеет колец». */
  const близко = composeScene(stateWith({ stars: [star({ at: 1 })], elapsed: 0 }))
  expect(близко.placements).toHaveLength(1)
  expect(близко.placements[0].z).toBeLessThan(DRAW_FAR_M)
})

test('ширина боковой плиты идёт за ступенью сложности, а высота — нет', () => {
  const HALF = VIEW.corridorWidth / 2
  const ширина = (step: number): number => {
    /* Край едет С препятствием, как его и кладёт `makeLevel`: ступень
       задаёт `blockFrac`, а тот — кромку проёма (`view.js:2510`). */
    const edge = obstacleEdge(tuneFor(step).blockFrac)
    const s = composeScene(
      stateWith({
        step,
        obstacles: [obstacle({ at: 3, kind: 'side', side: 1, look: 'plate', edge })],
        elapsed: 0,
      }),
    )
    const p = s.placements.find((p) => p.asset === 'obstacle/plate')
    expect(p).toBeDefined()
    expect(p!.size?.w).toBeCloseTo(HALF - edge, 4)
    /* Высота от ступени НЕ зависит: равномерный множитель вместо габарита
       сжимал бы плиту по высоте вместе с шириной, то есть лёгкий уровень
       показывал бы препятствие ниже стены. */
    expect(p!.size?.h).toBeCloseTo(2.6, 4)
    return p!.size!.w!
  }
  // Лестница сложности обязана эту ширину двигать, иначе проверка выше
  // сторожила бы одно и то же число дважды.
  expect(ширина(0)).toBeGreaterThan(ширина(4))
})

test('обочина красится палитрой СВОЕЙ зоны, а не именем зоны', () => {
  const s = composeScene(
    stateWith({
      zone: 'greenHill',
      decor: [
        decor({ kind: 'palm', zone: 'greenHill', at: 2 }),
        decor({ kind: 'palm', zone: 'nightHills', at: 3 }),
      ],
      elapsed: 0,
    }),
  )
  expect(s.placements.map((p) => p.asset)).toEqual(['decor/palm', 'decor/palm'])
  // Цвет готовый, а не имя палитры: разбирать THEME каждому выводу запрещено.
  expect(s.placements[0].tint).toBe(THEME.greenHill.palmLeaf)
  expect(s.placements[0].tint).toMatch(/^#|^rgb/)
  /* Зона у ЭЛЕМЕНТА, а не у кадра: оба размещения в кадре зоны greenHill, но
     второе принадлежит ночной зоне и обязано быть в её цвете. */
  expect(s.placements[1].tint).toBe(THEME.nightHills.palmLeaf)
  expect(s.placements[1].tint).not.toBe(s.placements[0].tint)
})

test('обочина отсекается ближе общего горизонта', () => {
  /* Глубина между порогом обочины и общим горизонтом: препятствие там ещё
     рисуется, обочина уже нет. Одна сцена на оба — иначе проверка прошла бы
     и над `composeScene`, не умеющим обочины вовсе. */
  const далеко = (DRAW_FAR_M * 0.75 + DRAW_FAR_M) / 2
  const at = далеко / speedOf(STEP)
  const s = composeScene(
    stateWith({
      decor: [decor({ kind: 'palm', zone: 'greenHill', at })],
      obstacles: [obstacle({ at, kind: 'side', side: 1, look: 'plate' })],
      elapsed: 0,
    }),
  )
  expect(s.placements.map((p) => p.asset)).toEqual(['obstacle/plate'])
  // Ближе порога та же обочина размещается — значит отсечение, а не немота.
  const близко = composeScene(
    stateWith({ decor: [decor({ kind: 'palm', zone: 'greenHill', at: 1 })] }),
  )
  expect(близко.placements).toHaveLength(1)
  expect(близко.placements[0].size?.h).toBeCloseTo(1.1, 4)
})

test('описание не знает про three', () => {
  const s = composeScene(stateWith({}))
  expect(Object.keys(s).sort()).toEqual(['camera', 'placements', 'world', 'zone'])
  /* Поля не придуманы на месте, а взяты из состояния: иначе проверка ключей
     прошла бы и над жёстко зашитой заглушкой. */
  expect(s.zone).toBe('greenHill')
  expect(s.world).toBe('hills')
  expect(s.camera.u).toBe(0)
})
