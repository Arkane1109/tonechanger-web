/* ==========================================================================
   ToneChanger - Procesamiento de audio (dsp.js)

   Cambia el tono de una señal sin cambiar su duración, con el mismo método
   que usa librosa.effects.pitch_shift:

     1. time_stretch: STFT -> vocoder de fase -> STFT inversa.
        El audio se estira por 1 / rate SIN cambiar sus frecuencias.
     2. resample: el audio estirado se remuestrea para que vuelva a la
        duración original. Al comprimirlo en el tiempo, todas las
        frecuencias quedan multiplicadas por 2^(n/12).

     rate = 2^(-n/12)        (con n = +12, rate = 0,5)

   Este archivo funciona en un Web Worker (pitch-worker.js) y también como
   script normal en la página (se usa si el navegador no permite Workers).
   ========================================================================== */

(function (root) {
  "use strict";

  const N_FFT = 2048;              // muestras por ventana (≈ 46 ms a 44,1 kHz)
  const HOP = 512;                 // salto entre ventanas (75 % de traslape)
  const N_BINS = N_FFT / 2 + 1;    // frecuencias útiles de una FFT real

  // ------------------------------------------------------------------------
  // FFT radix-2 (Cooley-Tukey), iterativa y en el mismo arreglo
  // ------------------------------------------------------------------------
  function createFFT(n) {
    const levels = Math.round(Math.log2(n));
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    // Tabla de inversión de bits para reordenar la entrada
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      let x = i;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      rev[i] = r;
    }

    /** Transformada in place. inverse = false: X[k] = Σ x[n]·e^(−i2πkn/N) */
    return function transform(re, im, inverse) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let j = start, k = 0; j < start + half; j++, k += step) {
            const wr = cos[k];
            const wi = inverse ? sin[k] : -sin[k];
            const l = j + half;
            const tr = re[l] * wr - im[l] * wi;
            const ti = re[l] * wi + im[l] * wr;
            re[l] = re[j] - tr;
            im[l] = im[j] - ti;
            re[j] += tr;
            im[j] += ti;
          }
        }
      }
    };
  }

  // FFT real de N puntos usando una FFT compleja de N/2 (el doble de rápido)
  const M = N_FFT / 2;
  const fftHalf = createFFT(M);
  const TW_COS = new Float64Array(M + 1);
  const TW_SIN = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) {
    TW_COS[k] = Math.cos((2 * Math.PI * k) / N_FFT);
    TW_SIN[k] = Math.sin((2 * Math.PI * k) / N_FFT);
  }
  const zr = new Float64Array(M);
  const zi = new Float64Array(M);

  /** x (N reales) -> Xr, Xi (N/2 + 1 frecuencias) */
  function rfft(x, Xr, Xi) {
    for (let n = 0; n < M; n++) {
      zr[n] = x[2 * n];
      zi[n] = x[2 * n + 1];
    }
    fftHalf(zr, zi, false);
    for (let k = 0; k <= M; k++) {
      const a = k % M;
      const b = (M - k) % M;
      const er = (zr[a] + zr[b]) / 2;
      const ei = (zi[a] - zi[b]) / 2;
      const or = (zi[a] + zi[b]) / 2;
      const oi = -(zr[a] - zr[b]) / 2;
      const wr = TW_COS[k];
      const wi = -TW_SIN[k];
      Xr[k] = er + (wr * or - wi * oi);
      Xi[k] = ei + (wr * oi + wi * or);
    }
  }

  /** Xr, Xi (N/2 + 1 frecuencias) -> x (N reales). Ignora la parte imaginaria de 0 y N/2. */
  function irfft(Xr, Xi, x) {
    const xi0 = Xi[0];
    const xiM = Xi[M];
    Xi[0] = 0;
    Xi[M] = 0;
    for (let k = 0; k < M; k++) {
      const ar = Xr[k];
      const ai = Xi[k];
      const br = Xr[M - k];
      const bi = -Xi[M - k];               // conj(X[M − k])
      const er = (ar + br) / 2;
      const ei = (ai + bi) / 2;
      const dr = (ar - br) / 2;
      const di = (ai - bi) / 2;
      const wr = TW_COS[k];
      const wi = TW_SIN[k];                 // e^(+i2πk/N)
      const or = dr * wr - di * wi;
      const oi = dr * wi + di * wr;
      zr[k] = er - oi;                      // Z = E + i·O
      zi[k] = ei + or;
    }
    Xi[0] = xi0;
    Xi[M] = xiM;
    fftHalf(zr, zi, true);
    for (let n = 0; n < M; n++) {
      x[2 * n] = zr[n] / M;
      x[2 * n + 1] = zi[n] / M;
    }
  }

  // Ventana de Hann periódica (la misma que usa librosa por defecto)
  const WINDOW = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

  // ------------------------------------------------------------------------
  // Paso 1: estirar en el tiempo sin cambiar el tono (vocoder de fase)
  // ------------------------------------------------------------------------
  function timeStretch(x, rate, onProgress) {
    const len = x.length;
    const pad = N_FFT / 2;                              // center=True de librosa
    const nFrames = 1 + Math.floor((len + 2 * pad - N_FFT) / HOP);
    const nOut = Math.ceil(nFrames / rate);             // ventanas de salida
    const outLen = Math.round(len / rate);              // duración estirada

    const buf = new Float64Array(N_FFT);
    const Xr = new Float64Array(N_BINS);
    const Xi = new Float64Array(N_BINS);

    // Analiza la ventana j: magnitud y fase como vector unitario (cos φ, sin φ).
    // Se guardan las dos últimas para no repetir FFTs.
    const cache = new Map();
    function frame(j) {
      let f = cache.get(j);
      if (f) return f;
      f = { mag: new Float64Array(N_BINS), ur: new Float64Array(N_BINS), ui: new Float64Array(N_BINS) };
      if (j < nFrames) {
        const start = j * HOP - pad;
        for (let n = 0; n < N_FFT; n++) {
          const idx = start + n;
          buf[n] = idx >= 0 && idx < len ? x[idx] * WINDOW[n] : 0;
        }
        rfft(buf, Xr, Xi);
        for (let k = 0; k < N_BINS; k++) {
          const m = Math.sqrt(Xr[k] * Xr[k] + Xi[k] * Xi[k]);
          f.mag[k] = m;
          if (m > 0) { f.ur[k] = Xr[k] / m; f.ui[k] = Xi[k] / m; } else { f.ur[k] = 1; f.ui[k] = 0; }
        }
      } else {
        f.ur.fill(1);                                   // ventanas de relleno (silencio)
      }
      cache.set(j, f);
      if (cache.size > 3) cache.delete(cache.keys().next().value);
      return f;
    }

    // Salida por superposición y suma (STFT inversa)
    const yLen = N_FFT + HOP * (nOut - 1);
    const y = new Float64Array(yLen);
    const wss = new Float64Array(yLen);                 // suma de ventana²

    // Fase acumulada guardada como vector unitario: acc = e^(iφ)
    const first = frame(0);
    const accR = Float64Array.from(first.ur);
    const accI = Float64Array.from(first.ui);

    for (let t = 0; t < nOut; t++) {
      const step = t * rate;
      const i0 = Math.floor(step);
      const alpha = step - i0;
      const f0 = frame(i0);
      const f1 = frame(i0 + 1);

      for (let k = 0; k < N_BINS; k++) {
        // Magnitud interpolada entre las dos ventanas vecinas, con la fase acumulada
        const m = (1 - alpha) * f0.mag[k] + alpha * f1.mag[k];
        Xr[k] = m * accR[k];
        Xi[k] = m * accI[k];

        // Avance de fase = φ1 − φ0 (equivale a avance esperado + desviación envuelta,
        // porque sumar 2π no cambia e^(iφ)). Se aplica como rotación: acc · u1 · conj(u0)
        const rr = f1.ur[k] * f0.ur[k] + f1.ui[k] * f0.ui[k];
        const ri = f1.ui[k] * f0.ur[k] - f1.ur[k] * f0.ui[k];
        const nr = accR[k] * rr - accI[k] * ri;
        const ni = accR[k] * ri + accI[k] * rr;
        accR[k] = nr;
        accI[k] = ni;
      }
      irfft(Xr, Xi, buf);

      const offset = t * HOP;
      for (let n = 0; n < N_FFT; n++) {
        const w = WINDOW[n];
        y[offset + n] += buf[n] * w;
        wss[offset + n] += w * w;
      }

      // Re-normaliza la fase acumulada de vez en cuando (errores de redondeo)
      if (t % 64 === 63) {
        for (let k = 0; k < N_BINS; k++) {
          const m = Math.sqrt(accR[k] * accR[k] + accI[k] * accI[k]) || 1;
          accR[k] /= m;
          accI[k] /= m;
        }
      }
      if (onProgress && t % 256 === 0) onProgress(t / nOut);
    }

    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = i + pad;
      if (idx < yLen) out[i] = wss[idx] > 1e-10 ? y[idx] / wss[idx] : y[idx];
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // Paso 2: remuestreo con un filtro sinc enventanado (Kaiser)
  // ------------------------------------------------------------------------
  const ZC = 16;                 // cruces por cero a cada lado del filtro
  const RES = 512;               // resolución de la tabla del filtro
  const ROLLOFF = 0.95;          // corte un poco antes de Nyquist (anti-aliasing)
  const KAISER_BETA = 8.6;

  function besselI0(x) {
    let sum = 1;
    let term = 1;
    const q = (x * x) / 4;
    for (let k = 1; k < 50; k++) {
      term *= q / (k * k);
      sum += term;
      if (term < sum * 1e-12) break;
    }
    return sum;
  }

  const KERNEL = (() => {
    const size = ZC * RES + 2;
    const table = new Float64Array(size);
    const i0b = besselI0(KAISER_BETA);
    for (let i = 0; i < size; i++) {
      const u = i / RES;
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      const r = u / ZC;
      const win = r <= 1 ? besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0b : 0;
      table[i] = sinc * win;
    }
    return table;
  })();

  /** Remuestrea z: la salida tiene ratio veces el número de muestras. */
  function resample(z, ratio, outLen, onProgress) {
    const out = new Float32Array(outLen);
    const scale = Math.min(1, ratio) * ROLLOFF;   // filtro pasa-bajos al bajar la tasa
    const half = ZC / scale;
    const zLen = z.length;
    for (let i = 0; i < outLen; i++) {
      const p = i / ratio;                         // posición en la señal de entrada
      const j0 = Math.max(0, Math.ceil(p - half));
      const j1 = Math.min(zLen - 1, Math.floor(p + half));
      let acc = 0;
      for (let j = j0; j <= j1; j++) {
        const pos = Math.abs(p - j) * scale * RES;
        const idx = pos | 0;
        const frac = pos - idx;
        acc += z[j] * (KERNEL[idx] + frac * (KERNEL[idx + 1] - KERNEL[idx]));
      }
      out[i] = acc * scale;
      if (onProgress && i % 65536 === 0) onProgress(i / outLen);
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // Cambio de tono completo (equivale a librosa.effects.pitch_shift)
  // ------------------------------------------------------------------------
  function checkSemitones(semitones) {
    const n = Number(semitones);
    if (!Number.isInteger(n) || n < -12 || n > 12) {
      throw new Error("El tono debe ser un número entero entre -12 y +12.");
    }
    return n;
  }

  /** Cambia el tono de UN canal. Devuelve un Float32Array del mismo largo. */
  function shiftChannel(x, semitones, onProgress) {
    const n = checkSemitones(semitones);
    const report = typeof onProgress === "function" ? onProgress : () => {};
    if (n === 0) {
      report(1);
      return Float32Array.from(x);
    }
    const rate = Math.pow(2, -n / 12);
    const stretched = timeStretch(x, rate, (p) => report(0.6 * p));
    const out = resample(stretched, rate, x.length, (p) => report(0.6 + 0.4 * p));
    report(1);
    return out;
  }

  /** Evita la saturación: si algún pico pasa de 0,999 se escala toda la señal. */
  function limitPeak(channels) {
    let peak = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > 0.999) {
      const g = 0.999 / peak;
      for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    }
    return channels;
  }

  /** Todos los canales seguidos (se usa si no hay Web Workers). */
  function pitchShift(channels, sampleRate, semitones, onProgress) {
    checkSemitones(semitones);
    const report = typeof onProgress === "function" ? onProgress : () => {};
    const out = channels.map((x, c) =>
      shiftChannel(x, semitones, (p) => report((c + p) / channels.length))
    );
    return limitPeak(out);
  }

  // ------------------------------------------------------------------------
  // Archivo WAV PCM de 16 bits
  // ------------------------------------------------------------------------
  function encodeWav(channels, sampleRate) {
    const nCh = channels.length;
    const len = channels[0].length;
    const dataBytes = len * nCh * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buffer);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

    str(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, nCh, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nCh * 2, true); v.setUint16(32, nCh * 2, true);
    v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < nCh; c++) {
        const s = Math.max(-1, Math.min(1, channels[c][i]));
        v.setInt16(off, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
        off += 2;
      }
    }
    return buffer;
  }

  const api = { pitchShift, shiftChannel, limitPeak, encodeWav, timeStretch, resample, N_FFT, HOP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ToneDSP = api;
})(typeof self !== "undefined" ? self : this);
