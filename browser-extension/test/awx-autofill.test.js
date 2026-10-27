import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(new URL("../awx-autofill.js", import.meta.url), "utf8");

function runAutofill({ subdomain = "qa-suporte", sessionUrl = "https://qa-suporte.digisac.chat", requestId = "request-identifier-123", returnOrigin = "https://tool.example", referrer = "https://tool.example/", inputs = [], controls = [], addInputOnLaunch = false, templateId = "59", hash, pendingJob, statusText = "", acknowledgeOutput = true, ackDownloadStarted = true } = {}) {
  const params = new URLSearchParams({
    awx_probe_subdomain: subdomain,
    awx_probe_session_url: sessionUrl,
    awx_probe_request_id: requestId,
    awx_probe_return_origin: returnOrigin,
  });
  const fragment = hash ?? `/templates/job_template/${templateId}/details?${params}`;
  const location = {
    href: `https://awx-public.ikatec.cloud/#${fragment}`,
    origin: "https://awx-public.ikatec.cloud",
    pathname: "/",
    search: "",
    hash: `#${fragment}`,
    reloadCount: 0,
    reload() { this.reloadCount += 1; },
  };
  const elements = new Map();
  const timers = new Map();
  const timeoutTimers = new Map();
  const session = new Map();
  const postedMessages = [];
  const windowListeners = new Map();
  const runtimeListeners = [];
  const runtimeMessages = [];
  if (pendingJob) session.set("digisac-awx-pending-job-v1", JSON.stringify(pendingJob));
  let launchClicks = 0;
  let activeObserver;
  let nextTimerId = 0;
  let nextTimeoutId = 100;
  const launchButton = {
    tagName: "BUTTON",
    innerText: "Launch",
    textContent: "Launch",
    disabled: false,
    getAttribute: () => null,
    click() {
      launchClicks += 1;
      if (addInputOnLaunch) {
        inputs.push(makeInput());
        activeObserver?.callback();
      }
    },
  };
  const document = {
    referrer,
    body: { innerText: statusText, appendChild(element) { elements.set(element.id, element); } },
    querySelectorAll(selector) {
      return selector.includes("input[") || selector.includes("input:not")
        ? inputs
        : selector.includes("button") ? [launchButton, ...controls] : [];
    },
    getElementById: (id) => elements.get(id) || null,
    createElement: () => ({ style: {}, setAttribute() {}, textContent: "" }),
  };
  class MutationObserverMock {
    constructor(callback) { this.callback = callback; activeObserver = this; }
    observe() {}
    disconnect() {}
  }
  const inputPrototype = {};
  const opener = {
    postMessage(message, targetOrigin) {
      postedMessages.push({ message, targetOrigin });
      if (message.type === "digisac-awx-webhook-output" && acknowledgeOutput) {
        windowListeners.get("message")?.({
          origin: returnOrigin,
          source: opener,
          data: {
            type: "digisac-awx-output-received",
            requestId: message.requestId,
            downloadStarted: ackDownloadStarted,
          },
        });
      }
    },
  };
  Object.defineProperty(inputPrototype, "value", {
    set(value) { this._value = value; },
    get() { return this._value || ""; },
  });
  const context = {
    URL,
    URLSearchParams,
    Date,
    location,
    document,
    history: { state: null, replaceState(_state, _title, url) { this.lastUrl = url; } },
    sessionStorage: {
      getItem(key) { return session.get(key) ?? null; },
      setItem(key, value) { session.set(key, String(value)); },
      removeItem(key) { session.delete(key); },
    },
    MutationObserver: MutationObserverMock,
    HTMLInputElement: { prototype: inputPrototype },
    HTMLTextAreaElement: { prototype: {} },
    Event: class EventMock { constructor(type, options) { this.type = type; this.bubbles = options.bubbles; } },
    setInterval(callback) { const id = ++nextTimerId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, delay = 0) {
      if (delay >= 1000) {
        const id = ++nextTimeoutId;
        timeoutTimers.set(id, callback);
        return id;
      }
      callback();
      return 1;
    },
    clearTimeout(id) { timeoutTimers.delete(id); },
    window: {
      opener,
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      removeEventListener(type, listener) {
        if (windowListeners.get(type) === listener) windowListeners.delete(type);
      },
    },
    chrome: {
      runtime: {
        id: "digisac-awx-test-extension",
        lastError: null,
        onMessage: {
          addListener(listener) { runtimeListeners.push(listener); },
          removeListener(listener) {
            const index = runtimeListeners.indexOf(listener);
            if (index >= 0) runtimeListeners.splice(index, 1);
          },
        },
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          callback(message.type === "AWX_EXPECT_OUTPUT_DOWNLOAD" ? { registered: true } : { granted: true });
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(script, context);
  return {
    inputs,
    elements,
    context,
    timers,
    session,
    postedMessages,
    runtimeMessages,
    opener,
    deliverOutputFile(message) {
      for (const listener of [...runtimeListeners]) listener(message, { id: "digisac-awx-test-extension" }, () => {});
    },
    runTimers() { for (const callback of timers.values()) callback(); },
    runTimeouts() {
      const callbacks = [...timeoutTimers.values()];
      timeoutTimers.clear();
      for (const callback of callbacks) callback();
    },
    flushAsync() { return new Promise((resolve) => setImmediate(resolve)); },
    get launchCount() { return launchClicks; },
  };
}

function makeInput(value = "") {
  const input = {
    tagName: "INPUT",
    _value: value,
    labels: [{ innerText: "Subdomain *", textContent: "Subdomain *" }],
    disabled: false,
    events: [],
    dispatchEvent(event) { this.events.push(event.type); },
    getAttribute: () => null,
  };
  Object.defineProperty(input, "value", {
    get() { return inputPrototypeValue.callGet(this); },
    set(next) { inputPrototypeValue.callSet(this, next); },
  });
  return input;
}

function makeControl(label) {
  return {
    innerText: label,
    textContent: label,
    disabled: false,
    clicks: 0,
    getAttribute: () => null,
    click() { this.clicks += 1; },
  };
}

const inputPrototypeValue = {
  callGet(element) { return element._value || ""; },
  callSet(element, value) { element._value = value; },
};

test("opens the template launch form and fills only the required Subdomain field", () => {
  const state = runAutofill({ addInputOnLaunch: true });
  assert.equal(state.launchCount, 1);
  assert.equal(state.inputs[0].value, "qa-suporte");
  assert.deepEqual(state.inputs[0].events, ["input", "change"]);
  assert.match([...state.elements.values()][0].textContent, /inicie o job manualmente/i);
  assert.match(state.context.history.lastUrl, /#\/templates\/job_template\/59\/details$/);
  const monitor = JSON.parse(state.session.get("digisac-awx-pending-job-v1"));
  assert.equal(monitor.sourceSessionUrl, "https://qa-suporte.digisac.chat");
  assert.equal(monitor.sourceSubdomain, "qa-suporte");
  assert.equal(monitor.requestId, "request-identifier-123");
  assert.equal(monitor.returnOrigin, "https://tool.example");
  assert.equal(monitor.templateId, "59");
});

test("opens the job template 88 form and associates the session with queue processes", () => {
  const state = runAutofill({ templateId: "88", inputs: [makeInput()] });

  assert.equal(state.inputs[0].value, "qa-suporte");
  assert.match([...state.elements.values()][0].textContent, /inicie o job manualmente/i);
  const monitor = JSON.parse(state.session.get("digisac-awx-pending-job-v1"));
  assert.equal(monitor.templateId, "88");
  assert.equal(monitor.sourceSessionUrl, "https://qa-suporte.digisac.chat");
});

test("preserves an existing Subdomain value instead of replacing it", () => {
  const state = runAutofill({ inputs: [makeInput("manual-value")] });
  assert.equal(state.launchCount, 0);
  assert.equal(state.inputs[0].value, "manual-value");
  assert.match([...state.elements.values()][0].textContent, /já havia um valor/i);
});

test("rejects a return origin that does not match the page that opened AWX", () => {
  const state = runAutofill({ inputs: [makeInput()], referrer: "https://other-tool.example/" });
  const monitor = JSON.parse(state.session.get("digisac-awx-pending-job-v1"));

  assert.equal(monitor.returnOrigin, "");
});

test("recognizes when the user manually launches the job", () => {
  const state = runAutofill({ inputs: [makeInput()] });
  assert.match([...state.elements.values()][0].textContent, /inicie o job manualmente/i);
  assert.ok(state.session.has("digisac-awx-pending-job-v1"));

  state.context.location.hash = "#/jobs/playbook/864/output";
  state.runTimers();

  assert.match([...state.elements.values()][0].textContent, /job iniciado no awx \(id 864\)/i);
  const saved = JSON.parse(state.session.get("digisac-awx-pending-job-v1"));
  assert.equal(saved.jobId, "864");
  assert.equal(saved.jobRoute, "/jobs/playbook/864/output");
  assert.equal(saved.sourceSessionUrl, "https://qa-suporte.digisac.chat");
});

test("recognizes a job after the AWX page reloads in the same tab", () => {
  const reloaded = runAutofill({
    hash: "/jobs/playbook/865/output",
    pendingJob: { armedAt: Date.now() },
  });
  reloaded.runTimers();

  assert.match([...reloaded.elements.values()][0].textContent, /job iniciado no awx \(id 865\)/i);
});

test("clears the in-progress job tracking when its Exportador page closes", () => {
  const state = runAutofill({ inputs: [makeInput()] });
  assert.ok(state.session.has("digisac-awx-pending-job-v1"));

  state.opener.closed = true;
  state.runTimers();

  assert.equal(state.session.has("digisac-awx-pending-job-v1"), false);
  assert.equal(state.timers.size, 0);
});

test("imports an already completed job URL and starts its output download", () => {
  const query = new URLSearchParams({
    awx_probe_subdomain: "qa-suporte",
    awx_probe_session_url: "https://qa-suporte.digisac.chat",
    awx_probe_request_id: "existing-job-request-273282",
    awx_probe_return_origin: "https://tool.example",
    awx_probe_job_id: "273282",
    awx_probe_template_id: "59",
  });
  const download = makeControl("Download Output");
  const state = runAutofill({
    hash: `/jobs/playbook/273282/output?${query}`,
    controls: [download],
  });

  const pending = JSON.parse(state.session.get("digisac-awx-pending-job-v1"));
  assert.equal(pending.jobId, "273282");
  assert.equal(pending.importedExistingJob, true);
  assert.equal(pending.sourceSessionUrl, "https://qa-suporte.digisac.chat");
  assert.equal(pending.requestId, "existing-job-request-273282");
  assert.equal(download.clicks, 1);
  assert.ok(state.runtimeMessages.some(({ type }) => type === "AWX_EXPECT_OUTPUT_DOWNLOAD"));
  assert.match(state.context.history.lastUrl, /#\/jobs\/playbook\/273282\/output$/);
});

test("does not treat Relaunch and Download Output alone as proof the job finished", () => {
  const relaunch = makeControl("Relaunch");
  const download = makeControl("Download Output");
  const details = makeControl("Details");
  const state = runAutofill({ inputs: [makeInput()], controls: [relaunch, download, details] });

  assert.equal(download.clicks, 0);
  state.context.location.hash = "#/jobs/playbook/866/output";
  state.runTimers();

  assert.equal(relaunch.clicks, 0);
  assert.equal(download.clicks, 0);
  assert.equal(details.clicks, 1);
});

test("does not download while the Details page reports Running, even if download controls are visible", () => {
  const download = makeControl("Download Output");
  const relaunch = makeControl("Relaunch");
  const state = runAutofill({
    hash: "/jobs/playbook/869/details",
    pendingJob: { armedAt: Date.now(), jobId: "869", startedAt: Date.now(), lastRefreshAt: Date.now() },
    statusText: "Job Details\nStatus\nRunning",
    controls: [download, relaunch],
  });

  assert.equal(download.clicks, 0);
});

test("does not refresh before 90 seconds while the reported status is still running", () => {
  const now = Date.now();
  const state = runAutofill({
    hash: "/jobs/playbook/867/details",
    pendingJob: { armedAt: now, jobId: "867", startedAt: now - 80_000, lastRefreshAt: now - 80_000 },
    statusText: "Job Details\nStatus\nRunning",
  });

  assert.equal(state.context.location.reloadCount, 0);
});

test("refreshes a Details page after 90 seconds when the reported status is still running", () => {
  const now = Date.now();
  const state = runAutofill({
    hash: "/jobs/playbook/867/details",
    pendingJob: { armedAt: now, jobId: "867", startedAt: now - 100_000, lastRefreshAt: now - 100_000 },
    statusText: "Job Details\nStatus\nRunning",
  });

  assert.equal(state.context.location.reloadCount, 1);
  const saved = JSON.parse(state.session.get("digisac-awx-pending-job-v1"));
  assert.ok(saved.lastRefreshAt >= now);
});

test("captures the downloaded TXT and sends its contents to the tool", async () => {
  const outputTab = makeControl("Output");
  const download = makeControl("Download Output");
  const state = runAutofill({
    hash: "/jobs/playbook/868/details",
    pendingJob: {
      armedAt: Date.now(),
      jobId: "868",
      startedAt: Date.now(),
      lastRefreshAt: Date.now(),
      requestId: "request-identifier-123",
      returnOrigin: "https://tool.example",
      sourceSessionUrl: "https://qa-suporte.digisac.chat",
      sourceSubdomain: "qa-suporte",
    },
    statusText: "Job Details\nStatus\nSuccessful",
    controls: [outputTab, download],
  });

  assert.equal(outputTab.clicks, 1);
  assert.equal(download.clicks, 0);
  state.context.location.hash = "#/jobs/playbook/868/output";
  state.context.document.body.innerText = "Output page with a Download Output button";
  state.runTimers();
  await state.flushAsync();

  assert.equal(download.clicks, 1, "the extension clicks AWX to create the TXT download it will capture");
  assert.ok(state.runtimeMessages.some(({ type }) => type === "AWX_EXPECT_OUTPUT_DOWNLOAD"));
  const registration = state.runtimeMessages.find(({ type }) => type === "AWX_EXPECT_OUTPUT_DOWNLOAD");
  assert.equal(registration.templateId, "59");
  assert.equal(registration.subdomain, "qa-suporte");
  assert.equal(state.postedMessages.length, 0, "the tool waits for the downloaded file content");
  state.deliverOutputFile({
    type: "AWX_OUTPUT_FILE_CAPTURED",
    requestId: "request-identifier-123",
    jobId: "868",
    ok: true,
    output: "{\"webhooks\":[{\"id\":\"hook-1\"}]}",
  });
  await state.flushAsync();

  assert.match([...state.elements.values()][0].textContent, /txt baixou e o output apareceu na ferramenta/i);
  assert.ok(JSON.parse(state.session.get("digisac-awx-pending-job-v1")).downloadClickedAt);
  const delivered = state.postedMessages.at(-1);
  assert.equal(delivered.targetOrigin, "https://tool.example");
  assert.equal(delivered.message.type, "digisac-awx-webhook-output");
  assert.equal(delivered.message.requestId, "request-identifier-123");
  assert.equal(delivered.message.filename, "awx-webhooks-qa-suporte-868.txt");
  assert.equal(delivered.message.fileAlreadyDownloaded, true);
  assert.match(delivered.message.output, /\"webhooks\"/);
});

test("names job 88 output as a process queue result", async () => {
  const download = makeControl("Download Output");
  const state = runAutofill({
    hash: "/jobs/playbook/871/output",
    pendingJob: {
      armedAt: Date.now(),
      jobId: "871",
      startedAt: Date.now(),
      lastRefreshAt: Date.now(),
      status: "successful",
      requestId: "request-identifier-123",
      returnOrigin: "https://tool.example",
      sourceSessionUrl: "https://qa-suporte.digisac.chat",
      sourceSubdomain: "qa-suporte",
      templateId: "88",
    },
    controls: [download],
    statusText: "Output\n[{\"queue\":\"worker\"}]",
  });

  state.runTimers();
  await state.flushAsync();
  state.deliverOutputFile({
    type: "AWX_OUTPUT_FILE_CAPTURED",
    requestId: "request-identifier-123",
    jobId: "871",
    ok: true,
    output: "[{\"queue\":\"worker\"}]",
  });
  await state.flushAsync();
  const outputMessage = state.postedMessages.find(({ message }) => message.type === "digisac-awx-webhook-output");
  assert.equal(outputMessage.message.filename, "awx-process-queue-qa-suporte-871.txt");
  const registration = state.runtimeMessages.find(({ type }) => type === "AWX_EXPECT_OUTPUT_DOWNLOAD");
  assert.equal(registration.templateId, "88");
  assert.equal(registration.subdomain, "qa-suporte");
  assert.equal(download.clicks, 1);
});

test("reports to the tool when AWX downloaded the file but its content could not be read", async () => {
  const state = runAutofill({
    hash: "/jobs/playbook/870/output",
    pendingJob: {
      armedAt: Date.now(),
      jobId: "870",
      startedAt: Date.now(),
      lastRefreshAt: Date.now(),
      status: "successful",
      requestId: "request-identifier-123",
      returnOrigin: "https://tool.example",
      sourceSessionUrl: "https://qa-suporte.digisac.chat",
      sourceSubdomain: "qa-suporte",
    },
    controls: [makeControl("Download Output")],
    statusText: "Output\n{\"webhooks\":[]}",
  });

  state.runTimers();
  await state.flushAsync();
  state.deliverOutputFile({
    type: "AWX_OUTPUT_FILE_CAPTURED",
    requestId: "request-identifier-123",
    jobId: "870",
    ok: false,
    error: "AWX_OUTPUT_READ_FAILED",
  });
  await state.flushAsync();

  const delivered = state.postedMessages.find(({ message }) => message.type === "digisac-awx-webhook-output");
  assert.equal(delivered.message.output, "");
  assert.match(delivered.message.error, /não conseguiu ler seu conteúdo/i);
  assert.match([...state.elements.values()][0].textContent, /baixou o txt, mas não foi possível exibir/i);
});
