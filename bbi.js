/**
 * bbi.js — Core BBI Calculation Pipeline
 *
 * Exports: runPipeline(chess, workerHelper, gradeOnly=false)
 * Returns: { objectiveEval, expectedEval, delta, grade, moveTable,fen }
 */

function gradeFromDelta(delta, objectiveEval, isForcedMate, expectedEval) {
  // If the active player has a forced mate in their favor, they're winning!
  // This isn't a trap for them—it means the *opponent* played a suicidal blunder.
  if (isForcedMate && objectiveEval > 0) return 'F';

  if (delta >= 9.0) return 'S';
  if (delta >= 5.0) return 'A';
  if (delta >= 3.0) return 'B';
  if (delta >= 1.5) return 'C';

  // D rank is now the default for anything < 1.5 delta (including negative)
  // EXCEPT for crushing advantages which get F rank
  if (expectedEval >= 5.0 || expectedEval <= -5.0) return 'F';

  return 'D';
}

// -------------------------------------------------------------------------
// Global Cache (Memory + IndexedDB)
// -------------------------------------------------------------------------
const BBICache = (() => {
  const DB_NAME = 'BBICacheDB';
  const STORE_NAME = 'evals';
  const VERSION = 1;
  let dbPromise = null;
  const memCache = new Map();

  // Pre-loading of starting position removed to ensure evaluation sync and engine consistency.

  function initDB() {
    if (!window.indexedDB) return Promise.reject('No IDB');
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = (e) => { e.target.result.createObjectStore(STORE_NAME); };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => reject('IndexedDB error');
      });
    }
    return dbPromise;
  }

  async function get(fen) {
    // Check IndexedDB first so we don't accidentally overwrite richer retroactively-graded data with hardcoded memCache
    try {
      const db = await initDB();
      return await new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fen);
        req.onsuccess = () => {
          if (req.result) {
            memCache.set(fen, req.result);
            resolve(req.result);
          } else {
            resolve(memCache.get(fen) || null);
          }
        };
        req.onerror = () => resolve(memCache.get(fen) || null);
      });
    } catch {
      return memCache.get(fen) || null;
    }
  }

  async function set(fen, data) {
    memCache.set(fen, data);
    try {
      const db = await initDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, fen);
    } catch { /* ignore */ }
  }

  async function clear() {
    memCache.clear();
    try {
      const db = await initDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch { /* ignore */ }
  }

  async function updateMetadata(key, metadata) {
    const data = await get(key);
    if (data) {
      Object.assign(data, metadata);
      await set(key, data);
    }
  }

  async function count() {
    try {
      const db = await initDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject('Count failed');
      });
    } catch { return memCache.size; }
  }

  async function remove(key) {
    memCache.delete(key);
    try {
      const db = await initDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
    } catch { /* ignore */ }
  }

  return { get, set, remove, clear, count, updateMetadata };
})();

// Convert Stockfish cp score to pawn units (capped ±30 for readability)
function cpToPawns(score_cp, score_mate, sideToMove) {
  // sideToMove: 'w' or 'b'. Stockfish always reports from side-to-move perspective.
  // We convert so that positive = White winning, negative = Black winning.
  let val;
  if (score_mate != null) {
    // Forced mate: return a large signed value
    val = score_mate > 0 ? 30 : -30;
  } else {
    val = (score_cp || 0) / 100;
  }

  // Stockfish perspective: positive = better for sideToMove.
  // White perspective: positive = better for White.
  const whiteRelative = (sideToMove === 'w') ? val : -val;
  return Math.max(-30, Math.min(30, whiteRelative));
}

// -------------------------------------------------------------------------
// WorkerHelper — drives stockfish.js via raw UCI string messages
// stockfish.js is used DIRECTLY as the Worker (its intended usage pattern).
// -------------------------------------------------------------------------
class WorkerHelper {
  constructor() {
    // Use stockfish.js as the worker source directly
    this.sf = new Worker('./stockfish.js');
    this.pending = [];       // queue of {resolve, score_cp, score_mate, pv}
    this.active = null;     // currently running job
    this.ready = false;

    this.sf.onmessage = (e) => this._handleLine(
      typeof e === 'string' ? e : (e.data ?? '')
    );
    this.sf.onerror = (e) => console.error('[Stockfish] Worker error:', e);

    // Init UCI
    this.sf.postMessage('uci');
    this.sf.postMessage('setoption name Hash value 32');
    this.sf.postMessage('isready');
  }

  _handleLine(line) {
    if (!line || typeof line !== 'string') return;

    if (line === 'readyok') {
      const wasReady = this.ready;
      this.ready = true;
      if (!wasReady) console.log('[Stockfish] Engine synchronized and ready for new position.');
      this._runNext();
      return;
    }

    // If we've called stop/isready, we ignore all incoming 'info' or 'bestmove'
    // lines until we see 'readyok'. This prevents stale evaluations from 
    // being incorrectly attributed to the new board state.
    if (!this.ready) return;

    const job = this.active;
    if (!job) return;

    if (line.startsWith('info') && line.includes('score')) {
      const cpM = line.match(/score cp (-?\d+)/);
      const mateM = line.match(/score mate (-?\d+)/);
      const pvM = line.match(/ pv (.+)/);
      if (cpM) { job.score_cp = parseInt(cpM[1], 10); job.score_mate = null; }
      if (mateM) { job.score_mate = parseInt(mateM[1], 10); job.score_cp = null; }
      if (pvM) job.pv = pvM[1].trim();
    }

    if (line.startsWith('bestmove')) {
      job.bestmove = line.split(' ')[1];
      this.active = null;
      job.resolve({
        score_cp: job.score_cp, 
        score_mate: job.score_mate,
        bestmove: job.bestmove, 
        pv: job.pv || '',
        fen: job.fen // Return the FEN this result belongs to
      });
      this._runNext();
    }
  }

  _runNext() {
    if (this.active || !this.ready || this.pending.length === 0) return;
    this.active = this.pending.shift();
    if (this.active.interrupted) {
      this.active = null;
      return this._runNext();
    }
    this.active.start(this.sf);
  }

  _enqueue(fen, move, depth, priority = false) {
    return new Promise((resolve) => {
      const job = {
        fen, // Store FEN for verification
        resolve, score_cp: null, score_mate: null, pv: '', bestmove: null,
        interrupted: false,
        start(sf) {
          if (move) {
            console.log(`[Stockfish] ${priority ? '[PRIORITY] ' : ''}Searching ${move} at depth ${depth}`);
            sf.postMessage(`position fen ${fen} moves ${move}`);
          } else {
            console.log(`[Stockfish] ${priority ? '[PRIORITY] ' : ''}Searching position at depth ${depth}`);
            sf.postMessage(`position fen ${fen}`);
          }
          sf.postMessage(`go depth ${depth}`);
        },
      };

      if (priority) {
        this.pending.unshift(job);
      } else {
        this.pending.push(job);
      }
      this._runNext();
    });
  }

  eval(fen, depth = 15, priority = false) { return this._enqueue(fen, null, depth, priority); }
  evalMove(fen, move, depth = 15, priority = false) { return this._enqueue(fen, move, depth, priority); }

  interruptActive() {
    if (this.active) {
      console.log('[Stockfish] Interrupting active task...');
      this.active.interrupted = true;
      this.active.resolve(null);
      this.active = null;
    }
    this.ready = false; 
    if (this.sf) {
      this.sf.postMessage('stop');
      this.sf.postMessage('isready');
    }
  }

  clearQueue() {
    if (this.active) {
      this.active.interrupted = true;
      this.active.resolve(null);
    }
    for (const job of this.pending) {
      job.interrupted = true;
      job.resolve(null);
    }
    this.pending = [];
    this.active = null;
    this.ready = false; 
    if (this.sf) {
      this.sf.postMessage('stop');
      this.sf.postMessage('isready');
    }
  }

  // Deprecated: Alias for legacy code
  clear() { this.clearQueue(); }
}


// -------------------------------------------------------------------------
// Main Pipeline
// -------------------------------------------------------------------------
async function runPipeline(chess, workerHelper, options = {}) {
  const {
    seeThreshold = -2.0,
    depth = 15,
    maxMoves = 20,   // cap plausible moves to evaluate for speed
    onProgress = null, // callback for progress bar
    priority = false,
  } = options;

  const fen = chess.fen();
  const turn = chess.turn();

  // Check cache first (Key now includes depth, threshold, and logic revision)
  const cacheKey = getCacheKey(fen, depth, seeThreshold);
  const cached = await BBICache.get(cacheKey);
  if (cached) {
    console.log('[BBI] Loaded from cache:', cacheKey);
    if (onProgress) onProgress(1); // 100%
    return cached;
  }

  const isWhiteTurn = turn === 'w';

  // Short-circuit on game over
  if (chess.game_over()) {
    const isCheckmate = chess.in_checkmate();
    const terminalEval = isCheckmate ? (isWhiteTurn ? -10.0 : 10.0) : 0.0;
    if (onProgress) onProgress(1);

    // skull emojis for white vs black checkmated
    const skull = isWhiteTurn ? '☠️' : '💀';

    return {
      fen,
      objectiveEval: terminalEval,
      expectedEval: terminalEval,
      delta: 0.0,
      grade: isCheckmate ? skull : 'D',
      isForcedMate: isCheckmate,
      bestmove: null,
      moveTable: []
    };
  }

  // --- Step 1: Get Maia probabilities ---
  let rawProbs;
  let dbMoves = [];
  let winProb = 0.5;
  let source = 'Maia';
  try {
    const maiaRes = await MAIA.getMaiaProbs(chess);
    rawProbs = maiaRes.moveProbs;
    winProb = maiaRes.winProb;
    source = maiaRes.source;
    dbMoves = maiaRes.dbMoves || [];
  } catch (err) {
    console.error('[BBI] Maia error:', err);
    // Fallback: uniform distribution over legal moves
    const moves = chess.moves({ verbose: true });
    const prob = 1 / moves.length;
    rawProbs = moves.map(m => ({ move: m, uci: m.from + m.to + (m.promotion || ''), prob }));
    source = 'Fallback (Uniform)';
  }

  console.log(`[BBI] Sourced from ${source}: ${rawProbs.length} moves. WinProb: ${(winProb * 100).toFixed(1)}%`);

  // Store original top probability and move for hydration formula
  const topProbPair = rawProbs.length > 0 ? rawProbs[0] : null;
  const maiaTopProb = topProbPair ? topProbPair.prob : 0;
  const maiaTopUCI = topProbPair ? topProbPair.uci : null;
  console.log(`[BBI] Maia Top Move: ${maiaTopUCI} (${(maiaTopProb * 100).toFixed(1)}%)`);

  // NEW: Store original WIN probability to ensure syncedObjectiveEval is resilient
  const originalWinProb = winProb;

  // --- Step 2: SEE Plausibility Filter ---
  const probThreshold = 0.02; // Global threshold (2.0%)
  let plausible = SEE.filterByPlausibility(chess, rawProbs, seeThreshold);

  // --- Step 2.1: Identify Hydration Candidates (+1.5 SEE) ---
  const hydrationCandidates = SEE.scanForHydration(chess, 1.5);
  console.log(`[BBI] SEE Hydration Scan found ${hydrationCandidates.length} candidate moves.`);
  hydrationCandidates.forEach(m => {
    const uci = m.from + m.to + (m.promotion || '');
    const existing = plausible.find(p => p.uci === uci);
    if (existing) {
      existing.isHydrationCandidate = true;
    } else {
      const original = rawProbs.find(p => p.uci === uci);
      const prob = original ? original.prob : 0;
      plausible.push({
        move: m,
        uci,
        prob,
        see: SEE.computeSEE(chess, m),
        isPlausible: true, // Hydration candidates are by definition plausible
        isHydrationCandidate: true
      });
    }
  });

  // Calculate maiaTopProb AFTER SEE filtering/re-normalization to ensure strong hydration
  // We use the top move from the 'significant' set if available
  const topSignificant = plausible.filter(p => p.prob > probThreshold).sort((a, b) => b.prob - a.prob)[0];
  const effectiveMaiaTopProb = topSignificant ? topSignificant.prob : maiaTopProb;
  console.log(`[BBI] effectiveMaiaTopProb: ${(effectiveMaiaTopProb * 100).toFixed(1)}% (via ${topSignificant ? topSignificant.uci : 'fallback'})`);
  console.log(`[BBI] maiaTopUCI: ${maiaTopUCI}, maiaTopProb: ${(maiaTopProb * 100).toFixed(1)}%`);

  console.log(`[SEE] ${plausible.length} moves survived (threshold: ${seeThreshold})`);

  // --- Step 2.5: Human Probability Pruning & SEE Integration ---
  // Mark moves that failed SEE as pruned.
  // Probability-based pruning is DELAYED until Step 4.9 to allow tactical hydration.
  const significant = plausible.filter(p => p.isPlausible);
  const totalSignificantProb = significant.reduce((sum, p) => sum + p.prob, 0);

  if (significant.length > 0) {
    plausible = plausible.map(p => {
      // FIX: Early pruning only happens for SEE failures (blunders)
      const isPruned = !p.isPlausible;
      return {
        ...p,
        isPruned,
        // bbiProb is the re-normalized probability among non-pruned moves (used for expectedEval)
        bbiProb: isPruned ? 0 : (p.prob / (totalSignificantProb || 1))
      };
    });
  } else {
    // Fallback: If EVERYTHING failed SEE, keep at least the top move
    const top = plausible.sort((a, b) => b.prob - a.prob)[0];
    plausible = plausible.map(p => ({
      ...p,
      isPruned: p !== top,
      bbiProb: p === top ? 1.0 : 0
    }));
  }

  // --- Step 3 & 4 Progress tracking ---
  // Filter out pruned moves (SEA failures) from the evaluation pipeline
  let movesToEval = plausible.filter(p => !p.isPruned).slice(0, maxMoves);
  console.log(`[BBI] Pipeline: plausible moves=${plausible.length}, searching top=${movesToEval.length} (pruned: ${plausible.filter(p => p.isPruned).length})`);

  // Ensure all hydration candidates are included in the evaluation
  plausible.filter(p => p.isHydrationCandidate).forEach(c => {
    if (!movesToEval.some(m => m.uci === c.uci)) {
      movesToEval.push(c);
    }
  });

  const totalTasks = movesToEval.length + 1; // +1 for the objective eval
  let completedTasks = 0;
  const tickProgress = () => {
    completedTasks++;
    if (onProgress) onProgress(completedTasks / totalTasks);
  };

  // --- Step 3: Objective Evaluation of current position ---
  let objResult = await workerHelper.eval(fen, depth, priority);
  // Background tasks: retry once if interrupted by a foreground priority task
  if (!objResult && !priority) {
    console.log('[BBI] Background objective eval interrupted, retrying...');
    objResult = await workerHelper.eval(fen, depth, priority);
  }
  
  // --- Step 4.2: Sanity Check ---
  // Ensure the engine result is for the correct position by verifying move legality AND FEN equality.
  // This prevents cross-contamination from old searches in the queue.
  if (!objResult || objResult.fen !== fen) {
    if (objResult) console.warn(`[BBI] Stale engine result ignored: expected ${fen.split(' ')[0]}, got ${objResult.fen.split(' ')[0]}`);
    throw new Error('Interrupted');
  }

  if (objResult.bestmove && objResult.bestmove !== '(none)') {
    const legalMoves = chess.moves({ verbose: true });
    const isLegal = legalMoves.some(m => (m.from + m.to + (m.promotion || '')) === objResult.bestmove);
    if (!isLegal) {
      console.warn(`[BBI] Illegal engine move detected: ${objResult.bestmove} in ${fen}`);
      throw new Error('Interrupted');
    }
  }

  tickProgress();
  let objectiveEval = cpToPawns(objResult.score_cp, objResult.score_mate, turn);
  if (isNaN(objectiveEval)) objectiveEval = 0.0;
  const isForcedMate = objResult.score_mate != null;

  // --- Step 4: Evaluate each plausible move via Stockfish ---
  const evalPromises = movesToEval.map(pair => {
    const testChess = new Chess(fen);
    testChess.move(pair.uci, { sloppy: true });

    if (testChess.game_over()) {
      tickProgress();
      const isCheckmate = testChess.in_checkmate();
      const objMateLimit = isWhiteTurn ? 10.0 : -10.0;
      return Promise.resolve({
        ...pair,
        score_cp: 0,
        score_mate: isCheckmate ? 0 : null,
        evalPawns: isCheckmate ? objMateLimit : 0.0
      });
    }

    const nextTurn = testChess.turn();
    const nextFen = testChess.fen();

    return workerHelper.eval(nextFen, depth, priority).then(async res => {
      // Background tasks: retry once if interrupted by a foreground priority task
      if (!res && !priority) {
        console.log(`[BBI] Background move eval interrupted for ${pair.uci}, retrying...`);
        res = await workerHelper.eval(nextFen, depth, priority);
      }
      if (!res) throw new Error('Interrupted');
      tickProgress();
      return {
        ...pair,
        score_cp: res.score_cp,
        score_mate: res.score_mate,
        // Since cpToPawns now returns a unified White-relative score, 
        // no negation is needed here regardless of whose turn it is.
        evalPawns: cpToPawns(res.score_cp, res.score_mate, nextTurn),
        bbiProb: pair.bbiProb,
        isPruned: pair.isPruned,
      };
    });
  });

  const rawEvaluated = (await Promise.all(evalPromises)).map((e, i) => {
    const m = movesToEval[i];
    return { ...m, ...e }; // Merge maia info with engine info
  });

  // Always re-normalize at this step so the analyzed subset sums to 100%
  // This effectively removes pruned moves from the probability distribution
  const searchProbSum = rawEvaluated.reduce((sum, e) => sum + e.prob, 0);
  let normalizedEvaluated = (searchProbSum > 0)
    ? rawEvaluated.map(e => ({ ...e, prob: e.prob / searchProbSum }))
    : rawEvaluated;

  // --- Step 4.5: Anchor Objective Evaluation ---
  // The root search horizon (Depth N) is our immutable truth. Child moves (searched to Depth N-1) 
  // will perfectly assemble back to exactly this root evaluation.
  const syncedObjectiveEval = objectiveEval;

  console.log(`[BBI] Immutable Objective Eval: ${objectiveEval.toFixed(2)}`);

  // --- Step 4.7: SEE Hydration Implementation ---
  // Compare high-SEE moves against Maia's preferred choice (original top probability move)
  const maiaBestMove = normalizedEvaluated.find(e => e.uci === maiaTopUCI);

  // FALLBACK: If Maia's top move was pruned or filtered, find the next highest probability move that was evaluated.
  let referenceMove = maiaBestMove;
  if (!referenceMove && normalizedEvaluated.length > 0) {
    referenceMove = [...normalizedEvaluated].sort((a, b) => b.prob - a.prob)[0];
    console.log(`[BBI] Maia Top Move ${maiaTopUCI} not evaluated. Using ${referenceMove.uci} as hydration reference.`);
  }

  const maiaBestEval = referenceMove ? referenceMove.evalPawns : objectiveEval;
  const safeMaiaBestEval = isNaN(maiaBestEval) ? objectiveEval : maiaBestEval;
  const safeEffectiveProb = isFinite(effectiveMaiaTopProb) ? effectiveMaiaTopProb : 0;

  console.log(`[BBI] Hydration Reference: ${referenceMove ? referenceMove.uci : 'Objective'} (Eval: ${safeMaiaBestEval.toFixed(2)}), effectiveMaiaTopProb: ${(safeEffectiveProb * 100).toFixed(1)}%`);

  let hydrationApplied = false;
  let finalEvaluatedList = normalizedEvaluated.map(e => {
    // 1. Identify "Tactical Gems": significant material gain + engine approved
    const isEngineApproved = isWhiteTurn
      ? (e.evalPawns >= (syncedObjectiveEval - 1.5))
      : (e.evalPawns <= (syncedObjectiveEval + 1.5));

    if (e.isHydrationCandidate && isEngineApproved) {
      // Use effectiveMaiaTopProb as a base to ensure the boost is proportional to the overall confidence
      const maiaConfidence = Math.max(0.1, safeEffectiveProb);

      // 2. Dynamic Scaling: Boost increases exponentially with the value of the piece captured
      // e.g. Queen (9) -> 9^1.2 ~= 13.9x boost, Pawn (1) -> 1.0x boost
      const seeGain = Math.max(1.0, e.see || 1.5);
      const dynamicWeight = Math.pow(seeGain, 1.2);

      // 3. Accuracy bonus: if this is the absolute best engine move, reward it even more
      const bestMoveBonus = (e.uci === objResult.bestmove) ? 2.0 : 0.5;

      const totalBoost = (dynamicWeight * 1.5 + bestMoveBonus) * maiaConfidence;

      if (totalBoost > 0 && isFinite(totalBoost)) {
        hydrationApplied = true;
        console.log(`[BBI] Hydrating tactical gem ${e.uci}: see=${e.see}, boost=${totalBoost.toFixed(4)}`);
        return { ...e, prob: e.prob + totalBoost, isHydrated: true, hydrationBoost: totalBoost };
      }
    }
    return e;
  });

  if (hydrationApplied) {
    console.log(`[BBI] Tactical Hydration applied to ${finalEvaluatedList.filter(e => e.isHydrated).length} moves.`);

    // RE-NORMALIZE to ensure Expected Eval doesn't explode
    const newSum = finalEvaluatedList.reduce((sum, e) => sum + (isNaN(e.prob) ? 0 : e.prob), 0);
    if (newSum > 0 && isFinite(newSum)) {
      finalEvaluatedList = finalEvaluatedList.map(e => ({ ...e, prob: (e.prob || 0) / newSum }));
    }
  }

  console.log(`[BBI] Final Move Table Probabilities:`, finalEvaluatedList.map(e => `${e.uci}: ${(e.prob * 100).toFixed(1)}%`));

  // --- Step 4.8: Lumbra's Opening Book Hydration (Hybrid: Prune & Recalculate) ---
  // If we are in Hybrid mode, the book move is pulled out of the model's distribution
  // and its probability is recalculated based on its tactical score vs the alternatives.
  if (source === 'Hybrid' && dbMoves.length > 0) {
    // 1. Partition evaluated moves into book moves and alternatives
    const bookMovesList = finalEvaluatedList.filter(e => dbMoves.includes(e.uci));
    const alternatives = finalEvaluatedList.filter(e => !dbMoves.includes(e.uci));

    if (bookMovesList.length > 0 && alternatives.length > 0) {
      // 2. Re-normalize alternatives to sum to 1.0 (to find the true "alternative world")
      const altSum = alternatives.reduce((sum, e) => sum + e.prob, 0);
      let normalizedAlts;
      if (altSum > 0 && isFinite(altSum)) {
        normalizedAlts = alternatives.map(e => ({ ...e, prob: e.prob / altSum }));
      } else {
        // Fallback: If alternatives are all 0% (Maia extremely confident in book move), 
        // treat them as uniform for the sake of finding the "best" tactical alternative.
        const uniform = 1 / alternatives.length;
        normalizedAlts = alternatives.map(e => ({ ...e, prob: uniform }));
      }

      // 3. Find the best alternative (highest probability, then highest eval)
      // 3. Find the best tactical alternative for the side to move
      const altTopMove = normalizedAlts.reduce((prev, curr) => {
        if (Math.abs(curr.prob - prev.prob) < 0.001) {
          // Tie-break with evaluation
          const isBetter = isWhiteTurn ? (curr.evalPawns > prev.evalPawns) : (curr.evalPawns < prev.evalPawns);
          return isBetter ? curr : prev;
        }
        return (curr.prob > prev.prob ? curr : prev);
      });
      const altTopEval = altTopMove.evalPawns;
      const altTopProb = (altSum > 0) ? altTopMove.prob : (1 / alternatives.length);

      // 4. Recalculate book move probabilities
      const updatedBookMoves = bookMovesList.map(bm => {
        const diff = (bm.evalPawns - altTopEval) * (isWhiteTurn ? 1 : -1);
        let newProb = 0;

        if (diff > 0.1) {
          // Dynamic Multiplier: (Material Diff) * Top Alternative Prob
          newProb = diff * altTopProb;
        } else {
          // Baseline: Fallback to original model probability if not tactically better
          newProb = bm.prob;
        }

        console.log(`[BBI] Recalculated Book Move ${bm.uci}: eval=${bm.evalPawns.toFixed(2)} vs altTop=${altTopEval.toFixed(2)}, newProb=${newProb.toFixed(4)}`);
        return { ...bm, prob: newProb, isBookHydrated: true };
      });

      // 5. Re-merge and set as the new final list (normalization happens in Step 4.9)
      finalEvaluatedList = normalizedAlts.concat(updatedBookMoves);
      hydrationApplied = true;
      console.log(`[BBI] Prune & Recalculate successfully applied for Hybrid mode.`);
    }
  }

  // --- Step 4.9: Post-Hydration Finalization ---
  if (hydrationApplied) {
    const totalProb = finalEvaluatedList.reduce((sum, e) => sum + e.prob, 0);
    finalEvaluatedList = finalEvaluatedList.map(e => ({ ...e, prob: e.prob / totalProb }));
  }

  // Final pruning and bbiProb allocation (always runs)
  const sig = finalEvaluatedList.filter(e => e.isPlausible && e.prob > probThreshold);
  const totalSigProb = sig.reduce((sum, e) => sum + e.prob, 0);

  finalEvaluatedList = finalEvaluatedList.map(e => {
    // A move is unpruned ONLY if it survived SEE AND (has sufficient probability OR is a hydration candidate)
    const isPruned = !e.isPlausible || (!e.isHydrationCandidate && e.prob <= probThreshold);
    return {
      ...e,
      isPruned,
      bbiProb: isPruned ? 0 : (e.prob / (totalSigProb || 1))
    };
  });

  const finalEvaluated = finalEvaluatedList;
  console.log(`[BBI] Pipeline: finalEvaluated size=${finalEvaluated.length}`);

  // --- Step 5: Expected Evaluation ---
  // Expected Eval only considers 'significant' moves (> 0.5% prob after hydration/re-normalization)
  const expectedEval = finalEvaluated.reduce((sum, e) => sum + e.bbiProb * e.evalPawns, 0);

  // --- Step 6: BBI Delta ---
  // Calculates "Lost Value" from the perspective of the current player.
  const delta = (syncedObjectiveEval - expectedEval) * (isWhiteTurn ? 1 : -1);
  console.log(`[BBI] Pipeline: delta=${delta.toFixed(3)} (Engine=${syncedObjectiveEval.toFixed(3)} - Human=${expectedEval.toFixed(3)})`);

  // --- Step 7: Grade ---
  // Check if humans have >= 1% chance of blundering into a forced mate (eval drops for side to move)
  const hasHumanFindableMate = finalEvaluated.some(e => {
    const isBlunderMate = isWhiteTurn ? (e.evalPawns <= -20.0) : (e.evalPawns >= 20.0);
    return e.prob > 0.01 && isBlunderMate;
  });
  const isLethalTrap = delta >= 4.0 && hasHumanFindableMate;

  // Find the most likely Maia move to see if we possess a crushing lead
  const topHumanMove = finalEvaluated.length > 0 ? finalEvaluated.reduce((prev, curr) => (curr.prob > prev.prob ? curr : prev)) : null;
  const topHumanEval = topHumanMove ? topHumanMove.evalPawns : objectiveEval;

  let grade = isLethalTrap ? 'SS' : gradeFromDelta(delta, objectiveEval, isForcedMate, expectedEval);

  // Crushing lead logic is already handled by gradeFromDelta
  console.log(`[BBI] Pipeline: Assigned Grade=${grade}`);

  // Forced move edge case: If there's only one literal legal move, the human cannot blunder.
  // We award an S rank because the correct move is "found" by default.
  const legalMovesCount = chess.moves().length;
  if (legalMovesCount === 1) {
    grade = 'S';
  }

  if (isForcedMate && objectiveEval > 0) grade = 'F';
  else if (isLethalTrap) grade = 'SS';

  // Sort by probability DESC so hydrated moves rise to the top
  finalEvaluated.sort((a, b) => b.prob - a.prob);

  // Build move table for display
  const moveTable = finalEvaluated.map(e => ({
    uci: e.uci,
    san: e.move.san,
    from: e.move.from,
    to: e.move.to,
    piece: e.move.piece,      // 'p','n','b','r','q','k'
    color: e.move.color,      // 'w' or 'b'
    prob: e.prob,
    see: e.see,
    evalPawns: e.evalPawns,
    evalAbs: isWhiteTurn ? e.evalPawns : -e.evalPawns, // White-relative for consistent dashboard display
    relativeDelta: (e.evalPawns - syncedObjectiveEval) * (isWhiteTurn ? 1 : -1),
    scoreMate: e.score_mate,
    weighted: e.bbiProb * e.evalPawns,
    cpLoss: Math.max(0, -((e.evalPawns - syncedObjectiveEval) * (isWhiteTurn ? 1 : -1))), // pawn units lost vs best play
    isPruned: e.isPruned,
    isHydrated: e.isHydrated || false,
    isHydrationCandidate: e.isHydrationCandidate || false,
    hydrationBoost: e.hydrationBoost || 0,
  }));

  const finalResult = { objectiveEval: syncedObjectiveEval, expectedEval, delta, grade, moveTable, fen, isForcedMate, scoreMate: objResult.score_mate, bestmove: objResult.bestmove, source };

  // Save to cache
  await BBICache.set(cacheKey, finalResult);

  return finalResult;
}

class AnalyzerQueue {
  constructor(workerHelper) {
    this.workerHelper = workerHelper;
    this.queue = [];
    this.activeTask = null;
    this.onQueueChange = null;
  }

  _notify() {
    if (this.onQueueChange) {
      this.onQueueChange(this.queue.length + (this.activeTask ? 1 : 0));
    }
  }

  async runQueue() {
    if (this.activeTask || this.queue.length === 0) return;
    this.activeTask = this.queue.shift();
    this._notify();

    try {
      const testChess = new Chess(this.activeTask.fen);
      const result = await runPipeline(testChess, this.workerHelper, {
        depth: this.activeTask.depth,
        seeThreshold: this.activeTask.seeThreshold,
        priority: this.activeTask.priority,
        maxMoves: this.activeTask.maxMoves || 20,
        onProgress: this.activeTask.onProgress
      });

      // Retroactive grading for the previous move
      if (this.activeTask.executedMove && this.activeTask.prevFen) {
        const dScale = this.activeTask.depth;
        const sScale = this.activeTask.seeThreshold;
        const prevKey = getCacheKey(this.activeTask.prevFen, dScale, sScale);
        let prevCache = await BBICache.get(prevKey);

        if (prevCache) {
          const move = this.activeTask.executedMove;
          const uci = move.from + move.to + (move.promotion || '');
          let mMatch = prevCache.moveTable.find(m => m.uci === uci);
          if (!mMatch) {
            mMatch = {
              uci: uci,
              san: move.san,
              from: move.from,
              to: move.to,
              piece: move.piece,
              color: move.color,
              prob: 0,
              evalPawns: result.objectiveEval,
              cpLoss: 0,
            };
            prevCache.moveTable.push(mMatch);
          }
          mMatch.futureGrade = result.grade;
          await BBICache.set(prevKey, prevCache);
        }
      }

      this.activeTask.resolve(result);
    } catch (e) {
      if (e.message !== 'Interrupted') {
        console.error('[AnalyzerQueue] Error:', e);
      }
      this.activeTask.reject(e);
    } finally {
      this.activeTask = null;
      this._notify();
      this.runQueue();
    }
  }

  analyze(options) {
    return new Promise((resolve, reject) => {
      const task = { ...options, resolve, reject };

      if (options.priority) {
        if (this.activeTask) {
          if (this.activeTask.priority || this.activeTask.isDowngraded) {
            // Keep interrupted foreground tracks (or downgraded queues) alive in the background
            const bgTask = { 
              ...this.activeTask, 
              priority: false, 
              isDowngraded: true,
              resolve: this.activeTask.isDowngraded ? this.activeTask.resolve : () => {}, 
              reject: this.activeTask.isDowngraded ? this.activeTask.reject : () => {}, 
              onProgress: null 
            };
            this.queue.push(bgTask);
          }
          this.workerHelper.interruptActive(); // Only abort the active search, preserve background sub-jobs
        }
        
        // Convert any pending priority tasks in the queue into background tasks
        this.queue.forEach(t => {
          if (t.priority) {
            t.priority = false;
            t.isDowngraded = true;
            t.reject(new Error('Interrupted'));
            t.resolve = () => {};
            t.reject = () => {};
            t.onProgress = null;
          }
        });

        this.queue.unshift(task);
      } else {
        this.queue.push(task);
      }
      
      this._notify();
      this.runQueue();
    });
  }

  clearBackgroundTasks() {
    this.queue = this.queue.filter(t => {
      if (!t.priority) {
        t.reject(new Error('Interrupted'));
        return false;
      }
      return true;
    });
    this._notify();
  }

  clearAll() {
    this.queue.forEach(t => t.reject(new Error('Interrupted')));
    this.queue = [];
    if (this.activeTask) {
      this.workerHelper.clearQueue();
    }
    this._notify();
  }
}

const BBI_REVISION = '2026-03-26-v8'; // Increment to invalidate old logic/grading caches
function getCacheKey(fen, depth, seeThreshold) {
  return `${fen}|d${depth}|s${seeThreshold}|${BBI_REVISION}`;
}

window.BBI = { AnalyzerQueue, runPipeline, gradeFromDelta, cpToPawns, WorkerHelper, getCacheKey, Cache: BBICache };
