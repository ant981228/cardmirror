/**
 * Geometry helper for the bottom-left "pill tray" — the fixed container
 * holding the dropzone and the send/receive pills (`.pmd-pill-tray`).
 */

/** Whether `clientX` falls within the pill tray's horizontal span (padded a
 *  little). Used to suppress the *downward* drag auto-scroll over that column,
 *  so dragging a card toward the dropzone / send / receive pills isn't fought
 *  by the document scrolling out from under the drop target. Returns false when
 *  the tray is absent or collapsed to zero width. */
export function pointerOverPillTrayColumn(clientX: number): boolean {
  const tray = document.querySelector('.pmd-pill-tray');
  if (!tray) return false;
  const r = tray.getBoundingClientRect();
  if (r.width === 0) return false;
  const pad = 24;
  return clientX >= r.left - pad && clientX <= r.right + pad;
}
