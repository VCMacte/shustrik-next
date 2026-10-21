/**
 * Описание кадра — общий язык обоих способов вывода.
 *
 * Развилка «полное 3D или 2.5D» решается замером на телефоне и до него
 * открыта (docs/superpowers/specs/2026-10-21-architecture.md, «Чем развилка
 * удерживается поздней»). Открытой её держит ровно то, что здесь нет ни
 * одного слова про отрисовку: `FrameScene` — список РАЗМЕЩЕНИЙ в метрах.
 * Трёхмерный вывод развернёт их в `InstancedMesh` и узлы glTF, спрайтовый —
 * в текстурированные плоскости, и ни один из двух не станет приватной
 * правдой другого.
 */

/** Имя ассета вида `obstacle/plate`. Чем он окажется на устройстве — не наше дело. */
export type AssetId = string

/**
 * Одно размещение. Оси: `z` — метры вперёд по коридору, `x` — метры поперёк
 * (вправо положительно), `y` — метры вверх от пола. `fade` 0..1: 1 — видно
 * целиком, 0 — растворилось в дымке.
 */
export type Placement = {
  asset: AssetId
  x: number
  y: number
  z: number
  yaw?: number
  scale?: number
  tint?: string
  fade?: number
}

/** Кадр целиком. Четыре поля, и ни одного про способ вывода. */
export type FrameScene = {
  zone: string
  world: string
  camera: { u: number; pitch: number }
  placements: Placement[]
}

/**
 * Дальность отсечения, метры. ЕДИНСТВЕННЫЙ владелец этого числа: по нему
 * `composeScene` выбрасывает дальнее, и его же читает бюджет кадра
 * (`estimate`). Вторая копия означала бы, что судят по одному горизонту, а
 * рисуют по другому, — тот же класс расхождения, от которого в `run-game`
 * заведены `obstacleEdge` и `obstacleDepth`.
 *
 * Совпадение с `VIEW.fogDistance` старого Canvas2D-рендерера не случайно, но
 * и не связь: там это параметр дымки в файле, который здесь переписывается,
 * а здесь — решение нового вывода, и менять его придётся по его собственным
 * причинам.
 */
export const DRAW_FAR_M = 30

/** Сторона коридора: −1 левая, 0 середина, 1 правая. */
export type Side = -1 | 0 | 1

/**
 * Препятствие в расписании забега (`src/core/level.js:169`). `at` — СЕКУНДА
 * забега, когда оно дойдёт до игрока, не метры: у каждого уровня своя
 * скорость, и расписание в секундах переживает её правку.
 */
export type Obstacle = {
  at: number
  kind: 'side' | 'duck'
  look: string
  side: Side
  /** Где кончается плита и начинается проём. Едет С препятствием: по нему судит `isSafe`. */
  edge: number
  passed: boolean
  hit: boolean
  verdictAt: number | null
}

/** Кольцо (`src/core/view.js:2973`). */
export type Star = {
  x: number
  z: number
  side: Side
  at: number
  taken: boolean
  worth: number
}

/** Элемент обочины (`src/core/view.js:2478`). */
export type Decor = {
  kind: string
  zone: string
  side: Side
  x: number
  y: number
  h: number
  z: number
  at: number
  phase: number
}

/**
 * Что дирижёр отдаёт на отрисовку.
 *
 * Основа — полезная нагрузка `view.render({...})` из `src/core/train.js:710`,
 * поле в поле. Сверх неё три поля, без которых `composeScene` работать не
 * может и которых в той нагрузке нет, потому что старый вид получал их при
 * создании: `world` и `step` (`train.js:104`) и `durationS` (`train.js:321`).
 *
 * Типа с таким именем в `run-game` нет — он объявлен здесь, и это НОВЫЙ код,
 * а не перевод логики на TypeScript.
 */
export type RunState = {
  decor: Decor[]
  /**
   * БОКОВАЯ скорость тела ребёнка (`train.js:710` отдаёт сюда `lastSpeed`):
   * по ней заикаются бадники. Ходом коридора она НЕ является — его задаёт
   * `tuneFor(step).speed`.
   */
  speed: number
  /** Смещение тела поперёк, −1..1. */
  u: number
  /** Присед, 0..1. */
  v: number
  /** Пройдено метров с начала забега. */
  travel: number
  stars: Star[]
  obstacles: Obstacle[]
  /** Секунд с начала забега. */
  elapsed: number
  zone: string
  prizes: Record<string, boolean>
  finishIn: number | null
  safe: boolean
  pulse: 0 | 1
  dim: number
  world: string
  /** Длина забега, секунды. */
  durationS: number
  /** Ступень сложности: по ней берётся скорость коридора. */
  step: number
}
