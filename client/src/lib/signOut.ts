// -----------------------------------------------------------------------------
// A deliberate sign-out is not a session that DIED mid-use.
//
// AuthGate (App.tsx) keeps the page tree mounted behind a login overlay when
// the server stops honouring the cookie — that protects a half-finished
// sitting from a machine restart. Settings → Sign out is the opposite case:
// the person leaving chose to, nothing on screen needs protecting, and on a
// shared machine the next person must NOT inherit the last person's
// half-answered paper, revealed answers or form drafts behind the password
// box. So the sign-out marks itself here, and the next time the gate sees the
// session locked it takes its cold-load branch — the plain login screen, the
// page tree unmounted — instead of the "your session expired" overlay.
//
// Module state, read once: the flag is consumed by the render that acts on
// it, so a later, genuine expiry gets the overlay again.
// -----------------------------------------------------------------------------

let pending = false;

/** Called by the sign-out action, BEFORE the auth status is refetched. */
export function markDeliberateSignOut(): void {
  pending = true;
}

/** True exactly once after markDeliberateSignOut(); false otherwise. */
export function takeDeliberateSignOut(): boolean {
  const p = pending;
  pending = false;
  return p;
}
