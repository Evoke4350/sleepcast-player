/** Hand the listener a file to save. */
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  // Revoking in the same tick as click() can race the browser's own
  // download handoff and cancel it — hold the URL alive a beat longer.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
