import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../../src/claude/queue.ts';

test('очередь выполняет задачи строго по одной', async () => {
  const q = new Queue();
  let running = 0;
  let maxConcurrent = 0;

  const task = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 10));
    running -= 1;
    return 'ok';
  };

  await Promise.all([q.run(task), q.run(task), q.run(task)]);
  assert.equal(maxConcurrent, 1, `одновременно выполнялось ${maxConcurrent}`);
});

test('очередь сохраняет порядок постановки', async () => {
  const q = new Queue();
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => q.run(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push(n);
  })));
  assert.deepEqual(order, [1, 2, 3]);
});

test('ошибка задачи не блокирует очередь', async () => {
  const q = new Queue();
  await assert.rejects(() => q.run(async () => { throw new Error('упало'); }), /упало/);
  const result = await q.run(async () => 'следующая работает');
  assert.equal(result, 'следующая работает');
});

test('упавшая задача не отклоняет соседние', async () => {
  const q = new Queue();
  const results = await Promise.allSettled([
    q.run(async () => 'первая'),
    q.run(async () => { throw new Error('вторая упала'); }),
    q.run(async () => 'третья'),
  ]);

  assert.equal(results[0]!.status, 'fulfilled');
  assert.equal(results[1]!.status, 'rejected');
  assert.equal(results[2]!.status, 'fulfilled');
  assert.equal((results[2] as PromiseFulfilledResult<string>).value, 'третья');
});
