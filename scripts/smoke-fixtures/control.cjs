class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

function validate(record) {
  if (typeof record.age !== "number") throw new ValidationError("age", "age must be a number");
  if (record.age < 0) throw new ValidationError("age", "age must be positive");
  if (!/^[a-z]+@[a-z]+\.[a-z]{2,}$/.test(record.email)) {
    throw new ValidationError("email", `bad email ${record.email}`);
  }
  return true;
}

function classify(code) {
  switch (true) {
    case code >= 500:
      return "server";
    case code >= 400:
      return "client";
    case code >= 300:
      return "redirect";
    default:
      return "ok";
  }
}

function findPair(grid, target) {
  outer: for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (grid[i][j] < 0) continue outer;
      if (grid[i][j] === target) return [i, j];
    }
  }
  return null;
}

const log = [];
for (const record of [
  { age: 30, email: "ann@mail.test" },
  { age: "x", email: "bob@mail.test" },
  { age: -1, email: "cy@mail.test" },
  { age: 5, email: "not-an-email" },
]) {
  try {
    validate(record);
    log.push("valid");
  } catch (error) {
    log.push(error instanceof ValidationError ? `${error.field}:${error.message}` : "other");
  } finally {
    log.push("|");
  }
}

let n = 27;
let steps = 0;
do {
  n = n % 2 === 0 ? n / 2 : 3 * n + 1;
  steps++;
} while (n !== 1);

const bits = [0xff & 0x0f, 1 << 10, -16 >> 2, -16 >>> 28, 5 ^ 3, ~7];
const template = "2026-10-01 id=42 user=ann; id=7 user=bob";
const users = [...template.matchAll(/id=(\d+) user=(\w+)/g)].map((m) => `${m[2]}:${m[1]}`);
const shouted = template.replace(/user=(\w+)/g, (_, name) => `USER=${name.toUpperCase()}`);
const keys = [];
const bag = { zeta: 1, alpha: 2, mid: 3 };
for (const key in bag) keys.push(key);

console.log(log.join(""));
console.log([200, 301, 404, 503].map(classify).join(","));
console.log(
  JSON.stringify(
    findPair(
      [
        [1, 2],
        [-1, 9],
        [3, 9],
      ],
      9,
    ),
  ),
);
console.log(steps, bits.join(","));
console.log(users.join(" "), shouted);
console.log(keys.sort().join(","), String(42).padStart(6, "0"), 0xff);
console.log(new Date(Date.UTC(2026, 9, 1, 12, 30)).toISOString(), (1234.5678).toFixed(2));
