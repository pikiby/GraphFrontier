'use strict';

const nodeCrypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');

const { WorkspaceGraphController } = require('./workspace-controller.cjs');
const {
  findExistingFileColumn,
  pickNoteTargetColumn,
  pickGlobalTargetColumn,
  pickSubgraphTargetColumn,
} = require('./tab-routing.cjs');

function getWebviewHtml(webview, extensionUri, title = 'GraphFrontier') {
  const nonce = nodeCrypto.randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview-bundle.js')
  );
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const safeTitle = String(title)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="${styleUri}" />
  <style id="gf-vault-theme"></style>
</head>
<body>
  <div id="graphfrontier-root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getWorkspaceDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return '';
  return folders[0].uri.fsPath;
}

function findActiveWorkspaceFilePath() {
  const docUri = vscode.window.activeTextEditor?.document?.uri;
  if (docUri?.scheme === 'file' && docUri.fsPath) {
    return docUri.fsPath;
  }
  const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
  const uri = input?.uri || input?.modified;
  if (uri?.scheme === 'file' && uri.fsPath) {
    return uri.fsPath;
  }
  return '';
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('graphfrontier');
  return {
    storageMode: cfg.get('storageMode', 'vscode'),
    preferObsidianTheme: cfg.get('preferObsidianTheme', false),
    mcpEnabled: cfg.get('mcpEnabled', true),
  };
}

class GraphFrontierExtensionHost {
  constructor(context) {
    this.context = context;
    this.controller = null;
    this.controllerWorkspace = '';
    this.globalPanel = null;
    this.localTabPanel = null;
    this.subgraphPanels = new Map();
    this.panelInstances = new Map();
    this.panelSeq = 0;
    this.reindexTimer = null;
    this.watcher = null;
  }

  async ensureController() {
    const workspaceDir = getWorkspaceDir();
    if (!workspaceDir) return null;
    if (this.controller && this.controllerWorkspace === workspaceDir) {
      return this.controller;
    }
    if (this.controller) await this.disposeController();

    const cfg = readConfig();
    const version = String(this.context.extension?.packageJSON?.version || '0.9.7');
    const baseStorageUri = this.context.storageUri || this.context.globalStorageUri;
    const fallbackHash = nodeCrypto
      .createHash('sha1')
      .update(workspaceDir)
      .digest('hex')
      .slice(0, 12);
    const stateDir =
      cfg.storageMode === 'vscode'
        ? this.context.storageUri?.fsPath ||
          (baseStorageUri
            ? path.join(baseStorageUri.fsPath, `ws-${fallbackHash}`)
            : path.join(workspaceDir, '.vscode', 'graphfrontier'))
        : cfg.storageMode === 'workspace'
          ? path.join(workspaceDir, '.vscode', 'graphfrontier')
          : null;

    const controller = new WorkspaceGraphController({
      workspaceDir,
      storageMode: cfg.storageMode,
      stateDir,
      preferObsidianTheme: cfg.preferObsidianTheme,
      mcpEnabled: cfg.mcpEnabled,
      version,
      host: {
        openFileInEditor: (absPath, sourcePanelId) => this.openFileInEditor(absPath, sourcePanelId),
        openExternalUrl: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        openSubgraphPanel: (opts) => this.openSubgraphPanel(opts),
        openLocalPanel: (opts) => this.openLocalTabPanel(opts),
        openGlobalPanel: () => this.openGlobalPanel(vscode.ViewColumn.Active),
      },
    });
    const activeFsPath = findActiveWorkspaceFilePath();
    if (activeFsPath) {
      controller.notifyActiveFileChanged(activeFsPath);
    }
    await controller.initMcp();

    this.controller = controller;
    this.controllerWorkspace = workspaceDir;
    this.setupWatcher(controller);
    return controller;
  }

  setupWatcher(controller) {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    const schedule = (uri) => {
      const rel = controller.toWorkspaceRelPath(uri?.fsPath);
      if (!rel) return;
      if (this.reindexTimer) clearTimeout(this.reindexTimer);
      this.reindexTimer = setTimeout(() => {
        this.reindexTimer = null;
        controller.triggerReindex();
      }, 300);
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,canvas}');
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.watcher = watcher;
  }

  wirePanel(
    webview,
    { kind, subgraphId = null, layout = null, initialFile = '' },
    panelObj = null
  ) {
    const controller = this.controller;
    const panelId = `vsc-${kind}-${++this.panelSeq}`;
    const attachment = controller.attachPanel({
      panelId,
      kind,
      subgraphId,
      layout,
      initialFile,
      postMessage: (msg) => webview.postMessage(msg),
    });
    if (panelObj) this.panelInstances.set(panelId, panelObj);

    const msgDisp = webview.onDidReceiveMessage((msg) => {
      void attachment.onMessage(msg);
    });
    return {
      panelId,
      attachment,
      dispose: () => {
        msgDisp.dispose();
        this.panelInstances.delete(panelId);
        attachment.onDispose();
      },
    };
  }

  getLocalPanelColumn() {
    return this.localTabPanel?.viewColumn || null;
  }

  async openFileInEditor(absPath, sourcePanelId) {
    const targetUri = vscode.Uri.file(absPath);
    const targetNorm = path.resolve(absPath);
    const groups = vscode.window.tabGroups?.all || [];
    const localCol = this.getLocalPanelColumn();
    const existingCol = findExistingFileColumn({
      groups,
      localCol,
      targetNorm,
      normalizePath: (p) => path.resolve(p),
    });
    if (existingCol) {
      await vscode.window.showTextDocument(targetUri, {
        viewColumn: existingCol,
        preview: false,
        preserveFocus: false,
      });
      return;
    }
    const panel = this.panelInstances.get(sourcePanelId);
    const viewColumn = pickNoteTargetColumn({
      groups,
      localCol,
      sourceCol: panel?.viewColumn || null,
      isFromLocal: !!(panel && panel === this.localTabPanel),
    });
    await vscode.window.showTextDocument(targetUri, {
      viewColumn,
      preview: false,
      preserveFocus: false,
    });
  }

  async openGlobalPanel(viewColumn = vscode.ViewColumn.Active) {
    const controller = await this.ensureController();
    if (!controller) {
      vscode.window.showInformationMessage(
        'Open a folder or workspace first to use GraphFrontier.'
      );
      return null;
    }
    if (this.globalPanel) {
      this.globalPanel.reveal(this.globalPanel.viewColumn || viewColumn);
      return this.globalPanel;
    }
    const targetCol = pickGlobalTargetColumn({
      groups: vscode.window.tabGroups?.all || [],
      activeCol: vscode.window.tabGroups?.activeTabGroup?.viewColumn || null,
      localCol: this.getLocalPanelColumn(),
      requestedCol: viewColumn,
    });
    const panel = vscode.window.createWebviewPanel(
      'graphfrontier.global',
      `GraphFrontier: ${controller.currentIndex.vaultName}`,
      targetCol,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    const wired = this.wirePanel(panel.webview, { kind: 'global' }, panel);
    panel.webview.html = getWebviewHtml(panel.webview, this.context.extensionUri, panel.title);
    panel.onDidDispose(() => {
      wired.dispose();
      if (this.globalPanel === panel) this.globalPanel = null;
    });
    this.globalPanel = panel;
    return { panel: wired.attachment.panel, readyPromise: wired.attachment.readyPromise };
  }

  async openSubgraphPanel({ subgraphId, layout, name }) {
    const controller = await this.ensureController();
    if (!controller) throw new Error('Workspace is not open.');
    const key = `${layout || ''}::${subgraphId}`;
    const existing = this.subgraphPanels.get(key);
    if (existing) {
      existing.vsPanel.reveal(existing.vsPanel.viewColumn || vscode.ViewColumn.Beside);
      return {
        panel: existing.wired.attachment.panel,
        readyPromise: existing.wired.attachment.readyPromise,
      };
    }
    const title = `Subgraph: ${name || subgraphId}`;
    const targetCol = pickSubgraphTargetColumn({
      groups: vscode.window.tabGroups?.all || [],
      globalCol: this.globalPanel?.viewColumn || null,
      localCol: this.getLocalPanelColumn(),
    });
    const vsPanel = vscode.window.createWebviewPanel('graphfrontier.subgraph', title, targetCol, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    });
    vsPanel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    const wired = this.wirePanel(
      vsPanel.webview,
      { kind: 'subgraph', subgraphId, layout },
      vsPanel
    );
    vsPanel.webview.html = getWebviewHtml(vsPanel.webview, this.context.extensionUri, title);
    vsPanel.onDidDispose(() => {
      wired.dispose();
      if (this.subgraphPanels.get(key)?.vsPanel === vsPanel) {
        this.subgraphPanels.delete(key);
      }
    });
    this.subgraphPanels.set(key, { vsPanel, wired });
    return { panel: wired.attachment.panel, readyPromise: wired.attachment.readyPromise };
  }

  async openLocalTabPanel({ path: targetPath } = {}) {
    const controller = await this.ensureController();
    if (!controller) {
      vscode.window.showInformationMessage(
        'Open a folder or workspace first to use GraphFrontier.'
      );
      return null;
    }
    const rel =
      controller.toWorkspaceRelPath(targetPath) ||
      controller.toWorkspaceRelPath(findActiveWorkspaceFilePath()) ||
      controller.activeEditorPath;
    if (rel) controller.notifyActiveFileChanged(rel, { force: true });

    if (this.localTabPanel) {
      this.localTabPanel.reveal(this.localTabPanel.viewColumn || vscode.ViewColumn.Beside);
      return this.localTabPanel;
    }

    const vsPanel = vscode.window.createWebviewPanel(
      'graphfrontier.local',
      'Local GraphFrontier',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      }
    );
    vsPanel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    const wired = this.wirePanel(
      vsPanel.webview,
      { kind: 'local', initialFile: rel || '' },
      vsPanel
    );
    vsPanel.webview.html = getWebviewHtml(
      vsPanel.webview,
      this.context.extensionUri,
      vsPanel.title
    );
    this.localTabPanel = vsPanel;

    let lockedGroup = false;
    const allGroups = vscode.window.tabGroups?.all || [];
    const activeTabs = vscode.window.tabGroups?.activeTabGroup?.tabs || [];
    if (allGroups.length > 1 && activeTabs.length <= 1) {
      try {
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        lockedGroup = true;
      } catch {
        // Ignore if host version lacks group lock command.
      }
    }

    vsPanel.onDidDispose(() => {
      wired.dispose();
      if (this.localTabPanel === vsPanel) this.localTabPanel = null;
      if (lockedGroup) {
        setTimeout(() => {
          const groups = vscode.window.tabGroups?.all || [];
          if (groups.length > 1) {
            for (const g of groups) {
              if ((g.tabs?.length || 0) === 0) {
                void vscode.window.tabGroups.close(g).then(undefined, () => {});
              }
            }
          }
        }, 60);
      }
    });
    return vsPanel;
  }

  async disposeController() {
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.globalPanel) {
      this.globalPanel.dispose();
      this.globalPanel = null;
    }
    if (this.localTabPanel) {
      this.localTabPanel.dispose();
      this.localTabPanel = null;
    }
    for (const entry of [...this.subgraphPanels.values()]) {
      entry.vsPanel.dispose();
    }
    this.subgraphPanels.clear();
    if (this.controller) {
      await this.controller.dispose();
      this.controller = null;
      this.controllerWorkspace = '';
    }
  }
}

async function activate(context) {
  const host = new GraphFrontierExtensionHost(context);
  if (getWorkspaceDir()) {
    void host.ensureController();
  }

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.text = '$(type-hierarchy-sub) GraphFrontier';
  statusBarItem.tooltip = 'Open Workspace GraphFrontier';
  statusBarItem.command = 'graphfrontier.openGraph';
  const syncStatusBar = () => {
    if (getWorkspaceDir()) statusBarItem.show();
    else statusBarItem.hide();
  };
  syncStatusBar();

  const syncActiveFromHost = () => {
    if (!host.controller) return;
    const activeFsPath = findActiveWorkspaceFilePath();
    if (activeFsPath) {
      host.controller.notifyActiveFileChanged(activeFsPath);
    }
  };

  const tabChangeDisp = vscode.window.tabGroups?.onDidChangeTabs
    ? vscode.window.tabGroups.onDidChangeTabs(syncActiveFromHost)
    : { dispose() {} };
  const folderChangeDisp = vscode.workspace.onDidChangeWorkspaceFolders
    ? vscode.workspace.onDidChangeWorkspaceFolders(syncStatusBar)
    : { dispose() {} };

  const treeView = vscode.window.createTreeView('graphfrontier.launcher', {
    treeDataProvider: {
      getTreeItem: (item) => item,
      getChildren: () => {
        const makeItem = (label, command, iconId) => {
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon(iconId);
          item.command = { command, title: label };
          return item;
        };
        return [
          makeItem('Open GraphFrontier', 'graphfrontier.openGraph', 'type-hierarchy-sub'),
          makeItem('Open Local Graph', 'graphfrontier.openLocalGraph', 'git-branch'),
          makeItem('Refresh Workspace Index', 'graphfrontier.refreshIndex', 'refresh'),
          makeItem(
            'Import Saves from Obsidian',
            'graphfrontier.importFromObsidian',
            'cloud-download'
          ),
          makeItem('Copy MCP Server URL', 'graphfrontier.copyMcpUrl', 'copy'),
        ];
      },
    },
  });

  context.subscriptions.push(
    statusBarItem,
    tabChangeDisp,
    folderChangeDisp,
    treeView,
    vscode.commands.registerCommand('graphfrontier.openGraph', () =>
      host.openGlobalPanel(vscode.ViewColumn.Active)
    ),
    vscode.commands.registerCommand('graphfrontier.openGraphBeside', () =>
      host.openGlobalPanel(vscode.ViewColumn.Beside)
    ),
    vscode.commands.registerCommand('graphfrontier.openLocalGraph', (resourceUri) =>
      host.openLocalTabPanel({ path: resourceUri?.fsPath || '' })
    ),
    vscode.commands.registerCommand('graphfrontier.refreshIndex', async () => {
      const controller = await host.ensureController();
      if (!controller) {
        vscode.window.showInformationMessage('Open a folder or workspace first.');
        return;
      }
      controller.triggerReindex();
      vscode.window.setStatusBarMessage('GraphFrontier index refreshed', 3000);
    }),
    vscode.commands.registerCommand('graphfrontier.importFromObsidian', async () => {
      const controller = await host.ensureController();
      if (!controller) {
        vscode.window.showInformationMessage('Open a folder or workspace first.');
        return;
      }
      try {
        const res = controller.importObsidianSaves();
        if (!res.imported) {
          vscode.window.showInformationMessage(
            'No Obsidian GraphFrontier saves found in .obsidian/plugins/graphfrontier.'
          );
          return;
        }
        if (host.globalPanel) {
          const prevCol = host.globalPanel.viewColumn || vscode.ViewColumn.Active;
          host.globalPanel.dispose();
          await host.openGlobalPanel(prevCol);
        }
        vscode.window.showInformationMessage(
          `Imported Obsidian GraphFrontier saves (active layout: ${res.activeLayout}).`
        );
      } catch (error) {
        vscode.window.showWarningMessage(
          error?.message || 'Failed to import Obsidian GraphFrontier saves.'
        );
      }
    }),
    vscode.commands.registerCommand('graphfrontier.copyMcpUrl', async () => {
      const controller = await host.ensureController();
      if (!controller) {
        vscode.window.showInformationMessage('Open a folder or workspace first.');
        return;
      }
      const status = controller.getMcpStatus();
      if (!status.enabled || !status.url) {
        vscode.window.showWarningMessage(
          status.error
            ? `GraphFrontier MCP unavailable: ${status.error}`
            : 'GraphFrontier MCP is currently OFF.'
        );
        return;
      }
      await vscode.env.clipboard.writeText(status.url);
      vscode.window.showInformationMessage('Copied GraphFrontier MCP URL to clipboard.');
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!host.controller) return;
      if (editor?.document?.uri?.scheme === 'file') {
        host.controller.notifyActiveFileChanged(editor.document.uri.fsPath);
      } else {
        syncActiveFromHost();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(async (ev) => {
      if (ev.affectsConfiguration('graphfrontier')) {
        await host.disposeController();
        if (getWorkspaceDir()) await host.ensureController();
      }
    }),
    {
      dispose: () => {
        void host.disposeController();
      },
    }
  );
}

function deactivate() {
  // Subscriptions handle disposal cleanly.
}

module.exports = { activate, deactivate };
