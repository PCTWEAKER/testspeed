(() => {
  const DOWN_URL = 'https://speed.cloudflare.com/__down';
  const UP_URL   = 'https://speed.cloudflare.com/__up';
  const TRACE_URL = 'https://speed.cloudflare.com/cdn-cgi/trace';

  const $ = (id) => document.getElementById(id);
  const gaugeFill = $('gaugeFill');
  const needle = $('needle');
  const gaugeNumber = $('gaugeNumber');
  const gaugeUnit = $('gaugeUnit');
  const gaugePhase = $('gaugePhase');
  const statusEl = $('status');
  const statusText = $('statusText');
  const startBtn = $('startBtn');
  const startLabel = $('startLabel');
  const dlValue = $('dlValue');
  const ulValue = $('ulValue');
  const pingValue = $('pingValue');
  const jitterValue = $('jitterValue');
  const metaColo = $('metaColo');
  const metaIp = $('metaIp');
  const metaTime = $('metaTime');

  const ARC_LEN = 377; // ~ pi * 120

  // Draw tick marks once
  (function drawTicks(){
    const g = $('ticks');
    const cx = 150, cy = 190, rOuter = 120, rInner = 108;
    for (let i = 0; i <= 10; i++){
      const a = Math.PI * (1 - i / 10); // pi -> 0
      const x1 = cx + rOuter * Math.cos(a);
      const y1 = cy - rOuter * Math.sin(a);
      const x2 = cx + rInner * Math.cos(a);
      const y2 = cy - rInner * Math.sin(a);
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('class','tick');
      g.appendChild(line);
    }
  })();

  // Map a Mbps value to a 0..1 fraction on a log-ish scale (0 to ~1000 Mbps)
  function fractionForMbps(mbps){
    const v = Math.max(0.05, mbps);
    const frac = Math.log10(v + 1) / Math.log10(1001);
    return Math.min(1, Math.max(0, frac));
  }

  function setGauge(mbps, color){
    const frac = fractionForMbps(mbps);
    gaugeFill.style.strokeDashoffset = ARC_LEN * (1 - frac);
    if (color) gaugeFill.style.stroke = color;
    const angle = -90 + frac * 180;
    needle.style.transform = `rotate(${angle}deg)`;
    gaugeNumber.textContent = mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1);
  }

  function setPhase(text){ gaugePhase.textContent = text; }
  function setUnit(u){ gaugeUnit.textContent = u; }

  function setStatus(mode, label){
    statusEl.className = 'status ' + mode;
    statusText.textContent = label;
  }

  function fmt(n, d = 1){ return Number.isFinite(n) ? n.toFixed(d) : '—'; }

  async function loadTrace(){
    try{
      const res = await fetch(TRACE_URL, {cache:'no-store'});
      const txt = await res.text();
      const data = {};
      txt.trim().split('\n').forEach(line => {
        const [k, v] = line.split('=');
        if (k) data[k] = v;
      });
      metaColo.textContent = 'server ' + (data.colo || '—');
      metaIp.textContent = 'ip ' + (data.ip || '—');
    }catch(e){
      metaColo.textContent = 'server —';
      metaIp.textContent = 'ip —';
    }
  }

  // ---------- Ping ----------
  async function runPing(){
    setPhase('measuring ping');
    setUnit('ms');
    const samples = [];
    for (let i = 0; i < 9; i++){
      const t0 = performance.now();
      try{
        await fetch(`${DOWN_URL}?bytes=0&_=${Date.now()}${i}`, {cache:'no-store'});
      }catch(e){ continue; }
      const rtt = performance.now() - t0;
      if (i > 0) samples.push(rtt); // discard first (connection warmup)
      setGauge(Math.min(rtt, 300) / 3, '#7C8A90'); // rough visual feedback, not final scale
      pingValue.textContent = fmt(rtt, 0);
    }
    samples.sort((a,b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] || 0;
    let jitterSum = 0;
    for (let i = 1; i < samples.length; i++) jitterSum += Math.abs(samples[i] - samples[i-1]);
    const jitter = samples.length > 1 ? jitterSum / (samples.length - 1) : 0;
    pingValue.textContent = fmt(median, 0);
    jitterValue.textContent = fmt(jitter, 1);
    return { ping: median, jitter };
  }

  // ---------- Download (fixed 15s duration) ----------
  const DOWNLOAD_MS = 15000;
  const UPLOAD_MS = 15000;

  async function runDownload(){
    setPhase('measuring download (15s)');
    setUnit('Mbps');
    setGauge(0, '#4FD1C5');
    const streams = 4;
    const controller = new AbortController();
    let totalBytes = 0;
    const start = performance.now();
    let lastTick = start, lastBytes = 0;

    function onChunk(len){
      totalBytes += len;
      const now = performance.now();
      const dt = now - lastTick;
      if (dt > 120){
        const instMbps = ((totalBytes - lastBytes) * 8) / (dt / 1000) / 1e6;
        setGauge(instMbps, '#4FD1C5');
        dlValue.textContent = fmt(instMbps);
        const remaining = Math.max(0, DOWNLOAD_MS - (now - start));
        setPhase(`measuring download — ${Math.ceil(remaining/1000)}s left`);
        lastTick = now; lastBytes = totalBytes;
      }
    }

    async function pull(){
      while (!controller.signal.aborted){
        let res;
        try{
          res = await fetch(`${DOWN_URL}?bytes=200000000&_=${Date.now()}${Math.random()}`, {cache:'no-store', signal: controller.signal});
        }catch(e){ return; }
        const reader = res.body.getReader();
        try{
          while (true){
            const { done, value } = await reader.read();
            if (done) break;
            onChunk(value.length);
          }
        }catch(e){ return; } // aborted mid-stream
      }
    }

    const timer = new Promise(resolve => setTimeout(() => { controller.abort(); resolve(); }, DOWNLOAD_MS));
    await Promise.race([Promise.all(Array.from({length: streams}, pull)), timer]);
    controller.abort();

    const totalSec = (performance.now() - start) / 1000;
    const finalMbps = (totalBytes * 8) / totalSec / 1e6;
    setGauge(finalMbps, '#4FD1C5');
    dlValue.textContent = fmt(finalMbps);
    return finalMbps;
  }

  // ---------- Upload (fixed 15s duration) ----------
  function xhrUploadTimed(blob, deadline, onProgress){
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      const finish = () => { if (!settled){ settled = true; resolve(); } };
      xhr.open('POST', `${UP_URL}?_=${Date.now()}${Math.random()}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = finish;
      xhr.onerror = finish;
      xhr.onabort = finish;
      xhr.send(blob);
      const remaining = Math.max(0, deadline - performance.now());
      setTimeout(() => { try{ xhr.abort(); }catch(e){} }, remaining);
    });
  }

  async function runUpload(){
    setPhase('measuring upload (15s)');
    setUnit('Mbps');
    setGauge(0, '#FFB020');
    const streams = 3;
    const size = 200_000_000; // large payload; upload is time-boxed, not size-boxed
    const blob = new Blob([new Uint8Array(size)]);
    const loadedByStream = new Array(streams).fill(0);
    const start = performance.now();
    const deadline = start + UPLOAD_MS;
    let lastTick = start, lastTotal = 0;

    function tick(){
      const total = loadedByStream.reduce((a,b) => a+b, 0);
      const now = performance.now();
      const dt = now - lastTick;
      if (dt > 120){
        const instMbps = ((total - lastTotal) * 8) / (dt / 1000) / 1e6;
        setGauge(instMbps, '#FFB020');
        ulValue.textContent = fmt(instMbps);
        const remaining = Math.max(0, deadline - now);
        setPhase(`measuring upload — ${Math.ceil(remaining/1000)}s left`);
        lastTick = now; lastTotal = total;
      }
    }

    const jobs = Array.from({length: streams}, (_, i) =>
      xhrUploadTimed(blob, deadline, (loaded) => { loadedByStream[i] = loaded; tick(); })
    );
    await Promise.all(jobs);
    const totalSec = (performance.now() - start) / 1000;
    const totalBytes = loadedByStream.reduce((a,b) => a+b, 0);
    const finalMbps = (totalBytes * 8) / totalSec / 1e6;
    setGauge(finalMbps, '#FFB020');
    ulValue.textContent = fmt(finalMbps);
    return finalMbps;
  }

  async function runAll(){
    startBtn.disabled = true;
    startLabel.textContent = 'Testing…';
    setStatus('running', 'running');
    dlValue.textContent = '—'; ulValue.textContent = '—';
    pingValue.textContent = '—'; jitterValue.textContent = '—';
    metaTime.textContent = '';

    try{
      await runPing();
      await runDownload();
      await runUpload();
      setPhase('test complete');
      setStatus('done', 'done');
      const now = new Date();
      metaTime.textContent = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    }catch(err){
      setPhase('test failed — check your connection');
      setStatus('idle', 'error');
    }finally{
      startBtn.disabled = false;
      startLabel.textContent = 'Test again';
    }
  }

  startBtn.addEventListener('click', runAll);
  setGauge(0);
  loadTrace();
})();
