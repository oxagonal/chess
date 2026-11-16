import { useEffect, useState, type ComponentType } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db/db';
import { useRoute, href, type Route } from './router';
import { HomePage } from './pages/Home';
import { RepertoirePage } from './pages/Repertoire';
import { TrainPage } from './pages/Train';
import { CoveragePage } from './pages/Coverage';
import { InsightsPage } from './pages/Insights';
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
  { path: 'insights', label: 'Insights', page: InsightsPage },
  { path: 'coverage', label: 'Coverage', page: CoveragePage },
  { path: 'games', label: 'Games', page: GamesPage },
  { path: 'settings', label: 'Settings', page: SettingsPage },
];

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function App() {
  const route = useRoute();
  const now = useNow();
  const due = useLiveQuery(() => db.cards.where('due').belowOrEqual(now).filter((c) => c.state !== 0).count(), [now]);
  const tab = TABS.find((t) => t.path === (route.path[0] ?? '')) ?? TABS[0];
  const Page = tab.page;

  useEffect(() => {
    document.title = due ? `(${due}) Chess Prep` : 'Chess Prep';
  }, [due]);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href={href('')}>
          ♞ Chess<span>Prep</span>
        </a>
        <nav className="nav row" style={{ flexWrap: 'nowrap' }}>
          {TABS.map((t) => (
            <a key={t.path} href={href(t.path)} className={t === tab ? 'active' : ''} aria-current={t === tab ? 'page' : undefined}>
              <span className="nav-icon">{NAV_ICONS[t.path]}</span>
              <span className="nav-label">{t.label}</span>
              {t.path === 'train' && !!due && <span className="badge due">{due}</span>}
            </a>
          ))}
        </nav>
        <span className="spacer" />
        <SyncIndicator />
      </header>
      <main className="main">
        <Page route={route} />
      </main>
    </div>
  );
}
