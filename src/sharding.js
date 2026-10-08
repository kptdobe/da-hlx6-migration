export function generateShardPrefixes(basePrefix, count, { expandPaths = [] } = {}) {
  if (count === 1) {
    return [{ prefix: basePrefix, type: 'all', description: 'All files', charRange: null }];
  }
  const shards = [];
  const allChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-.@$%'(,;[~";
  const expandSet = new Set(expandPaths.map((subPath) => basePrefix + subPath));
  for (const char of allChars) {
    const shardPrefix = basePrefix + char;
    const matchingExpandPath = [...expandSet].find((expanded) => expanded.startsWith(shardPrefix));
    if (matchingExpandPath) {
      for (const hi of '0123456789abcdef') {
        for (const lo of '0123456789abcdef') {
          shards.push({
            prefix: matchingExpandPath + hi + lo,
            type: 'hex',
            description: `Hex-expanded: '${matchingExpandPath}${hi}${lo}'`,
            charRange: [hi, lo],
            expandedFrom: shardPrefix,
          });
        }
      }
    } else {
      shards.push({
        prefix: shardPrefix, type: 'explicit',
        description: `Files starting with '${char}'`, charRange: [char],
      });
    }
  }
  return shards;
}