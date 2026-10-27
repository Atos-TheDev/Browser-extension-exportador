const EXPORTER_URL = "https://exportador-digisac.atos-prado.workers.dev/";
const DIGISAC_MATCHES = [
  "https://*.digisac.me/*",
  "https://*.digisac.app/*",
  "https://*.digisac.co/*",
  "https://*.digisac.chat/*",
  "https://*.digisac.io/*",
  "https://*.digisac.biz/*",
];

let captureQueue = Promise.resolve();
const activeRelays = new Set();

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    captureQueue = captureQueue.then(() => inspectRequest(details)).catch(async () => {
      await chrome.storage.session.remove(["activeCapture", "pendingHandoff"]);
      await chrome.storage.session.set({
        lastStatus: { text: "A captura falhou. Reabra a extensão para tentar novamente.", kind: "error" },
      });
      await chrome.action.setBadgeText({ text: "" });
    });
  },
  { urls: DIGISAC_MATCHES },
  ["requestHeaders", "extraHeaders"],
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "start-capture") {
    void startCapture(message.tabId, message.tabUrl).then(sendResponse);
    return true;
  }
  if (message?.type === "cancel-capture") {
    void cancelCapture().then(sendResponse);
    return true;
  }
  if (message?.type === "capture-status") {
    void readStatus().then(sendResponse);
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void relayPendingHandoff(tabId);
});

async function startCapture(tabId, tabUrl) {
  if (!Number.isInteger(tabId) || !isDigisacUrl(tabUrl)) {
    return { ok: false, error: "Abra uma página HTTPS de um domínio Digisac suportado e tente novamente." };
  }
  const { pendingHandoff } = await chrome.storage.session.get("pendingHandoff");
  if (pendingHandoff) {
    return { ok: false, error: "Uma captura anterior ainda está sendo enviada ao Exportador." };
  }
  await chrome.storage.session.set({
    activeCapture: { tabId, tabUrl, startedAt: Date.now() },
    lastStatus: { text: "Aguardando a próxima requisição autenticada da página Digisac.", kind: "waiting" },
  });
  await chrome.action.setBadgeText({ text: "ON" });
  await chrome.action.setBadgeBackgroundColor({ color: "#6855e8" });
  return { ok: true };
}

async function cancelCapture() {
  await chrome.storage.session.remove(["activeCapture", "pendingHandoff"]);
  await chrome.storage.session.set({
    lastStatus: { text: "Captura cancelada.", kind: "idle" },
  });
  await chrome.action.setBadgeText({ text: "" });
  return { ok: true };
}

async function inspectRequest(details) {
  const { activeCapture } = await chrome.storage.session.get("activeCapture");
  if (!activeCapture || details.tabId !== activeCapture.tabId) return;

  const requestUrl = new URL(details.url);
  if (!isDigisacUrl(requestUrl.href)) return;
  const apiPath = requestUrl.pathname.match(/^(.*)\/api\/v1(?:\/|$)/i);
  if (!apiPath) return;

  const authorization = details.requestHeaders?.find((header) =>
    header.name.toLowerCase() === "authorization")?.value;
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!bearer || bearer[1].length > 8192) return;

  const baseUrl = `${requestUrl.origin}${apiPath[1]}`.replace(/\/+$/, "");
  await chrome.storage.session.remove("activeCapture");
  await chrome.action.setBadgeText({ text: "" });
  const tab = await chrome.tabs.create({ url: EXPORTER_URL, active: true });
  await chrome.storage.session.set({
    pendingHandoff: {
      tabId: tab.id,
      url: baseUrl,
      token: bearer[1],
    },
    lastStatus: { text: "Token capturado. Enviando URL e token ao Exportador.", kind: "sending" },
  });
  await relayPendingHandoff(tab.id);
}

async function relayPendingHandoff(tabId) {
  if (activeRelays.has(tabId)) return;
  activeRelays.add(tabId);
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { pendingHandoff } = await chrome.storage.session.get("pendingHandoff");
      if (!pendingHandoff || pendingHandoff.tabId !== tabId) return;
      try {
        const result = await chrome.tabs.sendMessage(tabId, {
          type: "deliver-capture",
          requestId: crypto.randomUUID(),
          url: pendingHandoff.url,
          token: pendingHandoff.token,
        });
        if (!result?.accepted) {
          await chrome.storage.session.remove("pendingHandoff");
          await chrome.storage.session.set({
            lastStatus: { text: "O Exportador não aceitou a captura. Tente novamente.", kind: "error" },
          });
          return;
        }
        await chrome.storage.session.remove("pendingHandoff");
        await chrome.storage.session.set({
          lastStatus: { text: "A URL e o token foram entregues ao Exportador.", kind: "success" },
        });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await chrome.storage.session.remove("pendingHandoff");
    await chrome.storage.session.set({
      lastStatus: { text: "Não foi possível enviar o token. Tente novamente.", kind: "error" },
    });
  } finally {
    activeRelays.delete(tabId);
  }
}

async function readStatus() {
  const { activeCapture, pendingHandoff, lastStatus } =
    await chrome.storage.session.get(["activeCapture", "pendingHandoff", "lastStatus"]);
  return { active: Boolean(activeCapture), sending: Boolean(pendingHandoff), lastStatus };
}

function isDigisacUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && /\.(?:digisac\.me|digisac\.app|digisac\.co|digisac\.chat|digisac\.io|digisac\.biz)$/i.test(url.hostname);
}
const LAST_JOB_REFRESH_AT_KEY = "digisacAwxLastJobRefreshAt";
const PENDING_OUTPUT_DOWNLOADS_KEY = "digisacAwxPendingOutputDownloads";
const MIN_JOB_REFRESH_GAP_MS = 30 * 1000;
const OUTPUT_DOWNLOAD_TTL_MS = 60 * 1000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const AWX_ORIGIN = "https://awx-public.ikatec.cloud";
const AWX_OUTPUT_TEMPLATE_LABELS = { "59": "webhooks", "88": "process-queue" };

let reservationQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "AWX_EXPECT_OUTPUT_DOWNLOAD") {
    registerExpectedOutputDownload(message, _sender)
      .then(sendResponse)
      .catch(() => sendResponse({ registered: false }));
    return true;
  }

  if (message?.type !== "AWX_JOB_REFRESH_SLOT") return false;

  const reservation = reservationQueue.then(reserveRefreshSlot);
  reservationQueue = reservation.catch(() => undefined);
  reservation.then(sendResponse).catch(() => sendResponse({ granted: false, retryAfterMs: 5000 }));
  return true;
});

chrome.downloads.onCreated.addListener((downloadItem) => {
  return captureExpectedOutputDownload(downloadItem).catch(() => undefined);
});

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const safeDownloadUrl = getAllowedAwxDownloadUrl(downloadItem?.url, downloadItem?.referrer)
    || getAllowedAwxDownloadUrl(downloadItem?.finalUrl, downloadItem?.referrer);
  const jobId = safeDownloadUrl ? getDownloadedJobId(downloadItem, safeDownloadUrl) : "";
  if (!jobId) {
    suggest();
    return;
  }

  getExpectedOutputFilename(jobId)
    .then((filename) => suggest(filename ? { filename, conflictAction: "uniquify" } : undefined))
    .catch(() => suggest());
  return true;
});

async function reserveRefreshSlot() {
  const stored = await chrome.storage.local.get(LAST_JOB_REFRESH_AT_KEY);
  const lastRefreshAt = Number(stored[LAST_JOB_REFRESH_AT_KEY]) || 0;
  const now = Date.now();
  const retryAfterMs = lastRefreshAt + MIN_JOB_REFRESH_GAP_MS - now;

  if (retryAfterMs > 0) return { granted: false, retryAfterMs };

  await chrome.storage.local.set({ [LAST_JOB_REFRESH_AT_KEY]: now });
  return { granted: true };
}

async function registerExpectedOutputDownload(message, sender) {
  const tabId = sender.tab?.id;
  let senderOrigin = "";
  try {
    senderOrigin = new URL(sender.url || "").origin;
  } catch {}

  if (!Number.isInteger(tabId) || senderOrigin !== AWX_ORIGIN) return { registered: false };
  if (typeof message.requestId !== "string" || message.requestId.length < 8 || message.requestId.length > 128) return { registered: false };
  if (typeof message.jobId !== "string" || !/^\d+$/.test(message.jobId)) return { registered: false };
  const templateId = String(message.templateId || "59");
  const subdomain = String(message.subdomain || "").trim().toLowerCase();
  if (!Object.hasOwn(AWX_OUTPUT_TEMPLATE_LABELS, templateId)
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return { registered: false };

  const stored = await chrome.storage.session.get(PENDING_OUTPUT_DOWNLOADS_KEY);
  const pendingByRequest = stored[PENDING_OUTPUT_DOWNLOADS_KEY] || {};
  const now = Date.now();
  for (const [key, pending] of Object.entries(pendingByRequest)) {
    if (!pending || now - Number(pending.requestedAt) > OUTPUT_DOWNLOAD_TTL_MS) delete pendingByRequest[key];
  }
  pendingByRequest[message.requestId] = {
    requestId: message.requestId,
    jobId: message.jobId,
    tabId,
    filename: buildAwxOutputFilename(templateId, subdomain, message.jobId),
    requestedAt: now,
  };
  await chrome.storage.session.set({ [PENDING_OUTPUT_DOWNLOADS_KEY]: pendingByRequest });
  return { registered: true };
}

async function getExpectedOutputFilename(jobId) {
  const stored = await chrome.storage.session.get(PENDING_OUTPUT_DOWNLOADS_KEY);
  const pendingByRequest = stored[PENDING_OUTPUT_DOWNLOADS_KEY] || {};
  const now = Date.now();
  const matches = Object.values(pendingByRequest)
    .filter((pending) => pending
      && pending.jobId === jobId
      && typeof pending.filename === "string"
      && now - Number(pending.requestedAt) <= OUTPUT_DOWNLOAD_TTL_MS)
    .sort((left, right) => Number(right.requestedAt) - Number(left.requestedAt));
  return matches[0]?.filename || "";
}

function buildAwxOutputFilename(templateId, subdomain, jobId) {
  const label = AWX_OUTPUT_TEMPLATE_LABELS[templateId];
  return `awx-${label}-${subdomain}-${jobId}.txt`;
}

async function captureExpectedOutputDownload(downloadItem) {
  const safeDownloadUrl = getAllowedAwxDownloadUrl(downloadItem?.url, downloadItem?.referrer)
    || getAllowedAwxDownloadUrl(downloadItem?.finalUrl, downloadItem?.referrer);
  if (!safeDownloadUrl) return;

  const downloadedJobId = getDownloadedJobId(downloadItem, safeDownloadUrl);
  if (!downloadedJobId) return;

  const stored = await chrome.storage.session.get(PENDING_OUTPUT_DOWNLOADS_KEY);
  const pendingByRequest = stored[PENDING_OUTPUT_DOWNLOADS_KEY] || {};
  const now = Date.now();
  let removedExpired = false;
  const matches = [];
  for (const [key, pending] of Object.entries(pendingByRequest)) {
    if (!pending || now - Number(pending.requestedAt) > OUTPUT_DOWNLOAD_TTL_MS) {
      delete pendingByRequest[key];
      removedExpired = true;
      continue;
    }
    if (pending.jobId === downloadedJobId && Number.isInteger(pending.tabId) && pending.tabId >= 0) {
      matches.push([key, pending]);
    }
  }
  if (!matches.length) {
    if (removedExpired) await chrome.storage.session.set({ [PENDING_OUTPUT_DOWNLOADS_KEY]: pendingByRequest });
    return;
  }

  // Job IDs are unique in AWX. If the same completed job was opened more than once,
  // associate this download with the most recently armed tab.
  matches.sort((left, right) => Number(right[1].requestedAt) - Number(left[1].requestedAt));
  const [pendingKey, pending] = matches[0];
  const tabId = pending.tabId;
  delete pendingByRequest[pendingKey];
  await chrome.storage.session.set({ [PENDING_OUTPUT_DOWNLOADS_KEY]: pendingByRequest });

  let result = { ok: false, error: "AWX_OUTPUT_READ_FAILED" };
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: readDownloadedText,
      args: [safeDownloadUrl, MAX_OUTPUT_BYTES],
    });
    if (injection?.result?.ok && typeof injection.result.text === "string") {
      result = { ok: true, output: injection.result.text };
    } else if (injection?.result?.error === "AWX_OUTPUT_TOO_LARGE") {
      result = { ok: false, error: "AWX_OUTPUT_TOO_LARGE" };
    }
  } catch {}

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AWX_OUTPUT_FILE_CAPTURED",
      requestId: pending.requestId,
      jobId: pending.jobId,
      ok: result.ok,
      output: result.output || "",
      error: result.error || "",
    });
  } catch {}
}

function getAllowedAwxDownloadUrl(value, referrer) {
  try {
    const url = new URL(value);
    const isAllowedProtocol = url.protocol === "https:" || url.protocol === "blob:";
    if (!isAllowedProtocol || url.origin !== AWX_ORIGIN) return "";
    if (referrer && new URL(referrer).origin !== AWX_ORIGIN) return "";
    return url.href;
  } catch {
    return "";
  }
}

function getDownloadedJobId(downloadItem, downloadUrl) {
  try {
    const urlJobId = new URL(downloadUrl).pathname.match(/\/jobs\/(\d+)\/(?:stdout|output)\/?$/i)?.[1] || "";
    if (urlJobId) return urlJobId;
  } catch {}

  const filename = String(downloadItem?.filename || "").split(/[\\/]/).pop() || "";
  return filename.match(/^job[_-](\d+)\.txt$/i)?.[1] || "";
}

async function readDownloadedText(downloadUrl, maxBytes) {
  try {
    const url = new URL(downloadUrl);
    if ((url.protocol !== "https:" && url.protocol !== "blob:") || url.origin !== "https://awx-public.ikatec.cloud") {
      return { ok: false, error: "AWX_OUTPUT_READ_FAILED" };
    }
    const response = await fetch(downloadUrl, { credentials: "include", cache: "no-store" });
    if (!response.ok) return { ok: false, error: "AWX_OUTPUT_READ_FAILED" };
    const declaredLength = Number(response.headers.get("content-length")) || 0;
    if (declaredLength > maxBytes) return { ok: false, error: "AWX_OUTPUT_TOO_LARGE" };
    if (!response.body?.getReader) {
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > maxBytes) return { ok: false, error: "AWX_OUTPUT_TOO_LARGE" };
      return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let text = "";
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, error: "AWX_OUTPUT_TOO_LARGE" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    return { ok: false, error: "AWX_OUTPUT_READ_FAILED" };
  }
}
