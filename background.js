const STORAGE_KEY = "capturedPlaylistUrls";
const DOWNLOAD_STATE_KEY = "downloadStateByMediaKey";
const MAX_ITEMS = 30;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const LESSON_TITLE_SELECTOR = ".lesson-title-value";

// Configurable predicate: keep this focused on your "video" signal.
const REQUIRED_SUBSTRING = "video";

let storageUpdateQueue = Promise.resolve();
let creatingOffscreenDocument = null;

function passesVideoPredicate(urlString) {
  return urlString.toLowerCase().includes(REQUIRED_SUBSTRING);
}

function extractCustomMediaInfoFromPath(pathname) {
  const marker = "/api/playlist/media/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const tail = pathname.slice(markerIndex + marker.length);
  const tailMatch = tail.match(/^(.+)\/(\d+)\/?$/);
  if (!tailMatch) {
    return null;
  }

  return {
    mediaKey: tailMatch[1],
    resolution: tailMatch[2],
    sourceType: "custom"
  };
}

function isVimeoCdnHost(hostname) {
  return /(^|\.)vimeocdn\.com$/i.test(hostname);
}

function extractVimeoMediaInfoFromParsedUrl(parsed) {
  const isVimeoPlaylistJson =
    isVimeoCdnHost(parsed.hostname) &&
    parsed.pathname.includes("/v2/playlist/av/") &&
    parsed.pathname.endsWith("/playlist.json");
  if (!isVimeoPlaylistJson) {
    return null;
  }

  const videoIdFromPath = parsed.pathname.match(/\/video\/(\d+)/)?.[1] || "";
  const videoIdFromQuery = parsed.searchParams.get("videoId") || "";
  const eidFromPath = parsed.pathname.match(/\/(e[0-9a-f-]{8,})\//i)?.[1] || "";
  const mediaSeed = videoIdFromPath || videoIdFromQuery || eidFromPath || parsed.pathname;
  const mediaKey = `vimeo:${mediaSeed}`;

  return {
    mediaKey,
    resolution: "adaptive",
    sourceType: "vimeo"
  };
}

function extractVimeoPlayerPageInfoFromParsedUrl(parsed) {
  if (parsed.hostname !== "player.vimeo.com") {
    return null;
  }

  const match = parsed.pathname.match(/^\/video\/(\d+)\/?$/);
  if (!match) {
    return null;
  }

  const videoId = match[1];
  return {
    mediaKey: `vimeo:${videoId}`,
    resolution: "adaptive",
    sourceType: "vimeo-player-page"
  };
}

function parseResolutionNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function deriveMediaInfoFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const customInfo = extractCustomMediaInfoFromPath(parsed.pathname);
    if (customInfo) {
      return customInfo;
    }

    const vimeoManifestInfo = extractVimeoMediaInfoFromParsedUrl(parsed);
    if (vimeoManifestInfo) {
      return vimeoManifestInfo;
    }

    return extractVimeoPlayerPageInfoFromParsedUrl(parsed);
  } catch {
    return null;
  }
}

function getMediaKeyFromUrl(urlString) {
  const mediaInfo = deriveMediaInfoFromUrl(urlString);
  return mediaInfo ? mediaInfo.mediaKey : urlString;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getDownloadStateMap() {
  const data = await chrome.storage.session.get(DOWNLOAD_STATE_KEY);
  return isPlainObject(data[DOWNLOAD_STATE_KEY]) ? data[DOWNLOAD_STATE_KEY] : {};
}

async function updateDownloadState(mediaKey, patch) {
  if (!mediaKey) {
    return;
  }

  const stateMap = await getDownloadStateMap();
  const current = isPlainObject(stateMap[mediaKey]) ? stateMap[mediaKey] : {};
  stateMap[mediaKey] = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.session.set({ [DOWNLOAD_STATE_KEY]: stateMap });
}

async function clearDownloadState() {
  await chrome.storage.session.set({ [DOWNLOAD_STATE_KEY]: {} });
}

async function readLessonTitleFromTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return "";
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selector) => {
        const el = document.querySelector(selector);
        return el ? (el.textContent || "").trim() : "";
      },
      args: [LESSON_TITLE_SELECTOR]
    });
    return typeof results[0]?.result === "string" ? results[0].result.trim() : "";
  } catch {
    return "";
  }
}

async function readVimeoPlayerPageUrlFromTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return "";
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const candidates = Array.from(document.querySelectorAll("iframe[src]"))
          .map((el) => el.getAttribute("src") || "")
          .map((src) => src.trim())
          .filter((src) => /^https:\/\/player\.vimeo\.com\/video\/\d+/i.test(src));
        return candidates[0] || "";
      }
    });
    return typeof results[0]?.result === "string" ? results[0].result.trim() : "";
  } catch {
    return "";
  }
}

function pickVimeoCdnUrlFromBlock(block) {
  if (!block || typeof block !== "object" || !block.cdns || typeof block.cdns !== "object") {
    return "";
  }

  const pickEntry = (entry) => {
    if (!entry || typeof entry !== "object") {
      return "";
    }
    if (typeof entry.avc_url === "string" && entry.avc_url) {
      return entry.avc_url;
    }
    if (typeof entry.url === "string" && entry.url) {
      return entry.url;
    }
    return "";
  };

  if (typeof block.default_cdn === "string" && block.cdns[block.default_cdn]) {
    const url = pickEntry(block.cdns[block.default_cdn]);
    if (url) {
      return url;
    }
  }

  for (const entry of Object.values(block.cdns)) {
    const url = pickEntry(entry);
    if (url) {
      return url;
    }
  }

  return "";
}

async function readVimeoSourcesFromTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return null;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        try {
          if (location.hostname !== "player.vimeo.com") {
            return null;
          }
          const config = window.playerConfig || null;
          if (!config || !config.request || !config.request.files) {
            return null;
          }

          const files = config.request.files;
          const progressive = Array.isArray(files.progressive)
            ? files.progressive
                .filter((entry) => entry && typeof entry.url === "string" && entry.url)
                .map((entry) => ({
                  url: entry.url,
                  height: Number(entry.height) || -1,
                  bitrate: Number(entry.bitrate) || -1,
                  mime: typeof entry.mime === "string" ? entry.mime : ""
                }))
            : [];

          return {
            playerPageUrl: location.href,
            progressive,
            hls: files.hls || null,
            dash: files.dash || null
          };
        } catch {
          return null;
        }
      }
    });

    const frameResult = results.find((entry) => entry && entry.result && typeof entry.result === "object");
    if (!frameResult) {
      return null;
    }

    const data = frameResult.result;
    const hlsUrl = pickVimeoCdnUrlFromBlock(data.hls);
    const dashUrl = pickVimeoCdnUrlFromBlock(data.dash);
    const progressiveList = Array.isArray(data.progressive) ? data.progressive : [];
    const progressive = progressiveList
      .slice()
      .sort((a, b) => {
        const h = (Number(b.height) || -1) - (Number(a.height) || -1);
        if (h !== 0) {
          return h;
        }
        return (Number(b.bitrate) || -1) - (Number(a.bitrate) || -1);
      })[0];

    return {
      playerPageUrl: typeof data.playerPageUrl === "string" ? data.playerPageUrl : "",
      progressive:
        progressive && typeof progressive.url === "string"
          ? {
              url: progressive.url,
              mimeType: progressive.mime || "video/mp4",
              fileExtension: "mp4"
            }
          : null,
      hlsUrl,
      dashUrl
    };
  } catch {
    return null;
  }
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const offscreenDocumentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenDocumentUrl]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("Offscreen API is unavailable in this Chrome version.");
  }

  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["BLOBS"],
      justification: "Download and merge media segments while popup is closed."
    })
    .catch((error) => {
      const message = String(error && error.message ? error.message : "");
      if (!message.includes("Only a single offscreen document")) {
        throw error;
      }
    })
    .finally(() => {
      creatingOffscreenDocument = null;
    });

  await creatingOffscreenDocument;
}

function normalizeCapturedItems(items) {
  const byMediaKey = new Map();
  const passthroughItems = [];

  for (const item of items) {
    if (!item || typeof item.url !== "string") {
      continue;
    }

    const itemTimestamp = Number(item.timestamp) || 0;
    const itemMediaInfo =
      item.mediaKey && item.resolution
        ? { mediaKey: item.mediaKey, resolution: String(item.resolution) }
        : deriveMediaInfoFromUrl(item.url);

    if (!itemMediaInfo) {
      passthroughItems.push({
        ...item,
        timestamp: itemTimestamp
      });
      continue;
    }

    const candidate = {
      ...item,
      timestamp: itemTimestamp,
      mediaKey: itemMediaInfo.mediaKey,
      resolution: String(itemMediaInfo.resolution)
    };
    const existing = byMediaKey.get(itemMediaInfo.mediaKey);
    if (!existing) {
      byMediaKey.set(itemMediaInfo.mediaKey, candidate);
      continue;
    }

    const candidateResolution = parseResolutionNumber(candidate.resolution);
    const existingResolution = parseResolutionNumber(existing.resolution);
    if (
      candidateResolution > existingResolution ||
      (candidateResolution === existingResolution && candidate.timestamp > existing.timestamp)
    ) {
      byMediaKey.set(itemMediaInfo.mediaKey, {
        ...candidate,
        lessonTitle: candidate.lessonTitle || existing.lessonTitle || "",
        timestamp: Math.max(candidate.timestamp, existing.timestamp)
      });
    } else {
      byMediaKey.set(itemMediaInfo.mediaKey, {
        ...existing,
        lessonTitle: existing.lessonTitle || candidate.lessonTitle || "",
        timestamp: Math.max(existing.timestamp, candidate.timestamp)
      });
    }
  }

  const combined = [...byMediaKey.values(), ...passthroughItems];
  combined.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

  const deduped = [];
  const seenUrls = new Set();
  for (const item of combined) {
    if (seenUrls.has(item.url)) {
      continue;
    }
    seenUrls.add(item.url);
    deduped.push(item);
    if (deduped.length >= MAX_ITEMS) {
      break;
    }
  }

  return deduped;
}

function parseMatchingInfo(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }

  const customInfo = extractCustomMediaInfoFromPath(parsed.pathname);
  if (customInfo) {
    if (!parsed.searchParams.has("user-id")) {
      return null;
    }

    if (!passesVideoPredicate(urlString)) {
      return null;
    }

    return customInfo;
  }

  const vimeoManifestInfo = extractVimeoMediaInfoFromParsedUrl(parsed);
  if (vimeoManifestInfo) {
    return vimeoManifestInfo;
  }

  // Capture only canonical Vimeo A/V manifests to avoid duplicate short/auxiliary entries.
  return null;
}

async function getCapturedItems() {
  const data = await chrome.storage.session.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setCapturedItems(items) {
  await chrome.storage.session.set({ [STORAGE_KEY]: items });
}

async function updateBadgeCount(count) {
  const text = count > 0 ? String(count) : "";
  await chrome.action.setBadgeText({ text });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
  }
}

async function captureUrl(urlString, tabId) {
  const matchInfo = parseMatchingInfo(urlString);
  if (!matchInfo) {
    return;
  }

  const now = Date.now();
  const existingItems = await getCapturedItems();
  const existingForMedia = existingItems.find((item) => item && item.mediaKey === matchInfo.mediaKey);
  const existingForUrl = existingItems.find((item) => item && item.url === urlString);
  const rememberedLessonTitle =
    (existingForMedia && typeof existingForMedia.lessonTitle === "string" ? existingForMedia.lessonTitle : "") ||
    (existingForUrl && typeof existingForUrl.lessonTitle === "string" ? existingForUrl.lessonTitle : "");
  const lessonTitle = rememberedLessonTitle || (await readLessonTitleFromTab(tabId));
  const newEntry = {
    url: urlString,
    timestamp: now,
    resolution: matchInfo.resolution,
    mediaKey: matchInfo.mediaKey,
    lessonTitle
  };

  let highestForMedia = newEntry;
  const otherItems = [];
  let bestLessonTitle = lessonTitle;

  for (const item of existingItems) {
    if (!item || typeof item.url !== "string") {
      continue;
    }

    const itemMediaInfo =
      item.mediaKey && item.resolution
        ? { mediaKey: item.mediaKey, resolution: String(item.resolution) }
        : deriveMediaInfoFromUrl(item.url);

    const itemMediaKey = itemMediaInfo ? itemMediaInfo.mediaKey : null;
    if (itemMediaKey === matchInfo.mediaKey) {
      if (!bestLessonTitle && typeof item.lessonTitle === "string" && item.lessonTitle) {
        bestLessonTitle = item.lessonTitle;
      }
      const itemResolutionNumber = parseResolutionNumber(itemMediaInfo.resolution);
      const highestResolutionNumber = parseResolutionNumber(highestForMedia.resolution);
      if (itemResolutionNumber > highestResolutionNumber) {
        highestForMedia = {
          ...item,
          mediaKey: itemMediaKey,
          resolution: String(itemMediaInfo.resolution)
        };
      }
      continue;
    }

    if (item.url === urlString) {
      continue;
    }

    otherItems.push(item);
  }

  // Keep only one entry per mediaKey and surface it as most recent.
  const topEntry = {
    ...highestForMedia,
    timestamp: now,
    mediaKey: matchInfo.mediaKey,
    lessonTitle:
      bestLessonTitle ||
      (typeof highestForMedia.lessonTitle === "string" ? highestForMedia.lessonTitle : "") ||
      ""
  };

  const nextItems = normalizeCapturedItems([topEntry, ...otherItems]);

  await setCapturedItems(nextItems);
  await updateBadgeCount(nextItems.length);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // We observe only (no blocking). For webRequest visibility across real-world pages,
    // Chrome requires host permissions for both:
    // 1) the requested URL and
    // 2) the initiator/origin making the request.
    // <all_urls> in host_permissions ensures we do not miss valid captures.
    storageUpdateQueue = storageUpdateQueue.then(() => captureUrl(details.url, details.tabId)).catch((error) => {
      console.error("Failed to capture media URL", error);
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "START_DOWNLOAD") {
    (async () => {
      const urlString = typeof message.url === "string" ? message.url : "";
      if (!urlString) {
        throw new Error("Missing URL for download.");
      }
      const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
      const pageUrl = typeof message.pageUrl === "string" ? message.pageUrl : "";

      const mediaKey = getMediaKeyFromUrl(urlString);
      await updateDownloadState(mediaKey, {
        state: "running",
        message: "Queued...",
        error: "",
        filename: ""
      });

      await ensureOffscreenDocument();

      const mediaInfo = deriveMediaInfoFromUrl(urlString);
      const vimeoPlayerPageUrl =
        mediaInfo && mediaInfo.sourceType === "vimeo" && Number.isInteger(tabId)
          ? await readVimeoPlayerPageUrlFromTab(tabId)
          : "";
      const vimeoEmbeddedSources =
        mediaInfo && mediaInfo.sourceType === "vimeo" && Number.isInteger(tabId) ? await readVimeoSourcesFromTab(tabId) : null;

      await chrome.runtime.sendMessage({
        type: "OFFSCREEN_START_DOWNLOAD",
        url: urlString,
        lessonTitle: typeof message.lessonTitle === "string" ? message.lessonTitle : "",
        vimeoPlayerPageUrl,
        pageUrl,
        vimeoEmbeddedSources
      });

      sendResponse({
        ok: true,
        mediaKey
      });
    })().catch(async (error) => {
      const urlString = typeof message.url === "string" ? message.url : "";
      if (urlString) {
        const mediaKey = getMediaKeyFromUrl(urlString);
        await updateDownloadState(mediaKey, {
          state: "error",
          message: "Failed to start download",
          error: error.message
        });
      }

      sendResponse({
        ok: false,
        error: error.message
      });
    });

    return true;
  }

  if (message.type === "CANCEL_DOWNLOAD") {
    (async () => {
      const explicitMediaKey = typeof message.mediaKey === "string" ? message.mediaKey : "";
      const mediaKey = explicitMediaKey || getMediaKeyFromUrl(typeof message.url === "string" ? message.url : "");
      if (!mediaKey) {
        throw new Error("Missing media key for cancellation.");
      }

      await ensureOffscreenDocument();

      const offscreenResponse = await chrome.runtime.sendMessage({
        type: "OFFSCREEN_CANCEL_DOWNLOAD",
        mediaKey
      });

      if (offscreenResponse && offscreenResponse.found === false) {
        sendResponse({
          ok: false,
          mediaKey,
          error: "No active download for this item."
        });
        return;
      }

      sendResponse({
        ok: true,
        mediaKey,
        offscreenResponse: offscreenResponse || null
      });
    })().catch(async (error) => {
      const explicitMediaKey = typeof message.mediaKey === "string" ? message.mediaKey : "";
      const mediaKey = explicitMediaKey || getMediaKeyFromUrl(typeof message.url === "string" ? message.url : "");
      if (mediaKey) {
        await updateDownloadState(mediaKey, {
          state: "error",
          message: "Failed to cancel download",
          error: error.message
        });
      }

      sendResponse({
        ok: false,
        error: error.message
      });
    });

    return true;
  }

  if (message.type === "BROWSER_DOWNLOAD_START") {
    (async () => {
      const url = typeof message.url === "string" ? message.url : "";
      const filename = typeof message.filename === "string" ? message.filename : "";
      if (!url) {
        throw new Error("Missing URL for browser download.");
      }
      if (!filename) {
        throw new Error("Missing filename for browser download.");
      }

      const downloadId = await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      });

      sendResponse({
        ok: true,
        downloadId
      });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });
    return true;
  }

  if (message.type === "BROWSER_DOWNLOAD_CANCEL") {
    (async () => {
      const downloadId = Number(message.downloadId);
      if (!Number.isFinite(downloadId)) {
        throw new Error("Invalid download id for browser cancellation.");
      }

      try {
        await chrome.downloads.cancel(downloadId);
      } catch (error) {
        const msg = String(error?.message || "");
        if (
          !msg.includes("Invalid download id") &&
          !msg.includes("Download must be in progress") &&
          !msg.includes("not in progress")
        ) {
          throw error;
        }
      }

      sendResponse({
        ok: true
      });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });
    return true;
  }

  if (message.type === "DOWNLOAD_STATUS_UPDATE") {
    (async () => {
      const mediaKey = typeof message.mediaKey === "string" ? message.mediaKey : "";
      const patch = isPlainObject(message.patch) ? message.patch : {};
      if (!mediaKey) {
        throw new Error("Missing media key in status update.");
      }

      await updateDownloadState(mediaKey, patch);
      sendResponse({ ok: true });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error.message
      });
    });
    return true;
  }

  if (message.type === "CLEAR_DOWNLOAD_STATE") {
    clearDownloadState()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error.message
        })
      );
    return true;
  }

  return undefined;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !changes[STORAGE_KEY]) {
    return;
  }

  const nextItems = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
  updateBadgeCount(nextItems.length).catch((error) => {
    console.error("Failed to update badge count", error);
  });
});

async function initializeBadge() {
  const items = await getCapturedItems();
  const normalized = normalizeCapturedItems(items);
  if (JSON.stringify(normalized) !== JSON.stringify(items)) {
    await setCapturedItems(normalized);
  }
  await updateBadgeCount(normalized.length);
}

chrome.runtime.onInstalled.addListener(() => {
  initializeBadge().catch((error) => console.error("Badge init failed on install", error));
});

chrome.runtime.onStartup.addListener(() => {
  initializeBadge().catch((error) => console.error("Badge init failed on startup", error));
});

initializeBadge().catch((error) => {
  console.error("Badge init failed at service worker boot", error);
});
