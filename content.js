// Content script - runs on youtube.com

// Get video data via multiple methods
async function getVideoData(videoId) {
  // Method 1: fetch player API from page context (same-origin, has cookies)
  try {
    const resp = await fetch('/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: '2.20250722.07.00', hl: 'en', gl: 'US' } },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.streamingData?.formats?.length || data.streamingData?.adaptiveFormats?.length) {
        return buildResponse(data, videoId);
      }
    }
  } catch {}

  // Method 2: try ytInitialPlayerResponse via script injection
  try {
    const resp = await fetch('/watch?v=' + videoId);
    const html = await resp.text();
    const match = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*var\s+meta/);
    if (match) {
      const data = JSON.parse(match[1]);
      if (data.streamingData) return buildResponse(data, videoId);
    }
    // Fallback regex
    const match2 = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?"streamingData"[\s\S]+?\});/);
    if (match2) {
      const data = JSON.parse(match2[1]);
      if (data.streamingData) return buildResponse(data, videoId);
    }
  } catch {}

  return null;
}

function buildResponse(data, videoId) {
  const details = data.videoDetails || {};
  const formats = data.streamingData?.formats || [];
  const adaptive = data.streamingData?.adaptiveFormats || [];
  return {
    videoId: details.videoId || videoId,
    title: details.title || document.title.replace(' - YouTube', '').trim(),
    duration: parseInt(details.lengthSeconds) || 0,
    views: parseInt(details.viewCount) || 0,
    author: details.author || '',
    thumbnail: details.thumbnail?.thumbnails?.[0]?.url || '',
    url: 'https://www.youtube.com/watch?v=' + (details.videoId || videoId),
    formats: [...formats, ...adaptive].map(f => ({
      itag: f.itag,
      quality: f.qualityLabel || f.quality,
      mimeType: f.mimeType,
      width: f.width,
      height: f.height,
      bitrate: f.bitrate,
      contentLength: f.contentLength,
      url: f.url || null,
      signatureCipher: f.signatureCipher || null,
      audioQuality: f.audioQuality,
    })),
  };
}

// Handle messages from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DATA') {
    getVideoData(msg.videoId).then(data => {
      if (data) sendResponse(data);
      else sendResponse({ error: 'No video data found. Refresh the page.' });
    }).catch(() => {
      sendResponse({ error: 'Failed to get video data.' });
    });
    return true;
  }
});

// In-page download button
function addDownloadButton() {
  if (document.getElementById('yt-turbo-btn')) return;
  const actions = document.querySelector('#above-the-fold #menu-container, ytd-watch-metadata #actions, #actions ytd-menu-renderer');
  if (!actions) return;

  const btn = document.createElement('button');
  btn.id = 'yt-turbo-btn';
  btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download</span>';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD',
      url: window.location.href,
      quality: '1080',
      format: 'video',
      title: document.title.replace(' - YouTube', '').trim(),
    });
  });

  const firstBtn = actions.querySelector('ytd-button-renderer, button, #share-button, #like-button');
  if (firstBtn) firstBtn.parentNode.insertBefore(btn, firstBtn);
  else actions.appendChild(btn);
}

let lastUrl = '';
function checkUrl() {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    if (/youtube\.com\/(watch|shorts)/.test(lastUrl)) {
      setTimeout(addDownloadButton, 1500);
    }
  }
}

const observer = new MutationObserver(checkUrl);
observer.observe(document.body, { childList: true, subtree: true });
checkUrl();
