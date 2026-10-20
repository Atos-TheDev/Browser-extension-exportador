chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "deliver-capture"
    || typeof message.requestId !== "string"
    || typeof message.url !== "string"
    || typeof message.token !== "string") {
    return false;
  }

  let attempts = 0;
  let retryTimer;
  let settled = false;
  const onAcknowledgement = (event) => {
    if (event.source !== window
      || event.origin !== window.location.origin
      || event.data?.type !== "digisac-extension-capture-ack"
      || event.data.requestId !== message.requestId) return;
    settled = true;
    clearTimeout(retryTimer);
    window.removeEventListener("message", onAcknowledgement);
    sendResponse({ accepted: event.data.accepted === true });
  };
  const deliverToPage = () => {
    if (settled) return;
    if (attempts >= 40) {
      settled = true;
      window.removeEventListener("message", onAcknowledgement);
      sendResponse({ accepted: false });
      return;
    }
    attempts += 1;
    window.postMessage({
      type: "digisac-extension-capture",
      requestId: message.requestId,
      url: message.url,
      token: message.token,
    }, window.location.origin);
    retryTimer = setTimeout(deliverToPage, 250);
  };
  window.addEventListener("message", onAcknowledgement);
  deliverToPage();
  return true;
});
