// Текстуры для заглушек арта: небо по зонам и альбедо материалов.
//
// Зачем свой прогон, а не веб-интерфейс Easy Diffusion: картинок сорок с
// лишним, они нужны пачкой с одинаковыми настройками и предсказуемыми
// именами. Руками в браузере это не повторить — параметры разъезжаются от
// картинки к картинке, а нам важна ПОВТОРИМОСТЬ: сиды лежат в таблице
// целыми числами, и повторный прогон даёт те же файлы.
//
// Разделение на два рода картинок не стилистическое, а техническое:
//
//   НЕБО идёт через img2img от нашей же подложки. Подложка — вертикальный
//   градиент из палитры зоны (`sky` → `skyLow`) с полосой холмов внизу.
//   Так небо выходит в цветах игры и с горизонтом на своём месте. Генерация
//   «с нуля» вернёт красивую картинку с горизонтом где попало — это уже
//   проверено в соседних проектах (run-game, интерактивные комиксы).
//
//   АЛЬБЕДО материалов генерируется с нуля: это плоская заливка для грани
//   коробки, композиции в ней нет, и подложка ей ничего не даёт.
//
// Промпты неба выводятся ИЗ ДАННЫХ: `skyMotif` в палитре зоны уже говорит,
// что там видно (облака, ночь, сияние, заросли, бездна). Список руками
// разъехался бы с `theme.js` при первой же синхронизации логики.
//
// Правило Miracast (см. CLAUDE.md) задаёт стиль жёстко: телевизор получает
// картинку сжатием, цветность режется сильнее светлоты. Поэтому крупные
// плоские формы и контраст по СВЕТЛОТЕ, без тонких линий и мелкой детали.
//
// Запуск (Easy Diffusion должен быть поднят, см. docs):
//   node tools/make-textures.mjs               # всё
//   node tools/make-textures.mjs sky           # только небо
//   node tools/make-textures.mjs decor/kelp    # одну текстуру

import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME, WORLDS } from '../src/core/theme.js';

/* ---------------- где что лежит ---------------- */

/* `fileURLToPath`, а не разбор `pathname` руками: в пути проекта есть
   пробел, и из `import.meta.url` он приходит как `%20`. На этой же мели
   уже сидел `tools/sync-logic.mjs`. */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ED_CLIENT = resolve(ROOT, 'tools/ed-generate.mjs');
const OUT_TEX = resolve(ROOT, 'assets/tex');
const OUT_INIT = resolve(ROOT, 'tools/raw/init');   // подложки, под .gitignore
const OUT_RAW = resolve(ROOT, 'tools/raw');         // сырое из ED, под .gitignore

/* ---------------- стиль, общий для всего ---------------- */

/* Названо нарочно жёстко и повторяется в каждом промпте: модель склонна
   добавлять тонкую детализацию и мягкие переходы, а на Miracast и то и
   другое превращается в грязь. */
const FLAT = 'bold simple silhouette, flat matte colors, two or three tonal regions, '
  + 'strong lightness contrast, no thin lines, no text';

const NEG = 'text, letters, watermark, signature, frame, border, people, person, '
  + 'hands, blurry, soft focus, noise, grain, fine detail, thin lines, '
  + 'photorealistic, photo, lowres, jpeg artifacts';

/* ---------------- небо: мотив → что видно ---------------- */

/* Ключ — `skyMotif` из палитры зоны. Если синхронизация принесёт новый
   мотив, прогон упадёт с его именем, а не нарисует молча облака. */
const MOTIF = {
  clouds: 'big soft clouds in a clear sky',
  night: 'night sky with scattered stars, no moon',
  aurora: 'night sky with wide aurora ribbons',
  shallows: 'sunlit shallow water seen from below, light shafts',
  kelp: 'deep green underwater murk, faint light from above',
  abyss: 'near-black deep water with faint bioluminescent specks',
  cloudsHigh: 'view from far above the cloud deck, flat cloud floor',
  comet: 'deep space with a few comets and long tails',
  nebula: 'deep space nebula, broad colour clouds, few stars',
};

/* ---------------- предметы: что нарисовать ---------------- */

/* ПОЧЕМУ предметы, а не заливка материала. Калибровка 22 октября показала
   границу этой модели, и она совпала с таблицей из соседнего проекта
   (интерактивные комиксы, раздел «Контракт на картинки»):
   `deliberate_v2` хорошо делает небо и плоский стилизованный ПРЕДМЕТ, но
   «бесшовную текстуру материала» уводит либо в кафельный узор, либо в
   фотореалистичный камень с ЗАПЕЧЁННОЙ ТЕНЬЮ. Тень в альбедо недопустима:
   свет в этом проекте запечён в сам ассет, и вторая тень поверх него —
   грязь, которую уже ничем не убрать.

   Поэтому всё, что в сцене является предметом, рисуется как плоская
   картинка предмета. Для трёхмерного вывода это накладка на скрещённые
   плоскости, для спрайтового — готовый спрайт. То есть один и тот же арт
   годится обеим ветвям развилки, чего спека и требует.

   Список руками здесь намеренно: это описание предмета для нейросети, а не
   данные игры — из `theme.js` его не вывести, там лежат цвета. Зато
   полнота проверяется: отсутствие записи валит прогон (см. plan()). */
const SUBJECT = {
  // препятствия
  'obstacle/plate': 'a thick upright stone slab block',
  'obstacle/gate': 'a wooden plank gate barrier',
  'obstacle/floe': 'a pale blue cracked ice block',
  'obstacle/jelly': 'a translucent glowing jellyfish',
  'obstacle/asteroid': 'a grey pitted asteroid rock',
  'obstacle/ceiling': 'a rough rock slab hanging from above',
  'obstacle/bat': 'a dark bat with spread wings',
  'obstacle/icicles': 'a row of hanging ice spikes',
  'obstacle/ribs': 'an arch of pale bone ribs',
  'obstacle/comet': 'a glowing comet with a tail',
  'obstacle/beam': 'a heavy rusted metal beam',
  /* Вторая карта медузы: у неё два материала (тело и свечение), и это
     единственный ассет с двумя картами. Он такой намеренно — именно на нём
     проверяется, что бюджет не врёт вниз на сложном арте. */
  'obstacle/jelly-glow': 'a soft glowing cyan halo of light',
  // кольца
  'star/ring': 'a bright glowing golden ring, emissive',
  'star/big': 'a brilliant white-gold glowing star, emissive',
  // декор
  'decor/palm': 'a palm tree with broad fronds',
  'decor/bush': 'a round dense green shrub',
  'decor/flower': 'a single bright flower on a stem',
  'decor/cactus': 'a tall ribbed green cactus',
  'decor/rock': 'a grey boulder',
  'decor/firefly': 'a warm glowing firefly light, emissive',
  'decor/spruce': 'a dark green conifer tree',
  'decor/post': 'an old wooden post',
  'decor/totem': 'a carved painted wooden totem',
  'decor/kelp': 'tall green kelp blades growing upward',
  'decor/coral': 'branching pink coral',
  'decor/anemone': 'a purple sea anemone with tentacles',
  'decor/spire': 'a tall pale stone spire',
  'decor/drift': 'a pale drifting cloud of sediment',
  'decor/crystal': 'a cluster of violet crystals',
  'decor/shard': 'a sharp glassy shard',
};

/* Коридор — единственное, что остаётся ПОВЕРХНОСТЬЮ, а не предметом: пол и
   стены видны вплотную и во весь кадр. Нейросети они не отдаются по той же
   причине, по которой не отдаётся заливка: она возвращает тень. Пол и стены
   пишутся своим же писателем PNG из палитры зоны — это две полосы, и
   выходит и чище, и повторимее. */
const SURFACE = {
  'corridor/floor': ['floorA', 'floorB'],
  'corridor/walls': ['earthL', 'earthR'],
};

/* Сид выводится из ИМЕНИ, а не из порядкового номера. Разница не
   косметическая: при нумерации по порядку вставка одной строки в середину
   таблицы сдвигает сид всем последующим, и повторный прогон возвращает
   другие картинки — то есть повторимость, ради которой сиды и заведены,
   теряется от безобидной правки. Поймано на добавлении `jelly-glow`. */
function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000000;
}

/* ---------------- запись PNG без зависимостей ---------------- */

/* Растеризатора на машине нет (ни ImageMagick, ни Inkscape, ни sharp), а
   подложка нужна простая: градиент и полоса. Поэтому PNG пишется руками —
   это сорок строк и ноль зависимостей. */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG из функции цвета: (x, y) → [r, g, b]. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                        // фильтр строки: без фильтра
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // бит на канал
  ihdr[9] = 2;    // тип цвета: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/* ---------------- подложка неба ---------------- */

/* Горизонт на 72% высоты: ниже — полоса холмов, выше — градиент неба.
   Одно число, и оно же объясняет, почему генерация идёт img2img: без
   подложки модель ставит горизонт куда захочет, и полоса неба перестаёт
   стыковаться с полом коридора. */
const HORIZON = 0.72;

function skyInit(zone, width, height) {
  const p = THEME[zone];
  const top = rgb(p.sky);
  const low = rgb(p.skyLow);
  const hills = rgb(p.hills);
  const cloud = rgb(p.cloud);
  return png(width, height, (x, y) => {
    const v = y / height;
    if (v >= HORIZON) return hills;
    const t = v / HORIZON;
    const base = mix(top, low, t);
    /* Две мягкие полосы облаков: модели нужна зацепка, иначе на ровном
       градиенте она дорисовывает горизонт сама. */
    const band = Math.sin(v * 9) * Math.sin(x / width * 3.1);
    return band > 0.72 ? mix(base, cloud, 0.55) : base;
  });
}

/* ---------------- вызов Easy Diffusion ---------------- */

function generate({ out, prompt, negative, width, height, steps, seed, init, strength }) {
  const args = [ED_CLIENT,
    '--prompt', prompt,
    '--negative', negative,
    '--w', String(width), '--h', String(height),
    '--steps', String(steps), '--seed', String(seed),
    '--out', out];
  if (init) args.push('--init', init, '--strength', String(strength));

  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ED не отдал ${out} (код ${r.status})`);
}

/* ---------------- что вообще надо сделать ---------------- */

function plan() {
  const jobs = [];

  for (const info of Object.values(WORLDS)) {
    for (const zone of info.zones) {
      const motif = THEME[zone].skyMotif;
      const what = MOTIF[motif];
      if (!what) {
        throw new Error(`мотив неба «${motif}» (зона ${zone}) не описан в MOTIF — `
          + `синхронизация принесла новый мотив, добавь строку`);
      }
      jobs.push({
        id: `sky/${zone}`,
        prompt: `stylized game sky, ${what}, bold shapes, strong lightness `
          + `contrast, no thin lines, no text`,
        negative: `${NEG}, ground, grass, trees, buildings, horizon line`,
        width: 1024, height: 512, steps: 30,
        seed: seedOf(`sky/${zone}`),
        init: resolve(OUT_INIT, `${zone}.png`),
        strength: 0.72,
        makeInit: () => skyInit(zone, 1024, 512),
      });
    }
  }

  for (const [id, what] of Object.entries(SUBJECT)) {
    jobs.push({
      id,
      prompt: `flat stylized game art of ${what}, ${FLAT}, plain solid background`,
      negative: `${NEG}, cast shadow, drop shadow, ground plane, perspective, `
        + `tiles, tiling pattern, grid, ornament, busy pattern`,
      width: 512, height: 512, steps: 26,
      seed: seedOf(id),
    });
  }

  for (const [id, keys] of Object.entries(SURFACE)) {
    jobs.push({ id, surface: keys, width: 512, height: 512 });
  }
  return jobs;
}

/* ---------------- прогон ---------------- */

const filters = process.argv.slice(2);
const want = (id) => filters.length === 0 || filters.some((f) => id === f || id.startsWith(`${f}/`));

const jobs = plan().filter((j) => want(j.id));
if (jobs.length === 0) {
  console.error(`ничего не подошло под ${filters.join(', ')}`);
  process.exit(1);
}

mkdirSync(OUT_TEX, { recursive: true });
mkdirSync(OUT_INIT, { recursive: true });

/* Сырое остаётся в tools/raw/ (под .gitignore), в приложение едет копия в
   assets/tex/. Держать оба стоит: пересобрать ассет из сырого — секунда,
   сгенерировать заново — отдельный прогон. Тот же порядок, что в соседних
   проектах. */
function publish(id, from) {
  const to = resolve(OUT_TEX, `${id}.png`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

console.log(`к генерации: ${jobs.length} картинок\n`);
const t0 = Date.now();

for (const [i, job] of jobs.entries()) {
  const out = resolve(OUT_RAW, `${job.id}.png`);
  mkdirSync(dirname(out), { recursive: true });

  if (job.makeInit && !existsSync(job.init)) {
    mkdirSync(dirname(job.init), { recursive: true });
    writeFileSync(job.init, job.makeInit());
  }

  if (job.surface) {
    const [a, b] = job.surface.map((k) => rgb(THEME.greenHill[k]));
    console.log(`[${i + 1}/${jobs.length}] ${job.id}  (своим писателем, без ED)`);
    writeFileSync(out, png(job.width, job.height, (x, y) =>
      ((x >> 6) + (y >> 6)) % 2 ? a : mix(a, b, 0.5)));
    publish(job.id, out);
    continue;
  }

  console.log(`[${i + 1}/${jobs.length}] ${job.id}  seed=${job.seed}`);
  generate({ ...job, out });
  publish(job.id, out);
}

console.log(`\nготово: ${jobs.length} картинок за ${((Date.now() - t0) / 60000).toFixed(1)} мин`);
console.log(`сырое — в tools/raw/, отобранное кладётся в assets/tex/`);
