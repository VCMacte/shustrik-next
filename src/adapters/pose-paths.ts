/**
 * Пути к файлам MediaPipe — ИЗ СБОРКИ, а не из копии `config.js`.
 *
 * Зачем отдельный модуль. `src/core/config.js` — побайтовая копия логики
 * `run-game`, и править её нельзя (манифест хешей, `tools/sync-logic.mjs`).
 * А её `VENDOR` указывает в `vendor/mediapipe/…` — каталог, которого в этом
 * проекте нет и заводить который не за чем: `@mediapipe/tasks-vision` стоит
 * пакетом, и девятнадцать мегабайт, скопированных в репозиторий второй
 * раз, разъехались бы с пакетом в первое же обновление.
 *
 * Поэтому пути ПЕРЕКРЫВАЮТСЯ здесь, а копия остаётся нетронутой. Воркер
 * `src/core/pose.worker.js` это допускает без единой правки: он получает
 * `wasmBase`, `bundleUrl`, `packUrl` и `modelUrl` сообщением `init`, а
 * вписаны они в сообщение только в `pose.camera.js`. Страница спайка
 * собирает это сообщение сама (`spike.ts`, `poseInit`).
 *
 * Файлы в сборку кладёт плагин `mediapipeFromBuild()` из `vite.config.ts`, и
 * список у них ОДИН — тот, что ниже. Вторая копия списка означала бы путь,
 * ведущий туда, где файла нет, и выяснилось бы это молчаливым отказом
 * внутри wasm на телефоне.
 */

/** Пакет, из которого всё берётся. Версия закреплена в `package.json`. */
export const MEDIAPIPE_PACKAGE = '@mediapipe/tasks-vision'

/** Куда сборка кладёт файлы MediaPipe, относительно корня сайта. */
export const MEDIAPIPE_DIR = 'mediapipe'

/**
 * Что копируется из пакета как есть: `опубликованный путь` → `путь в пакете`.
 *
 * Вариант без SIMD кладётся тоже, и это не щедрость. Загрузчик сам решает,
 * какое имя попросить (`vision_wasm_internal.js` при поддержке SIMD,
 * `vision_wasm_nosimd_internal.js` без неё), и отсутствующий файл он не
 * объявляет — он молча не заводится. Пакет уже на диске, место занимает
 * только сборка, и лишние десять мегабайт дешевле одного такого вечера.
 */
export const MEDIAPIPE_FILES: Record<string, string> = {
  [`${MEDIAPIPE_DIR}/wasm/vision_wasm_internal.js`]: 'wasm/vision_wasm_internal.js',
  [`${MEDIAPIPE_DIR}/wasm/vision_wasm_internal.wasm`]: 'wasm/vision_wasm_internal.wasm',
  [`${MEDIAPIPE_DIR}/wasm/vision_wasm_nosimd_internal.js`]: 'wasm/vision_wasm_nosimd_internal.js',
  [`${MEDIAPIPE_DIR}/wasm/vision_wasm_nosimd_internal.wasm`]: 'wasm/vision_wasm_nosimd_internal.wasm',
}

/**
 * Классическая (IIFE) сборка библиотеки — её в пакете НЕТ, там только `.mjs`
 * и `.cjs`. А воркер обязан быть классическим: MediaPipe выполняет свой
 * wasm-загрузчик через `importScripts`, которого в модульном воркере не
 * существует, и падает там с «ModuleFactory not set» (проверено соседом,
 * `pose-game/src/adapters/pose/worker.ts`).
 *
 * Поэтому IIFE собирается из модульной сборки на лету, esbuild'ом, который и
 * так стоит внутри Vite. Сосед держит такой файл в репозитории руками —
 * здесь он получается из пакета, то есть не умеет разойтись с ним по версии.
 */
export const MEDIAPIPE_BUNDLE_ENTRY = 'vision_bundle.mjs'
export const MEDIAPIPE_BUNDLE_GLOBAL = 'Vision'
export const MEDIAPIPE_BUNDLE = `${MEDIAPIPE_DIR}/vision_bundle.js`

/**
 * Модель поз. Единственный файл конвейера, которого нет ни в одном пакете:
 * `@mediapipe/tasks-vision` поставляет рантайм, но не веса. Поэтому
 * `pose_landmarker_lite.task` лежит в `public/` и коммитится — так же, как у
 * соседа `pose-game`, и по той же причине: без него позы на телефоне не
 * поедут вовсе, а скачивать 5.8 МБ по сети посреди замера нельзя.
 */
export const MODEL_FILE = 'models/pose_landmarker_lite.task'

/** Пути, которыми пользуется страница спайка. */
export type PosePaths = {
  /** Каталог для `FilesetResolver.forVisionTasks()`. */
  wasm: string
  /** Классическая сборка для `importScripts` в воркере. */
  bundleClassic: string
  /** Общая с воркером упаковка точек — копия логики, не вендор. */
  pack: string
  /** Веса модели. */
  model: string
}

/**
 * База, от которой пути становятся абсолютными.
 *
 * Абсолютными они быть ОБЯЗАНЫ, и это не стиль (тот же довод записан в
 * `config.js`): загрузчик wasm разрешает относительный путь от базы ТОГО
 * контекста, где работает, а работает он в воркере, лежащем в `src/core/`.
 * Строка `mediapipe/wasm` указала бы оттуда в `src/core/mediapipe/wasm`, то
 * есть в никуда.
 *
 * Вне браузера базы нет и выдумывать её нельзя: пути остаются
 * относительными — ровно такими, какими их сверяют тесты.
 */
function pageBase(): string {
  return typeof document !== 'undefined' ? document.baseURI : ''
}

export function posePaths(base: string = pageBase()): PosePaths {
  const at = (path: string) => (base ? new URL(path, base).href : path)
  return {
    wasm: at(`${MEDIAPIPE_DIR}/wasm`),
    bundleClassic: at(MEDIAPIPE_BUNDLE),
    /* Упаковка точек — наш собственный модуль, и его адрес знает сборщик, а
       не мы: `new URL(..., import.meta.url)` Vite разрешает сам и в `dev`, и
       в собранном виде. Базы страницы здесь нет намеренно — файл лежит не
       рядом с `mediapipe/`, а там, куда его положит сборка. */
    pack: new URL('../core/pose.pack.js', import.meta.url).href,
    model: at(MODEL_FILE),
  }
}

/**
 * Что отдать на запрос `url`, если это файл MediaPipe.
 *
 * Возвращает путь внутри пакета, особое значение `'bundle'` для классической
 * сборки (её надо собрать, а не прочитать) или `null`, если запрос не наш.
 *
 * Живёт здесь, а не в `vite.config.ts`, ровно затем, чтобы соответствие
 * «путь ↔ файл» проверялось прогоном: иначе `pose-paths.ts` был бы набором
 * красивых строк, по которым на телефоне лежит пусто.
 */
export function mediapipeSource(url: string): string | null {
  /* Выхода за пределы каталога здесь быть не может, и проверки на `..`
     поэтому нет: соответствие ищется ТОЧНЫМ ключом в таблице, а не
     склейкой путей. Проверка стояла и была снята — она не падала ни на
     одной подмене, то есть была украшением, а не сторожем. */
  const path = url.split('?')[0].replace(/^\/+/, '')
  if (path === MEDIAPIPE_BUNDLE) return 'bundle'
  return MEDIAPIPE_FILES[path] ?? null
}
