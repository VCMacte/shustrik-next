# Скелет, общий слой и спайк — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** довести проект до ответа на единственную открытую развилку — полное
3D или 2.5D, — построив общий слой так, что ответ меняет только способ вывода.

**Architecture:** дирижёр из `run-game` отдаёт `RunState`; чистая
`composeScene` превращает его в `FrameScene` — список размещений без единого
упоминания three.js; трёхмерный вывод разворачивает описание в граф three.js, а
`estimate` считает по тому же описанию худший кадр в `node`, без GPU. Логика
копируется побайтово и сторожится хешами.

**Tech Stack:** Vite + TypeScript + Vitest, three.js, `@mediapipe/tasks-vision`;
логика — копии `.js` из `run-game` под `allowJs`.

**Spec:** [`../specs/2026-10-21-architecture.md`](../specs/2026-10-21-architecture.md)

## Global Constraints

- Установка зависимостей только так: `npm ci --maxsockets 4 --no-audit --no-fund`, и когда ничего другого не работает.
- `src/core/**` и `src/render/compose.ts` не импортируют `three` — ни прямо, ни транзитивно.
- `src/core/**` — побайтовые копии из `run-game`; перевод на TypeScript запрещён, правка здесь запрещена.
- Потолки: вызовы отрисовки в кадре < 150 (мягкий рубеж 100), вершины < 100 000, текстурная память ≤ 96 МБ, офлайн-комплект ≤ 100 МБ.
- Порог спайка (записан заранее, менять задним числом нельзя): `gap95` ≤ 40 мс И частота поз ≥ 10 Гц И доля пауз ноль.
- Версия `three` пинуется точным числом в `package.json` (`npm view three version` на момент установки) и называется в спеке.
- Набор печатает ЧИСЛО проверок: «всё сошлось» при нуле новых проверок выглядит так же, как при восьми.
- Числа игры, заданные во времени, в метры не переводятся (правило `run-game`: у каждого уровня своя скорость).

## Review Focus

- **`.glb` с несколькими примитивами или материалами на меш:** счёт вызовов обязан считать их отдельно, иначе бюджет врёт вниз именно на сложных ассетах. → Task 4.
- **Ассет, которого нет в таблице:** `estimate` обязан падать громко; «нет записи — ноль вершин» делает бюджет тем оптимистичнее, чем больше в сцене нового арта. → Task 5.
- **Пустая сцена** (первый кадр забега, пауза, финиш): `estimate` и вывод не вправе давать `NaN` или падать — у ребёнка это чёрный экран на старте. → Task 5.
- **Потеря контекста WebGL:** Chrome на этом телефоне выгружает контекст; без пересборки вывода ребёнок видит чёрный экран до перезапуска. → Task 6.
- **Устройство без ASTC/ETC2:** `KTX2Loader.detectSupport` обязан дать откат на несжатую текстуру, иначе арт молча не грузится. → Task 6.

---

### Task 1: Скелет и сторож развилки

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `index.html`, `src/shell/main.ts`
- Test: `tests/guards.test.ts`

**Interfaces:**
- Produces: скрипты `npm test` (typecheck + vitest), `npm run dev`, `npm run budget`; `vitest.config.ts` с `poolOptions.forks.maxForks: 4` — потолок параллельности живёт в конфиге, а не в командной строке, иначе он не действует у husky и в CI.

- [ ] **Step 1: Написать падающий сторож развилки**

```ts
// tests/guards.test.ts
import { readFileSync, readdirSync } from 'node:fs';
test('core и compose не знают про three', () => {
  for (const f of sourcesUnder(['src/core', 'src/render/compose.ts'])) {
    expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+['"]three/);
  }
});
test('логика не переведена на TypeScript', () => {
  expect(readdirSync('src/core').every((f) => f.endsWith('.js'))).toBe(true);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test`
Expected: FAIL — `src/core` не существует.

- [ ] **Step 3: Создать скелет**

`package.json` с зависимостями `three` (точная версия) и
`@mediapipe/tasks-vision@^0.10.17`, devDeps как в соседнем `pose-game`
(typescript, vite, vitest, @types/node). `tsconfig.json`: `allowJs: true`,
`checkJs: false`, `strict: true`. `src/core/.gitkeep` — папка должна
существовать до Task 2, иначе сторож нечего сторожить.

- [ ] **Step 4: Поставить зависимости**

Run: `npm ci --maxsockets 4 --no-audit --no-fund`
Expected: установка прошла; ничего другого в это время не запущено.

- [ ] **Step 5: Прогнать и убедиться, что сходится**

Run: `npm test`
Expected: PASS, и набор печатает число проверок.

- [ ] **Step 6: Коммит**

```bash
git add -A && git commit -m "Скелет: Vite, TypeScript, Vitest и сторож развилки"
```

---

### Task 2: Копии логики и сторож их целости

**Files:**
- Create: `tools/sync-logic.mjs`, `src/core/logic.manifest.json`
- Create (копированием): `src/core/*.js` — файлы перечислены в шаге 3
- Test: `tests/sync-logic.test.ts`

**Interfaces:**
- Consumes: сторож из Task 1.
- Produces: `node tools/sync-logic.mjs --check` (код выхода 1 при расхождении), `--from <путь к клону run-game>` для перекопирования; `logic.manifest.json` — `{файл: sha256}`.

- [ ] **Step 1: Написать падающие тесты синхронизатора**

```ts
test('манифест перечисляет все файлы core', () => {
  expect(Object.keys(manifest).sort()).toEqual(readdirSync('src/core').filter(f => f.endsWith('.js')).sort());
});
test('хеши совпадают с содержимым', () => {
  for (const [f, hash] of Object.entries(manifest)) expect(sha256(read(`src/core/${f}`))).toBe(hash);
});
test('правка копии ловится проверкой', () => {
  expect(checkAgainst({ 'util.js': 'deadbeef' }).ok).toBe(false);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test -- sync-logic`
Expected: FAIL — манифеста нет.

- [ ] **Step 3: Скопировать логику и написать синхронизатор**

Копируются из `run-game` байт в байт: `util.js`, `config.js`, `theme.js`,
`signals.js`, `calibrate.js`, `level.js`, `difficulty.js`, `awards.js`,
`text.js`, `audio.js`, `log.js`, `players.js`, `settings.js`, `camera.js`,
`pose.js`, `pose.camera.js`, `pose.worker.js`, `pose.engine.js`,
`pose.pack.js`, `fake-pose.js`, `train.js`.

`tools/sync-logic.mjs` экспортирует `checkAgainst(manifest) → {ok, drifted[]}`
и под `--from` перекопирует файлы, пересчитав манифест. Пути MediaPipe из
`config.js` НЕ правятся здесь — их перекрывает адаптер в Task 7.

- [ ] **Step 4: Прогнать набор целиком**

Run: `npm test`
Expected: PASS; сторож развилки по-прежнему зелёный (в `core` только `.js`).

- [ ] **Step 5: Коммит**

```bash
git add -A && git commit -m "Логика приехала копиями, целость под хешами"
```

---

### Task 3: Описание сцены

**Files:**
- Create: `src/render/types.ts`, `src/render/compose.ts`
- Test: `tests/compose.test.ts`

**Interfaces:**
- Consumes: `makeLevel`, `makeStars`, `tuneFor` из `src/core`.
- Produces:
  ```ts
  type AssetId = string;
  type Placement = { asset: AssetId; x: number; y: number; z: number; yaw?: number; scale?: number; tint?: string; fade?: number };
  type FrameScene = { zone: string; world: string; camera: { u: number; pitch: number }; placements: Placement[] };
  function composeScene(state: RunState): FrameScene;
  ```
  `z` — метры вперёд по коридору, `x` — метры поперёк, `y` — вверх; `fade` 0..1.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('препятствие стоит на своей стороне и на своём расстоянии', () => {
  const s = composeScene(stateWith({ obstacles: [{ at: 12, kind: 'side', side: -1, look: 'plate' }], runS: 2 }));
  const p = s.placements.find(p => p.asset === 'obstacle/plate');
  expect(p!.z).toBeCloseTo(12 - 2 * speedOf(1), 2);
  expect(Math.sign(p!.x)).toBe(-1);
});
test('кольцо дальше горизонта не размещается вовсе', () => {
  expect(composeScene(stateWith({ stars: [{ at: 400 }], runS: 0 })).placements).toHaveLength(0);
});
test('описание не знает про three', () => {
  expect(Object.keys(composeScene(stateWith({}))).sort()).toEqual(['camera', 'placements', 'world', 'zone']);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test -- compose`
Expected: FAIL — `composeScene` не определена.

- [ ] **Step 3: Реализовать `composeScene(state: RunState): FrameScene`**

Дальность отсечения — одно число в `src/render/types.ts` (`DRAW_FAR_M`), и оно
же читается бюджетом: второй копии дальности не положено. Расстояние считается
из времени и скорости уровня (`tuneFor(step).speed`), а не задаётся в метрах.

- [ ] **Step 4: Прогнать**

Run: `npm test -- compose`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add -A && git commit -m "Сцена стала описанием: FrameScene без three"
```

---

### Task 4: Таблица ассетов из `.glb`

**Files:**
- Create: `tools/asset-stat.mjs`, `assets/manifest.json`
- Test: `tests/asset-stat.test.ts`

**Interfaces:**
- Produces: `readGlbStats(buffer) → {primitives: {material: string, verts: number}[], textures: {name, width, height, format}[]}`; `assets/manifest.json` — `{assetId: {calls, verts, texBytes}}`, где `calls` = число примитивов.

- [ ] **Step 1: Написать падающие тесты на синтезированном `.glb`**

Фикстура строится в тесте, а не кладётся в репозиторий: заголовок `glTF` +
JSON-чанк + BIN-чанк, никаких бинарных файлов под гитом.

```ts
test('вершины считаются по accessor POSITION', () => {
  expect(readGlbStats(glb({ positions: 36 })).primitives[0].verts).toBe(36);
});
test('два примитива с разными материалами — два вызова', () => {
  expect(readGlbStats(glb({ primitives: 2, materials: 2 })).primitives).toHaveLength(2);
});
test('битый glb падает с внятной ошибкой, а не молча', () => {
  expect(() => readGlbStats(Buffer.from('nope'))).toThrow(/не glTF/);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test -- asset-stat`
Expected: FAIL — функции нет.

- [ ] **Step 3: Реализовать `readGlbStats` и генератор манифеста**

Парсер читает только JSON-чанк (бинарные данные не нужны): `meshes[].primitives[]`,
`accessors[attributes.POSITION].count`, `images[]` + `samplers`. Текстурная
память считается по формату: несжатая RGBA = `w*h*4`, ASTC 4×4 = `w*h`, с
мип-уровнями ×1.34.

- [ ] **Step 4: Прогнать**

Run: `npm test -- asset-stat`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add -A && git commit -m "Таблица ассетов считается из .glb, а не пишется руками"
```

---

### Task 5: Бюджет кадра без телефона

**Files:**
- Create: `src/render/estimate.ts`, `tools/budget.mjs`
- Test: `tests/estimate.test.ts`

**Interfaces:**
- Consumes: `composeScene` (Task 3), `assets/manifest.json` (Task 4).
- Produces: `estimate(scene: FrameScene, assets: AssetTable) → {calls: number, verts: number, texBytes: number}`; `npm run budget` печатает худший кадр и строку «по мирам», как в `run-game`.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('одинаковые ассеты складываются в ОДИН вызов', () => {
  // kelp — один примитив в таблице, поэтому два размещения дают один вызов
  const s = sceneWith([{ asset: 'decor/kelp' }, { asset: 'decor/kelp' }]);
  expect(estimate(s, table).calls).toBe(1);
});
test('а ассет из двух материалов даёт ДВА вызова, сколько бы его ни стояло', () => {
  // иначе бюджет врёт вниз именно на сложном арте: таблица хранит calls на ассет
  const s = sceneWith([{ asset: 'obstacle/jelly' }, { asset: 'obstacle/jelly' }]);
  expect(estimate(s, table).calls).toBe(table['obstacle/jelly'].calls);
});
test('неизвестный ассет падает громко', () => {
  expect(() => estimate(sceneWith([{ asset: 'нет такого' }]), table)).toThrow(/нет в таблице/);
});
test('пустая сцена даёт нули, а не NaN', () => {
  expect(estimate({ ...emptyScene, placements: [] }, table)).toEqual({ calls: 0, verts: 0, texBytes: 0 });
});
test('худший кадр укладывается в потолок по КАЖДОМУ миру', () => {
  for (const world of WORLDS) expect(worstFrame(world).calls).toBeLessThan(150);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test -- estimate`
Expected: FAIL.

- [ ] **Step 3: Реализовать `estimate` и прогон бюджета**

Инстансирование — главное правило счёта: размещения с одним `asset`
складываются в одну отрисовку (это и будет `InstancedMesh` в Task 6), поэтому
`calls = Σ` по РАЗНЫМ ассетам от `assets[id].calls` (у ассета из двух
материалов это два вызова, сколько бы его ни стояло), а `verts = Σ` по всем
размещениям от `assets[id].verts`. Прогон бюджета
перебирает миры, посевы и все ступени сложности, как счётчик `run-game`, и
печатает худший кадр каждого мира.

- [ ] **Step 4: Прогнать**

Run: `npm test -- estimate && npm run budget`
Expected: PASS; напечатан худший кадр и строка по мирам.

- [ ] **Step 5: Коммит**

```bash
git add -A && git commit -m "Бюджет кадра считается по описанию сцены, в node"
```

---

### Task 6: Трёхмерный вывод

**Files:**
- Create: `src/render/three/build.ts`, `src/render/three/renderer.ts`
- Test: `tests/three-build.test.ts`

**Interfaces:**
- Consumes: `FrameScene` (Task 3), `estimate` (Task 5).
- Produces:
  ```ts
  function build3D(scene: FrameScene, assets: LoadedAssets): THREE.Group;
  function stats3D(group: THREE.Group): { calls: number; verts: number };
  interface Renderer { resize(w: number, h: number, dpr: number): void; draw(scene: FrameScene): void; stats(): { calls: number; verts: number }; dispose(): void }
  function makeThreeRenderer(canvas: HTMLCanvasElement): Promise<Renderer>;
  ```
  `build3D` и `stats3D` работают БЕЗ WebGL — граф three.js собирается в `node`,
  и только `makeThreeRenderer` требует контекста.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('живой счёт совпадает с оценкой — судят и рисуют по одному числу', () => {
  const scene = worstFrame('deep').scene;
  expect(stats3D(build3D(scene, fakeAssets))).toEqual(estimate(scene, table));
});
test('повторяющийся ассет собран в один InstancedMesh', () => {
  const g = build3D(sceneWith([{ asset: 'decor/kelp' }, { asset: 'decor/kelp' }]), fakeAssets);
  expect(g.children.filter(c => c.type === 'Mesh' || c.type === 'InstancedMesh')).toHaveLength(1);
});
test('а ассет из двух материалов даёт два меша на один инстанс-набор', () => {
  const g = build3D(sceneWith([{ asset: 'obstacle/jelly' }]), fakeAssets);
  expect(stats3D(g).calls).toBe(2);
});
test('потеря контекста пересобирает вывод', async () => {
  const r = await makeThreeRenderer(stubCanvas());
  stubCanvas().emit('webglcontextlost');
  expect(r.stats().calls).toBeGreaterThan(0);
});
test('без ASTC и ETC2 текстуры грузятся несжатыми, а не молча никак', () => {
  expect(textureUrlFor('decor/kelp', { astc: false, etc2: false })).toMatch(/\.png$/);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test -- three-build`
Expected: FAIL.

- [ ] **Step 3: Реализовать сборку графа и вывод**

`build3D` разворачивает размещения в `InstancedMesh` по одному на ассет;
`makeThreeRenderer` добавляет `WebGLRenderer`, `KTX2Loader.detectSupport` и
подписку на `webglcontextlost`/`restored` с пересборкой. Внутреннее разрешение
0.7 и запечённый свет — из спеки.

- [ ] **Step 4: Прогнать**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add -A && git commit -m "Трёхмерный вывод за интерфейсом, счёт сверен с оценкой"
```

---

### Task 7: Спайк: страница, журнал и четыре прогона

**Files:**
- Create: `src/shell/spike.ts`, `src/adapters/pose-paths.ts`, `spike.html`
- Test: `tests/spike.test.ts`

**Interfaces:**
- Consumes: `makeThreeRenderer` (Task 6), лестница поз из `src/core`.
- Produces: страница с параметрами `?what=scene|pose|both` и `?delegate=gpu|cpu`; журнал пишет `fps`, `gap95`, `p50`, `hz`, `calls`, `verts` теми же именами, что `run-game` — иначе `tools/log-report.mjs` оттуда не прочтёт.

- [ ] **Step 1: Написать падающие тесты**

```ts
test('разбор run-game читает наш журнал', () => {
  expect(report(sessionFrom(spikeLog())).perf.gap.med).toBe(33);
});
test('четыре прогона различимы в журнале', () => {
  expect(spikeLog().filter(e => e.type === 'run.start').map(e => `${e.what}/${e.delegate}`))
    .toEqual(['scene/-', 'pose/gpu', 'both/gpu', 'both/cpu']);
});
test('пути MediaPipe перекрыты сборкой, а не копией config', () => {
  expect(posePaths().wasm).not.toMatch(/vendor\//);
});
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `npm test -- spike`
Expected: FAIL.

- [ ] **Step 3: Реализовать страницу спайка**

`gap95` считается тем же способом, что в `run-game` (самый затянувшийся кадр из
двадцати): имена полей и способ счёта обязаны совпадать, иначе числа спайка не
сравнятся с базовой линией. `pose-paths.ts` отдаёт пути к файлам
`@mediapipe/tasks-vision` из сборки, перекрывая `POSE` из скопированного
`config.js`.

- [ ] **Step 4: Прогнать набор**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Коммит и остановка на замере**

```bash
git add -A && git commit -m "Спайк готов: четыре прогона и журнал, читаемый разбором run-game"
```

**Дальше — человек с телефоном.** Четыре прогона в одной сессии (разброс
устройства ±8 fps живёт между сессиями), журнал прогоняется
`node ../run-game/tools/log-report.mjs <файл>`, числа кладутся в
`measurements/`. Порог записан в спеке и менять его по полученному числу
нельзя.

---

### Task 8 (условная): спрайтовый вывод

**Выполняется ТОЛЬКО если спайк не взял порог** (`gap95` > 40 мс или позы
< 10 Гц). Если взял — задача не делается вовсе, и это не долг, а закрытая
развилка.

**Files:**
- Create: `src/render/sprite/build.ts`, `tools/bake-sprites.mjs`
- Test: `tests/sprite-build.test.ts`

**Interfaces:**
- Consumes: тот же `FrameScene` и тот же интерфейс `Renderer`.
- Produces: `makeSpriteRenderer(canvas) → Promise<Renderer>`; `tools/bake-sprites.mjs` отрисовывает атласы ИЗ ТЕХ ЖЕ `.glb` через headless Chrome.

- [ ] **Step 1: Написать падающий тест на равенство описаний**

```ts
test('спрайтовый вывод читает то же описание, что трёхмерный', () => {
  const scene = worstFrame('deep').scene;
  expect(statsSprite(buildSprite(scene, atlas))).toEqual(estimate(scene, spriteTable));
});
```

- [ ] **Step 2–5:** как в Task 6 — прогнать падение, реализовать, прогнать,
      коммит.

---

## Чего в этом плане НЕТ намеренно

Офлайн-комплекта, иконок, меню, экрана результата и переноса игры целиком.
Всё это имеет смысл делать после ответа на развилку: до него любой из них
пришлось бы переписывать. Следующий план пишется под победивший способ вывода.
