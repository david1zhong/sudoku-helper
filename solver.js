'use strict';

/**
 * Human-style sudoku hint engine.
 * Given a grid (array of 81 ints, 0 = empty), getHint() returns the next
 * placeable number along with a plain-English explanation of how a person
 * would find it, chaining candidate-elimination techniques when needed.
 */
const Solver = (() => {

  // ---------- board geometry ----------
  const ROW_UNITS = [], COL_UNITS = [], BOX_UNITS = [];
  for (let i = 0; i < 9; i++) {
    const row = [], col = [];
    for (let j = 0; j < 9; j++) { row.push(i * 9 + j); col.push(j * 9 + i); }
    ROW_UNITS.push(row); COL_UNITS.push(col);
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const box = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push((br * 3 + r) * 9 + (bc * 3 + c));
      BOX_UNITS.push(box);
    }
  }
  const ALL_UNITS = [
    ...ROW_UNITS.map((cells, i) => ({ type: 'row', index: i, cells })),
    ...COL_UNITS.map((cells, i) => ({ type: 'column', index: i, cells })),
    ...BOX_UNITS.map((cells, i) => ({ type: 'box', index: i, cells })),
  ];
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const s = new Set();
    for (const u of ALL_UNITS) {
      if (u.cells.includes(i)) for (const c of u.cells) if (c !== i) s.add(c);
    }
    PEERS.push([...s]);
  }

  const rowOf = i => Math.floor(i / 9);
  const colOf = i => i % 9;
  const boxOf = i => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

  const BOX_NAMES = [
    'top-left', 'top-middle', 'top-right',
    'middle-left', 'center', 'middle-right',
    'bottom-left', 'bottom-middle', 'bottom-right',
  ];

  const cellName = i => `row ${rowOf(i) + 1}, column ${colOf(i) + 1}`;
  const cellNameCap = i => `Row ${rowOf(i) + 1}, column ${colOf(i) + 1}`;
  function unitName(u) {
    return u.type === 'box' ? `the ${BOX_NAMES[u.index]} box` : `${u.type} ${u.index + 1}`;
  }

  function listWords(arr, conj = 'and') {
    const a = arr.map(String);
    if (a.length === 0) return '';
    if (a.length === 1) return a[0];
    return a.slice(0, -1).join(', ') + ' ' + conj + ' ' + a[a.length - 1];
  }

  /** "a" / "an" for a digit: only 8 ("eight") takes "an". */
  function aFor(d, cap) {
    const w = d === 8 ? 'an' : 'a';
    return cap ? w[0].toUpperCase() + w.slice(1) : w;
  }

  // ---------- candidates / validity ----------

  function computeCandidates(grid) {
    const cands = new Array(81).fill(null);
    for (let i = 0; i < 81; i++) {
      if (grid[i]) continue;
      const used = new Set();
      for (const p of PEERS[i]) if (grid[p]) used.add(grid[p]);
      const s = new Set();
      for (let d = 1; d <= 9; d++) if (!used.has(d)) s.add(d);
      cands[i] = s;
    }
    return cands;
  }

  /** Returns array of {cells:[a,b], digit, unit} for every duplicate pair. */
  function conflicts(grid) {
    const out = [];
    for (const u of ALL_UNITS) {
      const seen = {};
      for (const c of u.cells) {
        const d = grid[c];
        if (!d) continue;
        if (seen[d] !== undefined) out.push({ cells: [seen[d], c], digit: d, unit: u });
        else seen[d] = c;
      }
    }
    return out;
  }

  function isComplete(grid) {
    return grid.every(v => v >= 1 && v <= 9);
  }

  /** Backtracking solution counter (stops at `limit`). Returns {count, solution}. */
  function countSolutions(grid, limit = 2) {
    const g = grid.slice();
    let count = 0, solution = null;

    function candsAt(i) {
      const used = new Set();
      for (const p of PEERS[i]) if (g[p]) used.add(g[p]);
      const s = [];
      for (let d = 1; d <= 9; d++) if (!used.has(d)) s.push(d);
      return s;
    }

    function search() {
      if (count >= limit) return;
      let best = -1, bestCands = null;
      for (let i = 0; i < 81; i++) {
        if (g[i]) continue;
        const cs = candsAt(i);
        if (cs.length === 0) return;
        if (!bestCands || cs.length < bestCands.length) { best = i; bestCands = cs; }
        if (bestCands.length === 1) break;
      }
      if (best === -1) {
        count++;
        if (count === 1) solution = g.slice();
        return;
      }
      for (const d of bestCands) {
        g[best] = d;
        search();
        g[best] = 0;
        if (count >= limit) return;
      }
    }

    search();
    return { count, solution };
  }

  // ---------- explanation helpers ----------

  /** Digits already placed in a list of cells (sorted, unique). */
  function digitsIn(grid, cells) {
    const s = new Set();
    for (const c of cells) if (grid[c]) s.add(grid[c]);
    return [...s].sort((a, b) => a - b);
  }

  /**
   * Why can't `cell` hold `digit`? Finds a placed peer with that digit,
   * preferring same row, then column, then box. Falls back to earlier
   * eliminations recorded in removedByTech.
   */
  function blockReason(grid, removedByTech, cell, digit) {
    const checks = [
      { cells: ROW_UNITS[rowOf(cell)], rel: 'row' },
      { cells: COL_UNITS[colOf(cell)], rel: 'column' },
      { cells: BOX_UNITS[boxOf(cell)], rel: 'box' },
    ];
    for (const { cells, rel } of checks) {
      for (const p of cells) {
        if (p !== cell && grid[p] === digit) {
          return { text: `its ${rel} already has a ${digit} (at ${cellName(p)})`, source: p };
        }
      }
    }
    if (removedByTech[cell] && removedByTech[cell].has(digit)) {
      return { text: `we already ruled ${digit} out of it in an earlier note`, source: -1 };
    }
    return { text: `it cannot be ${digit}`, source: -1 };
  }

  // ---------- placement techniques ----------

  function findNakedSingle(grid, cands, removedByTech) {
    for (let i = 0; i < 81; i++) {
      if (grid[i] || cands[i].size !== 1) continue;
      const digit = cands[i].values().next().value;

      const rowD = digitsIn(grid, ROW_UNITS[rowOf(i)]);
      const colD = digitsIn(grid, COL_UNITS[colOf(i)]);
      const boxD = digitsIn(grid, BOX_UNITS[boxOf(i)]);
      const baseExcluded = new Set([...rowD, ...colD, ...boxD]);
      const techOnly = [...(removedByTech[i] || [])].filter(d => !baseExcluded.has(d) && d !== digit).sort();

      const parts = [];
      if (rowD.length) parts.push(`its row already contains ${listWords(rowD)}`);
      if (colD.length) parts.push(`its column already contains ${listWords(colD)}`);
      if (boxD.length) parts.push(`its 3×3 box already contains ${listWords(boxD)}`);

      const explanation = [
        `Look at the cell at ${cellName(i)} (highlighted in green). A cell must hold a number that does not already appear anywhere in its row, its column, or its 3×3 box.`,
        `Here, ${parts.join('; ')}.`,
      ];
      if (techOnly.length) {
        explanation.push(`On top of that, the note${techOnly.length > 1 ? 's' : ''} above showed this cell also cannot be ${listWords(techOnly, 'or')}.`);
      }
      explanation.push(`That rules out every number except ${digit}, so this cell must be ${digit}.`);

      const unitCells = new Set([...ROW_UNITS[rowOf(i)], ...COL_UNITS[colOf(i)], ...BOX_UNITS[boxOf(i)]]);
      unitCells.delete(i);
      return {
        kind: 'place',
        technique: 'Only number left',
        title: `${cellNameCap(i)} must be ${digit}`,
        cell: i,
        digit,
        caption: `The green cell at ${cellName(i)} can only be ${digit}: every other number already appears in its row, column or box (the tinted cells).`,
        marks: Array.from({ length: 9 }, (_, k) => ({ cell: i, digit: k + 1, kind: k + 1 === digit ? 'yes' : 'no' })),
        explanation,
        highlights: { target: [i], source: [], unit: [...unitCells], elim: [] },
      };
    }
    return null;
  }

  function findHiddenSingle(grid, cands, removedByTech) {
    // Boxes are easiest for people to scan, so search them first.
    const order = [
      ...BOX_UNITS.map((cells, i) => ({ type: 'box', index: i, cells })),
      ...ROW_UNITS.map((cells, i) => ({ type: 'row', index: i, cells })),
      ...COL_UNITS.map((cells, i) => ({ type: 'column', index: i, cells })),
    ];
    for (const u of order) {
      for (let d = 1; d <= 9; d++) {
        if (u.cells.some(c => grid[c] === d)) continue;
        const spots = u.cells.filter(c => !grid[c] && cands[c].has(d));
        if (spots.length !== 1) continue;
        const target = spots[0];

        const bullets = [];
        const sources = new Set();
        for (const c of u.cells) {
          if (grid[c] || c === target) continue;
          const reason = blockReason(grid, removedByTech, c, d);
          if (reason.source >= 0) sources.add(reason.source);
          bullets.push(`The cell at ${cellName(c)} can't take it: ${reason.text}.`);
        }

        const explanation = [
          `Every row, column, and 3×3 box needs all of the numbers 1 through 9, so somewhere in ${unitName(u)} there has to be ${aFor(d)} ${d}.`,
          `Go through the empty cells of ${unitName(u)} one by one:`,
          ...bullets.map(b => '• ' + b),
          `That leaves ${cellName(target)} as the only cell in ${unitName(u)} that can take the ${d}.`,
        ];

        const blocked = u.cells.filter(c => !grid[c] && c !== target);
        return {
          kind: 'place',
          technique: `Only place in ${u.type === 'box' ? 'the box' : 'the ' + u.type}`,
          title: `${cellNameCap(target)} must be ${d}`,
          cell: target,
          digit: d,
          caption: `${aFor(d, true)} ${d} must go somewhere in ${unitName(u)} (tinted). It's blocked (red) in every empty cell except the green one at ${cellName(target)}. The ${d}s with a dashed ring do the blocking.`,
          marks: [
            { cell: target, digit: d, kind: 'yes' },
            ...blocked.map(c => ({ cell: c, digit: d, kind: 'no' })),
          ],
          explanation,
          highlights: { target: [target], source: [...sources], unit: u.cells, elim: [] },
        };
      }
    }
    return null;
  }

  // ---------- elimination techniques ----------

  function applyEliminations(cands, removedByTech, elims) {
    for (const { cell, digits } of elims) {
      for (const d of digits) {
        cands[cell].delete(d);
        removedByTech[cell].add(d);
      }
    }
  }

  function findPointing(grid, cands) {
    for (let b = 0; b < 9; b++) {
      for (let d = 1; d <= 9; d++) {
        const spots = BOX_UNITS[b].filter(c => !grid[c] && cands[c].has(d));
        if (spots.length < 2 || spots.length > 3) continue;
        const sameRow = spots.every(c => rowOf(c) === rowOf(spots[0]));
        const sameCol = spots.every(c => colOf(c) === colOf(spots[0]));
        if (!sameRow && !sameCol) continue;
        const line = sameRow
          ? { type: 'row', index: rowOf(spots[0]), cells: ROW_UNITS[rowOf(spots[0])] }
          : { type: 'column', index: colOf(spots[0]), cells: COL_UNITS[colOf(spots[0])] };
        const elims = line.cells
          .filter(c => boxOf(c) !== b && !grid[c] && cands[c].has(d))
          .map(c => ({ cell: c, digits: [d] }));
        if (!elims.length) continue;

        const explanation = [
          `Inside the ${BOX_NAMES[b]} box, the number ${d} can only fit in ${listWords(spots.map(cellName), 'or')}, and those cells all sit in ${line.type} ${line.index + 1}.`,
          `Whichever of them ends up holding the ${d}, that box's ${d} will be in ${line.type} ${line.index + 1}. A ${line.type} can only have one ${d}, so no cell of ${line.type} ${line.index + 1} outside this box can be ${d}.`,
          `So you can rule ${d} out of ${listWords(elims.map(e => cellName(e.cell)))}.`,
        ];

        return {
          kind: 'eliminate',
          technique: 'Box points along a line',
          title: `${d} in the ${BOX_NAMES[b]} box must stay in ${line.type} ${line.index + 1}`,
          caption: `The box's only spots for ${d} (blue) all sit in ${line.type} ${line.index + 1}, so the red ${d}s elsewhere in that ${line.type} are impossible.`,
          marks: [
            ...spots.map(c => ({ cell: c, digit: d, kind: 'maybe' })),
            ...elims.map(e => ({ cell: e.cell, digit: d, kind: 'no' })),
          ],
          eliminations: elims,
          explanation,
          highlights: { candidate: spots, source: [], unit: line.cells, elim: elims.map(e => e.cell) },
        };
      }
    }
    return null;
  }

  function findClaiming(grid, cands) {
    const lines = [
      ...ROW_UNITS.map((cells, i) => ({ type: 'row', index: i, cells })),
      ...COL_UNITS.map((cells, i) => ({ type: 'column', index: i, cells })),
    ];
    for (const line of lines) {
      for (let d = 1; d <= 9; d++) {
        const spots = line.cells.filter(c => !grid[c] && cands[c].has(d));
        if (spots.length < 2 || spots.length > 3) continue;
        const b = boxOf(spots[0]);
        if (!spots.every(c => boxOf(c) === b)) continue;
        const elims = BOX_UNITS[b]
          .filter(c => !line.cells.includes(c) && !grid[c] && cands[c].has(d))
          .map(c => ({ cell: c, digits: [d] }));
        if (!elims.length) continue;

        const explanation = [
          `In ${line.type} ${line.index + 1}, the number ${d} can only fit in ${listWords(spots.map(cellName), 'or')}, and those cells are all inside the ${BOX_NAMES[b]} box.`,
          `That ${line.type} must get its ${d} from one of those cells, which uses up the only ${d} the ${BOX_NAMES[b]} box is allowed. So the rest of that box can't hold ${aFor(d)} ${d}.`,
          `So you can rule ${d} out of ${listWords(elims.map(e => cellName(e.cell)))}.`,
        ];

        return {
          kind: 'eliminate',
          technique: 'Line claims a box',
          title: `${d} in ${line.type} ${line.index + 1} must stay in the ${BOX_NAMES[b]} box`,
          caption: `In ${line.type} ${line.index + 1}, ${d} (blue) only fits inside the tinted box. That uses up the box's ${d}, so its red cells can't take one.`,
          marks: [
            ...spots.map(c => ({ cell: c, digit: d, kind: 'maybe' })),
            ...elims.map(e => ({ cell: e.cell, digit: d, kind: 'no' })),
          ],
          eliminations: elims,
          explanation,
          highlights: { candidate: spots, source: [], unit: BOX_UNITS[b], elim: elims.map(e => e.cell) },
        };
      }
    }
    return null;
  }

  function findNakedPair(grid, cands) {
    for (const u of ALL_UNITS) {
      const empties = u.cells.filter(c => !grid[c]);
      for (let a = 0; a < empties.length; a++) {
        const ca = cands[empties[a]];
        if (ca.size !== 2) continue;
        for (let b = a + 1; b < empties.length; b++) {
          const cb = cands[empties[b]];
          if (cb.size !== 2) continue;
          const digits = [...ca].sort();
          if (![...cb].sort().every((d, k) => d === digits[k])) continue;
          const pair = [empties[a], empties[b]];
          const elims = empties
            .filter(c => !pair.includes(c))
            .map(c => ({ cell: c, digits: digits.filter(d => cands[c].has(d)) }))
            .filter(e => e.digits.length);
          if (!elims.length) continue;

          const explanation = [
            `In ${unitName(u)}, the two cells at ${cellName(pair[0])} and ${cellName(pair[1])} can each only be ${digits[0]} or ${digits[1]}. Nothing else fits in them.`,
            `Between those two cells they will use up both the ${digits[0]} and the ${digits[1]} for ${unitName(u)} (one each, in some order). This pattern is called a "naked pair".`,
            `So no other cell of ${unitName(u)} can be ${digits[0]} or ${digits[1]}: rule them out of ${listWords(elims.map(e => cellName(e.cell)))}.`,
          ];

          return {
            kind: 'eliminate',
            technique: 'Naked pair',
            title: `${digits[0]} and ${digits[1]} are locked into two cells of ${unitName(u)}`,
            caption: `The two blue cells at ${cellName(pair[0])} and ${cellName(pair[1])} only allow ${digits[0]} and ${digits[1]}, so between them they use both up. Cross those numbers off the red cells.`,
            marks: [
              ...pair.flatMap(c => digits.map(d => ({ cell: c, digit: d, kind: 'maybe' }))),
              ...elims.flatMap(e => e.digits.map(d => ({ cell: e.cell, digit: d, kind: 'no' }))),
            ],
            eliminations: elims,
            explanation,
            highlights: { candidate: pair, source: [], unit: u.cells, elim: elims.map(e => e.cell) },
          };
        }
      }
    }
    return null;
  }

  function findHiddenPair(grid, cands) {
    for (const u of ALL_UNITS) {
      const spotsFor = {};
      for (let d = 1; d <= 9; d++) {
        if (u.cells.some(c => grid[c] === d)) continue;
        const spots = u.cells.filter(c => !grid[c] && cands[c].has(d));
        if (spots.length === 2) spotsFor[d] = spots;
      }
      const ds = Object.keys(spotsFor).map(Number);
      for (let a = 0; a < ds.length; a++) {
        for (let b = a + 1; b < ds.length; b++) {
          const [d1, d2] = [ds[a], ds[b]];
          const s1 = spotsFor[d1], s2 = spotsFor[d2];
          if (s1[0] !== s2[0] || s1[1] !== s2[1]) continue;
          const elims = s1
            .map(c => ({ cell: c, digits: [...cands[c]].filter(d => d !== d1 && d !== d2) }))
            .filter(e => e.digits.length);
          if (!elims.length) continue;

          const explanation = [
            `In ${unitName(u)}, the numbers ${d1} and ${d2} each have only two possible homes, and they're the same two cells: ${cellName(s1[0])} and ${cellName(s1[1])}.`,
            `Since both numbers must go somewhere in ${unitName(u)}, those two cells must hold ${d1} and ${d2} (one each, in some order). This pattern is called a "hidden pair".`,
            `That means those two cells can't hold anything else: rule out ${listWords(elims.map(e => `${listWords(e.digits)} from ${cellName(e.cell)}`))}.`,
          ];

          return {
            kind: 'eliminate',
            technique: 'Hidden pair',
            title: `${d1} and ${d2} claim two cells of ${unitName(u)}`,
            caption: `${d1} and ${d2} fit nowhere else in ${unitName(u)}, so the two blue cells at ${cellName(s1[0])} and ${cellName(s1[1])} must take them. Their other candidates (red) disappear.`,
            marks: [
              ...s1.flatMap(c => [{ cell: c, digit: d1, kind: 'maybe' }, { cell: c, digit: d2, kind: 'maybe' }]),
              ...elims.flatMap(e => e.digits.map(dd => ({ cell: e.cell, digit: dd, kind: 'no' }))),
            ],
            eliminations: elims,
            explanation,
            highlights: { candidate: s1, source: [], unit: u.cells, elim: [] },
          };
        }
      }
    }
    return null;
  }

  function findNakedTriple(grid, cands) {
    for (const u of ALL_UNITS) {
      const empties = u.cells.filter(c => !grid[c] && cands[c].size <= 3);
      for (let a = 0; a < empties.length; a++) {
        for (let b = a + 1; b < empties.length; b++) {
          for (let c = b + 1; c < empties.length; c++) {
            const trio = [empties[a], empties[b], empties[c]];
            const union = new Set();
            for (const cell of trio) for (const d of cands[cell]) union.add(d);
            if (union.size !== 3) continue;
            const digits = [...union].sort();
            const elims = u.cells
              .filter(cell => !grid[cell] && !trio.includes(cell))
              .map(cell => ({ cell, digits: digits.filter(d => cands[cell].has(d)) }))
              .filter(e => e.digits.length);
            if (!elims.length) continue;

            const explanation = [
              `In ${unitName(u)}, the three cells at ${listWords(trio.map(cellName))} only allow the numbers ${listWords(digits)} between them.`,
              `Three cells, three possible numbers: those cells must take ${listWords(digits)} in some order, using all three of them up for ${unitName(u)}. This pattern is called a "naked triple".`,
              `So you can rule ${listWords(digits, 'and')} out of the other cells: ${listWords(elims.map(e => cellName(e.cell)))}.`,
            ];

            return {
              kind: 'eliminate',
              technique: 'Naked triple',
              title: `${listWords(digits)} are locked into three cells of ${unitName(u)}`,
              caption: `The three blue cells only allow ${listWords(digits)} between them. Three cells, three numbers, all used up. Cross them off the red cells.`,
              marks: [
                ...trio.flatMap(cell => [...cands[cell]].map(d => ({ cell, digit: d, kind: 'maybe' }))),
                ...elims.flatMap(e => e.digits.map(d => ({ cell: e.cell, digit: d, kind: 'no' }))),
              ],
              eliminations: elims,
              explanation,
              highlights: { candidate: trio, source: [], unit: u.cells, elim: elims.map(e => e.cell) },
            };
          }
        }
      }
    }
    return null;
  }

  function findXWing(grid, cands) {
    for (const [lineUnits, crossUnits, lineWord, crossWord, lineIdx, crossIdx] of [
      [ROW_UNITS, COL_UNITS, 'row', 'column', rowOf, colOf],
      [COL_UNITS, ROW_UNITS, 'column', 'row', colOf, rowOf],
    ]) {
      for (let d = 1; d <= 9; d++) {
        const linesWith2 = [];
        for (let i = 0; i < 9; i++) {
          if (lineUnits[i].some(c => grid[c] === d)) continue;
          const spots = lineUnits[i].filter(c => !grid[c] && cands[c].has(d));
          if (spots.length === 2) linesWith2.push({ line: i, spots });
        }
        for (let a = 0; a < linesWith2.length; a++) {
          for (let b = a + 1; b < linesWith2.length; b++) {
            const A = linesWith2[a], B = linesWith2[b];
            const colsA = A.spots.map(crossIdx).sort();
            const colsB = B.spots.map(crossIdx).sort();
            if (colsA[0] !== colsB[0] || colsA[1] !== colsB[1]) continue;
            const corners = [...A.spots, ...B.spots];
            const elims = [];
            for (const cc of colsA) {
              for (const cell of crossUnits[cc]) {
                if (!grid[cell] && cands[cell].has(d) && !corners.includes(cell)) {
                  elims.push({ cell, digits: [d] });
                }
              }
            }
            if (!elims.length) continue;

            const explanation = [
              `In ${lineWord}s ${A.line + 1} and ${B.line + 1}, the number ${d} has exactly two possible spots each, and in both ${lineWord}s those spots fall in the same two ${crossWord}s (${crossWord}s ${colsA[0] + 1} and ${colsA[1] + 1}). The four cells form a rectangle.`,
              `Each of those two ${lineWord}s must place its ${d} in one of the rectangle's corners, on opposite ${crossWord}s. So between them, the rectangle uses up the ${d} for both ${crossWord}s.`,
              `This pattern is called an "X-wing". You can rule ${d} out of every other cell in ${crossWord}s ${colsA[0] + 1} and ${colsA[1] + 1}: ${listWords(elims.map(e => cellName(e.cell)))}.`,
            ];

            return {
              kind: 'eliminate',
              technique: 'X-wing',
              title: `${aFor(d, true)} ${d} rectangle locks ${crossWord}s ${colsA[0] + 1} and ${colsA[1] + 1}`,
              caption: `The blue corners are the only spots for ${d} in ${lineWord}s ${A.line + 1} and ${B.line + 1}. They'll take ${d} at opposite corners, covering both ${crossWord}s, so the red ${d}s are impossible.`,
              marks: [
                ...corners.map(c => ({ cell: c, digit: d, kind: 'maybe' })),
                ...elims.map(e => ({ cell: e.cell, digit: d, kind: 'no' })),
              ],
              eliminations: elims,
              explanation,
              highlights: { candidate: corners, source: [], unit: [...crossUnits[colsA[0]], ...crossUnits[colsA[1]]], elim: elims.map(e => e.cell) },
            };
          }
        }
      }
    }
    return null;
  }

  const ELIMINATION_TECHNIQUES = [
    findPointing,
    findClaiming,
    findNakedPair,
    findHiddenPair,
    findNakedTriple,
    findXWing,
  ];

  // ---------- main entry point ----------

  /**
   * Returns one of:
   *   { error: string }                          invalid grid
   *   { done: true }                             already solved
   *   { presteps: [...], final: step, warning? } the hint
   * `final` is always a 'place' or 'reveal' step; presteps are eliminations.
   */
  function getHint(grid) {
    const dupes = conflicts(grid);
    if (dupes.length) {
      const d = dupes[0];
      return {
        error: `There are two ${d.digit}s in ${unitName(d.unit)} (at ${cellName(d.cells[0])} and ${cellName(d.cells[1])}). One of them is wrong. Fix it, then ask again.`,
        errorCells: d.cells,
      };
    }
    if (isComplete(grid)) return { done: true };

    const { count, solution } = countSolutions(grid, 2);
    if (count === 0) {
      return { error: 'This grid has no possible solution, so one of the numbers must be wrong. Compare the grid against your puzzle and fix any cell that looks off.' };
    }
    const warning = count > 1
      ? 'Heads-up: this grid has more than one solution, which usually means a number is missing. The hints below are still safe to follow.'
      : null;

    const cands = computeCandidates(grid);
    const removedByTech = Array.from({ length: 81 }, () => new Set());
    const presteps = [];

    for (let iter = 0; iter < 200; iter++) {
      const placed = findNakedSingle(grid, cands, removedByTech)
        || findHiddenSingle(grid, cands, removedByTech);
      if (placed) return { presteps, final: placed, warning };

      let advanced = null;
      for (const tech of ELIMINATION_TECHNIQUES) {
        advanced = tech(grid, cands);
        if (advanced) break;
      }
      if (!advanced) break;
      applyEliminations(cands, removedByTech, advanced.eliminations);
      presteps.push(advanced);
    }

    // Techniques exhausted, so reveal a number from the brute-force solution.
    if (count === 1) {
      let best = -1;
      for (let i = 0; i < 81; i++) {
        if (grid[i]) continue;
        if (best === -1 || cands[i].size < cands[best].size) best = i;
      }
      const digit = solution[best];
      return {
        presteps,
        warning,
        final: {
          kind: 'reveal',
          technique: 'Beyond simple logic',
          title: `${cellNameCap(best)} is ${digit}`,
          cell: best,
          digit,
          caption: `This one needs a trickier kind of reasoning than I can walk you through, so here's the answer: the green cell at ${cellName(best)} holds ${digit}.`,
          marks: [{ cell: best, digit, kind: 'yes' }],
          explanation: [
            'This position needs a more advanced technique than the step-by-step patterns this helper explains, so there is no simple "spot it yourself" path here.',
            `To keep you moving: in the finished puzzle, the cell at ${cellName(best)} holds ${digit}. (Its remaining possibilities were ${listWords([...cands[best]].sort(), 'and')}.)`,
            'After you fill it in, ask for the next number. The following steps will likely be explainable again.',
          ],
          highlights: { target: [best], source: [], unit: [], elim: [] },
        },
      };
    }

    return {
      error: 'I have run out of moves I can find, and this grid still has more than one solution. That usually means a number is missing. Compare the grid against your puzzle and add or fix any cell, then ask again.',
    };
  }

  return { getHint, conflicts, isComplete, computeCandidates, countSolutions, cellName };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Solver;
