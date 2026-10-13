import "./style.css";
import { increment, readCount } from "./state.js";

const button = document.querySelector('[data-testid="counter"]');

button.addEventListener("click", async () => {
  increment();
  const [{ describeCount }, { labelFor }] = await Promise.all([
    import("./describe.js"),
    import("./label.js"),
  ]);
  button.textContent = describeCount(readCount());
  button.title = labelFor(readCount());
});
