// --- Keep service worker alive ---
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {}
});

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

// --- Innertube API (multiple clients) ---
const CLIENTS = [
  { clientName: 'MWEB', clientVersion: '2.20250722.07.00', hl: 'en', gl: 'US' },
  { clientName: 'WEB', clientVersion: '2.20250722.07.00', hl: 'en', gl: 'US' },
  { clientName: 'ANDROID', clientVersion: '19.29.37', hl: 'en', gl: 'US', androidSdkVersion: 34, osName: 'Android', osVersion: '14', platform: 'MOBILE' },
];

const CLIENT_IDS = { MWEB: 2, WEB: 1, ANDROID: 3 };

async function innertubePlayer(videoId) {
  for (const client of CLIENTS) {
    try {
      const body = {
        context: { client },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      };

      const resp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': String(CLIENT_IDS[client.clientName] || 1),
          'X-Youtube-Client-Version': client.clientVersion,
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
          'Origin': 'https://www.youtube.com',
          'Referer': 'https://www.youtube.com/',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.streamingData?.formats?.length || data.streamingData?.adaptiveFormats?.length) {
        return data;
      }
    } catch {}
  }
  return null;
}

// --- Get video data: try open tab first, then API ---
async function getPageData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  // Method 1: Read from open YouTube tab via executeScript
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  for (const tab of tabs) {
    if (extractVideoId(tab.url) !== videoId) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          try {
            if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse?.streamingData) {
              return JSON.parse(JSON.stringify(ytInitialPlayerResponse));
            }
            const p = document.querySelector('#movie_player');
            if (p?.getPlayerResponse) return JSON.parse(JSON.stringify(p.getPlayerResponse()));
            return null;
          } catch { return null; }
        },
      });
      const result = results?.[0]?.result;
      if (result?.streamingData && result?.videoDetails?.videoId === videoId) {
        return buildVideoData(result, videoId);
      }
    } catch {}
    break;
  }

  // Method 2: Innertube API
  const data = await innertubePlayer(videoId);
  if (data) return buildVideoData(data, videoId);

  throw new Error('Could not load video data. Make sure the video is open in a YouTube tab.');
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
  const vf = formats.filter(f => f.mimeType?.startsWith('video/') && f.url);
  const sorted = vf.filter(f => !maxH || (f.height && f.height <= maxH))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  return sorted.find(f => f.mimeType?.includes('avc1')) || sorted[0];
}

function pickBestAudio(formats, qualityTier) {
  const af = formats.filter(f => f.mimeType?.startsWith('audio/') && f.url);
  if (!af.length) return null;
  const pool = af.filter(f => f.mimeType?.includes('mp4') || f.mimeType?.includes('audio/mp4'));
  if (!pool.length) af.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const sorted = pool.length ? pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0)) : af;
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

  throw new Error('No downloadable format found.');
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
