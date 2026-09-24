# @afterpack/protection-map

The viewer for the [AfterPack](https://www.afterpack.dev) Protection Map: a single HTML file that
shows your original source, shaded by how strongly each part was protected, with the weak spots a
build left readable.

You usually do not need to install this package. The AfterPack CLI and every AfterPack plugin
already use it to write `.afterpack/protectionMap.html` when your build has source maps. Open that
file in a browser. It works offline, straight from disk. Two options control it:
[`protectionMap.enabled`](https://www.afterpack.dev/docs/config#protectionMap-enabled) turns it on
or off, and [`protectionMap.detailed`](https://www.afterpack.dev/docs/config#protectionMap-detailed)
set to `false` leaves out the per-region list of transformations for a smaller file.

The Protection Map contains your original source. Keep it local: never deploy, publish or commit
it. The AfterPack tools add `.afterpack/` to your `.gitignore` for you.

## Render one yourself

If you have Protection Map data as JSON, render it with the bundled command. The template ships
with the package:

```sh
npx afterpack-protection-map report.json protection-map.html
```

Add `--no-lineage` for a smaller file without the per-region transform history.

Or from Node:

```js
import { writeFileSync } from "node:fs";
import { renderProtectionMapHtml } from "@afterpack/protection-map";

const { html } = renderProtectionMapHtml(data);
writeFileSync("protection-map.html", html);
```

`renderProtectionMapHtml(data, { template, includeLineage })` uses the bundled template unless you
pass one, and includes lineage unless `includeLineage` is `false`.

## Links

- [How to read the Protection Map](https://www.afterpack.dev/docs/protection-map)
- [Presets and protection levels](https://www.afterpack.dev/docs/presets)
- [Complexity](https://www.afterpack.dev/docs/complexity)
- [Directives for protecting specific code](https://www.afterpack.dev/docs/directives)

## License

Apache-2.0.

## Feedback

Questions, suggestions and bug reports: [afterpack.dev/contact](https://www.afterpack.dev/contact).
You can also file a bug on [GitHub Issues](https://github.com/afterpack-dev/afterpack/issues).
