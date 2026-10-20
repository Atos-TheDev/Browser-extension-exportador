const EXPORTER_URL = "https://exportador-digisac.atos-prado.workers.dev/";
const DIGISAC_MATCHES = [
  "https://*.digisac.me/*",
  "https://*.digisac.app/*",
  "https://*.digisac.co/*",
  "https://*.digisac.chat/*",
  "https://*.digisac.io/*",
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
    && /\.(?:digisac\.me|digisac\.app|digisac\.co|digisac\.chat|digisac\.io)$/i.test(url.hostname);
}
