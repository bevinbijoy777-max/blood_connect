import { cp, mkdir, rm } from "node:fs/promises";

const target = "dist/public";

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp("public", target, { recursive: true });

console.log(`copied public/ -> ${target}`);
