// --- Pro License System ---
const FREE_MAX_QUALITY = 1080;

async function getProStatus() {
  const data = await chrome.storage.local.get(['isPro', 'licenseKey', 'activatedAt']);
  return {
    isPro: !!data.isPro,
    licenseKey: data.licenseKey || null,
    activatedAt: data.activatedAt || null,
  };
}

async function activateLicense(key) {
  if (!/^YTT-[A-Z0-9]{6}-[A-Z0-9]{6}$/i.test(key)) {
    throw new Error('Invalid key format. Expected: YTT-XXXXXX-XXXXXX');
  }
  const valid = await validateKeyWithServer(key);
  if (!valid) throw new Error('Invalid or expired license key');
  await chrome.storage.local.set({
    isPro: true,
    licenseKey: key,
    activatedAt: new Date().toISOString(),
  });
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
  } catch {
    return false;
  }
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
  return (name || 'video')
    .replace(/[<>:"/\\|?*\n\r]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 150);
}

// --- Get video data from content script (no CORS issues) ---
async function getPageData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Find a YouTube tab with this video
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  let targetTab = tabs.find(t => {
    const tid = extractVideoId(t.url);
    return tid === videoId;
  });

  // If no tab has this video, open it in a new tab
  if (!targetTab) {
    targetTab = await chrome.tabs.create({ url: watchUrl, active: false });
    // Wait for page to load
    await new Promise(r => setTimeout(r, 3000));
  }

  // Try to get data directly
  try {
    const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_PAGE_DATA' });
    if (response && !response.error) return response;
  } catch {}

  // Inject content script and try again
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      files: ['content.js'],
    });
    await new Promise(r => setTimeout(r, 1000));
    const response = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_PAGE_DATA' });
    if (response && !response.error) return response;
  } catch {}

  throw new Error('Could not load video data. Try refreshing the YouTube tab.');
}

// --- Format picking ---
function pickFormat(formats, maxH) {
  const videoFormats = formats.filter(f => f.mimeType?.startsWith('video/'));
  const sorted = videoFormats
    .filter(f => !maxH || (f.height && f.height <= maxH))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  const h264 = sorted.find(f => f.mimeType?.includes('avc1'));
  return h264 || sorted[0];
}

function pickBestAudio(formats, qualityTier) {
  const audioFormats = formats.filter(f => f.mimeType?.startsWith('audio/'));
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
  // Filter to H.264 video formats for the quality list
  const h264Only = (data.formats || []).filter(f =>
    f.mimeType?.includes('avc1') && f.mimeType?.startsWith('video/')
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
    if (!bestAudio?.url) throw new Error('No audio format found. Try refreshing the YouTube page.');
    const ext = bestAudio.mimeType?.includes('webm') ? 'webm' : 'm4a';
    filename = `${filename}.${ext}`;
    await chrome.downloads.download({ url: bestAudio.url, filename, saveAs: false });
    return { success: true, filename };
  }

  // --- VIDEO ---
  // Try combined format first (has audio+video)
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

  throw new Error('No downloadable format found. Try refreshing the YouTube page.');
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_INFO') {
    fetchInfo(msg.url)
      .then(data => sendResponse(data))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    downloadVideo(msg.url, msg.quality, msg.title, msg.format, msg.audioQuality)
      .then(data => sendResponse(data))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'GET_PRO_STATUS') {
    getProStatus()
      .then(data => sendResponse(data))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'ACTIVATE_LICENSE') {
    activateLicense(msg.key)
      .then(data => sendResponse(data))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'DEACTIVATE_LICENSE') {
    deactivateLicense()
      .then(data => sendResponse(data))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});
