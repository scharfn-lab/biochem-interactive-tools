# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A collection of standalone, single-file interactive educational web tools for chemistry and biochemistry. No build system, no dependencies to install — open any `.html` file directly in a browser.

## Files

- **index.html** — Landing page linking to the tools. Add a tool by editing the `TOOLS` list at the top of its script; `index.test.js` checks that every link matches a file in this folder
- **ramachandran.html** — Interactive Ramachandran plot + 3D dipeptide viewer
- **cell_membrane.html** — Cell membrane ion transport / electrochemical gradient visualizer
- **chemistry_quiz.html** — Stoichiometry practice quiz (loads RDKit.js from CDN for molecular structures)
- **amino_acids.html** — Amino acid identification practice: names, side-chain types and pH forms (loads a pinned RDKit.js from CDN)
- **peptide_charge.html** — Peptide (1–6 residues) skeletal structure at any pH, with pKa values and pI practice, and a quiz mode (offline, no libraries)
- **enzyme_kinetics.html** — Measuring Rates, Kinetics and Inhibition tabs: product vs. time, Michaelis–Menten and Lineweaver–Burk plots, with a quiz mode (offline, no libraries)
- **oxygen_binding.html** — Hemoglobin and myoglobin O₂ saturation curves with pH, 2,3-BPG, CO₂ and fetal Hb, concerted and sequential views, and a quiz mode (offline, no libraries)
- **buffers.html** — Buffer visualizer: set the pH and temperature and add strong acid or base to see how a buffer responds, with a quiz mode (offline, no libraries)
- **enzyme_energy.html** — Reaction coordinate diagram comparing uncatalyzed and enzyme-catalyzed paths through an EP intermediate, with temperature and pH activity plots (offline, no libraries; not yet linked from index.html)

- **protein_purification.html** — Purification simulator: chain ion exchange, size exclusion and affinity steps on a random lysate, pool fractions, and read an SDS-PAGE gel (offline, no libraries; no scoring)

Tests live beside the pages as `*.test.js` and run with `node --test` (no dependencies).

## Architecture: ramachandran.html

The most complex file. Two coordinated views driven by a single `setAngles(φ, ψ)` hub:

```
User input (sliders / canvas click / drag)
    └→ setAngles(φ, ψ)
          ├→ updateUI()        — sync all controls
          ├→ renderPlot()      — redraw 2D heatmap
          └→ renderDipeptide() — rebuild & redraw 3D viewer
```

**2D Plot:** Ramachandran regions are defined as 2D Gaussians in `REGIONS[]`. `buildBackground()` pre-renders the heatmap once into `bgCache`; subsequent frames just restore it and redraw the current-angle point. Regions are hand-fitted approximations; the general α region is three overlapping lobes shaped so its favored area has no local clash. `findClashes()` counts only contacts within one residue's ϕ/ψ unit (`ramachandranUnits()`), because a uniform chain running into itself four or more residues along says nothing about whether one residue can take those angles.

**3D Viewer rendering pipeline:**
1. `buildDipeptide(φ, ψ)` — places atoms using the NeRF algorithm (given bond length, angle, dihedral → 3D coords)
2. View rotation matrix applied (screen-space, gimbal-lock-free); `mOrtho()` re-orthonormalizes periodically to prevent float drift
3. Orthographic projection → canvas space
4. Items (bonds + atoms) Z-sorted and drawn back-to-front
5. `drawBond()` clips line endpoints to atom sphere surfaces (bonds start/end at sphere edge, not center)
6. `drawAtom()` uses radial gradients for sphere shading with depth-based alpha

**Key data structures:**
- `atomStyle[key]` — `{fill, r, label}` per atom
- `bondDefs` — array of `[atomA, atomB, type]` triples; types: `'single'|'double'|'peptide'|'phi'|'psi'|'hbond'|'stub'`
- `proj[key]` — projected `{x, y, z}` per atom (rebuilt each frame)
- `residueAngles` — `{nTerm, central, cTerm}` each with `{phi, psi}`; all three sync by default

**Optional adjacent residues** (N-terminal, C-terminal) are toggled via checkboxes and appended to the base dipeptide atoms/bonds in `renderDipeptide()`.

## Architecture: cell_membrane.html

Central `state` object holds all ion concentrations, membrane potential (Vm), and temperature. Every slider/input change calls a unified update function that:
1. Recomputes ΔG for each ion via the Nernst equation: `ΔG = RT·ln([in]/[out]) + ZFΔVm`
2. Regenerates SVG ion dots using a seeded pseudo-random function (deterministic dot placement based on concentration)
3. Redraws the action potential curve canvas

## Architecture: chemistry_quiz.html

`currentQuestion` object holds the active compound, conversion type, values, and answer. `generateQuestion()` picks a random compound from the 29-item database and a random conversion type (or the user-selected filter), then builds display HTML and a step-by-step solution. RDKit.js (loaded async from CDN) renders SMILES strings to SVG for the Lewis structure panel; a queue handles draws requested before RDKit finishes loading.

## Architecture: amino_acids.html

`AA[]` holds the 20 amino acids with SMILES at pH 1, 7 and 13. `@`/`@@` in those SMILES follow the written atom order, not R/S, so L-cysteine is `[C@@H]` like the others even though its CIP label is R. `displayMode` is `'identify'` (the starting page), `'structure'`, `'name'` or `'interact'`; `getActiveFields()` decides which answer fields a question has. The Name Type row is a single choice per section (`structureNameType`, `nameModeNameType`; default `'random'`, resolved once per question in `current.randomNameType`): it is the name asked for in structure mode and the name shown in name mode. Name mode always asks for the property, from a name or a structure per `nameModeSource` (default `'random'`, resolved once per question in `current.randomSource`), and shows its Name Type row only for Show Name. Its structures open at `current.ph`, and the pH buttons switch from there. The name and type answers are custom type-ahead lists (`COMBO_OPTIONS`, prefix matching, ARIA combobox) rather than `<datalist>`, which matches letters anywhere in a word; the pH answer stays a `<select>`. The `'interact'` mode covers pairs of amino acids with a quiz and an unscored explorer. `SIDE_CHAINS` gives each side chain's charge and hydrogen-bond roles per pH, and `interactionsBetween()` applies the rules, so grading and explanations always agree. A salt bridge overrides its hydrogen bond. Questions are asked only at `INTERACT_PH` (7), and only for pairs with an interaction. The quiz takes a choice from six buttons (`chooseInteraction`), reveals the structures on the first click, and allows one retry (`interactTried`) before showing the answer. One question in five (`INTERACT_STRUCTURE_SHARE`, `fromStructure`) swaps this: it shows the structures from the start, with the names hidden in the prompt, captions and `aria-label` until the first click, and it falls back to names if RDKit fails (`asksFromStructure()`). It keeps its question in `interactQuestion`, separate from `current`. `nextQuestion()` deals from a shuffled `questionBag`, and `renderQuestion()` redraws the current question whenever a setting changes. A new question focuses its first box without scrolling, except on touch screens (`isTouchScreen()`), where focus would open the keyboard and scroll the page. `completeQuestion(results)` takes a right/wrong result per response type and feeds both the score and the `breakdown` table. `current.counted` keeps a reopened question from scoring twice, and `current.hadWrong` holds the identify-mode penalty. When bumping RDKit, change the version in both the `<script>` tag and `locateFile`.

## Architecture: peptide_charge.html

All pKa values live in the `PKA` table at the top of the script (Berg, Tymoczko & Stryer). `ionizableGroups(seq)` lists the free termini and side chains; `netCharge()` and `findPI()` (bisection) work from that list. `buildStructure(seq)` returns the SVG, drawing each residue from `SIDE_TEMPLATES` in local coordinates (x along the chain, u away from the backbone). Each ionizable group holds both its forms as `.ion-state` groups, and `updateStructureStates()` crossfades between them, so a pH change never rebuilds the drawing. Students identify the residues themselves, so nothing may mark residue boundaries or name the sequence: no bands, residue labels or peptide bond marks in the drawing, no sequence in its `aria-label`, `generateRandomPeptide()` leaves the entry box empty and turns about 30% of peptides 180° (`buildStructure(seq, true)`, with `ROTATED_LABELS` keeping labels upright and reading from the atom outward, while typed peptides always read N-terminus first), and `pKaRows()` lists R groups by name rather than position. `pKaTableRows()` fills the Determining pI table with the termini and all seven ionizable side chains from low pKa to high, ties alphabetical, whatever the peptide, and it always shows, so it can't reveal the residues. A lone three-letter code in the input is read as one residue. `piFeedback()` words every pI check: the actual pI when right, empty or on a later wrong try, and on a first wrong guess the range from `relevantPKas()`, the two pKa values either side of the neutral form. An answer counts as right within ±0.1 of either the exact `findPI()` value or `textbookPI()`, the average of that range, and `piStatement()` names both only when they differ by more than that.

Quiz Mode hides the Peptide and pH boxes and puts the quiz box above the structure. `nextQuizQuestion()` picks a peptide, a pH of 1, 7 or 14, and `quizFormat`, which asks for the sequence in 1-letter or 3-letter codes. The charge question asks for the whole-number charge of the most abundant species (`speciesCharge()`, each group in its main form at that pH), since students aren't taught to calculate the fractional net charge; `netCharge()` remains only for `findPI()`. `answersHidden()` draws the structure uncharged until all three answers are finished or Reveal is used. `quizField` tracks each answer's wrong tries, and `finishField()` locks it and adds it to `breakdown` once.

## Architecture: buffers.html

`state` holds the buffer, volume, total moles and `netBase`, the moles of strong base minus strong acid, counted from the buffer all in its acid form. `solveH()` finds [H⁺] from the charge balance, so the pH stays right past the buffering region, and every readout comes from it. Each action returns an error message or null, then calls `render()`. Each particle stands for a fixed number of moles, so the count follows the moles.

For the quiz, `buildQuizSet()` and `QUESTION_BUILDERS` produce plain-data questions, each with a `scene` written into `state`. That section of the script touches no DOM. Correct values use the exact solver, and the tests confirm that Henderson–Hasselbalch worked from a prompt's numbers still passes. `answersHidden()` is true during a question and hides the readouts, the curve's position dot and hover, and History's pH values, until the question is answered. `updateControls()` does nothing during a quiz, so the Buffer panel's fields never hold an answer. `exitQuiz()` restores the state saved by `startQuiz()`.

## Architecture: enzyme_kinetics.html

`commit()` is the hub: it validates the fields into `state.params`, keeping the last valid values, and `buildModel()` turns those into curves. Section 2 of the script touches no DOM, and the test file runs it in a vm. `state.mode` is `'rates'`, `'kinetics'` or `'inhibition'`. On Measuring Rates, `readRaw()` substitutes the hidden enzyme from `state.rates.enzymes`, so Km and kcat never reach the page's fields there. Demonstration and Collect Data use different enzymes because the × Km buttons reveal Km. `placeSharedFields()` moves [E]total and the units between the Experiment box and Enzyme parameters. `entryTruth()` works out kcat and catalytic efficiency there from what the plot shows, and the page gives no method for finding any of these answers. `seriesFor()` lists what a plot draws, bottom to top, and `buildRatesData()` builds the progress curves from the integrated rate law.

For the quiz, `buildQuizSet()` and `QUESTION_BUILDERS` produce plain-data questions, each with a `scene`. `drawQuizScene()` sets `state.params` directly and `commit()` does nothing during a quiz, so `exitQuiz()` can rebuild the tab from its own fields. Hard Mode uses `amountInVolume()`, which never pairs units that divide directly into the plot's concentration unit.

## Architecture: oxygen_binding.html

Every adjustable constant is in `MODEL`. P50 is the normal value multiplied by `bohrFactor()`, `bpgFactor()` and `co2Factor()`. `render()` is the hub. `state.activity` is null when no O₂ delivery button is selected, which hides the blue lines, dots and lung and tissue markers. Otherwise `drawMarkers()` draws the blue lines at Y(lung) and Y(tissue), with the arrow between them, and `drawDeliveryDots()` marks both points on Adjusted Hb and, at half size, on Normal Hb. `state.po2` is the selected pO₂, set by the schematic's slider or by clicking the plot; the red point and the purple arrow from Normal Hb to Adjusted Hb both sit at it. The schematic draws 12 molecules in each cell from `schematicMarkup()`, with hemoglobin following the Adjusted Hb curve. `boundSites()` rounds saturation to whole sites, and `subunitStates()` places them by `state.hbModel`: Concerted fills one molecule at a time with all four subunits in R, and Sequential spreads O₂ across molecules with only bound subunits in R. Both use the same Hill curve, so the model changes the drawing and never the saturation.

For the quiz, `QUIZ_BUILDERS` and `createQuizDeck()` in section 2 produce plain-data questions. Exactly one question in every five is the checkbox topic, `causes`, and it never comes up twice in a row. Shift, affinity and delivery answers come from the model, not typed in. A match question never pairs two causes in the same direction, because they look alike on a plot. Any plot with more than two curves names one as Normal Hb, so students compare with it rather than remember it. A blank Check Answer reveals the answer without changing the score. `quizCurveEntries()` keeps lettered curves unnamed until the question is answered. The quiz never writes to `state`, so exiting restores the page as it was. `shiftFrom()` compares P50 with normal to set the affinity box, though P50 itself no longer appears on the page. The carbon monoxide controls were removed from the page, and `withCarbonMonoxide()` and its tests remain in section 2 unused. Section 2 of the script touches no DOM, and the test file runs it in a vm.

## Architecture: enzyme_energy.html

Section 1 of the script touches no DOM, and the test file runs it in a vm. `render()` is the hub: `buildModel(state)` works out every number once, then `syncControls()`, `renderNotes()` and `drawAll()` read from it, so a later quiz mode has one place to hide or test values. The Quiz Mode button is disabled and has no code yet. `DEFAULTS` holds the optimal settings: a slightly stabilized ES and a low TS1. Reset returns to them, and "Show ground-state trap" applies `SETTINGS_TRAP`. ΔH of unfolding is the fixed `DH_UNFOLD`.

Energies are kept in kJ/mol, with S and E + S at zero, and only the number boxes and labels convert to kcal/mol. ES, TS1, EP and TS2 are each set directly as an energy relative to S (`esG`, `ts1G`, `epG`, `ts2G`). `catalyzedPath()` holds each transition state at least `MIN_TS_GAP` above its neighbors and reports each limit in `clamps`, which becomes the page's note. `barriersOf()` measures each barrier from the lowest state before it, and the largest is rate-limiting. The uncatalyzed path always shows, and one button hides or shows the catalyzed path (`showCat`). The temperature and pH plots draw whole curves and mark only the optimum, so no temperature or pH setting exists on the page.

## Architecture: protein_purification.html

Section 1 of the script touches no DOM, and the test file runs it in a vm. Students see only blobs, peaks and bands, plus the target's known MW and pI from `targetFacts()`, so no contaminant's MW or pI, and no amount, may reach the page. `generateLysate()` builds two contaminants sharing the target's pI and two sharing its native size, which is why no single non-affinity step can purify it, and retries until `isPurifiable()` holds. A run is a list of Gaussian `peaks`; the A280 curve and the `fractions` both come from those, so they can't disagree. Runs return plain data, and `runColumn()` keeps the latest in `state.pending` until `carryForward()` makes the pool the new sample. Each step stores the state from `before` it, and `undoLastStep()` restores that and removes the step's lanes by `stepId`. Lanes store amounts per protein, and `laneBands()` works out bands when drawn, so choosing a tag moves the target's band in existing lanes too, since the protein always carried it. The tag locks once a column has run with it. SEC has one column, `SEC_RANGE`, and the page lists no range. `columnBeads()` draws each method's beads in the column image, marked by shape as well as color.

## Git Workflow

After completing any meaningful unit of work — a feature, bug fix, or refactor — commit and push immediately so progress is never lost.

- Stage specific files by name, not `git add .`
- Write concise, descriptive commit messages in the imperative (e.g. `Clip bond lines to atom sphere surfaces`, `Replace φ with ϕ (U+03D5) throughout`)
- Push to `origin` after every commit: `git add <files> && git commit -m "..." && git push`
- Never skip hooks or force-push unless explicitly instructed

## Design Standards

### University of Tampa Brand Colors

Use the UT palette as the starting point for new pages and UI updates, and add or adjust colors where a page needs them to tell things apart, such as curves, ligands or answer states. Every choice must still meet WCAG 2.1 AA (below), and a page's stated colors take priority. Source: [UT Color Contrast Grid](https://www.ut.edu/about-utampa/university-services/office-of-marketing-and-communications/color-contrast-grid) and the [2024 Brand Guidelines](https://www.ut.edu/content/dam/ut/uploadedFiles/University_Services/Public_Information/UTBrandGuidelines2024UpdateV2.pdf).

**Primary:**
| Name | Hex |
|---|---|
| UT Red | `#D0012B` |
| Black | `#000000` |
| White | `#FFFFFF` |

**Secondary / supporting:**
| Name | Hex |
|---|---|
| Cream | `#E6E0CC` |
| Dark Gray | `#282828` |
| Medium-Dark Gray | `#404040` |
| Medium Gray | `#828282` |
| Light Gray | `#BFBFBF` |
| Off-White | `#F0F0F0` |

### WCAG Compliance

Target **WCAG 2.1 AA** as the minimum for all new work (AAA where feasible).

Key rules:
- Normal text (< 18pt / < 14pt bold): contrast ratio ≥ 4.5:1
- Large text (≥ 18pt / ≥ 14pt bold): contrast ratio ≥ 3:1
- UI components and graphical elements: contrast ratio ≥ 3:1
- Never convey information by color alone — pair color with labels, icons, or patterns
- All interactive controls need visible focus indicators
- Images and canvas graphics that convey meaning need `alt` text or `aria-label`

**Pre-approved UT color pairings (from UT's own contrast grid):**
- `#D0012B` on `#FFFFFF` — AA ✓
- `#FFFFFF` on `#D0012B` — AA ✓
- `#FFFFFF` on `#000000` — AAA ✓
- `#FFFFFF` on `#282828` — AAA ✓
- `#000000` on `#E6E0CC` — AAA ✓
- Avoid `#828282` or `#BFBFBF` as text on light backgrounds — contrast too low for body text

### Answer and Grayed-Out Colors

Every page uses these same colors, so a student sees the same signal on every tool. Correct answers are always this blue, taken from `amino_acids.html`, and never green or lavender. Keep black text on these backgrounds, and pair the color with a ✓ or ✗ or with words, since color alone isn't enough.

| State | Background | Border | Text |
|---|---|---|---|
| Correct | `#DBEAFE` | `#1565C0` | `#000000` |
| Incorrect | `#FFEBEE` | `#C8102E` | `#000000` |
| Grayed out (disabled box) | `#E4E4E4` | `#BFBFBF` | `#404040` |

These pages don't match yet, and should be brought in line when they're next changed:
- **chemistry_quiz.html:** its dark theme uses green and red for answers
- **amino_acids.html:** the correct background is right, but correct entry boxes have a crimson border and the all-correct message has a taupe border
- **cell_membrane.html:** its disabled button uses `#A0A0A0`

### Quiz Score Tracking

Every page with a quiz tracks each student's results the same way, so a student can see which kinds of question they mostly get right and wrong. `amino_acids.html` and `peptide_charge.html` are the models to follow.

- **Buttons:** put "Reset score" and "Score breakdown" together at the bottom of the page. "Score breakdown" opens and closes the table, and sets `aria-expanded`.
- **Table:** one row per question type, with "Correct Responses" and "Incorrect Responses" columns and a "Total" row. Keep the page's rows specific enough to show a weak spot, such as separate rows for 1-letter and 3-letter codes.
- **Counting:** count each response once per question, even if the question is reopened or a setting changes. Decide when a response is final and test it: a correct answer counts if the student gets it before the answer is shown, and showing the answer counts as incorrect. Hints, format errors and skipped questions don't count.
- **Storage:** results last for the session in a plain object such as `breakdown`, and aren't saved. An open table updates as answers come in, and "Reset score" clears it.

These pages have a quiz but don't track results this way yet, and should gain it when they're next changed:
- **buffers.html**
- **chemistry_quiz.html**

## Conventions

- **No jump to the answer box on phones.** A page that puts the cursor in a text box when a question opens calls `focus({ preventScroll: true })`, and skips it when `isTouchScreen()` is true, since on a phone focus opens the keyboard and scrolls the page.
- **No framework, no bundler.** Pure vanilla JS + Canvas 2D API. All math (vectors, matrices, NeRF) is implemented inline.
- **Greek letters** use Unicode directly in source (e.g., `ϕ` U+03D5, `ψ` U+03C8) — not HTML entities — in JS strings and canvas `fillText` calls.
- **Depth-based alpha** throughout the 3D viewer: `alpha = 0.5 + 0.5 * Math.tanh(depth * 0.3 + 0.5)`. Atoms use a slightly different curve (`0.55 + 0.45 * ...`).
- **Color theme:** ramachandran.html uses a UT-inspired palette (crimson, taupe, lavender); cell_membrane.html uses light blue (outside) / light pink (inside); chemistry_quiz.html is a dark glass-morphism theme; amino_acids.html uses crimson and taupe; enzyme_kinetics.html and oxygen_binding.html use crimson, taupe and lavender.
