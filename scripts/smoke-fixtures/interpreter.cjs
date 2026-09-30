function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      let text = "";
      while (i < input.length && /[0-9.]/.test(input[i])) text += input[i++];
      tokens.push({ type: "num", value: Number(text) });
    } else if (/[a-z_]/i.test(ch)) {
      let text = "";
      while (i < input.length && /[a-z_0-9]/i.test(input[i])) text += input[i++];
      tokens.push({ type: "id", value: text });
    } else if ("+-*/%^(),=".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
    } else {
      throw new SyntaxError(`unexpected ${ch} at ${i}`);
    }
  }
  return tokens;
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (value) => {
    const token = tokens[pos];
    if (value !== undefined && token?.value !== value) {
      throw new SyntaxError(`expected ${value} at token ${pos}`);
    }
    pos++;
    return token;
  };

  function primary() {
    const token = take();
    if (!token) throw new SyntaxError("unexpected end");
    if (token.type === "num") return { kind: "num", value: token.value };
    if (token.value === "(") {
      const inner = expression();
      take(")");
      return inner;
    }
    if (token.value === "-") return { kind: "neg", arg: unary() };
    if (token.type === "id") {
      if (peek()?.value === "(") {
        take("(");
        const args = [];
        while (peek()?.value !== ")") {
          args.push(expression());
          if (peek()?.value === ",") take(",");
        }
        take(")");
        return { kind: "call", name: token.value, args };
      }
      return { kind: "var", name: token.value };
    }
    throw new SyntaxError(`unexpected ${token.value}`);
  }

  function unary() {
    return primary();
  }

  function power() {
    const base = unary();
    if (peek()?.value === "^") {
      take("^");
      return { kind: "bin", op: "^", left: base, right: power() };
    }
    return base;
  }

  function term() {
    let left = power();
    while (["*", "/", "%"].includes(peek()?.value)) {
      const op = take().value;
      left = { kind: "bin", op, left, right: power() };
    }
    return left;
  }

  function expression() {
    let left = term();
    while (["+", "-"].includes(peek()?.value)) {
      const op = take().value;
      left = { kind: "bin", op, left, right: term() };
    }
    return left;
  }

  function statement() {
    if (tokens[pos]?.type === "id" && tokens[pos + 1]?.value === "=") {
      const name = take().value;
      take("=");
      return { kind: "let", name, value: expression() };
    }
    return expression();
  }

  const tree = statement();
  if (pos !== tokens.length) throw new SyntaxError(`trailing input at token ${pos}`);
  return tree;
}

const FUNCTIONS = {
  max: (...xs) => Math.max(...xs),
  min: (...xs) => Math.min(...xs),
  sqrt: (x) => Math.sqrt(x),
  hyp: (a, b) => Math.hypot(a, b),
};

function evaluate(node, scope) {
  switch (node.kind) {
    case "num":
      return node.value;
    case "neg":
      return -evaluate(node.arg, scope);
    case "var":
      if (!(node.name in scope)) throw new ReferenceError(`${node.name} is not defined`);
      return scope[node.name];
    case "let":
      scope[node.name] = evaluate(node.value, scope);
      return scope[node.name];
    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new ReferenceError(`no function ${node.name}`);
      return fn(...node.args.map((arg) => evaluate(arg, scope)));
    }
    case "bin": {
      const a = evaluate(node.left, scope);
      const b = evaluate(node.right, scope);
      if (node.op === "+") return a + b;
      if (node.op === "-") return a - b;
      if (node.op === "*") return a * b;
      if (node.op === "/") return a / b;
      if (node.op === "%") return a % b;
      return a ** b;
    }
    default:
      throw new Error(`unknown node ${node.kind}`);
  }
}

const program = [
  "x = 3",
  "y = x ^ 2 ^ 2 - 1",
  "z = (x + y) * -2 % 7",
  "hyp(3, 4) + max(x, y, 10) / min(4, 8)",
  "sqrt(y + 1) * 1.5",
  "w + 1",
  "3 $ 4",
  "(1 + 2",
];

const scope = {};
for (const line of program) {
  try {
    console.log(`${line} => ${evaluate(parse(tokenize(line)), scope)}`);
  } catch (error) {
    console.log(
      `${line} => ${error instanceof SyntaxError ? "syntax" : "reference"}: ${error.message}`,
    );
  }
}
console.log(JSON.stringify(scope));
