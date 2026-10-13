// Counts the monotone lattice paths through a grid, a small dynamic program the
// obfuscated worker must still get right.
function latticePaths(rows, cols) {
  const table = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(1));
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      table[r][c] = table[r - 1][c] + table[r][c - 1];
    }
  }
  return table[rows][cols];
}

self.addEventListener("message", (event) => {
  const { rows, cols } = event.data;
  self.postMessage(`${latticePaths(rows, cols)} paths through a ${rows}x${cols} grid`);
});
