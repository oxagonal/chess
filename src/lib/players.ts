/**
 * Scouting other players (Builder → Players): the games we know of a player, each seen from *their*
 * side (`userColor` = the player's color). Pure: no DOM, no database.
 */
import { hashString, readPgnGames, sameName } from './otb';
import { opposite } from './chess';
import type { Player, StoredGame } from './types';

/** Your over-the-board games against this player, turned around so they're the "user". */
export function otbGamesVs(player: Player, myGames: readonly StoredGame[]): StoredGame[] {
  return myGames
    .filter((g) => g.source === 'otb' && sameName(g.userColor === 'white' ? g.black : g.white, player.name))
    .map((g) => ({ ...g, userColor: opposite(g.userColor), userScore: g.userScore === undefined ? undefined : 1 - g.userScore }));
}

/** Games pasted as PGN for this player — those where the player's name is White or Black. */
export function pgnGamesOf(player: Player): { games: StoredGame[]; skipped: number } {
  if (!player.pgn?.trim()) return { games: [], skipped: 0 };
  const { games } = readPgnGames(player.pgn);
  const out: StoredGame[] = [];
  for (const g of games) {
    const color = sameName(g.white, player.name) ? 'white' : sameName(g.black, player.name) ? 'black' : undefined;
    if (!color) continue;
    const score = g.result === '1/2-1/2' ? 0.5 : g.result === '*' ? undefined : (g.result === '1-0') === (color === 'white') ? 1 : 0;
    out.push({
      id: `pgn:${player.id}:${hashString(`${g.white}|${g.black}|${g.playedAt ?? ''}|${g.sans.join(' ')}`)}`,
      source: 'otb',
      account: 'pgn',
      url: '',
      white: g.white,
      black: g.black,
      whiteElo: g.whiteElo,
      blackElo: g.blackElo,
      userColor: color,
      result: g.result,
      userScore: score,
      timeClass: 'classical',
      rated: true,
      playedAt: g.playedAt ?? 0,
      sans: g.sans,
      event: g.event,
    });
  }
  return { games: out, skipped: games.length - out.length };
}
