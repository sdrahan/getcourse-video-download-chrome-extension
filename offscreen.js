const MAX_SEGMENT_RETRIES = 12;
const activeDownloads = new Map();

class CancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "CancelledError";
  }
}

function isCancelledError(error) {
  return error instanceof CancelledError || error?.name === "AbortError";
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw new CancelledError("Download cancelled by user.");
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new CancelledError("Download cancelled by user."));
    };

    function cleanup() {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function sanitizeFilePart(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

    const mediaKey = match[1];
    const segments = mediaKey.split("/").filter(Boolean);
    const videoId = segments.length > 0 ? segments[segments.length - 1] : mediaKey;

    return {
      mediaKey,
      videoId,
      resolution: match[2]
    };
  } catch {
    return null;
  }
}

function buildDownloadFilename(urlString, lessonTitle) {
  const mediaInfo = extractMediaInfoFromUrl(urlString);
  const videoId = sanitizeFilePart(mediaInfo ? mediaInfo.videoId : "video");
  const title = sanitizeFilePart(lessonTitle);
  const rawName = title ? `${title} ${videoId}` : videoId;
  const normalized = sanitizeFilePart(rawName).slice(0, 180) || "video";
  return `${normalized}.ts`;
}

function splitPlaylistLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isCommentLine(line) {
  return line.startsWith("#");
}

function isLikelySegmentLine(line) {
  return /(?:\.ts|\.bin)(?:\?|$)/i.test(line);
}

function resolveUrl(line, baseUrl) {
  try {
    return new URL(line, baseUrl).toString();
  } catch {
    return null;
  }
}

function isHttpUrl(urlString) {
  return /^https?:\/\//i.test(urlString);
}

async function fetchText(urlString, signal) {
  throwIfAborted(signal);
  const response = await fetch(urlString, {
    method: "GET",
    credentials: "include",
    signal
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${urlString} (HTTP ${response.status})`);
  }
  return response.text();
}

async function fetchSegmentWithRetry(urlString, retries, signal) {
  let attempt = 0;
  while (true) {
    throwIfAborted(signal);
    try {
      const response = await fetch(urlString, {
        method: "GET",
        credentials: "include",
        signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } catch (error) {
      if (isCancelledError(error)) {
        throw error;
      }
      if (attempt >= retries) {
        throw new Error(`Segment fetch failed for ${urlString}: ${error.message}`);
      }
      const backoffMs = Math.min(3000, 250 * Math.pow(2, attempt));
      attempt += 1;
      await sleep(backoffMs, signal);
    }
  }
}

function getLastContentLine(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isCommentLine(lines[i])) {
      return lines[i];
    }
  }
  return null;
}

async function resolveSegmentUrlsFromPlaylistUrl(playlistUrl, signal) {
  const mainText = await fetchText(playlistUrl, signal);
  const mainLines = splitPlaylistLines(mainText);
  const hasDirectSegmentLinks = mainLines.some((line) => !isCommentLine(line) && isLikelySegmentLine(line));

  let mediaLines;
  let mediaBaseUrl;
  if (hasDirectSegmentLinks) {
    mediaLines = mainLines;
    mediaBaseUrl = playlistUrl;
  } else {
    const tail = getLastContentLine(mainLines);
    if (!tail) {
      throw new Error("Playlist does not contain a media playlist reference.");
    }

    const secondPlaylistUrl = resolveUrl(tail, playlistUrl);
    if (!secondPlaylistUrl || !isHttpUrl(secondPlaylistUrl)) {
      throw new Error("Playlist tail is not a valid media playlist URL.");
    }

    const secondText = await fetchText(secondPlaylistUrl, signal);
    mediaLines = splitPlaylistLines(secondText);
    mediaBaseUrl = secondPlaylistUrl;
  }

  const segmentUrls = [];
  for (const line of mediaLines) {
    throwIfAborted(signal);
    if (isCommentLine(line)) {
      continue;
    }

    const segmentUrl = resolveUrl(line, mediaBaseUrl);
    if (!segmentUrl || !isHttpUrl(segmentUrl)) {
      continue;
    }
    segmentUrls.push(segmentUrl);
  }

  if (segmentUrls.length === 0) {
    throw new Error("No segment URLs were found in playlist.");
  }

  return segmentUrls;
}

async function reportStatus(mediaKey, patch) {
  try {
    await chrome.runtime.sendMessage({
      type: "DOWNLOAD_STATUS_UPDATE",
      mediaKey,
      patch
    });
  } catch (error) {
    console.warn("Failed to report download status", error);
  }
}

async function sendRuntimeMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || !response.ok) {
    throw new Error(response?.error || "Runtime message failed.");
  }
  return response;
}

async function startBrowserDownload(blobUrl, filename) {
  const response = await sendRuntimeMessage({
    type: "BROWSER_DOWNLOAD_START",
    url: blobUrl,
    filename
  });
  return response.downloadId;
}

async function cancelChromeDownloadIfNeeded(downloadId) {
  if (!Number.isFinite(downloadId)) {
    return;
  }

  try {
    await sendRuntimeMessage({
      type: "BROWSER_DOWNLOAD_CANCEL",
      downloadId
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (
      !message.includes("Invalid download id") &&
      !message.includes("Download must be in progress") &&
      !message.includes("not in progress")
    ) {
      console.warn("Failed to cancel browser download", error);
    }
  }
}

async function cancelDownloadJob(mediaKey) {
  const job = activeDownloads.get(mediaKey);
  if (!job) {
    return false;
  }

  job.cancelled = true;
  job.abortController.abort();
  await cancelChromeDownloadIfNeeded(job.downloadId);
  await reportStatus(mediaKey, {
    state: "cancel_requested",
    message: "Cancelling..."
  });
  return true;
}

async function startDownloadJob(urlString, lessonTitle) {
  const mediaInfo = extractMediaInfoFromUrl(urlString);
  if (!mediaInfo) {
    throw new Error("URL does not contain expected /api/playlist/media/.../<resolution> structure.");
  }

  const mediaKey = mediaInfo.mediaKey;
  if (activeDownloads.has(mediaKey)) {
    await reportStatus(mediaKey, {
      state: "running",
      message: "Download already in progress."
    });
    return;
  }

  const abortController = new AbortController();
  const signal = abortController.signal;
  const job = {
    abortController,
    downloadId: null,
    cancelled: false
  };

  activeDownloads.set(mediaKey, job);
  await reportStatus(mediaKey, {
    state: "running",
    message: "Resolving playlist...",
    error: "",
    filename: ""
  });

  try {
    const filename = buildDownloadFilename(urlString, lessonTitle);
    const segmentUrls = await resolveSegmentUrlsFromPlaylistUrl(urlString, signal);

    const chunks = [];
    for (let i = 0; i < segmentUrls.length; i += 1) {
      throwIfAborted(signal);
      await reportStatus(mediaKey, {
        state: "running",
        message: `Downloading segments ${i + 1}/${segmentUrls.length}...`
      });
      const buffer = await fetchSegmentWithRetry(segmentUrls[i], MAX_SEGMENT_RETRIES, signal);
      chunks.push(buffer);
    }

    throwIfAborted(signal);
    await reportStatus(mediaKey, {
      state: "running",
      message: "Merging segments..."
    });

    const blob = new Blob(chunks, { type: "video/mp2t" });
    const blobUrl = URL.createObjectURL(blob);

    let downloadId;
    try {
      throwIfAborted(signal);
      downloadId = await startBrowserDownload(blobUrl, filename);
      job.downloadId = downloadId;
      throwIfAborted(signal);
    } finally {
      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60_000);
    }

    if (job.cancelled || signal.aborted) {
      await cancelChromeDownloadIfNeeded(downloadId);
      throw new CancelledError("Download cancelled by user.");
    }

    await reportStatus(mediaKey, {
      state: "success",
      message: "Download started in Chrome Downloads.",
      filename,
      segmentCount: segmentUrls.length,
      downloadId
    });
  } catch (error) {
    if (isCancelledError(error) || job.cancelled || signal.aborted) {
      await reportStatus(mediaKey, {
        state: "cancelled",
        message: "Download cancelled by user.",
        error: "",
        downloadId: job.downloadId
      });
    } else {
      await reportStatus(mediaKey, {
        state: "error",
        message: "Download failed.",
        error: error.message
      });
    }
  } finally {
    activeDownloads.delete(mediaKey);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "OFFSCREEN_START_DOWNLOAD") {
    const urlString = typeof message.url === "string" ? message.url : "";
    const lessonTitle = typeof message.lessonTitle === "string" ? message.lessonTitle : "";

    if (!urlString) {
      sendResponse({ ok: false, error: "Missing URL for offscreen download." });
      return undefined;
    }

    startDownloadJob(urlString, lessonTitle).catch((error) => {
      console.error("Offscreen download job failed", error);
    });
    sendResponse({ ok: true });
    return undefined;
  }

  if (message.type === "OFFSCREEN_CANCEL_DOWNLOAD") {
    const mediaKey = typeof message.mediaKey === "string" ? message.mediaKey : "";
    if (!mediaKey) {
      sendResponse({ ok: false, error: "Missing media key for cancellation." });
      return undefined;
    }

    cancelDownloadJob(mediaKey)
      .then((found) => sendResponse({ ok: true, found }))
      .catch((error) => {
        console.error("Offscreen cancellation failed", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return undefined;
});
