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
    const { pnr } = req.query;
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
      let ticketData = data.result;
      if (typeof ticketData === 'string') {
        try {
          ticketData = JSON.parse(ticketData);
        } catch (e) {}
      }
      return res.status(200).json({ success: true, pnr: cleanPnr, ticketData });
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
    const { pnr, ticketData } = body || {};
    if (!pnr || !ticketData) {
      return res.status(400).json({ error: 'Missing pnr or ticketData' });
    }
    const cleanPnr = String(pnr).trim().toUpperCase();
    try {
      const payloadStr = typeof ticketData === 'string' ? ticketData : JSON.stringify(ticketData);
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

  return res.status(405).json({ error: 'Method Not Allowed' });
};
