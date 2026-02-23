const STORAGE_KEY = "capturedPlaylistUrls";
const DOWNLOAD_STATE_KEY = "downloadStateByMediaKey";

const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");
const downloadStatusEl = document.getElementById("downloadStatus");
const clearButton = document.getElementById("clearButton");

let currentItems = [];
let currentDownloadState = {};
const pendingStartDownloads = new Set();
const pendingCancelDownloads = new Set();
const pendingRemoveItems = new Set();

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function setDownloadStatus(message, isError = false) {
  downloadStatusEl.textContent = message || "";
  if (isError) {
    downloadStatusEl.classList.add("error");
  } else {
    downloadStatusEl.classList.remove("error");
  }
}

function extractMediaInfoFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const marker = "/api/playlist/media/";
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }

    const tail = parsed.pathname.slice(markerIndex + marker.length);
    const match = tail.match(/^(.+)\/(\d+)\/?$/);
    if (!match) {
      return null;
    }

    return {
      mediaKey: match[1],
      resolution: match[2]
    };
  } catch {
    return null;
  }
}

function extractResolutionFallback(urlString) {
  const mediaInfo = extractMediaInfoFromUrl(urlString);
  return mediaInfo ? mediaInfo.resolution : "?";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getItemMediaKey(item) {
  if (item && typeof item.mediaKey === "string" && item.mediaKey.length > 0) {
    return item.mediaKey;
  }
  const mediaInfo = extractMediaInfoFromUrl(item && item.url ? item.url : "");
  return mediaInfo ? mediaInfo.mediaKey : item.url;
}

function buildDownloadMetaText(item, mediaKey) {
  const resolution = item.resolution || extractResolutionFallback(item.url);
  const lessonTitle =
    item && typeof item.lessonTitle === "string" && item.lessonTitle.trim() ? item.lessonTitle.trim() : "";
  const lessonPart = lessonTitle ? `Lesson: ${lessonTitle} | ` : "";
  const capturedAtText = `${lessonPart}Resolution: ${resolution} | Captured: ${formatTime(item.timestamp)}`;

  const state = isPlainObject(currentDownloadState[mediaKey]) ? currentDownloadState[mediaKey] : null;
  if (!state || !state.state) {
    return capturedAtText;
  }

  if (state.state === "running") {
    return `${capturedAtText} | Download: ${state.message || "Running..."}`;
  }
  if (state.state === "cancel_requested") {
    return `${capturedAtText} | Download: ${state.message || "Cancelling..."}`;
  }
  if (state.state === "cancelled") {
    return `${capturedAtText} | Download: Cancelled`;
  }
  if (state.state === "success") {
    return `${capturedAtText} | Download: ${state.filename || "Started in Downloads"}`;
  }
  if (state.state === "error") {
    const base = `${capturedAtText} | Download error: ${state.error || state.message || "Unknown error"}`;
    const withDebug = state.debugTrace ? `${base} | Debug available` : base;
    return state.ffmpegCommand ? `${withDebug} | FFmpeg command available` : withDebug;
  }

  return capturedAtText;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function readLessonTitleFromActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || typeof tabs[0].id !== "number") {
      return "";
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const el = document.querySelector(".lesson-title-value");
        return el ? (el.textContent || "").trim() : "";
      }
    });

    return typeof results[0]?.result === "string" ? results[0].result.trim() : "";
  } catch (error) {
    console.warn("Could not read lesson title from active tab", error);
    return "";
  }
}

async function readActiveTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] && typeof tabs[0].id === "number" ? tabs[0].id : null;
  } catch {
    return null;
  }
}

async function readActiveTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] && typeof tabs[0].url === "string" ? tabs[0].url : "";
  } catch {
    return "";
  }
}

async function persistLessonTitleForMediaKey(mediaKey, lessonTitle) {
  const normalizedTitle = typeof lessonTitle === "string" ? lessonTitle.trim() : "";
  if (!mediaKey || !normalizedTitle) {
    return;
  }

  const data = await chrome.storage.session.get(STORAGE_KEY);
  const items = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  let changed = false;
  const nextItems = items.map((item) => {
    if (getItemMediaKey(item) !== mediaKey) {
      return item;
    }
    if (typeof item.lessonTitle === "string" && item.lessonTitle.trim()) {
      return item;
    }
    changed = true;
    return {
      ...item,
      lessonTitle: normalizedTitle
    };
  });

  if (changed) {
    await chrome.storage.session.set({ [STORAGE_KEY]: nextItems });
  }
}

function render() {
  statusEl.textContent = `${currentItems.length} captured`;
  listEl.innerHTML = "";

  if (currentItems.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No matching requests captured yet. Start playback and reopen this popup.";
    listEl.appendChild(empty);
    return;
  }

  for (const item of currentItems) {
    const mediaKey = getItemMediaKey(item);
    const row = document.createElement("li");
    row.className = "entry";

    const top = document.createElement("div");
    top.className = "entryTop";

    const urlText = document.createElement("p");
    urlText.className = "url";
    urlText.textContent = item.url;
    top.appendChild(urlText);

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "copyButton";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        copyButton.textContent = "Copied";
        setTimeout(() => {
          if (!copyButton.disabled) {
            copyButton.textContent = "Copy";
          }
        }, 800);
      } catch (error) {
        console.error("Clipboard write failed", error);
        copyButton.textContent = "Failed";
        setTimeout(() => {
          if (!copyButton.disabled) {
            copyButton.textContent = "Copy";
          }
        }, 1000);
      }
    });
    actions.appendChild(copyButton);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "downloadButton";
    downloadButton.textContent = "Download";

    const state = isPlainObject(currentDownloadState[mediaKey]) ? currentDownloadState[mediaKey] : null;
    const isRunningState = state?.state === "running" || state?.state === "cancel_requested";
    const isRunning =
      pendingStartDownloads.has(mediaKey) || pendingCancelDownloads.has(mediaKey) || isRunningState;
    const isCancelling = pendingCancelDownloads.has(mediaKey) || state?.state === "cancel_requested";
    const isRemoving = pendingRemoveItems.has(mediaKey);
    if (isRunning) {
      downloadButton.className = "stopButton";
      downloadButton.textContent = isCancelling ? "Stopping..." : "Stop";
      downloadButton.disabled = isCancelling;
    }

    if (pendingStartDownloads.has(mediaKey)) {
      downloadButton.disabled = true;
      downloadButton.className = "downloadButton";
      downloadButton.textContent = "Starting...";
    }

    downloadButton.addEventListener("click", async () => {
      const latestState = isPlainObject(currentDownloadState[mediaKey]) ? currentDownloadState[mediaKey] : null;
      const latestIsRunning = latestState?.state === "running" || latestState?.state === "cancel_requested";
      if (pendingStartDownloads.has(mediaKey)) {
        return;
      }

      if (latestIsRunning || pendingCancelDownloads.has(mediaKey)) {
        pendingCancelDownloads.add(mediaKey);
        downloadButton.disabled = true;
        downloadButton.className = "stopButton";
        downloadButton.textContent = "Stopping...";
        setDownloadStatus("Cancelling download...");

        try {
          const response = await sendRuntimeMessage({
            type: "CANCEL_DOWNLOAD",
            mediaKey
          });

          if (!response || !response.ok) {
            throw new Error(response && response.error ? response.error : "Failed to cancel download.");
          }
          setDownloadStatus("Cancellation requested.");
        } catch (error) {
          console.error("Failed to cancel download", error);
          setDownloadStatus(`Failed to cancel download: ${error.message}`, true);
        } finally {
          pendingCancelDownloads.delete(mediaKey);
          await loadAndRender();
        }
        return;
      }

      pendingStartDownloads.add(mediaKey);
      downloadButton.disabled = true;
      downloadButton.textContent = "Starting";
      setDownloadStatus("Starting download...");

      try {
        const activeLessonTitle = await readLessonTitleFromActiveTab();
        const lessonTitle =
          activeLessonTitle || (typeof item.lessonTitle === "string" ? item.lessonTitle.trim() : "");
        if (activeLessonTitle) {
          await persistLessonTitleForMediaKey(mediaKey, activeLessonTitle);
        }
        const response = await sendRuntimeMessage({
          type: "START_DOWNLOAD",
          url: item.url,
          lessonTitle,
          tabId: await readActiveTabId(),
          pageUrl: await readActiveTabUrl()
        });

        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "Failed to start download.");
        }
        setDownloadStatus("Download started in background. You can close popup.");
      } catch (error) {
        console.error("Failed to start download", error);
        setDownloadStatus(`Failed to start download: ${error.message}`, true);
      } finally {
        pendingStartDownloads.delete(mediaKey);
        await loadAndRender();
      }
    });
    actions.appendChild(downloadButton);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "removeButton";
    removeButton.textContent = isRemoving ? "Removing..." : "Remove";
    removeButton.disabled = isRunning || isRemoving;
    removeButton.addEventListener("click", async () => {
      const latestState = isPlainObject(currentDownloadState[mediaKey]) ? currentDownloadState[mediaKey] : null;
      const latestIsRunning = latestState?.state === "running" || latestState?.state === "cancel_requested";
      if (latestIsRunning || pendingStartDownloads.has(mediaKey) || pendingCancelDownloads.has(mediaKey)) {
        setDownloadStatus("Stop the download first, then remove the item.", true);
        return;
      }

      pendingRemoveItems.add(mediaKey);
      removeButton.disabled = true;
      removeButton.textContent = "Removing...";

      try {
        const data = await chrome.storage.session.get([STORAGE_KEY, DOWNLOAD_STATE_KEY]);
        const items = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
        const downloadState = isPlainObject(data[DOWNLOAD_STATE_KEY]) ? data[DOWNLOAD_STATE_KEY] : {};

        const filteredItems = items.filter((candidate) => getItemMediaKey(candidate) !== mediaKey);
        delete downloadState[mediaKey];

        await chrome.storage.session.set({
          [STORAGE_KEY]: filteredItems,
          [DOWNLOAD_STATE_KEY]: downloadState
        });
        setDownloadStatus("Item removed.");
      } catch (error) {
        console.error("Failed to remove item", error);
        setDownloadStatus(`Failed to remove item: ${error.message}`, true);
      } finally {
        pendingRemoveItems.delete(mediaKey);
        await loadAndRender();
      }
    });
    actions.appendChild(removeButton);

    if (state?.state === "error" && typeof state.debugTrace === "string" && state.debugTrace.trim()) {
      const copyDebugButton = document.createElement("button");
      copyDebugButton.type = "button";
      copyDebugButton.className = "copyButton";
      copyDebugButton.textContent = "Copy debug";
      copyDebugButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(state.debugTrace);
          copyDebugButton.textContent = "Copied";
          setTimeout(() => {
            copyDebugButton.textContent = "Copy debug";
          }, 1000);
          setDownloadStatus("Debug log copied.");
        } catch (error) {
          console.error("Debug clipboard write failed", error);
          setDownloadStatus(`Failed to copy debug log: ${error.message}`, true);
        }
      });
      actions.appendChild(copyDebugButton);
    }

    if (state?.state === "error" && typeof state.ffmpegCommand === "string" && state.ffmpegCommand.trim()) {
      const copyFfmpegButton = document.createElement("button");
      copyFfmpegButton.type = "button";
      copyFfmpegButton.className = "copyButton";
      copyFfmpegButton.textContent = "Copy ffmpeg";
      copyFfmpegButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(state.ffmpegCommand);
          copyFfmpegButton.textContent = "Copied";
          setTimeout(() => {
            copyFfmpegButton.textContent = "Copy ffmpeg";
          }, 1000);
          setDownloadStatus("ffmpeg command copied. Run it in terminal.");
        } catch (error) {
          console.error("ffmpeg clipboard write failed", error);
          setDownloadStatus(`Failed to copy ffmpeg command: ${error.message}`, true);
        }
      });
      actions.appendChild(copyFfmpegButton);
    }

    top.appendChild(actions);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = buildDownloadMetaText(item, mediaKey);

    row.appendChild(top);
    row.appendChild(meta);
    listEl.appendChild(row);
  }
}

async function loadAndRender() {
  const data = await chrome.storage.session.get([STORAGE_KEY, DOWNLOAD_STATE_KEY]);
  currentItems = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  currentDownloadState = isPlainObject(data[DOWNLOAD_STATE_KEY]) ? data[DOWNLOAD_STATE_KEY] : {};
  render();
}

clearButton.addEventListener("click", async () => {
  await chrome.storage.session.set({
    [STORAGE_KEY]: [],
    [DOWNLOAD_STATE_KEY]: {}
  });
  pendingStartDownloads.clear();
  pendingCancelDownloads.clear();
  pendingRemoveItems.clear();
  setDownloadStatus("");
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session") {
    return;
  }

  if (changes[STORAGE_KEY]) {
    const nextItems = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
    currentItems = nextItems;
  }

  if (changes[DOWNLOAD_STATE_KEY]) {
    currentDownloadState = isPlainObject(changes[DOWNLOAD_STATE_KEY].newValue)
      ? changes[DOWNLOAD_STATE_KEY].newValue
      : {};
  }

  render();
});

loadAndRender().catch((error) => {
  console.error("Failed to load captured items", error);
  setDownloadStatus(`Failed to load captured URLs: ${error.message}`, true);
});
