import esbuild from "esbuild";
import { copyFileSync } from "fs";

const prod = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "codemirror", "@codemirror/*"],
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "main.js",
  sourcemap: prod ? false : "inline",
  minify: prod,
  logLevel: "info",
});

copyFileSync("src/styles.css", "styles.css");
