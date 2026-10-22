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
| `library.js` | **Library**: search, filters, question detail |
| `review.js` | **Review**: confirm themes, approve answers |
| `reps.js` | **Reps**: answer quality and consistency |
| `insights.js` | **Insights**: categories, interest map, data health |
| `calls.js` | **Calls**: delete a call, backups, start fresh |
| `logcall.js` | The **Log a call** dialog |
| `complete.js` | **Complete records** for older questions |
| `rules.js` | **Matching rules** and the matching check |
| `dialogs.js`, `import.js`, `ui.js`, `utils.js` | Dialogs, Excel/CSV and Salesforce import, shared helpers |
| `seed.js` | Starter data, used only if the dataset is empty |

## Uploading

Upload **all** files to the repo root, replacing the old ones. Eight files are new: `model.js`, `semantic.js`,
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

## How the numbers work

- **Accounts, not questions, rank themes and trends.** One talkative prospect can't dominate.
- **Gaps, the verdict bar and conflicts use only verdicts a person has set.** Suggested verdicts are never counted.
- **A conflict means two nearly identical questions with opposite answers.** That's a 70%+ match, one answer marked No and the other Yes or Partial. Different questions in the same theme can legitimately have different answers.
- **Repeat rate** is the share of questions whose theme already had an earlier question.
- **Questions without a date appear only under All time.** The Overview opens on All time until most questions have dates.

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

## Keyboard shortcuts

| Key | Action |
|---|---|
| `L` | Log a call |
| `N` | New single question |
| `/` | Search the library |
| `E` | Edit the selected question |
| `⌘K` or `Ctrl+K` | Quick find |
| `?` | List all shortcuts |
