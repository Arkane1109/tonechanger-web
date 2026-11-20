/* ==========================================================================
   ToneChanger - Web Worker
   Procesa un canal de audio en segundo plano para que la página no se
   congele. La página crea un worker por canal (izquierdo y derecho), así
   los dos canales se procesan al mismo tiempo.
   ========================================================================== */

importScripts("dsp.js");

self.onmessage = (event) => {
  const { jobId, index, samples, semitones } = event.data;
  try {
    let last = 0;
    const out = self.ToneDSP.shiftChannel(samples, semitones, (p) => {
      // Se envía el progreso como máximo cada 2 %
      if (p - last >= 0.02 || p === 1) {
        last = p;
        self.postMessage({ jobId, index, type: "progress", value: p });
      }
    });
    self.postMessage({ jobId, index, type: "done", samples: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ jobId, index, type: "error", message: (err && err.message) || String(err) });
  }
};
