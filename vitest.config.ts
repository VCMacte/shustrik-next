import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Потолок живёт здесь, а не в командной строке: командная строка не
    // доходит до husky и до CI, а конфиг доходит везде.
    //
    // pool зафиксирован явно: без этого потолок ниже держится только на
    // умолчании vitest 2 (форки), и смена на 'threads' в будущем обесценит
    // maxForks/minForks молча — ни один тест на это не упадёт.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        // Без явного minForks Tinypool падает конфликтом min/max, когда
        // maxForks меньше числа ядер — та же известная (и уже оплаченная)
        // ловушка, что в соседнем pose-game.
        minForks: 1,
      },
    },
    reporters: ['default', './tools/reporter-count.mjs'],
  },
})
