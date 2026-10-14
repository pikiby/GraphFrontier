const { fail } = require('./api-errors');

class LayoutApi {
  layoutName(raw) {
    if (
      typeof raw !== 'string' ||
      !raw.trim() ||
      /[\\/]/u.test(raw) ||
      raw.startsWith('.') ||
      /[. ]$/u.test(raw)
    )
      fail('INVALID_ARGUMENT', 'Use a layout filename, not a path.');
    const name = this.plugin.normalizeLayoutFileName(raw);
    if (
      name !== (/\.json$/iu.test(raw) ? raw : `${raw}.json`) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    )
      fail('INVALID_ARGUMENT', 'Layout name is not supported by the plugin filename rules.');
    return name;
  }

  backupDir() {
    return `${this.plugin.getLayoutsFolderRelativePath()}/backups`;
  }

  async readSaved(name) {
    const result = await this.plugin.readLayoutFileData(name);
    if (result.status !== 'ok')
      fail(
        result.status === 'missing' ? 'LAYOUT_NOT_FOUND' : 'LAYOUT_READ_FAILED',
        `Cannot read layout: ${name}`
      );
    return result.data;
  }

  async backupFiles() {
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(this.backupDir()))) return [];
    const listed = await adapter.list(this.backupDir());
    return listed.files
      .map((p) => p.split('/').pop())
      .filter((n) => /^backup-[a-z0-9-]+\.json$/.test(n))
      .sort()
      .reverse();
  }

  async readBackup(id, allowInvalid = false) {
    if (!/^backup-[a-z0-9-]+\.json$/.test(id)) fail('INVALID_ARGUMENT', 'Invalid backup ID.');
    try {
      const item = JSON.parse(
        await this.plugin.app.vault.adapter.read(`${this.backupDir()}/${id}`)
      );
      if (item.format !== 1 || !item.createdAt || typeof item.contents !== 'string')
        throw Error('Invalid backup');
      this.layoutName(item.layout);
      let validLayout = false;
      try {
        const data = JSON.parse(item.contents);
        validLayout = !!data && typeof data === 'object' && !Array.isArray(data);
      } catch {
        /* Damaged files can still be preserved as backups. */
      }
      if (!allowInvalid && !validLayout) throw Error('Invalid layout');
      item.validLayout = validLayout;
      return item;
    } catch {
      fail('BACKUP_READ_FAILED', 'Backup is missing or invalid; no layout was changed.');
    }
  }

  async makeBackup(name, ensure = false) {
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(this.plugin.getLayoutFileRelativePath(name))))
      fail('LAYOUT_NOT_FOUND', `Cannot back up missing layout: ${name}`);
    const contents = await adapter.read(this.plugin.getLayoutFileRelativePath(name));
    if (ensure) {
      for (const id of await this.backupFiles()) {
        const item = await this.readBackup(id, true);
        if (item.layout === name && item.contents === contents)
          return { backupId: id, layout: name, reused: true };
      }
    }
    const id = `backup-${Date.now().toString(36)}-${this.plugin
      .createGroupId()
      .replace(/[^a-z0-9-]/gi, '')
      .toLowerCase()}.json`;
    const item = { format: 1, layout: name, createdAt: new Date().toISOString(), contents };
    await this.plugin.ensureLayoutsFolder();
    if (!(await adapter.exists(this.backupDir()))) await adapter.mkdir(this.backupDir());
    const target = `${this.backupDir()}/${id}`;
    if (await adapter.exists(target)) fail('BACKUP_EXISTS', 'Backup ID collision; retry.');
    this.assertMutationActive();
    await adapter.write(target, JSON.stringify(item));
    if ((await adapter.read(target)) !== JSON.stringify(item))
      fail('BACKUP_WRITE_FAILED', 'Backup verification failed.');
    return { backupId: id, layout: name, reused: false };
  }

  async listLayouts(args = {}) {
    this.input('listLayouts', args);
    this.views();
    return {
      activeLayout: this.plugin.getActiveLayoutFileName(),
      layouts: await this.plugin.listLayoutFileNames(),
    };
  }

  async createLayout(raw) {
    const args = this.input('createLayout', raw),
      view = this.resolve(args, true),
      name = this.layoutName(args.name);
    await this.plugin.runLayoutFileOperation(async () => {
      this.resolve(args, true);
      if (await this.plugin.app.vault.adapter.exists(this.plugin.getLayoutFileRelativePath(name)))
        fail('LAYOUT_EXISTS', 'Choose a new layout name.');
      const data = args.source
        ? await this.readSaved(this.layoutName(args.source))
        : view.captureLayoutSnapshot(name);
      this.resolve(args, true);
      if (!(await this.plugin.writeLayoutFileData(name, data)))
        fail('LAYOUT_WRITE_FAILED', 'Cannot create layout.');
    });
    if (args.activate !== false) {
      this.resolve(args, true);
      if (
        !(await view.loadSavedLayout({
          layoutFileName: name,
          silent: true,
          assertCurrent: () => this.resolve(args, true),
        }))
      )
        fail('LAYOUT_READ_FAILED', 'Created layout, but could not activate it.');
      this.restoreLayoutCamera();
    }
    return { ...this.state(view), created: name };
  }

  async saveLayout(raw) {
    const args = this.input('saveLayout', raw),
      view = this.resolve(args, true),
      name = this.layoutName(args.name || this.plugin.getActiveLayoutFileName());
    const saved = await view.saveCurrentLayout({
      layoutFileName: name,
      silent: true,
      allowSearch: true,
      beforeWrite: async () => {
        this.resolve(args, true);
        if (await this.plugin.app.vault.adapter.exists(this.plugin.getLayoutFileRelativePath(name)))
          await this.makeBackup(name, true);
        this.resolve(args, true);
      },
    });
    if (!saved)
      fail('LAYOUT_WRITE_FAILED', 'Save failed or state changed; changes remain unsaved.');
    return this.state(view);
  }

  restoreLayoutCamera() {
    const s = this.plugin.data.view_state;
    for (const v of this.views()) {
      v.camera = { x: s.pan_x, y: s.pan_y, zoom: s.zoom };
      v.cameraTarget = { ...v.camera };
      v.markSearchVisibilityDirty();
      v.render();
    }
  }

  async loadLayout(raw) {
    const args = this.input('loadLayout', raw),
      view = this.resolve(args, true),
      name = this.layoutName(args.name);
    if (
      !(await view.loadSavedLayout({
        layoutFileName: name,
        silent: true,
        assertCurrent: () => this.resolve(args, true),
      }))
    )
      fail('LAYOUT_READ_FAILED', 'Cannot load layout; current state retained.');
    this.restoreLayoutCamera();
    return this.state(view);
  }

  async deleteLayout(raw) {
    const args = this.input('deleteLayout', raw),
      view = this.resolve(args, true),
      name = this.layoutName(args.name);
    // The hook runs in the same file-operation queue as UI/autosave commits.
    const result = await this.plugin.deleteLayoutFile(name, {
      beforeDelete: async () => {
        this.resolve(args, true);
        await this.makeBackup(name, true);
        this.resolve(args, true);
      },
    });
    if (!result.ok) fail('LAYOUT_DELETE_FAILED', result.reason);
    if (result.activeChanged) {
      await view.loadSavedLayout({ silent: true });
      this.restoreLayoutCamera();
    }
    return { ...result, ...this.state(view) };
  }

  async backupLayout(raw) {
    const args = this.input('backupLayout', raw);
    this.resolve(args, true);
    return this.plugin.runLayoutFileOperation(async () => {
      this.resolve(args, true);
      return this.makeBackup(this.layoutName(args.name), args.ensure);
    });
  }

  async listBackups(raw = {}) {
    const args = this.input('listBackups', raw);
    this.views();
    const name = args.name ? this.layoutName(args.name) : null;
    const all = [];
    for (const id of await this.backupFiles()) {
      const item = await this.readBackup(id, true);
      if (!name || name === item.layout)
        all.push({
          backupId: id,
          layout: item.layout,
          createdAt: item.createdAt,
          validLayout: item.validLayout,
        });
    }
    const offset = args.offset || 0,
      limit = args.limit || 100;
    return {
      items: all.slice(offset, offset + limit),
      nextOffset: offset + limit < all.length ? offset + limit : null,
    };
  }

  async restoreLayout(raw) {
    const args = this.input('restoreLayout', raw),
      view = this.resolve(args, true);
    const item = await this.readBackup(args.backupId),
      name = this.layoutName(args.name || item.layout);
    await this.plugin.runLayoutFileOperation(async () => {
      this.resolve(args, true);
      if (await this.plugin.app.vault.adapter.exists(this.plugin.getLayoutFileRelativePath(name)))
        await this.makeBackup(name, true);
      this.resolve(args, true);
      if (!(await this.plugin.writeLayoutFileData(name, JSON.parse(item.contents))))
        fail('LAYOUT_WRITE_FAILED', 'Restore failed; original backup retained.');
    });
    if (args.activate !== false || name === this.plugin.getActiveLayoutFileName()) {
      this.resolve(args, true);
      if (
        !(await view.loadSavedLayout({
          layoutFileName: name,
          silent: true,
          assertCurrent: () => this.resolve(args, true),
        }))
      )
        fail('LAYOUT_READ_FAILED', 'Restored layout, but activation failed.');
      this.restoreLayoutCamera();
    }
    return { ...this.state(view), restored: name, backupId: args.backupId };
  }
}
module.exports = { LayoutApi };
