/**
 * ui.js — Chessboard.js bindings + display updates
 */

const UI = (() => {
  let chess = null;
  let board = null;
  let onMoveCallback = null;
  let isFlipped = false; // tracks board orientation for overlay positioning

  // -------------------------------------------------------------------------
  // Board initialization
  // -------------------------------------------------------------------------
  function init(chessInstance, moveCallback) {
    chess = chessInstance;
    onMoveCallback = moveCallback;

    const cfg = {
      draggable: true,
      position: 'start',
      pieceTheme: 'img/chesspieces/wikipedia/{piece}.png',
      onDragStart,
      onDrop,
      onSnapEnd,
    };

    board = Chessboard('board', cfg);
    window.addEventListener('resize', () => board.resize());
  }

  function onDragStart(source, piece) {
    // Only allow the side to move to pick up pieces
    if (chess.game_over()) return false;
    if (chess.turn() === 'w' && piece.startsWith('b')) return false;
    if (chess.turn() === 'b' && piece.startsWith('w')) return false;
  }

  function onDrop(source, target) {
    // Attempt move (try queen promotion by default)
    const move = chess.move({ from: source, to: target, promotion: 'q' });
    if (!move) return 'snapback';

    updateStatus();
    if (onMoveCallback) onMoveCallback(chess.fen(), move);
  }

  function onSnapEnd() {
    board.position(chess.fen());
  }

  // -------------------------------------------------------------------------
  // External controls
  // -------------------------------------------------------------------------
  let lastMoveTable = null;
  let lastObjectiveEval = null;
  let lastBestMove = null;

  function flipBoard() {
    isFlipped = !isFlipped;
    board.flip();
    document.getElementById('board').classList.toggle('flipped', isFlipped);
    if (lastMoveTable) renderBlunderOverlay(lastMoveTable, lastObjectiveEval);
    if (lastBestMove) renderBestMoveArrow(lastBestMove);
  }

  function resetBoard() {
    chess.reset();
    board.start();
    clearScorePanel();
    clearBestMoveArrow();
    updateStatus();
    if (onMoveCallback) onMoveCallback(chess.fen(), null);
  }

  function loadFEN(fen, silent = false) {
    const ok = chess.load(fen);
    if (!ok) { showToast('Invalid FEN — please check your input.', 'error'); return false; }
    board.position(fen);
    updateStatus();
    if (!silent && onMoveCallback) onMoveCallback(fen, null);
    return true;
  }

  function undoMove() {
    const move = chess.undo();
    if (!move) {
      showToast('No previous moves to undo.', 'info');
      return;
    }
    board.position(chess.fen());
    clearBestMoveArrow();
    updateStatus();
    if (onMoveCallback) onMoveCallback(chess.fen(), null);
  }

  // -------------------------------------------------------------------------
  // Score panel display
  // -------------------------------------------------------------------------
  function showLoading(active, text = 'Calculating...', pct = 0) {
    document.getElementById('loading-indicator').classList.toggle('hidden', !active);
    document.getElementById('score-panel').classList.toggle('dimmed', active);

    const wrapper = document.querySelector('.board-wrapper');
    if (wrapper) wrapper.classList.toggle('is-evaluating', active);

    if (active) updateProgress(pct, text);
  }

  function updateProgress(pct, text = null) {
    const fill = document.getElementById('progress-fill');
    const label = document.getElementById('progress-text');
    if (fill) fill.style.width = `${pct * 100}%`;
    if (label) {
      if (text) label.textContent = text;
      else label.textContent = pct === 1 ? 'Complete' : `Calculating... (${Math.round(pct * 100)}%)`;
    }
  }

  function updateScorePanel({ objectiveEval, expectedEval, delta, grade, isForcedMate, scoreMate }) {
    const turn = chess.turn();
    const fmtAdv = v => {
      if (isNaN(v)) return '---';
      if (Math.abs(v) < 0.001) return '=0.00';
      return (v >= 0 ? '↑' : '↓') + Math.abs(v).toFixed(2);
    };
    const fmtDelta = v => {
      if (isNaN(v)) return '---';
      return (v < 0 ? '-' : '') + Math.abs(v).toFixed(2);
    };

    // Standard engine notation for Objective Eval: + for White, - for Black
    // Standard engine notation for Objective Eval: White-is-Positive ALWAYS
    const absObj = objectiveEval;
    // scoreMate is also White-relative internally now
    const absMate = scoreMate || 0;

    let objValText;
    if (isForcedMate && scoreMate !== undefined && scoreMate !== null) {
      const sign = absMate > 0 ? '+' : (absMate < 0 ? '-' : '');
      objValText = sign + 'M' + Math.abs(absMate);
    } else {
      if (isNaN(absObj)) {
        objValText = '---';
      } else {
        const objSign = absObj > 0 ? '+' : (absObj < 0 ? '-' : '');
        objValText = objSign + Math.abs(absObj).toFixed(2);
      }
    }

    const objEl = document.getElementById('obj-eval');
    objEl.textContent = objValText;
    
    // Manage advantage styling (side-neutral White vs Black)
    const objCard = objEl.parentElement;
    objCard.classList.add('metric-card-purple');
    
    objEl.classList.remove('text-white', 'text-black');
    if (absObj > 0.01)      objEl.classList.add('text-white');
    else if (absObj < -0.01) objEl.classList.add('text-black');

    // Avg Human Delta is the negative of the calculated loss.
    // e.g. If human loses 0.37 pawns, delta is +0.37. Avg Human Delta = -0.37.
    const avgDelta = -(delta || 0);
    const expEl = document.getElementById('exp-eval');
    
    if (isNaN(avgDelta)) {
      expEl.textContent = '---';
      expEl.className = 'metric-value';
    } else {
      expEl.textContent = (Math.abs(avgDelta) < 0.001 ? '=0.00' : (avgDelta >= 0 ? '↑' : '↓') + Math.abs(avgDelta).toFixed(2));
      expEl.className = 'metric-value ' + (avgDelta <= -0.05 ? 'eval-neg' : 'eval-neutral');
    }

    const gradeEl = document.getElementById('grade-badge');
    gradeEl.innerHTML = `<span class="grade-badge-letter">${grade}</span><span class="grade-badge-suffix">Rank</span>`;
    gradeEl.className = `grade-badge grade-${grade}`;
  }

  function clearScorePanel() {
    ['obj-eval', 'exp-eval', 'line-avg-eval'].forEach(id => {
      const el = document.getElementById(id);
      el.textContent = '—';
      if (id === 'obj-eval') {
        el.parentElement.classList.remove('metric-card-purple');
        el.classList.remove('text-white', 'text-black');
      }
    });
    const g = document.getElementById('grade-badge');
    g.textContent = '—';
    g.className = 'grade-badge';
  }

  // -------------------------------------------------------------------------
  // Move heatmap
  // -------------------------------------------------------------------------
  function updateMoveHeatmap(moveTable, source) {
    const indicator = document.getElementById('source-indicator');
    if (indicator) {
      indicator.textContent = source || 'Maia Rapid';
      let sourceKey = (source || 'Maia').split(' ')[0].toLowerCase();
      if (sourceKey === "lumbra's") sourceKey = 'lumbra';
      indicator.className = 'source-indicator source-' + sourceKey;
    }

    const tbody = document.getElementById('move-table-body');
    tbody.innerHTML = '';

    moveTable.forEach((row, i) => {
      const pct = (row.prob * 100).toFixed(1);

      // Hide moves that round to 0.0% (too obscure for humans)
      if (pct === '0.0') return;

      const tr = document.createElement('tr');
      if (row.isPruned) tr.classList.add('pruned-move');
      
      const evalVal = row.relativeDelta;
      const evDelta = (Math.abs(evalVal) < 0.001) ? '=0.00' : (evalVal >= 0 ? '↑' : '↓') + Math.abs(evalVal).toFixed(2);
      
      const heat = probToHeat(row.prob);
      tr.innerHTML = `
        <td class="rank">${i + 1}</td>
        <td class="move-san">${row.san}</td>
        <td class="prob-bar-cell">
          <div class="prob-bar" style="width:${pct}%; background:${heat}"></div>
          <span class="prob-label">${pct}%</span>
        </td>
        <td class="eval-cell ${evalVal >= -0.005 ? 'neutral' : 'neg'}">${evDelta}</td>
      `;

      tr.addEventListener('mouseenter', () => showSingleMoveGhost(row));
      tr.addEventListener('mouseleave', () => hideSingleMoveGhost());

      tbody.appendChild(tr);
    });
  }

  function probToHeat(prob) {
    // 0 → cold blue, 1 → hot red via HSL
    const h = 220 - Math.round(prob * 220); // 220=blue, 0=red
    return `hsl(${h}, 80%, 55%)`;
  }

  // -------------------------------------------------------------------------
  // Status line & toast
  // -------------------------------------------------------------------------
  function updateStatus() {
    const statusEl = document.getElementById('status-line');
    const historyLen = chess.history().length;
    const moveNum = Math.floor(historyLen / 2) + 1;
    const prefix = chess.turn() === 'w' ? `${moveNum}.` : `${moveNum}...`;

    if (chess.in_checkmate()) {
      statusEl.textContent = `${prefix} Checkmate! ${chess.turn() === 'w' ? 'Black' : 'White'} wins.`;
    } else if (chess.in_draw()) {
      statusEl.textContent = `${prefix} Draw!`;
    } else {
      const t = chess.turn() === 'w' ? 'White' : 'Black';
      statusEl.textContent = `${prefix} ${t} to move${chess.in_check() ? ' • Check!' : ''}`;
    }

    // Add turn class to board-wrapper for perspective styling (Player Perspective mode)
    const wrapper = document.querySelector('.board-wrapper');
    if (wrapper) {
      wrapper.classList.remove('turn-w', 'turn-b');
      wrapper.classList.add(`turn-${chess.turn()}`);
    }

    updateNavButtons();
  }

  async function updateNavButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const nextBtn = document.getElementById('btn-next');
    const resetBtn = document.getElementById('btn-reset');
    
    // Undo: disabled if no history
    if (undoBtn) {
      undoBtn.classList.toggle('btn-disabled', chess.history().length === 0);
    }

    // Reset: smoky and non-clickable if already at start FEN
    if (resetBtn) {
      const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      resetBtn.classList.toggle('btn-inactive', chess.fen() === startFen);
    }
    
    // Next: disabled if no cached navigation path
    if (nextBtn) {
      const depth = parseInt(document.getElementById('depth-slider').value, 10);
      const seeThreshold = parseFloat(document.getElementById('see-slider').value);
      const cacheKey = BBI.getCacheKey(chess.fen(), depth, seeThreshold);
      const cached = await BBI.Cache.get(cacheKey);
      nextBtn.classList.toggle('btn-disabled', !(cached && cached.lastNavigatedUci));
    }
  }

  function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = `toast toast-${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Blunder Overlay
  // -------------------------------------------------------------------------
  function renderBlunderOverlay(moveTable, objectiveEval) {
    lastMoveTable = moveTable;
    lastObjectiveEval = objectiveEval;
    clearBlunderOverlay(true);
    const container = document.getElementById('blunder-overlay');
    if (!container) return;
    if (!moveTable || moveTable.length === 0) return;

    // Blunderbait weight: balances how likely humans play a move AND how punishing it is.
    // Minimum 5% Maia probability so fringe lines don't crowd out realistic blunders,
    // and strictly require at least 1.5 pawns dropped to qualify as an explosive 'trap'.
    const allBlunders = [...moveTable]
      .filter(m => m.prob >= 0.05 && m.cpLoss >= 1.5)
      .map(m => ({ ...m, weight: m.prob * 2 + m.cpLoss }))
      .sort((a, b) => b.weight - a.weight);

    // Group all rendering needs by destination square
    const renderSq = {}; // sq -> { blunders: [], grade: null, bestMove: m }

    // 1. Map blunders
    allBlunders.forEach(m => {
      const sq = m.to || m.uci.slice(2, 4);
      if (!renderSq[sq]) renderSq[sq] = { blunders: [], grade: null, bestMove: m };
      renderSq[sq].blunders.push(m);
    });

    // 2. Map cached future grades that were retroactively added to moveTable
    for (const m of moveTable) {
      if (m.futureGrade) {
        const sq = m.to || m.uci.slice(2, 4);
        if (!renderSq[sq]) renderSq[sq] = { blunders: [], grade: null, bestMove: m };
        if (!renderSq[sq].grade) renderSq[sq].grade = m.futureGrade;
      }
    }

    const isFlipped = document.getElementById('board').classList.contains('flipped');

    Object.entries(renderSq).forEach(([sq, data]) => {
      _renderSquareGhosts(container, sq, data, isFlipped);
    });
  }

  /**
   * Private helper to render ghost pieces and badges on a specific square.
   * Shared between the full blunder overlay and the single-move hover ghost.
   */
  function _renderSquareGhosts(container, sq, data, isFlipped) {
    const file = sq.charCodeAt(0) - 97; // a=0 … h=7
    const rank = parseInt(sq[1]) - 1;   // 1=0 … 8=7

    const leftPct = isFlipped ? (7 - file) * 12.5 : file * 12.5;
    const topPct = isFlipped ? rank * 12.5 : (7 - rank) * 12.5;

    const marker = document.createElement('div');
    marker.className = 'blunder-marker';
    if (data.blunders.length > 0) marker.classList.add('has-blunders');
    if (data.grade) marker.classList.add('has-future-grade');
    marker.style.cssText = `left:${leftPct}%; top:${topPct}%; width:12.5%; height:12.5%; position:absolute;`;

    if (data.blunders.length > 0) {
      // Draw all ghost pieces (max 4 per square to prevent overflow)
      const group = data.blunders.slice(0, 4);
      group.forEach((m, idx) => {
        const imgFile = (m.color === 'w' ? 'w' : 'b') + m.piece.toUpperCase();
        const img = document.createElement('img');
        img.src = `img/chesspieces/wikipedia/${imgFile}.png`;
        img.className = `blunder-piece count-${group.length} idx-${idx}`;
        marker.appendChild(img);
      });

      // Explosion badge (bottom-center)
      const badge = document.createElement('div');
      const avgDelta = group.reduce((sum, m) => sum + m.relativeDelta, 0) / group.length;

      // Determine if this is an "improving" move or a "blunder" for styling
      const isImproving = avgDelta > 0.05;
      badge.className = 'blunder-badge' + (isImproving ? ' improving' : '');

      let evalTxt = (Math.abs(avgDelta) < 0.001) ? '=0' : (avgDelta >= 0 ? '↑' : '↓') + Math.abs(avgDelta).toFixed(1).replace(/\.0$/, '');
      
      const emoji = isImproving ? '' : '<span class="blunder-emoji">💥</span>';
      badge.innerHTML = `${emoji}<span class="blunder-cp">${evalTxt}</span>`;
      marker.appendChild(badge);

    } else if (data.bestMove) {
      // Draw ONE non-explosive ghost piece if it's cached but NOT a blunder
      const m = data.bestMove;
      const imgFile = (m.color === 'w' ? 'w' : 'b') + m.piece.toUpperCase();
      const img = document.createElement('img');
      img.src = `img/chesspieces/wikipedia/${imgFile}.png`;
      img.className = `blunder-piece count-1 idx-0 ${data.grade ? 'dim' : ''}`;
      marker.appendChild(img);

      // Add badge for single-move hover if not just a cached grade piece
      if (!data.grade || data.isHover) {
        const badge = document.createElement('div');
        const isImproving = m.relativeDelta > 0.05;
        badge.className = 'blunder-badge' + (isImproving ? ' improving' : '');
        const evalText = (Math.abs(m.relativeDelta) < 0.001) ? '=0.00' : (m.relativeDelta >= 0 ? '↑' : '↓') + Math.abs(m.relativeDelta).toFixed(1).replace(/\.0$/, '');
        const emoji = isImproving ? '' : '<span class="blunder-emoji">💥</span>';
        badge.innerHTML = `${emoji}<span class="blunder-cp">${evalText}</span>`;
        marker.appendChild(badge);
      }
    }

    // If it has a cached future grade, append the grade tag in the top right
    if (data.grade) {
      const gradeTag = document.createElement('div');
      gradeTag.className = `future-grade-tag grade-${data.grade}`;
      gradeTag.textContent = data.grade;
      marker.appendChild(gradeTag);
    }

    container.appendChild(marker);
  }

  function showSingleMoveGhost(move) {
    const mainOverlay = document.getElementById('blunder-overlay');
    if (!mainOverlay) return;

    // 1. Hide the default overlay
    mainOverlay.style.display = 'none';

    // 2. Create a temporary hover overlay
    let hoverOverlay = document.getElementById('hover-ghost-overlay');
    if (!hoverOverlay) {
      hoverOverlay = document.createElement('div');
      hoverOverlay.id = 'hover-ghost-overlay';
      hoverOverlay.className = 'blunder-overlay'; // Reuse structural class
      // Append it to the same parent as the blunder overlay
      mainOverlay.parentElement.appendChild(hoverOverlay);
    }
    hoverOverlay.innerHTML = '';
    hoverOverlay.style.display = 'block';

    // 3. Render the single ghost correctly
    const isFlipped = document.getElementById('board').classList.contains('flipped');
    const sq = move.to || move.uci.slice(2, 4);
    _renderSquareGhosts(hoverOverlay, sq, { blunders: [], grade: null, bestMove: move, isHover: true }, isFlipped);
  }

  function hideSingleMoveGhost() {
    const mainOverlay = document.getElementById('blunder-overlay');
    const hoverOverlay = document.getElementById('hover-ghost-overlay');
    if (mainOverlay) mainOverlay.style.display = 'block';
    if (hoverOverlay) hoverOverlay.style.display = 'none';
  }

  function clearBlunderOverlay(keepCache = false) {
    if (!keepCache) {
      lastMoveTable = null;
      lastObjectiveEval = null;
    }
    const el = document.getElementById('blunder-overlay');
    if (el) el.innerHTML = '';
  }

  function renderBestMoveArrow(bestmoveUCI) {
    lastBestMove = bestmoveUCI;
    clearBestMoveArrow(true);
    if (!bestmoveUCI || bestmoveUCI.length < 4) return;
    const from = bestmoveUCI.slice(0, 2);
    const to = bestmoveUCI.slice(2, 4);

    const boardEl = document.getElementById('board');
    if (!boardEl) return;

    const getCenter = (sq) => {
      const file = sq.charCodeAt(0) - 97;
      const rank = parseInt(sq[1]) - 1;
      const xPct = isFlipped ? (7 - file) * 12.5 + 6.25 : file * 12.5 + 6.25;
      const yPct = isFlipped ? rank * 12.5 + 6.25 : (7 - rank) * 12.5 + 6.25;
      return { x: xPct, y: yPct };
    };

    const start = getCenter(from);
    const end = getCenter(to);

    // Calculate angle for a single unified polygon arrow
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);
    const length = Math.sqrt(dx * dx + dy * dy);

    // Shorten the arrow slightly so it doesn't cover the piece entirely
    const shortenHead = 2.5; // percentage units
    const shortenTail = 1;

    const startX = start.x + Math.cos(angle) * shortenTail;
    const startY = start.y + Math.sin(angle) * shortenTail;
    const endX = end.x - Math.cos(angle) * shortenHead;
    const endY = end.y - Math.sin(angle) * shortenHead;

    const headLen = 4.5;    // percentage units
    const headWidth = 3.5;  // percentage units
    const shaftWidth = 1.3; // percentage units

    // Calculate the 7 points of the arrow polygon
    const p1x = startX - Math.sin(angle) * (shaftWidth / 2);
    const p1y = startY + Math.cos(angle) * (shaftWidth / 2);

    const p2x = startX + Math.sin(angle) * (shaftWidth / 2);
    const p2y = startY - Math.cos(angle) * (shaftWidth / 2);

    const shaftEndX = endX - Math.cos(angle) * headLen;
    const shaftEndY = endY - Math.sin(angle) * headLen;

    const p3x = shaftEndX + Math.sin(angle) * (shaftWidth / 2);
    const p3y = shaftEndY - Math.cos(angle) * (shaftWidth / 2);

    const p4x = shaftEndX + Math.sin(angle) * (headWidth / 2);
    const p4y = shaftEndY - Math.cos(angle) * (headWidth / 2);

    const p5x = endX;
    const p5y = endY;

    const p6x = shaftEndX - Math.sin(angle) * (headWidth / 2);
    const p6y = shaftEndY + Math.cos(angle) * (headWidth / 2);

    const p7x = shaftEndX - Math.sin(angle) * (shaftWidth / 2);
    const p7y = shaftEndY + Math.cos(angle) * (shaftWidth / 2);

    const points = `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y} ${p4x},${p4y} ${p5x},${p5y} ${p6x},${p6y} ${p7x},${p7y}`;

    const svgWrapper = document.createElement('div');
    svgWrapper.id = 'bestmove-arrow';
    svgWrapper.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:15; opacity:0.6; transition:opacity 0.15s ease;';

    svgWrapper.innerHTML = `
      <svg viewBox="0 0 100 100" style="width:100%; height:100%; overflow:visible;">
        <polygon points="${points}" fill="#388bfd" stroke="#2563eb" stroke-width="0.3" stroke-linejoin="round" />
      </svg>
    `;

    const wrapper = document.querySelector('.board-wrapper');
    if (wrapper) wrapper.appendChild(svgWrapper);
  }

  function clearBestMoveArrow(keepCache = false) {
    if (!keepCache) {
      lastBestMove = null;
    }
    const el = document.getElementById('bestmove-arrow');
    if (el) el.remove();
  }

  async function nextMove() {
    const depth = parseInt(document.getElementById('depth-slider').value, 10);
    const seeThreshold = parseFloat(document.getElementById('see-slider').value);
    const cacheKey = BBI.getCacheKey(chess.fen(), depth, seeThreshold);
    const cached = await BBI.Cache.get(cacheKey);

    let uci = null;
    if (cached && cached.lastNavigatedUci) {
      uci = cached.lastNavigatedUci;
    }

    if (uci) {
      const move = chess.move(uci, { sloppy: true });
      if (move) {
        board.position(chess.fen());
        updateStatus();
        if (onMoveCallback) onMoveCallback(chess.fen(), move);
        return true;
      }
    }
    showToast('No further analyzed moves found.', 'info');
    return false;
  }

  return {
    init, flipBoard, resetBoard, loadFEN, undoMove, nextMove, showLoading, updateProgress,
    updateScorePanel, clearScorePanel, updateMoveHeatmap,
    updateStatus, showToast, renderBlunderOverlay, clearBlunderOverlay,
    renderBestMoveArrow, clearBestMoveArrow
  };
})();

window.UI = UI;
