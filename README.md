# Prospect Q&A Hub: Phase 1 (management review)

A build-free web app. Every file sits in one folder next to `index.html`, so it uploads to GitHub Pages as-is.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell, sign-in, navigation, icons |
| `app.css` | All styles, including dark mode and mobile |
| `app.js` | Startup, navigation, quick find (⌘K) and shortcuts |
| `config.js` | Firebase settings and which dataset to use |
| `sync.js` | Sign-in and Firestore sync (transactions) |
| `store.js` | App state, the data model, and every change |
| `model.js` | Themes, verdicts, periods and other derived views |
| `similarity.js` | Matching engine: by meaning, or by words as a fallback |
| `semantic.js`, `semantic-worker.js` | Runs the open AI model in a background worker and caches its results |
| `overview.js` | **Overview**, the home screen |
| `inbox.js` | **To do**: every decision waiting, with one-tap answers |
| `changes.js` | The **What changed** panel (Overview and meeting summary) |
| `summary.js` | **Meeting summary**: one printable page |
| `library.js` | **Library**: search, filters, question detail |
| `review.js` | **Review**: confirm themes, approve answers |
| `themes.js` | **Themes**: rename, approve, add/remove/move questions, merge, delete |
| `reps.js` | **Reps**: answer quality and consistency |
| `insights.js` | **Insights**: categories, interest map, data health |
| `calls.js` | **Calls**: delete a call, backups, start fresh |
| `logcall.js` | The **Log a call** dialog |
| `complete.js` | **Complete records** for older questions |
| `rules.js` | **Matching rules** and the matching check |
| `calibrate.js` | **Calibrate matching**: the labeling deck that tunes both thresholds |
| `dialogs.js`, `import.js`, `ui.js`, `utils.js` | Dialogs, Excel/CSV and Salesforce import, shared helpers |
| `seed.js` | Starter data, used only if the dataset is empty |

## Uploading

Upload **all** files to the repo root, replacing the old ones. Thirteen files are new: `changes.js`, `summary.js`, `inbox.js`, `calibrate.js`, `themes.js`, `model.js`, `semantic.js`,
`semantic-worker.js`, `overview.js`, `reps.js`, `calls.js`, `logcall.js` and `complete.js`.
Then hard-refresh (Ctrl+Shift+R).

If a file is missing, the page names it instead of showing “Loading…”.

## First steps after uploading

1. **Back up first.** Go to Calls › Download backup. It saves a restore file and an Excel copy.
2. **Complete records** (in the sidebar) brings your existing questions up to date:
   - **Accounts:** confirm the suggestions, for example Kash › COR3 and Chuck › Callan. #37 is Dita asking Kash for feedback; mark it as prospect feedback.
   - **Dates:** one date per conversation. This creates a call for each.
   - **Verdicts:** review each suggested group, untick anything wrong, then decide the rest one at a time.
     A verdict answers “can we do what was asked?”, so “Does it *have to*…? No, it’s optional” is a **Yes**.
   - **Themes:** give each suggested theme a short name, such as “QR codes” or “LMS pricing”, and untick questions that don’t belong.
3. **Import a Salesforce report** (Overview › Accounts) to add deal stages. Account names must match the report’s spelling.

## Smart matching

- **What it is.** Related questions are found by meaning, using an open AI model (all-MiniLM-L6-v2, Apache-2.0) that runs inside the browser. Questions are never sent anywhere.
- **First load.** The model downloads once, about 23 MB, from Hugging Face. The browser caches it, along with each question's result.
- **Fallback.** If the model can't load (for example, a network blocks `cdn.jsdelivr.net` or `huggingface.co`), the app uses word matching and shows “Word matching only” in the sidebar.
- **Names are removed first.** Account, contact and rep names, plus the words under Matching rules › Words to ignore, are stripped before matching. That stops two questions from matching just because both mention “COR3”.
- **Measured on your data at the 42% default:**
  - finds 8 of 9 pairs a manager would call related
  - wrongly matches 0 of 10 unrelated pairs
  - word matching found 0 of the 9
- **The matching check gets more reliable over time.** Matching rules shows the check live. Each Review decision adds a pair to it, and once there are 30 or more, it can recommend a threshold.

## What changed and the meeting summary

On the Overview, choose **Last 30 days** or **Last 90 days** to see **What changed** compared with the period before:

- **Rising and falling themes,** counted by accounts. A theme only qualifies when at least 2 accounts moved, so one busy prospect can't make a trend.
- **New themes:** first asked about this period.
- **New gaps and promises:** No, Partial and Roadmap verdicts set this period, with "first time" marked when the theme had none before.
- **Accounts with open items:** 2 or more open follow-ups or roadmap promises, right now.
- **Themes by deal stage:** how many accounts at each Salesforce stage asked about each theme. This needs an imported Salesforce report.

Every item links to the questions behind it.

**Meeting summary**, the button at the top of the Overview, puts all of that on one A4 page: What changed, the top 8 themes and the open follow-ups. Use **Print or save as PDF**. On paper each list shows its top 5, with "N more" noted.

**Excel export** (now "Export to Excel") still gives the full data behind the Overview.

## To do

**To do**, in the sidebar or in the phone's bottom bar, lists every decision waiting, most urgent first. A badge shows how many are left.

| Card | Your options |
|---|---|
| **Follow-ups** overdue or due within 3 days | Done, Snooze a week |
| **Answers disagree:** near-identical questions, one marked No and one Yes or Partial | Settle in Review, They don't conflict |
| **Possible duplicates** at the "same question" threshold | Same question, Different questions |
| **Fits a theme:** a question without a theme that matches an existing one | Add to theme, Not this theme |
| **New theme?** A suggested group | name and Confirm theme, Not related |
| **Verdicts:** the suggested one is outlined | one tap to set, or Later (hidden 14 days) |

- **Undo:** every action offers Undo.
- **Hidden cards stay hidden:** dismissed and snoozed cards stay hidden for everyone, so the list doesn't keep asking the same thing.
- **Answers feed calibration:** duplicate answers become matching examples, and theme decisions do too.
- **The "All" view shows 5 verdicts,** then one card that opens the rest, so a backlog doesn't bury everything else.

## Calibrating matching

The app uses two thresholds:

| Threshold | Default | Used for |
|---|---|---|
| **Same topic** | 42% | grouping questions into themes and suggesting them for review |
| **Same question** | 70% | duplicate warnings, import close matches and conflict flags |

**Calibrate matching** (under Settings) shows 20 pairs the app is least sure about, chosen near either threshold:
- **Answering:** tap **Same question**, **Same topic** or **Unrelated**, or press 1, 2 or 3. Press S to skip and Backspace to go back. Scores stay hidden so they don't sway you.
- **Recommendations:** after each deck, the app suggests a better threshold once there are enough examples. It needs 10 related and 10 unrelated for themes, and 5 "same question" and 10 others for duplicates. Recommendations lean strict, because a missed match is cheaper than a wrong one.
- **Reviewing your labels:** every example appears in Matching rules › Matching check, scored live. You can change or remove each one.
- **Fitting to themes:** a new question is compared against the whole theme, using a blend of its closest member and the theme's average. On your data that found 30 of 30 held-out theme members, against 26 of 30 for closest-question alone. Theme suggestions use a bar 6 points above the same-topic threshold.

## How the numbers work

- **Accounts, not questions, rank themes and trends.** One talkative prospect can't dominate.
- **Gaps, the verdict bar and conflicts use only verdicts a person has set.** Suggested verdicts are never counted.
- **A conflict means two nearly identical questions with opposite answers.** That's a 70%+ match, one answer marked No and the other Yes or Partial. Different questions in the same theme can legitimately have different answers.
- **Repeat rate** is the share of questions whose theme already had an earlier question.
- **Questions without a date appear only under All time.** The Overview opens on All time until most questions have dates.

## Library: row size and bulk actions

- **Comfortable or Compact** (above the results): Compact shows one line per question, with its theme tag, category, verdict and approval. Each browser remembers the choice.
- **Sort by** newest or oldest, number (high to low or low to high), category, theme, account or rep. Theme sort puts questions without a theme last.
- **Tick questions to act on several at once:**
  - **Shift+click** ticks a range.
  - **The box above the list** ticks everything matching your current search and filters.
- **The action bar** offers Move to theme (including New theme… and Remove from theme), Change category (including New category…) and Delete. Each one can be undone right after, and the ticks clear afterwards so the next batch starts fresh.

## Editing themes

- **Themes** in the sidebar lists every confirmed theme, and below them the suggested ones, each with a Confirm button.
- **For the selected theme you can:**
  - rename it (press Enter to save)
  - pick the approved answer
  - remove questions, or tick several and move them to another theme or a new one
  - add questions from “Likely belongs here” or by searching
  - merge it into another theme, or delete it
- **Delete keeps the questions;** they just leave the theme. Removing, moving, merging and deleting can all be undone right after.
- **Each question in the Library has a Theme picker,** so you can move it, start a new theme with it, or remove it, without leaving the Library.
- **Each theme has a color, set on the Themes screen from 16 options.** That color appears everywhere the theme's questions do:
  - a tag and a left edge on Library rows
  - a dot in the theme picker, on the Themes list and on the Overview
  - a top border on Review cards

  New themes get the next unused color automatically, spaced out so early themes are easy to tell apart. The theme name always appears next to its color. The palette leaves out pure red, which means "needs attention" elsewhere in the app.
- **Every add or remove is also a matching example.** It's added to the matching check, so tuning gets better as you curate.

## Deleting and starting fresh

- **Delete a call** (Calls page): you choose whether its questions go too, or stay without a date. Undo is offered right after.
- **Start fresh** (Calls page): requires downloading a backup and typing “start fresh”. You can keep categories, rules and approved answers.
- **Restore from backup** (Calls page): replaces the current data for everyone with the backup file.
- **To test with clean data without touching the live dataset,** set `DATA_DOC = "data-staging"` in `config.js`. Your Firestore rules must allow that path.

## Compatibility

- **Same Firebase project and document.** New fields are optional, and calls, themes and settings are stored inside `insightConfig`, which the original app preserves when it saves.
- **Older questions keep working without the new fields.**
- **Retire the original app once you switch.** It saves the whole dataset at once and can overwrite edits made here.
- **Firestore caps a document at 1 MB.** Expect room for roughly 1,500–2,000 questions. Phase 2 moves to one document per question.

## Phones

- **Every screen fits the phone's width,** with no sideways scrolling and no zooming out.
- **Text fields and dropdowns use 16px text,** so iPhones don't zoom in when you tap them. Pinch-to-zoom still works if you want it.
- **Dialogs open full screen,** with their buttons pinned to the bottom so the keyboard can't hide them.
- **Wide tables, like the interest map, scroll sideways inside their own box.**

## Keyboard shortcuts

| Key | Action |
|---|---|
| `L` | Log a call |
| `N` | New single question |
| `/` | Search the library |
| `E` | Edit the selected question |
| `⌘K` or `Ctrl+K` | Quick find |
| `?` | List all shortcuts |
