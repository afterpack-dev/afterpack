class Shape {
  static count = 0;
  #id;

  constructor(label) {
    Shape.count += 1;
    this.#id = Shape.count;
    this.label = label;
  }

  get id() {
    return this.#id;
  }

  area() {
    return 0;
  }

  describe() {
    return `${this.label}#${this.id}:${this.area().toFixed(2)}`;
  }
}

class Rect extends Shape {
  constructor(w, h) {
    super("rect");
    this.w = w;
    this.h = h;
  }

  area() {
    return this.w * this.h;
  }

  set width(value) {
    this.w = Math.max(0, value);
  }
}

class Circle extends Shape {
  #r;

  constructor(r) {
    super("circle");
    this.#r = r;
  }

  area() {
    return Math.PI * this.#r * this.#r;
  }

  static unit() {
    return new Circle(1);
  }
}

class Inventory {
  #items = new Map();

  add(name, qty) {
    this.#items.set(name, (this.#items.get(name) ?? 0) + qty);
    return this;
  }

  *[Symbol.iterator]() {
    for (const [name, qty] of [...this.#items].sort(([a], [b]) => a.localeCompare(b))) {
      yield `${name}=${qty}`;
    }
  }

  get total() {
    let sum = 0;
    for (const qty of this.#items.values()) sum += qty;
    return sum;
  }
}

const shapes = [new Rect(3, 4), new Circle(2), Circle.unit(), new Rect(1.5, 2)];
shapes[0].width = -5;
shapes[3].width = 10;

const inventory = new Inventory().add("pear", 3).add("apple", 2).add("pear", 4);
const unique = new Set(shapes.map((s) => s.label));
const clone = JSON.parse(JSON.stringify({ shapes: shapes.map((s) => s.describe()) }));

console.log(shapes.map((s) => s.describe()).join(" "));
console.log(shapes.filter((s) => s instanceof Circle).length, Shape.count);
console.log([...inventory].join(","), inventory.total);
console.log([...unique].join("+"));
console.log(clone.shapes.length, typeof clone.shapes[0]);
console.log(shapes.reduce((acc, s) => acc + s.area(), 0).toFixed(4));
