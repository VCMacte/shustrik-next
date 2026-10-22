import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

import {
  MEDIAPIPE_BUNDLE,
  MEDIAPIPE_BUNDLE_ENTRY,
  MEDIAPIPE_BUNDLE_GLOBAL,
  MEDIAPIPE_FILES,
  MEDIAPIPE_PACKAGE,
  mediapipeSource,
} from './src/adapters/pose-paths'

const require = createRequire(import.meta.url)
const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * Каталог установленного пакета — спрашивается у резолвера, не выдумывается.
 *
 * Через главный вход, а не через `package.json`: его карта `exports`
 * подпуть `./package.json` не выпускает, и спросить о нём нельзя.
 */
function packageDir(): string {
  return dirname(require.resolve(MEDIAPIPE_PACKAGE))
}

/**
 * Файлы MediaPipe — В СБОРКУ, а не в репозиторий.
 *
 * Сосед (`pose-game`) держит те же девятнадцать мегабайт закоммиченными в
 * `public/vendor/`, и копия там успела разойтись с пакетом: IIFE-сборка
 * собрана руками когда-то и из `package.json` больше не выводится. Здесь всё
 * берётся из установленного пакета — разойтись не с чем.
 *
 * Классическая (IIFE) сборка собирается на лету: в пакете её нет (только
 * `.mjs` и `.cjs`), а воркеру нужна именно она — модульный воркер не умеет
 * `importScripts`, и MediaPipe падает в нём с «ModuleFactory not set».
 * Собирается esbuild'ом, который уже стоит внутри Vite.
 *
 * Имена файлов фиксированные, без хеша, и это обязательно: загрузчик wasm
 * достраивает имя сам (`${base}/vision_wasm_internal.js`), и хешированное
 * имя он не найдёт.
 */
function mediapipeFromBuild(): Plugin {
  let bundle: Promise<string> | null = null

  /** IIFE-сборка библиотеки. Считается один раз на процесс. */
  function classicBundle(): Promise<string> {
    if (bundle) return bundle
    bundle = (async () => {
      const esbuild = await import('esbuild')
      const out = await esbuild.build({
        entryPoints: [join(packageDir(), MEDIAPIPE_BUNDLE_ENTRY)],
        bundle: true,
        format: 'iife',
        globalName: MEDIAPIPE_BUNDLE_GLOBAL,
        minify: true,
        legalComments: 'none',
        write: false,
      })
      return out.outputFiles[0].text
    })()
    return bundle
  }

  /** Содержимое опубликованного файла: либо из пакета, либо собранное. */
  async function contentOf(published: string): Promise<Buffer | string | null> {
    const source = mediapipeSource(published)
    if (source === null) return null
    if (source === 'bundle') return classicBundle()
    return readFileSync(join(packageDir(), source))
  }

  return {
    name: 'mediapipe-from-build',

    /* В `dev` файлы отдаются посредником прямо из пакета: копировать
       девятнадцать мегабайт в `public/` ради `npm run dev` незачем. */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        void (async () => {
          const body = await contentOf(url)
          if (body === null) {
            next()
            return
          }
          res.setHeader('Content-Type', url.endsWith('.wasm')
            ? 'application/wasm'
            : 'text/javascript')
          res.end(body)
        })().catch(next)
      })
    },

    /* В сборке — настоящими файлами с теми же именами. */
    async generateBundle() {
      for (const published of [...Object.keys(MEDIAPIPE_FILES), MEDIAPIPE_BUNDLE]) {
        const body = await contentOf(`/${published}`)
        if (body === null) throw new Error(`нечего положить в ${published}`)
        this.emitFile({
          type: 'asset',
          fileName: published,
          source: typeof body === 'string' ? body : new Uint8Array(body),
        })
      }
    },
  }
}

/** Каталог ассетов комплекта. Тот же, из которого считает `asset-stat.mjs`. */
const ASSETS_DIR = 'assets'

/** Все файлы под `dir`, путями относительно корня проекта, через `/`. */
function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(HERE, dir)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (statSync(join(HERE, dir, entry)).isDirectory()) {
      out.push(...filesUnder(`${dir}/${entry}`, rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

/**
 * Комплект ассетов — В СБОРКУ.
 *
 * Без этого `dist/` не содержал ни одного `.glb`: вывод грузит их по
 * `assets/<id>.glb` от корня сайта, а корневой `assets/` не лежит в
 * `public/` и сам собой никуда не копируется. В `npm run dev` этого не
 * видно — там Vite отдаёт файлы прямо от корня проекта, и коридор
 * рисуется. Ломается ровно то, что человек повезёт к штативу: собранная
 * страница падает 404 на первом же `loadAsync`, и все четыре прогона
 * говорят «не запустился».
 *
 * Выбран перенос В СБОРКУ, а не «раздавать корень проекта». Вторая
 * возможность дешевле на одну строку инструкции, но собранная страница
 * обязана быть САМОДОСТАТОЧНОЙ: она уезжает на телефон целиком, без
 * `node_modules` и без исходников, и страница, работающая только из
 * дерева разработки, — ловушка того же рода, что и пройденная.
 *
 * `publicDir` для этого не годится: он один, и его уже некуда двигать —
 * там лежит модель поз, которой в пакетах нет. Имена при переносе
 * сохраняются дословно: загрузчик достраивает путь к текстуре сам, из
 * `uri` внутри `.glb` (`../tex/<...>.png`), и хешированное имя он не
 * найдёт — та же причина, что у файлов MediaPipe выше.
 */
function bundleAssets(): Plugin {
  return {
    name: 'bundle-assets',
    generateBundle() {
      const files = filesUnder(ASSETS_DIR)
      if (!files.length) throw new Error('комплект ассетов пуст: нечего класть в сборку')
      for (const rel of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${ASSETS_DIR}/${rel}`,
          source: new Uint8Array(readFileSync(join(HERE, ASSETS_DIR, rel))),
        })
      }
    },
  }
}

export default defineConfig({
  root: '.',
  plugins: [mediapipeFromBuild(), bundleAssets()],
  build: {
    /* Свои чанки — в `build/`, а не в `assets/`. По умолчанию Vite кладёт
       их туда же, куда переносится комплект арта, и однажды имя совпало бы
       молча. Разные каталоги снимают этот класс целиком. */
    assetsDir: 'build',
    rollupOptions: {
      /* Две страницы: игра и спайк. Спайк — не часть игры и в неё не ведёт:
         это измерительный стенд, который уедет вместе с развилкой. */
      input: {
        index: resolve(HERE, 'index.html'),
        spike: resolve(HERE, 'spike.html'),
      },
    },
  },
})
