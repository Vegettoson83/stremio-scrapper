const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL); // e.g. from Upstash for Vercel

const manifest = {
    id: 'org.scraper.failover.supreme',
    version: '6.0.0',
    name: '🔥 Supreme Streams (Failover + Redis)',
    description: 'Scrapes real .m3u8 with failover & Redis cache',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
        { type: 'movie', id: 'top-movies' },
        { type: 'series', id: 'top-shows' }
    ]
};

const builder = new addonBuilder(manifest);

// 🔥 Catalog Handler (cached)
builder.defineCatalogHandler(async ({ type, id }) => {
    const cacheKey = `catalog:${type}:${id}`;
    let cached = await redis.get(cacheKey);
    if (cached) return { metas: JSON.parse(cached) };

    let metas = [];
    try {
        // 🔥 Primary scrape: Cuevana
        const url = (type === 'series') ? 'https://cuevana3.me/series' : 'https://cuevana3.me/';
        const res = await axios.get(url);
        const $ = cheerio.load(res.data);

        $('article').each((i, el) => {
            const title = $(el).find('h2').text().trim();
            const poster = $(el).find('img').attr('src');
            const href = $(el).find('a').attr('href');
            const contentId = href.split('/').pop();

            metas.push({
                id: contentId,
                type,
                name: title,
                poster,
            });
        });

        await redis.set(cacheKey, JSON.stringify(metas), 'EX', 3600); // 1h cache

    } catch (err) {
        console.error('Catalog scrape failed:', err.message);
    }

    return { metas };
});

// 🔥 Meta Handler (cached)
builder.defineMetaHandler(async ({ id, type }) => {
    const cacheKey = `meta:${id}`;
    let cached = await redis.get(cacheKey);
    if (cached) return { meta: JSON.parse(cached) };

    let meta = {
        id,
        type,
        name: `Scraped ${id}`,
        poster: 'https://via.placeholder.com/300',
        description: 'Auto scraped',
    };

    await redis.set(cacheKey, JSON.stringify(meta), 'EX', 24 * 3600); // 24h cache
    return { meta };
});

// 🔥 Stream Handler (cached + failover)
builder.defineStreamHandler(async ({ id }) => {
    const cacheKey = `stream:${id}`;
    let cached = await redis.get(cacheKey);
    if (cached) return { streams: JSON.parse(cached) };

    let streams = [];

    try {
        // Try primary site first
        streams = await scrapeCuevanaStream(id);

        // Failover if empty
        if (!streams.length) {
            console.warn(`Primary site failed, trying failover for ${id}`);
            streams = await scrapeFailoverStream(id);
        }

        // Cache streams if we got any
        if (streams.length) await redis.set(cacheKey, JSON.stringify(streams), 'EX', 6 * 3600); // 6h cache

    } catch (err) {
        console.error('Stream scrape failed:', err.message);
    }

    return { streams };
});

// 🔥 Scrape from Cuevana (Primary)
async function scrapeCuevanaStream(id) {
    let streams = [];
    try {
        const pageUrl = `https://cuevana3.me/${id}`;
        const res = await axios.get(pageUrl);
        const $ = cheerio.load(res.data);

        const iframeUrl = $('iframe').attr('src');
        if (!iframeUrl) throw new Error('Iframe not found');

        const iframeRes = await axios.get(iframeUrl);
        const iframeHtml = iframeRes.data;

        const m3u8MasterMatch = iframeHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);

        if (m3u8MasterMatch && m3u8MasterMatch[1]) {
            const masterUrl = m3u8MasterMatch[1];

            const m3u8Res = await axios.get(masterUrl);
            const playlist = m3u8Res.data;

            const regex = /#EXT-X-STREAM-INF:.*RESOLUTION=\d+x(\d+).*?\n(.*?\.m3u8)/g;
            let match;
            const qualities = [];

            while ((match = regex.exec(playlist)) !== null) {
                const quality = match[1];
                const link = new URL(match[2], masterUrl).href;
                qualities.push({ quality, link });
            }

            if (qualities.length) {
                qualities.forEach(q => {
                    streams.push({
                        title: `${q.quality}p`,
                        url: q.link,
                        name: 'Cuevana Stream'
                    });
                });
            } else {
                streams.push({
                    title: 'Auto (Master)',
                    url: masterUrl,
                    name: 'Cuevana Stream'
                });
            }

        } else {
            throw new Error('No .m3u8 master link found');
        }

    } catch (err) {
        console.warn('Primary scrape error:', err.message);
    }
    return streams;
}

// 🔥 Scrape from Failover Site (e.g., Pelisplus)
async function scrapeFailoverStream(id) {
    let streams = [];
    try {
        const pageUrl = `https://pelisplushd.net/ver/${id}`;
        const res = await axios.get(pageUrl);
        const $ = cheerio.load(res.data);

        const iframeUrl = $('iframe').attr('src');
        if (!iframeUrl) throw new Error('Iframe not found');

        const iframeRes = await axios.get(iframeUrl);
        const iframeHtml = iframeRes.data;

        const m3u8Match = iframeHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);

        if (m3u8Match && m3u8Match[1]) {
            streams.push({
                title: 'Auto (Failover)',
                url: m3u8Match[1],
                name: 'Failover Stream'
            });
        } else {
            throw new Error('No .m3u8 link found in failover');
        }

    } catch (err) {
        console.warn('Failover scrape error:', err.message);
    }
    return streams;
}

// 🔥 Vercel serverless export
module.exports = (req, res) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    builder.getInterface().get(pathname, req, res);
};
