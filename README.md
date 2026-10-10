# Prospect Q&A Hub

A build-free web app. Upload the folder as-is to any static host (GitHub Pages works).

## Files

All files live in one folder, next to `index.html`. Upload them all to the root of the repo.

| File | What it does |
|---|---|
| `index.html` | Page shell, sign-in screen, icon sprite |
| `app.css` | All styles, including dark mode and mobile |
| `config.js` | Firebase settings and which dataset document to use |
| `sync.js` | Sign-in and Firestore sync |
| `store.js` | App state and every data change |
| `similarity.js` | Question matching engine |
| `ui.js` | Notifications and dialogs |
| `dialogs.js` | Question editor, categories, account |
| `import.js` | Excel and CSV import |
| `app.js` | Startup, navigation, quick find and shortcuts |
| `library.js`, `review.js`, `insights.js`, `rules.js` | The four sections |
| `seed.js` | Starter data, loaded only if the dataset is empty |

## Deploying to staging

1. Create a new GitHub repo (or a branch) and upload this folder's contents to its root.
2. Turn on GitHub Pages for it.
3. In the Firebase console, open **Authentication › Settings › Authorized domains** and add the staging domain (for example `yourname.github.io`). Sign-in fails on unlisted domains.
4. Choose which data staging uses (`config.js`, `DATA_DOC`):
   - `"data"` (default) reads and writes the **live dataset**. This is safe to run alongside the old app because the data format is unchanged.
   - `"data-staging"` keeps staging separate. Your Firestore rules must allow that path, and the first sign-in fills it with the starter data.

## Compatibility with the old app

- Same Firebase project, same document, same fields. The old app keeps working.
- New fields such as `standard`, `variantOf`, `related` and `importBatch` are ignored by the old app, and it preserves them.
- One caveat: the old app overwrites the whole dataset on every save. If someone saves in the old app while someone else works in the new one, the old app's save can undo the other person's recent change. Retire the old app once staging checks out.

## What changed

- **Faster load.** These were removed:
  - Tailwind's in-browser compiler, replaced by one CSS file
  - Font Awesome, replaced by inline icons
  - the spreadsheet library on startup; it now loads only when you import or export

  Firestore also caches locally, so repeat visits open instantly.
- **Safer.**
  - Every piece of user text is escaped before display, which closes a script-injection hole.
  - Saves use Firestore transactions, so simultaneous edits no longer overwrite each other.
- **Better matching.** The engine now uses:
  - word stemming and an editable abbreviation list
  - your overlap and Jaccard weights, which the old app ignored outside the inspector
  - a minimum number of shared terms
  - grouping that doesn't chain unrelated questions together
- **Five tabs became four sections:**
  - **Library:** search, filters and a detail panel
  - **Review:** combines the old Compare, Suggested Clusters and Formula Inspector
  - **Insights:** replaces Frequency
  - **Matching rules:** replaces the Insights Engine
- **New features:**
  - standard answers and variants
  - linked questions
  - a duplicate warning while typing a new question
  - delete and import with undo
  - import column matching and near-duplicate review
  - an interest map
  - data-health fixes
  - ⌘K quick find and keyboard shortcuts (`?` lists them)
  - password reset
  - mobile layout and dark mode

## Testing checklist

- [ ] Sign in, sign out, reset password
- [ ] Add, edit and delete a question, then undo the delete
- [ ] Search, filter by category, prospect and rep, and export the view
- [ ] Review: save a standard answer, link questions, dismiss a suggestion, then reopen it from Resolved
- [ ] Import a spreadsheet, check the close matches, then undo the import
- [ ] Change a matching rule and confirm the Review count updates
- [ ] Open the app on a phone
- [ ] Edit in two browsers at once and confirm both changes stick
