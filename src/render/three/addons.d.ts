/**
 * Типы для аддонов `three`, которых в пакете нет.
 *
 * `three@0.186` отдаёт `examples/jsm/**` без единого `.d.ts`, и литеральный
 * `import('three/examples/jsm/loaders/KTX2Loader.js')` валил `tsc --noEmit`
 * с TS7016. Обходили это спецификатором в переменной плюс `@vite-ignore` —
 * и обход ОКАЗАЛСЯ ХУЖЕ дыры: `@vite-ignore` прямо запрещает сборщику
 * переписать путь, поэтому в браузер уезжало голое имя пакета, разрешать
 * которое там нечем. Страница спайка не запускалась ни в одном режиме
 * («Failed to resolve module specifier»), и восемьдесят одна зелёная
 * проверка этого не видела.
 *
 * Объявление здесь возвращает спецификатор в ЛИТЕРАЛ: сборщик снова видит
 * его статически и переписывает, а `tsc` молчит. Типы намеренно `any` —
 * описывать чужие загрузчики своими руками значило бы завести копию,
 * которая разойдётся с `three` в первое же обновление.
 */
declare module 'three/examples/jsm/loaders/KTX2Loader.js' {
  export const KTX2Loader: any
}

declare module 'three/examples/jsm/loaders/GLTFLoader.js' {
  export const GLTFLoader: any
}
