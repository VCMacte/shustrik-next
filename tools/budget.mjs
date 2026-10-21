/**
 * `npm run budget` — худший кадр по мирам, в `node`, без телефона.
 *
 * Зачем отдельный прогон, а не только тест. Правило проекта требует, чтобы
 * число БЫЛО НАПЕЧАТАНО, а не только сверено с порогом: сверка молчит, пока
 * всё хорошо, и число становится известным ровно в тот момент, когда уже
 * поздно. Приём взят у `run-game` (`tests-control.mjs`, группа «бюджет
 * кадра»): печатается худший кадр и строка «по мирам».
 *
 * Перебор — тот же, что у счётчика `run-game`, и каждая его ось оплачена там
 * отдельной дырой:
 *   • МИРЫ — у каждого своя пара внешностей препятствий и свои зоны обочины;
 *     перебор одного мира не видел бы фигур остальных трёх;
 *   • ПОСЕВЫ — худший кадр зависит от того, как встали обочина и кольца, и
 *     разброс между посевами — десяток размещений;
 *   • СТУПЕНИ — у верхних своя скорость, своё чередование и свой ряд колец,
 *     то есть свой СОСТАВ кадра;
 *   • ПРИЗЫ — полный набор: призы накопительны, и мерить надо кадр ребёнка с
 *     собранной лестницей, а не пустой профиль (приз правит состав обочины).
 *
 * Счёт живёт НЕ здесь: складывает `src/render/estimate.ts`, один на всех, и
 * его же читает тест. Здесь только перебор кадров. Второй счётчик в этом
 * файле означал бы ровно то расхождение, от которого заведено правило «судят
 * и рисуют по одному числу».
 */
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { makeLevel } from '../src/core/level.js'
import { STEP_MAX, tuneFor } from '../src/core/difficulty.js'
import { WORLDS, worldReady, zoneAt } from '../src/core/theme.js'
import { unlockedAt } from '../src/core/awards.js'
/* `makeDecor` и `makeStars` живут в старом Canvas2D-рендерере, и взять их
   больше негде: это ГЕНЕРАТОРЫ расписания, а не отрисовка, и в `run-game`
   они лежат там же. Сторож стыка (`tests/guards.test.ts`) закрывает `src/`
   кроме `src/core`; инструменты и тесты он не трогает намеренно — иначе
   бюджет пришлось бы считать по расписанию, собранному руками, то есть по
   кадру, которого в игре не бывает. */
import { makeDecor, makeStars } from '../src/core/view.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * Посевы — те же четыре, что у счётчика `run-game`. Четыре, а не один:
 * один посев дал бы случайное число и однажды пропустил бы перебор.
 */
export const SEEDS = [1, 7, 13, 29]

/** Длина забега, секунды: как в счётчике `run-game`. */
export const DURATION_S = 300

/**
 * Шаг по времени. Кадры между соседними шагами отличаются сдвигом камеры, а
 * не СОСТАВОМ, а на число вызовов влияет только состав.
 */
export const FRAME_STEP_S = 0.25

/**
 * Банк призов, по которому собирается полный набор. То же число, что в
 * счётчике `run-game`: он открывает всю лестницу.
 */
const FULL_BANK = 1200

/**
 * Случайность с посевом — копия помощника из `tests-control.mjs`, а не из
 * логики игры: генераторы принимают `rng` снаружи ровно для этого, и перебор
 * обязан быть повторяемым. Формула повторена дословно, чтобы кадры здесь и
 * там были ОДНИМИ И ТЕМИ ЖЕ.
 */
function seeded(seed) {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

/**
 * Миры, по которым мерится бюджет. ЕДИНСТВЕННЫЙ владелец этого списка.
 *
 * Только собранные: у несобранного мира нет зон (`zonesOf` отдаёт ему зоны
 * холмов), мерить там нечего, и счётчик `run-game` фильтрует так же. Но
 * владелец обязан быть один: тест перебирал `Object.keys(WORLDS)`, а прогон
 * — отфильтрованный список, и сегодня они совпадали ровно потому, что
 * собраны все четыре мира. Пятый, несобранный, развёл бы их молча — и бюджет
 * начал бы СУДИТЬ не то, что ПЕЧАТАЕТ. Отсюда функция, а не константа: состав
 * зависит от `worldReady`, то есть от палитры, и застыть в снимке не вправе.
 */
export function measuredWorlds() {
  return Object.keys(WORLDS).filter((w) => worldReady(w))
}

/** Таблица ассетов с диска: её считает `tools/asset-stat.mjs`. */
export function loadAssets() {
  return JSON.parse(readFileSync(join(ROOT, 'assets', 'manifest.json'), 'utf8'))
}

/*
 * Счётчик подгружается ЧЕРЕЗ VITE, и это не причуда, а то же правило «одно
 * место» в применении к разрешению модулей.
 *
 * `src/render/estimate.ts` и `compose.ts` — TypeScript, и импорты в них без
 * расширений (`./numbers`, `./types`): так настроен проект
 * (`moduleResolution: Bundler`), и так их читают тесты. Голый `node` этого не
 * умеет ни с `--experimental-strip-types`, ни без: расширение он требует.
 * Выходов было три, и два плохие — дописать расширения в `compose.ts` ради
 * инструмента (правка чужого файла под нужды прогона) или завести вторую
 * копию счёта на JavaScript (ровно то расхождение, от которого заведено
 * «судят и рисуют по одному числу»). Остаётся третий: попросить разрешить
 * модули того, кто это и так делает для тестов и для `npm run dev`.
 *
 * Отсюда и ленивость: `vite` поднимается только когда прогон действительно
 * запущен программой, а тест импортирует `worstFrame` и грузит счётчик сам —
 * своим же разрешением модулей.
 */
let counters = null

async function loadCounters() {
  if (counters) return counters
  const { createServer } = await import('vite')
  const server = await createServer({
    configFile: false,
    root: ROOT,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true },
  })
  try {
    const [compose, estimate] = await Promise.all([
      server.ssrLoadModule('/src/render/compose.ts'),
      server.ssrLoadModule('/src/render/estimate.ts'),
    ])
    counters = { ...compose, ...estimate }
  } finally {
    /* Сервер нужен только на время загрузки: функции переживают его
       закрытие, а незакрытый он держит процесс и прогон не кончается. */
    await server.close()
  }
  return counters
}

/**
 * Расписание одного забега: препятствия, кольца и обочина для тройки
 * (мир, посев, ступень).
 *
 * ЕДИНСТВЕННЫЙ владелец порядка вызовов генераторов. Порядок здесь — не
 * стиль: все трое тянут из одного `rng`, и переставь их местами — получится
 * другой забег при том же посеве. Отсюда и функция: перебор ниже и
 * восстановление отдельного кадра (`sceneAt`) обязаны получать ОДИН И ТОТ ЖЕ
 * забег, иначе «худший кадр» и кадр, который потом разглядывают, окажутся
 * разными кадрами — молча.
 */
export function runOf(world, seed, step) {
  const rng = seeded(seed)
  const tune = tuneFor(step)
  const prizes = unlockedAt(FULL_BANK)
  /* МИР едет и в генератор препятствий: у каждого мира своя пара
     внешностей, и без этого параметра перебор мерил бы четыре мира
     фигурами холмов. */
  const obstacles = makeLevel({ durationS: DURATION_S, rng, tune, world })
  const stars = makeStars({ durationS: DURATION_S, obstacles, rng, tune })
  const decor = makeDecor({ durationS: DURATION_S, rng, world, prizes, speed: tune.speed })
  return { obstacles, stars, decor, tune, prizes }
}

/**
 * Состояние забега на секунде `t`. Тоже единственный владелец: описание
 * кадра целиком зависит от того, какие поля сюда положены, и вторая копия
 * этого объекта означала бы второй кадр с тем же названием.
 */
export function stateAt(run, world, step, t) {
  return {
    decor: run.decor,
    obstacles: run.obstacles,
    stars: run.stars,
    /* Боковая скорость тела, а не ход коридора: ход берётся у ступени
       (`tuneFor(step).speed`) внутри `composeScene`. На состав кадра это
       число не влияет вовсе, и записано оно ради того, чтобы состояние было
       настоящим, а не урезанным под счётчик. */
    speed: 0.5,
    u: t % 2 < 1 ? 1 : -1,
    v: 0,
    travel: t * run.tune.speed,
    elapsed: t,
    /* Зона — та же, что была бы в игре: формы обочины у зон свои, и небо
       кадра берётся по ней же. */
    zone: zoneAt(t, DURATION_S, world),
    prizes: run.prizes,
    finishIn: DURATION_S - t,
    safe: true,
    pulse: 0,
    dim: 0,
    world,
    durationS: DURATION_S,
    step,
  }
}

/**
 * Описание ОДНОГО кадра по его привязке `{world, seed, step, atS}` — ровно
 * той, которую отдаёт `worstFrame`.
 *
 * Нужно это затем, чтобы худший кадр можно было не только посчитать, но и
 * разглядеть: трёхмерный вывод сверяет на нём живой счёт с оценкой
 * (`tests/three-build.test.ts`). Пересобирается он теми же `runOf` и
 * `stateAt`, которыми шёл перебор, поэтому «тот самый кадр» — это свойство
 * кода, а не надежда; тест вдобавок сверяет восстановленный кадр с числами
 * перебора.
 */
export async function sceneAt(where, deps = {}) {
  const compose = deps.composeScene ?? (await loadCounters()).composeScene
  const run = runOf(where.world, where.seed, where.step)
  return compose(stateAt(run, where.world, where.step, where.atS))
}

/**
 * Худший кадр одного мира.
 *
 * Возвращаются МАКСИМУМЫ по каждому числу отдельно, а не четыре числа одного
 * кадра: самый дорогой по вызовам кадр не обязан быть самым дорогим по
 * вершинам, и «уложились» надо доказывать по каждой оси. Привязка (`zone`,
 * `seed`, `step`, `atS`) описывает кадр, худший ПО ВЫЗОВАМ — он головной,
 * как и в `run-game`; привязки остальных максимумов лежат в `peak`.
 *
 * `deps` — не отладочный ход, а способ прогнать перебор ПОДМЕНЁННЫМ
 * счётчиком и увидеть, что проверка не вечнозелёная: мутация, а не
 * рассуждение.
 */
export async function worstFrame(world, assets, deps = {}) {
  const loaded = await loadCounters()
  const compose = deps.composeScene ?? loaded.composeScene
  const estimate = deps.estimateFrame ?? loaded.estimateFrame
  const backdrop = deps.backdropAssets ?? loaded.backdropAssets

  const best = {
    world,
    frames: 0,
    calls: 0,
    callsNoInstancing: 0,
    verts: 0,
    texBytes: 0,
    /* Сколько РАЗНЫХ ассетов стоит в кадре — считается здесь, своим
       множеством, и к арифметике `estimate.ts` не причастно. Нужно это как
       НЕЗАВИСИМАЯ нижняя граница вызовов: у каждого ассета вызовов хотя бы
       один, значит вызовов в кадре не меньше, чем разных ассетов. Сверка с
       этим числом — единственная опора снимка худшего кадра, которая не
       проходит через документ. */
    distinctAssets: 0,
    zone: null,
    seed: null,
    step: null,
    atS: 0,
    backdrop: null,
    placementCount: 0,
    peak: {},
  }

  /** Запоминает максимум одного числа вместе с тем, где он случился. */
  const note = (key, value, where) => {
    if (!(value > best[key])) return
    best[key] = value
    best.peak[key] = where
  }

  for (const seed of SEEDS) {
    for (let step = 0; step <= STEP_MAX; step++) {
      const run = runOf(world, seed, step)

      for (let t = 0; t < DURATION_S; t += FRAME_STEP_S) {
        /* Кольца НЕ помечаются собранными, и это оценка СВЕРХУ, а не
           небрежность. В `run-game` собранное кольцо добавляло искры, и
           пометить ближайшее было дороже; здесь собранное кольцо просто
           исчезает из описания (`placeStar` отдаёт `null`), то есть любая
           пометка делает кадр ЛЕГЧЕ правды. */
        const scene = compose(stateAt(run, world, step, t))

        const b = estimate(scene, assets)
        const where = { zone: scene.zone, seed, step, atS: t }
        best.frames += 1
        if (b.calls > best.calls) {
          best.zone = scene.zone
          best.seed = seed
          best.step = step
          best.atS = t
          best.backdrop = b.backdrop
          best.placementCount = scene.placements.length
        }
        const kinds = new Set(scene.placements.map((p) => p.asset))
        for (const a of backdrop(scene)) kinds.add(a)
        note('distinctAssets', kinds.size, where)
        note('calls', b.calls, where)
        note('callsNoInstancing', b.callsNoInstancing, where)
        note('verts', b.verts, where)
        note('texBytes', b.texBytes, where)
      }
    }
  }

  return best
}

const MB = (bytes) => (bytes / 1048576).toFixed(1)

async function main() {
  const { CEILING_CALLS, SOFT_CALLS, CEILING_VERTS, CEILING_TEX_BYTES } = await loadCounters()
  const assets = loadAssets()

  const worlds = measuredWorlds()
  const byWorld = {}
  for (const world of worlds) byWorld[world] = await worstFrame(world, assets)

  /* Максимум КАЖДОГО числа по всем мирам, а не числа одного мира. Худший по
     вызовам мир не обязан быть худшим по вершинам или по вызовам без
     инстансирования — и это не рассуждение: `hills` даёт 15 вызовов и 24 без
     инстансирования, а `deep` — 14 и 25. Взять вторую цифру у головного мира
     значило бы объявить потолок проверенным по 24 там, где считается 25. */
  const across = (key) =>
    worlds.reduce((a, w) => (byWorld[w][key] > byWorld[a][key] ? w : a), worlds[0])

  const worst = across('calls')
  const W = byWorld[worst]
  const noInstWorld = across('callsNoInstancing')
  const vertsWorld = across('verts')
  const texWorld = across('texBytes')
  const NOINST = byWorld[noInstWorld].callsNoInstancing
  const VERTS = byWorld[vertsWorld].verts
  const TEX = byWorld[texWorld].texBytes
  const DISTINCT = byWorld[across('distinctAssets')].distinctAssets

  console.log('')
  console.log(
    `Бюджет кадра: ${worlds.length} миров × ${SEEDS.length} посевов ×` +
      ` ${STEP_MAX + 1} ступеней × ${DURATION_S} с шагом ${FRAME_STEP_S} с` +
      ` = ${worlds.reduce((n, w) => n + byWorld[w].frames, 0)} кадров.`,
  )
  console.log(
    'Числа ПРЕДВАРИТЕЛЬНЫ: сложность заглушек назначена, а не замерена' +
      ' (docs/art-placeholders.md). Правдива механика счёта.',
  )
  console.log('')
  console.log(
    `худший кадр: ${W.calls} вызовов при потолке ${CEILING_CALLS}` +
      ` (мир ${worst}, зона ${W.zone}, посев ${W.seed}, ступень ${W.step},` +
      ` ${W.atS.toFixed(1)} с, размещений ${W.placementCount})`,
  )
  console.log(
    '  из них постоянная часть кадра (пол, стены, небо зоны):' +
      ` ${W.backdrop.calls} вызовов, ${W.backdrop.verts} вершин,` +
      ` ${MB(W.backdrop.texBytes)} МБ`,
  )
  console.log(
    `  БЕЗ инстансирования худший кадр прогона: ${NOINST} вызовов` +
      ` (мир ${noInstWorld}) при том же потолке ${CEILING_CALLS} —` +
      ` ${NOINST < CEILING_CALLS ? 'укладывается' : 'НЕ УКЛАДЫВАЕТСЯ'}`,
  )
  console.log(
    `  разных ассетов в кадре (максимум прогона): ${DISTINCT}` +
      ' — независимая нижняя граница вызовов, считанная не счётчиком',
  )
  console.log(
    `  вершин (максимум прогона): ${VERTS} (мир ${vertsWorld})` +
      ` при потолке ${CEILING_VERTS}`,
  )
  console.log(
    `  текстур в кадре (максимум прогона): ${MB(TEX)} МБ (мир ${texWorld})` +
      ` при потолке ${MB(CEILING_TEX_BYTES)} МБ`,
  )
  console.log(
    'по мирам: ' +
      worlds
        .slice()
        .sort((a, b) => byWorld[b].calls - byWorld[a].calls)
        .map((w) => `${w} ${byWorld[w].calls} (без инст. ${byWorld[w].callsNoInstancing})`)
        .join(' · '),
  )
  console.log('')

  /* Приговор печатается здесь же, а не оставляется читателю: потолки
     записаны ЗАРАНЕЕ, и подогнать их под полученное число запрещено
     (CLAUDE.md). Мягкий рубеж назван отдельно — он не отказ, а предел, за
     которым новые украшения требуют замера на телефоне. */
  const verdicts = [
    [`вызовы < ${CEILING_CALLS}`, W.calls < CEILING_CALLS, true],
    [`вызовы ниже мягкого рубежа ${SOFT_CALLS}`, W.calls < SOFT_CALLS, false],
    [`вызовы БЕЗ инстансирования < ${CEILING_CALLS}`, NOINST < CEILING_CALLS, true],
    [`вершины < ${CEILING_VERTS}`, VERTS < CEILING_VERTS, true],
    [`текстуры кадра ≤ ${MB(CEILING_TEX_BYTES)} МБ`, TEX <= CEILING_TEX_BYTES, true],
    /* Не потолок, а сторож против ЗАНИЖЕНИЯ: вызовов не может быть меньше,
       чем разных ассетов в кадре, и считаны эти два числа по-разному. */
    [`вызовов не меньше, чем разных ассетов (${DISTINCT})`, W.calls >= DISTINCT, true],
  ]
  for (const [what, ok] of verdicts) console.log(`${ok ? '  да ' : '  НЕТ'} ${what}`)
  console.log('')

  /* Мягкий рубеж не роняет прогон: он предел для украшений, а не потолок.
     Жёсткие — роняют, иначе «не уложились» осталось бы строкой в выводе. */
  if (verdicts.some(([, ok, hard]) => hard && !ok)) process.exitCode = 1
}

/* Запуск только как программы: тест импортирует `worstFrame` и печатать
   ничего не должен. */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
