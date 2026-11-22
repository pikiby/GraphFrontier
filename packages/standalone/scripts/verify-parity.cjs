'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const STANDALONE_ROOT = path.resolve(__dirname, '..');
const GF_ROOT = path.resolve(process.env.GF_ROOT || path.join(STANDALONE_ROOT, '..', '..'));

const { indexVault } = require('../src/indexer.cjs');
const { startStandaloneServer } = require('../src/server.cjs');

const gfRequire = createRequire(path.join(GF_ROOT, 'package.json'));
const { Client } = gfRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = gfRequire(
  '@modelcontextprotocol/sdk/client/streamableHttp.js'
);

function gitStatusPorcelain(dir) {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
}

function collectTags(cache) {
  const set = new Set();
  for (const t of cache?.tags || []) {
    if (t?.tag) set.add(String(t.tag).replace(/^#/, ''));
  }
  const fmTags = cache?.frontmatter?.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (t) set.add(String(t).replace(/^#/, '').trim());
  } else if (typeof fmTags === 'string') {
    for (const piece of fmTags.split(/[, ]+/)) {
      const cleaned = piece.replace(/^#/, '').trim();
      if (cleaned) set.add(cleaned);
    }
  }
  return set;
}

async function main() {
  const rawVault = process.argv[2] || process.env.GRAPHFRONTIER_PARITY_VAULT;
  if (!rawVault) throw new Error('Usage: node scripts/verify-parity.cjs <vaultDir>');
  const vaultDir = path.resolve(rawVault);
  if (!fs.existsSync(vaultDir)) throw new Error(`Vault not found: ${vaultDir}`);

  const pwPath = process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE;
  const chromePath = process.env.GRAPHFRONTIER_CHROMIUM;
  if (!pwPath || !chromePath) {
    throw new Error(
      'Set GRAPHFRONTIER_PLAYWRIGHT_MODULE and GRAPHFRONTIER_CHROMIUM to run Chromium parity verification.'
    );
  }
  const { chromium } = require(pwPath);

  const hasGit = fs.existsSync(path.join(vaultDir, '.git'));
  const gitBefore = hasGit ? gitStatusPorcelain(vaultDir) : null;

  const t0 = Date.now();
  const idx = indexVault(vaultDir);
  const indexMs = Date.now() - t0;

  let groundTruthReport = null;
  const htmlExportPath = path.join(vaultDir, 'graphfrontier-static.html');
  if (fs.existsSync(htmlExportPath)) {
    const rawHtml = fs.readFileSync(htmlExportPath, 'utf8');
    const match = rawHtml.match(
      /<script id="graphfrontier-data" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (match) {
      const snap = JSON.parse(match[1]);
      let tagMismatches = 0;
      let headingMismatches = 0;
      let mdLinkMatched = 0;
      let mdLinkMissed = 0;
      let mdLinkExtra = 0;
      let changedSinceExport = 0;

      for (const [p, truthCache] of Object.entries(snap.caches || {})) {
        const diskPath = path.join(vaultDir, p);
        const diskText = fs.existsSync(diskPath) ? fs.readFileSync(diskPath, 'utf8') : null;
        if (diskText !== (snap.texts?.[p] ?? null)) {
          changedSinceExport++;
          continue;
        }
        const ourCache = idx.caches[p];
        if (!ourCache) {
          tagMismatches++;
          headingMismatches++;
          continue;
        }
        const tTags = collectTags(truthCache);
        const oTags = collectTags(ourCache);
        if (tTags.size !== oTags.size || [...tTags].some((x) => !oTags.has(x))) {
          tagMismatches++;
        }
        const tHeads = (truthCache.headings || []).map((h) => `${h.level}:${h.heading}`);
        const oHeads = (ourCache.headings || []).map((h) => `${h.level}:${h.heading}`);
        if (JSON.stringify(tHeads) !== JSON.stringify(oHeads)) {
          headingMismatches++;
        }
      }

      for (const [src, targets] of Object.entries(snap.resolvedLinks || {})) {
        if (!src.toLowerCase().endsWith('.md')) continue;
        const diskPath = path.join(vaultDir, src);
        const diskText = fs.existsSync(diskPath) ? fs.readFileSync(diskPath, 'utf8') : null;
        if (diskText !== (snap.texts?.[src] ?? null)) continue;

        const truthMd = new Set(
          Object.keys(targets || {}).filter((t) => t.toLowerCase().endsWith('.md'))
        );
        const ourMd = new Set(
          Object.keys(idx.resolvedLinks[src] || {}).filter((t) => t.toLowerCase().endsWith('.md'))
        );
        for (const t of truthMd) {
          if (ourMd.has(t)) mdLinkMatched++;
          else mdLinkMissed++;
        }
        for (const t of ourMd) {
          if (!truthMd.has(t) && t !== src) mdLinkExtra++;
        }
      }

      assert.equal(tagMismatches, 0, `Expected 0 tag mismatches, got ${tagMismatches}`);
      assert.equal(headingMismatches, 0, `Expected 0 heading mismatches, got ${headingMismatches}`);
      assert.equal(mdLinkMissed, 0, `Expected 0 missed .md links, got ${mdLinkMissed}`);
      assert.equal(mdLinkExtra, 0, `Expected 0 extra .md links, got ${mdLinkExtra}`);

      groundTruthReport = {
        snapshotNotes: Object.keys(snap.caches || {}).length,
        indexedNotes: Object.keys(idx.caches).length,
        indexedFiles: idx.files.length,
        changedSinceExport,
        tagMismatches,
        headingMismatches,
        mdLinkMatched,
        mdLinkMissed,
        mdLinkExtra,
      };
    }
  }

  const dataJsonPath = path.join(vaultDir, '.obsidian/plugins/graphfrontier/data.json');
  const expectedData = fs.existsSync(dataJsonPath)
    ? JSON.parse(fs.readFileSync(dataJsonPath, 'utf8'))
    : null;
  let expectedLayout = expectedData;
  if (expectedData?.active_layout_name) {
    const activeLayoutPath = path.join(
      vaultDir,
      '.obsidian/plugins/graphfrontier/layouts',
      expectedData.active_layout_name
    );
    if (fs.existsSync(activeLayoutPath)) {
      expectedLayout = JSON.parse(fs.readFileSync(activeLayoutPath, 'utf8'));
    }
  }

  const srv = await startStandaloneServer({
    vaultDir,
    readOnly: true,
    port: 0,
    mcpPort: 0,
    watch: false,
  });

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });

  const pageErrors = [];
  const consoleErrors = [];
  let mcpClient = null;
  let browserMetrics;
  let mcpConfigSummary;

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__graphFrontierStandalone?.view?.isOpen === true,
      null,
      {
        timeout: 15000,
      }
    );
    // Allow initial frame/physics paint to complete cleanly.
    await new Promise((r) => setTimeout(r, 400));

    browserMetrics = await page.evaluate(async () => {
      const { app, plugin, view } = window.__graphFrontierStandalone;
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const rootEl = view.contentEl;
      const canvas = view.canvasEl;
      const ctx = canvas?.getContext('2d');
      let nonBgPixels = 0;
      if (canvas && ctx && canvas.width > 0 && canvas.height > 0) {
        const w = Math.min(canvas.width, 1440);
        const h = Math.min(canvas.height, 900);
        const data = ctx.getImageData(0, 0, w, h).data;
        const r0 = data[0];
        const g0 = data[1];
        const b0 = data[2];
        for (let i = 0; i < data.length; i += 40) {
          if (
            Math.abs(data[i] - r0) > 4 ||
            Math.abs(data[i + 1] - g0) > 4 ||
            Math.abs(data[i + 2] - b0) > 4
          ) {
            nonBgPixels++;
          }
        }
      }

      const historySvgCount = rootEl.querySelectorAll(
        '.graphfrontier-history-button:not(.graphfrontier-gear-button) svg'
      ).length;
      const gearSvgCount = rootEl.querySelectorAll('.graphfrontier-gear-button svg').length;
      const headerButtonCount = rootEl.querySelectorAll(
        '.graphfrontier-sidepanel-header-actions button'
      ).length;
      const listsCount = plugin.getNodeLists().length;
      const layoutNames = await plugin.listLayoutFileNames();
      const firstActiveLayout = plugin.getActiveLayoutFileName();
      const firstCounts = {
        nodes: view.nodes.length,
        edges: view.edges.length,
        pins: Object.keys(plugin.data.pins || {}).length,
        savedPositions: Object.keys(plugin.data.saved_positions || {}).length,
        groups: (plugin.data.groups || []).length,
        darkEnergy: (plugin.data.dark_energy || []).length,
        strongPull: Object.keys(plugin.data.strong_pull_nodes || {}).length,
      };

      // Switch to alternate layout if available and switch back cleanly.
      let switchedLayout = null;
      if (layoutNames.includes('test.json')) {
        await plugin.setActiveLayoutFile('test.json');
        switchedLayout = {
          active: plugin.getActiveLayoutFileName(),
          nodes: view.nodes.length,
          pins: Object.keys(plugin.data.pins || {}).length,
        };
        await plugin.setActiveLayoutFile(firstActiveLayout);
      }

      const afterRestoreCounts = {
        activeLayout: plugin.getActiveLayoutFileName(),
        nodes: view.nodes.length,
        pins: Object.keys(plugin.data.pins || {}).length,
      };

      // Test opening first note cleanly in Note Reader (do not inspect or return name/text).
      const mdFiles = app.vault.getMarkdownFiles();
      let readerOpened = false;
      if (mdFiles.length) {
        await app.workspace.getLeaf().openFile(mdFiles[0]);
        const readerEl = document.querySelector('.graphfrontier-reader.is-open');
        const bodyLen =
          readerEl?.querySelector('.graphfrontier-reader-body')?.textContent?.length || 0;
        readerOpened = !!readerEl && bodyLen > 0;
        readerEl?.querySelector('.graphfrontier-reader-close')?.click();
      }

      return {
        bodyBg,
        hasAtomClass: document.body.classList.contains('theme-dark'),
        canvasSize: { w: canvas?.width || 0, h: canvas?.height || 0 },
        nonBgPixels,
        historySvgCount,
        gearSvgCount,
        headerButtonCount,
        listsCount,
        layoutNames,
        firstActiveLayout,
        firstCounts,
        switchedLayout,
        afterRestoreCounts,
        readerOpened,
      };
    });

    assert.equal(pageErrors.length, 0, `Unexpected page errors: ${JSON.stringify(pageErrors)}`);
    assert.equal(
      consoleErrors.length,
      0,
      `Unexpected console errors: ${JSON.stringify(consoleErrors)}`
    );
    assert.ok(browserMetrics.canvasSize.w > 0 && browserMetrics.canvasSize.h > 0);
    assert.ok(
      browserMetrics.nonBgPixels > 20,
      'Expected non-blank rendered graph pixels on canvas'
    );
    assert.equal(browserMetrics.historySvgCount, 2, 'Expected Undo and Redo SVG icons in header');
    assert.equal(browserMetrics.gearSvgCount, 1, 'Expected Settings gear SVG icon in header');
    assert.equal(
      browserMetrics.headerButtonCount,
      4,
      'Expected 4 header control buttons (Undo, Redo, Show/Hide, Settings)'
    );
    assert.equal(
      browserMetrics.readerOpened,
      true,
      'Expected Note Reader to render note content cleanly'
    );

    if (expectedLayout) {
      assert.equal(browserMetrics.firstActiveLayout, expectedData.active_layout_name);
      assert.equal(browserMetrics.firstCounts.groups, expectedLayout.groups.length);
      assert.equal(browserMetrics.firstCounts.pins, Object.keys(expectedLayout.pins || {}).length);
      assert.equal(
        browserMetrics.firstCounts.savedPositions,
        Object.keys(expectedLayout.saved_positions || {}).length
      );
      assert.equal(
        browserMetrics.firstCounts.darkEnergy,
        (expectedLayout.dark_energy || []).length
      );
      assert.equal(
        browserMetrics.firstCounts.strongPull,
        Object.keys(expectedLayout.strong_pull_nodes || {}).length
      );
      assert.equal(browserMetrics.bodyBg, 'rgb(39, 43, 52)');
      assert.equal(browserMetrics.afterRestoreCounts.activeLayout, expectedData.active_layout_name);
      assert.equal(
        browserMetrics.afterRestoreCounts.pins,
        Object.keys(expectedLayout.pins || {}).length
      );
    }

    assert.equal(srv.mcpHost.enabled, true, 'Expected MCP host to be enabled');
    mcpClient = new Client({ name: 'verify-parity', version: '1.0.0' });
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(srv.mcpHost.url)));
    const views = await mcpClient.callTool({ name: 'list_views', arguments: {} });
    const viewRef = views.structuredContent.views[0];
    assert.ok(viewRef?.viewId);
    const cfg = await mcpClient.callTool({
      name: 'get_configuration',
      arguments: { viewId: viewRef.viewId },
    });
    const nodeListsRes = await mcpClient.callTool({ name: 'list_node_lists', arguments: {} });
    mcpConfigSummary = {
      layout: cfg.structuredContent.layout,
      groups: cfg.structuredContent.groups?.length || 0,
      nodeLists: nodeListsRes.structuredContent.lists?.length || 0,
      gravity: cfg.structuredContent.gravity?.length || 0,
      nodeCount: cfg.structuredContent.nodeCount || 0,
      edgeCount: cfg.structuredContent.edgeCount || 0,
    };
    assert.equal(mcpConfigSummary.layout, browserMetrics.firstActiveLayout);
    assert.equal(mcpConfigSummary.groups, browserMetrics.firstCounts.groups);
    assert.equal(mcpConfigSummary.gravity, browserMetrics.firstCounts.darkEnergy);
    assert.equal(mcpConfigSummary.nodeLists, browserMetrics.listsCount);
  } finally {
    if (mcpClient) await mcpClient.close().catch(() => {});
    await browser.close();
    await srv.close();
  }

  assert.equal(srv.stateStore.diskWrites, 0, 'Expected zero disk writes in read-only mode');
  if (hasGit) {
    const gitAfter = gitStatusPorcelain(vaultDir);
    assert.equal(gitAfter, gitBefore, 'Vault git working tree status must remain untouched');
  }

  console.log(
    JSON.stringify(
      {
        parityStatus: 'PASS',
        indexMs,
        groundTruthReport,
        browserMetrics,
        mcpConfigSummary,
        diskWrites: srv.stateStore.diskWrites,
        gitStatusUntouched: hasGit,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('PARITY VERIFICATION FAILED:', err);
  process.exit(1);
});
