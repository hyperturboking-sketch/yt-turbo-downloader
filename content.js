// Content script - runs on YouTube pages, has access to page JS context

function getPlayerResponse() {
  // YouTube embeds video data in these globals
  if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse?.streamingData) {
    return ytInitialPlayerResponse;
  }
  // SPA navigation - check for player API
  const player = document.querySelector('#movie_player');
  if (player?.getPlayerResponse) {
    return player.getPlayerResponse();
  }
  // Try from page source
  const scripts = document.querySelectorAll('script');
  for (const s of scripts) {
    const text = s.textContent;
    if (text.includes('ytInitialPlayerResponse')) {
      const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
      if (match) {
        try { return JSON.parse(match[1]); } catch {}
      }
    }
  }
  return null;
}

function extractVideoData(response) {
  if (!response) return null;
  const details = response.videoDetails || {};
  const formats = response.streamingData?.formats || [];
  const adaptive = response.streamingData?.adaptiveFormats || [];
  const all = [...formats, ...adaptive];

  const videoId = details.videoId || '';

  return {
    videoId,
    title: details.title || document.title.replace(' - YouTube', '').trim(),
    duration: parseInt(details.lengthSeconds) || 0,
    views: parseInt(details.viewCount) || 0,
    author: details.author || '',
    thumbnail: details.thumbnail?.thumbnails?.[0]?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    formats: all.map(f => ({
      itag: f.itag,
      quality: f.qualityLabel || f.quality,
      mimeType: f.mimeType,
      width: f.width,
      height: f.height,
      bitrate: f.bitrate,
      contentLength: f.contentLength,
      url: f.url,
      signatureCipher: f.signatureCipher,
      audioQuality: f.audioQuality,
    })),
  };
}

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PAGE_DATA') {
    const response = getPlayerResponse();
    const data = extractVideoData(response);
    sendResponse(data || { error: 'Could not extract video data. Try refreshing the page.' });
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
    const response = getPlayerResponse();
    const data = extractVideoData(response);
    if (data?.formats?.length) {
      // Find best combined format
      const combined = data.formats.filter(f => f.url && f.audioQuality);
      const best = combined.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      if (best?.url) {
        const a = document.createElement('a');
        a.href = best.url;
        a.download = (data.title || 'video') + '.mp4';
        a.click();
      }
    }
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
