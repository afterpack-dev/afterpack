// AMD leaf module. Named define() -- the module id "calc" is a string literal
// the obfuscator encodes; if AfterPack preserved AMD semantics it still decodes
// to "calc" at runtime, so require.js registers + resolves it unchanged.
define("calc", [], function () {
  "use strict";
  return {
    add: function (a, b) {
      return a + b;
    },
    mul: function (a, b) {
      return a * b;
    },
  };
});
