const MAX_SEGMENT_RETRIES = 12;
const activeDownloads = new Map();

class CancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "CancelledError";
  }
}

class FfmpegRequiredError extends Error {
  constructor(message, ffmpegCommand) {
    super(message);
    this.name = "FfmpegRequiredError";
    this.ffmpegCommand = ffmpegCommand || "";
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
  return (
    isVimeoCdnHost(parsed.hostname) &&
    parsed.pathname.includes("/v2/playlist/av/") &&
    parsed.pathname.endsWith("/playlist.json")
  );
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
  let videoId = sanitizeFilePart(mediaInfo ? mediaInfo.videoId : "video");
  if (videoId.length > 48) {
    videoId = videoId.slice(0, 48);
  }
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

function safeUrlForLog(urlString) {
  try {
    const parsed = new URL(urlString);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(urlString || "");
  }
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function buildFfmpegCommand(inputUrl, outputFilename) {
  const outputName = sanitizeFilePart(outputFilename || "video.mp4").slice(0, 140) || "video.mp4";
  const outputPath = `$HOME/Downloads/${outputName}`;
  return `ffmpeg -hide_banner -loglevel warning -i ${shellQuote(
    inputUrl
  )} -map 0:v:0 -map 0:a:0 -c copy -movflags +faststart "${outputPath}"`;
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

function sortTracksByQuality(tracks) {
  tracks.sort((a, b) => {
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
  return tracks;
}

function trackLikelyHasEmbeddedAudio(track) {
  if (!track || typeof track !== "object") {
    return false;
  }
  if (track.has_audio === true || track.audio === true) {
    return true;
  }
  if (getTrackNumericValue(track, ["audio_channels", "channels", "channel_count"]) > 0) {
    return true;
  }
  if (typeof track.audio_codec === "string" && track.audio_codec.toLowerCase() !== "none") {
    return true;
  }
  if (typeof track.codecs === "string" && /(mp4a|aac|ac-3|ec-3|opus|vorbis)/i.test(track.codecs)) {
    return true;
  }
  if (typeof track.mime_type === "string" && track.mime_type.includes("audio")) {
    return true;
  }
  return false;
}

function pickBestVimeoTrackSelection(manifest) {
  const muxedTracks = sortTracksByQuality((Array.isArray(manifest?.muxed) ? manifest.muxed : []).filter(hasUsableTrackSource));
  if (muxedTracks.length > 0) {
    return {
      track: muxedTracks[0],
      family: "muxed"
    };
  }

  const audioVideoTracks = sortTracksByQuality(
    (Array.isArray(manifest?.audio_video) ? manifest.audio_video : []).filter(hasUsableTrackSource)
  );
  if (audioVideoTracks.length > 0) {
    return {
      track: audioVideoTracks[0],
      family: "audio_video"
    };
  }

  const videoTracks = sortTracksByQuality((Array.isArray(manifest?.video) ? manifest.video : []).filter(hasUsableTrackSource));
  if (videoTracks.length > 0) {
    const embeddedAudioTracks = videoTracks.filter(trackLikelyHasEmbeddedAudio);
    if (embeddedAudioTracks.length > 0) {
      return {
        track: embeddedAudioTracks[0],
        family: "video_embedded_audio"
      };
    }

    const hasSeparateAudioTracks = (Array.isArray(manifest?.audio) ? manifest.audio : []).some(hasUsableTrackSource);
    if (hasSeparateAudioTracks) {
      throw new Error("Separate audio/video Vimeo streams require remuxing, which is not supported yet.");
    }

    throw new Error("Vimeo track appears video-only with no embedded audio metadata. Refusing to create a potentially silent file.");
  }

  return null;
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

function buildVimeoHlsTsFallbackUrl(playlistJsonUrl) {
  let parsed;
  try {
    parsed = new URL(playlistJsonUrl);
  } catch {
    return "";
  }

  if (!parsed.pathname.endsWith("/playlist.json")) {
    return "";
  }

  parsed.pathname = parsed.pathname.replace(/\/playlist\.json$/, "/playlist.m3u8");
  parsed.searchParams.set("sf", "ts");

  // Preserve AVC-compatible ladders where possible.
  const omitParam = parsed.searchParams.get("omit");
  if (typeof omitParam === "string" && omitParam.includes("av1-hevc")) {
    parsed.searchParams.set("omit", omitParam.replace("av1-hevc", "").replace(/^[-,]+|[-,]+$/g, ""));
    if (!parsed.searchParams.get("omit")) {
      parsed.searchParams.delete("omit");
    }
  }

  return parsed.toString();
}

async function resolveVimeoChunksFromPlaylistJson(playlistUrl, signal, progressCallback) {
  const playlistText = await fetchText(playlistUrl, signal);

  let manifest;
  try {
    manifest = JSON.parse(playlistText);
  } catch {
    throw new Error("Vimeo playlist response is not valid JSON.");
  }

  const selection = pickBestVimeoTrackSelection(manifest);
  if (!selection) {
    throw new Error("Vimeo playlist JSON does not expose a downloadable track.");
  }
  const bestTrack = selection.track;

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

async function resolveVimeoViaHlsTsFallback(playlistJsonUrl, signal, progressCallback) {
  const hlsTsUrl = buildVimeoHlsTsFallbackUrl(playlistJsonUrl);
  if (!hlsTsUrl) {
    throw new Error("Could not derive Vimeo HLS TS fallback URL.");
  }

  const segmentUrls = await resolveSegmentUrlsFromPlaylistUrl(hlsTsUrl, signal);
  const chunks = await downloadSegmentBuffers(segmentUrls, signal, progressCallback);
  const inferred = inferMimeAndExtensionFromSegmentUrls(segmentUrls, "video/mp2t", "ts");
  return {
    chunks,
    segmentCount: segmentUrls.length,
    mimeType: inferred.mimeType,
    fileExtension: inferred.fileExtension
  };
}

function normalizeVimeoEmbeddedSources(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const result = {
    playerPageUrl: typeof value.playerPageUrl === "string" ? value.playerPageUrl : "",
    progressive: null,
    hlsUrl: typeof value.hlsUrl === "string" ? value.hlsUrl : "",
    dashUrl: typeof value.dashUrl === "string" ? value.dashUrl : ""
  };

  if (value.progressive && typeof value.progressive === "object" && typeof value.progressive.url === "string") {
    result.progressive = {
      url: value.progressive.url,
      mimeType: typeof value.progressive.mimeType === "string" ? value.progressive.mimeType : "video/mp4",
      fileExtension: typeof value.progressive.fileExtension === "string" ? value.progressive.fileExtension : "mp4"
    };
  }

  return result;
}

function pickFfmpegInputFromSources(embeddedSources) {
  if (!embeddedSources) {
    return "";
  }

  if (typeof embeddedSources.hlsUrl === "string" && embeddedSources.hlsUrl) {
    return embeddedSources.hlsUrl;
  }
  if (typeof embeddedSources.dashUrl === "string" && embeddedSources.dashUrl) {
    return embeddedSources.dashUrl;
  }
  return "";
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

function extractVimeoPlayerPageUrlFromHtml(htmlText) {
  const text = String(htmlText || "");
  const patterns = [
    /https:\/\/player\.vimeo\.com\/video\/\d+(?:\?[^\s"'<>]*)?/gi,
    /player\.vimeo\.com\/video\/\d+(?:\?[^\s"'<>]*)?/gi
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[0]) {
      continue;
    }
    const candidate = match[0].replace(/\\/g, "");
    if (candidate.startsWith("https://")) {
      return candidate;
    }
    return `https://${candidate.replace(/^\/\//, "")}`;
  }

  return "";
}

async function resolveVimeoPlayerPageUrlFromPageUrl(pageUrl, signal) {
  if (!pageUrl || !isHttpUrl(pageUrl)) {
    return "";
  }
  const pageHtml = await fetchText(pageUrl, signal);
  return extractVimeoPlayerPageUrlFromHtml(pageHtml);
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

function resolveVimeoManifestUrlFromPlayerConfig(config, options = {}) {
  const files = config?.request?.files;
  if (!isPlainObject(files)) {
    return "";
  }

  const preferHls = options && options.preferHls === true;
  const first = preferHls ? files.hls : files.dash;
  const second = preferHls ? files.dash : files.hls;

  const firstUrl = pickUrlFromCdnBlock(first);
  if (firstUrl) {
    return firstUrl;
  }

  const secondUrl = pickUrlFromCdnBlock(second);
  if (secondUrl) {
    return secondUrl;
  }

  return "";
}

function pickBestVimeoProgressiveFile(config) {
  const progressive = config?.request?.files?.progressive;
  const list = Array.isArray(progressive) ? progressive.filter((entry) => typeof entry?.url === "string" && entry.url) : [];
  if (list.length === 0) {
    return null;
  }

  const sorted = sortTracksByQuality([...list]);
  const best = sorted[0];
  return {
    url: best.url,
    mimeType: typeof best.mime === "string" && best.mime ? best.mime : "video/mp4",
    fileExtension: "mp4"
  };
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

async function resolveVimeoManifestUrlFromPlayerPage(playerPageUrl, signal, options = {}) {
  const htmlText = await fetchText(playerPageUrl, signal);
  const playerConfig = parseVimeoPlayerConfigFromHtml(htmlText);
  const skipProgressive = options && options.skipProgressive === true;
  const progressive = skipProgressive ? null : pickBestVimeoProgressiveFile(playerConfig);
  if (progressive) {
    return {
      progressive,
      manifestUrl: ""
    };
  }

  const manifestUrl = resolveVimeoManifestUrlFromPlayerConfig(playerConfig, options);
  if (!manifestUrl) {
    throw new Error("Vimeo player config does not expose progressive or DASH/HLS sources.");
  }

  const resolved = resolveUrl(manifestUrl, playerPageUrl);
  if (!resolved || !isHttpUrl(resolved)) {
    throw new Error("Vimeo manifest URL from player config is invalid.");
  }
  return {
    progressive: null,
    manifestUrl: resolved
  };
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

async function startDownloadJob(urlString, lessonTitle, options = {}) {
  const mediaInfo = extractMediaInfoFromUrl(urlString);
  if (!mediaInfo) {
    throw new Error("URL is not a supported source URL (expected custom playlist, Vimeo playlist.json, or Vimeo player page URL).");
  }

  const debugTrace = [];
  const debug = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    debugTrace.push(line);
    if (debugTrace.length > 120) {
      debugTrace.shift();
    }
    console.log(`[offscreen:${mediaInfo.mediaKey}] ${message}`);
  };

  const mediaKey = mediaInfo.mediaKey;
  const embeddedSources = normalizeVimeoEmbeddedSources(options.vimeoEmbeddedSources);
  debug(`Start download job. sourceType=${mediaInfo.sourceType}, url=${safeUrlForLog(urlString)}`);
  if (activeDownloads.has(mediaKey)) {
    debug("Job already running for this media key.");
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
      debug(`Resolving Vimeo sources from player page ${safeUrlForLog(urlString)}`);
      await reportStatus(mediaKey, {
        state: "running",
        message: "Resolving Vimeo player config..."
      });
      const resolvedSources = await resolveVimeoManifestUrlFromPlayerPage(urlString, signal);
      if (resolvedSources.progressive) {
        debug(`Using progressive source ${safeUrlForLog(resolvedSources.progressive.url)}`);
        await reportStatus(mediaKey, {
          state: "running",
          message: "Downloading progressive MP4..."
        });
        const fullBuffer = await fetchSegmentWithRetry(resolvedSources.progressive.url, MAX_SEGMENT_RETRIES, signal);
        chunks = [fullBuffer];
        segmentCount = 1;
        mimeType = resolvedSources.progressive.mimeType;
        fileExtension = resolvedSources.progressive.fileExtension;
      } else {
        resolvedSourceUrl = resolvedSources.manifestUrl;
        debug(`Using manifest from player config ${safeUrlForLog(resolvedSourceUrl)}`);
      }
    }

    if (
      chunks.length === 0 &&
      (mediaInfo.sourceType === "vimeo" || (mediaInfo.sourceType === "vimeo-player-page" && resolvedSourceUrl.includes("playlist.json")))
    ) {
      await reportStatus(mediaKey, {
        state: "running",
        message: "Resolving Vimeo playlist..."
      });
      debug(`Resolving Vimeo playlist JSON ${safeUrlForLog(resolvedSourceUrl)}`);
      try {
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
      } catch (error) {
        const message = String(error?.message || "");
        if (message.includes("Separate audio/video Vimeo streams require remuxing")) {
          debug("Detected separate A/V in Vimeo playlist JSON.");
          let resolvedViaPlayerConfig = false;
          let ffmpegInputUrl = pickFfmpegInputFromSources(embeddedSources);
          if (ffmpegInputUrl) {
            debug(`Prepared ffmpeg input from embedded sources: ${safeUrlForLog(ffmpegInputUrl)}`);
          }
          if (embeddedSources) {
            debug("Trying signed sources from embedded Vimeo frame config.");
            try {
              if (embeddedSources.progressive && embeddedSources.progressive.url) {
                debug(`Embedded frame provided progressive ${safeUrlForLog(embeddedSources.progressive.url)}`);
                await reportStatus(mediaKey, {
                  state: "running",
                  message: "Using progressive source from Vimeo frame..."
                });
                const fullBuffer = await fetchSegmentWithRetry(embeddedSources.progressive.url, MAX_SEGMENT_RETRIES, signal);
                chunks = [fullBuffer];
                segmentCount = 1;
                mimeType = embeddedSources.progressive.mimeType;
                fileExtension = embeddedSources.progressive.fileExtension;
                resolvedViaPlayerConfig = true;
              } else {
                const frameManifestUrl = embeddedSources.hlsUrl || embeddedSources.dashUrl;
                if (frameManifestUrl) {
                  debug(`Embedded frame provided manifest ${safeUrlForLog(frameManifestUrl)} (ffmpeg route)`);
                  ffmpegInputUrl = frameManifestUrl;
                }
              }
            } catch (embeddedError) {
              debug(`Embedded frame source fallback failed: ${String(embeddedError?.message || embeddedError)}`);
            }
          }

          let playerPageUrl = typeof options.vimeoPlayerPageUrl === "string" ? options.vimeoPlayerPageUrl : "";
          if (!playerPageUrl && embeddedSources && embeddedSources.playerPageUrl) {
            playerPageUrl = embeddedSources.playerPageUrl;
          }
          if (!playerPageUrl && typeof options.pageUrl === "string" && options.pageUrl) {
            debug(`No iframe player URL provided. Trying lesson page lookup: ${safeUrlForLog(options.pageUrl)}`);
            await reportStatus(mediaKey, {
              state: "running",
              message: "Separate A/V detected. Looking up Vimeo player URL on lesson page..."
            });
            try {
              playerPageUrl = await resolveVimeoPlayerPageUrlFromPageUrl(options.pageUrl, signal);
              debug(playerPageUrl ? `Found player URL on page: ${safeUrlForLog(playerPageUrl)}` : "No player URL found in lesson page HTML.");
            } catch (pageResolveError) {
              console.warn("Failed to resolve Vimeo player page URL from lesson page", pageResolveError);
              debug(`Lesson page lookup failed: ${String(pageResolveError?.message || pageResolveError)}`);
            }
          }

          if (!resolvedViaPlayerConfig && playerPageUrl) {
            debug(`Trying signed source resolution from player page: ${safeUrlForLog(playerPageUrl)}`);
            await reportStatus(mediaKey, {
              state: "running",
              message: "Separate A/V detected. Resolving signed sources from Vimeo player page..."
            });
            try {
              const playerResolved = await resolveVimeoManifestUrlFromPlayerPage(playerPageUrl, signal, {
                preferHls: true
              });
              if (playerResolved.progressive) {
                debug(`Player config returned progressive source ${safeUrlForLog(playerResolved.progressive.url)}`);
                await reportStatus(mediaKey, {
                  state: "running",
                  message: "Found progressive MP4 via player config..."
                });
                const fullBuffer = await fetchSegmentWithRetry(playerResolved.progressive.url, MAX_SEGMENT_RETRIES, signal);
                chunks = [fullBuffer];
                segmentCount = 1;
                mimeType = playerResolved.progressive.mimeType;
                fileExtension = playerResolved.progressive.fileExtension;
                resolvedViaPlayerConfig = true;
              } else if (playerResolved.manifestUrl) {
                debug(`Player config returned manifest ${safeUrlForLog(playerResolved.manifestUrl)} (ffmpeg route)`);
                ffmpegInputUrl = playerResolved.manifestUrl;
              }
            } catch (playerError) {
              console.warn("Vimeo player-page fallback failed", playerError);
              debug(`Player config fallback failed: ${String(playerError?.message || playerError)}`);
            }
          }

          if (!resolvedViaPlayerConfig) {
            if (ffmpegInputUrl) {
              const ffmpegOutput = buildDownloadFilename(urlString, lessonTitle, "mp4");
              const ffmpegCommand = buildFfmpegCommand(ffmpegInputUrl, ffmpegOutput);
              debug(`Separate A/V requires ffmpeg mux. Command prepared for ${ffmpegOutput}`);
              throw new FfmpegRequiredError(
                "Separate Vimeo audio/video detected. Use local ffmpeg command (Copy ffmpeg) to mux with audio.",
                ffmpegCommand
              );
            }

            debug(`Falling back to derived HLS TS URL from playlist JSON ${safeUrlForLog(resolvedSourceUrl)}`);
            await reportStatus(mediaKey, {
              state: "running",
              message: "Separate A/V detected. Trying Vimeo HLS TS fallback..."
            });
            const fallback = await resolveVimeoViaHlsTsFallback(resolvedSourceUrl, signal, async (index, total) => {
              await reportStatus(mediaKey, {
                state: "running",
                message: `Downloading fallback TS segments ${index}/${total}...`
              });
            });
            chunks = fallback.chunks;
            segmentCount = fallback.segmentCount;
            mimeType = fallback.mimeType;
            fileExtension = fallback.fileExtension;
          }
        } else {
          throw error;
        }
      }
    } else if (chunks.length === 0) {
      debug(`Using generic playlist resolver on ${safeUrlForLog(resolvedSourceUrl)}`);
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
    debug(`Prepared blob (${chunks.length} chunks, mime=${mimeType}), starting browser download as ${filename}`);
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
    debug(`Download start success, downloadId=${downloadId}`);
  } catch (error) {
    if (isCancelledError(error) || job.cancelled || signal.aborted) {
      debug("Download cancelled.");
      await reportStatus(mediaKey, {
        state: "cancelled",
        message: "Download cancelled by user.",
        error: "",
        downloadId: job.downloadId,
        debugTrace: debugTrace.join("\n")
      });
    } else {
      const ffmpegCommand = typeof error?.ffmpegCommand === "string" ? error.ffmpegCommand : "";
      debug(`Download failed: ${String(error?.message || error)}`);
      await reportStatus(mediaKey, {
        state: "error",
        message: "Download failed.",
        error: error.message,
        debugTrace: debugTrace.join("\n"),
        ffmpegCommand
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
    const vimeoPlayerPageUrl = typeof message.vimeoPlayerPageUrl === "string" ? message.vimeoPlayerPageUrl : "";
    const pageUrl = typeof message.pageUrl === "string" ? message.pageUrl : "";
    const vimeoEmbeddedSources = normalizeVimeoEmbeddedSources(message.vimeoEmbeddedSources);

    if (!urlString) {
      sendResponse({ ok: false, error: "Missing URL for offscreen download." });
      return undefined;
    }

    startDownloadJob(urlString, lessonTitle, { vimeoPlayerPageUrl, pageUrl, vimeoEmbeddedSources }).catch((error) => {
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
