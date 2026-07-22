// --- Pro License System ---
const FREE_MAX_QUALITY = 1080;
const PRO_QUALITIES = [1440, 2160]; // 1440p, 4K

async function getProStatus() {
  const data = await chrome.storage.local.get(['isPro', 'licenseKey', 'activatedAt']);
  return {
    isPro: !!data.isPro,
    licenseKey: data.licenseKey || null,
    activatedAt: data.activatedAt || null,
  };
}

async function activateLicense(key) {
  // Simple key format: YTT-{6 alphanumeric}-{6 alphanumeric}
  if (!/^YTT-[A-Z0-9]{6}-[A-Z0-9]{6}$/i.test(key)) {
    throw new Error('Invalid key format. Expected: YTT-XXXXXX-XXXXXX');
  }

  // Validate key against our server (placeholder - replace with real endpoint)
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
  // TODO: Replace with real license validation endpoint
  // For now, accept keys with valid format and specific prefixes
  // In production, call your license server:
  // const resp = await fetch('https://your-api.com/validate-key', { ... });

  // Demo: accept YTT-DEMO01-XXXXXX format keys
  if (key.startsWith('YTT-DEMO01-')) return true;

  // Production example:
  try {
    const resp = await fetch('https://your-license-server.com/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machineId: await getMachineId() }),
    });
    const data = await resp.json();
    return data.valid === true;
  } catch {
    return false; // Fail closed
  }
}

async function getMachineId() {
  // Generate a stable machine identifier
  const data = await chrome.storage.local.get(['machineId']);
  if (data.machineId) return data.machineId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ machineId: id });
  return id;
}

const INNERTUBE_CLIENTS = [
  {
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    clientVersion: '2.0',
    hl: 'en',
    gl: 'US',
    clientScreen: 'EMBED',
  },
  {
    clientName: 'MWEB',
    clientVersion: '2.20250722.01.00',
    hl: 'en',
    gl: 'US',
  },
  {
    clientName: 'WEB',
    clientVersion: '2.20250722.01.00',
    hl: 'en',
    gl: 'US',
  },
];

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

async function callInnertube(videoId, endpoint = 'player') {
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const payload = {
        context: { client },
        videoId,
      };

      const resp = await fetch(
        `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Youtube-Client-Name': '85',
            'X-Youtube-Client-Version': client.clientVersion,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            'Origin': 'https://www.youtube.com',
            'Referer': 'https://www.youtube.com/',
          },
          body: JSON.stringify(payload),
        }
      );

      if (resp.ok) {
        const data = await resp.json();
        if (data.streamingData?.formats?.length || data.streamingData?.adaptiveFormats?.length) {
          return data;
        }
      }
    } catch {}
  }
  throw new Error('All Innertube clients failed. YouTube may be blocking requests.');
}

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

  // Prefer M4A (AAC) for widest compatibility
  const m4a = audioFormats.filter(f => f.mimeType?.includes('mp4') || f.mimeType?.includes('audio/mp4'));
  const webm = audioFormats.filter(f => f.mimeType?.includes('webm'));
  const pool = m4a.length ? m4a : webm;

  // Sort by bitrate descending
  pool.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const maxBitrate = { high: 999999, medium: 192000, low: 96000 }[qualityTier] || 192000;

  // Pick highest bitrate at or below the tier cap, or the lowest available
  return pool.find(f => (f.bitrate || 0) <= maxBitrate) || pool[pool.length - 1];
}

async function fetchInfo(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const data = await callInnertube(videoId);
  const details = data.videoDetails || {};
  const formats = data.streamingData?.formats || [];
  const adaptive = data.streamingData?.adaptiveFormats || [];
  const all = [...formats, ...adaptive];

  const h264Only = all.filter(f =>
    f.mimeType?.includes('avc1') && f.mimeType?.startsWith('video/')
  ).sort((a, b) => (b.height || 0) - (a.height || 0));

  return {
    videoId,
    title: details.title || 'Unknown',
    duration: parseInt(details.lengthSeconds) || 0,
    views: parseInt(details.viewCount) || 0,
    author: details.author || '',
    thumbnail: details.thumbnail?.thumbnails?.[0]?.url
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    formats: h264Only.map(f => ({
      itag: f.itag,
      quality: f.qualityLabel || f.quality,
      mimeType: f.mimeType,
      width: f.width,
      height: f.height,
      bitrate: f.bitrate,
      contentLength: f.contentLength,
      url: f.url,
    })),
  };
}

async function downloadVideo(url, quality, title, format = 'video', audioQuality = 'medium') {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  const { isPro } = await getProStatus();
  let maxH = parseInt(quality) || 1080;

  if (!isPro && maxH > FREE_MAX_QUALITY) {
    maxH = FREE_MAX_QUALITY;
  }

  const data = await callInnertube(videoId);
  const formats = data.streamingData?.formats || [];
  const adaptive = data.streamingData?.adaptiveFormats || [];
  const all = [...formats, ...adaptive];

  let filename = sanitizeFilename(title || videoId);

  // --- AUDIO ONLY ---
  if (format === 'audio') {
    const bestAudio = pickBestAudio(all, audioQuality);
    if (!bestAudio?.url) throw new Error('No audio format found');

    const ext = bestAudio.mimeType?.includes('webm') ? 'webm' : 'm4a';
    filename = `${filename}.${ext}`;
    await chrome.downloads.download({
      url: bestAudio.url,
      filename,
      saveAs: false,
    });
    return { success: true, filename };
  }

  // --- VIDEO ---
  const bestVideo = pickFormat(all, maxH);

  if (!bestVideo) {
    throw new Error('No downloadable format found');
  }

  // Combined format (video+audio in one stream)
  if (bestVideo.audioQuality) {
    const ext = bestVideo.mimeType?.includes('webm') ? 'webm' : 'mp4';
    filename = `${filename}.${ext}`;
    await chrome.downloads.download({
      url: bestVideo.url,
      filename,
      saveAs: false,
    });
    return { success: true, filename };
  }

  // Try combined format from non-adaptive streams
  const combinedFormats = formats.filter(f =>
    f.mimeType?.startsWith('video/') && f.audioQuality
  );
  const bestCombined = combinedFormats
    .filter(f => f.height && f.height <= maxH)
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  if (bestCombined?.url) {
    filename = `${filename}.mp4`;
    await chrome.downloads.download({
      url: bestCombined.url,
      filename,
      saveAs: false,
    });
    return { success: true, filename };
  }

  // Video only (adaptive)
  if (bestVideo.url) {
    const videoExt = bestVideo.mimeType?.includes('webm') ? 'webm' : 'mp4';
    filename = `${filename}.${videoExt}`;
    await chrome.downloads.download({
      url: bestVideo.url,
      filename,
      saveAs: false,
    });
    return { success: true, filename, note: 'Video only (no audio)' };
  }

  throw new Error('Could not get download URL');
}

function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*\n\r]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 150);
}

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
