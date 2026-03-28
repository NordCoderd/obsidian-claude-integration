import fs from "fs";
import path from "path";
import { config } from "dotenv";

config();

const dest = process.env.DEPLOY_DEST;
if (!dest) {
  console.error("Error: DEPLOY_DEST environment variable is not set. Add it to .env");
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync("main.js", path.join(dest, "main.js"));
fs.copyFileSync("manifest.json", path.join(dest, "manifest.json"));
fs.copyFileSync("styles.css", path.join(dest, "styles.css"));

console.log(`Deployed to ${dest}`);
