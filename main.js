/**
 * main.js — Orchestration Entry Point
 * Wires chess.js + WorkerHelper + MAIA + BBI pipeline + UI together.
 */

(async function () {
  // Declare shared state FIRST — before UI.init() registers callbacks
  // (avoids Temporal Dead Zone errors if a move fires before await resolves)
  let modelLoaded = false;
  let queuedFen = null;
  let currentFen = null;
  let isImporting = false;

  // -------------------------------------------------------------------------
  // Instantiate core objects
  // -------------------------------------------------------------------------
  const chess = new Chess();
  const workerHelper = new BBI.WorkerHelper();
  const analyzer = new BBI.AnalyzerQueue(workerHelper);

  analyzer.onQueueChange = (count) => {
    const el = document.getElementById('queue-counter');
    if (el) {
      if (count > 0) {
        el.textContent = `(${count} pending)`;
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  };

  // Seeding of startpos.json removed to ensure evaluation sync and engine consistency.

  // -------------------------------------------------------------------------
  // Initialize chessboard UI
  // -------------------------------------------------------------------------
  UI.init(chess, async (fen, move) => {
    try {
      await analyzeAndUpdateUI(fen, move);
    } catch (e) {
      if (e.message !== 'Interrupted') console.error('UI Pipeline error:', e);
    }
  });
  UI.updateStatus();

  // -------------------------------------------------------------------------
  // Load Maia model & Explorer DB
  // -------------------------------------------------------------------------
  const modelStatus = document.getElementById('model-status');
  modelStatus.textContent = 'Loading Engine & DB…';
  modelStatus.className = 'model-status loading';

  // Load DB first (it's large, start it early)
  const dbPromise = MAIA.loadExplorerDB('./models/explorer_db.json');

  await MAIA.loadModel('./models/maia_rapid.onnx').then(async ok => {
    modelLoaded = ok;
    const statusEl = document.getElementById('model-status');
    if (ok) {
      await dbPromise; // Ensure DB is also tried
      statusEl.textContent = 'Maia Rapid ✓';
      statusEl.className = 'model-status ok';
      if (queuedFen) {
        await analyzeAndUpdateUI(queuedFen, null);
        queuedFen = null;
      } else {
        // Auto-calculate the initial position on load
        await analyzeAndUpdateUI(chess.fen(), null);
      }
    } else {
      statusEl.textContent = 'Maia model not found — place maia_rapid.onnx in ./models/';
      statusEl.className = 'model-status error';
      UI.showToast('Maia model not found. Place maia_rapid.onnx in ./models/ and reload.', 'error');
    }

    // Hide initial fullscreen loader once everything is ready
    const loader = document.getElementById('app-loader');
    if (loader) {
      loader.classList.add('hidden');
      setTimeout(() => loader.remove(), 500); // cleanup from DOM
    }

    updateTrashUI();
  });

  // -------------------------------------------------------------------------
  // DOM event listeners
  // -------------------------------------------------------------------------
  document.getElementById('btn-flip').addEventListener('click', () => { UI.flipBoard(); updateLineAvgBBI(); });
  document.getElementById('btn-reset').addEventListener('click', () => { UI.resetBoard(); UI.clearBlunderOverlay(); });
  document.getElementById('btn-undo').addEventListener('click', () => UI.undoMove());
  document.getElementById('btn-next').addEventListener('click', () => UI.nextMove());
  document.getElementById('btn-recalculate').addEventListener('click', async () => {
    const dScale = parseInt(document.getElementById('depth-slider').value, 10);
    const sScale = parseFloat(document.getElementById('see-slider').value);
    const cacheKey = BBI.getCacheKey(chess.fen(), dScale, sScale);
    await BBI.Cache.remove(cacheKey);
    await analyzeAndUpdateUI(chess.fen(), null);
    UI.showToast('Position cache cleared and re-calculated.', 'success');
  });
  document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    isImporting = false;
    analyzer.clearAll();

    const progContainer = document.getElementById('pgn-progress-container');
    if (progContainer) progContainer.classList.add('hidden');

    await BBI.Cache.clear();
    UI.resetBoard();
    UI.clearBlunderOverlay();
    UI.showToast('Memory cleared and analysis stopped.', 'success');
    updateTrashUI();
  });

  document.getElementById('btn-set-fen').addEventListener('click', () => {
    const fen = document.getElementById('fen-input').value.trim();
    UI.loadFEN(fen);
  });

  document.getElementById('fen-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-set-fen').click();
  });

  // Depth slider
  const depthSlider = document.getElementById('depth-slider');
  const depthLabel = document.getElementById('depth-label');

  // Load depth from localStorage
  const savedDepth = localStorage.getItem('bbi_depth');
  if (savedDepth) {
    depthSlider.value = savedDepth;
    depthLabel.textContent = savedDepth;
  }

  depthSlider.addEventListener('input', () => {
    depthLabel.textContent = depthSlider.value;
  });
  depthSlider.addEventListener('change', () => {
    localStorage.setItem('bbi_depth', depthSlider.value);
  });

  // SEE threshold slider
  const seeSlider = document.getElementById('see-slider');
  const seeLabel = document.getElementById('see-label');

  // Load pruning from localStorage
  const savedSee = localStorage.getItem('bbi_see');
  if (savedSee) {
    seeSlider.value = savedSee;
    const val = parseFloat(savedSee);
    if (val <= -5.6) {
      seeLabel.textContent = 'Off';
    } else {
      seeLabel.textContent = (val >= 0 ? '+' : '') + val;
    }
  }

  seeSlider.addEventListener('input', () => {
    const val = parseFloat(seeSlider.value);
    if (val <= -5.6) {
      seeLabel.textContent = 'Off';
    } else {
      seeLabel.textContent = (val >= 0 ? '+' : '') + val;
    }
  });
  seeSlider.addEventListener('change', () => {
    localStorage.setItem('bbi_see', seeSlider.value);
  });

  // Player Perspective Mode toggle
  const oneSidedToggle = document.getElementById('toggle-onesided');
  if (oneSidedToggle) {
    const applyToggle = () => {
      const wrapper = document.querySelector('.board-wrapper');
      if (wrapper) wrapper.classList.toggle('one-sided', oneSidedToggle.checked);
      updateLineAvgBBI();
    };
    oneSidedToggle.addEventListener('change', applyToggle);
    applyToggle();
  }

  // -------------------------------------------------------------------------
  // Line Average BBI System
  // -------------------------------------------------------------------------
  async function updateLineAvgBBI() {
    const depth = parseInt(document.getElementById('depth-slider').value, 10);
    const seeThreshold = parseFloat(document.getElementById('see-slider').value);
    
    // Evaluate path
    const clone = new Chess();
    clone.load_pgn(chess.pgn());
    
    const fensToExamine = [clone.fen()];
    while (clone.undo()) {
      fensToExamine.unshift(clone.fen());
    }

    let activeFens = fensToExamine;
    const isOneSided = document.getElementById('toggle-onesided').checked;
    const isFlipped = document.getElementById('board').classList.contains('flipped');
    
    if (isOneSided) {
      const targetTurn = isFlipped ? 'w' : 'b'; 
      activeFens = activeFens.filter(fen => fen.split(' ')[1] === targetTurn);
    }

    let totalLoss = 0;
    let count = 0;
    for (const fen of activeFens) {
      const key = BBI.getCacheKey(fen, depth, seeThreshold);
      const cached = await BBI.Cache.get(key);
      if (cached && typeof cached.delta === 'number') {
         // Skip fatal anomalies that skew blunderability index massively
         if (cached.grade !== 'F' && cached.grade !== '💀' && cached.grade !== '☠️') {
           totalLoss += cached.delta; // Cache strictly stores human loss as + absolute delta pawns
           count++;
         }
      }
    }

    const lineValEl = document.getElementById('line-avg-eval');
    if (!lineValEl) return;
    
    if (count === 0) {
      lineValEl.textContent = '—';
      lineValEl.className = 'metric-value';
      return;
    }

    const avg = totalLoss / count;

    let gradeStr = 'D';
    let rankClass = 'eval-D';

    if (avg >= 15.0) { gradeStr = 'SS'; rankClass = 'eval-SS'; }
    else if (avg >= 9.0) {
      if (avg >= 12.0) gradeStr = 'S+';
      else gradeStr = 'S';
      rankClass = 'eval-S';
    }
    else if (avg >= 5.0) {
      if (avg >= 7.5) gradeStr = 'A+';
      else if (avg >= 6.0) gradeStr = 'A';
      else gradeStr = 'A-';
      rankClass = 'eval-A';
    }
    else if (avg >= 3.0) {
      if (avg >= 4.3) gradeStr = 'B+';
      else if (avg >= 3.6) gradeStr = 'B';
      else gradeStr = 'B-';
      rankClass = 'eval-B';
    }
    else if (avg >= 1.5) {
      if (avg >= 2.5) gradeStr = 'C+';
      else if (avg >= 2.0) gradeStr = 'C';
      else gradeStr = 'C-';
      rankClass = 'eval-C';
    }
    else {
      if (avg >= 1.0) gradeStr = 'D+';
      else gradeStr = 'D';
      rankClass = 'eval-D';
    }

    lineValEl.innerHTML = `<span style="font-size:1.8rem; letter-spacing:-0.05em;">${gradeStr}</span> <span style="font-size:0.8rem; font-weight:normal; color:#8b949e; margin-left:4px;">(↓${avg.toFixed(2)})</span>`;
    lineValEl.className = 'metric-value ' + rankClass;
  }

  // -------------------------------------------------------------------------
  // PGN Import & Game Review
  // -------------------------------------------------------------------------
  async function importPGN() {
    if (isImporting) {
      UI.showToast('Another import is already in progress.', 'warning');
      return;
    }

    const pgnEl = document.getElementById('pgn-input');
    const pgn = pgnEl.value.trim();
    if (!pgn) return;

    const tempChess = new Chess();
    if (!tempChess.load_pgn(pgn)) {
      UI.showToast('Invalid PGN format.', 'error');
      return;
    }

    const history = tempChess.history({ verbose: true });

    // UI Progress Setup
    const progContainer = document.getElementById('pgn-progress-container');
    const progFill = document.getElementById('pgn-progress-fill');
    const progText = document.getElementById('pgn-progress-text');
    const stopBtn = document.getElementById('btn-stop-import');

    progContainer.classList.remove('hidden');
    if (stopBtn) stopBtn.classList.remove('hidden');
    progFill.style.width = '0%';
    const progSpan = progText.querySelector('span');
    progSpan.textContent = `Setup...`;

    try {
      // Reset board to the PGN's starting position
      const pgnHeader = tempChess.header();
      const startFen = pgnHeader.FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

      UI.showToast(`Analyzing ${history.length} moves...`, 'info');

      // UI.loadFEN updates visual board and global chess state.
      // We load it silently so it doesn't trigger its own non-silent pipeline which would abort our import.
      const ok = UI.loadFEN(startFen, true);
      if (!ok) throw new Error("Failed to load starting FEN");

      // CRITICAL: Update currentFen so that the first move's retroactive evaluation 
      // correctly targets the starting position.
      currentFen = startFen;
      isImporting = true;

      // Hydrate the initial starting position so its cache entry exists for the loop.
      await analyzeAndUpdateUI(startFen, null);

      // Use a fresh chess instance to step through
      const walkChess = new Chess(startFen);

      let loopPrevFen = startFen;

      // 2. Loop through moves
      for (let i = 0; i < history.length; i++) {
        if (!isImporting) throw new Error('Cancelled');

        const move = history[i];
        walkChess.move(move);

        // Hydrate silently with sub-move progress using CURRENT slider depth
        const targetDepth = parseInt(document.getElementById('depth-slider').value, 10);
        const targetSee = parseFloat(document.getElementById('see-slider').value);

        // Ensure "Next Move" navigation flows correctly
        const prevKey = BBI.getCacheKey(loopPrevFen, targetDepth, targetSee);
        let prevCache = await BBI.Cache.get(prevKey);
        let needsAnalysis = true;
        const uci = move.from + move.to + (move.promotion || '');

        if (prevCache) {
          // Check if this position is already perfectly cached
          const currentKey = BBI.getCacheKey(walkChess.fen(), targetDepth, targetSee);
          const cachedCurrent = await BBI.Cache.get(currentKey);

          if (cachedCurrent && cachedCurrent.moveTable && cachedCurrent.moveTable.length > 0) {
            needsAnalysis = false;
            prevCache.lastNavigatedUci = uci; // Apply navigation link immediately since it's cached
            
            // Apply retroactive grade instantly
            let mMatch = prevCache.moveTable.find(m => m.uci === uci);
            if (mMatch) mMatch.futureGrade = cachedCurrent.grade;
            
            await BBI.Cache.set(prevKey, prevCache);
          }
        }

        if (needsAnalysis) {
          let retries = 3;
          while (retries > 0 && isImporting) {
            try {
              await analyzer.analyze({
                fen: walkChess.fen(),
                depth: targetDepth,
                seeThreshold: targetSee,
                priority: false, // Background processing
                executedMove: move,
                prevFen: loopPrevFen,
                onProgress: (pct) => {
                  const currentCount = i + 1;
                  const totalCount = history.length;
                  const subPct = Math.floor(pct * 99).toString().padStart(2, '0');
                  progSpan.textContent = `${currentCount}.${subPct} / ${totalCount}`;

                  // Smooth out the main bar: current base + sub-progress
                  const totalPct = ((i + pct) / totalCount) * 100;
                  progFill.style.width = `${totalPct}%`;
                }
              });
              break; // Success
            } catch (e) {
              // If interrupted by a foreground move, wait and retry this position
              if (e.message === 'Interrupted' && isImporting) {
                retries--;
                await new Promise(r => setTimeout(r, 1000)); // Wait for the user's move to finish
                continue;
              }
              throw e;
            }
          }

          // Link the navigation string NOW that analysis successfully completed
          let updatedPrev = await BBI.Cache.get(prevKey);
          if (updatedPrev) {
            updatedPrev.lastNavigatedUci = uci;
            await BBI.Cache.set(prevKey, updatedPrev);
          }
          
          // Give the browser a moment to breathe/render/commit transactions
          await new Promise(r => setTimeout(r, 500));
        } else {
          // Micro-breather for incredibly fast cached imports so UI doesn't freeze completely
          await new Promise(r => setTimeout(r, 10));
        }

        loopPrevFen = walkChess.fen();

        // Dynamically refresh the currently viewed board on every background move processed
        const cacheKey = BBI.getCacheKey(currentFen, targetDepth, targetSee);
        const cached = await BBI.Cache.get(cacheKey);
        if (cached) {
          renderBBIResult(cached, currentFen.split(' ')[1]);
          await updateLineAvgBBI();
        }

        // final tick for this move AFTER the safety delay
        progSpan.textContent = `${i + 1}.00 / ${history.length}`;
        progFill.style.width = `${((i + 1) / history.length) * 100}%`;

        // Allow navigation to this move immediately as it's analyzed
        UI.updateStatus();
      }

      UI.showToast('Analysis complete!', 'success');

      // Refresh the UI for the starting position to show hydrated grades/badges
      await analyzeAndUpdateUI(chess.fen(), null);
    } catch (err) {
      if (err.message !== 'Cancelled' && err.message !== 'Interrupted') {
        console.error('[PGN Import] Crashed:', err);
        UI.showToast('Import interrupted by an error.', 'error');
      }
    } finally {
      isImporting = false;
      const stopBtn = document.getElementById('btn-stop-import');
      if (stopBtn) stopBtn.classList.add('hidden');
      setTimeout(() => progContainer.classList.add('hidden'), 2000);
      updateTrashUI();
    }
  }

  document.getElementById('btn-import-pgn').addEventListener('click', importPGN);
  document.getElementById('btn-stop-import').addEventListener('click', () => {
    isImporting = false;
    analyzer.clearBackgroundTasks();
    const progContainer = document.getElementById('pgn-progress-container');
    if (progContainer) progContainer.classList.add('hidden');
    UI.showToast('Import cancelled.', 'warning');
  });

  // -------------------------------------------------------------------------
  // Pipeline orchestration
  // -------------------------------------------------------------------------

  let analyzeDebounceTimer = null;

  async function analyzeAndUpdateUI(fen, executedMove, prevFenOverride = null) {
    UI.clearBestMoveArrow();
    UI.clearScorePanel();
    UI.clearBlunderOverlay();

    const prevFen = prevFenOverride || currentFen;
    const targetFen = fen || chess.fen();
    currentFen = targetFen;
    document.getElementById('fen-input').value = currentFen;

    if (!modelLoaded) return;

    UI.showLoading(true, 'Evaluating position...', 0);

    // Immediate Navigation Tracking
    if (executedMove && prevFen) {
      const dScale = parseInt(document.getElementById('depth-slider').value, 10);
      const sScale = parseFloat(document.getElementById('see-slider').value);
      const prevKey = BBI.getCacheKey(prevFen, dScale, sScale);
      let prevCache = await BBI.Cache.get(prevKey);

      if (!prevCache) {
        prevCache = {
          fen: prevFen,
          moveTable: [],
          grade: '-',
          depth: dScale,
          timestamp: Date.now()
        };
      }

      // Proactively clear priority-true foreground navigation from polluting background pipeline map
      if (!isImporting) {
        const uci = executedMove.from + executedMove.to + (executedMove.promotion || '');
        prevCache.lastNavigatedUci = uci;
        await BBI.Cache.set(prevKey, prevCache);
      }

      const currentViewKey = BBI.getCacheKey(currentFen, dScale, sScale);
      if (prevKey === currentViewKey) {
        UI.updateStatus();
      }
    }

    // --- Instant Cache Check ---
    // If we already have a full analysis result, render it immediately
    // without launching a priority pipeline (which would interrupt background work)
    const depth = parseInt(document.getElementById('depth-slider').value, 10);
    const seeThreshold = parseFloat(document.getElementById('see-slider').value);
    const instantKey = BBI.getCacheKey(targetFen, depth, seeThreshold);
    const instantCached = await BBI.Cache.get(instantKey);

    if (instantCached && instantCached.moveTable && instantCached.moveTable.length > 0) {
      renderBBIResult(instantCached, chess.turn());
      await updateLineAvgBBI();
      UI.showLoading(false);
      updateTrashUI();
      return;
    }

    // --- Debounced Pipeline Launch ---
    // When rapidly navigating uncached positions, wait for the user to settle
    // before launching heavy analysis (prevents cascading priority interrupts)
    if (analyzeDebounceTimer) clearTimeout(analyzeDebounceTimer);

    return new Promise((resolve, reject) => {
      analyzeDebounceTimer = setTimeout(async () => {
        // Re-verify this is still the position the user is viewing
        if (currentFen !== targetFen) {
          UI.showLoading(false);
          resolve();
          return;
        }

        try {
          const result = await analyzer.analyze({
            fen: targetFen,
            depth,
            seeThreshold,
            priority: true, // Foreground UI interaction has highest priority
            executedMove,
            prevFen,
            onProgress: (pct) => UI.updateProgress(pct)
          });

          renderBBIResult(result, chess.turn());
          await updateLineAvgBBI();
          resolve(result);
        } catch (e) {
          if (e.message !== 'Interrupted') console.error('Pipeline error:', e);
          reject(e);
        } finally {
          UI.showLoading(false);
          updateTrashUI();
        }
      }, 150);
    });
  }

  function renderBBIResult(result, currentTurn) {
    if (!result) return;
    
    UI.updateScorePanel(result);
    UI.updateMoveHeatmap(result.moveTable, result.source);
    UI.renderBlunderOverlay(result.moveTable, result.objectiveEval);
    UI.renderBestMoveArrow(result.bestmove);

    const side = (currentTurn || result.fen.split(' ')[1]) === 'w' ? 'White' : 'Black';
    const interpEl = document.getElementById('delta-interp');

    if (result.grade === 'SS') {
      interpEl.innerHTML = `☠️ <strong>${side} is facing a lethal trap!</strong>`;
      interpEl.className = 'interp high';
    } else if (result.grade === 'S') {
      const unpruned = result.moveTable.filter(m => !m.isPruned);
      if (unpruned.length === 1 && result.moveTable.length === 1) {
        interpEl.innerHTML = `🎯 <strong>${side} has a forced move — no alternative options</strong>`;
      } else if (unpruned.length === 1) {
        interpEl.innerHTML = `🎯 <strong>${side} has a strategic 'only move'</strong>`;
      } else {
        interpEl.innerHTML = `🔥 <strong>${side} is in severe danger</strong>`;
      }
      interpEl.className = 'interp high';
    } else if (result.grade === 'A') {
      interpEl.innerHTML = `⚠️ <strong>${side} is in a minefield</strong>`;
      interpEl.className = 'interp high';
    } else if (result.grade === 'B') {
      interpEl.innerHTML = `⚡ <strong>${side} is in a tense position</strong>`;
      interpEl.className = 'interp medium';
    } else if (result.grade === 'C') {
      interpEl.innerHTML = `🛡️ <strong>${side} is not likely to blunder</strong>`;
      interpEl.className = 'interp low';
    } else if (result.grade === 'D') {
      interpEl.innerHTML = `✅ <strong>${side} has plenty of safe options</strong>`;
      interpEl.className = 'interp neutral';
    } else if (result.grade === 'F') {
      const otherSide = side === 'White' ? 'Black' : 'White';
      if (result.expectedEval >= 5.0) {
        interpEl.innerHTML = `🎉 <strong>${side} is starting or continuing a crushing attack</strong>`;
      } else if (result.expectedEval <= -5.0) {
        interpEl.innerHTML = `📉 <strong>${otherSide} is mounting a crushing attack against ${side}</strong>`;
      } else {
        interpEl.innerHTML = `🛡️ <strong>Stable — Human play is engine-aligned</strong>`;
      }
      interpEl.className = 'interp neutral';
    } else if (result.grade === '💀' || result.grade === '☠️') {
      interpEl.innerHTML = `💀 <strong>${side} has been checkmated</strong>`;
      interpEl.className = 'interp neutral';
    }
  }

  async function updateTrashUI() {
    const btn = document.getElementById('btn-clear-cache');
    if (!btn) return;

    try {
      const count = await BBI.Cache.count();
      btn.title = `Clear ${count} analyzed positions from local storage`;

      if (count <= 1) {
        btn.classList.add('btn-inactive');
      } else {
        btn.classList.remove('btn-inactive');
      }
    } catch (e) {
      console.error('[Trash UI] Failed to update:', e);
    }
  }

  window._bbidebug = { chess, workerHelper, analyzer };
})();
