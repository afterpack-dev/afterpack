// Entry module of the native-ESM graph: <script type="module"> loads this, which
// imports two siblings (state.js -> math.js, format.js). No bundler is involved --
// the browser resolves the ./*.js specifiers, so obfuscation must preserve every
// import/export name and specifier for the graph to still link at runtime.
import { increment } from "./state.js";
import { label } from "./format.js";

const button = document.querySelector('[data-testid="counter"]');
button.textContent = label(0);
button.addEventListener("click", () => {
  button.textContent = label(increment());
});
