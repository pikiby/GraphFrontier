'use strict';

const VIEW_COLUMN_ACTIVE = -1;
const VIEW_COLUMN_BESIDE = -2;
const VIEW_COLUMN_ONE = 1;

function findExistingFileColumn({
  groups = [],
  localCol = null,
  targetNorm,
  normalizePath = (p) => p,
}) {
  if (!targetNorm) return null;
  const matchesGroup = (group) => {
    for (const tab of group.tabs || []) {
      const uri = tab.input?.uri || tab.input?.modified;
      if (uri?.scheme === 'file' && uri.fsPath && normalizePath(uri.fsPath) === targetNorm) {
        return true;
      }
    }
    return false;
  };

  for (const group of groups) {
    if (!group.viewColumn || group.viewColumn === localCol) continue;
    if (matchesGroup(group)) return group.viewColumn;
  }

  for (const group of groups) {
    if (!group.viewColumn || group.viewColumn !== localCol) continue;
    if (matchesGroup(group)) return group.viewColumn;
  }

  return null;
}

function pickNoteTargetColumn({
  groups = [],
  localCol = null,
  sourceCol = null,
  isFromLocal = false,
}) {
  const nonLocalGroups = groups.filter((g) => g.viewColumn && g.viewColumn !== localCol);
  if (isFromLocal || (localCol && sourceCol === localCol)) {
    if (nonLocalGroups.length > 0) return nonLocalGroups[0].viewColumn;
    return VIEW_COLUMN_BESIDE;
  }

  const otherNonLocal = sourceCol ? nonLocalGroups.filter((g) => g.viewColumn !== sourceCol) : [];
  if (otherNonLocal.length > 0) return otherNonLocal[0].viewColumn;
  if (sourceCol && sourceCol !== localCol) return sourceCol;
  if (nonLocalGroups.length > 0) return nonLocalGroups[0].viewColumn;
  return localCol ? VIEW_COLUMN_BESIDE : VIEW_COLUMN_ONE;
}

function pickGlobalTargetColumn({
  groups = [],
  activeCol = null,
  localCol = null,
  requestedCol = VIEW_COLUMN_ACTIVE,
}) {
  if (requestedCol !== VIEW_COLUMN_ACTIVE && requestedCol !== localCol) {
    return requestedCol;
  }
  if (!localCol || activeCol !== localCol) {
    return requestedCol;
  }
  const nonLocal = groups.find((g) => g.viewColumn && g.viewColumn !== localCol);
  return nonLocal ? nonLocal.viewColumn : VIEW_COLUMN_BESIDE;
}

function pickSubgraphTargetColumn({ groups = [], globalCol = null, localCol = null }) {
  if (!localCol) return VIEW_COLUMN_BESIDE;
  const nonLocal = groups.filter((g) => g.viewColumn && g.viewColumn !== localCol);
  const otherNonLocal = globalCol ? nonLocal.filter((g) => g.viewColumn !== globalCol) : nonLocal;
  if (otherNonLocal.length > 0) return otherNonLocal[0].viewColumn;
  if (globalCol && globalCol !== localCol) return globalCol;
  if (nonLocal.length > 0) return nonLocal[0].viewColumn;
  return VIEW_COLUMN_BESIDE;
}

module.exports = {
  VIEW_COLUMN_ACTIVE,
  VIEW_COLUMN_BESIDE,
  VIEW_COLUMN_ONE,
  findExistingFileColumn,
  pickNoteTargetColumn,
  pickGlobalTargetColumn,
  pickSubgraphTargetColumn,
};
