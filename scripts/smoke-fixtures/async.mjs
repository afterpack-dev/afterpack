const events = [];

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

async function fetchAll(ids) {
  const results = await Promise.all(ids.map((id) => delay(ids.length - id, id * 10)));
  return results.reduce((sum, value) => sum + value, 0);
}

async function* ticker(limit) {
  for (let i = 1; i <= limit; i++) {
    await delay(1);
    yield i * i;
  }
}

function* range(start, end) {
  for (let i = start; i < end; i++) yield i;
}

export async function run() {
  events.push("start");
  queueMicrotask(() => events.push("microtask"));
  setTimeout(() => events.push("timeout"), 0);
  await null;
  events.push("after-await");
  const total = await fetchAll([1, 2, 3, 4]);
  const squares = [];
  for await (const value of ticker(4)) squares.push(value);
  const settled = await Promise.allSettled([
    Promise.reject(new Error("nope")),
    Promise.resolve("yes"),
  ]);
  const raced = await Promise.race([delay(20, "slow"), delay(1, "fast")]);
  return { total, squares, settled: settled.map((s) => s.status), raced, range: [...range(2, 6)] };
}

const outcome = await run();
await delay(5);
console.log(JSON.stringify(outcome));
console.log(events.join(","));
