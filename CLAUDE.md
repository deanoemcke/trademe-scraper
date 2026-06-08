# Code Principles

**Named, callable functions only.** Write logic as named, exported functions.
Never embed meaningful operations in anonymous closures or plugin bodies — if it
can't be imported and called in isolation, it's not structured correctly.

**Single source of truth.** Never maintain two structures that mirror each other.
Derive one from the other on demand. Multiple update paths for the same value is
a design bug.

**Normalize at system boundaries.** At every external boundary, convert to
semantic types before data enters the application: numbers not display strings,
booleans not flag integers, named constants not magic values.

**Validate external data; trust internal data.** Assert the shape of data from
external systems at the ingestion point. Never validate internal function
arguments — trust the type system.

**No silent failures.** Don't swallow errors. Don't return a sentinel value from
a parse or lookup and let callers treat it as a pass. Make failures explicit.

**Resource limits on all external inputs.** Every input from an untrusted source
needs an explicit cap before processing: size limits, item count limits, timeouts.

**Atomic writes to persistent state.** If a write can be interrupted, write
all-or-nothing with a completion flag, or don't write until complete. Never serve
a partial write as a complete result.

**No side effects at module scope.** No I/O, connections, or registrations at
import time. All initialization must be called explicitly — this is what makes a
module unit-testable.

**State is data, not DOM.** Application state must be serializable plain objects.
Never read state back out of a rendered view — that couples rendering structure
to business logic and breaks silently on any template change.
