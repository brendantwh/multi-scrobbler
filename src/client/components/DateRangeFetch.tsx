import React, { useState } from 'react';
import dayjs from 'dayjs';

interface Props {
  sourceId: string;
  sourceType: string;
}

export const DateRangeFetch: React.FC<Props> = ({ sourceId, sourceType }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{found: number, discovered: number, message: string} | null>(null);

  const handleFetch = async () => {
    if (!from || !to) return;

    setLoading(true);
    setError('');
    setResult(null);

    try {
      const response = await fetch(`/api/source/dateRange?type=${sourceType}&name=${sourceId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: dayjs(from).startOf('day').toISOString(),
          to: dayjs(to).endOf('day').toISOString(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch scrobbles');
      }

      setResult(data);
      setFrom('');
      setTo('');
    } catch (err) {
      console.log(err.message);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="lastfm-fetch p-4 border rounded">
      <h3 className="mb-4">Fetch Historical Scrobbles</h3>
      <div className="flex gap-4 items-end">
        <div>
          <label className="block text-sm font-medium mb-1">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            disabled={loading}
            className="px-2 py-1 border rounded text-black"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={loading}
            className="px-2 py-1 border rounded text-black"
          />
        </div>
        <button
          onClick={handleFetch}
          disabled={loading || !from || !to}
          className="px-4 py-1 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          {loading ? 'Fetching...' : 'Fetch Scrobbles'}
        </button>
      </div>
      {error && <div className="mt-4 text-red-500">{error}</div>}
      {result && <div className="mt-4 text-green-500">{result.message}</div>}
    </div>
  );
};