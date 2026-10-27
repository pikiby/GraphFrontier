const { LayoutApi } = require('./api-layouts');
const { GraphApiError, fail } = require('./api-errors');
const { validate } = require('./api-tools');
const { NODE_VISUAL_SETTINGS, getNodeVisualSetting } = require('./node-visuals');
const { PREFIX } = require('./dark-energy');
const { SUBGRAPH_PREFIX } = require('./subgraphs');
const { HOTKEY_COMMANDS, normalizeAttachmentExtensions } = require('./constants');
const copy = (value) => JSON.parse(JSON.stringify(value));

class GraphFrontierActions extends LayoutApi {
  assertMutationActive() {
    if (this.closed) fail('API_CLOSED', 'GraphFrontier is unloaded.');
    if (this.mutationSignal?.aborted)
      fail('REQUEST_CANCELLED', 'Request cancelled before committing.');
  }
  input(method, args) {
    if (this.closed) fail('API_CLOSED', 'GraphFrontier is unloaded.');
    try {
      return validate(method, args);
    } catch (error) {
      throw new GraphApiError('INVALID_ARGUMENT', error.message);
    }
  }

  nodesFor(view, ids) {
    return [...new Set(ids)].map((id) => {
      if (['__proto__', 'constructor', 'prototype'].includes(id))
        fail('INVALID_ARGUMENT', 'Invalid node ID.');
      const node = view.nodeById.get(id);
      if (!node) fail('NODE_NOT_FOUND', `Unknown node: ${id}`);
      return node;
    });
  }

  query(raw) {
    const parsed = this.plugin.parseGroupQuery(raw);
    if (!parsed?.value)
      fail(
        'INVALID_ARGUMENT',
        'Use a complete typed query: name:, path:, file:, tag:, line:, section: or [property]:.'
      );
    return parsed;
  }

  changed({ rebuild = false, kick = false, panel = false, scopeView = null } = {}) {
    for (const view of this.views()) {
      if (scopeView && (view.subgraphScope?.id || null) !== (scopeView.subgraphScope?.id || null))
        continue;
      view.layoutEditVersion++;
      view.layoutAutosaveDirty = true;
      view.layoutStillFrames = 0;
      if (rebuild) view.refreshFromVault({ keepCamera: true });
      if (kick) view.kickLayoutSearch();
      if (panel) view.buildSidePanel();
      view.markQueryRuleVisibilityDirty();
      view.render();
    }
    this.plugin.schedulePersist();
  }

  getConfiguration(raw) {
    const args = this.input('getConfiguration', raw),
      view = this.resolve(args);
    return {
      ...this.state(view),
      settings: copy(this.plugin.getSettings()),
      groups: copy(this.plugin.data.groups),
      blacklist: copy(this.plugin.data.blacklist),
      whitelist: copy(this.plugin.data.whitelist),
      gravity: copy(this.plugin.data.dark_energy),
      subgraphs: copy(this.plugin.data.subgraphs),
      hotkeys: copy(this.plugin.data.hotkeys),
      commands: copy(HOTKEY_COMMANDS),
      search: {
        query: view.searchInputEl?.value || view.searchInputValue,
        mode: view.searchMode,
        showConnections: this.plugin.getSettings().show_search_connections,
      },
      ui: {
        panelOpen: view.sidePanelOpen,
        sections: copy(this.plugin.getSidePanelSectionsState()),
      },
      visibleNodeIds: view.apiVisibleNodeIds ? [...view.apiVisibleNodeIds] : null,
    };
  }

  updateSettings(raw) {
    const args = this.input('updateSettings', raw),
      view = this.resolve(args, true),
      keys = Object.keys(args.settings);
    Object.assign(this.plugin.data.settings, args.settings);
    if (keys.includes('excluded_attachment_extensions')) {
      this.plugin.data.settings.excluded_attachment_extensions = normalizeAttachmentExtensions(
        args.settings.excluded_attachment_extensions
      );
    }
    if (keys.includes('strong_pull_multiplier')) this.plugin.applyStrongPullToMarkedNodes();
    if (keys.some((k) => ['link_distance', 'orbit_distance'].includes(k)))
      this.plugin.recomputeOrbitRadiiAllViews();
    if (keys.includes('search_mode'))
      for (const v of this.views()) {
        v.searchMode = args.settings.search_mode;
        v.commitSearchSelectionFromInput(v.searchInputValue);
      }
    this.changed({
      rebuild: keys.some((k) =>
        [
          'hide_orphans',
          'hide_attachments',
          'include_unlinked_attachments',
          'excluded_attachment_extensions',
          'existing_files_only',
        ].includes(k)
      ),
      kick: keys.some((k) =>
        [
          'base_link_strength',
          'link_distance',
          'strong_pull_multiplier',
          'orbit_distance',
          'repel_strength',
          'repel_radius',
          'center_strength',
          'damping',
        ].includes(k)
      ),
      panel: true,
    });
    return { ...this.state(view), settings: copy(this.plugin.getSettings()) };
  }

  getNodeSettings(raw) {
    const args = this.input('getNodeSettings', raw),
      view = this.resolve(args);
    return {
      ...this.state(view),
      nodes: this.nodesFor(view, args.nodeIds).map((node) => ({
        id: node.id,
        overrides: {
          ...copy(this.plugin.data.node_visual_settings[node.id] || {}),
          label_font_size: this.plugin.getNodeLabelSize(node.id),
        },
        effective: Object.fromEntries(
          NODE_VISUAL_SETTINGS.map((s) => [
            s.key,
            getNodeVisualSetting(this.plugin, node.id, s.key),
          ])
        ),
        edgeColor: this.plugin.getPaintedEdgeColor(node.id),
        multiplier: this.plugin.getNodeMultiplier(node.id),
        strongPull: this.plugin.isStrongPullNode(node.id),
        pin: copy(this.plugin.getPin(node.id)),
        orbit: copy(this.plugin.getOrbitPin(node.id)),
      })),
    };
  }

  updateNodeSettings(raw) {
    const args = this.input('updateNodeSettings', raw),
      view = this.resolve(args, true),
      nodes = this.nodesFor(view, args.nodeIds);
    for (const node of nodes) {
      if (
        node.meta?.darkEnergy &&
        (args.edgeColor !== undefined ||
          args.multiplier !== undefined ||
          args.strongPull !== undefined ||
          NODE_VISUAL_SETTINGS.some((s) => s.edges && args.settings[s.key] !== undefined))
      )
        fail('INVALID_ARGUMENT', 'Gravity nodes do not have edge or strong-pull settings.');
    }
    for (const node of nodes) {
      if (args.reset) this.plugin.resetNodeVisualSettings(node.id);
      for (const [key, value] of Object.entries(args.settings))
        this.plugin.setNodeVisualSetting(node.id, key, value);
      if (args.edgeColor !== undefined) {
        if (args.edgeColor === null) this.plugin.clearPaintedEdgeColor(node.id);
        else this.plugin.setPaintedEdgeColor(node.id, args.edgeColor);
      }
      if (args.multiplier !== undefined) {
        if (args.multiplier === null) this.plugin.clearNodeMultiplier(node.id);
        else this.plugin.setNodeMultiplier(node.id, args.multiplier, { mode: 'manual' });
      }
      if (args.strongPull === true)
        this.plugin.setNodeMultiplier(node.id, this.plugin.getSettings().strong_pull_multiplier, {
          mode: 'strong-pull',
        });
      if (args.strongPull === false) this.plugin.clearNodeMultiplier(node.id);
    }
    this.changed({
      kick: args.multiplier !== undefined || args.strongPull !== undefined,
      scopeView: view,
    });
    return this.getNodeSettings({ viewId: args.viewId, nodeIds: args.nodeIds });
  }

  editRules(raw) {
    const args = this.input('editRules', raw),
      view = this.resolve(args, true),
      current = copy(this.plugin.data[args.list]);
    const rules = args.rules || [],
      ids = args.ids || [];
    if (['add', 'update', 'replace'].includes(args.action) && args.rules === undefined)
      fail('INVALID_ARGUMENT', 'rules is required.');
    if (args.action === 'remove' && !ids.length) fail('INVALID_ARGUMENT', 'ids is required.');
    for (const rule of rules) {
      if (rule.id && ['__proto__', 'constructor', 'prototype'].includes(rule.id))
        fail('INVALID_ARGUMENT', 'Invalid rule ID.');
    }
    const known = new Set(current.map((r) => r.id));
    if (args.action === 'update' && rules.some((r) => !r.id || !known.has(r.id)))
      fail('RULE_NOT_FOUND', 'Every update needs an existing rule ID.');
    if (args.action === 'remove' && ids.some((id) => !known.has(id)))
      fail('RULE_NOT_FOUND', 'Rule not found.');
    let next;
    if (args.action === 'clear') next = [];
    if (args.action === 'replace') next = rules;
    if (args.action === 'add') next = [...current, ...rules];
    if (args.action === 'remove') next = current.filter((r) => !ids.includes(r.id));
    if (args.action === 'update')
      next = current.map((r) => ({ ...r, ...rules.find((n) => n.id === r.id) }));
    for (const rule of next) {
      this.query(rule.query);
      if (args.list === 'groups' && !rule.color)
        fail('INVALID_ARGUMENT', 'Groups require a color.');
    }
    const explicit = next.filter((r) => r.id).map((r) => r.id);
    if (new Set(explicit).size !== explicit.length)
      fail('INVALID_ARGUMENT', 'Rule IDs must be unique.');
    this.plugin[
      { groups: 'updateGroups', blacklist: 'updateBlacklist', whitelist: 'updateWhitelist' }[
        args.list
      ]
    ](next);
    this.changed({ panel: true });
    return { ...this.state(view), list: args.list, rules: copy(this.plugin.data[args.list]) };
  }

  searchNodes(raw) {
    const args = this.input('searchNodes', raw),
      view = this.resolve(args),
      parsed = this.query(args.query),
      visible = args.visibleOnly === false ? null : view.getFilterVisibleNodeIds();
    const found = view.nodes.filter(
      (n) =>
        (!visible || visible.has(n.id)) &&
        view.nodeMatchesParsedGroup(view.getNodeMetaForSearch(n) || {}, parsed, n)
    );
    const offset = args.offset || 0,
      limit = args.limit || 100;
    return {
      ...this.state(view),
      nodeIds: found.slice(offset, offset + limit).map((n) => n.id),
      total: found.length,
      nextOffset: offset + limit < found.length ? offset + limit : null,
    };
  }

  setSearch(raw) {
    const args = this.input('setSearch', raw),
      view = this.resolve(args, true);
    if (args.query.trim()) this.query(args.query);
    if (args.mode) {
      view.searchMode = args.mode;
      if (!view.subgraphScope) this.plugin.data.settings.search_mode = args.mode;
    }
    if (args.showConnections !== undefined)
      this.plugin.data.settings.show_search_connections = args.showConnections;
    view.focusNodeId = null;
    view.commitSearchSelectionFromInput(args.query || 'name:');
    view.syncSearchModeToggleUi();
    view.render();
    this.plugin.schedulePersist();
    return {
      ...this.state(view),
      query: view.searchInputValue,
      mode: view.searchMode,
      matchCount: view.searchMatchedNodeIds.size,
    };
  }

  setVisibleNodes(raw) {
    const args = this.input('setVisibleNodes', raw),
      view = this.resolve(args, true);
    if (args.nodeIds !== null) this.nodesFor(view, args.nodeIds);
    view.apiVisibleNodeIds = args.nodeIds === null ? null : new Set(args.nodeIds);
    view.markSearchVisibilityDirty();
    view.render();
    return { ...this.state(view), visibleNodeIds: args.nodeIds };
  }

  highlightNodes(raw) {
    const args = this.input('highlightNodes', raw),
      view = this.resolve(args, true);
    this.nodesFor(view, args.nodeIds);
    const highlighted = new Set(args.nodeIds);
    if (args.includeLinked)
      for (const id of args.nodeIds)
        for (const linked of view.getLinkedNodeIds(id)) highlighted.add(linked);
    view.searchSelectedNodeId = null;
    view.searchInputValue = 'name:';
    if (view.searchInputEl) view.searchInputEl.value = 'name:';
    view.searchMatchedNodeIds = highlighted;
    view.focusNodeId = null;
    view.markSearchVisibilityDirty();
    view.syncSearchClearButtonVisibility();
    view.render();
    return { ...this.state(view), highlightedCount: highlighted.size };
  }

  setCamera(raw) {
    const args = this.input('setCamera', raw),
      view = this.resolve(args, true);
    if (Boolean(args.camera) === Boolean(args.fit))
      fail('INVALID_ARGUMENT', 'Specify either camera or fit=true.');
    if (args.fit) {
      const visible = view.getFilterVisibleNodeIds();
      view.fitCameraToNodes(view.nodes.filter((n) => !visible || visible.has(n.id)));
    } else {
      view.camera = { ...args.camera };
      view.cameraTarget = { ...args.camera };
    }
    view.persistViewState();
    view.render();
    return this.state(view);
  }

  async moveNodes(raw) {
    const args = this.input('moveNodes', raw),
      view = this.resolve(args, true);
    this.nodesFor(
      view,
      args.positions.map((p) => p.id)
    );
    for (const p of args.positions) {
      const node = view.nodeById.get(p.id),
        mode = args.pin || 'keep';
      if (mode === 'grid' || (mode === 'keep' && this.plugin.getPinMode(p.id) === 'grid'))
        await view.pinNodeToGrid(p.id, p);
      else if (mode === 'exact' || (mode === 'keep' && this.plugin.isPinned(p.id)))
        await view.pinNodeExact(p.id, p);
      else {
        node.x = p.x;
        node.y = p.y;
        node.vx = 0;
        node.vy = 0;
        if (mode === 'none') {
          this.plugin.removePin(p.id);
          this.plugin.removeOrbitPin(p.id);
        } else {
          const orbit = this.plugin.getOrbitPin(p.id),
            anchor = orbit && view.nodeById.get(orbit.anchor_id);
          if (anchor)
            this.plugin.setOrbitPin(p.id, {
              ...orbit,
              radius: Math.max(1, Math.hypot(p.x - anchor.x, p.y - anchor.y)),
              angle: Math.atan2(p.y - anchor.y, p.x - anchor.x),
            });
        }
      }
    }
    view.markNodeSpatialIndexDirty();
    this.changed({ kick: true, scopeView: view });
    return this.state(view);
  }

  async pinNodes(raw) {
    const args = this.input('pinNodes', raw),
      view = this.resolve(args, true);
    if (
      [args.nodeIds !== undefined, args.all === true, args.anchorId !== undefined].filter(Boolean)
        .length !== 1
    )
      fail('INVALID_ARGUMENT', 'Choose nodeIds, all=true, or anchorId.');
    if (args.mode === 'orbit' && !args.anchorId)
      fail('INVALID_ARGUMENT', 'Orbit requires anchorId.');
    if (args.anchorId) {
      this.nodesFor(view, [args.anchorId]);
      await view[
        {
          exact: 'pinLinkedNodes',
          grid: 'pinLinkedNodesToGrid',
          orbit: 'pinLinkedNodesToOrbit',
          none: 'unpinLinkedNodes',
        }[args.mode]
      ](args.anchorId, { targetKind: args.targetKind || 'all' });
    } else if (args.all && args.mode === 'none') {
      await view.commandUnpinAllNodes();
    } else {
      const nodes = args.all ? view.nodes : this.nodesFor(view, args.nodeIds);
      for (const node of nodes) {
        if (args.mode === 'none') {
          this.plugin.removePin(node.id);
          this.plugin.removeOrbitPin(node.id);
        } else await view[args.mode === 'grid' ? 'pinNodeToGrid' : 'pinNodeExact'](node.id, node);
      }
    }
    this.changed({ kick: true, scopeView: view });
    return this.state(view);
  }

  async subgraphNodes(raw) {
    const args = this.input('subgraphNodes', raw);
    const view = this.resolve(args, true);
    const existing = this.plugin.data.subgraphs.find((group) => group.id === args.id);
    if (args.action !== 'create' && !existing) fail('NODE_NOT_FOUND', 'Subgraph not found');
    if (args.action !== 'create' && args.memberIds !== undefined)
      fail('INVALID_ARGUMENT', 'Only creation accepts memberIds; use Ungroup to release members');
    try {
      if (args.action === 'create') {
        if (args.id) fail('INVALID_ARGUMENT', 'IDs are generated for new subgraphs');
        const group = view.setSubgraph({
          id: `${SUBGRAPH_PREFIX}${this.plugin.createGroupId()}`,
          name: args.name || 'Subgraph',
          members: args.memberIds ?? [...view.selectedNodeIds],
        });
        return { ...this.state(view), subgraph: copy(group) };
      }
      if (args.action === 'rename') {
        if (!args.name?.trim()) fail('INVALID_ARGUMENT', 'Enter a subgraph name');
        return {
          ...this.state(view),
          subgraph: copy(view.setSubgraph({ ...existing, name: args.name })),
        };
      }
      if (!view.nodeById.has(args.id))
        fail('NODE_NOT_FOUND', 'Open the parent graph to target this container');
      if (args.action === 'ungroup') view.ungroupSubgraph(args.id);
      else if (args.action === 'open') {
        const child = await view.openSubgraphSeparately(args.id);
        return { ...this.state(view), openedView: this.state(child) };
      }
      return this.state(view);
    } catch (error) {
      if (error instanceof GraphApiError) throw error;
      fail('INVALID_ARGUMENT', error.message);
    }
  }

  gravityNodes(raw) {
    const args = this.input('gravityNodes', raw),
      view = this.resolve(args, true);
    const existing = args.id && this.plugin.data.dark_energy.find((n) => n.id === args.id);
    if (args.action !== 'create' && !existing) fail('NODE_NOT_FOUND', 'Gravity node not found.');
    if (args.action === 'create' && args.id)
      fail('INVALID_ARGUMENT', 'IDs are generated for new gravity nodes.');
    if (args.action === 'delete') view.removeDarkEnergy({ id: args.id });
    else {
      if (args.action === 'create' && !args.queries)
        fail('INVALID_ARGUMENT', 'queries is required.');
      for (const q of args.queries || []) this.query(q);
      const item = {
        id: `${PREFIX}${this.plugin.createGroupId()}`,
        name: 'Gravity node',
        strength: 10,
        repulsion: 0,
        x: 0,
        y: 0,
        ...existing,
      };
      const current = existing && view.nodeById.get(existing.id);
      if (current) {
        item.x = current.x;
        item.y = current.y;
      }
      for (const key of ['name', 'queries', 'strength', 'repulsion', 'x', 'y'])
        if (args[key] !== undefined) item[key] = args[key];
      view.setDarkEnergy(item);
      if (args.x !== undefined || args.y !== undefined) {
        const node = view.nodeById.get(item.id);
        if (node) {
          node.x = item.x;
          node.y = item.y;
          node.vx = 0;
          node.vy = 0;
        }
        if (this.plugin.isPinned(item.id))
          this.plugin.setPin(item.id, item, { mode: this.plugin.getPinMode(item.id) });
      }
      this.changed();
      return { ...this.state(view), gravity: copy(item) };
    }
    this.changed();
    return this.state(view);
  }

  async getExportLocations(raw) {
    const args = this.input('getExportLocations', raw);
    this.resolve(args);
    return {
      vault: this.plugin.app.vault.getName(),
      home: null,
      desktop: null,
      vaultRelative: true,
    };
  }

  async exportHtml(raw) {
    const args = this.input('exportHtml', raw),
      view = this.resolve(args, true);
    const revision = this.plugin._persistRevision;
    if (args.nodeIds) this.nodesFor(view, args.nodeIds);
    const result = await view.commandExportStaticHtml({
      exportPath: args.path,
      nodeIds: args.nodeIds,
      includeContents: args.includeContents !== false,
      overwrite: args.overwrite === true,
      rememberPath: false,
      assertCurrent: () => {
        this.resolve(args, true);
        if (this.plugin._persistRevision !== revision)
          fail(
            'STATE_CHANGED',
            'Graph settings changed during export. Retry with the current state.'
          );
      },
    });
    if (!result)
      fail(
        'EXPORT_FAILED',
        'Export failed. Check the path, canvas readiness and overwrite option.'
      );
    return result;
  }

  async graphAction(raw) {
    const args = this.input('graphAction', raw);
    if (args.action === 'open') {
      await this.plugin.openOrRevealGraphFrontierView();
      return this.listViews();
    }
    const view = this.resolve(args, true);
    if (args.action === 'refresh') view.refreshFromVault({ keepCamera: true });
    if (args.action === 'pause') view.layoutPaused = true;
    if (args.action === 'resume') view.kickLayoutSearch();
    if (args.action === 'align_grid') await view.alignPinsToGrid();
    if (args.action === 'select_linked') {
      this.nodesFor(view, [args.nodeId]);
      view.selectLinkedNodes(args.nodeId);
    }
    if (args.action === 'arm_box_select') await view.commandArmBoxSelection();
    if (args.action === 'clear_selection') view.clearNodeSelection();
    view.render();
    return { ...this.state(view), paused: view.layoutPaused };
  }

  updateUi(raw) {
    const args = this.input('updateUi', raw),
      view = this.resolve(args, true);
    if ((args.commandId === undefined) !== (args.hotkey === undefined))
      fail('INVALID_ARGUMENT', 'Specify both commandId and hotkey. Empty hotkey clears it.');
    if (args.commandId) {
      const normalized = this.plugin.normalizeHotkeyText(args.hotkey);
      if (args.hotkey && !normalized) fail('INVALID_ARGUMENT', 'Invalid hotkey.');
      if (normalized && this.plugin.getHotkeyCommandIdByHotkey(normalized, args.commandId))
        fail('INVALID_ARGUMENT', 'Hotkey is already assigned.');
      this.plugin.setCommandHotkey(args.commandId, args.hotkey);
    }
    if (args.panelOpen !== undefined) view.sidePanelOpen = args.panelOpen;
    if (args.sections) {
      Object.assign(this.plugin.data.view_state.side_panel_sections, args.sections);
      for (const v of this.views())
        v.sidePanelSectionState = this.plugin.getSidePanelSectionsState();
    }
    for (const v of this.views()) v.buildSidePanel();
    this.plugin.schedulePersist();
    return this.getConfiguration({ viewId: args.viewId });
  }

  async nodeAction(raw) {
    const args = this.input('nodeAction', raw),
      view = this.resolve(args, true),
      [node] = this.nodesFor(view, [args.nodeId]),
      app = this.plugin.app;
    let text;
    const file = app.vault.getAbstractFileByPath(node.id);
    const isFile = (entry) => !!entry && typeof entry.extension === 'string';
    if (
      ['copy_path', 'copy_system_path', 'copy_obsidian_url'].includes(args.action) &&
      (!isFile(file) || node.id.startsWith(PREFIX) || node.id.startsWith(SUBGRAPH_PREFIX))
    )
      fail('NODE_NOT_FOUND', 'File not found.');
    if (args.action === 'copy_name') text = node.label || node.id;
    if (args.action === 'copy_path') text = node.id;
    if (args.action === 'copy_obsidian_url')
      text = `obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(node.id)}`;
    if (args.action === 'copy_system_path') {
      if (typeof app.vault.adapter.getFullPath !== 'function')
        fail('UNAVAILABLE', 'System paths are not available.');
      text = app.vault.adapter.getFullPath(node.id);
    }
    if (args.action === 'copy_linked_names' || args.action === 'copy_linked_paths')
      text = view.formatCopyList(
        view
          .getLinkedNodeIds(node.id)
          .map((id) => view.nodeById.get(id))
          .filter(Boolean)
          .filter(
            (n) =>
              args.action !== 'copy_linked_paths' ||
              (!n.id.startsWith(PREFIX) &&
                !n.id.startsWith(SUBGRAPH_PREFIX) &&
                isFile(app.vault.getAbstractFileByPath(n.id)))
          )
          .map((n) =>
            args.action === 'copy_linked_names'
              ? view.getLinkedNodeDisplayName(n)
              : app.vault.getAbstractFileByPath(n.id).path
          )
      );
    if (text !== undefined) {
      if (args.clipboard && !(await view.copyTextToClipboard(text)))
        fail('UNAVAILABLE', 'Clipboard is unavailable.');
      return { text, copied: !!args.clipboard };
    }
    if (args.action === 'open_note') {
      if (!file) fail('NODE_NOT_FOUND', 'File not found.');
      await app.workspace.getLeaf(true).openFile(file);
    }
    if (args.action === 'local_graph') await view.openLocalGraphForNode(node.id);
    if (args.action === 'close_preview') view.closeQuickPreview();
    if (args.action === 'preview') {
      const rect = view.canvasEl.getBoundingClientRect();
      await view.toggleQuickPreview(
        node.id,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      );
    }
    if (args.action === 'open_path' || args.action === 'open_url') {
      const key = args.action === 'open_path' ? 'path' : 'url',
        value = file && app.metadataCache.getFileCache(file)?.frontmatter?.[key];
      if (typeof value !== 'string' || !value.trim()) fail('UNAVAILABLE', `No ${key} property.`);
      const { openNoteTarget } = require('./note-navigation');
      await openNoteTarget(app, key, value.trim(), view.contentEl.win);
    }
    return { ok: true, action: args.action };
  }
}
module.exports = { GraphFrontierActions };
