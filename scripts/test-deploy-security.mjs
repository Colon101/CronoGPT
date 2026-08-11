#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/main.yml", import.meta.url), "utf8");
const deploy = readFileSync(new URL("./oracle/deploy.sh", import.meta.url), "utf8");
const compose = readFileSync(new URL("../deploy/oracle/docker-compose.yml", import.meta.url), "utf8");

assert.doesNotMatch(workflow, /ssh-keyscan/, "CI must never trust a host key learned from the deployment network");
assert.match(workflow, /ORACLE_SSH_HOST_KEY:\s*\$\{\{ secrets\.ORACLE_SSH_HOST_KEY \}\}/);
assert.match(workflow, /for key in ORACLE_SSH_PRIVATE_KEY ORACLE_SSH_HOST_KEY/);
assert.ok((workflow.match(/StrictHostKeyChecking=yes/g) ?? []).length >= 2, "every workflow SSH call must enforce strict host checking");
assert.ok((workflow.match(/UserKnownHostsFile=/g) ?? []).length >= 2, "every workflow SSH call must name the pinned known_hosts file");
assert.ok((workflow.match(/GlobalKnownHostsFile=\/dev\/null/g) ?? []).length >= 2, "workflow SSH must not accept an unpinned global host key");

assert.match(deploy, /ORACLE_SSH_KNOWN_HOSTS:\?Set ORACLE_SSH_KNOWN_HOSTS/);
assert.match(deploy, /StrictHostKeyChecking=yes/);
assert.match(deploy, /UserKnownHostsFile=/);
assert.match(deploy, /GlobalKnownHostsFile=\/dev\/null/);
assert.match(deploy, /RSYNC_SSH/);
for (const line of deploy.split("\n").filter((candidate) => /(?:^|\|)\s*ssh\s/.test(candidate))) {
  assert.match(line, /"\$\{SSH_ARGS\[@\]\}"/, `deploy SSH call must use the strict shared arguments: ${line.trim()}`);
}
assert.match(compose, /headers:\{host:process\.env\.CRONOGPT_DOMAIN\}/, "production healthcheck must use the configured public Host");

console.log("deployment SSH trust checks passed");
