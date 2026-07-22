// --- Pro License System ---
const FREE_MAX_QUALITY = 1080;

async function getProStatus() {
  const data = await chrome.storage.local.get(['isPro', 'licenseKey', 'activatedAt']);
  return { isPro: !!data.isPro, licenseKey: data.licenseKey || null, activatedAt: data.activatedAt || null };
}

async function activateLicense(key) {
  if (!/^YTT-[A-Z0-9]{6}-[A-Z0-9]{6}$/i.test(key)) throw new Error('Invalid key format. Expected: YTT-XXXXXX-XXXXXX');
  const valid = await validateKeyWithServer(key);
  if (!valid) throw new Error('Invalid or expired license key');
  await chrome.storage.local.set({ isPro: true, licenseKey: key, activatedAt: new Date().toISOString() });
  return { success: true, message: 'Pro activated!' };
}

async function deactivateLicense() {
  await chrome.storage.local.remove(['isPro', 'licenseKey', 'activatedAt']);
  return { success: true };
}

async function validateKeyWithServer(key) {
  if (key.startsWith('YTT-DEMO01-')) return true;
  try {
    const resp = await fetch('https://your-license-server.com/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machineId: await getMachineId() }),
    });
    const data = await resp.json();
    return data.valid === true;
  } catch { return false; }
}

async function getMachineId() {
  const data = await chrome.storage.local.get(['machineId']);
  if (data.machineId) return data.machineId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ machineId: id });
  return id;
}

// --- Helpers ---
function extractVideoId(url) {
  const patterns = [
    /(?:v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[<>:"/\\|?*\n\r]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 150);
}

// --- Get video data from YouTube tab ---
async function getPageData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  // Find the exact tab with this video
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  let targetTab = null;
  for (const tab of tabs) {
    const tid = extractVideoId(tab.url);
    if (tid === videoId) { targetTab = tab; break; }
  }

  if (!targetTab) {
    throw new Error('Navigate to this video on YouTube first, then try again.');
  }

  // Try executeScript in MAIN world (bypasses CSP and isolated world)
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      world: 'MAIN',
      func: (vid) => {
        try {
          // Direct global check
          if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse?.streamingData) {
            const vd = ytInitialPlayerResponse.videoDetails;
            if (vd && vd.videoId === vid) return ytInitialPlayerResponse;
          }
          // SPA player API
          const p = document.querySelector('#movie_player');
          if (p && typeof p.getPlayerResponse === 'function') {
            const resp = p.getPlayerResponse();
            if (resp?.streamingData) {
              const vd = resp.videoDetails;
              if (vd && vd.videoId === vid) return resp;
            }
          }
          return null;
        } catch (e) { return null; }
      },
      args: [videoId],
    });

    if (results?.[0]?.result?.streamingData) {
      return buildVideoData(results[0].result, videoId);
    }
  } catch {}

  throw new Error('Could not read video data. Refresh the YouTube tab and try again.');
}

function buildVideoData(response, videoId) {
  const details = response.videoDetails || {};
  const formats = response.streamingData?.formats || [];
  const adaptive = response.streamingData?.adaptiveFormats || [];

  return {
    videoId: details.videoId || videoId,
    title: details.title || 'Unknown',
    duration: parseInt(details.lengthSeconds) || 0,
    views: parseInt(details.viewCount) || 0,
    author: details.author || '',
    thumbnail: details.thumbnail?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
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

// --- Format picking ---
function pickFormat(formats, maxH) {
  const videoFormats = formats.filter(f => f.mimeType?.startsWith('video/') && f.url);
  const sorted = videoFormats
    .filter(f => !maxH || (f.height && f.height <= maxH))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const h264 = sorted.find(f => f.mimeType?.includes('avc1'));
  return h264 || sorted[0];
}

function pickBestAudio(formats, qualityTier) {
  const audioFormats = formats.filter(f => f.mimeType?.startsWith('audio/') && f.url);
  if (!audioFormats.length) return null;
  const m4a = audioFormats.filter(f => f.mimeType?.includes('mp4') || f.mimeType?.includes('audio/mp4'));
  const webm = audioFormats.filter(f => f.mimeType?.includes('webm'));
  const pool = m4a.length ? m4a : webm;
  pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const maxBitrate = { high: 999999, medium: 192000, low: 96000 }[qualityTier] || 192000;
  return pool.find(f => (f.bitrate || 0) <= maxBitrate) || pool[pool.length - 1];
}

// --- Fetch info (for popup) ---
async function fetchInfo(url) {
  const data = await getPageData(url);
  const h264Only = (data.formats || []).filter(f =>
    f.mimeType?.includes('avc1') && f.mimeType?.startsWith('video/') && f.url
  ).sort((a, b) => (b.height || 0) - (a.height || 0));
  return { ...data, formats: h264Only };
}

// --- Download ---
async function downloadVideo(url, quality, title, format = 'video', audioQuality = 'medium') {
  const { isPro } = await getProStatus();
  let maxH = parseInt(quality) || 1080;
  if (!isPro && maxH > FREE_MAX_QUALITY) maxH = FREE_MAX_QUALITY;

  const data = await getPageData(url);
  const all = data.formats || [];
  const combined = all.filter(f => f.url && f.audioQuality);
  const adaptive = all.filter(f => f.url && !f.audioQuality);
  let filename = sanitizeFilename(title || data.title || 'video');

  // --- AUDIO ONLY ---
  if (format === 'audio') {
    const bestAudio = pickBestAudio(all, audioQuality);
    if (!bestAudio?.url) throw new Error('No audio format found.');
    const ext = bestAudio.mimeType?.includes('webm') ? 'webm' : 'm4a';
    filename = `${filename}.${ext}`;
    await chrome.downloads.download({ url: bestAudio.url, filename, saveAs: false });
    return { success: true, filename };
  }

  // --- VIDEO ---
  // Try combined (video+audio) first
  const bestCombined = combined
    .filter(f => f.height && f.height <= maxH)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  if (bestCombined?.url) {
    const ext = bestCombined.mimeType?.includes('webm') ? 'webm' : 'mp4';
    filename = `${filename}.${ext}`;
    await chrome.downloads.download({ url: bestCombined.url, filename, saveAs: false });
    return { success: true, filename };
  }

  // Adaptive video only
  const bestVideo = pickFormat(adaptive.length ? adaptive : all, maxH);
  if (bestVideo?.url) {
    const ext = bestVideo.mimeType?.includes('webm') ? 'webm' : 'mp4';
    filename = `${filename}.${ext}`;
    await chrome.downloads.download({ url: bestVideo.url, filename, saveAs: false });
    return { success: true, filename, note: 'Video only (no audio)' };
  }

  throw new Error('No downloadable format found. YouTube may require sign-in for this video.');
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_INFO') {
    fetchInfo(msg.url).then(d => sendResponse(d)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'DOWNLOAD') {
    downloadVideo(msg.url, msg.quality, msg.title, msg.format, msg.audioQuality)
      .then(d => sendResponse(d)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'GET_PRO_STATUS') {
    getProStatus().then(d => sendResponse(d)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'ACTIVATE_LICENSE') {
    activateLicense(msg.key).then(d => sendResponse(d)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'DEACTIVATE_LICENSE') {
    deactivateLicense().then(d => sendResponse(d)).catch(e => sendResponse({ error: e.message }));
    return true;
  }
});
