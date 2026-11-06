// Public leaderboards for the panel attract screen, shared by the server and the static demo. Pure.
// Only display names leave this function: no ids, PINs, tokens, DNI or email.

// "Ana Lucía Fernández" -> "Ana F." (first name + last initial, for a public screen).
export function shortName(full) {
  const t = String(full).replace(/\s*\(demo\)$/, '').trim().split(/\s+/).filter(Boolean);
  return t.length > 1 ? `${t[0]} ${t[t.length - 1][0].toUpperCase()}.` : (t[0] ?? '');
}

// rows: finished attempts { guest, name, game, score, at }. Each guest counts once per board (their best attempt);
// ties go to whoever scored first. Returns { all: [{ name, game, score }], byGame: { [gameId]: [...] } }.
export function leaderboards(rows, gameIds, n = 5) {
  const sorted = [...rows].sort((a, b) => b.score - a.score || a.at - b.at);
  const top = (list) => {
    const seen = new Set(), out = [];
    for (const r of list) {
      if (seen.has(r.guest)) continue;
      seen.add(r.guest);
      out.push({ name: shortName(r.name), game: r.game, score: r.score });
      if (out.length === n) break;
    }
    return out;
  };
  return { all: top(sorted), byGame: Object.fromEntries(gameIds.map((id) => [id, top(sorted.filter((r) => r.game === id))])) };
}
