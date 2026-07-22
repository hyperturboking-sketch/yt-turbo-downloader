// Content script - runs on youtube.com pages

// Inject page-context script to read player data
function getPlayerResponse() {
  return new Promise((resolve) => {
    const id = '__yt_turbo_' + Date.now();

    // Listen for response
    function onMsg(e) {
      if (e.data?.id === id) {
        window.removeEventListener('message', onMsg);
        resolve(e.data.result);
      }
    }
    window.addEventListener('message', onMsg);

    // Inject script into page world via DOM
    const s = document.createElement('script');
    s.textContent = `window.postMessage({id:"${id}",result:(function(){
      try {
        if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse?.streamingData) {
          return ytInitialPlayerResponse;
        }
        // Try from player API
        const p = document.querySelector('#movie_player');
        if (p && p.getPlayerResponse) return p.getPlayerResponse();
        return null;
      } catch(e) { return null; }
    })()})`;
    (document.head || document.documentElement).appendChild(s);
    s.remove();

    // Timeout
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 2000);
  });
}

// Handle messages from background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DATA') {
    getPlayerResponse().then(resp => {
      if (!resp?.streamingData) {
        sendResponse({ error: 'No video data found. Refresh the page and try again.' });
        return;
      }
      const details = resp.videoDetails || {};
      const formats = resp.streamingData?.formats || [];
      const adaptive = resp.streamingData?.adaptiveFormats || [];
      sendResponse({
        videoId: details.videoId || '',
        title: details.title || document.title.replace(' - YouTube', '').trim(),
        duration: parseInt(details.lengthSeconds) || 0,
        views: parseInt(details.viewCount) || 0,
        author: details.author || '',
        thumbnail: details.thumbnail?.thumbnails?.[0]?.url || '',
        url: 'https://www.youtube.com/watch?v=' + (details.videoId || ''),
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
