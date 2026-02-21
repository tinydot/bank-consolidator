# Bank Statement Consolidator — Notes for Claude

## Intentional Design Decisions

### No duplicate transaction detection
Duplicate transactions are **intentionally allowed**. Some banks legitimately issue
duplicate rows in their CSV exports (e.g. pending → posted transactions appearing
twice, or split transactions). Silently deduplicating would cause data loss for
these users. The user is responsible for managing duplicates via the Ignore button
or Import History tab.

Do **not** add automatic deduplication (hash-based or otherwise) without explicit
user request.
