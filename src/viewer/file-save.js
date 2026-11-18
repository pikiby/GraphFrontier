const { Notice } = require('./obsidian');

function createFileSaver(getHtml) {
  let handle = null;
  // Installed viewers may already have the original file handle.
  window.launchQueue?.setConsumer(({ files }) => {
    if (files?.length === 1 && files[0].kind === 'file') handle = files[0];
  });
  let pending = Promise.resolve();
  let manual = false;

  function write() {
    pending = pending
      .catch(() => {})
      .then(async () => {
        const html = getHtml();
        const writable = await handle.createWritable();
        await writable.write(html);
        await writable.close();
      });
    return pending;
  }

  return {
    async saveLayout(capture) {
      if (manual) return false;
      manual = true;
      try {
        if (!handle && typeof window.showOpenFilePicker === 'function') {
          const [selected] = await window.showOpenFilePicker({ multiple: false });
          const file = await selected.getFile();
          const original = document.getElementById('graphfrontier-data')?.textContent;
          const contents = await file.text();
          if (
            !original ||
            !contents.includes(
              `<script id="graphfrontier-data" type="application/json">${original}</script>`
            )
          ) {
            new Notice('Select the original GraphFrontier HTML. No file was changed.');
            return false;
          }
          handle = selected;
        }
        if (!handle) {
          new Notice(
            'Not saved: the browser opened this HTML without access to write the original file.'
          );
          return false;
        }
        if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
          new Notice('Not saved: write permission was not granted.');
          return false;
        }
        if (!(await capture())) return false;
        await write();
        new Notice(`Saved into ${handle.name}`);
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        new Notice(`Cannot save the page: ${error?.message || error}`);
        return false;
      } finally {
        manual = false;
      }
    },
  };
}

module.exports = { createFileSaver };
