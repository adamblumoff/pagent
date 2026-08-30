Once you approach around 1000 LOC in a single file, do an audit of the file and modularize accordingly unless there is a good justification.

In general, I trust you with refactors as they don't effect the behavior of the application. However, on behavior making changes I want to be very involved and make sure we go slow and methodically.

Autoreview timeout should be set to 15 minutes, please do other work in parallel while waiting.

<!-- scope:rules:start -->
## Scope contribution rules

Read and follow `.scope/RULES.md` before
making or submitting changes.
<!-- scope:rules:end -->
