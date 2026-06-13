# Sudoku Helper

Stuck on a sudoku? Take a photo or screenshot of it, and this tool shows you how to find the next number. It explains the logic in plain English, the way a person would actually spot it, and you can ask for as many next steps as you want.

I built it as a teaching aid, not an auto-solver. The point is for you to place the number yourself and get why it goes there, not to have the whole solution dumped on you.

## Use it

Open `index.html` in a browser, or serve the folder (`python -m http.server`).

1. Get your puzzle in. Drag a photo or screenshot onto the page, click to browse, or just paste an image with `Ctrl+V`. If you'd rather, you can type the puzzle in by hand.
2. Check the grid. The digits get read automatically, and any cell the reader wasn't sure about shows up yellow. Click a wrong one and retype it.
3. Hit "Find my next number." You get one placement plus a short explanation of how to see it yourself. If spotting it first means ruling some candidates out (a naked pair, an X-wing, that sort of thing), those show up as numbered notes you can expand, and hovering a note highlights it on the board.
4. Press the button again whenever you get stuck on the next one.

Everything runs in the browser, and your images never leave your computer. The one catch: the digit reader (Tesseract.js) loads from a CDN the first time you use it, so the first image needs an internet connection.

## How it works

- `extractor.js` is the computer vision, all in plain JavaScript. It runs an adaptive (Bradley) threshold, uses connected-component analysis to find the puzzle outline, does a 4-point perspective warp to straighten it, then pulls the blob out of each cell. Every non-empty cell goes through Tesseract.js (digits only), which runs in a web worker so the page never freezes.
- `solver.js` is a human-style hint engine. It tries the techniques in the order a person would: naked single, hidden single, box/line interactions, naked and hidden pairs, naked triples, then X-wings, chaining eliminations until it can place a number. The explanation text is built from whatever logic it actually used. If a puzzle is harder than any of that, it falls back to revealing one digit from the brute-force solution, and it tells you that's what it did.
- `app.js`, `index.html`, and `styles.css` are the UI.
