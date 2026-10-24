# Шустрик на новой графике — техника

Бегалка от первого лица для ребёнка 7 лет: телефон на штативе видит ребёнка
камерой и считает позу, смещение тела ведёт взгляд по коридору, присед проводит
под препятствием. Это НОВАЯ ГРАФИКА к уже работающей игре: логика приезжает из
`run-game`, переписывается только отрисовка.

Здесь — только то, что задевает любую правку. Замысел, решения и бюджеты — в
[`docs/superpowers/specs/2026-10-21-architecture.md`](docs/superpowers/specs/2026-10-21-architecture.md).
Порядок работ — в [`docs/superpowers/plans/`](docs/superpowers/plans/).

## Команды

```
npm ci --maxsockets 4 --no-audit --no-fund   # и когда ничего другого не работает
npm run dev            # vite, http://localhost:5173
npm test               # typecheck + vitest
npm run budget         # худший кадр по мирам, без телефона
node tools/sync-logic.mjs --check            # не разъехались ли копии логики
node tools/make-placeholder-assets.mjs       # перезаписать заглушки assets/**.glb
node tools/asset-stat.mjs                    # пересчитать assets/manifest.json из .glb
```

## Инварианты, которые задевает любая правка

**Развилка «3D или 2.5D» ещё не решена, и код обязан дожить до ответа.** Это не
стиль, а требование замера: на видеоядре инференс отнимает кадры у картинки, на
процессоре картинка отнимает герцы у инференса, и какой способ вывода проходит
порог — покажет спайк. Отсюда три правила ниже.

**`src/core/` и `src/render/compose.ts` не импортируют `three`.** Сцена — чистое
ОПИСАНИЕ (`FrameScene`: список размещений), и оба способа вывода читают одно и
то же описание. Проверяется тестом, а не договорённостью.

**Число, по которому СУДЯТ, и число, которое РИСУЮТ, берутся из одного места.**
Бюджет кадра считает `estimate(scene, assets)` в `node`; на устройстве
`renderer.stats()` отдаёт живые вызовы и вершины, и тест сверяет их с
`estimate`. Две копии расходятся — и бюджет начинает врать уверенно.

**Логика НЕ правится здесь.** `src/core/*.js` — побайтовые копии из `run-game`
под `allowJs`; перевод на TypeScript запрещён, потому что он не механический, а
та математика проверена десятью журналами с ребёнком. Правка едет в `run-game`
и приезжает сюда `tools/sync-logic.mjs`. Сторож держит хеши и падает на
расхождении.

**Потолки записаны ЗАРАНЕЕ и лежат в спеке:** вызовы < 150, вершины < 100 000,
текстурная память ≤ 96 МБ, офлайн-комплект ≤ 100 МБ; порог спайка — `gap95`
≤ 40 мс И позы ≥ 10 Гц. Менять потолок задним числом под полученное число —
ровно то, от чего эти записи защищают.

**Miracast сжимает картинку.** Крупные формы, различать элементы заливкой и
светлотой, а не тонкой рамкой и не тоном: рамка исчезнет, цветность режется
сильнее светлоты.

## Устройство

| Папка | Задача |
|---|---|
| `src/core/` | **копии логики из `run-game`**, `.js`, руками не правятся |
| `src/render/` | описание сцены (`compose`, `types`, `estimate`) и способы вывода |
| `src/shell/` | экраны, меню, главный цикл |
| `src/adapters/` | камера, поза, журнал, хранилище — обёртки над `core` |
| `assets/` | `.glb` с запечённым светом, текстуры KTX2 |
| `tools/` | синхронизация логики, статистика ассетов, сборка |
| `docs/` | по файлу на тему; индекс — в спеке |

## Что здесь НЕ изобретается

Словарь управления (две оси), расписание препятствий, приговор, кольца, кубок,
сложность, журнал — всё это приезжает из `run-game` как есть. Новое здесь
только одно: как это выглядит.

## Поведенческие правила (из andrej-karpathy-skills)

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
