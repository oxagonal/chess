/**
 * About & credits (Settings). Chess Prep uses GPL-3.0 libraries, so the app is GPL-3.0-or-later too:
 * this panel is its "Appropriate Legal Notices" — copyright, no warranty, the license and the source.
 */
const REPO = 'https://github.com/oxagonal/chess';
const LICENSE_URL = `${REPO}/blob/main/LICENSE`;

const CREDITS: { name: string; url: string; what: string; license: string }[] = [
  { name: 'chessground', url: 'https://github.com/lichess-org/chessground', what: 'chessboard, by Lichess', license: 'GPL-3.0-or-later' },
  { name: 'chessops', url: 'https://github.com/niklasf/chessops', what: 'chess rules, by Niklas Fiekas', license: 'GPL-3.0-or-later' },
  { name: 'Stockfish', url: 'https://github.com/nmrugg/stockfish.js', what: 'engine, by the Stockfish developers (stockfish.js build)', license: 'GPL-3.0' },
  { name: 'cburnett pieces', url: 'https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces', what: 'piece images, by Colin M.L. Burnett', license: 'GPL-2.0-or-later' },
  { name: 'ts-fsrs', url: 'https://github.com/open-spaced-repetition/ts-fsrs', what: 'spaced-repetition scheduling', license: 'MIT' },
  { name: 'Dexie', url: 'https://dexie.org', what: 'in-browser storage', license: 'Apache-2.0' },
  { name: 'React', url: 'https://react.dev', what: 'user interface', license: 'MIT' },
  { name: 'Inter', url: 'https://rsms.me/inter/', what: 'typeface, by Rasmus Andersson', license: 'SIL OFL 1.1' },
];

export function AboutPanel() {
  const built = new Date(__BUILD_TIME__).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="panel col about">
      <h2>About &amp; credits</h2>
      <p className="small" style={{ margin: 0 }}>
        <b>Chess Prep</b> · Copyright © 2026 oxagonal
      </p>
      <p className="small" style={{ margin: 0 }}>
        Designed by oxagonal and built together with{' '}
        <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">
          Claude
        </a>
        , Anthropic's AI coding assistant.
      </p>
      <p className="muted small" style={{ margin: 0 }}>
        Chess Prep is free software: you can use, share and change it under the terms of the GNU General Public License, version 3 or
        (at your option) any later version. It comes with <b>no warranty</b>, to the extent permitted by law.
      </p>
      <div className="row">
        <a className="btn small" href={REPO} target="_blank" rel="noreferrer">
          Source code
        </a>
        <a className="btn small" href={LICENSE_URL} target="_blank" rel="noreferrer">
          License (GPL-3.0)
        </a>
      </div>
      <div>
        <h3>Built with</h3>
        <ul className="credits small">
          {CREDITS.map((c) => (
            <li key={c.name}>
              <a href={c.url} target="_blank" rel="noreferrer">
                {c.name}
              </a>{' '}
              <span className="muted">
                — {c.what} · {c.license}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Opening statistics and cloud evaluations come from the Lichess opening explorer; games are downloaded from the Lichess and
          Chess.com public APIs. Not affiliated with Lichess or Chess.com.
        </p>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Version {__BUILD_COMMIT__} · built {built}
      </p>
    </div>
  );
}
