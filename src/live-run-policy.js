// A forward-only collection must not make retrospective history requests or
// judge its new window using gaps already present in the shared archive.
export function liveRunPolicy(forwardOnly = false) {
  return {
    forwardOnly,
    startupCatchup: !forwardOnly,
    reconnectCatchup: !forwardOnly,
    shutdownCatchup: !forwardOnly,
    requireWholeArchiveContiguous: !forwardOnly,
  };
}
