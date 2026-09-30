const memo = new Map();
function fib(n) {
  if (n < 2) return n;
  if (memo.has(n)) return memo.get(n);
  const value = fib(n - 1) + fib(n - 2);
  memo.set(n, value);
  return value;
}

function counter(start = 0, step = 1) {
  let current = start;
  return {
    next: () => {
      current += step;
      return current;
    },
    reset: () => {
      current = start;
      return current;
    },
  };
}

const curry =
  (fn) =>
  (...args) =>
    args.length >= fn.length ? fn(...args) : curry(fn.bind(null, ...args));

const volume = curry((a, b, c) => a * b * c);

function describe({ name, tags = [], owner: { email } = {} }, ...extra) {
  const label = `${name.toUpperCase()}[${tags.join("|")}]`;
  return `${label} <${email ?? "none"}> ${extra.length}`;
}

const words = "the quick brown fox jumps over the lazy dog".split(" ");
const frequency = words.reduce((acc, word) => {
  acc[word] = (acc[word] ?? 0) + 1;
  return acc;
}, {});

const sorted = [...words].sort((a, b) => b.length - a.length || a.localeCompare(b));

const c = counter(10, 5);
c.next();
c.next();

const results = [
  fib(40),
  c.next(),
  c.reset(),
  volume(2)(3)(4),
  volume(2, 3)(5),
  describe({ name: "alpha", tags: ["x", "y"], owner: { email: "a@example.test" } }, 1, 2),
  describe({ name: "beta" }),
  JSON.stringify(frequency),
  sorted.join(","),
  words.map((w) => w[0]).join(""),
  [1, 2, 3, 4, 5].filter((n) => n % 2).map((n) => n ** 2),
  String.raw`a\nb${1 + 1}`,
];

for (const line of results) console.log(typeof line === "string" ? line : JSON.stringify(line));
