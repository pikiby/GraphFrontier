// Persistent manual/MCP file-to-file links stored in layout data.

function isValidLinkEndpoint(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
}

function canonicalLinkKey(source, target) {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

function normalizeCustomLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = isValidLinkEndpoint(item.source) ? item.source : '';
    const target = isValidLinkEndpoint(item.target) ? item.target : '';
    if (!source || !target || source === target) continue;
    const key = canonicalLinkKey(source, target);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ source, target });
  }
  return result;
}

function addCustomLinks(existing, pairs) {
  const list = normalizeCustomLinks(existing);
  const seen = new Set(list.map((link) => canonicalLinkKey(link.source, link.target)));
  let added = 0;
  for (const item of pairs || []) {
    if (!item || typeof item !== 'object') continue;
    const source = isValidLinkEndpoint(item.source) ? item.source : '';
    const target = isValidLinkEndpoint(item.target) ? item.target : '';
    if (!source || !target || source === target) continue;
    const key = canonicalLinkKey(source, target);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ source, target });
    added += 1;
  }
  return { links: list, added };
}

function removeCustomLinks(existing, pairs) {
  const removeKeys = new Set();
  for (const item of pairs || []) {
    if (!item || typeof item !== 'object') continue;
    if (!isValidLinkEndpoint(item.source) || !isValidLinkEndpoint(item.target)) continue;
    if (item.source === item.target) continue;
    removeKeys.add(canonicalLinkKey(item.source, item.target));
  }
  if (!removeKeys.size) return { links: normalizeCustomLinks(existing), removed: 0 };
  const kept = [];
  let removed = 0;
  for (const link of normalizeCustomLinks(existing)) {
    if (removeKeys.has(canonicalLinkKey(link.source, link.target))) {
      removed += 1;
    } else {
      kept.push(link);
    }
  }
  return { links: kept, removed };
}

export { canonicalLinkKey, normalizeCustomLinks, addCustomLinks, removeCustomLinks };
