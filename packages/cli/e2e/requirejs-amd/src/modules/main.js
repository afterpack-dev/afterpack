// AMD entry (require.js data-main). Uses require() to pull the two obfuscated
// modules at runtime, then wires the DOM -- exercising the whole AMD load +
// resolve + factory-invoke path against obfuscated modules.
require(["calc", "greeter"], function (calc, greeter) {
  "use strict";
  var output = document.querySelector('[data-testid="amd-output"]');
  output.textContent = greeter.greet("AMD") + " product=" + calc.mul(4, 5);

  var button = document.querySelector('[data-testid="counter"]');
  var count = 0;
  button.addEventListener("click", function () {
    count = calc.add(count, 1);
    var parity = count % 2 === 0 ? "even" : "odd";
    button.textContent = "count is " + count + " (" + parity + ")";
  });
});
