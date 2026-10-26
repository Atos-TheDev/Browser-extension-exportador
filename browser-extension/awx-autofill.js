(() => {
  const AWX_ORIGIN = "https://awx-public.ikatec.cloud";
  const SUPPORTED_TEMPLATE_IDS = new Set(["59", "88"]);
  const SUBDOMAIN_PARAM = "awx_probe_subdomain";
  const SESSION_URL_PARAM = "awx_probe_session_url";
  const REQUEST_ID_PARAM = "awx_probe_request_id";
  const RETURN_ORIGIN_PARAM = "awx_probe_return_origin";
  const JOB_ID_PARAM = "awx_probe_job_id";
  const TEMPLATE_ID_PARAM = "awx_probe_template_id";
  const NOTICE_ID = "digisac-awx-notice";
  const JOB_MONITOR_KEY = "digisac-awx-pending-job-v1";
  const JOB_MONITOR_TTL_MS = 60 * 60 * 1000;
  const JOB_MONITOR_POLL_MS = 1000;
  const JOB_REFRESH_INTERVAL_MS = 90 * 1000;
  const JOB_ACTIVE_STATUSES = new Set(["new", "pending", "waiting", "running"]);
  const JOB_TERMINAL_STATUSES = new Set(["successful", "failed", "error", "canceled", "cancelled"]);
  const currentUrl = new URL(location.href);
  const routeAndQuery = location.hash.replace(/^#/, "");
  const queryIndex = routeAndQuery.indexOf("?");
  const route = queryIndex < 0 ? routeAndQuery : routeAndQuery.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? "" : routeAndQuery.slice(queryIndex + 1));
  const templateMatch = route.match(/^\/templates\/job_template\/(\d+)\/details$/);
  const templateId = templateMatch?.[1] || "";
  const subdomain = (query.get(SUBDOMAIN_PARAM) || "").trim().toLowerCase();
  const sourceSessionUrl = normalizeSessionUrl(query.get(SESSION_URL_PARAM) || "");
  const requestId = normalizeRequestId(query.get(REQUEST_ID_PARAM) || "");
  const returnOrigin = normalizeReturnOrigin(query.get(RETURN_ORIGIN_PARAM) || "");
  const importedJobId = query.get(JOB_ID_PARAM) || "";
  const importedTemplateId = query.get(TEMPLATE_ID_PARAM) || "59";

  if (currentUrl.origin !== AWX_ORIGIN) return;

  if (importedJobId) {
    const routeJobId = route.match(/^\/jobs\/(?:[^/]+\/)?(\d+)(?:\/|$)/)?.[1] || "";
    if (!/^\d+$/.test(importedJobId) || routeJobId !== importedJobId) {
      showNotice("O ID do job não corresponde à URL do AWX. Confira o endereço informado.", true);
      return;
    }
    if (!SUPPORTED_TEMPLATE_IDS.has(importedTemplateId)
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)
      || !sourceSessionUrl
      || !requestId
      || !returnOrigin) {
      showNotice("Não consegui associar este job à sessão da ferramenta. Reabra a consulta a partir da página de lentidão.", true);
      return;
    }

    query.delete(SUBDOMAIN_PARAM);
    query.delete(SESSION_URL_PARAM);
    query.delete(REQUEST_ID_PARAM);
    query.delete(RETURN_ORIGIN_PARAM);
    query.delete(JOB_ID_PARAM);
    query.delete(TEMPLATE_ID_PARAM);
    const remainingQuery = query.toString();
    const cleanHash = `#${route}${remainingQuery ? `?${remainingQuery}` : ""}`;
    history.replaceState(history.state, "", `${location.pathname}${location.search}${cleanHash}`);

    const importedJob = {
      armedAt: Date.now(),
      jobId: importedJobId,
      jobRoute: route,
      startedAt: Date.now(),
      lastRefreshAt: Date.now(),
      status: "successful",
      sourceSessionUrl,
      sourceSubdomain: subdomain,
      requestId,
      returnOrigin,
      templateId: importedTemplateId,
      importedExistingJob: true,
    };
    try {
      sessionStorage.setItem(JOB_MONITOR_KEY, JSON.stringify(importedJob));
      showNotice(`Job ${importedJobId} associado à ferramenta. Preparando o download do Output.`);
      watchForJobStart();
    } catch {
      showNotice("Não consegui guardar a associação do job nesta aba. Recarregue o AWX e tente novamente.", true);
    }
    return;
  }

  if (!SUPPORTED_TEMPLATE_IDS.has(templateId) || !subdomain) {
    const pendingJob = readPendingJob();
    if (pendingJob && !pendingJob.downloadClickedAt) watchForJobStart();
    return;
  }

  query.delete(SUBDOMAIN_PARAM);
  query.delete(SESSION_URL_PARAM);
  query.delete(REQUEST_ID_PARAM);
  query.delete(RETURN_ORIGIN_PARAM);
  const remainingQuery = query.toString();
  const cleanHash = `#${route}${remainingQuery ? `?${remainingQuery}` : ""}`;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${cleanHash}`);

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    showNotice("Subdomínio inválido recebido. Preencha Subdomain manualmente; o job não foi iniciado.", true);
    return;
  }

  let launchClicked = false;
  let finished = false;
  const deadline = Date.now() + 20_000;
  const observer = new MutationObserver(attempt);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  const timer = setInterval(attempt, 200);
  attempt();

  function attempt() {
    if (finished) return;
    const input = findSubdomainInput();
    if (input) {
      const currentValue = String(input.value || "").trim().toLowerCase();
      if (currentValue && currentValue !== subdomain) {
        finish("Já havia um valor em Subdomain; a extensão o preservou. Confira antes de continuar.", true);
        return;
      }
      if (!currentValue && !setInputValue(input, subdomain)) {
        finish("Não consegui preencher Subdomain. Preencha manualmente; o job não foi iniciado.", true);
        return;
      }
      armJobStartMonitor({ sourceSessionUrl, sourceSubdomain: subdomain, requestId, returnOrigin, templateId });
      finish("Subdomain preenchido. Revise o formulário, avance e inicie o job manualmente.");
      return;
    }

    if (!launchClicked) {
      const launchButton = findLaunchButton();
      if (launchButton) {
        launchClicked = true;
        showNotice("Abrindo o formulário do job. A extensão não inicia o job.");
        launchButton.click();
      }
    }

    if (Date.now() >= deadline) {
      finish("Não encontrei o campo Subdomain. Preencha manualmente; o job não foi iniciado.", true);
    }
  }

  function findSubdomainInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    return inputs.find((input) => {
      const labels = Array.from(input.labels || []).map((label) => normalize(label.innerText || label.textContent));
      const ariaLabel = normalize(input.getAttribute("aria-label") || "");
      return labels.some((label) => /^subdomain\b/.test(label)) || /^subdomain\b/.test(ariaLabel);
    }) || null;
  }

  function findLaunchButton() {
    return Array.from(document.querySelectorAll('button, [role="button"]')).find((button) => {
      const label = normalize(button.getAttribute("aria-label") || button.innerText || button.textContent || "");
      return label === "launch" && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }) || null;
  }

  function setInputValue(input, value) {
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return String(input.value || "").trim().toLowerCase() === value;
  }

  function finish(message, isError = false) {
    finished = true;
    observer.disconnect();
    clearInterval(timer);
    showNotice(message, isError);
  }

  function armJobStartMonitor(sessionMetadata) {
    try {
      sessionStorage.setItem(JOB_MONITOR_KEY, JSON.stringify({
        armedAt: Date.now(),
        ...sessionMetadata,
      }));
      watchForJobStart();
    } catch {
      showNotice("Subdomain preenchido. O navegador não permitiu acompanhar o início do job nesta aba.", true);
    }
  }

  function readPendingJob() {
    try {
      const value = JSON.parse(sessionStorage.getItem(JOB_MONITOR_KEY) || "null");
      if (!value || value.downloadClickedAt || !Number.isFinite(value.armedAt) || Date.now() - value.armedAt > JOB_MONITOR_TTL_MS) {
        sessionStorage.removeItem(JOB_MONITOR_KEY);
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  function watchForJobStart() {
    let finishedWatching = false;
    let refreshRequestScheduled = false;
    let routeTimer;
    let refreshRetryTimer;
    let outputCaptureTimer;
    let jobId = readPendingJob()?.jobId || "";

    const onCapturedOutput = (message, sender) => {
      if (message?.type !== "AWX_OUTPUT_FILE_CAPTURED") return false;
      if (sender?.id && sender.id !== chrome.runtime.id) return false;
      const pendingJob = readPendingJob();
      if (!pendingJob || message.requestId !== pendingJob.requestId || message.jobId !== pendingJob.jobId) return false;

      if (outputCaptureTimer) clearTimeout(outputCaptureTimer);
      chrome.runtime.onMessage.removeListener(onCapturedOutput);
      const filenameLabel = String(pendingJob.templateId || "59") === "88" ? "process-queue" : "webhooks";
      const filename = `awx-${filenameLabel}-${pendingJob.sourceSubdomain || "tenant"}-${pendingJob.jobId}.txt`;
      const output = message.ok && typeof message.output === "string" ? message.output : "";
      const error = message.error === "AWX_OUTPUT_TOO_LARGE"
        ? "O output excede o limite de 5 MB para exibição na ferramenta; o arquivo continua disponível nos downloads."
        : output ? "" : "O AWX baixou o TXT, mas a extensão não conseguiu ler seu conteúdo para exibi-lo aqui.";

      void sendOutputToTool(pendingJob, {
        type: "digisac-awx-webhook-output",
        jobId: pendingJob.jobId,
        finalStatus: pendingJob.importedExistingJob ? "" : pendingJob.status || "successful",
        filename,
        output,
        error,
        fileAlreadyDownloaded: true,
      }).then((delivered) => {
        savePendingJob({ ...pendingJob, downloadClickedAt: Date.now() });
        showNotice(delivered
          ? output
            ? `Job ${pendingJob.jobId}${getSourceSessionLabel(pendingJob)} concluído. O TXT baixou e o output apareceu na ferramenta.`
            : `Job ${pendingJob.jobId} baixou o TXT, mas não foi possível exibir o conteúdo na ferramenta.`
          : `Job ${pendingJob.jobId} baixou o TXT, mas a ferramenta não confirmou o recebimento.`, !delivered || !output);
      });
      return false;
    };
    chrome.runtime.onMessage.addListener(onCapturedOutput);

    const checkRoute = () => {
      if (finishedWatching) return;
      let pendingJob = readPendingJob();
      if (!pendingJob) {
        finishedWatching = true;
        routeObserver.disconnect();
        if (routeTimer) clearInterval(routeTimer);
        return;
      }
      const currentRouteAndQuery = location.hash.replace(/^#/, "");
      const currentQueryIndex = currentRouteAndQuery.indexOf("?");
      const currentRoute = currentQueryIndex < 0
        ? currentRouteAndQuery
        : currentRouteAndQuery.slice(0, currentQueryIndex);
      const match = currentRoute.match(/^\/jobs\/(?:[^/]+\/)?(\d+)(?:\/|$)/);
      if (!match) return;

      if (jobId && match[1] !== jobId) {
        finishedWatching = true;
        routeObserver.disconnect();
        clearInterval(routeTimer);
        return;
      }

      if (!jobId) {
        jobId = match[1];
        pendingJob = {
          ...pendingJob,
          jobId,
          jobRoute: currentRoute,
          startedAt: Date.now(),
          lastRefreshAt: Date.now(),
        };
        try {
          savePendingJob(pendingJob);
        } catch {
          // O aviso ainda informa o início mesmo se o estado não puder ser salvo.
        }
        showNotice(`Job iniciado no AWX (ID ${jobId})${getSourceSessionLabel(pendingJob)}. Acompanhando o status.`);
        sendToTool(pendingJob, {
          type: "digisac-awx-job-started",
          jobId,
        });
      }

      const isOutputPage = /\/output\/?$/.test(currentRoute);
      const isDetailsPage = /\/details\/?$/.test(currentRoute)
        || /^\/jobs\/[^/]+\/\d+\/?$/.test(currentRoute);

      if (isOutputPage && !JOB_TERMINAL_STATUSES.has(pendingJob.status)) {
        const detailsTab = findTabControl("details");
        const lastDetailsAttemptAt = Number(pendingJob.detailsTabAttemptAt || 0);
        if (detailsTab && Date.now() - lastDetailsAttemptAt >= 3000) {
          pendingJob = { ...pendingJob, detailsTabAttemptAt: Date.now() };
          savePendingJob(pendingJob);
          detailsTab.click();
        }
        return;
      }

      if (isDetailsPage) {
        const status = readJobStatus();
        if (status && status !== pendingJob.status) {
          pendingJob = { ...pendingJob, status };
          savePendingJob(pendingJob);
        }

        if (status && JOB_TERMINAL_STATUSES.has(status)) {
          const outputTab = findTabControl("output");
          const lastOutputAttemptAt = Number(pendingJob.outputTabAttemptAt || 0);
          if (outputTab && Date.now() - lastOutputAttemptAt >= 3000) {
            pendingJob = { ...pendingJob, outputTabAttemptAt: Date.now() };
            savePendingJob(pendingJob);
            outputTab.click();
            showNotice(`Job ${jobId}${getSourceSessionLabel(pendingJob)} finalizado (${status}). Abrindo Output para baixar.`);
          }
          return;
        }

        if (status && JOB_ACTIVE_STATUSES.has(status)) {
          const lastRefreshAt = Number(pendingJob.lastRefreshAt || pendingJob.startedAt || pendingJob.armedAt);
          if (Date.now() - lastRefreshAt >= JOB_REFRESH_INTERVAL_MS && !refreshRequestScheduled) {
            refreshRequestScheduled = true;
            chrome.runtime.sendMessage({ type: "AWX_JOB_REFRESH_SLOT", jobId }, (response) => {
              if (chrome.runtime.lastError) {
                refreshRetryTimer = setTimeout(() => {
                  refreshRequestScheduled = false;
                  checkRoute();
                }, 5000);
                return;
              }
              if (response?.granted) {
                const latestJob = readPendingJob();
                if (!latestJob || latestJob.jobId !== jobId) return;
                savePendingJob({ ...latestJob, lastRefreshAt: Date.now() });
                setTimeout(() => location.reload(), 100);
                return;
              }
              const retryAfterMs = Math.max(1000, Number(response?.retryAfterMs) || 5000);
              refreshRetryTimer = setTimeout(() => {
                refreshRequestScheduled = false;
                checkRoute();
              }, retryAfterMs + 100);
            });
          }
          return;
        }
      }

      if (isOutputPage && JOB_TERMINAL_STATUSES.has(pendingJob.status)) {
        const downloadButton = findEnabledControl("download output");
        if (!downloadButton) return;

        finishedWatching = true;
        routeObserver.disconnect();
        clearInterval(routeTimer);
        savePendingJob({ ...pendingJob, downloadRequestedAt: Date.now() });
        chrome.runtime.sendMessage({ type: "AWX_EXPECT_OUTPUT_DOWNLOAD", requestId: pendingJob.requestId, jobId }, (response) => {
          if (chrome.runtime.lastError || !response?.registered) {
            try {
              downloadButton.click();
              showNotice(`Job ${jobId} concluído. O AWX está baixando o TXT; não consegui preparar a captura para a ferramenta.`, true);
              const filenameLabel = String(pendingJob.templateId || "59") === "88" ? "process-queue" : "webhooks";
              void sendOutputToTool(pendingJob, {
                type: "digisac-awx-webhook-output",
                jobId,
                finalStatus: pendingJob.status || "successful",
                filename: `awx-${filenameLabel}-${pendingJob.sourceSubdomain || "tenant"}-${jobId}.txt`,
                output: "",
                error: "O AWX baixou o TXT, mas não consegui preparar a captura do conteúdo para a ferramenta.",
                fileAlreadyDownloaded: true,
              }).then(() => savePendingJob({ ...pendingJob, downloadClickedAt: Date.now() }));
            } catch {
              showNotice(`Job ${jobId} concluído, mas não consegui iniciar o download. Abra Output e use Download Output.`, true);
            }
            return;
          }

          try {
            downloadButton.click();
            outputCaptureTimer = setTimeout(() => {
              const latestJob = readPendingJob();
              if (!latestJob || latestJob.requestId !== pendingJob.requestId || latestJob.downloadClickedAt) return;
              chrome.runtime.onMessage.removeListener(onCapturedOutput);
              const filenameLabel = String(latestJob.templateId || "59") === "88" ? "process-queue" : "webhooks";
              void sendOutputToTool(latestJob, {
                type: "digisac-awx-webhook-output",
                jobId,
                finalStatus: latestJob.status || "successful",
                filename: `awx-${filenameLabel}-${latestJob.sourceSubdomain || "tenant"}-${jobId}.txt`,
                output: "",
                error: "O AWX baixou o TXT, mas a extensão não conseguiu capturar seu conteúdo a tempo.",
                fileAlreadyDownloaded: true,
              }).then(() => savePendingJob({ ...latestJob, downloadClickedAt: Date.now() }));
              showNotice(`Job ${jobId} baixou o TXT, mas o conteúdo não chegou à ferramenta.`, true);
            }, 15_000);
            showNotice(`Job ${jobId}${getSourceSessionLabel(pendingJob)} concluído. Baixando o TXT para exibi-lo na ferramenta.`);
          } catch {
            chrome.runtime.onMessage.removeListener(onCapturedOutput);
            showNotice(`Job ${jobId} concluído, mas não consegui acionar Download Output.`, true);
          }
        });
      }
    };

    const routeObserver = new MutationObserver(checkRoute);
    routeObserver.observe(document.body, { childList: true, subtree: true });
    routeTimer = setInterval(checkRoute, JOB_MONITOR_POLL_MS);
    checkRoute();
  }

  function findEnabledControl(expectedLabel) {
    return Array.from(document.querySelectorAll('button, [role="button"], a[download]')).find((element) => {
      return getControlLabels(element).includes(expectedLabel)
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }) || null;
  }

  function findTabControl(expectedLabel) {
    return Array.from(document.querySelectorAll('a[href], button, [role="tab"], [role="button"]')).find((element) => {
      return getControlLabels(element).includes(expectedLabel)
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true";
    }) || null;
  }

  function getControlLabels(element) {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.innerText,
      element.textContent,
    ].map(normalize).filter(Boolean);
  }

  function readJobStatus() {
    const statusValues = new Set([...JOB_ACTIVE_STATUSES, ...JOB_TERMINAL_STATUSES]);
    const lines = String(document.body?.innerText || "").split(/\r?\n/).map(normalize).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === "status" && statusValues.has(lines[index + 1])) return lines[index + 1];
      const labeledStatus = lines[index].match(/^status\s*[:\-]\s*([a-z]+)$/);
      if (labeledStatus && statusValues.has(labeledStatus[1])) return labeledStatus[1];
      const inlineStatus = lines[index].match(/^status\s+([a-z]+)$/);
      if (inlineStatus && statusValues.has(inlineStatus[1])) return inlineStatus[1];
    }

    return "";
  }

  function savePendingJob(value) {
    sessionStorage.setItem(JOB_MONITOR_KEY, JSON.stringify(value));
  }

  function normalizeSessionUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
      return url.origin;
    } catch {
      return "";
    }
  }

  function normalizeRequestId(value) {
    return /^[a-z0-9-]{16,100}$/i.test(value) ? value : "";
  }

  function normalizeReturnOrigin(value) {
    try {
      const url = new URL(value);
      const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
      if (url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
      if (url.protocol !== "https:" && !isLocalHttp) return "";
      if (!document.referrer || new URL(document.referrer).origin !== url.origin) return "";
      return url.origin;
    } catch {
      return "";
    }
  }

  function sendToTool(job, message) {
    if (!job.requestId || !job.returnOrigin || !job.sourceSessionUrl || !window.opener) return false;
    try {
      window.opener.postMessage({
        ...message,
        requestId: job.requestId,
        sourceSessionUrl: job.sourceSessionUrl,
      }, job.returnOrigin);
      return true;
    } catch {
      return false;
    }
  }

  function sendOutputToTool(job, message) {
    if (!job.requestId || !job.returnOrigin || !job.sourceSessionUrl || !window.opener) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId;
      const finish = (downloadStarted) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(timeoutId);
        resolve(downloadStarted);
      };
      const onMessage = (event) => {
        if (event.origin !== job.returnOrigin || event.source !== window.opener) return;
        if (event.data?.type !== "digisac-awx-output-received" || event.data.requestId !== job.requestId) return;
        finish(event.data.downloadStarted === true);
      };

      window.addEventListener("message", onMessage);
      timeoutId = setTimeout(() => finish(false), 5000);
      if (!sendToTool(job, message)) finish(false);
    });
  }

  function getSourceSessionLabel(job) {
    try {
      return job.sourceSessionUrl ? ` · ${new URL(job.sourceSessionUrl).hostname}` : "";
    } catch {
      return "";
    }
  }

  function showNotice(message, isError = false) {
    if (!document.body) return;
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
      notice = document.createElement("div");
      notice.id = NOTICE_ID;
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:420px;padding:12px 16px;border-radius:8px;background:#302b54;color:#fff;font:14px/1.45 Arial,sans-serif;box-shadow:0 3px 16px #0005";
      document.body.appendChild(notice);
    }
    notice.textContent = message;
    notice.style.background = isError ? "#8d273a" : "#302b54";
  }

  function normalize(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }
})();
