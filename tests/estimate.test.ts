/**
 * Бюджет кадра считается ПО ОПИСАНИЮ сцены, в `node`, без телефона и без GPU.
 *
 * Правило проекта, ради которого этот файл существует: **число, по которому
 * СУДЯТ, и число, которое РИСУЮТ, берутся из одного места** (CLAUDE.md,
 * спека, раздел «Бюджет считается по описанию, а не по устройству»). Позже
 * `renderer.stats()` отдаст живые вызовы и вершины, и тест сверит их с
 * `estimate` того же кадра; разойдутся — значит одно из двух врёт.
 *
 * Чего эти проверки НЕ доказывают, и читать их без этого нельзя: сложность
 * ассетов в `assets/manifest.json` НАЗНАЧЕНА автором заглушек, а не замерена
 * (`docs/art-placeholders.md`). Проверяется МЕХАНИКА СЧЁТА — она правдива
 * уже сейчас, — а не предсказание кадров в секунду.
 *
 * Каждая проверка здесь отвечает на вопрос «прошла бы она, если убрать то,
 * что она проверяет?» — ответ записан рядом с ней, потому что за прошлый
 * этап трижды находился тест, зелёный по построению.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  CEILING_CALLS,
  CEILING_TEX_BYTES,
  CEILING_VERTS,
  SOFT_CALLS,
  backdropAssets,
  estimate,
  estimateFrame,
  estimateWithoutInstancing,
} from '../src/render/estimate'
import type { AssetTable } from '../src/render/estimate'
import type { FrameScene, Placement } from '../src/render/types'
import { WORLDS } from '../src/core/theme.js'
import { DURATION_S, FRAME_STEP_S, SEEDS, worstFrame } from '../tools/budget.mjs'
import { STEP_MAX } from '../src/core/difficulty.js'

/** Таблица ассетов — та самая, которую считает `tools/asset-stat.mjs`. */
const table: AssetTable = JSON.parse(
  readFileSync(join(__dirname, '..', 'assets', 'manifest.json'), 'utf8'),
)

/** Кадр без единого размещения: зона и мир нужны даже пустому кадру. */
const emptyScene: FrameScene = {
  zone: 'greenHill',
  world: 'hills',
  camera: { u: 0, pitch: 0 },
  placements: [],
}

/** Сцена из одних имён ассетов: координаты бюджету безразличны. */
function sceneWith(items: Array<Pick<Placement, 'asset'>>): FrameScene {
  return {
    ...emptyScene,
    placements: items.map((it) => ({ asset: it.asset, x: 0, y: 0, z: 1 })),
  }
}

// ─────────────────────────── инстансирование ────────────────────────────

/**
 * Прошла бы вхолостую? НЕТ. Уберите группировку по имени ассета — и два
 * размещения дадут два вызова вместо одного; это и показано второй строкой:
 * тот же кадр без инстансирования даёт 2.
 */
test('одинаковые ассеты складываются в ОДИН вызов', () => {
  // kelp — один примитив в таблице, поэтому два размещения дают один вызов
  const s = sceneWith([{ asset: 'decor/kelp' }, { asset: 'decor/kelp' }])
  expect(estimate(s, table).calls).toBe(1)
  // Та же сцена БЕЗ инстансирования — два вызова. Без этой половины первая
  // строка зелена и у счётчика, который просто теряет повторы.
  expect(estimateWithoutInstancing(s, table).calls).toBe(2)
})

/**
 * Прошла бы вхолостую? НЕТ, и это её главное свойство: вершины — ровно то
 * место, где «сложил в один вызов» не значит «нарисовал один раз». Счётчик,
 * который сливал бы и вершины, дал бы 8 вместо 16.
 */
test('вершины считаются по ВСЕМ размещениям, а вызовы — по разным ассетам', () => {
  const one = sceneWith([{ asset: 'decor/kelp' }])
  const two = sceneWith([{ asset: 'decor/kelp' }, { asset: 'decor/kelp' }])
  expect(two.placements.length).toBe(2)
  expect(estimate(two, table).verts).toBe(2 * table['decor/kelp'].verts)
  expect(estimate(two, table).verts).toBe(2 * estimate(one, table).verts)
  // А вызов при этом один и тот же — иначе доказано не то.
  expect(estimate(two, table).calls).toBe(estimate(one, table).calls)
})

/**
 * Прошла бы вхолостую? НЕТ. `obstacle/jelly` — ЕДИНСТВЕННЫЙ ассет в таблице
 * с двумя материалами (`docs/art-placeholders.md`, «Что заглушки нарочно
 * делают НЕудобно»), и ронять его сложность запрещено. Счётчик, который
 * считает МЕШИ вместо примитивов, дал бы здесь 1 — то есть соврал бы вниз
 * ровно на сложном арте.
 */
test('а ассет из двух материалов даёт ДВА вызова, сколько бы его ни стояло', () => {
  // иначе бюджет врёт вниз именно на сложном арте: таблица хранит calls на ассет
  const s = sceneWith([{ asset: 'obstacle/jelly' }, { asset: 'obstacle/jelly' }])
  expect(estimate(s, table).calls).toBe(table['obstacle/jelly'].calls)
  // Проверка, что проверено НЕ единицей: у jelly в таблице именно два вызова.
  expect(table['obstacle/jelly'].calls).toBe(2)
})

// ─────────────────────────── отказы и границы ───────────────────────────

/**
 * Прошла бы вхолостую? НЕТ: уберите бросок — и `assets[id]` вернёт
 * `undefined`, сумма станет `NaN`, а бюджет — «всё укладывается» при любом
 * числе. Молчаливый `?? 0` здесь опаснее отказа: имена ассетов — договор
 * трёх задач (`src/render/types.ts`), и разъехавшееся имя обязано падать.
 */
test('неизвестный ассет падает громко', () => {
  expect(() => estimate(sceneWith([{ asset: 'нет такого' }]), table)).toThrow(/нет в таблице/)
})

/**
 * Прошла бы вхолостую? НЕТ, если счёт идёт сложением: пустая сумма по
 * `undefined` даёт `NaN`, а `toEqual` на `NaN` падает. Заодно это
 * ЗАКРЕПЛЯЕТ договор: `estimate` считает то описание, которое ему дали, и
 * постоянную часть кадра сам не добавляет (её вносит `estimateFrame`).
 */
test('пустая сцена даёт нули, а не NaN', () => {
  expect(estimate({ ...emptyScene, placements: [] }, table)).toEqual({
    calls: 0,
    verts: 0,
    texBytes: 0,
  })
})

/**
 * Прошла бы вхолостую? НЕТ. Текстура ассета резидентна ОДИН раз, сколько бы
 * размещений его ни стояло, — счётчик, который умножал бы её на размещения,
 * дал бы вдвое больше и упёрся бы в потолок 96 МБ на пустом месте.
 */
test('текстурная память считается по РАЗНЫМ ассетам, а не по размещениям', () => {
  const two = sceneWith([{ asset: 'decor/kelp' }, { asset: 'decor/kelp' }])
  expect(estimate(two, table).texBytes).toBe(table['decor/kelp'].texBytes)
})

// ──────────────── постоянная часть кадра: коридор и небо ────────────────

/**
 * Прошла бы вхолостую? НЕТ. Это та дыра, которая делает бюджет ложно
 * спокойным: `composeScene` выдаёт только `obstacle/*`, `decor/*` и
 * `star/*`, а пол, стены и небо рисуются КАЖДЫЙ кадр и стоят вызовов.
 * Уберите постоянную часть — и `estimateFrame` совпадёт с `estimate`,
 * то есть сравнение ниже упадёт.
 */
test('постоянная часть кадра — пол, стены и небо ЕГО зоны — входит в бюджет кадра', () => {
  expect(backdropAssets(emptyScene)).toEqual([
    'corridor/floor',
    'corridor/walls',
    'sky/greenHill',
  ])

  const framed = estimateFrame(emptyScene, table)
  const standing =
    table['corridor/floor'].calls + table['corridor/walls'].calls + table['sky/greenHill'].calls
  expect(framed.backdrop.calls).toBe(standing)
  expect(framed.calls).toBe(estimate(emptyScene, table).calls + standing)
  // Небо берётся у ЗОНЫ кадра, а не одно на игру: иначе двенадцать небес
  // попали бы в бюджет разом (`docs/art-placeholders.md`).
  expect(backdropAssets({ ...emptyScene, zone: 'nebula' })).toContain('sky/nebula')
  expect(estimateFrame({ ...emptyScene, zone: 'nebula' }, table).backdrop.texBytes).toBe(
    table['corridor/floor'].texBytes +
      table['corridor/walls'].texBytes +
      table['sky/nebula'].texBytes,
  )
})

/**
 * Прошла бы вхолостую? НЕТ. Зона кадра приходит из `zoneAt` и может приехать
 * синхронизацией новой: неба для неё в таблице не будет, и промолчать здесь
 * значит рисовать кадр без неба, судя его как полный.
 */
test('кадр в зоне без неба падает громко, а не считается без неба', () => {
  expect(() => estimateFrame({ ...emptyScene, zone: 'нетзоны' }, table)).toThrow(/нет в таблице/)
})

// ───────────────────── худший кадр по каждому миру ──────────────────────

/**
 * Прошла бы вхолостую? НЕТ в обеих своих половинах, и это проверено
 * мутацией (запись — в отчёте этапа): убери перебор миров — и три мира из
 * четырёх не попадут в счёт вовсе; убери ступени — и состав кадра верхних
 * уровней не будет посчитан никогда.
 *
 * Снимок ПЕЧАТАЕТ худший кадр и строку «по мирам», а не только сверяет
 * порог: иначе число известно только в момент падения (приём взят у
 * `run-game`, `tests-control.mjs`, группа «бюджет кадра»).
 */
test(
  'худший кадр укладывается в потолок по КАЖДОМУ миру',
  async () => {
    const worlds = Object.keys(WORLDS)
    expect(worlds.length).toBeGreaterThan(1)

    const byWorld: Record<string, Awaited<ReturnType<typeof worstFrame>>> = {}
    for (const world of worlds) byWorld[world] = await worstFrame(world, table)

    const worst = Object.values(byWorld).reduce((a, b) => (b.calls > a.calls ? b : a))
    /* Максимум каждого числа — по ВСЕМ мирам, а не у головного: худший по
       вызовам мир не обязан быть худшим по вершинам или без инстансирования
       (`hills` 15/24, `deep` 14/25). */
    const across = (key: 'callsNoInstancing' | 'verts' | 'texBytes') =>
      Math.max(...Object.values(byWorld).map((w) => w[key]))
    console.log(
      `  худший кадр: ${worst.calls} вызовов при потолке ${CEILING_CALLS}` +
        ` (мир ${worst.world}, зона ${worst.zone}, посев ${worst.seed},` +
        ` ступень ${worst.step}, ${worst.atS.toFixed(1)} с);` +
        ` максимум вершин ${across('verts')},` +
        ` текстур ${(across('texBytes') / 1048576).toFixed(1)} МБ;` +
        ` БЕЗ инстансирования ${across('callsNoInstancing')}`,
    )
    console.log(
      '  по мирам: ' +
        worlds
          .slice()
          .sort((a, b) => byWorld[b].calls - byWorld[a].calls)
          .map((w) => `${w} ${byWorld[w].calls} (без инст. ${byWorld[w].callsNoInstancing})`)
          .join(' · '),
    )

    /*
     * ДВЕ проверки самого перебора, без которых всё ниже вечнозелено.
     *
     * Порог «не больше потолка» — оценка СВЕРХУ, и обмануть её легче всего,
     * посчитав меньше кадров: перебор, который потерял ступени или мерил
     * четыре мира одними холмами, пройдёт порог тем вернее, чем меньше
     * посчитал. Поэтому проверяется и САМ ПЕРЕБОР.
     *
     * 1. Число кадров — ровно посевы × ступени × шаги по времени. Форма
     *    произведения записана ЗДЕСЬ, а множители взяты у их владельцев
     *    (`SEEDS` и шаг — у прогона, `STEP_MAX` — у сложности): потеряй
     *    перебор ступени, и кадров станет впятеро меньше.
     * 2. Миры дают РАЗНЫЕ числа. Если бы `world` не доезжал до генераторов,
     *    все четыре мира дали бы одно и то же — и это не рассуждение:
     *    считано 15 · 14 · 13 · 12, четыре разных числа.
     */
    const framesPerWorld = SEEDS.length * (STEP_MAX + 1) * (DURATION_S / FRAME_STEP_S)
    for (const world of worlds) expect(byWorld[world].frames).toBe(framesPerWorld)
    expect(new Set(worlds.map((w) => byWorld[w].calls)).size).toBeGreaterThan(1)

    for (const world of worlds) {
      const w = byWorld[world]
      // Обратная сторона, без которой порог проходит и пустой кадр: пустой
      // счётчик — это не «уложились», а «ничего не посчитали».
      expect(w.calls).toBeGreaterThan(backdropAssets(emptyScene).length)
      expect(w.calls).toBeLessThan(CEILING_CALLS)
      /* И БЕЗ инстансирования — тем же потолком. Запас, который даёт слияние
         размещений в один вызов, не был замерен до этого этапа, и пока оба
         числа не названы, «укладываемся» держится на честном слове: вывод,
         который забудет инстансировать, уложится или нет — вопрос счёта. */
      expect(w.callsNoInstancing).toBeLessThan(CEILING_CALLS)
      expect(w.verts).toBeLessThan(CEILING_VERTS)
      expect(w.texBytes).toBeLessThanOrEqual(CEILING_TEX_BYTES)
    }

    /*
     * Число, которое ОБЕЩАЕТ документ, сверяется с посчитанным — приём взят у
     * `run-game`, и повод там был буквальный: корень обещал 117, комментарий
     * говорил 116, счётчик давал 113, и две копии из трёх врали. Как только
     * число названо в прозе, у него появляется второй владелец, и единственный
     * способ не дать им разъехаться — сверять.
     *
     * Сверяется ТОЧНЫМ равенством, а не допуском: перебор детерминирован
     * (посевы заданы), значит разошлись числа — изменился кадр, и документ
     * обязан это сказать. Заодно проверяются оба потолка в той же строке:
     * иначе их можно поднять в прозе, не сознавшись нигде.
     *
     * Прошла бы вхолостую? НЕТ: правка любой из четырёх цифр — в документе
     * или в счёте — роняет её, и это проверено мутацией.
     */
    const doc = readFileSync(join(__dirname, '..', 'docs', 'art-placeholders.md'), 'utf8')
    const promised = doc.match(/\*\*(\d+) при потолке (\d+) и мягком рубеже (\d+)\*\*/)
    expect(promised, 'строка «**N при потолке M и мягком рубеже K**» в docs/art-placeholders.md')
      .not.toBeNull()
    const [, said, ceiling, soft] = promised!.map(Number)
    expect(said).toBe(worst.calls)
    expect(ceiling).toBe(CEILING_CALLS)
    expect(soft).toBe(SOFT_CALLS)
    // И число БЕЗ инстансирования: ровно та прикидка, которая оказалась
    // неверной, поэтому она обязана остаться сверяемой, а не стать прозой.
    const promisedNoInst = doc.match(/Посчитано \*\*(\d+)\*\*/)
    expect(promisedNoInst, 'строка «Посчитано **N**» в docs/art-placeholders.md').not.toBeNull()
    expect(Number(promisedNoInst![1])).toBe(across('callsNoInstancing'))
  },
  600_000,
)

/**
 * Потолки записаны ЗАРАНЕЕ и задним числом не правятся (CLAUDE.md, спека).
 * Прошла бы вхолостую? НЕТ: подними `CEILING_CALLS` в `estimate.ts` под
 * полученный результат — и упадёт здесь, назвав обе стороны.
 */
test('потолки — те, что записаны заранее', () => {
  const spec = readFileSync(
    join(__dirname, '..', 'docs', 'superpowers', 'specs', '2026-10-21-architecture.md'),
    'utf8',
  )
  expect(spec).toMatch(/\*\*< 150\*\*, мягкий рубеж 100/)
  expect(spec).toMatch(/\*\*< 100 000\*\*/)
  expect(spec).toMatch(/\*\*≤ 96 МБ\*\*/)
  expect(CEILING_CALLS).toBe(150)
  expect(SOFT_CALLS).toBe(100)
  expect(CEILING_VERTS).toBe(100_000)
  expect(CEILING_TEX_BYTES).toBe(96 * 1024 * 1024)
})
