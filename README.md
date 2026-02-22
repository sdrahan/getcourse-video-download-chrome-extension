# Playlist Media URL Capture (Chrome Extension, MV3)

This extension passively observes outgoing requests and records playlist-media URLs that match:

- Path contains: `/api/playlist/media/` (host can vary)
- Path ends with numeric resolution segment (example: `/360`, `/720`, `/1080`)
- Query includes: `user-id`
- URL also passes a configurable `"video"` predicate

Captured URLs are shown in the popup with copy/download controls, lesson context (when available), and item removal.

## Install (Load Unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select this folder: `/Users/sdrahan/projects/getcourse-video-download-chrome-extension`.
5. Pin the extension if desired.

## Quick Test

1. Open DevTools on a page where video playback triggers requests.
2. Start video playback.
3. Open the extension popup.
4. Confirm captured entries appear (most recent first).
5. Use **Copy** on any row, **Download** to assemble and save the video as `.ts`, **Stop** to interrupt an active download, **Remove** to delete a single item, or **Clear** to reset the session list.

If you want to force a test quickly, trigger a request in any tab to a URL like:
`https://example-cdn.test/api/playlist/media/abc/def/720?user-cdn=cdnvideo&user-id=123`

## Where to Change Matching Logic

- Main matcher and predicate: `/Users/sdrahan/projects/getcourse-video-download-chrome-extension/background.js`
- Edit:
  - `passesVideoPredicate(urlString)` for the `"video"` condition
  - `parseMatchingInfo(urlString)` for path/query/resolution rules

## Storage + Badge Behavior

- Session storage key: `capturedPlaylistUrls` in `chrome.storage.session`
- De-duplication: same URL is moved to top with fresh timestamp
- For the same media key (path part after `/api/playlist/media/`), only the highest resolution is kept
- If `.lesson-title-value` is available on the source tab at capture time, it is stored and shown in metadata
- Max kept: `30` (configurable in `background.js`)
- Badge shows current captured count

## Download Behavior (Built-in)

- Download trigger/UI is in `/Users/sdrahan/projects/getcourse-video-download-chrome-extension/popup.js`.
- Download execution runs in `/Users/sdrahan/projects/getcourse-video-download-chrome-extension/offscreen.js` (triggered by `/Users/sdrahan/projects/getcourse-video-download-chrome-extension/background.js`), so it continues even if popup closes.
- It mirrors your Bash flow:
  - Fetch captured playlist URL.
  - If playlist contains direct segment links (`.ts`/`.bin`), use it directly.
  - Otherwise take the last media-playlist line and fetch it.
  - Download all media segment URLs in order (with retries) and merge to one `.ts`.
  - Save into Chrome Downloads via `chrome.downloads`.
- While running, each item shows a **Stop** button. It cancels the in-progress job and attempts to cancel any started Chrome download entry.
- Filename rule:
  - If page has `.lesson-title-value`, output filename is: `<lesson title> <video_id>.ts`
  - If not found, output filename is: `<video_id>.ts`
  - `video_id` is the last segment of the media key inside `/api/playlist/media/.../<resolution>`

Note: merge is done in extension memory before download starts, so very large videos can be memory-heavy.

## MV3 Service Worker Debugging Notes

1. In `chrome://extensions`, find this extension.
2. Click **Service worker** link under the extension card to open its DevTools.
3. Watch Console logs/errors from `background.js`.
4. Remember MV3 service workers are ephemeral and can stop when idle.

## Why `<all_urls>` Host Permissions

This extension uses `chrome.webRequest` in observe-only mode. For reliable visibility, Chrome permission checks involve:

- The actual request URL
- The initiator/origin that triggered the request

Using `<all_urls>` avoids missing valid captures when requests originate from arbitrary sites.
