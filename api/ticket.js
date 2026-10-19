// Serverless function on Vercel: /api/ticket
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const kvUrl = process.env.KV_REST_API_URL || 
                process.env.UPSTASH_REDIS_REST_URL || 
                process.env.STORAGE_KV_REST_API_URL || 
                process.env.STORAGE_REST_API_URL;

  const kvToken = process.env.KV_REST_API_TOKEN || 
                  process.env.UPSTASH_REDIS_REST_TOKEN || 
                  process.env.STORAGE_KV_REST_API_TOKEN || 
                  process.env.STORAGE_REST_API_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(500).json({ 
      error: 'Upstash Redis / Vercel KV environment variables not configured on Vercel project.' 
    });
  }

  // ─── GET Handler ───────────────────────────────────────────
  if (req.method === 'GET') {
    const { pnr, all, purge } = req.query;

    // 1. Get all tickets list (or purge heavy HTML from legacy tickets)
    if (all === 'true' || all === '1' || purge === 'true' || (!pnr && req.url && req.url.includes('all=true'))) {
      try {
        let keys = [];
        try {
          const keysRes = await fetch(kvUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${kvToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(['KEYS', 'ticket:*'])
          });
          const keysData = await keysRes.json();
          if (Array.isArray(keysData.result)) keys = keysData.result;
        } catch (e) {}

        if (keys.length === 0) {
          try {
            const keysRes = await fetch(`${kvUrl}/keys/ticket:*`, {
              headers: { Authorization: `Bearer ${kvToken}` }
            });
            const keysData = await keysRes.json();
            if (Array.isArray(keysData.result)) keys = keysData.result;
          } catch (e) {}
        }

        if (!Array.isArray(keys) || keys.length === 0) {
          return res.status(200).json({ success: true, tickets: [] });
        }

        // Fetch values in small batches of 4 to strictly stay under 10MB request/response limit
        const BATCH_SIZE = 4;
        const tickets = [];
        let purgedCount = 0;

        for (let i = 0; i < keys.length; i += BATCH_SIZE) {
          const batchKeys = keys.slice(i, i + BATCH_SIZE);
          try {
            const mgetRes = await fetch(kvUrl, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${kvToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(['MGET', ...batchKeys])
            });
            const mgetData = await mgetRes.json();
            const values = Array.isArray(mgetData.result) ? mgetData.result : [];

            for (let j = 0; j < values.length; j++) {
              const v = values[j];
              const keyName = batchKeys[j];
              if (!v) continue;

              try {
                let item = typeof v === 'string' ? JSON.parse(v) : v;
                if (!item || typeof item !== 'object') continue;

                // Check if this record still contains heavy rawHTML / htmlCompressed
                let hadHeavyHTML = false;
                if ('rawHTML' in item || 'htmlCompressed' in item) {
                  delete item.rawHTML;
                  delete item.htmlCompressed;
                  hadHeavyHTML = true;
                }
                if (item.record && ('rawHTML' in item.record || 'htmlCompressed' in item.record)) {
                  delete item.record.rawHTML;
                  delete item.record.htmlCompressed;
                  hadHeavyHTML = true;
                }
                if (item.ticketData && item.ticketData.rawHTML) {
                  delete item.ticketData.rawHTML;
                  hadHeavyHTML = true;
                }

                // Auto-heal / purge: rewrite cleaned slim record back to Upstash Redis
                if (hadHeavyHTML && keyName) {
                  purgedCount++;
                  fetch(kvUrl, {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${kvToken}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(['SET', keyName, JSON.stringify(item)])
                  }).catch(() => {});
                }

                tickets.push(item);
              } catch (e) {}
            }
          } catch (batchErr) {
            console.warn('Batch MGET error:', batchErr);
          }
        }

        return res.status(200).json({ success: true, tickets, purgedCount });
      } catch (err) {
        console.error('Fetch all tickets error:', err);
        return res.status(500).json({ error: 'Failed to retrieve tickets', details: err.message });
      }
    }

    // 2. Get single ticket by PNR
    if (!pnr) {
      return res.status(400).json({ error: 'Missing PNR' });
    }
    const cleanPnr = String(pnr).trim().toUpperCase();
    try {
      const response = await fetch(`${kvUrl}/get/ticket:${cleanPnr}`, {
        headers: {
          Authorization: `Bearer ${kvToken}`
        }
      });
      const data = await response.json();
      if (!data || data.result === null || data.result === undefined) {
        return res.status(404).json({ error: 'Booking not found', pnr: cleanPnr });
      }
      let rawData = data.result;
      if (typeof rawData === 'string') {
        try {
          rawData = JSON.parse(rawData);
        } catch (e) {}
      }

      // Strip heavy rawHTML if present and self-heal in background
      if (rawData && typeof rawData === 'object') {
        let hadHeavyHTML = false;
        if ('rawHTML' in rawData || 'htmlCompressed' in rawData) {
          delete rawData.rawHTML;
          delete rawData.htmlCompressed;
          hadHeavyHTML = true;
        }
        if (rawData.record && ('rawHTML' in rawData.record || 'htmlCompressed' in rawData.record)) {
          delete rawData.record.rawHTML;
          delete rawData.record.htmlCompressed;
          hadHeavyHTML = true;
        }
        if (hadHeavyHTML) {
          fetch(kvUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${kvToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(['SET', `ticket:${cleanPnr}`, JSON.stringify(rawData)])
          }).catch(() => {});
        }
      }

      const ticketData = (rawData && rawData.ticketData) ? rawData.ticketData : rawData;
      return res.status(200).json({ success: true, pnr: cleanPnr, ticketData, record: rawData });
    } catch (err) {
      console.error('Fetch ticket error:', err);
      return res.status(500).json({ error: 'Failed to retrieve ticket', details: err.message });
    }
  }

  // ─── POST Handler ──────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) {}
    }
    const { pnr, ticketData, record } = body || {};
    if (!pnr || (!ticketData && !record)) {
      return res.status(400).json({ error: 'Missing pnr or ticketData/record' });
    }
    const cleanPnr = String(pnr).trim().toUpperCase();

    try {
      // Build lightweight record: STRICTLY strip all rawHTML / htmlCompressed payloads
      let toSave = record ? { ...record } : { pnr: cleanPnr, ticketData };
      delete toSave.rawHTML;
      delete toSave.htmlCompressed;
      if (toSave.record) {
        delete toSave.record.rawHTML;
        delete toSave.record.htmlCompressed;
      }
      if (ticketData && ticketData.rawHTML) {
        delete ticketData.rawHTML;
      }
      // Safeguard: airlineLogo should not exceed 25KB base64
      if (toSave.airlineLogo && typeof toSave.airlineLogo === 'string' && toSave.airlineLogo.length > 25000) {
        toSave.airlineLogo = null;
      }

      const payloadStr = JSON.stringify(toSave);
      const response = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', `ticket:${cleanPnr}`, payloadStr])
      });
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'eticket.simpletravel.vn';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const shortUrl = `${proto}://${host}/${cleanPnr}`;

      return res.status(200).json({ 
        success: true, 
        pnr: cleanPnr, 
        shortUrl: shortUrl,
        result: data 
      });
    } catch (err) {
      console.error('Save ticket error:', err);
      return res.status(500).json({ error: 'Failed to save ticket', details: err.message });
    }
  }

  // ─── DELETE Handler ────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { pnr, all } = req.query;
    try {
      if (all === 'true' || all === '1') {
        let keys = [];
        try {
          const keysRes = await fetch(kvUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${kvToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(['KEYS', 'ticket:*'])
          });
          const keysData = await keysRes.json();
          if (Array.isArray(keysData.result)) keys = keysData.result;
        } catch (e) {}

        if (keys.length === 0) {
          try {
            const keysRes = await fetch(`${kvUrl}/keys/ticket:*`, {
              headers: { Authorization: `Bearer ${kvToken}` }
            });
            const keysData = await keysRes.json();
            if (Array.isArray(keysData.result)) keys = keysData.result;
          } catch (e) {}
        }

        if (Array.isArray(keys) && keys.length > 0) {
          await fetch(kvUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${kvToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(['DEL', ...keys])
          });
        }
        return res.status(200).json({ success: true, message: 'All test tickets cleared', count: keys.length });
      }

      if (pnr) {
        const cleanPnr = String(pnr).trim().toUpperCase();
        await fetch(`${kvUrl}/del/ticket:${cleanPnr}`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        return res.status(200).json({ success: true, message: `Deleted ticket ${cleanPnr}` });
      }

      return res.status(400).json({ error: 'Missing pnr or all parameter' });
    } catch (err) {
      console.error('Delete ticket error:', err);
      return res.status(500).json({ error: 'Failed to delete ticket', details: err.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
