import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("declares AWX support only for the approved AWX host", () => {
  assert.ok(manifest.host_permissions.includes("https://awx-public.ikatec.cloud/*"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.content_scripts.some((script) =>
    script.matches.includes("https://awx-public.ikatec.cloud/*")
      && script.js.includes("awx-autofill.js")));
});

test("does not include the experimental page-to-JSON capture script", () => {
  const scripts = manifest.content_scripts.flatMap((script) => script.js);
  assert.equal(scripts.includes("capture.js"), false);
});
