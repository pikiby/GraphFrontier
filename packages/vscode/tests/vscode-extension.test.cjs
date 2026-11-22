'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const VSCODE_ROOT = path.resolve(__dirname, '..');
const GF_ROOT = path.resolve(process.env.GF_ROOT || path.join(VSCODE_ROOT, '..', '..'));

const { WorkspaceGraphController } = require(
  path.join(VSCODE_ROOT, 'dist', 'workspace-controller.cjs')
);
const {
  VIEW_COLUMN_ACTIVE,
  VIEW_COLUMN_BESIDE,
  findExistingFileColumn,
  pickNoteTargetColumn,
  pickGlobalTargetColumn,
  pickSubgraphTargetColumn,
} = require(path.join(VSCODE_ROOT, 'src', 'tab-routing.cjs'));
const gfRequire = createRequire(path.join(GF_ROOT, 'package.json'));
const { Client } = gfRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = gfRequire(
  '@modelcontextprotocol/sdk/client/streamableHttp.js'
);

const WEBVIEW_CSS = fs.readFileSync(path.join(VSCODE_ROOT, 'dist', 'webview.css'), 'utf8');
const WEBVIEW_JS_PATH = path.join(VSCODE_ROOT, 'dist', 'webview-bundle.js');

async function mountSimulatedWebview(
  browser,
  controller,
  opts,
  { pageErrors, consoleErrors, viewport = { width: 1280, height: 800 } }
) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (err) => pageErrors.push(`${opts.panelId}: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`${opts.panelId}: ${msg.text()}`);
  });

  let closed = false;
  const attachment = controller.attachPanel({
    ...opts,
    postMessage: (msg) => {
      if (closed || page.isClosed()) return;
      void page.evaluate((m) => window.postMessage(m, '*'), msg).catch(() => {});
    },
  });

  await page.exposeFunction('__gfHostSend', (msg) => {
    void attachment.onMessage(msg);
  });

  await page.setContent(
    '<!DOCTYPE html><html><head><meta charset="utf-8" /><style id="gf-vault-theme"></style></head><body class="vscode-dark"><div id="graphfrontier-root"></div></body></html>'
  );
  await page.addStyleTag({ content: WEBVIEW_CSS });
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({
      postMessage: (msg) => window.__gfHostSend(msg),
      getState: () => null,
      setState: () => {},
    });
  });
  await page.addScriptTag({ path: WEBVIEW_JS_PATH });
  await page.waitForFunction(() => window.__graphFrontierVscode?.view?.isOpen === true, null, {
    timeout: 15000,
  });
  await attachment.readyPromise;

  const dispose = async () => {
    closed = true;
    attachment.onDispose();
    if (!page.isClosed()) await page.close().catch(() => {});
  };

  return { page, ...attachment, dispose };
}

test(
  'VS Code multi-panel extension: global graph, adjacent file open, split subgraphs, local sidebar tracking, and MCP routing',
  {
    skip: !process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE || !process.env.GRAPHFRONTIER_CHROMIUM,
  },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-vsc-e2e-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.writeFileSync(path.join(dir, 'alpha.md'), '---\ntags: [core]\n---\n# Alpha\nSee [[beta]].');
    fs.writeFileSync(path.join(dir, 'beta.md'), '# Beta\nLinks [[alpha]] and [[gamma]].');
    fs.writeFileSync(path.join(dir, 'gamma.md'), '# Gamma\nBack to [[beta]].');

    const { chromium } = require(process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({
      executablePath: process.env.GRAPHFRONTIER_CHROMIUM,
      headless: true,
    });
    t.after(() => browser.close());

    const openedFiles = [];
    const openedLocalPanels = [];
    const mountedPanels = [];
    const subgraphByKey = new Map();
    const pageErrors = [];
    const consoleErrors = [];
    let subSeq = 0;

    let controller;
    controller = new WorkspaceGraphController({
      workspaceDir: dir,
      storageMode: 'graphfrontier',
      preferObsidianTheme: false,
      mcpEnabled: true,
      mcpPort: 0,
      host: {
        async openFileInEditor(absPath, sourcePanelId, relPath) {
          openedFiles.push({ relPath, sourcePanelId });
        },
        async openLocalPanel({ path: targetPath }) {
          openedLocalPanels.push(targetPath);
        },
        async openSubgraphPanel({ subgraphId, layout }) {
          const key = `${layout || ''}::${subgraphId}`;
          if (subgraphByKey.has(key)) return subgraphByKey.get(key);
          const panelId = `vsc-subgraph-${++subSeq}`;
          const mounted = await mountSimulatedWebview(
            browser,
            controller,
            { panelId, kind: 'subgraph', subgraphId, layout },
            { pageErrors, consoleErrors }
          );
          mountedPanels.push(mounted);
          subgraphByKey.set(key, mounted);
          return mounted;
        },
      },
    });
    await controller.initMcp();
    controller.notifyActiveFileChanged('alpha.md');

    let mcpClient = null;
    try {
      const globalMounted = await mountSimulatedWebview(
        browser,
        controller,
        { panelId: 'vsc-global-1', kind: 'global' },
        { pageErrors, consoleErrors }
      );
      mountedPanels.push(globalMounted);

      const globalNodeCount = await globalMounted.page.evaluate(
        () => window.__graphFrontierVscode.view.nodes.length
      );
      assert.equal(globalNodeCount, 3);

      // Verify clicking/opening a note delegates to VS Code editor host.
      await globalMounted.page.evaluate(async () => {
        const { app } = window.__graphFrontierVscode;
        const f = app.vault.getAbstractFileByPath('alpha.md');
        await app.workspace.getLeaf(true).openFile(f);
      });
      assert.equal(openedFiles.length, 1);
      assert.equal(openedFiles[0].relPath, 'alpha.md');

      // Verify `Show local graph` on a node opens ONLY Local Graph split panel and never opens the note itself.
      await globalMounted.page.evaluate(async () => {
        const { view } = window.__graphFrontierVscode;
        await view.openLocalGraphForNode('beta.md');
      });
      assert.equal(openedLocalPanels.includes('beta.md'), true);
      assert.equal(
        openedFiles.some((entry) => entry.relPath === 'beta.md'),
        false
      );

      // Mount Local Graph sidebar and verify it tracks active editor changes.
      const localMounted = await mountSimulatedWebview(
        browser,
        controller,
        { panelId: 'vsc-local-sidebar', kind: 'local', initialFile: 'alpha.md' },
        { pageErrors, consoleErrors }
      );
      mountedPanels.push(localMounted);

      assert.equal(
        await localMounted.page.evaluate(() => window.__graphFrontierVscode.view.localPath),
        'alpha.md'
      );
      controller.notifyActiveFileChanged('gamma.md');
      await localMounted.page.waitForFunction(
        () => window.__graphFrontierVscode.view.localPath === 'gamma.md'
      );

      // Create a Subgraph in Global panel and open it in a dedicated split VS Code panel.
      const subId = 'graphfrontier:subgraph:core';
      await globalMounted.page.evaluate(async (id) => {
        const { view } = window.__graphFrontierVscode;
        view.setSubgraph({
          id,
          name: 'Core Pair',
          members: ['alpha.md', 'beta.md'],
        });
        await view.openSubgraphSeparately(id);
      }, subId);

      const subKey = `${controller.stateStore.getPluginData().active_layout_name}::${subId}`;
      const subMounted = subgraphByKey.get(subKey);
      assert.ok(subMounted, 'Expected subgraph split panel to be created');
      const subMeta = await subMounted.page.evaluate(() => ({
        scopeId: window.__graphFrontierVscode.view.subgraphScope?.id,
        nodeCount: window.__graphFrontierVscode.view.nodes.length,
      }));
      assert.equal(subMeta.scopeId, subId);
      assert.equal(subMeta.nodeCount, 2);

      // Verify HTTP MCP lists BOTH global and subgraph panels and routes pin_nodes cleanly.
      assert.equal(controller.getMcpStatus().enabled, true);
      mcpClient = new Client({ name: 'vscode-test', version: '1.0.0' });
      await mcpClient.connect(
        new StreamableHTTPClientTransport(new URL(controller.getMcpStatus().url))
      );
      const listed = await mcpClient.callTool({ name: 'list_views', arguments: {} });
      assert.equal(listed.structuredContent.views.length, 2);
      const globalRef = listed.structuredContent.views.find((v) => !v.subgraphId);
      const subRef = listed.structuredContent.views.find((v) => v.subgraphId === subId);
      assert.ok(globalRef && subRef);

      // In parent Global graph, alpha.md & beta.md are collapsed into `subId`, while subRef holds alpha.md & beta.md.
      const globalPinRes = await mcpClient.callTool({
        name: 'pin_nodes',
        arguments: {
          viewId: globalRef.viewId,
          contextToken: globalRef.contextToken,
          nodeIds: ['gamma.md'],
          mode: 'exact',
        },
      });
      assert.equal(globalPinRes.isError, undefined, JSON.stringify(globalPinRes));

      // Shared state-sync increments subRef's contextToken cleanly when globalRef mutates pins; refresh via list_views.
      const listedAfterGlobalPin = await mcpClient.callTool({ name: 'list_views', arguments: {} });
      const subRef2 = listedAfterGlobalPin.structuredContent.views.find(
        (v) => v.subgraphId === subId
      );
      assert.ok(subRef2);

      const subPinRes = await mcpClient.callTool({
        name: 'pin_nodes',
        arguments: {
          viewId: subRef2.viewId,
          contextToken: subRef2.contextToken,
          nodeIds: ['alpha.md'],
          mode: 'exact',
        },
      });
      assert.equal(subPinRes.isError, undefined, JSON.stringify(subPinRes));

      // Verify state-sync preserved BOTH pins across panels and on disk.
      await globalMounted.page.waitForFunction(
        () => window.__graphFrontierVscode.plugin.data?.pins?.['alpha.md']?.mode === 'exact'
      );
      assert.equal(controller.stateStore.getPluginData()?.pins?.['alpha.md']?.mode, 'exact');
      assert.equal(controller.stateStore.getPluginData()?.pins?.['gamma.md']?.mode, 'exact');
      assert.ok(fs.existsSync(path.join(dir, '.graphfrontier', 'data.json')));
    } finally {
      if (mcpClient) await mcpClient.close().catch(() => {});
      for (const m of mountedPanels) await m.dispose();
      await controller.dispose();
    }

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  }
);

test(
  'VS Code readOnly smoke test on vault preserves git status and matches Obsidian layout',
  {
    skip:
      !process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE ||
      !process.env.GRAPHFRONTIER_CHROMIUM ||
      !process.env.GRAPHFRONTIER_PARITY_VAULT ||
      !fs.existsSync(
        path.join(
          process.env.GRAPHFRONTIER_PARITY_VAULT,
          '.obsidian',
          'plugins',
          'graphfrontier',
          'data.json'
        )
      ),
  },
  async (t) => {
    const dpDir = process.env.GRAPHFRONTIER_PARITY_VAULT;
    const gitBefore = execFileSync('git', ['-C', dpDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    const expectedData = JSON.parse(
      fs.readFileSync(path.join(dpDir, '.obsidian/plugins/graphfrontier/data.json'), 'utf8')
    );
    const expectedLayoutPath = path.join(
      dpDir,
      '.obsidian/plugins/graphfrontier/layouts',
      expectedData.active_layout_name
    );
    const expectedLayout = fs.existsSync(expectedLayoutPath)
      ? JSON.parse(fs.readFileSync(expectedLayoutPath, 'utf8'))
      : expectedData;

    const { chromium } = require(process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({
      executablePath: process.env.GRAPHFRONTIER_CHROMIUM,
      headless: true,
    });
    t.after(() => browser.close());

    const pageErrors = [];
    const consoleErrors = [];
    const controller = new WorkspaceGraphController({
      workspaceDir: dpDir,
      storageMode: 'readOnly',
      preferObsidianTheme: true,
      mcpEnabled: false,
      mcpPort: 0,
    });

    const mounted = await mountSimulatedWebview(
      browser,
      controller,
      { panelId: 'vsc-dp-global', kind: 'global' },
      { pageErrors, consoleErrors, viewport: { width: 1440, height: 900 } }
    );
    try {
      await new Promise((r) => setTimeout(r, 300));
      const metrics = await mounted.page.evaluate(() => {
        const { plugin, view } = window.__graphFrontierVscode;
        const rootRect = document.getElementById('graphfrontier-root').getBoundingClientRect();
        const sidepanelEl = document.querySelector('.graphfrontier-sidepanel');
        const simStyle = document.createElement('style');
        simStyle.textContent = '::-webkit-scrollbar { width: 10px; height: 10px; }';
        document.head.appendChild(simStyle);
        const sidepanelOffsetWidth = sidepanelEl?.offsetWidth || 0;
        const sidepanelClientWidth = sidepanelEl?.clientWidth || 0;
        const prevMaxHeight = sidepanelEl ? sidepanelEl.style.maxHeight : '';
        if (sidepanelEl) sidepanelEl.style.maxHeight = '220px';
        const scrolledSidepanelClientWidth = sidepanelEl?.clientWidth || 0;
        if (sidepanelEl) sidepanelEl.style.maxHeight = prevMaxHeight;
        simStyle.remove();

        const tabLabels = Array.from(document.querySelectorAll('.graphfrontier-settings-tab')).map(
          (b) => b.textContent.trim()
        );
        const hasGearButton = !!document.querySelector('.graphfrontier-gear-button');

        const hasBorderControl = !!view.sideControls.get('node_border_width')?.input;
        const backingScaleMin = view.backingScale >= 1;
        const fileTypesHeader =
          document.querySelector('.graphfrontier-file-types-header')?.textContent?.trim() || '';

        return {
          bodyBg: getComputedStyle(document.body).backgroundColor,
          activeLayout: plugin.getActiveLayoutFileName(),
          nodes: view.nodes.length,
          edges: view.edges.length,
          pins: Object.keys(plugin.data.pins || {}).length,
          savedPositions: Object.keys(plugin.data.saved_positions || {}).length,
          listsCount: (plugin.nodeListStore?.lists || []).length,
          groups: (plugin.data.groups || []).length,
          rootW: rootRect.width,
          rootH: rootRect.height,
          sidepanelOffsetWidth,
          sidepanelClientWidth,
          scrolledSidepanelClientWidth,
          tabLabels,
          hasGearButton,
          hasBorderControl,
          backingScaleMin,
          fileTypesHeader,
        };
      });
      assert.equal(metrics.activeLayout, expectedData.active_layout_name);
      assert.equal(metrics.pins, Object.keys(expectedLayout.pins || {}).length);
      assert.equal(metrics.groups, (expectedLayout.groups || []).length);
      assert.ok(metrics.nodes >= 1000 && metrics.edges >= 1000);
      assert.ok(metrics.savedPositions >= 3000);
      assert.ok(metrics.listsCount >= 1);
      assert.ok(metrics.rootW >= 1400 && metrics.rootH >= 850);
      assert.equal(metrics.bodyBg, 'rgb(39, 43, 52)');
      assert.equal(metrics.sidepanelOffsetWidth, 250);
      assert.ok(metrics.sidepanelClientWidth >= 243);
      assert.ok(metrics.scrolledSidepanelClientWidth >= 243);
      assert.deepEqual(metrics.tabLabels, ['Groups', 'Display', 'Physics', 'Files']);
      assert.equal(metrics.hasGearButton, true);
      assert.equal(metrics.hasBorderControl, true);
      assert.equal(metrics.backingScaleMin, true);
      assert.equal(metrics.fileTypesHeader, 'Filter by file type');
    } finally {
      await mounted.dispose();
      await controller.dispose();
    }

    assert.equal(controller.stateStore.diskWrites, 0);
    const gitAfter = execFileSync('git', ['-C', dpDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    assert.equal(gitAfter, gitBefore);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  }
);

test(
  'VS Code unlinked markdown repo visibility, localSidebar isolation, CTA openGlobalPanel, and show_only_groups override',
  {
    skip: !process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE || !process.env.GRAPHFRONTIER_CHROMIUM,
  },
  async (t) => {
    // 1. Fresh unlinked markdown repo (no .obsidian, zero wikilinks): Global Graph must show unlinked docs.
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-vsc-unlinked-'));
    t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo\nStandalone readme.');
    fs.writeFileSync(path.join(repoDir, 'docs', 'guide.md'), '# Guide\nStandalone guide.');

    const { chromium } = require(process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({
      executablePath: process.env.GRAPHFRONTIER_CHROMIUM,
      headless: true,
    });
    t.after(() => browser.close());

    const pageErrors = [];
    const consoleErrors = [];
    let openGlobalCalls = 0;

    const controller = new WorkspaceGraphController({
      workspaceDir: repoDir,
      storageMode: 'auto',
      mcpEnabled: false,
      mcpPort: 0,
      host: {
        async openGlobalPanel() {
          openGlobalCalls += 1;
        },
      },
    });

    // Mount localSidebar FIRST with no active file.
    const localMounted = await mountSimulatedWebview(
      browser,
      controller,
      { panelId: 'vsc-local-first', kind: 'local', initialFile: '' },
      { pageErrors, consoleErrors, viewport: { width: 320, height: 640 } }
    );
    try {
      const btnVisible = await localMounted.page.evaluate(() => {
        const btn = document.querySelector('.gf-vsc-open-global-btn');
        return !!btn && getComputedStyle(btn).display !== 'none';
      });
      assert.equal(btnVisible, true);
      await localMounted.page.click('.gf-vsc-open-global-btn');
      assert.equal(openGlobalCalls, 1);

      // localSidebar must never create .graphfrontier/data.json or layouts/data.json before Global opens.
      assert.equal(fs.existsSync(path.join(repoDir, '.graphfrontier', 'data.json')), false);
      assert.equal(controller.stateStore.diskWrites, 0);

      // Opening Global Graph on the unlinked repo shows all 2 markdown files (hide_orphans defaults to false).
      const globalMounted = await mountSimulatedWebview(
        browser,
        controller,
        { panelId: 'vsc-global-unlinked', kind: 'global' },
        { pageErrors, consoleErrors }
      );
      try {
        const globalNodes = await globalMounted.page.evaluate(
          () => window.__graphFrontierVscode.view.nodes.length
        );
        assert.equal(globalNodes, 2);
      } finally {
        await globalMounted.dispose();
      }
    } finally {
      await localMounted.dispose();
      await controller.dispose();
    }

    // 2. Vault with show_only_groups: true where focused note is NOT in any group:
    // Local Graph must override show_only_groups = false and still show the active note!
    const groupedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-vsc-grouped-'));
    t.after(() => fs.rmSync(groupedDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(groupedDir, '.obsidian', 'plugins', 'graphfrontier'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(groupedDir, 'tagged.md'), '---\ntags: [keep]\n---\n# Tagged');
    fs.writeFileSync(path.join(groupedDir, 'ungrouped.md'), '# Ungrouped\nStandalone doc.');
    fs.writeFileSync(
      path.join(groupedDir, '.obsidian', 'plugins', 'graphfrontier', 'data.json'),
      JSON.stringify({
        active_layout_name: 'data.json',
        settings: { show_only_groups: true, hide_orphans: false },
        groups: [{ query: 'tag:#keep', color: '#ff0000', enabled: true }],
      })
    );

    const groupedController = new WorkspaceGraphController({
      workspaceDir: groupedDir,
      storageMode: 'auto',
      mcpEnabled: false,
      mcpPort: 0,
    });
    const groupedLocal = await mountSimulatedWebview(
      browser,
      groupedController,
      { panelId: 'vsc-local-ungrouped', kind: 'local', initialFile: 'ungrouped.md' },
      { pageErrors, consoleErrors, viewport: { width: 320, height: 640 } }
    );
    try {
      const localCheck = await groupedLocal.page.evaluate(() => {
        const { view } = window.__graphFrontierVscode;
        const visible = view.getFilterVisibleNodeIds?.();
        const visibleCount =
          visible instanceof Set
            ? view.nodes.filter((n) => visible.has(n.id)).length
            : view.nodes.length;
        return {
          localPath: view.localPath,
          showOnlyGroups: view.plugin.data.settings.show_only_groups,
          nodes: view.nodes.map((n) => n.id),
          visibleCount,
        };
      });
      assert.equal(localCheck.localPath, 'ungrouped.md');
      assert.equal(localCheck.showOnlyGroups, false);
      assert.deepEqual(localCheck.nodes, ['ungrouped.md']);
      assert.equal(localCheck.visibleCount, 1);
      assert.equal(fs.existsSync(path.join(groupedDir, '.graphfrontier', 'data.json')), false);
      assert.equal(groupedController.stateStore.diskWrites, 0);
    } finally {
      await groupedLocal.dispose();
      await groupedController.dispose();
    }

    // 3. Isolated VS Code storageMode ('vscode') ignores .obsidian plugins data AND separates local-view.json from data.json.
    const isolatedStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-vsc-isolated-state-'));
    t.after(() => fs.rmSync(isolatedStateDir, { recursive: true, force: true }));
    const isolatedController = new WorkspaceGraphController({
      workspaceDir: groupedDir,
      storageMode: 'vscode',
      stateDir: isolatedStateDir,
      mcpEnabled: false,
      mcpPort: 0,
    });
    const isolatedGlobal = await mountSimulatedWebview(
      browser,
      isolatedController,
      { panelId: 'vsc-isolated-global', kind: 'global' },
      { pageErrors, consoleErrors }
    );
    const isolatedLocal = await mountSimulatedWebview(
      browser,
      isolatedController,
      { panelId: 'vsc-isolated-local', kind: 'local', initialFile: 'tagged.md' },
      { pageErrors, consoleErrors, viewport: { width: 320, height: 640 } }
    );
    try {
      const globalGroups = await isolatedGlobal.page.evaluate(
        () => (window.__graphFrontierVscode.plugin.data.groups || []).length
      );
      assert.equal(globalGroups, 0, 'vscode storageMode must not inherit Obsidian groups');

      await isolatedLocal.page.evaluate(async () => {
        const { view } = window.__graphFrontierVscode;
        view.plugin.data.settings.show_grid = false;
        await view.saveCurrentLayout({ silent: true });
      });
      assert.equal(fs.existsSync(path.join(groupedDir, '.graphfrontier')), false);
      assert.ok(fs.existsSync(path.join(isolatedStateDir, 'data.json')));
      assert.ok(fs.existsSync(path.join(isolatedStateDir, 'local-view.json')));
      const globalSaved = JSON.parse(
        fs.readFileSync(path.join(isolatedStateDir, 'data.json'), 'utf8')
      );
      assert.equal(
        globalSaved.settings.show_grid,
        true,
        'local save must not overwrite global data.json'
      );

      // Reopen Local Graph and confirm saved local state was restored independently of Obsidian/Global data.
      const isolatedLocal2 = await mountSimulatedWebview(
        browser,
        isolatedController,
        { panelId: 'vsc-isolated-local-2', kind: 'local', initialFile: 'tagged.md' },
        { pageErrors, consoleErrors, viewport: { width: 320, height: 640 } }
      );
      try {
        const restoredGrid = await isolatedLocal2.page.evaluate(
          () => window.__graphFrontierVscode.view.plugin.data.settings.show_grid
        );
        assert.equal(restoredGrid, false);
      } finally {
        await isolatedLocal2.dispose();
      }
    } finally {
      await isolatedGlobal.dispose();
      await isolatedLocal.dispose();
      await isolatedController.dispose();
    }

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  }
);

test('tab routing never opens notes, global graph, or subgraphs inside Local Graph split column', () => {
  const twoCols = [
    { viewColumn: 1, tabs: [] },
    { viewColumn: 2, tabs: [] },
  ];
  // [Full Graph Col 1] | [Local Graph Col 2], click on Full Graph -> stays in Col 1, never Col 2!
  assert.equal(
    pickNoteTargetColumn({ groups: twoCols, localCol: 2, sourceCol: 1, isFromLocal: false }),
    1
  );

  // [Full Graph Col 1] | [Local Graph Col 2], click on Local Graph -> opens in Col 1!
  assert.equal(
    pickNoteTargetColumn({ groups: twoCols, localCol: 2, sourceCol: 2, isFromLocal: true }),
    1
  );

  // [Notes Col 1] | [Full Graph Col 2] | [Local Graph Col 3], click on Full Graph -> opens in Col 1 (never Col 3)!
  const threeCols = [
    { viewColumn: 1, tabs: [] },
    { viewColumn: 2, tabs: [] },
    { viewColumn: 3, tabs: [] },
  ];
  assert.equal(
    pickNoteTargetColumn({ groups: threeCols, localCol: 3, sourceCol: 2, isFromLocal: false }),
    1
  );

  // [Local Graph ONLY Col 1], click on Local Graph -> opens beside (-2) in a new unlocked split!
  assert.equal(
    pickNoteTargetColumn({
      groups: [{ viewColumn: 1, tabs: [] }],
      localCol: 1,
      sourceCol: 1,
      isFromLocal: true,
    }),
    VIEW_COLUMN_BESIDE
  );

  // findExistingFileColumn prefers non-local groups, falling back to localCol only if user placed file only there.
  const groupsWithDup = [
    { viewColumn: 2, tabs: [{ input: { uri: { scheme: 'file', fsPath: '/vault/a.md' } } }] },
    { viewColumn: 1, tabs: [{ input: { uri: { scheme: 'file', fsPath: '/vault/a.md' } } }] },
  ];
  assert.equal(
    findExistingFileColumn({ groups: groupsWithDup, localCol: 2, targetNorm: '/vault/a.md' }),
    1
  );
  assert.equal(
    findExistingFileColumn({
      groups: [
        {
          viewColumn: 2,
          tabs: [{ input: { uri: { scheme: 'file', fsPath: '/vault/only-local.md' } } }],
        },
      ],
      localCol: 2,
      targetNorm: '/vault/only-local.md',
    }),
    2
  );

  // Global Graph focused on Local Graph (Col 2) routes to non-local Col 1 instead of covering Local Graph.
  assert.equal(
    pickGlobalTargetColumn({
      groups: twoCols,
      activeCol: 2,
      localCol: 2,
      requestedCol: VIEW_COLUMN_ACTIVE,
    }),
    1
  );

  // Subgraph opened from Full Graph (Col 1) while Local Graph is in Col 2 routes to Col 1 instead of Col 2!
  assert.equal(pickSubgraphTargetColumn({ groups: twoCols, globalCol: 1, localCol: 2 }), 1);
});
