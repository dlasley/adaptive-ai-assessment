import { useState, useEffect } from 'react';
import type { Unit } from '@adaptive/shared/types';

let cachedUnits: Unit[] | null = null;
let fetchPromise: Promise<Unit[]> | null = null;

async function loadUnits(): Promise<Unit[]> {
  if (cachedUnits) return cachedUnits;
  if (fetchPromise) return fetchPromise;

  fetchPromise = fetch('/api/units')
    .then(res => {
      if (!res.ok) throw new Error(`Failed to fetch units: ${res.status}`);
      return res.json();
    })
    .then((data: Unit[]) => {
      cachedUnits = data;
      return data;
    })
    .catch(err => {
      fetchPromise = null; // allow retry on failure
      throw err;
    });

  return fetchPromise;
}

export function useUnits(): { units: Unit[]; loading: boolean } {
  const [units, setUnits] = useState<Unit[]>(cachedUnits ?? []);
  const [loading, setLoading] = useState(cachedUnits === null);

  useEffect(() => {
    if (cachedUnits) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs local state with the shared module-level cache, populated by a concurrent caller
      setUnits(cachedUnits);
      setLoading(false);
      return;
    }

    loadUnits()
      .then(data => {
        setUnits(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load units:', err);
        setLoading(false);
      });
  }, []);

  return { units, loading };
}
