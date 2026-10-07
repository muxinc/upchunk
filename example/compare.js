const $ = (selector, root = document) => root.querySelector(selector);

const CHUNK_SIZE_KB = 30720;

const formatBytes = (bytes) => {
  if (bytes == null) return '–';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatSeconds = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);
const formatBitrate = (bps) => (bps == null ? '–' : `${(bps / 1e6).toFixed(2)} Mbps`);

const summarizeMedia = (summary) => {
  if (!summary) return '–';
  const video = summary.video[0];
  const audio = summary.audio[0];
  const parts = [summary.container];
  if (video) {
    parts.push(
      `${video.codec ?? '?'} ${video.codedWidth}x${video.codedHeight}` +
        (video.frameRate ? ` @ ${video.frameRate.toFixed(2)} fps` : '') +
        (video.maxKeyFrameInterval != null ? `, max GOP ${video.maxKeyFrameInterval.toFixed(1)} s` : '') +
        (video.averageBitrate != null ? `, ${formatBitrate(video.averageBitrate)}` : '')
    );
  }
  if (audio) parts.push(`${audio.codec ?? '?'} ${audio.channels}ch ${audio.sampleRate} Hz`);
  return parts.join(' · ');
};

class Column {
  constructor(root) {
    this.root = root;
    this.status = $('[data-role="status"]', root);
    this.upload = $('[data-role="upload"]', root);
    this.uploadPct = $('[data-role="upload-pct"]', root);
    this.transcode = $('[data-role="transcode"]', root);
    this.transcodePct = $('[data-role="transcode-pct"]', root);
    this.stats = $('[data-role="stats"]', root);
    this.report = $('[data-role="report"]', root);
    this.rows = new Map();
  }

  reset() {
    this.setStatus('Idle');
    this.setUpload(0);
    this.setTranscode(0);
    this.stats.innerHTML = '';
    this.rows.clear();
    if (this.report) this.report.textContent = '';
  }

  setStatus(text, tone = '') {
    this.status.textContent = text;
    this.status.className = `status ${tone}`.trim();
  }

  setUpload(pct) {
    this.upload.value = pct;
    this.uploadPct.textContent = `${pct.toFixed(0)}%`;
  }

  setTranscode(pct) {
    if (!this.transcode) return;
    this.transcode.value = pct;
    this.transcodePct.textContent = `${pct.toFixed(0)}%`;
  }

  set(label, value, { numeric = false, html = false } = {}) {
    let row = this.rows.get(label);
    if (!row) {
      row = document.createElement('tr');
      row.innerHTML = `<td></td><td class="${numeric ? 'num' : ''}"></td>`;
      row.firstChild.textContent = label;
      this.stats.appendChild(row);
      this.rows.set(label, row);
    }
    if (html) row.lastChild.innerHTML = value;
    else row.lastChild.textContent = value;
  }

  setReport(value) {
    if (this.report) this.report.textContent = value;
  }
}

const tags = (items) =>
  items && items.length ? items.map((item) => `<span class="tag">${item}</span>`).join('') : '<span class="hint">none</span>';

const columns = {
  without: new Column($('#card-without')),
  with: new Column($('#card-with')),
};

const state = { uploads: [], running: false };

const setRunning = (running) => {
  state.running = running;
  $('#run').disabled = running;
  $('#analyze').disabled = running;
  $('#cancel').disabled = !running;
};

const transcoderOptions = () => ({
  maxResolutionTier: $('#tier').value,
  mode: $('#always').checked ? 'always' : 'auto',
});

const runSide = (side, file, endpoint) =>
  new Promise((resolve) => {
    const column = columns[side];
    const withTranscode = side === 'with';
    const startedAt = performance.now();
    let transcodeMs = null;
    let uploadStartedAt = null;
    let uploadedFile = file;

    column.reset();
    column.set('Original size', formatBytes(file.size), { numeric: true });
    column.setStatus(withTranscode ? 'Inspecting…' : 'Uploading…');

    const upload = UpChunk.createUpload({
      endpoint,
      file,
      chunkSize: CHUNK_SIZE_KB,
      transcode: withTranscode ? UpChunkMediabunny.createMuxTranscoder(transcoderOptions()) : undefined,
    });
    state.uploads.push(upload);

    const finish = (outcome) => {
      const totalMs = performance.now() - startedAt;
      column.set('Total time', formatSeconds(totalMs), { numeric: true });
      resolve({ side, outcome, totalMs, transcodeMs, uploadMs: uploadStartedAt ? performance.now() - uploadStartedAt : null, uploadedFile, file });
    };

    upload.on('transcodeProgress', ({ detail }) => {
      column.setStatus('Transcoding…');
      column.setTranscode(detail);
    });

    upload.on('transcodeSuccess', ({ detail }) => {
      transcodeMs = performance.now() - startedAt;
      uploadedFile = detail.file;
      column.setTranscode(100);
      column.set('Transcoded', detail.transcoded ? 'yes' : 'no, uploaded as-is');
      column.set('Why', tags(detail.reasons), { html: true });
      column.set('Notes', tags(detail.notes), { html: true });
      column.set('Input', summarizeMedia(detail.summary));
      column.set('Uploaded size', formatBytes(detail.file.size), { numeric: true });
      column.set(
        'Size change',
        `${(((detail.file.size - file.size) / file.size) * 100).toFixed(1)}%`,
        { numeric: true }
      );
      column.set('Transcode time', formatSeconds(transcodeMs), { numeric: true });
      column.setReport(JSON.stringify({ report: detail.report, summary: detail.summary }, null, 2));
      if (detail.error) column.set('Fallback error', String(detail.error.message ?? detail.error));
      column.setStatus('Uploading…');
    });

    upload.on('attempt', () => {
      if (uploadStartedAt === null) uploadStartedAt = performance.now();
    });

    upload.on('progress', ({ detail }) => column.setUpload(detail));

    upload.on('error', ({ detail }) => {
      column.setStatus(`Error: ${detail.message}`, 'warn');
      finish('error');
    });

    upload.on('success', () => {
      column.setUpload(100);
      column.set('Uploaded size', formatBytes(uploadedFile.size), { numeric: true });
      column.set('Upload time', formatSeconds(performance.now() - uploadStartedAt), { numeric: true });
      column.setStatus('Uploaded. Check the asset in the Mux dashboard.', 'ok');
      finish('success');
    });
  });

const renderVerdict = (results) => {
  const verdict = $('#verdict');
  const withSide = results.find((r) => r.side === 'with');
  const withoutSide = results.find((r) => r.side === 'without');
  if (!withSide || !withoutSide) {
    verdict.hidden = true;
    return;
  }
  const sizeDelta = withSide.uploadedFile.size - withoutSide.uploadedFile.size;
  const lines = [
    `<strong>Both uploads finished.</strong>`,
    `Without transcode: ${formatBytes(withoutSide.uploadedFile.size)} in ${formatSeconds(withoutSide.totalMs)}.`,
    `With transcode: ${formatBytes(withSide.uploadedFile.size)} in ${formatSeconds(withSide.totalMs)}` +
      (withSide.transcodeMs != null ? ` (${formatSeconds(withSide.transcodeMs)} of that was inspection and transcoding)` : '') +
      '.',
    sizeDelta === 0
      ? 'The uploaded bytes were identical, so the file already conformed and was passed through.'
      : `The transcoded upload was ${formatBytes(Math.abs(sizeDelta))} ${sizeDelta < 0 ? 'smaller' : 'larger'}.`,
    'The real payoff is server-side: compare time-to-ready and <code>non_standard_input_reasons</code> on the two assets.',
  ];
  verdict.innerHTML = lines.join('<br />');
  verdict.hidden = false;
};

$('#run').addEventListener('click', async () => {
  const file = $('#file').files[0];
  const urlWithout = $('#url-without').value.trim();
  const urlWith = $('#url-with').value.trim();
  if (!file) return alert('Pick a file first.');
  if (!urlWithout && !urlWith) return alert('Enter at least one upload URL.');

  $('#verdict').hidden = true;
  state.uploads = [];
  setRunning(true);

  const jobs = [];
  if (urlWithout) jobs.push(() => runSide('without', file, urlWithout));
  if (urlWith) jobs.push(() => runSide('with', file, urlWith));

  let results;
  if ($('#parallel').checked) {
    results = await Promise.all(jobs.map((job) => job()));
  } else {
    results = [];
    for (const job of jobs) results.push(await job());
  }

  setRunning(false);
  if (results.every((r) => r.outcome === 'success')) renderVerdict(results);
});

$('#analyze').addEventListener('click', async () => {
  const file = $('#file').files[0];
  if (!file) return alert('Pick a file first.');
  const column = columns.with;
  column.reset();
  column.setStatus('Inspecting…');
  setRunning(true);
  const startedAt = performance.now();
  try {
    const { report, summary } = await UpChunkMediabunny.analyzeFile(file, transcoderOptions());
    column.set('Original size', formatBytes(file.size), { numeric: true });
    column.set('Input', summarizeMedia(summary));
    column.set('Standard input', report.standard ? 'yes' : 'no');
    column.set('Would transcode', report.needsWork ? 'yes' : 'no');
    column.set('Why', tags(report.reasons), { html: true });
    column.set('Inspection time', formatSeconds(performance.now() - startedAt), { numeric: true });
    column.setReport(JSON.stringify({ report, summary }, null, 2));
    column.setStatus(report.needsWork ? 'This file would be transcoded before upload.' : 'This file would be uploaded as-is.', report.needsWork ? 'warn' : 'ok');
  } catch (e) {
    column.setStatus(`Inspection failed: ${e.message}`, 'warn');
  } finally {
    setRunning(false);
  }
});

$('#cancel').addEventListener('click', () => {
  state.uploads.forEach((upload) => upload.abort());
  Object.values(columns).forEach((column) => column.setStatus('Cancelled', 'warn'));
  setRunning(false);
});
