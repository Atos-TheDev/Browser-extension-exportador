const $ = (selector) => document.querySelector(selector);

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "capture-status" });
  $("#start").classList.toggle("hidden", status.active || status.sending);
  $("#cancel").classList.toggle("hidden", !status.active && !status.sending);
  if (status.active) {
    setStatus("Captura ativa. Aguardando uma nova requisição autenticada da aba Digisac.", "waiting");
  } else if (status.sending) {
    setStatus("Token encontrado. Entregando ao Exportador…", "waiting");
  } else {
    setStatus(status.lastStatus?.text || "", status.lastStatus?.kind || "");
  }
}

function setStatus(text, kind) {
  $("#status").textContent = text;
  $("#status").className = kind;
}

$("#start").addEventListener("click", async () => {
  $("#start").disabled = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({
    type: "start-capture",
    tabId: tab?.id,
    tabUrl: tab?.url,
  });
  if (!result?.ok) {
    setStatus(result?.error || "Não foi possível iniciar a captura.", "error");
    $("#start").disabled = false;
    return;
  }
  await refresh();
});

$("#cancel").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "cancel-capture" });
  await refresh();
});

void refresh();
