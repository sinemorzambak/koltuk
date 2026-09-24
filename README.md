# Koltuk

A single-page life management system with an AI weekly check-in.
No build step, no framework, no bundler — one HTML file, a Postgres database,
and one serverless function that keeps an API key off the client.

**Live demo:** _(add your Netlify URL)_ · opens with sample data, nothing is stored
**UI language:** Turkish

---

## Why it exists

Most planning tools fail the same way: they ask for daily input, and the day you
skip is the day you stop opening them. Koltuk is built around the opposite
constraint — **one 15-minute check-in per week**, and nothing else is mandatory.

Three rules are enforced by the product, not by willpower:

| Rule | How the UI enforces it |
|---|---|
| Only 3 active life areas | Goals and commitments are generated per area — there is no fourth slot to type into |
| 70% is enough | The weekly stat is "days with 3+ anchors", not a streak; the target line sits at 70%, not 100% |
| One untracked day a week | A "flow day" toggle excludes the day from every calculation instead of marking it failed |

New wants go to a **Park** list with a visible 30-day counter rather than into the plan.

## The AI part

The Sunday check-in sends the last weeks of tracked data — anchor completion per
habit, flow days, commitment outcomes, the month's theme and goals, the Park
queue with ages, and upcoming milestones — to Claude, and gets back a structured
response:

- an honest 2–3 sentence read of the week, grounded in the actual numbers
- **one** suggested commitment per active area, accepted with a single click
- a ready-to-send sentence for declining something that doesn't fit this month
- the one thing that is quietly drifting

The model is called with a **tool schema**, so the response is typed JSON rather
than prose to parse — the UI renders it directly and the "accept" button writes
straight back into the week's commitments.

```
browser ──POST──► Supabase Edge Function ──► Anthropic Messages API
  │                (holds ANTHROPIC_API_KEY)         │
  │                                          tool_choice: check_in
  └──◄── typed JSON: summary / commitments / no_sentence / watch
```

The API key lives in a Supabase secret and never reaches the browser — which is
what makes it safe to publish this repo and host the page publicly.

**The provider is swappable and the whole thing runs on free tiers.** The
function picks its provider from whichever key is present — Gemini, Groq,
OpenRouter or Anthropic — and normalises three different structured-output
mechanisms (Anthropic tool calls, Gemini `responseSchema`, OpenAI-compatible
JSON mode) behind one `callModel(system, text, schema)` signature. If no model
name is configured it queries the provider's model list and picks a suitable
one, so the function keeps working when model IDs change underneath it.

**And it degrades to nothing.** With no key configured at all, the function
returns 501 and the browser falls back to `localCheckIn()` — a rule-based
version of the same output, built from the same data, rendered in the same UI
with a "written locally" note. The AI is an upgrade to the wording, never a
dependency.

## The meal planner

The Sunday check-in also builds the week's food, because a plan that ignores what
you eat gets abandoned by Wednesday. It is a small constraint solver, not a list:

- recipes carry `slot` (breakfast/lunch/dinner), `minutes`, `protein_g`, `tags`
  and structured `ingredients` (`item`, `qty`, `unit`, `aisle`)
- generation applies real kitchen rules — a dish tagged `artikverir` ("makes
  leftovers") makes the next day's lunch prefer `artiktan`; the Sunday `hazirlik`
  batch-cook feeds Monday and Tuesday lunches; weekdays prefer `hizli`; a
  `hazirlik` recipe can never land on a non-prep day, and a leftovers recipe can
  never be chosen when there are no leftovers
- the shopping list is derived, not written: ingredients across the chosen
  recipes are summed by item and unit, grouped by aisle, and split into two trips
  so the fresh produce for the back half of the week is bought later

Today's three meals, with steps, appear on the Today tab — the payoff for the
fifteen minutes spent on Sunday.

## Architecture

```
index.html                          one file: markup, styles, logic
  ├─ config block                   empty keys → demo mode with seeded data
  ├─ data layer                     same interface over Supabase or in-memory demo
  ├─ render functions               plain DOM, no virtual DOM, no reactivity library
  └─ one delegated click handler    every interaction routed by data-* attributes

supabase/functions/koltuk-ai/       Deno edge function, CORS + typed tool call
```

**Demo mode** is the interesting bit for a public repo: leaving the Supabase
config empty swaps the data layer for an in-memory implementation with generated
sample history, including a canned AI response. The same file therefore serves as
both a working personal app and a clickable public demo, with no personal data in
the repository.

### Data model (Postgres / Supabase)

| Table | Holds |
|---|---|
| `koltuk_days` | one row per day: anchor checkboxes, flow-day flag, one-line note |
| `koltuk_weeks` | commitments, rituals, win/drag, energy, closed flag |
| `koltuk_months` | theme, three goals, end-of-month review |
| `koltuk_settings` | the three active areas as JSON |
| `koltuk_park` | parked wants with timestamps for the 30-day rule |
| `design_tasks` | checklist items grouped by category |
| `menu_recipes` | recipes with tags and structured ingredients |
| `menu_weeks` | the week's plan and its derived shopping list |

Every table carries a `user_id` defaulting to `auth.uid()`, with a row-level
security policy of `user_id = auth.uid()` for authenticated users only — the
anon key in the page grants nothing on its own.

## Running it

1. Create a Supabase project and the tables above.
2. Deploy the function. A key is optional — without one the app uses its local
   fallback; with one you get the written version:
   ```bash
   supabase functions deploy koltuk-ai

   # any one of these (the first three have free tiers):
   supabase secrets set GEMINI_API_KEY=...        # aistudio.google.com
   supabase secrets set GROQ_API_KEY=...          # console.groq.com
   supabase secrets set OPENROUTER_API_KEY=...    # use a ":free" model
   supabase secrets set ANTHROPIC_API_KEY=...     # paid

   # optional overrides
   supabase secrets set AI_PROVIDER=gemini
   supabase secrets set AI_MODEL=...
   ```
3. Fill `SUPABASE_URL` and `SUPABASE_KEY` at the top of the script block in `index.html`.
4. Serve `index.html` anywhere static (Netlify drag-and-drop is enough).

Leave step 3 out and it runs as the demo.

## Notes

- Written to be read: no build output, so what is in the repo is exactly what runs.
- The companion app, [Defter](../defter), tracks the debt this system links to.
  Both share the same design tokens in two themes — Koltuk at night, Defter on paper.
