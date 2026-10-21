/**
 * Печатает число проверок — это не делает ни Vitest из коробки, ни
 * `pose-game`. Без этого «всё сошлось» при нуле новых проверок выглядит
 * ровно так же, как при восьми (docs/superpowers/plans — ограничение плана).
 *
 * Формулировка намеренно повторяет `run-game/tests-shell.mjs`: тот же
 * словарь для того же факта в двух репозиториях читается одинаково.
 */

// Обход вложенных suite нужен, потому что сами проверки (test) лежат не
// только на верхнем уровне файла, а и внутри describe-блоков — без рекурсии
// счётчик занижал бы число на вложенных наборах.
function collectTests(tasks) {
  const tests = []
  for (const task of tasks ?? []) {
    if (task.type === 'suite') {
      tests.push(...collectTests(task.tasks))
    } else {
      tests.push(task)
    }
  }
  return tests
}

export default class CountReporter {
  onFinished(files = []) {
    const tests = files.flatMap((file) => collectTests(file.tasks))
    const passed = tests.filter((t) => t.result?.state === 'pass').length
    const failed = tests.filter((t) => t.result?.state === 'fail').length
    // test.skip/test.todo не попадают ни в passed, ни в failed — отдельный
    // счёт, а не молчание: пропущенная проверка не подтверждает ничего, и
    // «всё сошлось» не должно выглядеть так же, будто она подтвердила.
    const skipped = tests.length - passed - failed

    const skippedNote = skipped > 0 ? `, ${skipped} пропущено` : ''

    if (failed > 0) {
      console.error(`\n${failed} провал(ов) из ${passed + failed} проверок${skippedNote}`)
      return
    }
    console.log(`\nвсё сошлось: ${passed} проверок${skippedNote}`)
  }
}
