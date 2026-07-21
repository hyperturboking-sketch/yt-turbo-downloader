const $ = id => document.getElementById(id);

let currentVideo = null;
let downloadCount = 0;
let isPro = false;
let formatMode = 'video'; // 'video' or 'audio'

const QUALITY_LOCKED = [1440, 2160];

async function init() {
  const data = await chrome.storage.local.get(['downloadCount', 'lastDate']);
  const today = new Date().toDateString();
  if (data.lastDate === today) {
    downloadCount = data.downloadCount || 0;
  } else {
    downloadCount = 0;
    await chrome.storage.local.set({ downloadCount: 0, lastDate: today });
  }
  $('stats').textContent = `Downloads today: ${downloadCount}`;

  const proResp = await chrome.runtime.sendMessage({ type: 'GET_PRO_STATUS' });
  isPro = proResp?.isPro || false;
  updateProUI();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /youtube\.com\/watch/.test(tab.url)) {
    $('urlInput').value = tab.url;
    fetchVideo(tab.url);
  }
}

function updateProUI() {
  const badge = $('proBadge');
  const upgradeBtn = $('upgradeBtn');

  if (isPro) {
    if (badge) { badge.textContent = 'PRO'; badge.style.display = ''; }
    if (upgradeBtn) upgradeBtn.style.display = 'none';
    $('qualitySelect').querySelectorAll('option').forEach(opt => {
      opt.disabled = false;
      if (opt.dataset.locked) opt.textContent = opt.textContent.replace(' 🔒', '');
    });
  } else {
    if (badge) badge.style.display = 'none';
    if (upgradeBtn) upgradeBtn.style.display = '';
    $('qualitySelect').querySelectorAll('option').forEach(opt => {
      const val = parseInt(opt.value);
      if (QUALITY_LOCKED.includes(val)) {
        opt.disabled = true;
        if (!opt.textContent.includes('🔒')) opt.textContent += ' 🔒';
      }
    });
  }
}

function updateFormatUI() {
  const isAudio = formatMode === 'audio';
  $('qualityRow').style.display = isAudio ? 'none' : ($('videoCard').classList.contains('show') ? 'flex' : 'none');
  $('audioRow').classList.toggle('show', isAudio);
  $('formatToggle').style.display = $('videoCard').classList.contains('show') ? 'flex' : 'none';
  $('dlBtnText').textContent = isAudio ? 'Download Audio' : 'Download MP4';
}

// Format toggle
$('formatToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('formatToggle').querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  formatMode = btn.dataset.format;
  updateFormatUI();
});

$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('urlInput').value = text;
    if (/youtube\.com|youtu\.be/.test(text)) fetchVideo(text);
  } catch {}
});

$('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const url = $('urlInput').value.trim();
    if (/youtube\.com|youtu\.be/.test(url)) fetchVideo(url);
  }
});

$('urlInput').addEventListener('input', () => {
  const url = $('urlInput').value.trim();
  if (/youtube\.com|youtu\.be/.test(url)) fetchVideo(url);
  else {
    $('videoCard').classList.remove('show');
    $('qualityRow').style.display = 'none';
    $('audioRow').classList.remove('show');
    $('formatToggle').style.display = 'none';
    $('emptyState').style.display = '';
    $('dlBtn').disabled = true;
  }
});

$('dlBtn').addEventListener('click', startDownload);

if ($('upgradeBtn')) {
  $('upgradeBtn').addEventListener('click', () => $('upgradeModal').classList.add('show'));
}
if ($('closeModal')) {
  $('closeModal').addEventListener('click', () => $('upgradeModal').classList.remove('show'));
}
if ($('upgradeModal')) {
  $('upgradeModal').addEventListener('click', (e) => {
    if (e.target === $('upgradeModal')) $('upgradeModal').classList.remove('show');
  });
}

if ($('activateBtn')) {
  $('activateBtn').addEventListener('click', async () => {
    const key = $('licenseInput').value.trim();
    if (!key) return;
    $('activateBtn').disabled = true;
    $('activateBtn').textContent = 'Activating...';
    $('licenseStatus').className = 'license-status';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'ACTIVATE_LICENSE', key });
      if (resp.error) throw new Error(resp.error);
      $('licenseStatus').textContent = resp.message;
      $('licenseStatus').className = 'license-status show success';
      isPro = true;
      updateProUI();
      setTimeout(() => {
        $('upgradeModal').classList.remove('show');
        $('licenseStatus').className = 'license-status';
      }, 1500);
    } catch (e) {
      $('licenseStatus').textContent = e.message;
      $('licenseStatus').className = 'license-status show error';
    } finally {
      $('activateBtn').disabled = false;
      $('activateBtn').textContent = 'Activate';
    }
  });
}

async function fetchVideo(url) {
  $('emptyState').style.display = 'none';
  $('videoCard').classList.add('show');
  $('qualityRow').style.display = 'none';
  $('audioRow').classList.remove('show');
  $('dlBtn').disabled = true;
  $('dlBtnText').innerHTML = '<span class="spinner"></span> Fetching...';
  hideStatus();

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'FETCH_INFO', url });
    if (resp.error) throw new Error(resp.error);
    currentVideo = resp;
    $('thumb').src = resp.thumbnail || '';
    $('title').textContent = resp.title || 'Unknown';
    const dur = resp.duration ? formatDuration(resp.duration) : '';
    const views = resp.views ? formatNumber(resp.views) + ' views' : '';
    $('meta').textContent = [dur, views, resp.author].filter(Boolean).join(' · ');

    updateProUI();
    updateFormatUI();
    $('dlBtn').disabled = false;
  } catch (e) {
    showStatus(e.message, 'error');
    $('dlBtnText').textContent = 'Download';
  }
}

async function startDownload() {
  if (!currentVideo) return;

  const quality = $('qualitySelect').value;
  const q = parseInt(quality);

  if (formatMode === 'video' && !isPro && QUALITY_LOCKED.includes(q)) {
    $('upgradeModal').classList.add('show');
    return;
  }

  $('dlBtn').disabled = true;
  $('dlBtnText').innerHTML = '<span class="spinner"></span> Downloading...';
  $('progress').classList.add('show');
  $('progressFill').style.width = '10%';
  $('progressText').textContent = 'Starting download...';
  hideStatus();

  try {
    const msg = {
      type: 'DOWNLOAD',
      url: currentVideo.url,
      title: currentVideo.title,
      format: formatMode,
    };
    if (formatMode === 'video') {
      msg.quality = quality;
    } else {
      msg.audioQuality = $('audioSelect').value;
    }

    const resp = await chrome.runtime.sendMessage(msg);
    if (resp.error) throw new Error(resp.error);

    $('progressFill').style.width = '100%';
    $('progressText').textContent = 'Download started!';
    const label = formatMode === 'audio' ? 'audio' : `video`;
    showStatus(`"${currentVideo.title}" ${label} saved to Downloads`, 'success');

    downloadCount++;
    await chrome.storage.local.set({ downloadCount, lastDate: new Date().toDateString() });
    $('stats').textContent = `Downloads today: ${downloadCount}`;
  } catch (e) {
    showStatus(e.message, 'error');
  } finally {
    $('dlBtn').disabled = false;
    $('dlBtnText').textContent = formatMode === 'audio' ? 'Download Audio' : 'Download MP4';
    setTimeout(() => $('progress').classList.remove('show'), 2000);
  }
}

function showStatus(msg, type) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status show ${type}`;
}
function hideStatus() { $('status').className = 'status' }

function formatDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function formatNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

init();
