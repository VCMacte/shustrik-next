import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        maxForks: 4,
        // Без явного minForks Tinypool падает конфликтом min/max, когда
        // maxForks меньше числа ядер — та же известная (и уже оплаченная)
        // ловушка, что в соседнем pose-game.
        minForks: 1,
      },
    },
    // Потолок живёт здесь, а не в командной строке: командная строка не
    // доходит до husky и до CI, а конфиг доходит везде.
    reporters: ['default', './tools/reporter-count.mjs'],
  },
})
