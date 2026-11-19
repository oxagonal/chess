import { useEffect, useState, type ComponentType } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { loadDueCount } from './db/training';
import { setDueBadge } from './services/appBadge';
import { useNow } from './hooks';
import { useRoute, href, type Route } from './router';
import { HomePage } from './pages/Home';
import { RepertoirePage } from './pages/Repertoire';
import { TrainPage } from './pages/Train';
import { MapPage } from './pages/MapPage';
import { GamesPage } from './pages/Games';
import { SettingsPage } from './pages/Settings';
import { SyncIndicator } from './components/SyncPanel';
import { NAV_ICONS } from './components/icons';

export interface PageProps {
  route: Route;
}

interface Tab {
  path: string;
  label: string;
  page: ComponentType<PageProps>;
}

/**
 * Top-level tabs. To add a feature area (e.g. an engine-powered "Review" tab for analysing games),
 * create a page component under src/pages and register it here.
 */
const TABS: Tab[] = [
  { path: '', label: 'Home', page: HomePage },
  { path: 'repertoire', label: 'Repertoire', page: RepertoirePage },
  { path: 'train', label: 'Train', page: TrainPage },
  { path: 'map', label: 'Map', page: MapPage },
  { path: 'games', label: 'Games', page: GamesPage },
  { path: 'settings', label: 'Settings', page: SettingsPage },
];

/**
 * Where you were in Games — the game you were reviewing, or a filtered list — so its tab takes you back
 * there after you've been elsewhere (checking the line in the builder, drilling it…). Kept for the
 * session. Tapping Games while in Games goes to the list.
 */
const LAST_GAMES_KEY = 'chess-prep:lastGames';

/**
 * Old addresses: Coverage and Insights were tabs of their own, and the map a view of the Repertoire —
 * they're all the Map tab now (bookmarks and links keep working).
 */
function movedTo(route: Route): string | undefined {
  const [top, sub] = route.path;
  if (top === 'coverage' || top === 'insights') return href(sub ? `map/${sub}` : 'map');
  if (top === 'repertoire' && !sub && route.query.get('view') === 'map') {
    const set = route.query.get('set');
    const color = route.query.get('color');
    return href(set ? `map/set:${set}` : color ? `map/${color}` : 'map');
  }
  return undefined;
}

function useLastGames(route: Route): string {
  const [last, setLast] = useState(() => {
    try {
      return sessionStorage.getItem(LAST_GAMES_KEY) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (route.path[0] !== 'games') return;
    const sub = route.path[1];
    // Not the over-the-board editor: what you typed there isn't kept anyway.
    const here = sub === 'new' || sub === 'edit' ? '' : window.location.hash;
    setLast(here);
    try {
      if (here) sessionStorage.setItem(LAST_GAMES_KEY, here);
      else sessionStorage.removeItem(LAST_GAMES_KEY);
    } catch {
      /* storage unavailable: just not remembered */
    }
  }, [route]);
  return last;
}

export function App() {
  const route = useRoute();
  const now = useNow();
  // What a review would actually have — not a due card of a move you've taken out of training.
  const due = useLiveQuery(() => loadDueCount(now), [now]);
  const moved = movedTo(route);
  useEffect(() => {
    if (moved) window.location.replace(moved);
  }, [moved]);
  const tab = TABS.find((t) => t.path === (moved ? 'map' : (route.path[0] ?? ''))) ?? TABS[0];
  const Page = tab.page;
  const lastGames = useLastGames(route);
  const tabHref = (t: Tab) => (t.path === 'games' && tab !== t && lastGames ? lastGames : href(t.path));

  useEffect(() => {
    document.title = due ? `(${due}) Chess Prep` : 'Chess Prep';
    // And on the installed app's icon, where the browser supports it.
    if (due !== undefined) setDueBadge(due);
  }, [due]);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href('')}>
          ♞ Chess<span>Prep</span>
        </a>
        <nav className="nav row" style={{ flexWrap: 'nowrap' }}>
          {TABS.map((t) => (
            <a key={t.path} href={tabHref(t)} className={t === tab ? 'active' : ''} aria-current={t === tab ? 'page' : undefined}>
              <span className="nav-icon">{NAV_ICONS[t.path]}</span>
              <span className="nav-label">{t.label}</span>
              {t.path === 'train' && !!due && <span className="badge due">{due}</span>}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <SyncIndicator />
      </header>
      <main className="main">{!moved && <Page route={route} />}</main>
    </div>
  );
}
