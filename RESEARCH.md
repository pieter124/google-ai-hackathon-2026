# Research backing

Two literature passes sit behind three things in this repo: the rubric anchors
(`src/config.js` → `CRITERIA_DEFINITIONS`), the interviewer's behavior prompt
(`src/api/geminiClient.js` → `INTERVIEWER_BEHAVIOR`), and the Watchdog and
phase thresholds (`src/components/InterviewScreen.js`).

Evidence is tagged `[peer-reviewed]` or `[industry]` (practitioner sources that
converge but aren't peer-reviewed). Worth being upfront: no big-tech company
publishes its literal internal rubric, and there's no peer-reviewed study that
directly measures how human technical interviewers take turns. The hard numbers
below come from adjacent fields — conversation analysis, intelligent tutoring
systems, wait-time research — and are applied by analogy. Treat every threshold
as a tunable default, not a validated constant.

## 1. Evaluation criteria → the anchored rubric

The four dimensions are the intersection of Google's four attributes, Meta's
four signals, and the usual ML-system-design dimensions:

1. **Problem Understanding** — decode, clarify, decompose, iterate to optimal.
2. **Communication & Approach** — can the interviewer follow the reasoning live,
   and does the candidate take up feedback. Used as a **cap, not an additive**:
   a strong coder nobody can follow is a real-world reject (Meta).
3. **Code Quality & Correctness** — correct, clean, idiomatic code, *plus*
   proactive verification and edge-case reasoning (Meta treats testing as a top
   maturity signal; it's folded in here rather than split into its own row).
4. **Complexity Awareness** — big-O, comparing alternatives, justified
   optimization.

Scoring policy: each dimension is scored independently on a fixed 1–5 scale
with explicit anchors at 1/3/5. Any single 1/5 on problem understanding or
correctness should force a no-hire regardless of the other scores.

### Signals that actually predict interviewer scores
- **Speaking rate positive; filler words/sec negative; lexical richness
  positive** — Naim, Tanveer, Gildea & Hoque, *Automated Analysis and Prediction
  of Job Interview Performance*, IEEE T-AC 2018 (arXiv:1504.03425), r > 0.65,
  AUC ≈ 0.81. `[peer-reviewed, older]`
- **Structured rubrics roughly double predictive validity** — Sackett et al.
  2022; Wingate et al., IJSA 2025 meta-analysis. `[peer-reviewed]`
- **Question-specific anchors improve LLM scoring** — *Rubric Is All You Need*,
  ICER 2025. `[peer-reviewed]`

### Why filler rate is a soft signal only
- **Accent bias**: non-native accents draw lower competence ratings from
  stereotype, not comprehensibility — Maindidze et al., IJSA 2025 meta-analysis.
  `[peer-reviewed]` Automated systems amplify this.
- **Disfluency ≠ incompetence**: interview stress can halve measured performance
  independent of skill, and does so unevenly — Behroozi, Shirolkar, Barik &
  Parnin, *Does Stress Impact Technical Interview Performance?*, ESEC/FSE 2020.
  `[peer-reviewed, older]`
- So: anchor scoring on substance, never gate on delivery smoothness. The
  scorecard shows filler stats as coaching, with that caveat printed next to
  them.

## 2. Conversation dynamics → interviewer behavior, phases, Watchdog

- **Talk ratio ~40/60** (interviewer/candidate), quietest during coding — Gong's
  100k-call analysis puts top performers at 43/57. `[industry]`, transferred.
- **Protect think-time.** Ordinary conversation only tolerates ~1s of silence
  (Sacks/Schegloff/Jefferson 1974; Jefferson 1989) `[peer-reviewed]`, but
  stretching wait-time to ≥3s — up to 20–30s during genuinely hard thinking —
  improves reasoning (Rowe 1972/1986) `[peer-reviewed, foundational]`. The
  number-one failure mode of a naive interview bot is filling silence too early,
  which is why the silent-idle threshold is in the tens of seconds rather than
  a few.
- **The assistance dilemma**: help too late and you get frustration and wasted
  time; too early and the signal goes shallow — Koedinger & Aleven 2007.
  `[peer-reviewed]`
- **Hard-idle**: soft-flag at 30–45s with no keystrokes or speech; ITS work
  calls it "idle" at ≥2 min. Require at least two concurrent signals before
  intervening.
- **Wheel-spinning**: three or more failed attempts at the same sub-step with no
  forward change — Beck & Gong 2013. `[peer-reviewed, older]` This is what the
  thrash detector approximates from code snapshots.
- **Hint ladder**, one rung per ~60–90s: (0) reflective prompt → (1) point at
  where to look → (2) name the technique → (3) concrete next step → (4)
  bottom-out. **Bottom-out hints destroy both learning and assessment signal, so
  they're gated hard** — LAK26 2026, *Revisiting the Hint Button*.
  `[peer-reviewed, recent]`
- **Phase U-curve** over a 45-minute slot: intro and framing (high talk) →
  clarify → approach, no coding yet → coding (near-silent) → testing → wrap-up
  (high talk). This is the shape the reading → approach → implementing phase
  machine reproduces.

### Where each finding lands in the code

| Finding | Where |
|---|---|
| Anchored dimensions, communication-as-cap | `src/config.js` → `CRITERIA_DEFINITIONS`, `GRADING_RUBRIC` in `geminiClient.js` |
| Hint ladder, 60/40 talk ratio, protect silence | `INTERVIEWER_BEHAVIOR` in `geminiClient.js` |
| Per-interviewer hint posture | `hintPosture` in `src/config.js` |
| Phase U-curve | `PHASE_GUIDANCE` in `geminiClient.js`, phase machine in `InterviewScreen.js` |
| Silent-idle threshold, nudge cooldown | `WATCHDOG_*` constants in `InterviewScreen.js` |
| Wheel-spinning | `detectThrash` in `InterviewScreen.js` |
| Filler rate as soft coaching signal | `src/utils/fillerWords.js`, scorecard prompt, on-screen caveat |

### Citations
Naim et al. 2018 (IEEE T-AC); Behroozi et al. 2020 (ESEC/FSE); Thomas 2023 (ACM
C&C); *Rubric Is All You Need* ICER 2025; Wingate et al. 2025 (IJSA); Maindidze
et al. 2025 (IJSA); Rowe 1972/1986; Stivers et al. 2009 (PNAS);
Sacks/Schegloff/Jefferson 1974; Koedinger & Aleven 2007; Beck & Gong 2013;
*Revisiting the Hint Button* LAK26 2026; Gong.io talk-ratio analysis
`[industry]`; Pragmatic Engineer and interviewing.io hint norms `[industry]`.
