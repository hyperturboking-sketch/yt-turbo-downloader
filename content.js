// Content script - runs on youtube.com, has same-origin access

// Make Innertube API call from within the YouTube page (has cookies/session)
async function fetchPlayerFromPage(videoId) {
  // Get ytcfg for API key and client info
  let apiKey = '';
  let clientName = 'WEB';
  let clientVersion = '2.20250722.07.00';

  try {
    if (typeof ytcfg !== 'undefined') {
      apiKey = ytcfg.get('INNERTUBE_API_KEY') || '';
      clientName = ytcfg.get('INNERTUBE_CLIENT_NAME') || 'WEB';
      clientVersion = ytcfg.get('INNERTUBE_CLIENT_VERSION') || clientVersion;
    }
  } catch {}

  const resp = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: { client: { clientName, clientVersion, hl: 'en', gl: 'US' } },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.streamingData?.formats?.length || data.streamingData?.adaptiveFormats?.length) {
    return data;
  }
  return null;
}

// Handle messages from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DATA') {
    (async () => {
      const videoId = msg.videoId;
      if (!videoId) { sendResponse({ error: 'No video ID' }); return; }

      // Method 1: Try ytInitialPlayerResponse (has URLs or cipher)
      let data = null;
      try {
        if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse?.streamingData) {
          data = ytInitialPlayerResponse;
        }
      } catch {}

      // Method 2: Fetch from Innertube API with page cookies (best chance of direct URLs)
      if (!data?.streamingData) {
        try { data = await fetchPlayerFromPage(videoId); } catch {}
      }

      // Method 3: Player API
      if (!data?.streamingData) {
        try {
          const p = document.querySelector('#movie_player');
          if (p?.getPlayerResponse) data = p.getPlayerResponse();
        } catch {}
      }

      if (!data?.streamingData) {
        sendResponse({ error: 'No video data found. Refresh the page.' });
        return;
      }

      const details = data.videoDetails || {};
      const formats = data.streamingData?.formats || [];
      const adaptive = data.streamingData?.adaptiveFormats || [];

      sendResponse({
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
      });
    })();
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
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    <span>Download</span>
  `;
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
  if (firstBtn) {
    firstBtn.parentNode.insertBefore(btn, firstBtn);
  } else {
    actions.appendChild(btn);
  }
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
