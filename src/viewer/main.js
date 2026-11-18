// The exported page: the plugin itself (data, view, rendering, physics, menus) running on the
// vault snapshot taken at export, with the Obsidian API provided by ./obsidian.
const obsidian = require('obsidian');

obsidian.installDomHelpers(window);

const { createApp } = require('./app');
const { renderMarkdown } = require('./markdown');
const { createFileSaver } = require('./file-save');
const { buildPageHtml } = require('../export-html');
const GraphFrontierPlugin = require('../main');
const { GRAPHFRONTIER_VIEW_TYPE } = require('../constants');

// Notes open in a panel at the left of the graph, rendered from the exported note text; the
// settings menu stays on the right.
function createNoteReader(app) {
  const panel = document.body.createDiv({ cls: 'graphfrontier-reader' });
  const header = panel.createDiv({ cls: 'graphfrontier-reader-header' });
  const title = header.createDiv({ cls: 'graphfrontier-reader-title' });
  const close = header.createEl('button', {
    cls: 'graphfrontier-reader-close',
    attr: { 'aria-label': 'Close' },
  });
  obsidian.setIcon(close, 'x');
  if (!close.firstChild) close.setText('×');
  const body = panel.createDiv({ cls: 'graphfrontier-reader-body markdown-rendered' });
  close.addEventListener('click', () => panel.removeClass('is-open'));
  return {
    async open(file) {
      title.setText(file.basename || file.path);
      title.setAttr('title', file.path);
      body.innerHTML = renderMarkdown(await app.vault.cachedRead(file)) || '<p>(empty)</p>';
      body.scrollTop = 0;
      panel.addClass('is-open');
    },
  };
}

async function boot() {
  const dataEl = document.getElementById('graphfrontier-data');
  const snapshot = JSON.parse(dataEl.textContent);
  // The page's own styles and script, to write the page again when it saves.
  const styles = document.querySelector('head style')?.textContent || '';
  const script = document.scripts[document.scripts.length - 1]?.textContent || '';
  const options = snapshot.exportOptions || { physics: true, settings: true };
  obsidian.setIconSet(snapshot.icons);
  document.body.addClass(...(snapshot.bodyClasses || []));

  let reader = null;
  let saver = null;
  const app = createApp(snapshot, {
    openNote: (file) => reader?.open(file),
    onPluginFileChange: () => saver?.schedule(),
  });
  reader = createNoteReader(app);
  const plugin = new GraphFrontierPlugin(app, snapshot.manifest);
  plugin.exportPage = options;
  await plugin.onload();
  if (!options.physics && plugin.data.view_state?.settings_tab === 'physics')
    plugin.data.view_state.settings_tab = 'groups';
  // Saves write the layouts into this page's own file.
  if (options.saves)
    saver = createFileSaver(() =>
      buildPageHtml({
        title: document.title,
        styles,
        script,
        data: { ...snapshot, pluginData: app.pluginData, pluginFiles: app.vault.adapter.files() },
      })
    );
  app.metadataCache.trigger('resolved');

  const leaf = {
    app,
    view: null,
    getViewState: () => ({ type: GRAPHFRONTIER_VIEW_TYPE }),
    setViewState: async () => {},
    openFile: (file) => app.workspace.getLeaf().openFile(file),
    detach: () => {},
  };
  const view = app.viewFactories.get(GRAPHFRONTIER_VIEW_TYPE)(leaf);
  leaf.view = view;
  app.leaves.push(leaf);
  app.workspace.activeLeaf = leaf;
  document.getElementById('graphfrontier-root').appendChild(view.containerEl);
  view.load();
  await view.onOpen();
}

boot().catch((error) => {
  document.body.createDiv({
    cls: 'graphfrontier-boot-error',
    text: `Cannot open graph: ${error?.message || error}`,
  });
  throw error;
});
