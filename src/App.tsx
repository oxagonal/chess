import { useEffect, useState, type ComponentType } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { loadDueCount } from './db/training';
import { setDueBadge } from './services/appBadge';
import { useNow } from './hooks';
import { useRoute, href, scopeHref, type Route } from './router';
import { HomePage } from './pages/Home';
import { RepertoirePage } from './pages/Repertoire';
import { TrainPage } from './pages/Train';
import { PuzzlesPage } from './pages/Puzzles';
import { GamesPage } from './pages/Games';
import { PlanPage } from './pages/Plan';
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
  /** Not in the tab bar: reached from another tab, which stays highlighted (`under`). */
  under?: string;
}

/**
 * Top-level tabs. To add a feature area (e.g. an engine-powered "Review" tab for analysing games),
 * create a page component under src/pages and register it here.
 */
const TABS: Tab[] = [
  { path: '', label: 'Home', page: HomePage },
  // Your chapters, how ready they are and training them (it took over the Map tab); a chapter's builder.
  { path: 'repertoire', label: 'Repertoire', page: RepertoirePage },
  { path: 'puzzles', label: 'Puzzles', page: PuzzlesPage },
  // Training sessions (#/train?mode=…) are started from the Repertoire tab.
  { path: 'train', label: 'Train', page: TrainPage, under: 'repertoire' },
  { path: 'games', label: 'Games', page: GamesPage },
  // Your training time against the 1/3 rule, and your week's plan.
  { path: 'plan', label: 'Plan', page: PlanPage },
  { path: 'settings', label: 'Settings', page: SettingsPage },
];

/**
 * Where you were in Games — the game you were reviewing, or a filtered list — so its tab takes you back
 * there after you've been elsewhere (checking the line in the builder, drilling it…). Kept for the
 * session. Tapping Games while in Games goes to the list.
 */
const LAST_GAMES_KEY = 'chess-prep:lastGames';

/**
 * Old addresses: Coverage and Insights were tabs of their own, then the Map tab — which is the
 * Repertoire tab now, with its scope in `?scope=` (bookmarks and links keep working).
 */
function movedTo(route: Route): string | undefined {
  const [top, sub] = route.path;
  if (top === 'map' || top === 'coverage' || top === 'insights') return scopeHref(sub);
  // The Train tab is part of the Repertoire tab: only sessions stay at #/train.
  if (top === 'train' && !route.query.get('mode')) {
    const rep = route.query.get('rep');
    return scopeHref(rep && rep !== 'all' ? rep : undefined);
  }
  if (top === 'repertoire' && !sub && !route.query.get('scope')) {
    const set = route.query.get('set');
    const color = route.query.get('color');
    if (set || color) return scopeHref(set ? `set:${set}` : color!);
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
  const tab = TABS.find((t) => t.path === (moved ? 'repertoire' : (route.path[0] ?? ''))) ?? TABS[0];
  const Page = tab.page;
  // The tab lit in the bar (a session lights the Repertoire tab, where it was started).
  const shownTab = (tab.under && TABS.find((t) => t.path === tab.under)) || tab;
  const lastGames = useLastGames(route);
  const tabHref = (t: Tab) => (t.path === 'games' && tab !== t && lastGames ? lastGames : href(t.path));

  useEffect(() => {
    document.title = due ? `(${due}) Tabiya` : 'Tabiya';
    // And on the installed app's icon, where the browser supports it.
    if (due !== undefined) setDueBadge(due);
  }, [due]);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href('')}>
          <span>♞</span> Tabiya
        </a>
        <nav className="nav row" style={{ flexWrap: 'nowrap' }}>
          {TABS.filter((t) => !t.under).map((t) => (
            <a key={t.path} href={tabHref(t)} className={t === shownTab ? 'active' : ''} aria-current={t === shownTab ? 'page' : undefined}>
              <span className="nav-icon">{NAV_ICONS[t.path]}</span>
              <span className="nav-label">{t.label}</span>
              {t.path === 'repertoire' && !!due && <span className="badge due">{due}</span>}
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
