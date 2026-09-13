import { rm } from "node:fs/promises";

await Promise.all(
  ["dist", "dist-electron"].map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ),
);
