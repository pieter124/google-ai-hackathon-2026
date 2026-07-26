# Research backing

Two literature passes drive the rubric anchors (`config.js` → `RUBRIC`), the
interviewer behavior prompt (`api/geminiClient.js`), and the Watchdog
thresholds (`config.js` → `WATCHDOG`). Evidence tiers: `[peer-reviewed]` vs
`[industry]` (practitioner sources, converging but not peer-reviewed). No
big-tech company publishes its literal internal rubric, and no peer-reviewed
study directly measures human technical-interviewer turn-taking — hard numbers
below are drawn from adjacent fields (conversation analysis, intelligent
tutoring systems, wait-time research) and applied by analogy. Treat thresholds
as tunable defaults, not validated constants.

## 1. Evaluation criteria → the 5-point rubric

Dimensions are the intersection of Google's four attributes, Meta's four
signals, and ML-system-design dimensions:

1. **Problem-solving & approach** — decode, decompose, iterate to optimal.
2. **Coding & correctness** — correct, clean, idiomatic code.
3. **Communication** — can the interviewer follow reasoning live; feedback uptake. **Used as a CAP, not additive** — a strong coder who can't be followed is a real-world reject (Meta).
4. **Verification & testing** — proactively tests, reasons about edge cases (Meta calls this a top maturity signal).
5. **Complexity & trade-offs** — big-O, compares alternatives, optimizes.

Scoring policy: score dimensions independently on a fixed 1–5 scale with
per-question anchors (question-specific rubrics measurably improve LLM code
evaluation). Any single 1/5 on problem-solving or correctness should force a
no-hire regardless of other scores.

### Measurable signals that predict interviewer scores
- **Speaking rate positive; filler words/sec negative; lexical richness positive** — Naim, Tanveer, Gildea & Hoque, *Automated Analysis and Prediction of Job Interview Performance*, IEEE T-AC 2018 (arXiv:1504.03425), r>0.65, AUC≈0.81. `[peer-reviewed, older]`
- **Structured rubrics ~double predictive validity** — Sackett et al. 2022; Wingate et al., IJSA 2025 meta-analysis. `[peer-reviewed]`
- **Question-specific rubrics improve LLM scoring** — *Rubric Is All You Need*, ICER 2025. `[peer-reviewed]`

### Fairness caveats (why filler rate is a SOFT signal only)
- **Accent bias**: non-native accents get lower competence ratings from stereotype, not comprehensibility — Maindidze et al., IJSA 2025 meta-analysis. `[peer-reviewed]` Automated systems amplify this.
- **Disfluency ≠ incompetence**: stress can halve measured performance independent of skill, worse for women — Behroozi, Shirolkar, Barik & Parnin, *Does Stress Impact Technical Interview Performance?*, ESEC/FSE 2020. `[peer-reviewed, older]`
- Therefore: anchor scoring on substance (problem-solving, correctness, testing), never gate on delivery smoothness. Present filler stats as coaching, not a filter.

## 2. Conversation dynamics → interviewer behavior + Watchdog

- **Talk ratio ~40/60** (interviewer/candidate); quietest during coding — Gong 100k-call analysis (top performers 43/57) `[industry]`, transferred.
- **Protect think-time**: ordinary conversation tolerates ~1s silence (Sacks/Schegloff/Jefferson 1974; Jefferson 1989) `[peer-reviewed]`, but extending wait-time to ≥3s (up to 20–30s during hard thinking) improves reasoning — Rowe 1972/1986. `[peer-reviewed, foundational]` The #1 naive-bot failure is filling silence too early.
- **Assistance dilemma**: help too late → frustration/wasted time; too early → shallow signal — Koedinger & Aleven 2007. `[peer-reviewed]`
- **Hard-idle**: soft-flag 30–45s no keystrokes/speech; "idle" at ≥2 min (ITS). Require ≥2 concurrent signals before intervening.
- **Wheel-spinning**: ≥3 failed attempts at the same sub-step with no forward change — Beck & Gong 2013. `[peer-reviewed, older]`
- **Hint ladder** (climb one rung per ~60–90s): (0) reflective prompt → (1) point at where to look → (2) name the technique → (3) concrete next step → (4) bottom-out. **Bottom-out hints destroy learning and assessment signal — gate hard** — LAK26 2026, *Revisiting the Hint Button*. `[peer-reviewed, recent]` Log depth-of-help-needed as a signal.
- **Phase U-curve** (45 min): intro/framing (high talk) → clarify → approach (no coding yet) → coding (near-silent) → testing → wrap-up (high talk).

### How this maps to code
| Finding | Where |
|---|---|
| 5 rubric dimensions + anchors, comms-as-cap | `config.js RUBRIC`, report prompt |
| Filler = soft coaching signal | `utils/fillerWords.js`, report prompt |
| Hint ladder + U-curve + protect silence | interviewer turn prompt |
| 35s silent-idle, 75s cooldown, 3s cadence | `config.js WATCHDOG` |

### Key citations
Naim et al. 2018 (IEEE T-AC); Behroozi et al. 2020 (ESEC/FSE); Thomas 2023 (ACM C&C); *Rubric Is All You Need* ICER 2025; Wingate et al. 2025 (IJSA); Maindidze et al. 2025 (IJSA); Rowe 1972/1986; Stivers et al. 2009 (PNAS); Sacks/Schegloff/Jefferson 1974; Koedinger & Aleven 2007; Beck & Gong 2013; *Revisiting the Hint Button* LAK26 2026; Gong.io talk-ratio `[industry]`; Pragmatic Engineer / interviewing.io hint norms `[industry]`.
