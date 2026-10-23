/**
 * Спайк: страница, на которой снимается ЕДИНСТВЕННОЕ число проекта.
 *
 * Развилка «полное 3D или 2.5D» не решена, и решает её замер на телефоне:
 * `gap95` ≤ 40 мс И частота поз ≥ 10 Гц И доля пауз ноль
 * (`docs/superpowers/specs/2026-10-21-architecture.md`). Порог записан
 * заранее и под полученное число не меняется.
 *
 * Отсюда устройство страницы — семь прогонов в ОДНОЙ сессии:
 *
 *   scene/-     картинка без позы      — сколько стоит трёхмерный вывод сам
 *   pose/gpu    поза без картинки      — сколько стоит инференс сам
 *   both/gpu    и то и другое на GPU   — там инференс отнимает кадры
 *   both/cpu    и то и другое на CPU   — там картинка отнимает герцы
 *
 * и те же три картинки ещё раз, в МАЛОМ БУФЕРЕ (`src/render/buffer.ts`):
 *
 *   scene/-/small    — подействовала ли ручка вообще
 *   both/gpu/small   — берёт ли порог полное 3D, если картинка дешевле
 *   both/cpu/small   — и ГЛАВНОЕ: чем картинка облагает процессорный инференс
 *
 * Последняя тройка — не «ещё немного чисел», а единственная оставшаяся
 * неизвестность спайка, и она решает формат проекта (спека, «Неизвестность,
 * которая решает формат»). Малый буфер режет площадь прохода отрисовки в
 * 6.5 раза на этом телефоне (арифметика — в `src/render/buffer.ts`), не
 * меняя ни вызовов, ни вершин, ни одного ассета: он двигает ПОЛОСУ ПАМЯТИ и
 * ничего больше. Значит ответ читается прямо —
 * инференс на процессоре упал к 87 мс, значит облагала полоса, и 2.5D
 * становится основным путём; остался на 109, значит облагала работа CPU, и
 * полное 3D проходит. `?buffer=small` без позы стоит первым в тройке затем,
 * чтобы «ничего не изменилось» нельзя было спутать с «ручка не подействовала».
 *
 * В одной сессии, а не семью перезагрузками: разброс устройства ±8 fps
 * живёт МЕЖДУ сессиями и съел бы весь эффект (та же причина записана в
 * `run-game`, `train.js:restartPose`). Адрес задаёт только НАЧАЛЬНЫЙ прогон,
 * дальше переключают кнопки.
 *
 * Имена полей журнала и способ счёта взяты у `run-game` (`train.js`,
 * `flushHealth`) дословно: журнал обязан читаться `tools/log-report.mjs`
 * оттуда без единой правки разборщика, иначе числа спайка не сопоставятся с
 * базовой линией 21 октября.
 */
import { makeLevel } from '../core/level.js'
import { tuneFor } from '../core/difficulty.js'
import { unlockedAt } from '../core/awards.js'
import { zoneAt, WORLDS, worldReady } from '../core/theme.js'
import { POSE } from '../core/config.js'
import { quantile, round } from '../core/util.js'
import { openCamera } from '../core/camera.js'
import * as log from '../core/log.js'

import { makeDecor, makeStars } from '../render/numbers'
import { composeScene } from '../render/compose'
import type { Decor, Obstacle, RunState } from '../render/types'
import type { BufferPolicy } from '../render/buffer'
import { makeThreeRenderer } from '../render/three/renderer'
import type { Renderer } from '../render/three/renderer'
import { posePaths } from '../adapters/pose-paths'

/*
 * `MediaStreamTrackProcessor` в типах DOM ещё нет: он есть в Chrome для
 * Android (и это ОСНОВНОЙ путь кадров — ни копий, ни работы на главном
 * потоке), но стандартом не стал. Объявление минимальное: ровно то, чем
 * пользуется страница.
 */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream
}

// ────────────────────────────── прогоны ──────────────────────────────

export type What = 'scene' | 'pose' | 'both'
export type Delegate = 'gpu' | 'cpu'

export type Run = {
  what: What
  /** `null` у прогона без позы: делегата там нет, и врать о нём нельзя. */
  delegate: Delegate | null
  /**
   * Внутреннее разрешение. Третья ось прогона, и ровно поэтому она здесь, а
   * не переключателем на странице: буфер обязан попасть в журнал рядом с
   * `what` и `delegate`, иначе два забега с разной картинкой окажутся в
   * разборе одной строкой.
   */
  buffer: BufferPolicy
}

const WHATS: What[] = ['scene', 'pose', 'both']
const DELEGATES: Delegate[] = ['gpu', 'cpu']
const BUFFERS: BufferPolicy[] = ['full', 'small']

/**
 * Разбор адреса. Бросает на незнакомом значении, а не подставляет своё.
 *
 * Молчаливая подстановка здесь стоила бы всего замера: человек открыл бы
 * `?delegate=npu`, получил прогон на видеоядре, записал его как
 * процессорный — и две строки таблицы сравнивали бы одно и то же.
 */
export function runFromQuery(search: string): Run {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)

  const whatRaw = q.get('what') ?? 'both'
  if (!WHATS.includes(whatRaw as What)) {
    throw new Error(`?what=${whatRaw}: бывает только ${WHATS.join(', ')}`)
  }
  const what = whatRaw as What

  const delegateRaw = q.get('delegate')
  if (delegateRaw !== null && !DELEGATES.includes(delegateRaw as Delegate)) {
    throw new Error(`?delegate=${delegateRaw}: бывает только ${DELEGATES.join(', ')}`)
  }
  /* У прогона без позы делегата нет вовсе, что бы ни стояло в адресе:
     нечему исполняться ни на видеоядре, ни на процессоре. */
  const delegate = what === 'scene' ? null : ((delegateRaw ?? 'gpu') as Delegate)

  const bufferRaw = q.get('buffer') ?? 'full'
  if (!BUFFERS.includes(bufferRaw as BufferPolicy)) {
    throw new Error(`?buffer=${bufferRaw}: бывает только ${BUFFERS.join(', ')}`)
  }
  /* У прогона без картинки буфер всё равно остаётся в прогоне, а не гасится
     в `full`, как гасится делегат у `scene`. Разница не в придирчивости:
     делегата без позы НЕ СУЩЕСТВУЕТ, а буфер без картинки существует и
     равен нулю пикселей — и `?what=pose&buffer=small` поэтому не ошибка
     человека, а бессмысленный, но честный прогон, который журнал назовёт
     своим именем. Молча переписать его в `full` значило бы положить в
     таблицу забег под чужой строкой. */
  const buffer = bufferRaw as BufferPolicy

  return { what, delegate, buffer }
}

/**
 * Адреса замера — ЕДИНСТВЕННЫЙ их владелец.
 *
 * Адреса, а не разобранные прогоны: человек набирает на телефоне именно их,
 * и кнопки страницы обязаны вести туда же. Прогоняется этот список через
 * `runFromQuery` и в `boot()`, и в проверке — значит «поменяли строку, а
 * кнопка осталась прежней» перестало быть возможным.
 */
export const SPIKE_RUNS = [
  '?what=scene',
  '?what=pose&delegate=gpu',
  '?what=both&delegate=gpu',
  '?what=both&delegate=cpu',
  /* Малый буфер ДОПИСАН в конец, а не вставлен рядом с парным полным
     прогоном. Номер плитки — это номер строки таблицы спайка, и вставка
     посередине сдвинула бы номера 1–4, которыми уже названа базовая линия
     21 октября: человек у штатива искал бы «третий прогон», а разбор печатал
     бы под тройкой другой забег. */
  '?what=scene&buffer=small',
  '?what=both&delegate=gpu&buffer=small',
  '?what=both&delegate=cpu&buffer=small',
] as const

/**
 * Как прогон называется в журнале и на кнопке.
 *
 * `full` в имени НЕ ПОЯВЛЯЕТСЯ, и это не экономия букв. Четыре имени
 * (`scene/-`, `pose/gpu`, `both/gpu`, `both/cpu`) — те самые, которыми
 * названа базовая линия 21 октября и строки таблицы в спеке; припиши к ним
 * `/full`, и сравнивать замер станет не с чем, потому что сопоставляет
 * разбор ПО ИМЕНИ. Суффикс получает только то, чего в той таблице не было.
 */
export function runName(run: Run): string {
  const tail = run.buffer === 'small' ? '/small' : ''
  return `${run.what}/${run.delegate ?? '-'}${tail}`
}

/** Плитка пульта: номер строки таблицы спайка и подпись словами. */
export type RunTile = {
  /** Номер в таблице спайка; 0 — прогон не из таблицы (так бывает из адреса). */
  no: number
  title: string
  sub: string
}

/**
 * Как прогон выглядит на пульте.
 *
 * `both/gpu` на кнопке читается только тем, кто помнит таблицу спайка, — а у
 * штатива стоит человек с телефоном в руках. Поэтому слова; и поэтому НОМЕР
 * строки таблицы, а не просто порядок кнопок: разбор `run-game` печатает
 * забеги в порядке записи, и прогон, снятый не по порядку, пришлось бы
 * искать в выдаче глазами.
 *
 * Номер берётся из `SPIKE_RUNS` — у четвёрки один владелец, и «поменяли
 * список, а номера остались прежними» невозможно.
 */
export function runTile(run: Run): RunTile {
  const name = runName(run)
  const no = SPIKE_RUNS.findIndex((s) => runName(runFromQuery(s)) === name) + 1
  const where = run.delegate === 'cpu' ? 'процессор' : 'видеоядро'
  /* Буфер приписывается к подписи СЛОВАМИ и последним, а не отдельной
     строкой плитки: у штатива человек сверяет подпись с таблицей на бумаге,
     и «малый буфер» в конце читается там же, где в таблице стоит пометка.
     `480×270` на кнопку не идёт — это число телефона, а не человека, и на
     мелком экране потолок до него не доходит (см. `bufferFor`). */
  const buf = run.buffer === 'small' ? ', малый буфер' : ''
  if (run.what === 'scene') return { no, title: 'Картинка', sub: `без позы${buf}` }
  if (run.what === 'pose') return { no, title: 'Поза', sub: `${where}, без картинки${buf}` }
  return { no, title: 'Всё вместе', sub: `${where}${buf}` }
}

/**
 * Отметка начала прогона. ЕДИНСТВЕННОЕ место, где `run.start` попадает в
 * журнал: по этим записям четыре прогона потом и различают.
 */
export function noteRunStart(run: Run, world: string): void {
  /* `world` и `step` рядом не для полноты: разбор `run-game` печатает их у
     каждого забега, и без них четыре строки таблицы не сказали бы, что
     сняты они с одного и того же кадра.

     Мир приходит ПАРАМЕТРОМ, а не берётся из модуля: его крутят на пульте, и
     умолчание внутри сделало бы кнопку украшением — картинка менялась бы, а
     разбор всех четырёх забегов называл бы один и тот же мир. */
  log.event('run.start', {
    what: run.what,
    delegate: run.delegate ?? '-',
    /* Буфер пишется ВСЕГДА, в том числе `full`. Разбор читает поля по
       именам, и отсутствие поля он прочтёт как отсутствие, а не как
       «полный»: четыре забега без пометки и три с пометкой различались бы
       тогда дырой в таблице, а не значением. */
    buffer: run.buffer,
    world,
    step: STEP,
  })
}

// ──────────────────────────── окно здоровья ────────────────────────────

/** Отсчёт позы — то, что отдаёт воркер (`pose.worker.js`). */
export type PoseSample = {
  inferMs?: number
  dropped?: number
  lm?: Float32Array | null
}

export type Health = {
  /** Кадр отрисован. `now` — метка `requestAnimationFrame`. */
  frame(now: number): void
  /** Длительность отрисовки кадра, миллисекунды. */
  drew(ms: number): void
  /** Пришёл отсчёт позы. */
  pose(sample: PoseSample): void
  /** Закрыть окно и записать его в журнал. Возвращает записанное. */
  flush(now: number, stage: string): Record<string, number | string> | null
}

/**
 * Накопители окна здоровья — копия `health` из `run-game` (`train.js:204`) и
 * его же `flushHealth` (`train.js:957`).
 *
 * Копия, а не своя мера, ровно по одной причине: разборщик читает каждое
 * поле ПО ИМЕНИ, а базовая линия 21 октября снята именно этим способом
 * счёта. Своё имя или своя формула — и числа спайка перестанут сравниваться
 * с тем, ради сравнения с чем они снимаются.
 *
 * Чего в `run-game` нет и что прибавлено здесь — `calls`, `verts` и `bufPx`
 * из вывода. Разборщик их просто не заметит: он берёт поля по именам, а не
 * весь объект.
 */
export function makeHealth(
  stats: () => { calls: number; verts: number; bufPx: number },
  startedAt: number,
): Health {
  /* Начало ПЕРВОГО окна приходит снаружи, и умолчания у него нет нарочно.
     `now` на странице — это `performance.now()` от загрузки документа, и
     ноль здесь означал бы, что первое окно каждого прогона длиной во всё
     время жизни страницы: `fps`, `hz` и `ok` занижены в разы, а разборщик
     берёт как раз `min` — то есть «худшее» каждого прогона оказалось бы
     мусором. Порог `hz ≥ 10` решает развилку, и ронять его нечем.
     `run-game` ставит `health.since = performance.now()` при старте забега
     (`train.js:1105`) — здесь ровно то же. */
  let since = startedAt
  let lastFrame = 0
  let frames = 0
  let poses = 0
  let ok = 0
  let dropped = 0
  const infer: number[] = []
  const draw: number[] = []
  const gaps: number[] = []

  return {
    frame(now: number): void {
      /* Промежутки копятся СЫРЫМИ, без зажима сверху. Зажим защищает ход
         забега от прыжка после замершей страницы, но для меры плавности он
         же и слепота: провал на 120 мс — ровно то, что ребёнок чувствует, —
         прочитался бы как 50 (`train.js:622`). */
      if (lastFrame) gaps.push(now - lastFrame)
      lastFrame = now
      frames++
    },

    drew(ms: number): void {
      draw.push(ms)
    },

    pose(sample: PoseSample): void {
      poses++
      dropped += sample.dropped || 0
      if (sample.inferMs) infer.push(sample.inferMs)
      if (sample.lm) ok++
    },

    flush(now: number, stage: string): Record<string, number | string> | null {
      const span = (now - since) / 1000
      since = now
      if (!span || !frames) return null

      const live = stats()
      const health = {
        stage,
        fps: Math.round(frames / span),
        hz: Math.round(poses / span),
        drop: dropped,
        ok: round(poses ? ok / poses : 0),
        p50: infer.length ? Math.round(quantile(infer, 0.5)) : 0,
        p95: infer.length ? Math.round(quantile(infer, 0.95)) : 0,
        draw50: draw.length ? Math.round(quantile(draw, 0.5)) : 0,
        draw95: draw.length ? Math.round(quantile(draw, 0.95)) : 0,
        /* Ровность хода: насколько затянулся худший кадр окна. Медианы
           промежутка рядом НЕТ намеренно — она и есть 1000/fps, то есть
           вторая копия соседнего поля. */
        gap95: gaps.length ? Math.round(quantile(gaps, 0.95)) : 0,
        /* Живой счёт кадра — тот самый, который сверяется с `estimate`.
           Без него «gap95 вырос» нельзя отличить от «в кадре стало вдвое
           больше вызовов». */
        calls: live.calls,
        verts: live.verts,
        /* Пикселей в буфере кадра — ЧЕТВЁРТОЕ число бюджета, и единственное
           из четырёх, которого `estimate` не знает вовсе: он считает вызовы,
           вершины и текстуры, а заливку не считает. Поэтому выигрыш малого
           буфера в оценке не виден, и без этого поля замер «инференс упал на
           20 мс» нечем отличить от «телефон повернули посреди прогона». */
        bufPx: live.bufPx,
      }
      log.event('health', health)

      frames = 0
      poses = 0
      ok = 0
      dropped = 0
      infer.length = 0
      draw.length = 0
      gaps.length = 0
      return health
    },
  }
}

// ───────────────────────────── конвейер позы ─────────────────────────────

/**
 * Сообщение `init` для `src/core/pose.worker.js`.
 *
 * Здесь и происходит ПЕРЕКРЫТИЕ путей: воркер — побайтовая копия и правке не
 * подлежит, но все четыре адреса он получает сообщением, а вписаны они в
 * сообщение только в `pose.camera.js`. Страница спайка собирает сообщение
 * сама и кладёт туда пути сборки вместо `VENDOR` из копии `config.js`.
 *
 * Лестницы отказов здесь НЕТ, и это осознанно. Лестница отдала бы видеоядро
 * вместо не заведшегося процессора — ребёнку это милосердие, а замеру
 * подлог: строка «both/cpu» в таблице оказалась бы вторым «both/gpu». Не
 * завелось — прогон не состоялся, и это видно.
 */
export function poseInit(run: Run, base?: string): Record<string, unknown> {
  const paths = base === undefined ? posePaths() : posePaths(base)
  return {
    type: 'init',
    mode: 'stream',
    delegate: (run.delegate ?? 'gpu').toUpperCase(),
    hz: run.delegate === 'cpu' ? POSE.hzCpu : POSE.hz,
    mainTimeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : 0,
    bundleUrl: paths.bundleClassic,
    packUrl: paths.pack,
    wasmBase: paths.wasm,
    modelUrl: paths.model,
    pose: POSE,
  }
}

// ─────────────────────────────── забег ───────────────────────────────

/**
 * Воркер распознавания. Отдельной функцией, а не строкой внутри прогона, по
 * двум причинам сразу.
 *
 * Первая: воркер обязан быть КЛАССИЧЕСКИМ. MediaPipe выполняет свой
 * wasm-загрузчик через `importScripts`, которого в модульном воркере не
 * существует, и падает там с «ModuleFactory not set». Отсутствие
 * `{ type: 'module' }` — не забывчивость, и место ему рядом с объяснением.
 *
 * Вторая: спецификатор обязан быть ЛИТЕРАЛОМ внутри `new URL(...,
 * import.meta.url)` — только так сборщик видит воркер и собирает его. Тот же
 * адрес, составленный в рантайме, в `dev` отдаётся как обычный модуль и
 * падает с «Cannot use import statement outside a module». Проверено
 * браузером: именно так и вышло при попытке позвать воркер мимо этой
 * функции.
 */
export function makePoseWorker(): Worker {
  return new Worker(new URL('../core/pose.worker.js', import.meta.url))
}

/**
 * Миры, по которым вообще можно мерить. Второй список после `budget.mjs`.
 *
 * Владелец списка объявлен там (`measuredWorlds`), но `budget.mjs` живёт в
 * `node` и тянет `node:fs` — в браузер его не внести. Поэтому здесь вторая
 * запись того же правила, как `makeRun` против `runOf`, и сверяет их тест, а
 * не договорённость: разъедутся — на телефоне будут мерить мир, которого
 * бюджет не считал.
 *
 * Функция, а не константа, по той же причине, что у соседа: состав зависит от
 * `worldReady`, то есть от палитры, и застыть в снимке не вправе.
 */
export function spikeWorlds(): string[] {
  return Object.keys(WORLDS).filter((w) => worldReady(w))
}

/**
 * Мир по умолчанию, посев и ступень замера.
 *
 * Раньше здесь стоял `WORLD = 'city'` — мира с таким именем в `WORLDS` нет
 * вовсе, и `zonesOf` молча откатывался на зоны холмов: рисовались холмы, а в
 * журнал каждого забега шло имя мира, которого не существует. Теперь
 * умолчание берётся из того же списка, что и кнопка пульта.
 */
export const DEFAULT_WORLD = spikeWorlds()[0]
export const SEED = 1
export const STEP = 1
/** Длина забега и банк призов — те же, что у перебора бюджета. */
export const DURATION_S = 300
const FULL_BANK = 1200

/**
 * Расписание забега.
 *
 * Порядок вызовов генераторов повторяет `tools/budget.mjs:runOf` — все трое
 * тянут из одного `rng`, и перестановка дала бы другой забег при том же
 * посеве. Общего владельца для них завести не вышло: `budget.mjs` живёт в
 * `node` и тянет `node:fs`, в браузер его не внести. Поэтому совпадение
 * сторожит тест (`tests/spike.test.ts`), а не договорённость.
 */
export function makeRun(seed: number = SEED, world: string = DEFAULT_WORLD, step: number = STEP) {
  let s = seed
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const tune = tuneFor(step)
  const prizes = unlockedAt(FULL_BANK)
  /* Приведение к `never[]`, а не к `Obstacle[]`: генераторы логики живут в
     `src/core/*.js` под `checkJs: false`, типов у них нет, и у
     необязательного `obstacles` в `makeStars` TypeScript выводит как раз
     `never[]`. Описать их форму здесь значило бы завести вторую,
     НЕПРОВЕРЯЕМУЮ копию — расходиться с оригиналом она начала бы молча.
     Настоящий сторож формы один: `composeScene`, который это и читает. */
  const obstacles = makeLevel({ durationS: DURATION_S, rng, tune, world }) as never[]
  const stars = makeStars({ durationS: DURATION_S, obstacles, rng, tune })
  const decor = makeDecor({ durationS: DURATION_S, rng, world, prizes, speed: tune.speed })
  return { obstacles, stars, decor, tune, prizes }
}

/**
 * Состояние забега на секунде `t`.
 *
 * Боковой ход камеры берётся ОТ ВРЕМЕНИ, а не от тела ребёнка, и это
 * требование сравнимости, а не упрощение. Сравниваются прогоны `scene` и
 * `both`; если бы взгляд вёл ребёнок, в них рисовались бы РАЗНЫЕ кадры, и
 * разница чисел означала бы заодно разницу содержимого кадра. Поза в спайке
 * нагружает конвейер — управление приезжает с настоящими экранами.
 */
export function stateAt(run: ReturnType<typeof makeRun>, t: number, world: string): RunState {
  return {
    /* Приведения, а не разметка: генераторы живут в `src/core/*.js`
       (`checkJs: false`), и типов у них нет ни одного. Описать их здесь
       значило бы завести вторую, НЕПРОВЕРЯЕМУЮ копию их формы — расходиться
       она начала бы молча. Настоящий сторож формы — `composeScene`, который
       это описание и читает. */
    decor: run.decor as Decor[],
    obstacles: run.obstacles as Obstacle[],
    stars: run.stars,
    speed: 0.5,
    u: Math.sin(t * 0.7),
    v: 0,
    travel: t * run.tune.speed,
    elapsed: t,
    zone: zoneAt(t, DURATION_S, world),
    prizes: run.prizes as unknown as Record<string, boolean>,
    finishIn: DURATION_S - t,
    safe: true,
    pulse: 0,
    dim: 0,
    world,
    durationS: DURATION_S,
    step: STEP,
  }
}

// ─────────────────────────────── страница ───────────────────────────────

/** Пустой счёт: у прогона без картинки вызовов и вершин нет, а не «неизвестно». */
const NO_DRAW = { calls: 0, verts: 0, bufPx: 0 }

type Live = {
  /** Экран повернули или шторка уехала: буфер обязан пойти за ним. */
  resize(): void
  stop(): Promise<void>
}

/**
 * Один прогон целиком: картинка, поза или и то и другое.
 *
 * Возвращает способ остановиться — без него переключение прогонов оставляло
 * бы прошлый работать, и «both» мерился бы поверх «scene».
 */
async function runLive(
  run: Run,
  world: string,
  canvas: HTMLCanvasElement,
  say: (s: string) => void,
): Promise<Live> {
  let renderer: Renderer | null = null

  // ── картинка ──
  let raf = 0
  const schedule = run.what !== 'pose'
  /* Растяжение малого буфера делает СТРАНИЦА, а не вывод.
     `image-rendering: pixelated` — это свойство холста на странице, а вывод
     «размер холста НА СТРАНИЦЕ» не трогает принципиально (`resize`,
     `updateStyle = false`). Растянет всё равно композитор браузера, то есть
     даром: отдельного прохода растяжения нет, и замер не заплатит за то,
     чего в игре не будет. Снимается класс ВСЕГДА, в том числе у прогона без
     картинки: прошлый прогон оставил бы его на холсте, и полный буфер
     следующего растягивался бы ближайшим соседом неизвестно зачем. */
  canvas.classList.toggle('pixel', run.buffer === 'small')
  if (schedule) {
    renderer = await makeThreeRenderer(canvas, { buffer: run.buffer })
    renderer.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio)
  }

  // ── поза ──
  let worker: Worker | null = null
  let camStop: (() => void) | null = null
  if (run.what !== 'scene') {
    const cam = await openCamera({ facing: 'user' })
    camStop = () => cam.stream.getTracks().forEach((t: MediaStreamTrack) => t.stop())
    if (typeof MediaStreamTrackProcessor === 'undefined') {
      throw new Error('нет MediaStreamTrackProcessor: замер на этом браузере несравним')
    }
    worker = makePoseWorker()
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m.type === 'pose') health.pose(m)
      else if (m.type === 'ready') log.event('pose.ready', { ...m, cam: cam.settings ?? null })
      else if (m.type === 'fail') {
        log.event('pose.fail', m)
        say(`поза не завелась: ${m.message}`)
      } else if (m.type === 'pose.error') log.event('pose.error', m)
    }
    const processor = new MediaStreamTrackProcessor({ track: cam.track.clone() })
    const init = { ...poseInit(run), stream: processor.readable }
    worker.postMessage(init, [processor.readable])
  }

  // ── главный цикл ──
  /* Расписание строится всегда, даже у прогона без картинки: кадры там
     по-прежнему идут (`gap95` у «pose/gpu» — такое же число таблицы, как у
     остальных), и ветка «а тут расписания нет» была бы вторым путём, по
     которому мерится то же самое. */
  const level = makeRun(SEED, world, STEP)
  const t0 = performance.now()
  let lastWindow = t0

  /* `run.start` пишется ПОСЛЕ того, как всё завелось, а не до. Иначе
     несостоявшийся прогон (камера не открылась, делегат не поднялся) всё
     равно оставлял бы запись, и повтор дал бы в таблице разбора пятый
     забег с нулём окон — рядом с четырьмя настоящими. */
  noteRunStart(run, world)
  const health = makeHealth(
    /* Счёт и буфер берутся у вывода ПО ОТДЕЛЬНОСТИ, потому что `stats()`
       сверяется с `estimate` целиком и пятого поля в нём быть не может
       (`Renderer.buffer`). Собираются они здесь, в одном выражении, чтобы
       журнал не мог получить счёт одного кадра и буфер другого. */
    () => (renderer ? { ...renderer.stats(), bufPx: renderer.buffer().px } : NO_DRAW),
    t0,
  )

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame)
    health.frame(now)
    if (renderer) {
      const drawStart = performance.now()
      renderer.draw(composeScene(stateAt(level, (now - t0) / 1000, world)))
      health.drew(performance.now() - drawStart)
    }
    if (now - lastWindow > 1000) {
      lastWindow = now
      const w = health.flush(now, runName(run))
      if (w) {
        /* Буфер на экране, а не только в журнале: первый вопрос у штатива —
           «подействовала ли ручка вообще», и ответ на него обязан быть
           виден ДО разбора. Прогон с неподействовавшим потолком иначе
           уехал бы в таблицу как полноценная строка. */
        say(`${runName(run)}  fps ${w.fps}  gap95 ${w.gap95} мс  позы ${w.hz} Гц`
          + `  инференс ${w.p50} мс  вызовы ${w.calls}  буфер ${renderer?.buffer().w ?? 0}×`
          + `${renderer?.buffer().h ?? 0}`)
      }
    }
  }
  raf = requestAnimationFrame(frame)

  return {
    resize(): void {
      renderer?.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio)
    },

    async stop(): Promise<void> {
      cancelAnimationFrame(raf)
      if (worker) {
        worker.postMessage({ type: 'stop' })
        worker.terminate()
      }
      camStop?.()
      renderer?.dispose()
      await log.flush()
    },
  }
}

/**
 * Держать экран включённым, пока идёт замер.
 *
 * Без этого вся затея рушится тихо: прогон идёт не меньше минуты без единого
 * касания, экран гаснет, `requestAnimationFrame` встаёт — и `gap95` с
 * паузами отравлены ровно там, где снимается приговор. `run-game` держит
 * блокировку по той же причине (`app.js:140`).
 *
 * Имена событий журнала те же, что там: разбор считает по ним, сколько раз
 * блокировку снимало системой (`released: true, why: 'system'`) и сколько
 * раз её брали заново (`got: true, why: 'regain'`). Запрос повторяется при
 * возврате на вкладку: система снимает блокировку, уводя страницу в фон, и
 * сама её не возвращает.
 */
export function keepAwake(
  warn: (text: string | null) => void,
  /* Запрашиватель приходит параметром, а не берётся из `navigator` внутри:
     ветку «блокировки не дали» иначе нечем проверить, а она и есть главная
     — молчаливый отказ здесь стоит целого выезда. */
  api: { request(kind: string): Promise<any> } | undefined = (navigator as any)?.wakeLock,
): void {
  /* Молчать нельзя. Прежняя версия писала отказ только в журнал — то есть
     человек узнавал бы о погасшем экране ПОСЛЕ выезда, разбирая числа, в
     которых уже ничего не поправить. Отказ обязан быть на экране, рядом с
     кнопками, и не исчезать. */
  const complain = (why: string): void => {
    warn(`экран может погаснуть (${why}) — выключите автоблокировку в настройках телефона`)
  }
  if (!api) {
    log.event('wakelock', { got: false, why: 'unsupported' })
    complain('браузер не умеет wakeLock')
    return
  }
  let held: any = null
  const ask = async (why: string): Promise<void> => {
    if (held && held.released !== true) return
    try {
      const lock = await api.request('screen')
      held = lock
      warn(null)
      lock.addEventListener?.('release', () => {
        if (held !== lock) return
        held = null
        log.event('wakelock', { got: false, released: true, why: 'system' })
        complain('система сняла блокировку')
      })
      log.event('wakelock', { got: true, why })
    } catch (e) {
      const name = String((e as Error)?.name ?? e)
      log.event('wakelock', { got: false, why: name })
      complain(name)
    }
  }
  void ask('start')
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void ask('regain')
  })
}

// ──────────────────────────── пульт замера ────────────────────────────

/** Три экрана пульта: калитка, выбор прогона, сам прогон. */
export type PultScreen = 'gate' | 'pult' | 'run'

export type PultDeps = {
  /** Запустить прогон. В странице — `switchTo`, в проверке — список вызовов. */
  play: (run: Run, world: string) => void
  /** Удержание экрана. Просится ТОЛЬКО с калитки: нужен живой жест. */
  keepAwake?: () => void
  /** Полный экран. Там же и по той же причине. */
  fullscreen?: () => void
}

export type Pult = {
  readonly screen: PultScreen
  readonly world: string
  /** Имена прогонов, которые в этой сессии уже шли. */
  readonly done: readonly string[]
  /** Касание калитки: отсюда и только отсюда просятся экранные права. */
  start(): void
  pick(run: Run): void
  toMenu(): void
  nextWorld(): void
}

/**
 * Пульт: что на экране, какой мир выбран и какие прогоны уже сняты.
 *
 * Без DOM намеренно — ровно затем, чтобы это проверялось в `node`. Страница
 * ниже только рисует это состояние и зовёт его же методы.
 *
 * Зачем калитка. Полный экран и `wakeLock` браузер отдаёт только по живому
 * жесту. Пока страница просила их при загрузке, отказ приходил молча, и
 * обнаружился бы погасшим экраном посреди прогона — то есть отравленным
 * `gap95` ровно там, где снимается приговор.
 *
 * Зачем отметка пройденных. Все прогоны снимаются в ОДНОЙ сессии (разброс
 * устройства ±8 fps живёт между сессиями), и пропущенный обнаруживается уже
 * на разборе, когда телефон сложен и ребёнок ушёл. С приходом малого буфера
 * их семь, и пропустить один стало ровно вдвое легче.
 */
export function makePult(deps: PultDeps): Pult {
  const worlds = spikeWorlds()
  let screen: PultScreen = 'gate'
  let at = 0
  const done: string[] = []

  return {
    get screen(): PultScreen {
      return screen
    },
    get world(): string {
      return worlds[at]
    },
    get done(): readonly string[] {
      return done
    },

    start(): void {
      screen = 'pult'
      deps.fullscreen?.()
      deps.keepAwake?.()
    },

    pick(run: Run): void {
      const name = runName(run)
      /* Повтор прогона второй отметки не заводит: прогонов по-прежнему
         столько, сколько адресов в `SPIKE_RUNS`, и «снято шесть из семи»
         обязано читаться с экрана. */
      if (!done.includes(name)) done.push(name)
      screen = 'run'
      deps.play(run, worlds[at])
    },

    toMenu(): void {
      screen = 'pult'
    },

    nextWorld(): void {
      at = (at + 1) % worlds.length
    },
  }
}

/**
 * Запуск страницы. Зовётся из `spike.html`, а не сама: модуль обязан
 * импортироваться в `node` (его проверяет прогон), а там страницы нет.
 *
 * Здесь только рисование состояния пульта и подписка на его методы: что
 * показано, какой мир и какие прогоны сняты, решает `makePult`, который
 * проверяется в `node`. Разделение нужно затем, чтобы правило «права
 * просятся только с калитки» сторожилось тестом, а не чтением кода.
 */
export function boot(): void {
  log.watchLifecycle()

  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
  const gateEl = byId('gate')
  const pultEl = byId('pult')
  const runEl = byId('run')
  const canvas = byId<HTMLCanvasElement>('stage')
  const status = byId('status')
  const warnEl = byId('warn')
  const tilesEl = byId('tiles')
  const worldEl = byId<HTMLButtonElement>('world')
  const saveEl = byId<HTMLButtonElement>('save')
  const pultMsg = byId('pultMsg')
  const runLabel = byId('runLabel')

  const say = (s: string): void => {
    status.textContent = s
  }
  /* Предупреждение живёт ОТДЕЛЬНОЙ строкой: `say` переписывается каждую
     секунду числами окна, и беда, попавшая туда, исчезла бы через секунду. */
  const warn = (text: string | null): void => {
    warnEl.textContent = text ?? ''
    warnEl.hidden = !text
  }

  let current: Live | null = null
  let busy = false

  async function stop(): Promise<void> {
    await current?.stop()
    current = null
  }

  async function switchTo(run: Run, world: string): Promise<void> {
    if (busy) return
    busy = true
    try {
      await stop()
      say(`${runName(run)}: запуск…`)
      current = await runLive(run, world, canvas, say)
    } catch (e) {
      log.event('spike.fail', { run: runName(run), message: String((e as Error)?.message ?? e) })
      say(`${runName(run)} не запустился: ${String((e as Error)?.message ?? e)}`)
    } finally {
      busy = false
    }
  }

  const pult = makePult({
    play: (run, world) => {
      /* Сначала показать экран прогона, потом запускать. Канва на скрытом
         экране имеет нулевой размер, и буфер отрисовки завёлся бы нулевым —
         то есть числа были бы сняты с картинки, которой нет. */
      runLabel.textContent = tileText(run)
      paint()
      void switchTo(run, world)
    },
    keepAwake: () => keepAwake(warn),
    fullscreen: () => {
      /* Отказ в полном экране замер не отменяет: он портит только поля по
         краям. Молчать о нём тоже нельзя — шторка сверху крадёт кадры. */
      void document.documentElement.requestFullscreen?.().catch((e: Error) => {
        log.event('fullscreen.fail', { message: String(e?.message ?? e) })
      })
    },
  })

  const tileText = (run: Run): string => {
    const t = runTile(run)
    return `${t.no} · ${t.title} · ${t.sub}`
  }

  /* Плитки — те же прогоны, что и адреса: список один (`SPIKE_RUNS`), и
     «поменяли адрес, а кнопка осталась прежней» невозможно. Поэтому и
     тройка малого буфера появилась на пульте сама, без правки здесь. */
  const marks = new Map<string, HTMLElement>()
  for (const search of SPIKE_RUNS) {
    const run = runFromQuery(search)
    const t = runTile(run)
    const b = document.createElement('button')
    b.className = 'tile'
    b.innerHTML = `<b>${t.no} · ${t.title}</b><span>${t.sub}</span><i hidden>снят</i>`
    b.onclick = () => pult.pick(run)
    tilesEl.append(b)
    marks.set(runName(run), b)
  }

  function paint(): void {
    gateEl.hidden = pult.screen !== 'gate'
    pultEl.hidden = pult.screen !== 'pult'
    runEl.hidden = pult.screen !== 'run'
    worldEl.textContent = `Мир: ${(WORLDS as Record<string, { name: string }>)[pult.world].name}`
    for (const [name, b] of marks) {
      const played = pult.done.includes(name)
      b.classList.toggle('played', played)
      ;(b.querySelector('i') as HTMLElement).hidden = !played
    }
  }

  byId<HTMLButtonElement>('gateStart').onclick = () => {
    pult.start()
    paint()
    /* Адрес по-прежнему задаёт НАЧАЛЬНЫЙ прогон — тем же разбором и с тем же
       громким отказом на незнакомом значении. Без параметров пульт просто
       остаётся на экране выбора: открыть страницу и ничего не запустить
       теперь можно, и это отдельно полезно — журнал выгружают оттуда же. */
    if (!location.search) return
    try {
      pult.pick(runFromQuery(location.search))
    } catch (e) {
      pultMsg.textContent = String((e as Error)?.message ?? e)
    }
  }

  worldEl.onclick = () => {
    pult.nextWorld()
    paint()
  }

  byId<HTMLButtonElement>('back').onclick = () => {
    void stop().then(() => {
      pult.toMenu()
      paint()
    })
  }

  saveEl.onclick = async () => {
    await stop()
    const r = await log.save()
    pultMsg.textContent = `журнал: ${r.name}, ${Math.round(r.bytes / 1024)} КБ, сессий ${r.sessions}`
  }

  /* Поворот телефона посреди замера обязан доехать до буфера: иначе кадры
     продолжают рисоваться в прежний размер, и числа второй половины прогона
     сняты с другой картинки, чем числа первой. */
  addEventListener('resize', () => current?.resize())

  paint()
}
