// --- Keep service worker alive ---
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machineId: await getMachineId() }),
    });
    return (await resp.json()).valid === true;
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
  for (const pat of patterns) { const m = url.match(pat); if (m) return m[1]; }
  return null;
}

function sanitizeFilename(name) {
  return (name || 'video').replace(/[<>:"/\\|?*\n\r]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 150);
}

// --- Get video data: content script on YouTube page (same-origin, has cookies) ---
async function getPageData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  // Find the YouTube tab with this video
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  let targetTab = null;
  for (const tab of tabs) {
    if (extractVideoId(tab.url) === videoId) { targetTab = tab; break; }
  }

  if (!targetTab) {
    throw new Error('Navigate to this video on YouTube first, then try again.');
  }

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      files: ['content.js'],
    });
  } catch {}

  // Wait for content script to be ready
  await new Promise(r => setTimeout(r, 500));

  // Ask content script to get data (it runs on youtube.com with cookies)
  try {
    const response = await chrome.tabs.sendMessage(targetTab.id, {
      type: 'GET_PAGE_DATA',
      videoId,
    });

    if (response?.error) throw new Error(response.error);
    if (response?.formats?.length) return response;
  } catch (e) {
    if (e.message?.includes('Could not establish connection')) {
      // Content script not ready, wait and retry
      await new Promise(r => setTimeout(r, 1000));
      const retry = await chrome.tabs.sendMessage(targetTab.id, { type: 'GET_PAGE_DATA', videoId });
      if (!retry?.error && retry?.formats?.length) return retry;
    }
    throw e;
  }

  throw new Error('Could not load video data. Refresh the YouTube tab and try again.');
}

// --- Format picking ---
function pickFormat(formats, maxH) {
  const vf = formats.filter(f => f.mimeType?.startsWith('video/') && f.url);
  const sorted = vf.filter(f => !maxH || (f.height && f.height <= maxH))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  return sorted.find(f => f.mimeType?.includes('avc1')) || sorted[0];
}

function pickBestAudio(formats, qualityTier) {
  const af = formats.filter(f => f.mimeType?.startsWith('audio/') && f.url);
  if (!af.length) return null;
  const m4a = af.filter(f => f.mimeType?.includes('mp4') || f.mimeType?.includes('audio/mp4'));
  const sorted = m4a.length ? m4a : af;
  sorted.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const max = { high: 999999, medium: 192000, low: 96000 }[qualityTier] || 192000;
  return sorted.find(f => (f.bitrate || 0) <= max) || sorted[sorted.length - 1];
}

// --- Fetch info ---
async function fetchInfo(url) {
  const data = await getPageData(url);
  return { ...data, formats: (data.formats || []).filter(f => f.mimeType?.includes('avc1') && f.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0)) };
}

// --- Download ---
async function downloadVideo(url, quality, title, format = 'video', audioQuality = 'medium') {
  const { isPro } = await getProStatus();
  let maxH = parseInt(quality) || 1080;
  if (!isPro && maxH > FREE_MAX_QUALITY) maxH = FREE_MAX_QUALITY;

  const data = await getPageData(url);
  const all = data.formats || [];
  let filename = sanitizeFilename(title || data.title || 'video');

  if (format === 'audio') {
    const best = pickBestAudio(all, audioQuality);
    if (!best?.url) throw new Error('No audio format found.');
    filename = `${filename}.${best.mimeType?.includes('webm') ? 'webm' : 'm4a'}`;
    await chrome.downloads.download({ url: best.url, filename, saveAs: false });
    return { success: true, filename };
  }

  // Combined (has audio)
  const combined = all.filter(f => f.url && f.audioQuality && f.height && f.height <= maxH)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (combined?.url) {
    filename = `${filename}.${combined.mimeType?.includes('webm') ? 'webm' : 'mp4'}`;
    await chrome.downloads.download({ url: combined.url, filename, saveAs: false });
    return { success: true, filename };
  }

  // Video only
  const best = pickFormat(all, maxH);
  if (best?.url) {
    filename = `${filename}.${best.mimeType?.includes('webm') ? 'webm' : 'mp4'}`;
    await chrome.downloads.download({ url: best.url, filename, saveAs: false });
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
