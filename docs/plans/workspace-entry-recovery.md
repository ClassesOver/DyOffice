# Web workspace entry recovery, phase 1

This restores document navigation entries, **not unsaved contents**. The existing
editor save/lease/recovery protocols are unchanged. Settings subpage routes and
editor dirty-state badges remain later work.

- An authenticated `/auth/me` response includes a non-secret deployment ID.
- `sessionStorage` namespace combines deployment and user IDs; only up to 20 file
  IDs, their order, and selected ID are serialized. No filenames, bytes, tokens,
  leases, editor URLs or commit receipts are persisted. Denied storage is optional.
- `#/file/<uuid>` or `#/home` carries the current entry. After session binding,
  restoration GETs each file through that bound authenticated reader and validates
  identity, format, exact revision URL and current capabilities. Missing files
  are omitted with a notice; revoked/changed sessions abort restoration.
- Only the selected restored editor mounts. Later activation mounts another editor;
  already mounted editors remain alive when hidden. A never-mounted entry can
  close without an editor guard; live native editors still require their guard.
- URL history navigation does not dispose any document. An active settings close
  guard may refuse navigation and the URL is restored. A latest-wins route
  sequence plus the tab-selection token fences late successes and errors, including
  a newer Home action, another tab selection, rejected navigation and unmount. Unknown files use the
  captured session-bound open path. Logout clears the snapshot only after success.

Neither stored hints nor URL IDs authorize access. Refresh cannot promise draft
recovery. Unknown commit results must still use the existing receipt protocol,
never automatically replay a mutation. Browser acceptance must include reload,
Back/Forward, user/deployment switch, missing files, unavailable storage, dirty
settings, live dirty editors, inactive lazy tabs and logout. Unit tests do not
substitute for these browser scenarios.
