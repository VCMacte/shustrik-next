/**
 * Спайк: четыре прогона, журнал и пути MediaPipe.
 *
 * Весь проект построен ради одного числа — `gap95` при живых позах, — и
 * снимается оно журналом. Журнал обязан читаться разбором `run-game`
 * (`tools/log-report.mjs`) БЕЗ правок разборщика: иначе числа спайка не
 * сопоставятся с базовой линией 21 октября, и замер потеряет смысл.
 *
 * Поэтому здесь зовётся НАСТОЯЩИЙ `report` из соседнего репозитория, а не его
 * пересказ, и журнал приходит к нему НАСТОЯЩИМ путём записи: `log.event` →
 * `log.flush` → `log.save`, то есть ровно тем файлом, который человек
 * выгрузит с телефона. Подделанный журнал в этом тесте сделал бы его пустым:
 * он проверял бы согласие теста с самим собой.
 */
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { beforeAll, expect, test } from 'vitest'

const ROOT = join(__dirname, '..')

/** Разбор журнала у соседа. Путь один и тот же у всех — репозитории рядом. */
const LOG_REPORT = resolve(ROOT, '..', 'run-game', 'tools', 'log-report.mjs')

// ─────────────────── стенд: браузерная обвязка журнала ───────────────────

/*
 * `src/core/log.js` — побайтовая копия, и трогать её нельзя. Она живёт в
 * браузере: IndexedDB для хранения и `<a download>` для выгрузки. В `node`
 * ни того, ни другого нет, поэтому здесь стоит МИНИМАЛЬНАЯ подмена САМОГО
 * БРАУЗЕРА — не журнала.
 *
 * Разница принципиальная. Подменив журнал, тест проверял бы собственную
 * выдумку: схлопывание повторов в `_n`/`_lastT`, конверт `{t, type, ...}` и
 * форма выгруженного файла — всё это живёт в `log.js`, и именно на это
 * рассчитывает разборщик. Подменив браузер, мы оставляем настоящим весь путь
 * записи и теряем только то, чего в `node` не бывает.
 */

type Row = Record<string, unknown>

/** Хранилище одного объектного стора: строки, ключ и автоинкремент. */
type Store = {
  keyPath: string
  autoIncrement: boolean
  seq: number
  rows: Map<unknown, Row>
  indexes: Map<string, string>
}

function makeIndexedDbStub() {
  const stores = new Map<string, Store>()

  const request = <T>(run: () => T) => {
    const req: any = { onsuccess: null, onerror: null, result: undefined }
    queueMicrotask(() => {
      try {
        req.result = run()
        req.onsuccess?.()
      } catch (e) {
        req.error = e
        req.onerror?.()
      }
    })
    return req
  }

  function storeApi(name: string, tx: any) {
    const st = stores.get(name)!
    const api = {
      add(value: Row) {
        tx.touch()
        const key = st.autoIncrement ? ++st.seq : value[st.keyPath]
        st.rows.set(key, st.autoIncrement ? { ...value, [st.keyPath]: key } : value)
      },
      put(value: Row) {
        tx.touch()
        st.rows.set(value[st.keyPath], value)
      },
      get(key: unknown) {
        tx.touch()
        return request(() => st.rows.get(key))
      },
      getAll() {
        tx.touch()
        return request(() => [...st.rows.values()])
      },
      delete(key: unknown) {
        tx.touch()
        st.rows.delete(key)
      },
      clear() {
        tx.touch()
        st.rows.clear()
      },
      index(indexName: string) {
        const keyPath = st.indexes.get(indexName)!
        return {
          openKeyCursor(range: { only: unknown }) {
            tx.touch()
            const keys = [...st.rows.entries()]
              .filter(([, row]) => row[keyPath] === range.only)
              .map(([k]) => k)
            let i = 0
            const req: any = { onsuccess: null, onerror: null, result: null }
            const step = () => {
              if (i >= keys.length) {
                req.result = null
                req.onsuccess?.()
                return
              }
              req.result = { primaryKey: keys[i++], continue: () => queueMicrotask(step) }
              req.onsuccess?.()
            }
            queueMicrotask(step)
            return req
          },
        }
      },
    }
    return api
  }

  function transaction(names: string | string[]) {
    void names
    const tx: any = { oncomplete: null, onerror: null, onabort: null }
    let pending = 0
    let settled = false
    tx.touch = () => {
      pending++
      setTimeout(() => {
        pending--
        if (pending === 0 && !settled) {
          settled = true
          tx.oncomplete?.()
        }
      }, 0)
    }
    tx.objectStore = (name: string) => storeApi(name, tx)
    tx.touch()
    return tx
  }

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string, opts: { keyPath: string; autoIncrement?: boolean }) {
      const st: Store = {
        keyPath: opts.keyPath,
        autoIncrement: !!opts.autoIncrement,
        seq: 0,
        rows: new Map(),
        indexes: new Map(),
      }
      stores.set(name, st)
      return { createIndex: (n: string, keyPath: string) => st.indexes.set(n, keyPath) }
    },
    transaction,
  }

  return {
    open() {
      const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null, result: db }
      queueMicrotask(() => {
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
}

/** Содержимое файла, который `log.save()` отдал бы на скачивание. */
let savedBlob: Blob | null = null
/* Через функцию, а не напрямую: присваивание ниже видно потоку управления
   TypeScript, а запись из подменённого `createObjectURL` — нет, и чтение
   поля сужалось бы до `null`. */
const takeSavedBlob = (): Blob | null => savedBlob

function installBrowserStubs() {
  const g = globalThis as any
  g.indexedDB = makeIndexedDbStub()
  g.IDBKeyRange = { only: (v: unknown) => ({ only: v }) }
  /* Перехват ровно в той точке, где браузер получает ФАЙЛ. Дальше идёт
     `a.click()`, которого в node нет, — и пусть бросает: `download()` ловит
     и честно вернёт `saved: false`. Зато содержимое файла у нас настоящее,
     собранное самим `log.js`, а не пересобранное тестом. */
  const realCreateObjectURL = URL.createObjectURL
  URL.createObjectURL = ((blob: Blob) => {
    savedBlob = blob
    return 'blob:spike-test'
  }) as typeof realCreateObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  g.document = {
    createElement: () => ({
      href: '',
      download: '',
      click() {
        throw new Error('в node настоящей загрузки нет — файл уже перехвачен')
      },
    }),
  }
}

// ─────────────────────────── действующие лица ───────────────────────────

type SpikeModule = typeof import('../src/shell/spike')
type PosePathsModule = typeof import('../src/adapters/pose-paths')

let spike: SpikeModule
let posePathsModule: PosePathsModule
let log: typeof import('../src/core/log.js')
let report: (session: unknown) => any

beforeAll(async () => {
  installBrowserStubs()
  spike = await import('../src/shell/spike')
  posePathsModule = await import('../src/adapters/pose-paths')
  log = await import('../src/core/log.js')
  if (!existsSync(LOG_REPORT)) {
    throw new Error(
      `разбор run-game не найден: ${LOG_REPORT}. `
        + 'Без него проверка «журнал читается разбором run-game» невозможна.',
    )
  }
  ;({ report } = (await import(LOG_REPORT.split(sep).join('/'))) as any)
})

/**
 * Выгружает журнал НАСТОЯЩИМ путём (`log.save`) и отдаёт разобранный файл.
 *
 * Форма — та, которую ждёт разборщик: `{ sessions: [{ id, startedAt, ua,
 * log: [...] }] }`. Собирает её `log.js`, не тест.
 */
async function exportedDump(): Promise<any> {
  savedBlob = null
  await log.save()
  const blob = takeSavedBlob()
  if (!blob) throw new Error('log.save() не отдал файл')
  return JSON.parse(await blob.text())
}

// ───────────────────────────── сами проверки ─────────────────────────────

test('разбор run-game читает наш журнал', async () => {
  /* Окна здоровья пишет НАСТОЯЩИЙ накопитель страницы спайка: имена полей и
     способ счёта живут там, а не здесь. Кадры ровные по 33 мс — значит
     `gap95` каждого окна равен 33, и медиана окон тоже 33. */
  const health = spike.makeHealth(() => ({ calls: 120, verts: 90_000 }), 0)
  let now = 0
  for (let window = 0; window < 3; window++) {
    for (let i = 0; i < 30; i++) {
      now += 33
      health.frame(now)
      /* Позы идут вдвое реже кадров: 15 Гц при инференсе 40 мс — та самая
         пара, ради которой спайк и затевался. */
      if (i % 2 === 0) health.pose({ inferMs: 40, dropped: 0, lm: new Float32Array(132) })
    }
    health.flush(now, 'both')
  }

  const dump = await exportedDump()
  expect(dump.sessions).toHaveLength(1)
  const rep = report(dump.sessions[0])

  // Ровность хода — то самое число, ради которого всё.
  expect(rep.perf.gap.med).toBe(33)
  /* Остальные имена проверяются рядом не для полноты: разборщик читает
     КАЖДОЕ по имени, и переименуй мы `p50` или `hz` — `gap.med` остался бы
     тридцатью тремя, а замер стал бы наполовину слепым. */
  expect(rep.perf.infer.med).toBe(40)
  expect(rep.perf.hz.med).toBe(15)
  expect(rep.perf.fps.med).toBe(30)
  expect(rep.perf.drop).toBe(0)
  expect(rep.perf.windows).toBe(3)
})

test('живой счёт кадра едет в журнал рядом с ровностью', async () => {
  const health = spike.makeHealth(() => ({ calls: 121, verts: 91_000 }), 0)
  let now = 0
  for (let i = 0; i < 30; i++) {
    now += 33
    health.frame(now)
  }
  health.flush(now, 'both')

  const dump = await exportedDump()
  const windows = dump.sessions[0].log.filter((e: any) => e.type === 'health')
  expect(windows.at(-1)).toMatchObject({ calls: 121, verts: 91_000 })
  // И разбор при этом не спотыкается о незнакомые поля.
  expect(report(dump.sessions[0]).perf.gap.med).toBe(33)
})

test('четыре прогона различимы в журнале', async () => {
  /* Прогоняется ТОТ ЖЕ список адресов, из которого страница строит кнопки
     (`SPIKE_RUNS`), — иначе «поменяли строку в boot(), всё осталось
     зелёным» было бы возможно. Самосверки здесь не возникает: сверяются
     АДРЕСА с ИМЕНАМИ, записанными литералом, а не список со списком. */
  for (const search of spike.SPIKE_RUNS) {
    spike.noteRunStart(spike.runFromQuery(search))
  }

  const dump = await exportedDump()
  const runs = dump.sessions[0].log
    .filter((e: any) => e.type === 'run.start')
    .map((e: any) => `${e.what}/${e.delegate}`)
  expect(runs).toEqual(['scene/-', 'pose/gpu', 'both/gpu', 'both/cpu'])
})

test('адрес без параметров даёт полный прогон на видеоядре', () => {
  expect(spike.runFromQuery('')).toEqual({ what: 'both', delegate: 'gpu' })
  // Мусор не должен молча превращаться в прогон, которого человек не просил.
  expect(() => spike.runFromQuery('?what=всё')).toThrow()
  expect(() => spike.runFromQuery('?what=both&delegate=npu')).toThrow()
})

test('пути MediaPipe перекрыты сборкой, а не копией config', async () => {
  const { posePaths } = posePathsModule
  const { VENDOR } = await import('../src/core/config.js')

  expect(posePaths().wasm).not.toMatch(/vendor\//)
  expect(posePaths().bundleClassic).not.toMatch(/vendor\//)
  expect(posePaths().model).not.toMatch(/vendor\//)

  /* Главное здесь — именно ПЕРЕКРЫТИЕ: копия `config.js` осталась нетронутой
     и по-прежнему указывает в `vendor/`, а страница спайка берёт другое. */
  expect(VENDOR.wasmBase).toMatch(/vendor\//)
  expect(posePaths().wasm).not.toBe(VENDOR.wasmBase)
  expect(posePaths().bundleClassic).not.toBe(VENDOR.bundleClassic)
  expect(posePaths().model).not.toBe(VENDOR.model)

  // База страницы — чтобы воркер не разрешал путь от собственного каталога.
  const abs = posePaths('https://phone.local/shustrik/')
  expect(abs.wasm).toBe('https://phone.local/shustrik/mediapipe/wasm')
  expect(abs.model).toBe('https://phone.local/shustrik/models/pose_landmarker_lite.task')
})

test('файлы, на которые указывают пути, вправду лежат на диске', () => {
  const { MEDIAPIPE_FILES, MEDIAPIPE_BUNDLE_ENTRY, MODEL_FILE } = posePathsModule
  const pkg = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision')

  expect(Object.keys(MEDIAPIPE_FILES).length).toBeGreaterThan(0)
  for (const [published, source] of Object.entries(MEDIAPIPE_FILES)) {
    expect(published).not.toMatch(/vendor\//)
    expect(existsSync(join(pkg, source))).toBe(true)
  }
  // Классическую сборку делает esbuild из модульной — её вход тоже реален.
  expect(existsSync(join(pkg, MEDIAPIPE_BUNDLE_ENTRY))).toBe(true)
  /* Модели `.task` в пакете нет вовсе, и без неё позы на телефоне не поедут.
     Она лежит в `public/` и коммитится — решение записано в отчёте этапа. */
  expect(existsSync(join(ROOT, 'public', MODEL_FILE))).toBe(true)
})

test('воркер позы получает пути сборки, а не VENDOR из копии', async () => {
  const { VENDOR } = await import('../src/core/config.js')
  const init = spike.poseInit({ what: 'both', delegate: 'cpu' }, 'https://phone.local/shustrik/')

  expect(init.type).toBe('init')
  expect(init.delegate).toBe('CPU')
  expect(init.wasmBase).toBe('https://phone.local/shustrik/mediapipe/wasm')
  expect(init.modelUrl).toBe('https://phone.local/shustrik/models/pose_landmarker_lite.task')
  expect(init.bundleUrl).not.toBe(VENDOR.bundleClassic)
  expect(init.wasmBase).not.toBe(VENDOR.wasmBase)
  // Путь до упаковщика точек обязан вести в копию логики, а не в чужую.
  expect(init.packUrl).toMatch(/core\/pose\.pack\.js$/)

  expect(spike.poseInit({ what: 'pose', delegate: 'gpu' }, 'https://x/').delegate).toBe('GPU')
})

test('кнопки страницы ведут ровно в четыре прогона замера', () => {
  /* Имена — литералом, адреса — из владельца. Разъехались бы они молча:
     `?what=pose` без делегата дал бы `pose/gpu` и выглядел бы правильно, а
     строка таблицы «поза на процессоре» исчезла бы из замера. */
  expect(spike.SPIKE_RUNS.map((s) => spike.runName(spike.runFromQuery(s))))
    .toEqual(['scene/-', 'pose/gpu', 'both/gpu', 'both/cpu'])
})

test('первое окно считается от начала прогона, а не от загрузки страницы', () => {
  /* Страница загрузилась давно: на старте прогона `performance.now()` — сто
     секунд. Если бы окно считалось от нуля, span первого окна вышел бы в
     сто секунд, и `fps`/`hz` занизились бы в разы — а разбор берёт у
     прогона именно `min`, то есть «худшее» стало бы мусором. */
  const t0 = 100_000
  const health = spike.makeHealth(() => ({ calls: 7, verts: 7 }), t0)
  const window = (from: number): Record<string, number | string> => {
    let now = from
    for (let i = 0; i < 30; i++) {
      now += 33
      health.frame(now)
      health.pose({ inferMs: 40, dropped: 0, lm: new Float32Array(132) })
    }
    return health.flush(now, 'both')!
  }

  const first = window(t0)
  expect(first.fps).toBe(30)
  expect(first.hz).toBe(30)
  // Второе окно считается от конца первого — и обязано совпасть с первым.
  const second = window(t0 + 30 * 33)
  expect(second.fps).toBe(first.fps)
  expect(second.hz).toBe(first.hz)
})

test('забег спайка — тот же, что перебирает бюджет', async () => {
  /* `makeRun` в `spike.ts` и `runOf` в `tools/budget.mjs` — две записи
     одного порядка вызовов генераторов: все трое тянут из одного `rng`, и
     перестановка дала бы другой забег при том же посеве. Общего владельца
     завести не вышло (`budget.mjs` живёт в node и тянет `node:fs`), поэтому
     совпадение сторожится здесь, а не договорённостью. Разъедутся — спайк
     начнёт мерить кадр, которого бюджет не считал. */
  const { runOf } = await import('../tools/budget.mjs')
  const mine = spike.makeRun(1, 'city', 1)
  const theirs = runOf('city', 1, 1)
  expect(mine.obstacles).toEqual(theirs.obstacles)
  expect(mine.stars).toEqual(theirs.stars)
  expect(mine.decor).toEqual(theirs.decor)
  expect(mine.obstacles.length).toBeGreaterThan(0)
  expect(mine.decor.length).toBeGreaterThan(0)
})

test('сборка вправду кладёт файлы MediaPipe туда, куда указывают пути', async () => {
  /* Без этой проверки `pose-paths.ts` — просто строки: пути были бы красивы,
     а по ним на телефоне лежало бы пусто. Здесь спрашивается сам плагин
     сборки, тот же самый, что стоит в `vite.config.ts`. */
  const { mediapipeSource } = posePathsModule
  for (const published of Object.keys(posePathsModule.MEDIAPIPE_FILES)) {
    expect(mediapipeSource(`/${published}`)).not.toBeNull()
  }
  expect(mediapipeSource('/mediapipe/vision_bundle.js')).toBe('bundle')
  expect(mediapipeSource('/index.html')).toBeNull()
  expect(mediapipeSource('/mediapipe/wasm')).toBeNull()
})
