/**
 * Спайк: страница, на которой снимается ЕДИНСТВЕННОЕ число проекта.
 *
 * Развилка «полное 3D или 2.5D» не решена, и решает её замер на телефоне:
 * `gap95` ≤ 40 мс И частота поз ≥ 10 Гц И доля пауз ноль
 * (`docs/superpowers/specs/2026-10-21-architecture.md`). Порог записан
 * заранее и под полученное число не меняется.
 *
 * Отсюда устройство страницы — четыре прогона в ОДНОЙ сессии:
 *
 *   scene/-     картинка без позы      — сколько стоит трёхмерный вывод сам
 *   pose/gpu    поза без картинки      — сколько стоит инференс сам
 *   both/gpu    и то и другое на GPU   — там инференс отнимает кадры
 *   both/cpu    и то и другое на CPU   — там картинка отнимает герцы
 *
 * В одной сессии, а не четырьмя перезагрузками: разброс устройства ±8 fps
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
import { zoneAt } from '../core/theme.js'
import { POSE } from '../core/config.js'
import { quantile, round } from '../core/util.js'
import { openCamera } from '../core/camera.js'
import * as log from '../core/log.js'

import { makeDecor, makeStars } from '../render/numbers'
import { composeScene } from '../render/compose'
import type { Decor, Obstacle, RunState } from '../render/types'
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
}

const WHATS: What[] = ['scene', 'pose', 'both']
const DELEGATES: Delegate[] = ['gpu', 'cpu']

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

  return { what, delegate }
}

/**
 * Четыре адреса замера — ЕДИНСТВЕННЫЙ их владелец.
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
] as const

/** Как прогон называется в журнале и на кнопке. */
export function runName(run: Run): string {
  return `${run.what}/${run.delegate ?? '-'}`
}

/**
 * Отметка начала прогона. ЕДИНСТВЕННОЕ место, где `run.start` попадает в
 * журнал: по этим записям четыре прогона потом и различают.
 */
export function noteRunStart(run: Run): void {
  /* `world` и `step` рядом не для полноты: разбор `run-game` печатает их у
     каждого забега, и без них четыре строки таблицы не сказали бы, что
     сняты они с одного и того же кадра. */
  log.event('run.start', {
    what: run.what,
    delegate: run.delegate ?? '-',
    world: WORLD,
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
 * Чего в `run-game` нет и что прибавлено здесь — `calls` и `verts` из
 * `renderer.stats()`. Разборщик их просто не заметит: он берёт поля по
 * именам, а не весь объект.
 */
export function makeHealth(
  stats: () => { calls: number; verts: number },
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

/** Мир, посев и ступень замера. Одни и те же во всех четырёх прогонах. */
export const WORLD = 'city'
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
export function makeRun(seed: number = SEED, world: string = WORLD, step: number = STEP) {
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
export function stateAt(run: ReturnType<typeof makeRun>, t: number): RunState {
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
    zone: zoneAt(t, DURATION_S, WORLD),
    prizes: run.prizes as unknown as Record<string, boolean>,
    finishIn: DURATION_S - t,
    safe: true,
    pulse: 0,
    dim: 0,
    world: WORLD,
    durationS: DURATION_S,
    step: STEP,
  }
}

// ─────────────────────────────── страница ───────────────────────────────

/** Пустой счёт: у прогона без картинки вызовов и вершин нет, а не «неизвестно». */
const NO_DRAW = { calls: 0, verts: 0 }

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
async function runLive(run: Run, canvas: HTMLCanvasElement, say: (s: string) => void): Promise<Live> {
  let renderer: Renderer | null = null

  // ── картинка ──
  let raf = 0
  const schedule = run.what !== 'pose'
  if (schedule) {
    renderer = await makeThreeRenderer(canvas)
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
  const level = makeRun()
  const t0 = performance.now()
  let lastWindow = t0

  /* `run.start` пишется ПОСЛЕ того, как всё завелось, а не до. Иначе
     несостоявшийся прогон (камера не открылась, делегат не поднялся) всё
     равно оставлял бы запись, и повтор дал бы в таблице разбора пятый
     забег с нулём окон — рядом с четырьмя настоящими. */
  noteRunStart(run)
  const health = makeHealth(() => renderer?.stats() ?? NO_DRAW, t0)

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame)
    health.frame(now)
    if (renderer) {
      const drawStart = performance.now()
      renderer.draw(composeScene(stateAt(level, (now - t0) / 1000)))
      health.drew(performance.now() - drawStart)
    }
    if (now - lastWindow > 1000) {
      lastWindow = now
      const w = health.flush(now, runName(run))
      if (w) {
        say(`${runName(run)}  fps ${w.fps}  gap95 ${w.gap95} мс  позы ${w.hz} Гц`
          + `  инференс ${w.p50} мс  вызовы ${w.calls}`)
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

/**
 * Запуск страницы. Зовётся из `spike.html`, а не сама: модуль обязан
 * импортироваться в `node` (его проверяет прогон), а там страницы нет.
 */
export function boot(): void {
  log.watchLifecycle()

  const canvas = document.getElementById('stage') as HTMLCanvasElement
  const status = document.getElementById('status') as HTMLElement
  const buttons = document.getElementById('runs') as HTMLElement
  const warnEl = document.getElementById('warn') as HTMLElement
  const say = (s: string): void => {
    status.textContent = s
  }
  /* Предупреждение живёт ОТДЕЛЬНОЙ строкой: `say` переписывается каждую
     секунду числами окна, и беда, попавшая туда, исчезла бы через секунду. */
  const warn = (text: string | null): void => {
    warnEl.textContent = text ?? ''
    warnEl.hidden = !text
  }
  /* После `warn`, а не до: блокировка умеет не дасться, и сказать об этом
     надо на экран, которого до этой строки ещё нет. */
  keepAwake(warn)

  let current: Live | null = null
  let busy = false

  async function switchTo(run: Run): Promise<void> {
    if (busy) return
    busy = true
    try {
      await current?.stop()
      current = null
      say(`${runName(run)}: запуск…`)
      current = await runLive(run, canvas, say)
    } catch (e) {
      log.event('spike.fail', { run: runName(run), message: String((e as Error)?.message ?? e) })
      say(`${runName(run)} не запустился: ${String((e as Error)?.message ?? e)}`)
    } finally {
      busy = false
    }
  }

  /* Четыре кнопки — те же четыре прогона, что и четыре адреса. Кнопки нужны,
     чтобы все четыре легли в ОДНУ сессию журнала: разброс устройства живёт
     между сессиями. */
  for (const search of SPIKE_RUNS) {
    const run = runFromQuery(search)
    const b = document.createElement('button')
    b.textContent = runName(run)
    b.onclick = () => void switchTo(run)
    buttons.append(b)
  }

  const save = document.createElement('button')
  save.textContent = 'выгрузить журнал'
  save.onclick = async () => {
    await current?.stop()
    current = null
    const r = await log.save()
    say(`журнал: ${r.name}, ${Math.round(r.bytes / 1024)} КБ, сессий ${r.sessions}`)
  }
  buttons.append(save)

  /* Поворот телефона посреди замера обязан доехать до буфера: иначе кадры
     продолжают рисоваться в прежний размер, и числа второй половины прогона
     сняты с другой картинки, чем числа первой. */
  addEventListener('resize', () => current?.resize())

  void switchTo(runFromQuery(location.search))
}
