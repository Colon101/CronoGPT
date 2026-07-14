#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
rmSync(join(repoRoot, "dist"), { force: true, recursive: true });
