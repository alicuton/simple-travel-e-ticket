// Serverless function on Vercel: /api/ticket
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  if (req.method === 'GET') {
    const { pnr, all } = req.query;
    // 1. Get all tickets list for cross-device sync (e.g., Mobile <-> Desktop)
    if (all === 'true' || all === '1' || (!pnr && req.url && req.url.includes('all=true'))) {
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

        // Fetch all values via MGET
        const mgetRes = await fetch(kvUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${kvToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(['MGET', ...keys])
        });
        const mgetData = await mgetRes.json();
        const values = Array.isArray(mgetData.result) ? mgetData.result : [];
        const tickets = [];
        values.forEach(v => {
          if (v) {
            try {
              tickets.push(typeof v === 'string' ? JSON.parse(v) : v);
            } catch(e) {}
          }
        });
        return res.status(200).json({ success: true, tickets });
      } catch (err) {
        console.error('Fetch all tickets error:', err);
        return res.status(500).json({ error: 'Failed to retrieve tickets', details: err.message });
      }
    }

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
      // If full record was saved, extract ticketData
      const ticketData = (rawData && rawData.ticketData) ? rawData.ticketData : rawData;
      return res.status(200).json({ success: true, pnr: cleanPnr, ticketData, record: rawData });
    } catch (err) {
      console.error('Fetch ticket error:', err);
      return res.status(500).json({ error: 'Failed to retrieve ticket', details: err.message });
    }
  }

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
      // Store the full record or ticketData object
      const toSave = record || { pnr: cleanPnr, ticketData };
      const payloadStr = typeof toSave === 'string' ? toSave : JSON.stringify(toSave);
      const response = await fetch(kvUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${kvToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['SET', `ticket:${cleanPnr}`, payloadStr])
      });
      const data = await response.json();
      return res.status(200).json({ 
        success: true, 
        pnr: cleanPnr, 
        shortUrl: `https://eticket.thesimple.media/${cleanPnr}`,
        result: data 
      });
    } catch (err) {
      console.error('Save ticket error:', err);
      return res.status(500).json({ error: 'Failed to save ticket', details: err.message });
    }
  }

  if (req.method === 'DELETE') {
    const { pnr, all } = req.query;
    try {
      if (all === 'true' || all === '1') {
        // Find all ticket:* keys and delete them
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
