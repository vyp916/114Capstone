/* filters.js
FilterManager: manages video filters for broadcaster
- Creates a hidden canvas that composites video + overlays
- Provides UI (a floating panel) for selecting filters, uploading sticker (1:1), positioning/scaling sticker
- Exposes getProcessedStream() returning canvas.captureStream() (video). Keep audio track from original getUserMedia stream.

Design notes:
- Fixed filters: implemented using CanvasRenderingContext2D.filter (CSS filter strings like 'grayscale(0.3) contrast(1.2)')
- Face/sticker filter: user uploads square image and can drag/scale it. (No automatic face-detection here; manual placement is supported. Placeholder code left for future face-tracking integration.)
- Interactive filter: simple animated overlay (scanlines) that toggles when active.
*/

class FilterManager {
  constructor(videoEl, originalStream, opts = {}) {
    this.video = videoEl; // source video element showing raw camera stream
    this.origStream = originalStream;
    this.width = opts.width || 640;
    this.height = opts.height || 480;
    this.fps = opts.fps || 25;
    this.autoFace = !!opts.autoFace; // 若為 true，嘗試啟用 MediaPipe FaceMesh 偵測

    // create canvas for composition
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
  // append hidden canvas to DOM so captureStream works consistently across browsers
  this.canvas.style.display = 'none';
  document.body.appendChild(this.canvas);

    // current settings
    this.currentFilter = null; // string for ctx.filter
    this.stickerImg = null; // HTMLImageElement
    this.sticker = { x: 50, y: 50, w: 120, h: 120, visible: false, dragging: false, scale: 1 };
    this.interactiveOn = false;
    this.animStart = null;
  // face detection state
  this.faceMesh = null;
  this.faceReady = false;
  this.lastFaceLandmarks = null; // normalized landmarks array
  this._faceLastSent = 0; // timestamp of last frame sent to faceMesh

    // create UI
    this._createUI();

    // init face detector if requested
    if (this.autoFace) {
      this._initFaceMesh();
    }

    // bind events
    this._bindStickerDrag();

    // start draw loop
    this._startLoop();
  }

  // returns a MediaStream for video (canvas stream)
  getProcessedStream() {
    // capture at specified fps
    return this.canvas.captureStream(this.fps);
  }

  _startLoop() {
    const draw = (t) => {
      if (!this.video || this.video.readyState < 2) {
        requestAnimationFrame(draw);
        return;
      }

      // sync canvas size to video display size if changed
      const vw = this.video.videoWidth || this.width;
      const vh = this.video.videoHeight || this.height;
      if (this.canvas.width !== vw || this.canvas.height !== vh) {
        this.canvas.width = vw;
        this.canvas.height = vh;
      }

      // apply filter
      this.ctx.save();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.filter = this.currentFilter || 'none';

      // draw video
      try {
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      } catch (e) {
        // ignore if video not ready
      }

      this.ctx.filter = 'none';

      // interactive overlay
      if (this.interactiveOn) {
        this._drawInteractive(t);
      }

      // NOTE: feeding frames to FaceMesh is handled by MediaPipe Camera (if initialized)

      // sticker overlay
      if (this.stickerImg && this.sticker.visible) {
        // if auto face mode and landmarks available, compute box from landmarks
        if (this.sticker.auto && this.lastFaceLandmarks) {
          // compute bbox from normalized landmarks
          const lms = this.lastFaceLandmarks;
          let minX = 1, minY = 1, maxX = 0, maxY = 0;
          for (let i = 0; i < lms.length; i++) {
            const p = lms[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }
          // map to canvas pixels
          const pad = 0.15; // padding relative to face bbox
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const bw = (maxX - minX);
          const bh = (maxY - minY);
          const wPx = (bw * (1 + pad * 2)) * this.canvas.width;
          const hPx = (bh * (1 + pad * 2)) * this.canvas.height;
          const xPx = (cx * this.canvas.width) - (wPx / 2);
          const yPx = (cy * this.canvas.height) - (hPx / 2);
          // draw the sticker centered on face bbox
          this.ctx.drawImage(this.stickerImg, xPx, yPx, wPx, hPx);
        } else {
          this.ctx.drawImage(this.stickerImg, this.sticker.x, this.sticker.y, this.sticker.w * this.sticker.scale, this.sticker.h * this.sticker.scale);
        }
      }

      this.ctx.restore();

      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  // Initialize MediaPipe FaceMesh (dynamic CDN load). Sets this.faceReady and this.faceMesh.
  async _initFaceMesh() {
    if (this.faceReady || !this.autoFace) return;
    try {
      // load required scripts sequentially
      const loadScript = (src) => new Promise((res, rej) => {
        if (document.querySelector(`script[src="${src}"]`)) return res();
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => res();
        s.onerror = (e) => rej(e);
        document.head.appendChild(s);
      });

      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/face_mesh.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js');
      await loadScript('https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js');

      // create FaceMesh instance
      this.faceMesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
      this.faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      this.faceMesh.onResults((results) => {
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length) {
          const lms = results.multiFaceLandmarks[0];
          this.lastFaceLandmarks = lms;
          // compute normalized bbox for debugging/logging
          let minX = 1, minY = 1, maxX = 0, maxY = 0;
          for (let i = 0; i < lms.length; i++) {
            const p = lms[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }
          if (!this.faceReady) {
            this.faceReady = true;
            this.faceLoading = false;
          }
        } else {
          this.lastFaceLandmarks = null;
        }
      });

      // create MediaPipe Camera helper to feed video frames into faceMesh
        try {
        // Camera should be available via camera_utils script
        this.camera = new Camera(this.video, {
          onFrame: async () => {
            try { await this.faceMesh.send({ image: this.video }); } catch (e) {}
          },
          width: this.width,
          height: this.height
        });
        this.camera.start();
        this.faceLoading = true;
      } catch (e) {
        // if Camera helper isn't available, fall back to manual send attempts later
        this.faceLoading = true;
        console.warn('⚠️ MediaPipe Camera helper unavailable, will attempt manual sends as fallback', e);
      }
    } catch (err) {
      console.warn('⚠️ FaceMesh init failed:', err);
      this.faceReady = false;
      this.faceMesh = null;
    }
  }


  _drawInteractive(t) {
    // simple scanline animation that moves vertically
    const ctx = this.ctx;
    const now = t || performance.now();
    const speed = 0.3; // pixels per ms
    const yOffset = ((now * speed) % (this.canvas.height * 2)) - this.canvas.height;

    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#00ff00';
    for (let y = yOffset; y < this.canvas.height; y += 8) {
      ctx.fillRect(0, y, this.canvas.width, 2);
    }
    ctx.restore();
  }

  _createUI() {
    // root container
    const panel = document.createElement('div');
    panel.className = 'filter-panel';
    panel.innerHTML = `
      <button class="filter-toggle">🎨 濾鏡</button>
      <div class="filter-card hidden">
        <h3>固定濾鏡</h3>
        <div class="filter-list">
          <button data-filter="none">無</button>
          <button data-filter="contrast(1.2) saturate(1.4)">增強色彩</button>
          <button data-filter="sepia(0.4) contrast(1.05)">泛黃</button>
          <button data-filter="grayscale(1) contrast(1.1)">黑白</button>
        </div>
        <h3>臉部濾鏡 / 貼紙</h3>
        <input type="file" class="sticker-input" accept="image/*"><br>
        <small>上傳 1:1 照片作為貼紙，拖曳調整位置/大小</small>
        <div class="sticker-gallery" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"></div>
        <h3 style="margin-top:8px">互動濾鏡</h3>
        <div class="interactive-area"></div>
      </div>
    `;

    document.body.appendChild(panel);
    this.ui = panel;
    // prepare default stickers and helper renderers BEFORE they're used
    this.defaultStickers = [
      '/stickers/CLOWN.png',
      '/stickers/hongzhong.png',
      '/stickers/ultraman.png',
    ];

    // helper methods used by the UI
    this._renderStickerGallery = (container) => {
      if (!container) return;
      container.innerHTML = '';
      // add a "none" button to clear stickers
      const noneBtn = document.createElement('button');
      noneBtn.textContent = '無';
      noneBtn.title = '移除貼紙';
      noneBtn.style.padding = '6px 8px';
      noneBtn.style.borderRadius = '6px';
      noneBtn.style.cursor = 'pointer';
      noneBtn.addEventListener('click', () => {
        this.stickerImg = null;
        this.sticker.visible = false;
        this.sticker.auto = false;
        if (this._autoBtn) this._autoBtn.style.background = '';
      });
      container.appendChild(noneBtn);
      this.defaultStickers.forEach(src => {
        const img = document.createElement('img');
        img.src = src;
        img.style.width = '56px';
        img.style.height = '56px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.title = '加入貼紙';
        img.addEventListener('click', () => {
            const image = new Image();
            // allow cross-origin for CDN resources (our /stickers are same-origin but safe to set)
            image.crossOrigin = 'anonymous';
            image.onload = () => {
              this.stickerImg = image;
              const base = Math.min(this.canvas.width, this.canvas.height);
              // preserve aspect ratio
              const aspect = image.naturalWidth / (image.naturalHeight || 1);
              const targetH = base * 0.22;
              const targetW = targetH * aspect;
              this.sticker.w = targetW;
              this.sticker.h = targetH;
              this.sticker.x = (this.canvas.width - this.sticker.w) / 2;
              this.sticker.y = (this.canvas.height - this.sticker.h) / 2;
              this.sticker.scale = 1;
            this.sticker.visible = true;
            // auto-enable sticker auto-placement when a sticker is chosen
            this.sticker.auto = true;
            if (this._autoBtn) this._autoBtn.style.background = '#0a74da';
            if (this.autoFace && !this.faceReady) this._initFaceMesh();
          };
            image.src = src;
        });
        container.appendChild(img);
      });
    };

    this._renderInteractiveArea = () => {
      if (!this.interactiveArea) return;
      this.interactiveArea.innerHTML = '';
      if (!this.interactiveEffects || this.interactiveEffects.length === 0) {
        const small = document.createElement('small');
        small.textContent = '暫無互動濾鏡';
        small.style.color = '#ccc';
        this.interactiveArea.appendChild(small);
        return;
      }
      this.interactiveEffects.forEach(eff => {
        const btn = document.createElement('button');
        btn.textContent = eff.name;
        btn.addEventListener('click', () => eff.apply(this));
        this.interactiveArea.appendChild(btn);
      });
    };

    // references
    this.uiToggle = panel.querySelector('.filter-toggle');
    this.uiCard = panel.querySelector('.filter-card');
    this.stickerInput = panel.querySelector('.sticker-input');
    this.interactiveBtn = panel.querySelector('.interactive-toggle');

    // events
    this.uiToggle.addEventListener('click', () => this.uiCard.classList.toggle('hidden'));

    this.uiCard.querySelectorAll('.filter-list button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const f = e.currentTarget.dataset.filter;
        this.currentFilter = f === 'none' ? null : f;
      });
    });

    this.stickerInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const img = new Image();
      img.onload = () => {
        this.stickerImg = img;
        // assume square; set initial size relative to canvas
        const base = Math.min(this.canvas.width, this.canvas.height);
        const aspect = img.naturalWidth / (img.naturalHeight || 1);
        const targetH = base * 0.25;
        const targetW = targetH * aspect;
        this.sticker.w = targetW;
        this.sticker.h = targetH;
        this.sticker.x = (this.canvas.width - this.sticker.w) / 2;
        this.sticker.y = (this.canvas.height - this.sticker.h) / 2;
        this.sticker.scale = 1;
        this.sticker.visible = true;
        // auto-enable sticker auto-placement when user uploads a sticker
        this.sticker.auto = true;
        if (this._autoBtn) this._autoBtn.style.background = '#0a74da';
        if (this.autoFace && !this.faceReady) this._initFaceMesh();
      };
      img.src = URL.createObjectURL(f);
    });


    // Interactive effects list (could be extended)
    this.interactiveEffects = []; // empty => show '暫無互動濾鏡'
    this.interactiveArea = panel.querySelector('.interactive-area');
    this._renderInteractiveArea();

    // populate sticker gallery with default stickers
    this._renderStickerGallery(panel.querySelector('.sticker-gallery'));
    // minimal styles for panel via JS injection if not present
    if (!document.getElementById('filter-styles')) {
      const s = document.createElement('style');
      s.id = 'filter-styles';
      s.textContent = `
      .filter-panel { position: absolute; left: 50%; transform: translateX(-50%); bottom: 60px; z-index: 100; display: none; }
      body:has(#video) .filter-panel { display: block; }
      .filter-panel .filter-toggle { background:#FF6B35;color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;box-shadow: 0 2px 8px rgba(255,107,53,0.3); }
      .filter-card { background: rgba(0,0,0,0.9); color:#fff; padding:12px; border-radius:8px; margin-bottom:8px; width:260px; }
      .filter-card.hidden { display:none }
      .filter-list button { margin:6px 4px; padding:6px 8px; border-radius:6px; border:none; cursor:pointer }
      .filter-list button:hover { transform:translateY(-2px) }
      .interactive-toggle { margin-top:8px; padding:8px 10px; border-radius:6px; border:none; cursor:pointer }
      .sticker-input { margin-top:6px }
      `;
      document.head.appendChild(s);
    }
  }

  _bindStickerDrag() {
    // allow dragging/resizing the sticker with mouse/touch over the canvas
    const canvas = this.canvas;
    let last = null;
    const isOverSticker = (x, y) => {
      const sx = this.sticker.x;
      const sy = this.sticker.y;
      const sw = this.sticker.w * this.sticker.scale;
      const sh = this.sticker.h * this.sticker.scale;
      return x >= sx && x <= sx + sw && y >= sy && y <= sy + sh;
    };

    canvas.addEventListener('pointerdown', (ev) => {
      if (!this.sticker.visible) return;
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
      const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
      if (isOverSticker(x, y)) {
        this.sticker.dragging = true;
        last = { x, y };
        canvas.setPointerCapture(ev.pointerId);
      }
    });

    canvas.addEventListener('pointermove', (ev) => {
      if (!this.sticker.visible || !this.sticker.dragging) return;
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
      const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
      const dx = x - last.x;
      const dy = y - last.y;
      this.sticker.x += dx;
      this.sticker.y += dy;
      last = { x, y };
    });

    canvas.addEventListener('pointerup', (ev) => {
      this.sticker.dragging = false;
      last = null;
    });

    // wheel to scale sticker when hovering
    canvas.addEventListener('wheel', (ev) => {
      if (!this.sticker.visible) return;
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
      const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
      if ( (x >= this.sticker.x && x <= this.sticker.x + this.sticker.w * this.sticker.scale) &&
           (y >= this.sticker.y && y <= this.sticker.y + this.sticker.h * this.sticker.scale) ) {
        const delta = ev.deltaY < 0 ? 0.05 : -0.05;
        this.sticker.scale = Math.max(0.1, this.sticker.scale + delta);
      }
    }, { passive: false });
  }
}

// export for browser
window.FilterManager = FilterManager;
