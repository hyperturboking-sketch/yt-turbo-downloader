// Content script - runs on youtube.com

async function getVideoData(videoId) {
  // Must be on youtube.com
  if (!location.hostname.includes('youtube.com')) return null;

  // Method 1: fetch player API from same-origin page (has cookies)
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
    // Must be JSON, not HTML
    const ct = resp.headers.get('content-type') || '';
    if (resp.ok && ct.includes('json')) {
      const data = await resp.json();
      // Must have streamingData with actual URLs
      const fmts = [...(data.streamingData?.formats || []), ...(data.streamingData?.adaptiveFormats || [])];
      const hasUrls = fmts.some(f => f.url);
      if (hasUrls) return buildResponse(data, videoId);
    }
  } catch {}

  // Method 2: read ytInitialPlayerResponse from the page
  try {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const t = s.textContent;
      if (t.includes('ytInitialPlayerResponse')) {
        const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?"streamingData"[\s\S]*?\});/);
        if (m) {
          const data = JSON.parse(m[1]);
          const fmts = [...(data.streamingData?.formats || []), ...(data.streamingData?.adaptiveFormats || [])];
          if (fmts.some(f => f.url)) return buildResponse(data, videoId);
        }
      }
    }
  } catch {}

  // Method 3: check global variable
  try {
    if (window.ytInitialPlayerResponse?.streamingData) {
      const data = window.ytInitialPlayerResponse;
      const fmts = [...(data.streamingData?.formats || []), ...(data.streamingData?.adaptiveFormats || [])];
      if (fmts.some(f => f.url)) return buildResponse(data, videoId);
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
    title: details.title || 'Unknown',
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
      if (data?.formats?.length) sendResponse(data);
      else sendResponse({ error: 'No downloadable formats found. The video may require sign-in.' });
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
