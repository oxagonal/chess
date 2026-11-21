import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { PRACTICE_CREDIT_KEY, type PracticeCredit } from '../services/practiceCredit';

/** Says once what the practice-credit fix did (services/practiceCredit), until you close it. */
export function PracticeCreditNote() {
  const row = useLiveQuery(() => db.kv.get(PRACTICE_CREDIT_KEY), []);
  const credit = row?.value as PracticeCredit | undefined;
  if (!credit || credit.seen || !credit.count) return null;
  return (
    <div className="panel row practice-credit" role="status">
      <span className="small">
        <b>
          ✓ {credit.count} move{credit.count === 1 ? '' : 's'} now count{credit.count === 1 ? 's' : ''} as learned.
        </b>{' '}
        Reviews had been having you play {credit.count === 1 ? 'it' : 'them'} at the ends of lines without counting{' '}
        {credit.count === 1 ? 'it' : 'them'}; from now on a move you never learned that you play right in a review counts as learned.
      </span>
      <span className="spacer" />
      <button className="small ghost" aria-label="Close" onClick={() => void db.kv.put({ key: PRACTICE_CREDIT_KEY, value: { ...credit, seen: true } })}>
        ✕
      </button>
    </div>
  );
}
