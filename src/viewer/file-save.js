// Saving the exported page into its own HTML file, so saved layouts live in the file itself.
// A browser writes a local file only through a file the user chose: the first save asks where
// (pick this page's file to replace it); later saves write there without asking. Browsers
// without that ability download an updated copy instead. Saves without a click (Autosave) only
// write once a file has been chosen.
const { Notice } = require('./obsidian');

function download(html, name) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pageFileName() {
  const name = decodeURIComponent(window.location.pathname.split('/').pop() || '');
  return /\.html?$/i.test(name) ? name : 'graphfrontier.html';
}

function createFileSaver(getHtml) {
  let handle = null;
  let timer = null;
  let askedForClick = false;
  const name = pageFileName();

  async function write(html) {
    const writable = await handle.createWritable();
    await writable.write(html);
    await writable.close();
  }

  async function save() {
    const html = getHtml();
    if (handle) {
      await write(html);
      return;
    }
    // Choosing a file needs a click; saves without one wait for it.
    if (!navigator.userActivation?.isActive) {
      if (!askedForClick)
        new Notice('Click Save layout once to choose the file this page saves into');
      askedForClick = true;
      return;
    }
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'HTML page', accept: { 'text/html': ['.html'] } }],
        });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        throw error;
      }
      await write(html);
      new Notice(`Saved into ${handle.name}`);
      return;
    }
    download(html, name);
    new Notice('This browser cannot write files: an updated copy of the page was downloaded');
  }

  return {
    schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        save().catch((error) => new Notice(`Cannot save the page: ${error?.message || error}`));
      }, 150);
    },
  };
}

module.exports = { createFileSaver };
