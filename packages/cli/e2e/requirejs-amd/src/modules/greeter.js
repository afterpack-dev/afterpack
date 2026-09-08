// AMD module with a dependency -- proves the encoded dependency id ("calc")
// still resolves through require.js after obfuscation, and the injected module
// object is used normally inside the factory.
define("greeter", ["calc"], function (calc) {
  "use strict";
  return {
    greet: function (name) {
      return "Hello, " + name + "! sum=" + calc.add(2, 3);
    },
  };
});
