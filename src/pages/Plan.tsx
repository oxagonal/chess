/**
 * The Plan tab: your training time against Noël Studer's 1/3 rule — tactics, your games (playing and
 * reviewing them) and study (one topic at a time, openings at most a third) — for this week, last week
 * or the last 30 days; what to do next; your weekly plan (Studer: write down the day, the time, the
 * third and the exact task beforehand); and time logged by hand for what happens away from the app.
 * Time in the app is recorded as you use it (services/activity).
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid } from '../db/db';
import { updateSettings, useSettings, type PlanSlot } from '../db/settings';
import { useNow } from '../hooks';
import { behind, fmtDuration, minutes, periodBounds, planTotals, SPEEDS, THIRD_LABEL, THIRDS, tooMuchOpenings, TOPIC_LABEL, weekStart, type PlanTotals } from '../lib/plan';
import type { Activity, StudyTopic, Third } from '../lib/types';
import { deleteActivity, logActivity } from '../services/activity';
import { href } from '../router';
import { fmtDate } from '../components/ui';

type Period = 'week' | 'last' | '30d';
const PERIODS: [Period, string][] = [
  ['week', 'This week'],
  ['last', 'Last week'],
  ['30d', '30 days'],
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TOPICS: StudyTopic[] = ['openings', 'endgames', 'positional', 'other'];
const DAY_MS = 86_400_000;

export function PlanPage() {
  const settings = useSettings();
  const [period, setPeriod] = useState<Period>('week');
  const now = useNow(60_000);
  const { from, to, days } = periodBounds(period, now);
  const activities = useLiveQuery(() => db.activity.where('start').between(from, to, true, false).toArray(), [from, to]);
  const games = useLiveQuery(() => db.games.where('playedAt').between(from, to, true, false).toArray(), [from, to]);
  if (!settings.loaded || !activities || !games) return <div className="muted">Loading…</div>;

  const totals = planTotals(activities, games, from, to, settings.trainingSpeeds);
  const target = (settings.weeklyMinutes * 60_000 * days) / 7;

  return (
    <div className="col plan-page" style={{ gap: 14 }}>
      <div className="row">
        <h1 style={{ margin: 0 }}>Plan</h1>
        <span className="spacer" />
        <div className="segmented" role="group" aria-label="Period">
          {PERIODS.map(([p, label]) => (
            <button key={p} className={`small ${p === period ? 'active' : ''}`} onClick={() => setPeriod(p)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <Balance totals={totals} target={target} focus={settings.studyFocus} period={period} />
      {period === 'week' && <WeekPlan slots={settings.planSlots} activities={activities} now={now} />}
      <LogTime focus={settings.studyFocus} />
      <Recent activities={activities} />
      <PlanSettings />
    </div>
  );
}

/* ------------------------------------------------------------------ balance */

function Balance({ totals, target, focus, period }: { totals: PlanTotals; target: number; focus: StudyTopic; period: Period }) {
  const third = target / 3;
  const next = behind(totals, target);
  const openingsShare = totals.total ? totals.topics.openings / totals.total : 0;
  const when = period === 'week' ? 'this week' : period === 'last' ? 'last week' : 'in the last 30 days';
  return (
    <div className="panel col" style={{ gap: 12 }}>
      <div className="row">
        <span>
          <b className="plan-total">{fmtDuration(totals.total)}</b> <span className="muted">of {fmtDuration(target)} {when}</span>
        </span>
        <span className="spacer" />
        <span className="muted small">a third each: tactics · your games · study</span>
      </div>
      {THIRDS.map((t) => {
        const done = totals.by[t];
        return (
          <div key={t} className="plan-third">
            <span className="plan-third-name">{THIRD_LABEL[t]}</span>
            <div className="plan-bar" title={`${fmtDuration(done)} of ${fmtDuration(third)}`}>
              <div className={`plan-fill ${t}`} style={{ width: `${Math.min(100, third ? (100 * done) / third : 0)}%` }} />
            </div>
            <span className="small nowrap">
              <b>{fmtDuration(done)}</b> <span className="muted">/ {fmtDuration(third)}</span>
            </span>
            <span className="muted small plan-third-detail">
              {t === 'tactics' && 'puzzles here, and tactics you logged'}
              {t === 'games' && (
                <>
                  playing {fmtDuration(totals.playing)} ({totals.gamesPlayed} game{totals.gamesPlayed === 1 ? '' : 's'}) · reviewing {fmtDuration(totals.reviewing)}
                </>
              )}
              {t === 'study' &&
                TOPICS.filter((x) => totals.topics[x] > 0 || x === focus)
                  .map((x) => `${TOPIC_LABEL[x]} ${fmtDuration(totals.topics[x])}${x === focus ? ' (your focus)' : ''}`)
                  .join(' · ')}
            </span>
          </div>
        );
      })}
      {tooMuchOpenings(totals) && (
        <div className="note warn-note">
          ⚠ Openings took <b>{Math.round(openingsShare * 100)}%</b> of your training {when}. Studer keeps them to a third at most — most opening
          work comes out of analysing your own games, and tactics and your games move the needle more.
        </div>
      )}
      {period !== 'last' && (
        <div className="row plan-next">
          <span className="small">
            Furthest behind: <b>{THIRD_LABEL[next]}</b>
          </span>
          <span className="spacer" />
          <NextAction third={next} focus={focus} />
        </div>
      )}
    </div>
  );
}

function NextAction({ third, focus }: { third: Third; focus: StudyTopic }) {
  if (third === 'tactics')
    return (
      <a className="btn small primary" href={href('puzzles')}>
        Do puzzles
      </a>
    );
  if (third === 'games')
    return (
      <a className="btn small primary" href={href('games')}>
        Review a game
      </a>
    );
  return focus === 'openings' ? (
    <a className="btn small primary" href={href('repertoire')}>
      Train your openings
    </a>
  ) : (
    <span className="muted small">Study {TOPIC_LABEL[focus].toLowerCase()} — then log the time below</span>
  );
}

/* --------------------------------------------------------------- week plan */

function WeekPlan({ slots, activities, now }: { slots: PlanSlot[]; activities: Activity[]; now: number }) {
  const [adding, setAdding] = useState(false);
  const w = weekStart(now);
  const today = Math.floor((now - w) / DAY_MS);
  // A slot is done when that day has about as much time in its third (games played count too).
  const dayTotal = (day: number, third: Third) =>
    activities.filter((a) => a.third === third && a.start >= w + day * DAY_MS && a.start < w + (day + 1) * DAY_MS).reduce((s, a) => s + a.ms, 0);
  const sorted = [...slots].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
  const remove = (id: string) => void updateSettings({ planSlots: slots.filter((s) => s.id !== id) });
  const planned = slots.reduce((s, x) => s + x.minutes, 0);
  return (
    <div className="panel col" style={{ gap: 8 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Your week</h2>
        <span className="muted small">{planned ? `${planned} min planned` : 'Plan the days, times, thirds and exact tasks beforehand'}</span>
        <span className="spacer" />
        {!adding && (
          <button className="small" onClick={() => setAdding(true)}>
            + Add a slot
          </button>
        )}
      </div>
      {adding && <SlotForm onDone={() => setAdding(false)} slots={slots} />}
      {!sorted.length && !adding && (
        <p className="muted small" style={{ margin: 0 }}>
          E.g. Tuesday 18:00 · Tactics · 45 min · “Lichess puzzles: 30 min solving, 15 min checking the solutions” — specific slots and
          tasks, not “an hour on Tuesday”.
        </p>
      )}
      {sorted.length > 0 && (
        <ul className="plan-slots">
          {sorted.map((s) => {
            const done = s.day <= today && dayTotal(s.day, s.third) >= s.minutes * 60_000 * 0.8;
            return (
              <li key={s.id} className={`${s.day === today ? 'today' : ''} ${done ? 'done' : ''}`}>
                <span className="plan-slot-when">
                  {DAYS[s.day]} {s.time}
                </span>
                <span className={`plan-chip ${s.third}`}>{THIRD_LABEL[s.third]}</span>
                <span className="small">{s.minutes} min</span>
                <span className="plan-slot-task">{s.task}</span>
                <span className="spacer" />
                {done && <span className="badge good" title="That day has about this much time in this third">✓ done</span>}
                <button className="small ghost" aria-label="Remove" title="Remove this slot" onClick={() => remove(s.id)}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SlotForm({ slots, onDone }: { slots: PlanSlot[]; onDone: () => void }) {
  const [day, setDay] = useState(0);
  const [time, setTime] = useState('18:00');
  const [third, setThird] = useState<Third>('tactics');
  const [mins, setMins] = useState(45);
  const [task, setTask] = useState('');
  const save = () => {
    void updateSettings({ planSlots: [...slots, { id: uid(), day, time, third, minutes: Math.max(5, mins), task: task.trim() }] });
    onDone();
  };
  return (
    <div className="row plan-form">
      <select value={day} onChange={(e) => setDay(Number(e.target.value))} aria-label="Day">
        {DAYS.map((d, i) => (
          <option key={d} value={i}>
            {d}
          </option>
        ))}
      </select>
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
      <select value={third} onChange={(e) => setThird(e.target.value as Third)} aria-label="Third">
        {THIRDS.map((t) => (
          <option key={t} value={t}>
            {THIRD_LABEL[t]}
          </option>
        ))}
      </select>
      <label className="small inline-field">
        <input type="number" min={5} step={5} value={mins} onChange={(e) => setMins(Number(e.target.value) || 0)} style={{ width: 64 }} /> min
      </label>
      <input className="plan-task" placeholder="The exact task, e.g. “Lichess puzzles 30 min, 15 min checking”" value={task} onChange={(e) => setTask(e.target.value)} />
      <button className="small primary" onClick={save}>
        Add
      </button>
      <button className="small ghost" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- logging */

function LogTime({ focus }: { focus: StudyTopic }) {
  const [third, setThird] = useState<Third>('study');
  const [topic, setTopic] = useState<StudyTopic>(focus);
  const [mins, setMins] = useState(30);
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState(false);
  const save = async () => {
    const at = new Date(`${day}T12:00:00`).getTime();
    await logActivity({ third, topic, minutes: Math.max(1, mins), at: Number.isFinite(at) ? at : Date.now(), note });
    setNote('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="panel col" style={{ gap: 8 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>Log time</h2>
        <span className="muted small">for what you do away from the app — a book, a course, puzzles elsewhere, games over the board</span>
      </div>
      <div className="row plan-form">
        <select value={third} onChange={(e) => setThird(e.target.value as Third)} aria-label="Third">
          {THIRDS.map((t) => (
            <option key={t} value={t}>
              {THIRD_LABEL[t]}
            </option>
          ))}
        </select>
        {third === 'study' && (
          <select value={topic} onChange={(e) => setTopic(e.target.value as StudyTopic)} aria-label="Topic">
            {TOPICS.map((t) => (
              <option key={t} value={t}>
                {TOPIC_LABEL[t]}
              </option>
            ))}
          </select>
        )}
        <label className="small inline-field">
          <input type="number" min={1} step={5} value={mins} onChange={(e) => setMins(Number(e.target.value) || 0)} style={{ width: 64 }} /> min
        </label>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
        <input className="plan-task" placeholder="What (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="small primary" onClick={save}>
          {saved ? '✓ Logged' : 'Log'}
        </button>
      </div>
    </div>
  );
}

const WHAT: Record<string, string> = {
  'train-review': 'Opening review',
  'train-learn': 'Learning openings',
  'train-drill': 'Opening drill',
  builder: 'Building your repertoire',
  review: 'Game review',
  puzzles: 'Puzzles',
  log: 'Logged',
};

function Recent({ activities }: { activities: Activity[] }) {
  const rows = [...activities].sort((a, b) => b.start - a.start).slice(0, 20);
  if (!rows.length) return null;
  return (
    <div className="panel col" style={{ gap: 6 }}>
      <h2 style={{ margin: 0 }}>Time recorded</h2>
      <ul className="plan-recent">
        {rows.map((a) => (
          <li key={a.id}>
            <span className="muted small nowrap">
              {fmtDate(a.start)} {a.manual ? '' : new Date(a.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className={`plan-chip ${a.third}`}>{a.third === 'study' && a.topic ? TOPIC_LABEL[a.topic] : THIRD_LABEL[a.third]}</span>
            <span className="small">{a.note ?? WHAT[a.what] ?? a.what}</span>
            <span className="spacer" />
            <span className="small nowrap">{minutes(a.ms) || '<1'} min</span>
            <button className="small ghost" aria-label="Delete" title="Delete this time" onClick={() => void deleteActivity(a.id)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

function PlanSettings() {
  const s = useSettings();
  return (
    <div className="panel col" style={{ gap: 8 }}>
      <h2 style={{ margin: 0 }}>Settings</h2>
      <div className="row plan-form">
        <label className="small inline-field">
          Training a week
          <input
            type="number"
            min={1}
            step={0.5}
            value={Math.round((s.weeklyMinutes / 60) * 10) / 10}
            onChange={(e) => void updateSettings({ weeklyMinutes: Math.max(30, Math.round((Number(e.target.value) || 0) * 60)) })}
            style={{ width: 64 }}
          />
          hours
        </label>
        <label className="small inline-field" title="Study one thing at a time: your weakest area (Studer)">
          Study focus
          <select value={s.studyFocus} onChange={(e) => void updateSettings({ studyFocus: e.target.value as StudyTopic })}>
            {TOPICS.map((t) => (
              <option key={t} value={t}>
                {TOPIC_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row plan-form">
        <span className="small">Games that count as training:</span>
        {SPEEDS.map((sp) => (
          <label key={sp} className="check small">
            <input
              type="checkbox"
              checked={s.trainingSpeeds.includes(sp)}
              onChange={(e) =>
                void updateSettings({ trainingSpeeds: e.target.checked ? [...s.trainingSpeeds, sp] : s.trainingSpeeds.filter((x) => x !== sp) })
              }
            />
            {sp}
          </label>
        ))}
        <span className="muted small">(Studer: a training game is never faster than 3+0; for classical goals play rapid)</span>
      </div>
    </div>
  );
}
