import { readFileSync } from 'node:fs'
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

export default defineConfig({
  root: '.',
  plugins: [mediapipeFromBuild()],
  build: {
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
