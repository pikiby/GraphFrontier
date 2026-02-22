import esbuild from "esbuild";
import process from "process";

const isProd = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.js"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "browser",
  target: "es2018",
  sourcemap: isProd ? false : "inline",
  minify: false,
  logLevel: "info",
  outfile: "main.js"
});

if (isProd) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
