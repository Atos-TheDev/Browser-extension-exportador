import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(new URL("../background.js", import.meta.url), "utf8");

function loadBackground() {
  let listener;
  let downloadListener;
  const storage = new Map();
  const sessionStorage = new Map();
  const sentToTabs = [];
  let lastInjection;
  const context = {
    Date,
    URL,
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) { listener = callback; },
        },
      },
      storage: {
        local: {
          async get(key) { return { [key]: storage.get(key) }; },
          async set(values) {
            for (const [key, value] of Object.entries(values)) storage.set(key, value);
          },
        },
        session: {
          async get(key) { return { [key]: sessionStorage.get(key) }; },
          async set(values) {
            for (const [key, value] of Object.entries(values)) sessionStorage.set(key, value);
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) sessionStorage.delete(key);
          },
        },
      },
      webRequest: {
        onBeforeSendHeaders: { addListener() {} },
      },
      downloads: {
        onCreated: { addListener(callback) { downloadListener = callback; } },
      },
      scripting: {
        async executeScript(injection) {
          lastInjection = injection;
          return [{ result: { ok: true, text: "{\"actual\":\"downloaded output\"}" } }];
        },
      },
      tabs: {
        onUpdated: { addListener() {} },
        async sendMessage(tabId, message) { sentToTabs.push({ tabId, message }); },
      },
    },
  };
  vm.runInNewContext(script, context);

  function requestRefresh() {
    return new Promise((resolve) => {
      const keepChannelOpen = listener({ type: "AWX_JOB_REFRESH_SLOT" }, { tab: { id: 1 } }, resolve);
      assert.equal(keepChannelOpen, true);
    });
  }

  function expectOutputDownload({ tabId = 41, requestId = "request-output-123", jobId = "123", senderUrl = "https://awx-public.ikatec.cloud/#/jobs/playbook/123/output" } = {}) {
    return new Promise((resolve) => {
      const keepChannelOpen = listener({ type: "AWX_EXPECT_OUTPUT_DOWNLOAD", requestId, jobId }, {
        tab: { id: tabId },
        url: senderUrl,
      }, resolve);
      assert.equal(keepChannelOpen, true);
    });
  }

  return { requestRefresh, expectOutputDownload, storage, sessionStorage, sentToTabs, get lastInjection() { return lastInjection; }, get downloadListener() { return downloadListener; } };
}

test("serializes refreshes from multiple tabs with at least 30 seconds between them", async () => {
  const background = loadBackground();
  const [first, second] = await Promise.all([background.requestRefresh(), background.requestRefresh()]);

  assert.equal(first.granted, true);
  assert.equal(second.granted, false);
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 30_000);

  background.storage.set("digisacAwxLastJobRefreshAt", Date.now() - 31_000);
  const later = await background.requestRefresh();
  assert.equal(later.granted, true);
});

test("captures the expected AWX TXT download and sends its contents to that job tab", async () => {
  const background = loadBackground();
  const registered = await background.expectOutputDownload();
  assert.equal(registered.registered, true);

  await background.downloadListener({
    id: 81,
    url: "https://awx-public.ikatec.cloud/api/v2/jobs/123/stdout/?format=txt_download",
    referrer: "https://awx-public.ikatec.cloud/#/jobs/playbook/123/output",
    filename: "/home/user/Downloads/job_123.txt",
  });

  assert.equal(background.lastInjection.world, "MAIN");
  assert.equal(background.lastInjection.target.tabId, 41);
  assert.equal(background.lastInjection.args[0], "https://awx-public.ikatec.cloud/api/v2/jobs/123/stdout/?format=txt_download");
  assert.equal(background.sentToTabs[0].tabId, 41);
  assert.equal(background.sentToTabs[0].message.requestId, "request-output-123");
  assert.equal(background.sentToTabs[0].message.output, "{\"actual\":\"downloaded output\"}");
  assert.equal(Object.keys(background.sessionStorage.get("digisacAwxPendingOutputDownloads")).length, 0);
});

test("matches concurrent downloads by job ID and routes each result to its registered tab", async () => {
  const background = loadBackground();
  await background.expectOutputDownload({ tabId: 41, requestId: "request-output-123", jobId: "123" });
  await background.expectOutputDownload({
    tabId: 42,
    requestId: "request-output-456",
    jobId: "456",
    senderUrl: "https://awx-public.ikatec.cloud/#/jobs/playbook/456/output",
  });

  await background.downloadListener({
    id: 82,
    url: "https://awx-public.ikatec.cloud/api/v2/jobs/456/stdout/?format=txt_download",
    referrer: "https://awx-public.ikatec.cloud/",
    filename: "/home/user/Downloads/job_456.txt",
  });

  assert.equal(background.lastInjection.target.tabId, 42);
  assert.equal(background.sentToTabs[0].tabId, 42);
  assert.equal(background.sentToTabs[0].message.requestId, "request-output-456");

  await background.downloadListener({
    id: 83,
    url: "https://awx-public.ikatec.cloud/api/v2/jobs/123/stdout/?format=txt_download",
    referrer: "https://awx-public.ikatec.cloud/",
    filename: "/home/user/Downloads/job_123.txt",
  });

  assert.equal(background.lastInjection.target.tabId, 41);
  assert.equal(background.sentToTabs[1].tabId, 41);
  assert.equal(background.sentToTabs[1].message.requestId, "request-output-123");
  assert.equal(Object.keys(background.sessionStorage.get("digisacAwxPendingOutputDownloads")).length, 0);
});

test("does not register an output capture request from outside AWX", async () => {
  const background = loadBackground();
  const registered = await background.expectOutputDownload({
    senderUrl: "https://attacker.example/#/jobs/playbook/123/output",
  });

  assert.equal(registered.registered, false);
  assert.equal(background.sessionStorage.get("digisacAwxPendingOutputDownloads"), undefined);
});

test("rejects a download URL for another job even if its filename matches the expected job", async () => {
  const background = loadBackground();
  await background.expectOutputDownload();

  await background.downloadListener({
    id: 83,
    tabId: 41,
    url: "https://awx-public.ikatec.cloud/api/v2/jobs/999/stdout/?format=txt_download",
    referrer: "https://awx-public.ikatec.cloud/#/jobs/playbook/999/output",
    filename: "/home/user/Downloads/job_123.txt",
  });

  assert.equal(background.lastInjection, undefined);
  assert.equal(background.sentToTabs.length, 0);
});

test("does not read a matching filename hosted outside AWX", async () => {
  const background = loadBackground();
  await background.expectOutputDownload();

  await background.downloadListener({
    id: 84,
    tabId: 41,
    url: "https://files.example/job_123.txt",
    referrer: "https://awx-public.ikatec.cloud/#/jobs/playbook/123/output",
    filename: "/home/user/Downloads/job_123.txt",
  });

  assert.equal(background.lastInjection, undefined);
  assert.equal(background.sentToTabs.length, 0);
});

test("matches the AWX job filename when the download URL does not contain a job route", async () => {
  const background = loadBackground();
  await background.expectOutputDownload();

  await background.downloadListener({
    id: 85,
    url: "blob:https://awx-public.ikatec.cloud/a-b-c",
    referrer: "https://awx-public.ikatec.cloud/",
    filename: "/home/user/Downloads/job_123.txt",
  });

  assert.equal(background.lastInjection.target.tabId, 41);
  assert.equal(background.sentToTabs[0].message.jobId, "123");
});
