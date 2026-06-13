'use strict';

/**
 * Image → sudoku grid extraction, in pure JavaScript.
 * Finds the puzzle outline (adaptive threshold + connected components),
 * straightens it with a perspective warp, then reads each filled cell with
 * Tesseract.js (loaded lazily from CDN; it runs in a web worker, so the
 * page never freezes).
 */
const Extractor = (() => {

  const WARP_SIZE = 540;          // 9 cells × 60 px
  const CELL = WARP_SIZE / 9;

  let workerPromise = null;

  // ---------- tiny vision toolkit ----------

  /** Canvas/image → { gray: Uint8ClampedArray, w, h }, downscaled to maxDim. */
  function toGray(source, maxDim) {
    const sw = source.width, sh = source.height;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    }
    return { gray, w, h };
  }

  /**
   * Bradley adaptive threshold: ink[i] = 1 where the pixel is noticeably
   * darker than its neighborhood average. Handles uneven lighting/shadows.
   */
  function adaptiveInk(gray, w, h, windowFrac = 1 / 16, t = 0.15) {
    // integral image (one row/col of padding)
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    const half = Math.max(4, Math.round(Math.min(w, h) * windowFrac / 2));
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
                  - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        if (gray[y * w + x] * area < sum * (1 - t)) ink[y * w + x] = 1;
      }
    }
    return ink;
  }

  /**
   * Connected components (4-neighbour flood fill) over an ink mask.
   * Returns per-component stats; corner extremes use x+y / x−y, which give
   * the four corners of a roughly axis-aligned quadrilateral.
   */
  function components(ink, w, h, minCount) {
    const labels = new Int32Array(w * h); // 0 = unvisited
    const comps = [];
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (!ink[start] || labels[start]) continue;
      const label = comps.length + 1;
      let top = 0;
      stack[top++] = start;
      labels[start] = label;
      const comp = {
        count: 0, minX: w, maxX: 0, minY: h, maxY: 0,
        tl: { v: Infinity }, br: { v: -Infinity }, tr: { v: -Infinity }, bl: { v: Infinity },
      };
      while (top > 0) {
        const p = stack[--top];
        const x = p % w, y = (p - x) / w;
        comp.count++;
        if (x < comp.minX) comp.minX = x;
        if (x > comp.maxX) comp.maxX = x;
        if (y < comp.minY) comp.minY = y;
        if (y > comp.maxY) comp.maxY = y;
        const sum = x + y, diff = x - y;
        if (sum < comp.tl.v) comp.tl = { v: sum, x, y };
        if (sum > comp.br.v) comp.br = { v: sum, x, y };
        if (diff > comp.tr.v) comp.tr = { v: diff, x, y };
        if (diff < comp.bl.v) comp.bl = { v: diff, x, y };
        if (x > 0 && ink[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[top++] = p - 1; }
        if (x < w - 1 && ink[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[top++] = p + 1; }
        if (y > 0 && ink[p - w] && !labels[p - w]) { labels[p - w] = label; stack[top++] = p - w; }
        if (y < h - 1 && ink[p + w] && !labels[p + w]) { labels[p + w] = label; stack[top++] = p + w; }
      }
      if (comp.count >= minCount) comps.push(comp);
    }
    return comps;
  }

  /** Pick the component that looks most like a sudoku grid outline. */
  function pickGrid(comps, w, h) {
    const minSide = Math.min(w, h);
    let best = null, bestArea = 0;
    for (const c of comps) {
      const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
      if (bw < minSide * 0.25 || bh < minSide * 0.25) continue;
      const aspect = bw / bh;
      if (aspect < 0.5 || aspect > 2) continue;
      // Grid lines are sparse within their bounding box; a solid blob
      // (photo region, filled rectangle) is not a grid.
      if (c.count > bw * bh * 0.6) continue;
      const area = bw * bh;
      if (area > bestArea) { bestArea = area; best = c; }
    }
    return best;
  }

  /**
   * Homography that maps destination (straight) coords → source quad coords,
   * built from the 4 corner correspondences. Standard 8-unknown DLT solve.
   */
  function homographyTo(quad, size) {
    const src = [[0, 0], [size, 0], [size, size], [0, size]];
    const dst = [[quad.tl.x, quad.tl.y], [quad.tr.x, quad.tr.y], [quad.br.x, quad.br.y], [quad.bl.x, quad.bl.y]];
    // Solve A·hvec = b for h11..h32 (h33 = 1)
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    // Gaussian elimination with partial pivoting
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
      const d = A[col][col];
      if (Math.abs(d) < 1e-12) return null;
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / d;
        for (let k = col; k < 8; k++) A[r][k] -= f * A[col][k];
        b[r] -= f * b[col];
      }
    }
    const hv = b.map((v, i) => v / A[i][i]);
    return [hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1];
  }

  /** Warp the source grayscale through H into a size×size image (bilinear). */
  function warp(gray, w, h, H, size) {
    const out = new Uint8ClampedArray(size * size);
    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        const dn = H[6] * u + H[7] * v + H[8];
        const sx = (H[0] * u + H[1] * v + H[2]) / dn;
        const sy = (H[3] * u + H[4] * v + H[5]) / dn;
        let val = 255;
        if (sx >= 0 && sy >= 0 && sx < w - 1 && sy < h - 1) {
          const x0 = Math.floor(sx), y0 = Math.floor(sy);
          const fx = sx - x0, fy = sy - y0;
          const i = y0 * w + x0;
          val = gray[i] * (1 - fx) * (1 - fy) + gray[i + 1] * fx * (1 - fy)
              + gray[i + w] * (1 - fx) * fy + gray[i + w + 1] * fx * fy;
        }
        out[v * size + u] = val;
      }
    }
    return out;
  }

  function grayToCanvas(gray, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < gray.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- pipeline steps ----------

  function findGridAndWarp(source) {
    const { gray, w, h } = toGray(source, 1000);
    const ink = adaptiveInk(gray, w, h);
    const comps = components(ink, w, h, Math.min(w, h) * 2);
    const grid = pickGrid(comps, w, h);
    if (!grid) return null;
    const H = homographyTo(grid, WARP_SIZE);
    if (!H) return null;
    return warp(gray, w, h, H, WARP_SIZE);
  }

  /**
   * Split the warped grid into 81 cells; build a small clean canvas
   * (black digit on white) for every cell that contains ink.
   */
  function prepareCells(warped) {
    const ink = adaptiveInk(warped, WARP_SIZE, WARP_SIZE, 1 / 12, 0.12);
    const MARGIN = 8;                  // trims the grid lines around each cell
    const inner = CELL - 2 * MARGIN;   // 44
    const out = [];

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        // copy the cell's inner ink mask
        const mask = new Uint8Array(inner * inner);
        const ox = c * CELL + MARGIN, oy = r * CELL + MARGIN;
        for (let y = 0; y < inner; y++) {
          for (let x = 0; x < inner; x++) {
            mask[y * inner + x] = ink[(oy + y) * WARP_SIZE + (ox + x)];
          }
        }
        const comps = components(mask, inner, inner, 20);
        let best = null, bestCount = 0;
        for (const comp of comps) {
          const bw = comp.maxX - comp.minX + 1, bh = comp.maxY - comp.minY + 1;
          // a digit is reasonably tall, not a hairline grid fragment
          if (bh >= inner * 0.33 && bw >= 3 && comp.count > bestCount) {
            bestCount = comp.count;
            best = comp;
          }
        }
        if (!best) continue;

        // crop the digit (with padding) from the warped grayscale
        const pad = 3;
        const x0 = Math.max(0, best.minX - pad), y0 = Math.max(0, best.minY - pad);
        const x1 = Math.min(inner - 1, best.maxX + pad), y1 = Math.min(inner - 1, best.maxY + pad);
        const dw = x1 - x0 + 1, dh = y1 - y0 + 1;
        const crop = new Uint8ClampedArray(dw * dh);
        for (let y = 0; y < dh; y++) {
          for (let x = 0; x < dw; x++) {
            // binarize from the ink mask: black digit on white
            crop[y * dw + x] = mask[(y0 + y) * inner + (x0 + x)] ? 0 : 255;
          }
        }
        const tmp = grayToCanvas(crop, dw, dh);

        // center it on a white square at a comfortable OCR size
        const SIZE = 72, TARGET_H = 44;
        const scale = TARGET_H / dh;
        const sw = Math.max(1, Math.round(dw * scale));
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, (SIZE - sw) / 2, (SIZE - TARGET_H) / 2, sw, TARGET_H);

        out.push({ idx: r * 9 + c, canvas });
      }
    }
    return out;
  }

  // ---------- OCR ----------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the digit reader. Check your internet connection and try again.'));
      document.head.appendChild(s);
    });
  }

  function loadOcrWorker(onStatus) {
    if (!workerPromise) {
      onStatus('Loading the digit reader (first time only)…');
      workerPromise = loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js')
        .then(async () => {
          const worker = await Tesseract.createWorker('eng');
          await worker.setParameters({
            tessedit_char_whitelist: '123456789',
            tessedit_pageseg_mode: Tesseract.PSM.SINGLE_CHAR,
          });
          return worker;
        });
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  // ---------- cancellation ----------

  /** A user-initiated cancel, distinguished from real failures by its name. */
  function abortError() {
    const e = new Error('Reading canceled.');
    e.name = 'AbortError';
    return e;
  }

  /** Reject as soon as `signal` aborts, otherwise settle with the promise.
      Lets a cancel land mid-download, not just between cells. */
  function raceAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        v => { signal.removeEventListener('abort', onAbort); resolve(v); },
        e => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  // ---------- main entry point ----------

  /**
   * `source` is a canvas or image holding the photo/screenshot.
   * `signal` (optional AbortSignal) lets the caller cancel a slow read.
   * Returns { grid, uncertain, warpedURL, digitCount }.
   * Throws Error with a user-friendly message on failure, or an AbortError
   * (err.name === 'AbortError') when the caller cancels.
   */
  async function extract(source, onStatus, signal) {
    onStatus = onStatus || (() => {});
    const throwIfAborted = () => { if (signal && signal.aborted) throw abortError(); };

    throwIfAborted();
    onStatus('Finding the puzzle grid…');
    await new Promise(r => setTimeout(r, 30)); // let the status paint
    const warped = findGridAndWarp(source);
    if (!warped) {
      throw new Error('Could not find a sudoku grid in that image. Try a tighter, straight-on shot of the puzzle, or enter the digits by hand.');
    }
    const warpedURL = grayToCanvas(warped, WARP_SIZE, WARP_SIZE).toDataURL('image/png');

    const cells = prepareCells(warped);
    if (cells.length < 8 || cells.length > 80) {
      throw new Error('That doesn\'t look like a sudoku in progress (found ' + cells.length + ' filled cells). Try a clearer image, or enter the digits by hand.');
    }

    // The reader can be a multi-megabyte first-time download, so let a cancel
    // interrupt it rather than forcing the user to wait it out.
    const worker = await raceAbort(loadOcrWorker(onStatus), signal);
    const grid = new Array(81).fill(0);
    const uncertain = new Array(81).fill(false);

    for (let k = 0; k < cells.length; k++) {
      throwIfAborted();
      onStatus(`Reading digits… ${k + 1} of ${cells.length}`);
      const { idx, canvas } = cells[k];
      try {
        const { data } = await worker.recognize(canvas);
        const ch = (data.text || '').trim().split('').find(ch => ch >= '1' && ch <= '9');
        if (ch) {
          grid[idx] = Number(ch);
          if ((data.confidence || 0) < 65) uncertain[idx] = true;
        } else {
          uncertain[idx] = true; // ink was there but unreadable
        }
      } catch (e) {
        uncertain[idx] = true;
      }
    }

    return { grid, uncertain, warpedURL, digitCount: grid.filter(Boolean).length };
  }

  return { extract };
})();
