/* ==========================================================================
   ToneChanger (versión web) - Lógica de la página
   - Selección / arrastre del archivo y decodificación con la Web Audio API
   - Reproductores con reproducir, pausar, detener y barra de tiempo
   - Control de tono (-12 a +12 semitonos)
   - Cambio de tono en Web Workers (js/pitch-worker.js + js/dsp.js)
   - Vista previa, restablecer, descarga en WAV y mensajes de estado
   Todo pasa en el navegador: el audio nunca sale del computador del usuario.
   ========================================================================== */

(() => {
  "use strict";

  const CONFIG = window.TONECHANGER_CONFIG || { maxSizeMb: 50, maxMinutes: 10, minSemitones: -12, maxSemitones: 12 };
  const ALLOWED_EXTENSIONS = ["mp3", "wav"];
  const MAX_BYTES = CONFIG.maxSizeMb * 1024 * 1024;
  const SAMPLE_RATE = 44100;              // el audio se decodifica a 44,1 kHz
  const WORKER_URL = "js/pitch-worker.js";

  // ---------- Referencias al DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const dom = {
    dropzone: $("#dropzone"),
    fileInput: $("#fileInput"),
    selectBtn: $("#selectBtn"),
    uploadStatus: $("#uploadStatus"),
    fileInfo: $("#fileInfo"),
    fileName: $("#fileName"),
    fileDetails: $("#fileDetails"),
    newFileBtn: $("#newFileBtn"),
    originalHint: $("#originalHint"),
    toneControls: $("#toneControls"),
    slider: $("#pitchSlider"),
    value: $("#semitoneValue"),
    desc: $("#semitoneDesc"),
    math: $("#semitoneMath"),
    upBtn: $("#upBtn"),
    downBtn: $("#downBtn"),
    chips: document.querySelectorAll(".chip"),
    applyBtn: $("#applyBtn"),
    resetBtn: $("#resetBtn"),
    processing: $("#processing"),
    processingTime: $("#processingTime"),
    progressBar: $("#progressBar"),
    progressText: $("#progressText"),
    resultBlock: $("#resultBlock"),
    resultLabel: $("#resultLabel"),
    staleHint: $("#staleHint"),
    downloadBtn: $("#downloadBtn"),
    toasts: $("#toasts"),
  };

  // ---------- Estado de la aplicación ----------
  const state = {
    loaded: false,       // hay un audio cargado
    fileName: null,      // nombre del archivo cargado
    objectUrl: null,     // URL local para reproducir el original
    channels: null,      // muestras decodificadas: [Float32Array, ...]
    sampleRate: SAMPLE_RATE,
    result: null,        // { semitones, url, duration, seconds }
    uploading: false,
    processing: false,
    jobId: 0,            // identifica cada procesamiento (para ignorar respuestas viejas)
  };

  // ======================================================================
  // Utilidades
  // ======================================================================
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function signed(n) {
    return n > 0 ? `+${n}` : `${n}`;
  }

  function getExtension(name) {
    const idx = name.lastIndexOf(".");
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
  }

  function baseName(name) {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
  }

  /** Describe con palabras el cambio de tono seleccionado. */
  function describeSemitones(n) {
    if (n === 0) return "Tono original";
    const dir = n > 0 ? "más aguda" : "más grave";
    if (Math.abs(n) === 12) return `Una octava ${dir}`;
    const unit = Math.abs(n) === 1 ? "semitono" : "semitonos";
    return `${Math.abs(n)} ${unit} ${n > 0 ? "más agudo" : "más grave"}`;
  }

  // ---------- Notificaciones ----------
  function toast(message, type = "info", duration) {
    const el = document.createElement("div");
    el.className = `toast toast--${type}`;
    el.setAttribute("role", type === "error" ? "alert" : "status");

    const msg = document.createElement("span");
    msg.className = "toast__msg";
    msg.textContent = message;

    const close = document.createElement("button");
    close.className = "toast__close";
    close.type = "button";
    close.setAttribute("aria-label", "Cerrar mensaje");
    close.textContent = "×";

    el.append(msg, close);
    dom.toasts.appendChild(el);

    const remove = () => {
      if (!el.isConnected) return;
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), 250);
    };
    close.addEventListener("click", remove);
    setTimeout(remove, duration ?? (type === "error" ? 8000 : 4500));

    // Máximo 4 mensajes visibles
    while (dom.toasts.children.length > 4) dom.toasts.firstElementChild.remove();
  }

  // ======================================================================
  // Reproductor de audio personalizado
  // ======================================================================
  const players = [];

  class AudioPlayer {
    constructor(root) {
      this.root = root;
      this.audio = root.querySelector("audio");
      this.playBtn = root.querySelector(".player__play");
      this.stopBtn = root.querySelector(".player__stop");
      this.seek = root.querySelector(".player__seek");
      this.timeEl = root.querySelector(".player__time");
      this.isSeeking = false;
      this.onError = null;

      this.playBtn.addEventListener("click", () => this.toggle());
      this.stopBtn.addEventListener("click", () => this.stop());

      this.audio.addEventListener("play", () => {
        // Solo un reproductor suena a la vez
        players.forEach((p) => { if (p !== this) p.pause(); });
        this.root.classList.add("is-playing");
        this.playBtn.setAttribute("aria-label", "Pausar");
      });
      this.audio.addEventListener("pause", () => {
        this.root.classList.remove("is-playing");
        this.playBtn.setAttribute("aria-label", "Reproducir");
      });
      this.audio.addEventListener("ended", () => {
        this.audio.currentTime = 0;
        this.render();
      });
      ["timeupdate", "loadedmetadata", "durationchange", "seeked"].forEach((ev) =>
        this.audio.addEventListener(ev, () => this.render())
      );
      this.audio.addEventListener("error", () => {
        if (!this.audio.getAttribute("src")) return; // error por limpiar la fuente
        if (typeof this.onError === "function") this.onError();
      });

      // Barra de posición (adelantar / retroceder)
      this.seek.addEventListener("input", () => {
        this.isSeeking = true;
        const d = this.audio.duration;
        if (Number.isFinite(d)) this.renderTime((this.seek.value / 1000) * d, d);
        this.paintSeek();
      });
      this.seek.addEventListener("change", () => {
        const d = this.audio.duration;
        if (Number.isFinite(d)) this.audio.currentTime = (this.seek.value / 1000) * d;
        this.isSeeking = false;
      });

      players.push(this);
      this.render();
    }

    setSource(url) {
      this.stop();
      this.root.classList.remove("is-playing");
      this.audio.src = url;
      this.audio.load();
      this.root.dataset.disabled = "false";
      this.render();
    }

    clear() {
      this.pause();
      this.root.classList.remove("is-playing");
      this.audio.removeAttribute("src");
      this.audio.load();
      this.root.dataset.disabled = "true";
      this.seek.value = 0;
      this.render();
    }

    get hasSource() {
      return Boolean(this.audio.getAttribute("src"));
    }

    toggle() {
      if (!this.hasSource) return;
      if (this.audio.paused) {
        const p = this.audio.play();
        if (p && typeof p.catch === "function") {
          p.catch((err) => {
            if (err && err.name === "AbortError") return;
            toast("El navegador no pudo reproducir el audio.", "error");
          });
        }
      } else {
        this.pause();
      }
    }

    pause() {
      if (!this.audio.paused) this.audio.pause();
    }

    stop() {
      this.pause();
      if (this.hasSource) {
        try { this.audio.currentTime = 0; } catch (e) { /* metadatos aún no cargados */ }
      }
      this.render();
    }

    paintSeek() {
      this.seek.style.setProperty("--progress", `${this.seek.value / 10}%`);
    }

    renderTime(current, duration) {
      this.timeEl.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    }

    render() {
      const d = this.audio.duration;
      const c = this.audio.currentTime || 0;
      if (!this.isSeeking) {
        this.seek.value = Number.isFinite(d) && d > 0 ? Math.round((c / d) * 1000) : 0;
        this.renderTime(c, Number.isFinite(d) ? d : 0);
      }
      this.paintSeek();
    }
  }

  const originalPlayer = new AudioPlayer($("#originalPlayer"));
  const resultPlayer = new AudioPlayer($("#resultPlayer"));

  originalPlayer.onError = () =>
    toast("Tu navegador no puede reproducir este archivo, pero aún puedes cambiar su tono y escuchar el resultado.", "warning");
  resultPlayer.onError = () =>
    toast("No se pudo cargar la vista previa. Vuelve a aplicar el cambio.", "error");

  // ======================================================================
  // Control de tono
  // ======================================================================
  function getSemitones() {
    return parseInt(dom.slider.value, 10) || 0;
  }

  function setSemitones(n) {
    const clamped = Math.max(CONFIG.minSemitones, Math.min(CONFIG.maxSemitones, n));
    dom.slider.value = clamped;
    updateToneDisplay();
  }

  function updateToneDisplay() {
    const n = getSemitones();
    dom.value.textContent = signed(n);
    dom.desc.textContent = describeSemitones(n);
    const factor = Math.pow(2, n / 12);
    dom.math.innerHTML = `Factor de frecuencia: 2<sup>${n}/12</sup> = ×${factor.toFixed(4)}`;

    // Relleno del control desde el centro (0) hasta el valor actual
    const range = CONFIG.maxSemitones - CONFIG.minSemitones;
    const pos = ((n - CONFIG.minSemitones) / range) * 100;
    const center = ((0 - CONFIG.minSemitones) / range) * 100;
    dom.slider.style.setProperty("--fill-start", `${Math.min(center, pos)}%`);
    dom.slider.style.setProperty("--fill-end", `${Math.max(center, pos)}%`);

    dom.chips.forEach((chip) => chip.classList.toggle("is-active", Number(chip.dataset.value) === n));
    dom.upBtn.disabled = n >= CONFIG.maxSemitones;
    dom.downBtn.disabled = n <= CONFIG.minSemitones;

    // Avisa si la vista previa ya no corresponde al valor del control
    dom.staleHint.hidden = !(state.result && state.result.semitones !== n);
  }

  dom.slider.addEventListener("input", updateToneDisplay);
  dom.upBtn.addEventListener("click", () => setSemitones(getSemitones() + 1));
  dom.downBtn.addEventListener("click", () => setSemitones(getSemitones() - 1));
  dom.chips.forEach((chip) =>
    chip.addEventListener("click", () => setSemitones(Number(chip.dataset.value)))
  );

  // ======================================================================
  // Resultado (vista previa y descarga)
  // ======================================================================
  function clearResult() {
    if (state.result && state.result.url) URL.revokeObjectURL(state.result.url);
    state.result = null;
    resultPlayer.clear();
    dom.resultBlock.dataset.empty = "true";
    dom.resultLabel.textContent = "Aún no hay audio modificado.";
    dom.downloadBtn.setAttribute("aria-disabled", "true");
    dom.downloadBtn.setAttribute("href", "#");
    dom.downloadBtn.tabIndex = -1;
    dom.staleHint.hidden = true;
  }

  function showResult(result) {
    const n = result.semitones;
    if (state.result && state.result.url) URL.revokeObjectURL(state.result.url);
    state.result = result;

    resultPlayer.setSource(result.url);

    const sign = n > 0 ? `+${n}` : `${n}`;
    const downloadName = `${baseName(state.fileName || "audio")}_tono${n >= 0 ? "+" : ""}${n}.wav`;
    dom.downloadBtn.href = result.url;
    dom.downloadBtn.setAttribute("download", downloadName);
    dom.downloadBtn.setAttribute("aria-disabled", "false");
    dom.downloadBtn.removeAttribute("tabindex");

    dom.resultBlock.dataset.empty = "false";
    dom.resultLabel.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = `${sign} semitonos · ${describeSemitones(n)}`;
    dom.resultLabel.append(
      "Resultado: ",
      strong,
      ` · duración ${formatTime(result.duration)} · procesado en ${result.seconds.toFixed(1)} s`
    );
    updateToneDisplay();
  }

  // ======================================================================
  // Bloqueo de controles mientras se sube o procesa
  // ======================================================================
  function refreshControls() {
    const hasFile = state.loaded;
    const busy = state.uploading || state.processing;
    dom.toneControls.disabled = !hasFile;
    dom.applyBtn.disabled = !hasFile || busy;
    dom.resetBtn.disabled = !hasFile || busy;
    dom.newFileBtn.disabled = busy;
    dom.selectBtn.disabled = busy;
    if (hasFile) updateToneDisplay();
  }

  // ======================================================================
  // Carga de archivos
  // ======================================================================
  function validateFile(file) {
    if (!file) return "No se seleccionó ningún archivo.";
    const ext = getExtension(file.name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return `Formato no compatible (.${ext || "sin extensión"}). Solo se permiten archivos MP3 o WAV.`;
    }
    if (file.size === 0) return "El archivo está vacío (0 bytes).";
    if (file.size > MAX_BYTES) {
      return `El archivo pesa ${formatSize(file.size)} y supera el máximo de ${CONFIG.maxSizeMb} MB.`;
    }
    return null;
  }

  function resetToEmpty() {
    originalPlayer.clear();
    clearResult();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    state.channels = null;
    state.loaded = false;
    state.fileName = null;
    dom.fileInfo.hidden = true;
    dom.dropzone.hidden = false;
    dom.originalHint.hidden = false;
    setSemitones(0);
    refreshControls();
  }

  /** Convierte el archivo (MP3 o WAV) en muestras con la Web Audio API. */
  async function decodeFile(file) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error("Tu navegador no soporta la Web Audio API. Usa Chrome, Edge, Firefox o Safari actualizados.");
    const data = await file.arrayBuffer();
    const ctx = new Ctx(1, 1, SAMPLE_RATE);
    try {
      return await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(data, resolve, reject);
        if (p && typeof p.then === "function") p.then(resolve, reject);
      });
    } catch (err) {
      throw new Error("No se pudo leer el archivo. Puede estar dañado o no ser un audio MP3/WAV válido.");
    }
  }

  async function handleFile(file) {
    if (state.uploading || state.processing) {
      toast("Espera a que termine la operación actual.", "warning");
      return;
    }
    const problem = validateFile(file);
    if (problem) {
      toast(problem, "error");
      dom.fileInput.value = "";
      return;
    }

    // Si ya había un archivo, se descarta (RF11)
    const hadFile = state.loaded;
    if (hadFile) resetToEmpty();

    state.uploading = true;
    refreshControls();
    dom.dropzone.hidden = true;
    dom.uploadStatus.hidden = false;

    try {
      const audio = await decodeFile(file);
      const duration = audio.duration;
      if (!audio.length || !Number.isFinite(duration) || duration <= 0) {
        throw new Error("El archivo de audio está vacío o no contiene sonido.");
      }
      if (duration > CONFIG.maxMinutes * 60) {
        throw new Error(`El audio dura ${(duration / 60).toFixed(1)} minutos. El máximo permitido es ${CONFIG.maxMinutes} minutos.`);
      }

      state.channels = [];
      for (let c = 0; c < audio.numberOfChannels; c++) state.channels.push(audio.getChannelData(c));
      state.sampleRate = audio.sampleRate;
      state.fileName = file.name;
      state.objectUrl = URL.createObjectURL(file);
      state.loaded = true;

      dom.fileName.textContent = file.name;
      dom.fileName.title = file.name;
      const nCh = audio.numberOfChannels;
      const channels = nCh === 1 ? "mono" : nCh === 2 ? "estéreo" : `${nCh} canales`;
      dom.fileDetails.textContent =
        `${getExtension(file.name).toUpperCase()} · ${formatSize(file.size)} · ${formatTime(duration)} · ${channels}`;
      dom.fileInfo.hidden = false;
      dom.originalHint.hidden = true;

      originalPlayer.setSource(state.objectUrl);
      clearResult();
      setSemitones(0);
      toast(hadFile ? "Nuevo archivo cargado correctamente." : "Archivo cargado correctamente. Ya puedes ajustar el tono.", "success");
    } catch (err) {
      state.channels = null;
      state.loaded = false;
      dom.dropzone.hidden = false;
      toast(err.message, "error");
    } finally {
      state.uploading = false;
      dom.uploadStatus.hidden = true;
      dom.fileInput.value = "";
      refreshControls();
    }
  }

  // Botón y zona de carga
  dom.selectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.fileInput.click();
  });
  dom.dropzone.addEventListener("click", () => {
    if (!state.uploading) dom.fileInput.click();
  });
  dom.newFileBtn.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    if (file) handleFile(file);
  });

  // Arrastrar y soltar (en la zona de carga o en cualquier parte de la página)
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    dom.dropzone.classList.add("is-dragover");
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dom.dropzone.classList.remove("is-dragover");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dom.dropzone.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // ======================================================================
  // Aplicar cambio de tono
  // ======================================================================
  let timerId = null;

  function startProcessingUI() {
    const started = performance.now();
    dom.processing.hidden = false;
    dom.processingTime.textContent = "0 s";
    setProgress(0);
    timerId = setInterval(() => {
      dom.processingTime.textContent = `${Math.floor((performance.now() - started) / 1000)} s`;
    }, 250);
  }

  function stopProcessingUI() {
    clearInterval(timerId);
    dom.processing.hidden = true;
  }

  function setProgress(p) {
    const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
    dom.progressBar.style.width = `${pct}%`;
    dom.progressText.textContent = `${pct} %`;
  }

  /** Procesa cada canal en su propio Web Worker (en paralelo). */
  function shiftWithWorkers(channels, semitones, onProgress) {
    return new Promise((resolve, reject) => {
      const jobId = state.jobId;
      const progress = new Array(channels.length).fill(0);
      const results = new Array(channels.length);
      const workers = [];
      let pending = channels.length;
      const finish = (fn, value) => {
        workers.forEach((w) => w.terminate());
        fn(value);
      };

      try {
        channels.forEach(() => workers.push(new Worker(WORKER_URL)));
      } catch (err) {
        workers.forEach((w) => w.terminate());
        reject(Object.assign(new Error("Workers no disponibles"), { noWorkers: true }));
        return;
      }

      workers.forEach((worker, index) => {
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.jobId !== jobId) return;
          if (msg.type === "progress") {
            progress[index] = msg.value;
            onProgress(progress.reduce((a, b) => a + b, 0) / channels.length);
          } else if (msg.type === "done") {
            results[index] = msg.samples;
            if (--pending === 0) finish(resolve, results);
          } else if (msg.type === "error") {
            finish(reject, new Error(msg.message));
          }
        };
        worker.onerror = (e) => {
          e.preventDefault();
          finish(reject, Object.assign(new Error("Workers no disponibles"), { noWorkers: true }));
        };
        // Se envía una copia del canal (el original se conserva para volver a procesar)
        const copy = Float32Array.from(channels[index]);
        worker.postMessage({ jobId, index, samples: copy, semitones }, [copy.buffer]);
      });
    });
  }

  /** Plan B: procesar en la página (por ejemplo, si se abrió con doble clic). */
  async function shiftOnMainThread(channels, semitones, onProgress) {
    await new Promise((r) => setTimeout(r, 60)); // deja que se dibuje el indicador
    return window.ToneDSP.pitchShift(channels, state.sampleRate, semitones, onProgress);
  }

  dom.applyBtn.addEventListener("click", async () => {
    if (!state.loaded || state.processing) return;
    const semitones = getSemitones();
    const jobId = ++state.jobId;
    const started = performance.now();

    state.processing = true;
    refreshControls();
    resultPlayer.pause();
    startProcessingUI();

    try {
      let out;
      try {
        out = await shiftWithWorkers(state.channels, semitones, setProgress);
        out = window.ToneDSP.limitPeak(out);
      } catch (err) {
        if (!err.noWorkers) throw err;
        toast("Procesando sin Web Workers: la página puede quedarse quieta unos segundos.", "warning");
        out = await shiftOnMainThread(state.channels, semitones, setProgress);
      }
      if (jobId !== state.jobId) return;   // se cargó otro archivo mientras tanto

      const wav = window.ToneDSP.encodeWav(out, state.sampleRate);
      const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      showResult({
        semitones,
        url,
        duration: out[0].length / state.sampleRate,
        seconds: (performance.now() - started) / 1000,
      });
      const msg = semitones === 0
        ? "Listo. Con 0 semitonos el audio conserva su tono original."
        : `Tono modificado ${signed(semitones)} semitonos. Escucha la vista previa.`;
      toast(msg, "success");
    } catch (err) {
      toast(err.message || "Ocurrió un error al procesar el audio.", "error");
    } finally {
      state.processing = false;
      stopProcessingUI();
      refreshControls();
    }
  });

  // ======================================================================
  // Restablecer tono original (RF09)
  // ======================================================================
  dom.resetBtn.addEventListener("click", () => {
    if (!state.loaded || state.processing) return;
    resultPlayer.stop();
    originalPlayer.stop();
    clearResult();
    setSemitones(0);
    toast("Tono restablecido a 0. Puedes escuchar el audio original sin modificaciones.", "info");
  });

  // ======================================================================
  // Descarga (RF10)
  // ======================================================================
  dom.downloadBtn.addEventListener("click", (e) => {
    if (!state.result) {
      e.preventDefault();
      toast("Primero aplica un cambio de tono.", "warning");
      return;
    }
    toast("Descargando el audio modificado…", "info", 3000);
  });

  // Estado inicial
  clearResult();
  updateToneDisplay();
  refreshControls();
})();
