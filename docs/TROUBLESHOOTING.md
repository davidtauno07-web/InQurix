# Indexing and search troubleshooting

## Where things live
- The local index is `index.db` (SQLite, plus `-wal`/`-shm` files) in the app data folder. Set `INQURIX_USER_DATA` to use a different folder.
- **Sources & indexing** shows each folder's document count, failed files with the reason, the recent event log, and the pause/resume control.
- To rebuild from scratch, quit InQurix and delete `index.db*`. Original documents are never modified.

## A file is not indexed
| Symptom | Cause / fix |
|---|---|
| File missing entirely | Only authorised folders are indexed. Hidden files are skipped unless "include hidden" is on for that source. `node_modules`, VCS folders and similar are always skipped. Check the folder's exclusion patterns. |
| Status `failed` | The reason is shown in the failures list: e.g. a password-protected or encrypted file, a corrupt archive, or a parse error. Executables and macro-enabled Office files are refused on purpose. |
| Status `partial` | Some content was extracted, but a limit was hit or part of the file could not be read (for example, OCR was skipped after 50 pages). |
| Status `unavailable` | The file could not be read (permissions, offline network drive). It is retried on the next scan. Files under a folder that cannot be read are kept, not deleted. |
| Large files | Default limits: 200 MB per file, 2,000 PDF pages, 200,000 sheet rows, ZIP ≤ 5,000 entries / 500 MB uncompressed / ratio 200, 120 s per file. |
| Scanned PDFs or images have no text | OCR uses bundled English Tesseract data. Very low-quality scans may produce little text. |
| Edits not picked up | The watcher reindexes changed files within seconds. Periodic reconciliation also catches changes made while the app was closed. Check that indexing is not paused and that the source is enabled. |

## Search finds nothing, or the wrong thing
- Disabled sources are excluded from search and investigations until they are re-enabled.
- Quoted text (`"automatic renewal"`) must appear exactly. Remove the quotes for a broader search.
- Filters such as `type:pdf` narrow results. Remove them to widen the search.
- Semantic (meaning-based) matching needs the local model (`npm run models -w @inqurix/desktop` in development; it is bundled in installers) and at least two words. Invoice numbers, amounts, account numbers and emails are matched exactly, including zero-padded variants (`INV-1048` / `INV-01048`).
- Every result shows *why* it matched (exact reference, amount, words, meaning) and where (page, sheet/cell, slide, email part).

## Quick Search shortcut does nothing
- Another application, or a second InQurix instance, may own `Ctrl+Shift+Space` / `⌘+Shift+Space`. A banner in the workspace reports this; choose another shortcut in Settings.
