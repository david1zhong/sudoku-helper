'use strict';

(() => {

  // ---------- state ----------
  const EMPTY = 0, GIVEN = 1, SOLVED = 2;
  let grid = new Array(81).fill(0);
  let types = new Array(81).fill(EMPTY);   // EMPTY | GIVEN | SOLVED
  let uncertain = new Array(81).fill(false);
  let selected = -1;
  let history = [];                        // snapshots for Undo
  let currentHint = null;
  let busy = false;
  let uncertainWarned = false;             // first hint press with "?" cells outstanding warns once

  const STORAGE_KEY = 'sudoku-helper-v1';

  // ---------- elements ----------
  const $ = id => document.getElementById(id);
  const viewUpload = $('view-upload');
  const viewSolve = $('view-solve');
  const dropzone = $('dropzone');
  const fileInput = $('file-input');
  const statusEl = $('upload-status');
  const cancelBtn = $('cancel-btn');
  const cancelLine = $('cancel-line');
  const boardEl = $('board');
  const reviewBanner = $('review-banner');
  const warpedThumb = $('warped-thumb');
  const thumbFig = $('thumb-fig');
  const readbackList = $('readback-list');
  const thumbHome = $('thumb-home');

  /** The thumbnail lives in the review banner while verifying, in the extras after. */
  function placeThumb(inBanner) {
    (inBanner ? reviewBanner : thumbHome).appendChild(thumbFig);
  }
  const conflictMsg = $('conflict-msg');
  const hintPanel = $('hint-panel');
  const hintBtn = $('hint-btn');
  const undoBtn = $('undo-btn');
  const newBtn = $('new-btn');
  const numpad = $('numpad');
  const hintEmpty = $('hint-empty');
  const dock = $('hint-dock');
  const dockTitle = $('dock-title');
  const dockCaption = $('dock-caption');
  const dockAction = $('dock-action');

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // touch devices have no Enter key; confirmation advice must match the input
  const coarseInput = window.matchMedia('(hover: none) and (pointer: coarse)');

  // Visually-hidden live region for screen-reader announcements.
  const announcer = document.createElement('div');
  announcer.className = 'sr-only';
  announcer.setAttribute('aria-live', 'polite');
  document.body.appendChild(announcer);
  function announce(msg) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = msg; }, 50);
  }

  // ---------- board DOM ----------
  const cellEls = [];
  const valEls = [];
  (function buildBoard() {
    for (let i = 0; i < 81; i++) {
      const r = Math.floor(i / 9), c = i % 9;
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.dataset.idx = i;
      if (c === 2 || c === 5) cell.classList.add('b-right');
      if (r === 2 || r === 5) cell.classList.add('b-bottom');
      cell.tabIndex = i === 0 ? 0 : -1; // roving tabindex
      cell.addEventListener('click', () => { selectCell(i); });
      cell.addEventListener('focus', () => { if (selected !== i) selectCell(i, false); });
      const val = document.createElement('span');
      val.className = 'val';
      cell.appendChild(val);
      boardEl.appendChild(cell);
      cellEls.push(cell);
      valEls.push(val);
    }
  })();

  function selectCell(i, focus = true) {
    selected = i;
    render();
    if (focus) cellEls[i].focus();
  }

  // ---------- rendering ----------
  function render() {
    const dupes = Solver.conflicts(grid);
    const conflictCells = new Set();
    for (const d of dupes) d.cells.forEach(c => conflictCells.add(c));

    for (let i = 0; i < 81; i++) {
      const el = cellEls[i];
      valEls[i].textContent = grid[i] ? String(grid[i]) : '';
      el.classList.toggle('given', types[i] === GIVEN);
      el.classList.toggle('solved', types[i] === SOLVED);
      el.classList.toggle('uncertain', uncertain[i]);
      el.classList.toggle('conflict', conflictCells.has(i));
      el.classList.toggle('selected', selected === i);
      el.classList.remove('hl-target', 'hl-source', 'hl-unit', 'hl-elim', 'hl-candidate');
      el.tabIndex = (selected === -1 ? i === 0 : selected === i) ? 0 : -1;
      const bits = [grid[i] ? String(grid[i]) + (types[i] === SOLVED ? ', placed by hint' : '') : 'empty'];
      if (uncertain[i]) bits.push('not sure, please check');
      if (conflictCells.has(i)) bits.push('conflicts with another cell');
      const label = `Row ${Math.floor(i / 9) + 1}, column ${i % 9 + 1}, ${bits.join(', ')}`;
      el.dataset.baseLabel = label;
      el.setAttribute('aria-label', label);
    }
    saveState();

    if (dupes.length) {
      const d = dupes[0];
      conflictMsg.textContent = `Two ${d.digit}s clash (shown in red). Tap a red cell and retype it.`;
      conflictMsg.hidden = false;
    } else {
      conflictMsg.hidden = true;
    }

    undoBtn.disabled = history.length === 0;
    for (const b of numpad.querySelectorAll('.pad-btn')) b.disabled = selected === -1;
    numpad.classList.toggle('inactive', selected === -1);
    if (currentHint && currentHint.final) annotate(currentHint.final);
    updateReadback();
  }

  /**
   * Spoken/text version of the grid for verifying the photo read without
   * comparing images: one line per row, kept in sync as cells are fixed.
   */
  function updateReadback() {
    if (reviewBanner.hidden) return;
    const rows = [];
    for (let r = 0; r < 9; r++) {
      const cells = [];
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        cells.push(grid[i] ? String(grid[i]) + (uncertain[i] ? ' (not sure)' : '') : 'blank');
      }
      rows.push(`Row ${r + 1}: ` + cells.join(', '));
    }
    const key = rows.join('|');
    if (readbackList.dataset.key === key) return;
    readbackList.dataset.key = key;
    readbackList.innerHTML = '';
    for (const text of rows) {
      const li = document.createElement('li');
      li.textContent = text;
      readbackList.appendChild(li);
    }
  }

  /** Paint a step onto the board: highlight classes + ghost pencil marks. */
  function annotate(step) {
    if (!step) return;
    const h = step.highlights;
    if (h) {
      for (const i of h.unit || []) cellEls[i].classList.add('hl-unit');
      for (const i of h.elim || []) cellEls[i].classList.add('hl-elim');
      for (const i of h.candidate || []) cellEls[i].classList.add('hl-candidate');
      for (const i of h.source || []) cellEls[i].classList.add('hl-source');
      for (const i of h.target || []) cellEls[i].classList.add('hl-target');
    }
    if (step.marks) {
      const byCell = new Map();
      for (const m of step.marks) {
        if (grid[m.cell]) continue; // never draw over a real digit
        if (!byCell.has(m.cell)) byCell.set(m.cell, []);
        byCell.get(m.cell).push(m);
      }
      for (const [cell, ms] of byCell) {
        // In the answer cell the green digit is the whole message; stacking the
        // eight cross-outs on top of it just buries the one number that matters.
        // The "everything else is ruled out" story lives in the caption and the
        // aria-label (built from the full mark set below), so nothing is lost.
        const yesMarks = ms.filter(m => m.kind === 'yes');
        const visible = yesMarks.length ? yesMarks : ms;
        const wrap = document.createElement('div');
        wrap.className = 'marks' + (visible.length === 1 ? ' single' : '');
        for (const m of visible) {
          const s = document.createElement('span');
          s.className = 'mark ' + m.kind;
          s.textContent = m.digit;
          if (visible.length > 1) s.style.gridArea = `${Math.floor((m.digit - 1) / 3) + 1} / ${(m.digit - 1) % 3 + 1}`;
          wrap.appendChild(s);
        }
        cellEls[cell].appendChild(wrap);

        // expose the hint marks to assistive tech via the cell's name
        const phrases = [];
        const by = kind => ms.filter(m => m.kind === kind).map(m => m.digit);
        const yes = by('yes'), no = by('no'), maybe = by('maybe');
        if (yes.length) {
          phrases.push(`hint: place ${yes.join(', ')} here`);
          // listing eight crossed-out digits one by one is pure noise
          if (no.length) phrases.push('every other number is ruled out');
        } else {
          if (maybe.length) phrases.push(`hint: ${maybe.join(', ')} could go here`);
          if (no.length) phrases.push(`hint: ${no.join(', ')} ruled out here`);
        }
        const el = cellEls[cell];
        el.setAttribute('aria-label', (el.dataset.baseLabel || '') + ', ' + phrases.join(', '));
      }
    }
  }

  function clearHighlightsOnly() {
    for (const el of cellEls) {
      el.classList.remove('hl-target', 'hl-source', 'hl-unit', 'hl-elim', 'hl-candidate');
      for (const m of el.querySelectorAll('.marks')) m.remove();
      if (el.dataset.baseLabel) el.setAttribute('aria-label', el.dataset.baseLabel);
    }
  }

  // ---------- editing ----------
  document.addEventListener('keydown', e => {
    if (viewSolve.hidden || selected === -1) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const r = Math.floor(selected / 9), c = selected % 9;
    if (e.key >= '1' && e.key <= '9') {
      setCell(selected, Number(e.key), GIVEN);
    } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
      setCell(selected, 0, EMPTY);
    } else if (e.key === 'Enter' && grid[selected] && uncertain[selected]) {
      uncertain[selected] = false;
      render();
      announce('Marked as correct.');
    } else if (e.key === 'ArrowUp' && r > 0) selectCell(selected - 9);
    else if (e.key === 'ArrowDown' && r < 8) selectCell(selected + 9);
    else if (e.key === 'ArrowLeft' && c > 0) selectCell(selected - 1);
    else if (e.key === 'ArrowRight' && c < 8) selectCell(selected + 1);
    else return;
    e.preventDefault();
  });

  function setCell(i, digit, type) {
    // Typing the hinted digit into the hinted cell fulfils the hint, so
    // celebrate it instead of silently wiping the explanation.
    const f = currentHint && currentHint.final;
    if (f && digit && i === f.cell && digit === f.digit) {
      applyFinal(f, true);
      return;
    }
    pushHistory();
    grid[i] = digit;
    types[i] = digit ? type : EMPTY;
    uncertain[i] = false;
    dismissHint();
    render();
  }

  function pushHistory() {
    history.push({ grid: grid.slice(), types: types.slice(), uncertain: uncertain.slice(), hint: currentHint });
    if (history.length > 200) history.shift();
  }

  undoBtn.addEventListener('click', () => {
    const prev = history.pop();
    if (!prev) return;
    grid = prev.grid; types = prev.types; uncertain = prev.uncertain;
    dismissHint();
    // Bring back the explanation that was on screen at that point. The grid
    // state it reasoned about has just been restored, so it's valid again.
    if (prev.hint && !prev.hint.error && !prev.hint.done) {
      currentHint = prev.hint;
      renderHint(prev.hint);
      updateHintEmpty();
    }
    render();
    announce('Undid the last change.');
  });

  // Tapping the pad with no cell selected lands on the container (disabled
  // buttons pass pointer events through); point at the tip instead of going dead.
  const numpadTip = $('numpad-tip');
  let tipTimer = null;
  numpad.addEventListener('click', e => {
    const b = e.target.closest('.pad-btn');
    if (!b || selected === -1) {
      if (selected === -1) {
        numpadTip.classList.add('attention');
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => numpadTip.classList.remove('attention'), 1800);
        announce('Tap a cell on the board first, then choose a number.');
      }
      return;
    }
    const d = Number(b.dataset.digit);
    setCell(selected, d, d ? GIVEN : EMPTY);
  });

  // ---------- image input ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragover', 'dragenter'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); dropzone.classList.remove('dragging'); }));
  dropzone.addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) handleFile(f);
  });
  // Stop the browser from navigating away if an image is dropped outside the zone.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) { e.preventDefault(); handleFile(f); }
        return;
      }
    }
  });

  // ---------- persistence ----------
  let saveTimer = null;
  function saveState() {
    // Debounced: render() runs on every selection move; writing is only
    // needed once things settle.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (!grid.some(Boolean)) { localStorage.removeItem(STORAGE_KEY); return; }
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          grid, types, uncertain,
          thumb: warpedThumb.src && warpedThumb.src.startsWith('data:') ? warpedThumb.src : '',
          savedAt: Date.now(),
        }));
      } catch (e) { /* storage full or blocked; saving is best-effort */ }
    }, 250);
  }

  (function offerResume() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!Array.isArray(s.grid) || s.grid.length !== 81 || !s.grid.some(Boolean)) return;
      $('resume-line').hidden = false;
      $('resume-btn').addEventListener('click', () => {
        grid = s.grid.slice();
        types = (s.types || s.grid.map(v => (v ? 1 : 0))).slice();
        uncertain = (s.uncertain || new Array(81).fill(false)).slice();
        if (s.thumb) warpedThumb.src = s.thumb;
        showSolveView(false);
        if (s.thumb) { placeThumb(false); thumbFig.hidden = false; }
        announce('Puzzle restored. Press “Find my next number” whenever you are stuck.');
      });
    } catch (e) { /* corrupt saved state; ignore */ }
  })();

  function startManualEntry() {
    resetState();
    showSolveView(false);
  }
  $('manual-btn').addEventListener('click', startManualEntry);
  $('error-manual-btn').addEventListener('click', startManualEntry);

  // Two-step in-page confirm, no jarring browser dialog.
  let newConfirmTimer = null;
  function resetNewBtn() {
    clearTimeout(newConfirmTimer);
    newBtn.classList.remove('confirming');
    newBtn.textContent = 'New puzzle';
  }
  newBtn.addEventListener('click', () => {
    if (grid.some(Boolean) && !newBtn.classList.contains('confirming')) {
      newBtn.classList.add('confirming');
      newBtn.textContent = 'Tap again to clear';
      newConfirmTimer = setTimeout(resetNewBtn, 4000);
      return;
    }
    resetNewBtn();
    resetState();
    viewSolve.hidden = true;
    viewUpload.hidden = false;
    setStatus('');
  });

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
    statusEl.hidden = !msg;
    // On failure, offer the recovery path as a real button, not just prose.
    $('error-manual').hidden = !isError;
  }

  async function handleFile(file) {
    if (busy) return;
    // Replacing an existing grid is undoable rather than gated by a dialog.
    const prevSnapshot = (!viewSolve.hidden && grid.some(Boolean))
      ? { grid: grid.slice(), types: types.slice(), uncertain: uncertain.slice() }
      : null;

    busy = true;
    viewSolve.hidden = true;
    viewUpload.hidden = false;
    dropzone.classList.add('busy');
    const controller = new AbortController();
    cancelBtn.onclick = () => { controller.abort(); cancelBtn.disabled = true; };
    cancelBtn.disabled = false;
    cancelLine.hidden = false;
    try {
      const bmp = await blobToCanvas(file);
      setStatus('Analyzing image…');
      const result = await Extractor.extract(bmp, msg => setStatus(msg), controller.signal);

      resetState();
      grid = result.grid.slice();
      uncertain = result.uncertain.slice();
      types = grid.map(v => (v ? GIVEN : EMPTY));
      warpedThumb.src = result.warpedURL;
      warpedThumb.alt = `Straightened photo of your puzzle. I read ${result.digitCount} digits from it; the grid beside it shows them.`;
      placeThumb(true);
      if (prevSnapshot) history = [prevSnapshot];

      const unreadable = uncertain.filter(Boolean).length;
      const confirmHow = coarseInput.matches
        ? 'retype the digit to confirm it, or type the right one'
        : 'press Enter to confirm, or retype';
      reviewBanner.querySelector('p').textContent =
        `I read ${result.digitCount} digits. Compare the grid against the picture and fix any wrong cell.` +
        (unreadable ? ` The ${unreadable > 1 ? unreadable + ' yellow cells' : 'yellow cell'} with a “?” ${unreadable > 1 ? 'are ones' : 'is one'} I wasn't sure about: ${confirmHow}.` : '') +
        (prevSnapshot ? ' Your previous grid is one Undo away.' : '');
      reviewBanner.hidden = false;
      showSolveView(true);
      setStatus('');
      // Land the screen reader on the review step instead of dropping focus to
      // the body when the upload view it was on disappears.
      announce(reviewBanner.querySelector('p').textContent);
      $('review-heading').focus();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        setStatus('');
        announce('Reading canceled. Your photo was not used. Choose another, or type the puzzle in by hand.');
        dropzone.focus(); // the Cancel button is about to be hidden
      } else {
        setStatus(err.message || 'I could not read that image. Try a clearer photo, or type the puzzle in by hand below.', true);
      }
    } finally {
      cancelLine.hidden = true;
      cancelBtn.onclick = null;
      dropzone.classList.remove('busy');
      busy = false;
    }
  }

  function blobToCanvas(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that image file.')); };
      img.src = url;
    });
  }

  function resetState() {
    grid = new Array(81).fill(0);
    types = new Array(81).fill(EMPTY);
    uncertain = new Array(81).fill(false);
    selected = -1;
    history = [];
    uncertainWarned = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    dismissHint();
  }

  function showSolveView(fromImage) {
    viewUpload.hidden = true;
    viewSolve.hidden = false;
    reviewBanner.hidden = !fromImage;
    thumbFig.hidden = !fromImage;
    resetHintBtnLabel();
    render();
  }

  /** The big button's resting label depends on where the user is in the flow:
      verifying a photo, or just looking for the next move. */
  function resetHintBtnLabel() {
    hintBtn.textContent = reviewBanner.hidden
      ? 'Find my next number'
      : 'Looks right, find my next number';
  }

  // ---------- hints ----------
  hintBtn.addEventListener('click', () => {
    if (!reviewBanner.hidden) {
      reviewBanner.hidden = true;
      placeThumb(false);
      resetHintBtnLabel();
    }

    // A hint computed from a misread digit is confidently wrong, so insist on
    // one check of the unsure cells before the first hint (second press proceeds).
    const unconfirmed = [];
    for (let i = 0; i < 81; i++) if (uncertain[i]) unconfirmed.push(i);
    if (unconfirmed.length && !uncertainWarned) {
      uncertainWarned = true;
      dismissHint();
      const msg = unconfirmed.length > 1
        ? `There are ${unconfirmed.length} cells I wasn't sure I read correctly. They're yellow with a “?”.`
        : `There is 1 cell I wasn't sure I read correctly. It's yellow with a “?”.`;
      hintPanel.appendChild(card('warn', 'One quick check first', [
        msg,
        (coarseInput.matches
          ? 'Compare each one against your puzzle. Retype the digit to confirm it, or type the right digit to fix it.'
          : 'Compare each one against your puzzle. Press Enter (or retype the digit) to confirm it, or type the right digit to fix it.'),
        'Then press “Find my next number” again and it will go ahead either way.',
      ]));
      updateHintEmpty();
      selectCell(unconfirmed[0]);
      announce(msg + ' Please check them, then ask again.');
      return;
    }

    // A hint left unplaced: pressing the button again writes it in with a
    // little animation, then moves straight on to the next number.
    const f = currentHint && currentHint.final;
    if (f && !grid[f.cell]) {
      pushHistory();
      grid[f.cell] = f.digit;
      types[f.cell] = SOLVED;
      uncertain[f.cell] = false;
      dismissHint();
      render();
      popIn(f.cell);
      announce(`${f.digit} placed at ${Solver.cellName(f.cell)}. Looking for the next number.`);
      hintBtn.disabled = true;
      setTimeout(() => {
        hintBtn.disabled = false;
        showNextHint();
      }, prefersReducedMotion.matches ? 0 : 700);
      return;
    }

    showNextHint();
  });

  function showNextHint() {
    dismissHint();
    // No sudoku has a single answer with fewer than 17 numbers, so an almost
    // empty grid means the puzzle has not been entered yet, not that anything
    // is wrong. Point the user at the grid instead of computing a non-answer.
    if (grid.filter(Boolean).length < 17) {
      hintPanel.appendChild(card('warn', 'Add your puzzle first', [
        'I can only find your next number once the puzzle’s printed numbers are in the grid.',
        'Type them in with the number pad below, then press “Find my next number” again.',
      ]));
      updateHintEmpty();
      announce('Type your puzzle’s printed numbers into the grid first, then ask again.');
      return;
    }
    const res = Solver.getHint(grid);
    currentHint = res;
    renderHint(res);
    updateHintEmpty();
    render();
  }

  /** Brief pop on a digit the helper just wrote in, so the eye lands on it. */
  function popIn(cell) {
    cellEls[cell].classList.add('just-placed');
    valEls[cell].classList.add('just-placed');
    setTimeout(() => {
      cellEls[cell].classList.remove('just-placed');
      valEls[cell].classList.remove('just-placed');
    }, 1100);
  }

  function updateHintEmpty() {
    // The legend stays available but folds away once a hint is on screen.
    hintEmpty.open = hintPanel.childElementCount === 0;
  }

  function dismissHint() {
    currentHint = null;
    hintPanel.innerHTML = '';
    clearHighlightsOnly();
    dock.hidden = true;
    document.body.classList.remove('dock-open');
    resetHintBtnLabel();
    updateHintEmpty();
  }

  /** Fill in the hinted digit (shared by the hint card, the dock, and typing it yourself). */
  function applyFinal(f, typedItYourself) {
    pushHistory();
    grid[f.cell] = f.digit;
    types[f.cell] = SOLVED;
    uncertain[f.cell] = false;
    dismissHint();
    render();
    popIn(f.cell);
    const sc = card('success',
      typedItYourself ? `You found the ${f.digit}` : `${f.digit} placed`,
      [(typedItYourself ? 'Exactly right: ' : 'Filled in at ') + Solver.cellName(f.cell) + '. It appears in green italics, so you can always tell your placed numbers from the printed ones. Stuck again later? Just press “Find my next number”.']);
    sc.tabIndex = -1;
    hintPanel.appendChild(sc);
    updateHintEmpty();
    sc.focus(); // the button that was focused no longer exists
    announce(typedItYourself
      ? `Exactly right. ${f.digit} placed at ${Solver.cellName(f.cell)}.`
      : `${f.digit} placed at ${Solver.cellName(f.cell)}.`);
  }

  /** Compact fixed bar so the hint stays visible next to the board on phones.
      Teach-first: its action points at the cell instead of placing the digit. */
  function showDock(f) {
    dockTitle.textContent = f.title;
    // The title already carries the coordinate; keep the caption to the short
    // teach-first nudge so it never clamps mid-sentence. "Show me where" and the
    // green ring point at the cell.
    dockCaption.textContent = `Type the ${f.digit} in yourself.`;
    dockAction.textContent = 'Show me where';
    dockAction.onclick = () => lookAt(f.cell, f.digit);
    dock.hidden = false;
    document.body.classList.add('dock-open');
  }

  /** Scroll the board to a cell and pulse its ring once. The pulse is visual,
      so name the cell out loud for anyone who can't see it. */
  function lookAt(cell, digit) {
    const el = cellEls[cell];
    el.scrollIntoView({ behavior: prefersReducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
    el.classList.remove('look-here');
    void el.offsetWidth; // restart the animation on repeat taps
    el.classList.add('look-here');
    setTimeout(() => el.classList.remove('look-here'), 1300);
    announce(`The green cell is at ${Solver.cellName(cell)}.` + (digit ? ` Type the ${digit} there.` : ''));
  }

  $('dock-close').addEventListener('click', () => {
    dock.hidden = true;
    document.body.classList.remove('dock-open');
  });

  function renderHint(res) {
    hintPanel.innerHTML = '';

    if (res.error) {
      hintPanel.appendChild(card('error', 'Something\'s off', [res.error]));
      if (res.errorCells) {
        for (const c of res.errorCells) cellEls[c].classList.add('conflict');
      }
      announce(res.error);
      return;
    }
    if (res.done) {
      hintPanel.appendChild(card('success', 'Solved!', ['The puzzle is complete: every cell is filled and valid. Nice work!']));
      announce('The puzzle is complete. Nice work!');
      return;
    }

    if (res.warning) {
      hintPanel.appendChild(card('warn', 'Check the grid', [res.warning]));
    }

    if (res.presteps.length) {
      const wrap = document.createElement('details');
      wrap.className = 'presteps';
      const sum = document.createElement('summary');
      sum.textContent = `First, ${res.presteps.length} thing${res.presteps.length > 1 ? 's' : ''} to notice. Tap a note to show it on the board; tap it again to hide it.`;
      wrap.appendChild(sum);
      // The card is a big mouse/touch target, but the real control is a
      // button inside it, so keyboards and screen readers reach both it and
      // the nested "Read the full logic" disclosure.
      let pinned = null; // { card, btn }
      const unpin = () => {
        if (!pinned) return;
        pinned.card.classList.remove('pinned');
        pinned.btn.textContent = 'Show on the board';
        pinned = null;
      };
      res.presteps.forEach((step, k) => {
        // Don't repeat the technique kicker back to back: the numbered title
        // already tells consecutive notes apart, so a second identical kicker
        // just reads as a duplicate card.
        const sameAsPrev = k > 0 && res.presteps[k - 1].technique === step.technique;
        const el = stepCard('note', `Note ${k + 1}: ${step.title}`, step, sameAsPrev ? null : step.technique);
        const showStep = () => { clearHighlightsOnly(); annotate(step); };
        const showFinal = () => { clearHighlightsOnly(); annotate(res.final); };

        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = 'Show on the board';
        el.appendChild(btn);

        const toggle = () => {
          if (pinned && pinned.card === el) {
            unpin();
            showFinal();
          } else {
            unpin();
            pinned = { card: el, btn };
            el.classList.add('pinned');
            btn.textContent = 'Hide from the board';
            showStep();
            announce(`Showing note ${k + 1} on the board: ${step.caption || step.title}`);
          }
        };
        btn.addEventListener('click', toggle);
        el.addEventListener('click', e => {
          if (e.target.closest('button, details')) return;
          toggle();
        });
        el.addEventListener('mouseenter', () => { if (!pinned) showStep(); });
        el.addEventListener('mouseleave', () => { if (!pinned) showFinal(); });
        btn.addEventListener('focus', () => { if (!pinned) showStep(); });
        btn.addEventListener('blur', () => { if (!pinned) showFinal(); });
        wrap.appendChild(el);
      });
      hintPanel.appendChild(wrap);
    }

    const f = res.final;
    const fc = stepCard(f.kind === 'reveal' ? 'reveal' : 'place', f.title, f, f.technique);
    if (f.kind === 'reveal') {
      const note = document.createElement('p');
      note.className = 'fineprint';
      note.textContent = 'The dashed edge means this number was taken from the finished solution rather than deduced step by step.';
      fc.appendChild(note);
    }
    // Teach-first: the primary path is the user placing the number themselves.
    const teach = document.createElement('p');
    teach.className = 'teach';
    teach.textContent = `Now find the green cell at ${Solver.cellName(f.cell)} and type the ${f.digit} in yourself.`;
    const det = fc.querySelector('details');
    if (det) fc.insertBefore(teach, det); else fc.appendChild(teach);
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Or place it for me';
    btn.addEventListener('click', () => applyFinal(f));
    fc.appendChild(btn);
    hintPanel.appendChild(fc);
    showDock(f);
    // While a hint is on screen, the big button changes job: pressing it places
    // this number and moves on. Name what the button does (the app places it),
    // not "write it in", which is the instruction given to the user elsewhere.
    hintBtn.textContent = 'Place it and find the next number';
    updateHintEmpty();
    announce(`Hint: ${f.title}. ${f.caption || ''}`);
    // With the dock on screen (phones) the board stays in view: the dock
    // carries the headline and the marks are the explanation. Only scroll
    // to the prose card where there is no dock.
    if (getComputedStyle(dock).display === 'none') {
      fc.scrollIntoView({ behavior: prefersReducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
    }
  }

  /** Card for a solver step: one-line caption, full text behind a <details>. */
  function stepCard(kind, title, step, badge) {
    const el = card(kind, title, step.caption ? [step.caption] : [], badge);
    if (step.explanation && step.explanation.length) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'Read the full logic';
      det.appendChild(sum);
      for (const p of step.explanation) {
        const pe = document.createElement('p');
        if (p.startsWith('• ')) { pe.className = 'bullet'; pe.textContent = p.slice(2); }
        else pe.textContent = p;
        det.appendChild(pe);
      }
      el.appendChild(det);
    }
    return el;
  }

  function card(kind, title, paragraphs, badge) {
    const el = document.createElement('div');
    el.className = 'hint-card ' + kind;
    if (badge) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = badge;
      el.appendChild(b);
    }
    const h = document.createElement('h3');
    h.textContent = title;
    el.appendChild(h);
    for (const p of paragraphs) {
      const pe = document.createElement('p');
      if (p.startsWith('• ')) { pe.className = 'bullet'; pe.textContent = p.slice(2); }
      else pe.textContent = p;
      el.appendChild(pe);
    }
    return el;
  }

  render();
})();
