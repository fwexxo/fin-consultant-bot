/**
 * Последовательная очередь с конкурентностью 1.
 *
 * Claude Agent SDK запускает `claude` CLI отдельным процессом. На VPS
 * с 2 ГБ RAM параллельные запуски способны исчерпать память и уронить
 * соседние сервисы, поэтому конкурентность жёстко равна единице.
 */
export class Queue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // fn передан и в onFulfilled, и в onRejected: очередь должна
    // выполнить задачу независимо от того, чем кончилась предыдущая.
    const result = this.#tail.then(fn, fn);

    // Хвост не наследует отказ, иначе одна упавшая задача отклонила бы
    // все последующие.
    this.#tail = result.then(() => undefined, () => undefined);

    return result;
  }
}
