import { cp, mkdir } from "node:fs/promises";

const source = new URL("../node_modules/cesium/Build/Cesium/", import.meta.url);
const target = new URL("../public/cesium/", import.meta.url);

await mkdir(target, { recursive: true });
await Promise.all(
  ["Assets", "ThirdParty", "Widgets", "Workers"].map((directory) =>
    cp(new URL(directory, source), new URL(directory, target), { recursive: true }),
  ),
);
