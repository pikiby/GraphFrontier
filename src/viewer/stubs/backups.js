// The exported page keeps no backups: its changes live only in the open tab.
class BackupManager {
  constructor(plugin, preferences) {
    this.preferences = preferences || {};
    this.restoring = false;
  }
  async initialize() {}
  schedule() {}
  dispose() {}
}

export { BackupManager };
