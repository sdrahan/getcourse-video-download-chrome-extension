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

function extractCustomMediaInfoFromParsedUrl(parsed) {
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
    resolution: match[2],
    sourceType: "custom"
  };
}

function isVimeoCdnHost(hostname) {
  return /(^|\.)vimeocdn\.com$/i.test(hostname);
}

function isVimeoPlaylistJsonUrl(parsed) {
  return isVimeoCdnHost(parsed.hostname) && parsed.pathname.includes("/v2/playlist/") && parsed.pathname.endsWith("/playlist.json");
}

function extractVimeoMediaInfoFromParsedUrl(parsed) {
  if (!isVimeoPlaylistJsonUrl(parsed)) {
    return null;
  }

  const videoIdFromPath = parsed.pathname.match(/\/video\/(\d+)/)?.[1] || "";
  const videoIdFromQuery = parsed.searchParams.get("videoId") || "";
  const eidFromPath = parsed.pathname.match(/\/(e[0-9a-f-]{8,})\//i)?.[1] || "";
  const mediaSeed = videoIdFromPath || videoIdFromQuery || eidFromPath || parsed.pathname;
  const mediaKey = `vimeo:${mediaSeed}`;
  const videoId = videoIdFromPath || videoIdFromQuery || eidFromPath || mediaSeed;

  return {
    mediaKey,
    videoId,
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
    videoId,
    resolution: "adaptive",
    sourceType: "vimeo-player-page"
  };
}

function extractMediaInfoFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const customInfo = extractCustomMediaInfoFromParsedUrl(parsed);
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

function buildDownloadFilename(urlString, lessonTitle, fileExtension) {
  const mediaInfo = extractMediaInfoFromUrl(urlString);
  const videoId = sanitizeFilePart(mediaInfo ? mediaInfo.videoId : "video");
  const title = sanitizeFilePart(lessonTitle);
  const rawName = title ? `${title} ${videoId}` : videoId;
  const normalized = sanitizeFilePart(rawName).slice(0, 180) || "video";
  const ext = String(fileExtension || "ts").replace(/^\./, "");
  return `${normalized}.${ext || "ts"}`;
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
  let initMapUrl = "";
  for (const line of mediaLines) {
    throwIfAborted(signal);
    if (isCommentLine(line)) {
      const mapMatch = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/i);
      if (mapMatch && mapMatch[1]) {
        const resolvedMapUrl = resolveUrl(mapMatch[1], mediaBaseUrl);
        if (resolvedMapUrl && isHttpUrl(resolvedMapUrl)) {
          initMapUrl = resolvedMapUrl;
        }
      }
      continue;
    }

    const segmentUrl = resolveUrl(line, mediaBaseUrl);
    if (!segmentUrl || !isHttpUrl(segmentUrl)) {
      continue;
    }
    segmentUrls.push(segmentUrl);
  }

  if (initMapUrl) {
    segmentUrls.unshift(initMapUrl);
  }

  if (segmentUrls.length === 0) {
    throw new Error("No segment URLs were found in playlist.");
  }

  return segmentUrls;
}

function decodeBase64ToArrayBuffer(base64Value) {
  const normalized = String(base64Value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function getTrackNumericValue(track, keys) {
  for (const key of keys) {
    const value = Number(track?.[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return -1;
}

function hasUsableTrackSource(track) {
  if (!track || typeof track !== "object") {
    return false;
  }

  if (Array.isArray(track.segments) && track.segments.length > 0) {
    return true;
  }

  return typeof track.url === "string" && track.url.length > 0;
}

function pickBestVimeoTrack(manifest) {
  const candidateArrays = [
    ...((Array.isArray(manifest?.video) ? [manifest.video] : [])),
    ...((Array.isArray(manifest?.audio_video) ? [manifest.audio_video] : [])),
    ...((Array.isArray(manifest?.muxed) ? [manifest.muxed] : []))
  ];

  const allTracks = candidateArrays.flat().filter(hasUsableTrackSource);
  if (allTracks.length === 0) {
    return null;
  }

  allTracks.sort((a, b) => {
    const heightDelta = getTrackNumericValue(b, ["height", "max_height"]) - getTrackNumericValue(a, ["height", "max_height"]);
    if (heightDelta !== 0) {
      return heightDelta;
    }

    const bitrateDelta =
      getTrackNumericValue(b, ["bitrate", "avg_bitrate", "bandwidth"]) -
      getTrackNumericValue(a, ["bitrate", "avg_bitrate", "bandwidth"]);
    if (bitrateDelta !== 0) {
      return bitrateDelta;
    }

    return (Array.isArray(b.segments) ? b.segments.length : 0) - (Array.isArray(a.segments) ? a.segments.length : 0);
  });

  return allTracks[0];
}

function getSegmentUrlPart(segment) {
  if (typeof segment === "string") {
    return segment;
  }
  if (!segment || typeof segment !== "object") {
    return "";
  }
  if (typeof segment.url === "string") {
    return segment.url;
  }
  if (typeof segment.uri === "string") {
    return segment.uri;
  }
  if (typeof segment.path === "string") {
    return segment.path;
  }
  return "";
}

function resolveWithFallback(pathPart, baseUrls) {
  for (const baseUrl of baseUrls) {
    const resolved = resolveUrl(pathPart, baseUrl);
    if (resolved && isHttpUrl(resolved)) {
      return resolved;
    }
  }
  return null;
}

function getMimeExtension(mimeType) {
  const lower = String(mimeType || "").toLowerCase();
  if (lower.includes("mp4")) {
    return "mp4";
  }
  if (lower.includes("mpegurl") || lower.includes("x-mpegurl")) {
    return "m3u8";
  }
  return "bin";
}

async function resolveVimeoChunksFromPlaylistJson(playlistUrl, signal, progressCallback) {
  const playlistText = await fetchText(playlistUrl, signal);

  let manifest;
  try {
    manifest = JSON.parse(playlistText);
  } catch {
    throw new Error("Vimeo playlist response is not valid JSON.");
  }

  const bestTrack = pickBestVimeoTrack(manifest);
  if (!bestTrack) {
    throw new Error("Vimeo playlist JSON does not expose a downloadable track.");
  }

  const manifestBase = resolveUrl(manifest.base_url || "", playlistUrl) || playlistUrl;
  const trackBase = resolveUrl(bestTrack.base_url || "", manifestBase) || manifestBase;
  const baseCandidates = [trackBase, manifestBase, playlistUrl];

  const chunks = [];
  if (typeof bestTrack.init_segment === "string" && bestTrack.init_segment.length > 0) {
    chunks.push(decodeBase64ToArrayBuffer(bestTrack.init_segment));
  }

  const segmentUrls = [];
  if (Array.isArray(bestTrack.segments)) {
    for (const segment of bestTrack.segments) {
      throwIfAborted(signal);
      const part = getSegmentUrlPart(segment);
      if (!part) {
        continue;
      }
      const resolved = resolveWithFallback(part, baseCandidates);
      if (resolved) {
        segmentUrls.push(resolved);
      }
    }
  }

  if (segmentUrls.length === 0 && typeof bestTrack.url === "string") {
    const directTrackUrl = resolveWithFallback(bestTrack.url, baseCandidates);
    if (directTrackUrl) {
      segmentUrls.push(directTrackUrl);
    }
  }

  if (segmentUrls.length === 0) {
    throw new Error("Vimeo playlist track has no usable segment URLs.");
  }

  for (let i = 0; i < segmentUrls.length; i += 1) {
    throwIfAborted(signal);
    if (typeof progressCallback === "function") {
      await progressCallback(`Downloading segments ${i + 1}/${segmentUrls.length}...`);
    }
    const buffer = await fetchSegmentWithRetry(segmentUrls[i], MAX_SEGMENT_RETRIES, signal);
    chunks.push(buffer);
  }

  const mimeType = typeof bestTrack.mime_type === "string" && bestTrack.mime_type ? bestTrack.mime_type : "video/mp4";
  return {
    chunks,
    segmentCount: segmentUrls.length,
    mimeType,
    fileExtension: getMimeExtension(mimeType)
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractJsonObjectAfterMarker(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return "";
  }

  const objectStart = text.indexOf("{", markerIndex + marker.length);
  if (objectStart === -1) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = objectStart; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(objectStart, i + 1);
      }
    }
  }

  return "";
}

function parseVimeoPlayerConfigFromHtml(htmlText) {
  const objectText = extractJsonObjectAfterMarker(htmlText, "window.playerConfig = ");
  if (!objectText) {
    throw new Error("Vimeo player HTML does not contain window.playerConfig.");
  }

  try {
    return JSON.parse(objectText);
  } catch {
    throw new Error("Failed to parse Vimeo playerConfig JSON.");
  }
}

function pickUrlFromCdnBlock(block) {
  if (!isPlainObject(block) || !isPlainObject(block.cdns)) {
    return "";
  }

  const cdns = block.cdns;
  const pickFromEntry = (entry) => {
    if (!isPlainObject(entry)) {
      return "";
    }
    if (typeof entry.url === "string" && entry.url) {
      return entry.url;
    }
    if (typeof entry.avc_url === "string" && entry.avc_url) {
      return entry.avc_url;
    }
    return "";
  };

  if (typeof block.default_cdn === "string" && cdns[block.default_cdn]) {
    const url = pickFromEntry(cdns[block.default_cdn]);
    if (url) {
      return url;
    }
  }

  for (const entry of Object.values(cdns)) {
    const url = pickFromEntry(entry);
    if (url) {
      return url;
    }
  }
  return "";
}

function resolveVimeoManifestUrlFromPlayerConfig(config) {
  const files = config?.request?.files;
  if (!isPlainObject(files)) {
    return "";
  }

  const dashUrl = pickUrlFromCdnBlock(files.dash);
  if (dashUrl) {
    return dashUrl;
  }

  const hlsUrl = pickUrlFromCdnBlock(files.hls);
  if (hlsUrl) {
    return hlsUrl;
  }

  return "";
}

function inferMimeAndExtensionFromSegmentUrls(segmentUrls, fallbackMimeType, fallbackExtension) {
  const lowerUrls = segmentUrls.map((url) => url.toLowerCase());
  if (lowerUrls.some((url) => /\.(m4s|mp4)(\?|$)/.test(url))) {
    return { mimeType: "video/mp4", fileExtension: "mp4" };
  }
  if (lowerUrls.some((url) => /\.(ts|bin)(\?|$)/.test(url))) {
    return { mimeType: "video/mp2t", fileExtension: "ts" };
  }
  return {
    mimeType: fallbackMimeType,
    fileExtension: fallbackExtension
  };
}

async function downloadSegmentBuffers(segmentUrls, signal, progressMessageFactory) {
  const chunks = [];
  for (let i = 0; i < segmentUrls.length; i += 1) {
    throwIfAborted(signal);
    if (typeof progressMessageFactory === "function") {
      await progressMessageFactory(i + 1, segmentUrls.length);
    }
    const buffer = await fetchSegmentWithRetry(segmentUrls[i], MAX_SEGMENT_RETRIES, signal);
    chunks.push(buffer);
  }
  return chunks;
}

async function resolveVimeoManifestUrlFromPlayerPage(playerPageUrl, signal) {
  const htmlText = await fetchText(playerPageUrl, signal);
  const playerConfig = parseVimeoPlayerConfigFromHtml(htmlText);
  const manifestUrl = resolveVimeoManifestUrlFromPlayerConfig(playerConfig);
  if (!manifestUrl) {
    throw new Error("Vimeo player config does not expose DASH/HLS manifest URLs.");
  }

  const resolved = resolveUrl(manifestUrl, playerPageUrl);
  if (!resolved || !isHttpUrl(resolved)) {
    throw new Error("Vimeo manifest URL from player config is invalid.");
  }
  return resolved;
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
    throw new Error("URL is not a supported source URL (expected custom playlist, Vimeo playlist.json, or Vimeo player page URL).");
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
    let chunks = [];
    let segmentCount = 0;
    let mimeType = "video/mp2t";
    let fileExtension = "ts";
    let resolvedSourceUrl = urlString;

    if (mediaInfo.sourceType === "vimeo-player-page") {
      await reportStatus(mediaKey, {
        state: "running",
        message: "Resolving Vimeo player config..."
      });
      resolvedSourceUrl = await resolveVimeoManifestUrlFromPlayerPage(urlString, signal);
    }

    if (
      mediaInfo.sourceType === "vimeo" ||
      (mediaInfo.sourceType === "vimeo-player-page" && resolvedSourceUrl.includes("playlist.json"))
    ) {
      await reportStatus(mediaKey, {
        state: "running",
        message: "Resolving Vimeo playlist..."
      });
      const vimeoResult = await resolveVimeoChunksFromPlaylistJson(resolvedSourceUrl, signal, async (message) => {
        await reportStatus(mediaKey, {
          state: "running",
          message
        });
      });
      chunks = vimeoResult.chunks;
      segmentCount = vimeoResult.segmentCount;
      mimeType = vimeoResult.mimeType;
      fileExtension = vimeoResult.fileExtension;
    } else {
      const segmentUrls = await resolveSegmentUrlsFromPlaylistUrl(resolvedSourceUrl, signal);
      chunks = await downloadSegmentBuffers(segmentUrls, signal, async (index, total) => {
        await reportStatus(mediaKey, {
          state: "running",
          message: `Downloading segments ${index}/${total}...`
        });
      });
      segmentCount = segmentUrls.length;
      const fallbackMimeType = mediaInfo.sourceType === "custom" ? "video/mp2t" : "video/mp4";
      const fallbackExtension = mediaInfo.sourceType === "custom" ? "ts" : "mp4";
      const inferred = inferMimeAndExtensionFromSegmentUrls(segmentUrls, fallbackMimeType, fallbackExtension);
      mimeType = inferred.mimeType;
      fileExtension = inferred.fileExtension;
    }

    throwIfAborted(signal);
    await reportStatus(mediaKey, {
      state: "running",
      message: "Merging segments..."
    });

    const filename = buildDownloadFilename(urlString, lessonTitle, fileExtension);
    const blob = new Blob(chunks, { type: mimeType });
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
      segmentCount,
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
