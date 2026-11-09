const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

// 🎯 PROXY CONFIGURATION (STRICT — ALL API CALLS GO THROUGH PROXY)
const PROXY_URL = process.env.PROXY_URL || null;
const PROXY_ENABLED = process.env.PROXY_ENABLED !== 'false' && !!PROXY_URL;

let proxyAgent = null;
if (PROXY_ENABLED && PROXY_URL) {
    try {
        if (PROXY_URL.startsWith('socks5://') || PROXY_URL.startsWith('socks://')) {
            proxyAgent = new SocksProxyAgent(PROXY_URL);
            console.log(`🔄 SOCKS5 Proxy enabled: ${PROXY_URL.replace(/:[^@]*@/, ':***@')}`);
        } else {
            proxyAgent = new HttpsProxyAgent(PROXY_URL);
            console.log(`🔄 HTTP/HTTPS Proxy enabled: ${PROXY_URL.replace(/:[^@]*@/, ':***@')}`);
        }
    } catch (error) {
        console.error('❌ Failed to create proxy agent:', error.message);
        console.log('⚠️ Continuing without proxy...');
        PROXY_ENABLED = false;
        proxyAgent = null;
    }
} else {
    console.log('ℹ️ Proxy not configured or disabled. Using direct connections.');
}

// 🎯 DEBUG LOGS
const debugLogs = [];
function debugLog(userId, action, url, method, headers = {}, data = null, response = null, error = null) {
    const debugEntry = {
        timestamp: new Date().toISOString(),
        userId, action,
        proxy: PROXY_ENABLED ? {
            enabled: true,
            url: PROXY_URL ? PROXY_URL.replace(/:[^@]*@/, ':***@') : null
        } : { enabled: false },
        request: {
            url, method,
            headers: JSON.stringify(headers, null, 2),
            body: data ? JSON.stringify(data, null, 2) : null
        },
        response: response ? {
            status: response.status,
            data: JSON.stringify(response.data, null, 2)
        } : null,
        error: error ? {
            message: error.message,
            status: error.response?.status,
            data: error.response?.data ? JSON.stringify(error.response.data, null, 2) : null
        } : null
    };

    debugLogs.unshift(debugEntry);
    if (debugLogs.length > 200) debugLogs.pop();

    console.log('\n' + '='.repeat(80));
    console.log(`🔍 DEBUG [${debugEntry.timestamp}] - USER: ${userId}`);
    console.log(`📝 ACTION: ${action}`);
    if (PROXY_ENABLED) {
        console.log(`🌐 PROXY: ${PROXY_URL ? PROXY_URL.replace(/:[^@]*@/, ':***@') : 'enabled'}`);
    }
    console.log(`📡 REQUEST:`);
    console.log(`   URL: ${url}`);
    console.log(`   METHOD: ${method}`);
    console.log(`   HEADERS:`, JSON.stringify(headers, null, 2));
    if (data) console.log(`   BODY:`, JSON.stringify(data, null, 2));
    if (response) {
        console.log(`✅ RESPONSE:`);
        console.log(`   STATUS: ${response.status}`);
        console.log(`   DATA:`, JSON.stringify(response.data, null, 2));
    }
    if (error) {
        console.log(`❌ ERROR:`);
        console.log(`   MESSAGE: ${error.message}`);
        if (error.response) {
            console.log(`   STATUS: ${error.response.status}`);
            console.log(`   RESPONSE DATA:`, JSON.stringify(error.response.data, null, 2));
        }
    }
    console.log('='.repeat(80) + '\n');
}

// Middleware
app.use(express.json());
app.use(express.static('public'));

// 🎯 CONFIG
const CONFIG = {
    BASE_URL: process.env.BASE_URL,
    BASE_URL_REF: process.env.BASE_URL_REF,
    BASE_URL_MONEY: process.env.BASE_URL_MONEY,
    BASE_URL_SPRAY: process.env.BASE_URL_SPRAY,
    BASE_URL_ACH: process.env.BASE_URL_ACH,
    BASE_URL_OPENPACK: process.env.BASE_URL_OPENPACK,
    USERS_FILE: 'users.json',
};

const BASE_URL = CONFIG.BASE_URL;
const BASE_URL_REF = CONFIG.BASE_URL_REF;
const BASE_URL_MONEY = CONFIG.BASE_URL_MONEY;
const BASE_URL_SPRAY = CONFIG.BASE_URL_SPRAY;
const BASE_URL_ACH = CONFIG.BASE_URL_ACH;
const USERS_CONFIG = CONFIG.USERS_FILE;
const BASE_URL_OPENPACK = CONFIG.BASE_URL_OPENPACK;

// ---------- ✅ Derive kolex API base for collections / market ----------
function deriveApiBase() {
    if (process.env.BASE_URL_COLLECTIONS) return process.env.BASE_URL_COLLECTIONS.replace(/\/+$/, '');
    if (process.env.BASE_URL_MARKET)      return process.env.BASE_URL_MARKET.replace(/\/+$/, '');

    const tryStrip = (url, patterns) => {
        if (!url) return null;
        const noQuery = url.split('?')[0].replace(/\/+$/, '');
        for (const p of patterns) {
            const s = noQuery.replace(p, '');
            if (s !== noQuery) return s;
        }
        return null;
    };

    const fromSpray = tryStrip(BASE_URL_SPRAY, [/\/spinner\/spin$/, /\/spinner$/, /\/spin$/]);
    if (fromSpray) return fromSpray;

    const fromRef = tryStrip(BASE_URL_REF, [/\/auth\/refresh$/, /\/refresh$/, /\/auth$/]);
    if (fromRef) return fromRef;

    const fromMoney = tryStrip(BASE_URL_MONEY, [/\/user\/funds$/, /\/funds$/]);
    if (fromMoney) return fromMoney;

    return '';
}

const KOLEX_API_BASE = deriveApiBase();
const BASE_URL_COLLECTIONS = process.env.BASE_URL_COLLECTIONS || KOLEX_API_BASE;
const BASE_URL_MARKET      = process.env.BASE_URL_MARKET      || KOLEX_API_BASE;

// Spinner endpoint — derive from SPRAY (…/spinner/spin → …/spinner), or override via env
let BASE_URL_SPINNER = process.env.BASE_URL_SPINNER;
if (!BASE_URL_SPINNER && BASE_URL_SPRAY) {
    BASE_URL_SPINNER = BASE_URL_SPRAY.split('?')[0].replace(/\/spin\/?$/, '');
}

// ============================================================
// 📊 STATE
// ============================================================
let userData = {};
let activityLogs = [];

let globalSpinnerConfig = {
    spinnerId: 7030,
    packIds: [11953, 12053, 12079, 12121, 12145, 12316, 14356],
    autoFetch: true,
    lastAutoFetch: null,
};

let globalListingConfig = { delayMs: 2400 };
let templateCirculationCache = {};
let collectionCirculationProfiles = {};

const DEFAULT_EXCLUDED_COLLECTIONS = new Set([
    1,2,3,4,5,6,7,8,9,10,11,104,105,106,153,154,155,156,157,158,159,160,161,162,163,164,165,166,167,168,
    181,183,188,928,929,930,931,932,933,934,935,936,937,938,939,940,941,943,945,946,947,
    2740,2938,2939,2940,2941,2942,2943,2944,2945,2946,2947,2948,2950,2953,2954,2955,2957,2958,2959,
    2961,2964,2966,6650,6651,6652,6653,6654,6655,6656,6657,6658,6659,6660,6661,6662,6663,6664,6665,6666,
    18316,18514,18877,18911,18913,18914,18927,18928,18930,20131,18918,18932,
    11155,11156,11157,11225,11551,16411,16412,16413,2542,2543,1376,1378,1379,1380,1381,1383,1384,1385
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ============================================================
// 💵 PRICE FORMULA
// ============================================================
function mintDesirability(M, circulation) {
    const m = Math.max(1, Math.floor(M));
    let B;
    if (m === 1) B = 1.00;
    else if (m === 2) B = 0.60;
    else if (m <= 5) B = 0.52 - 0.04 * (m - 3);
    else if (m <= 9) B = 0.38 - 0.025 * (m - 6);
    else if (m <= 19) B = 0.25 - 0.009 * (m - 10);
    else if (m <= 49) B = 0.15 * Math.exp(-0.035 * (m - 20));
    else B = 0.055 * Math.exp(-0.045 * (m - 50));
    if (circulation > 500 && m >= 11) B *= 0.50;
    return B;
}
function classifyTier(CL) {
    if (CL <= 150) return 'legendary';
    if (CL <= 500) return 'epic';
    return 'ordinary';
}
function tierFloor(tier, CL) {
    if (tier === 'legendary') return clamp(2.00 + 0.50 * (150 - CL) / 100, 2.00, 2.50);
    if (tier === 'epic') return clamp(0.25 + 0.15 * (500 - CL) / 250, 0.25, 0.40);
    return 0.10;
}
function mintOneValue(tier, R, CL) {
    if (tier === 'legendary') return 10.00 * Math.pow(150 / CL, 0.20) * Math.exp(0.25 * (R - 9.00));
    if (tier === 'epic')      return 5.50 * Math.pow(250 / CL, 0.55) * Math.exp(0.22 * (R - 9.00));
    return Math.min(5.50, 3.40 * Math.exp(0.28 * (R - 4.30)));
}
function randomStrength(tier, M, premium) {
    if (premium < 0.015) return 0;
    const m = Math.max(1, Math.floor(M));
    if (tier === 'legendary') {
        if (m === 1) return 0.51;
        if (m === 2) return 0.345;
        if (m <= 5) return 0.27;
    }
    if (m === 1) return 0.33;
    if (m === 2) return 0.27;
    if (m <= 9) return 0.225;
    if (m <= 19) return 0.195;
    if (m <= 49) return 0.15;
    return 0.10 * clamp(premium / 0.50, 0, 1);
}
function roundMarketPrice(v) {
    if (v < 1) return Math.round(v * 100) / 100;
    if (v < 5) return Math.round(v * 20) / 20;
    return Math.round(v * 10) / 10;
}
function deterministicRandom(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h) + seed.charCodeAt(i); h |= 0; }
    return ((h >>> 0) % 100000) / 50000 - 1;
}

async function loadCirculationCache() {
    try {
        const raw = await fs.readFile('circulation-cache.json', 'utf8');
        const p = JSON.parse(raw);
        templateCirculationCache = p.templateCache || {};
        collectionCirculationProfiles = p.collectionProfiles || {};
        console.log(`✅ Cache: ${Object.keys(templateCirculationCache).length} templates, ` +
                    `${Object.keys(collectionCirculationProfiles).length} collections`);
    } catch { console.log('ℹ️ No circulation cache yet'); }
}
async function saveCirculationCache() {
    try {
        await fs.writeFile('circulation-cache.json', JSON.stringify({
            templateCache: templateCirculationCache,
            collectionProfiles: collectionCirculationProfiles,
        }, null, 2));
    } catch (e) { console.error('Cache save failed:', e); }
}
function recordTemplateCirculation(templateId, minted) {
    if (!templateId || !minted || minted <= 0) return;
    templateCirculationCache[templateId] = minted;
}
function mergeCollectionObservation(collectionId, minted, rating) {
    if (!collectionId || !minted || minted <= 0) return;
    if (!collectionCirculationProfiles[collectionId]) collectionCirculationProfiles[collectionId] = [];
    const groups = collectionCirculationProfiles[collectionId];
    const found = groups.find(g => g.minted === minted);
    if (found) {
        found.count += 1;
        found.ratingMin = Math.min(found.ratingMin, rating);
        found.ratingMax = Math.max(found.ratingMax, rating);
    } else {
        groups.push({ minted, count: 1, ratingMin: rating, ratingMax: rating });
        groups.sort((a, b) => a.minted - b.minted);
    }
}
function resolveCirculation({ totalMinted, templateId, collectionId, mintNumber, rating }) {
    const M = Math.max(1, Math.floor(mintNumber || 1));
    const R = clamp(rating || 0, 0, 10);
    if (totalMinted != null && Number.isFinite(totalMinted) && totalMinted >= M) {
        recordTemplateCirculation(templateId, totalMinted);
        return { circulation: totalMinted, source: 'direct', confidence: 1.00 };
    }
    const cached = templateId != null ? templateCirculationCache[templateId] : undefined;
    if (cached !== undefined && cached >= M) {
        return { circulation: cached, source: 'template-cache', confidence: 0.98 };
    }
    const groups = collectionId != null ? (collectionCirculationProfiles[collectionId] || []) : [];
    const valid = groups.filter(g => g.minted >= M);
    if (valid.length === 1) {
        return { circulation: valid[0].minted, source: 'collection-single', confidence: 0.90 };
    }
    if (valid.length > 1) {
        let best = null, bestDist = Infinity;
        for (const g of valid) {
            let dist = 0;
            if (R < g.ratingMin) dist = g.ratingMin - R;
            else if (R > g.ratingMax) dist = R - g.ratingMax;
            if (dist < bestDist || (dist === bestDist && (best === null || g.minted > best.minted))) {
                best = g; bestDist = dist;
            }
        }
        const confidence = clamp(0.88 - bestDist * 0.15, 0.60, 0.88);
        return { circulation: best.minted, source: 'collection-rating-match', confidence };
    }
    let estimated;
    if (R >= 7.75 && M > 20) estimated = 100;
    else if (R >= 7.50) estimated = 250;
    else if (R >= 6.00) estimated = 250;
    else if (R >= 4.50) estimated = 2500;
    else estimated = 10000;
    if (estimated < M) {
        if (M <= 250) estimated = 250;
        else if (M <= 500) estimated = 500;
        else if (M <= 2500) estimated = 2500;
        else if (M <= 5000) estimated = 5000;
        else if (M <= 7500) estimated = 7500;
        else estimated = 10000;
    }
    return { circulation: estimated, source: 'rating-fallback', confidence: 0.45 };
}

function calculateListingPrice(card, userId, opts = {}) {
    const M = Math.max(1, Math.floor(card.mintNumber || 1));
    const R = clamp(card.rating || 0, 0, 10);
    const aggression = clamp(opts.aggression ?? 0, -1, 1);
    const circ = resolveCirculation({
        totalMinted: card.minted, templateId: card.templateId,
        collectionId: card.collectionId, mintNumber: M, rating: R,
    });
    const CL = circ.circulation;
    const tier = classifyTier(CL);
    const F = tierFloor(tier, CL);
    const V = Math.max(F, mintOneValue(tier, R, CL));
    const B = mintDesirability(M, CL);
    let basePrice = F + (V - F) * B;
    if (circ.source === 'rating-fallback') basePrice = F + (basePrice - F) * 0.82;
    else if (circ.source === 'collection-rating-match') basePrice = F + (basePrice - F) * 0.95;
    const premium = Math.max(0, basePrice - F);
    const rs = randomStrength(tier, M, premium);
    const period = opts.pricingPeriod || new Date().toISOString().slice(0, 10);
    const RM = (opts.randomValue != null) ? clamp(opts.randomValue, -1, 1)
                                          : deterministicRandom(`${card.id}:${userId}:${period}`);
    const randomMultiplier = Math.exp(rs * RM);
    const aggressionMultiplier = Math.exp(0.12 * aggression);
    let adjustedPrice = F + premium * randomMultiplier * aggressionMultiplier;
    const minRatio = tier === 'legendary' && M === 1 ? 0.70 : 0.78;
    const maxRatio = tier === 'legendary' && M === 1 ? 1.55 : 1.35;
    adjustedPrice = clamp(adjustedPrice, Math.max(F, basePrice * minRatio), basePrice * maxRatio);
    adjustedPrice = Math.min(adjustedPrice, 15.00);
    const finalPrice = Math.max(F, adjustedPrice);
    return {
        price: roundMarketPrice(finalPrice), basePrice: roundMarketPrice(basePrice),
        floor: F, mintOneValue: V, mintFactor: B, tier,
        circulationUsed: CL, circulationSource: circ.source, circulationConfidence: circ.confidence,
        randomValue: RM, randomStrength: rs, randomMultiplier,
        aggression, aggressionMultiplier,
    };
}
function getUserAggression(user) { return clamp(Number(user.aggression ?? 0), -1, 1); }

// 🎯 Axios instance — PROXY APPLIED TO ALL REQUESTS
function createAxiosInstance() {
    const config = {
        timeout: 20000
    };

    if (PROXY_ENABLED && proxyAgent) {
        config.httpsAgent = proxyAgent;
        config.httpAgent = proxyAgent;
        if (PROXY_URL && !PROXY_URL.startsWith('socks')) {
            config.proxy = false;
        }
    }

    return axios.create(config);
}

// ============================================================
// 🚀 INIT
// ============================================================
async function initializeApp() {
    try {
        console.log('🚀 INITIALIZING APPLICATION...');
        console.log(`🌐 Proxy Status: ${PROXY_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        if (PROXY_ENABLED && PROXY_URL) {
            console.log(`   Proxy URL: ${PROXY_URL.replace(/:[^@]*@/, ':***@')}`);
        }
        console.log('🔧 URL Resolution:');
        console.log(`   BASE_URL_REF         = ${BASE_URL_REF || '(unset)'}`);
        console.log(`   BASE_URL_SPRAY       = ${BASE_URL_SPRAY || '(unset)'}`);
        console.log(`   BASE_URL_MONEY       = ${BASE_URL_MONEY || '(unset)'}`);
        console.log(`   BASE_URL_SPINNER     = ${BASE_URL_SPINNER || '(unset)'}`);
        console.log(`   KOLEX_API_BASE       = ${KOLEX_API_BASE || '(EMPTY! ⚠️)'}`);
        console.log(`   BASE_URL_COLLECTIONS = ${BASE_URL_COLLECTIONS || '(EMPTY! ⚠️)'}`);
        console.log(`   BASE_URL_MARKET      = ${BASE_URL_MARKET || '(EMPTY! ⚠️)'}`);

        if (!BASE_URL_COLLECTIONS || !BASE_URL_MARKET) {
            console.warn('⚠️  Scanner will fail — set BASE_URL_COLLECTIONS and BASE_URL_MARKET env vars');
            console.warn('   (or ensure BASE_URL_SPRAY ends with /spinner/spin so it can be derived)');
        }

        await loadUserConfig();
        await loadCirculationCache();

        // Load spinner config
        try {
            const parsed = JSON.parse(await fs.readFile('spinner-config.json', 'utf8'));
            globalSpinnerConfig = {
                spinnerId: parsed.spinnerId || 7030,
                packIds: Array.isArray(parsed.packIds) ? parsed.packIds : [11953, 12053, 12079, 12121, 12145, 12316, 14356],
                autoFetch: parsed.autoFetch !== undefined ? !!parsed.autoFetch : true,
                lastAutoFetch: parsed.lastAutoFetch || null,
            };
            console.log('✅ Loaded saved spinner config:', globalSpinnerConfig);
        } catch {
            console.log('ℹ️ Using default spinner config');
            await saveSpinnerConfig();
        }

        // Load listing config
        try {
            const p = JSON.parse(await fs.readFile('listing-config.json', 'utf8'));
            globalListingConfig.delayMs = p.delayMs || 2400;
        } catch {
            await fs.writeFile('listing-config.json', JSON.stringify(globalListingConfig, null, 2));
        }

        console.log('🔄 REFRESHING TOKENS FOR ALL USERS AT STARTUP...');
        for (const userId of Object.keys(userData)) {
            await refreshToken(userId);
        }

        console.log('✅ Application initialized successfully');
        startImmediateOperations();
        startScheduledTasks();
        startContinuousOperations();
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
    }
}

function startImmediateOperations() {
    console.log('🎯 STARTING IMMEDIATE OPERATIONS...');
    setTimeout(() => {
        Object.keys(userData).forEach((userId) => {
            const user = userData[userId];
            if (user.isActive && isWithinActiveWindow(userId)) {
                logActivity(userId, '🚀 Starting immediate operations after startup');
                setTimeout(() => { claimAchievements(userId); }, 10000);
                checkFunds(userId);
                if (!user.nextSpinTime) calculateNextSpinTime(userId);
            }
        });
    }, 120000);
}

async function loadUserConfig() {
    try {
        const configData = await fs.readFile(USERS_CONFIG, 'utf8');
        const users = JSON.parse(configData);

        for (const user of users) {
            userData[user.userId] = {
                ...user,
                jwtToken: null,
                lastRefresh: null,
                nextSpinTime: null,
                nextListerTime: null,
                spinCount: 0,
                achievementsClaimed: 0,
                lastFunds: 0,
                lastCoronas: 0,
                lastUsd: 0,
                logs: [],
                isActive: false,
                dailyAchievementsDone: false,
                dailyFundsChecks: 0,
                packsOpened: 0,
                aggression: user.aggression != null ? Number(user.aggression) : 0,
                listerJitter: user.listerJitter ?? user['lister-jitter'] ?? 150,
            };
        }
        console.log(`✅ Loaded configuration for ${users.length} users`);
    } catch (error) {
        console.error('❌ Error loading user config:', error);
        userData = {};
    }
}

// ============================================================
// 🔌 API REQUEST — ALL CALLS GO THROUGH PROXY
// ============================================================
async function makeAPIRequest(url, method = 'GET', headers = {}, data = null, userId = 'system') {
    try {
        debugLog(userId, 'SENDING_REQUEST', url, method, headers, data);

        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance({
            method: method.toLowerCase(),
            url: url,
            headers: {
                'Content-Type': 'application/json',
                ...headers
            },
            data: data
        });

        debugLog(userId, 'REQUEST_SUCCESS', url, method, headers, data, response);
        return { success: true, data: response.data, status: response.status };
    } catch (error) {
        debugLog(userId, 'REQUEST_ERROR', url, method, headers, data, null, error);
        return {
            success: false,
            error: error.message,
            status: error.response?.status,
            responseData: error.response?.data
        };
    }
}

// ============================================================
// 🎡 SPINNER HELPERS
// ============================================================
async function saveSpinnerConfig() {
    try {
        await fs.writeFile('spinner-config.json', JSON.stringify(globalSpinnerConfig, null, 2));
    } catch (e) { console.error('Failed to save spinner config:', e); }
}

async function fetchAndUpdateSpinnerInfo(userId, force = false) {
    const user = userData[userId];
    if (!user?.jwtToken) {
        logActivity('system', `❌ Spinner: no JWT for ${userId}`);
        return false;
    }
    if (!force) {
        if (!globalSpinnerConfig.autoFetch) return false;
        if (globalSpinnerConfig.lastAutoFetch) {
            const elapsed = Date.now() - new Date(globalSpinnerConfig.lastAutoFetch).getTime();
            if (elapsed < 5 * 60 * 1000) return true;
        }
    }
    if (!BASE_URL_SPINNER) {
        logActivity('system', '❌ BASE_URL_SPINNER missing');
        return false;
    }

    const url = `${BASE_URL_SPINNER}?categoryId=1`;
    const res = await makeAPIRequest(url, 'GET',
        { 'Content-Type': 'application/json', 'x-user-jwt': user.jwtToken }, null, userId);

    if (!res.success || !res.data?.data) {
        logActivity('system', `❌ Spinner fetch failed: ${res.error || 'no data'}`);
        return false;
    }

    const data = res.data.data;
    const items = Array.isArray(data.items) ? data.items : [];
    const packPrizeIds = items
        .filter(it => Array.isArray(it.properties?.pack_templates) && it.properties.pack_templates.length > 0)
        .map(it => it.id);

    globalSpinnerConfig.spinnerId = data.id;
    globalSpinnerConfig.packIds = packPrizeIds;
    globalSpinnerConfig.lastAutoFetch = new Date().toISOString();
    await saveSpinnerConfig();
    logActivity('system', `🎡 Spinner: ID=${data.id}, packs=[${packPrizeIds.join(',')}]`);
    return true;
}

// ============================================================
// 🔑 TOKEN REFRESH
// ============================================================
async function refreshToken(userId) {
    const user = userData[userId];
    if (!user) {
        logActivity(userId, 'ERROR: User not found in configuration');
        return false;
    }

    logActivity(userId, 'Starting token refresh...');
    const result = await makeAPIRequest(BASE_URL_REF, 'POST',
        { 'Content-Type': 'application/json' },
        { refreshToken: user.refreshToken }, userId);

    if (result.success && result.data.data?.jwt) {
        user.jwtToken = result.data.data.jwt;
        user.lastRefresh = new Date().toISOString();
        user.isActive = true;

        const newRefreshToken = result.data.data?.refreshToken;
        if (newRefreshToken && newRefreshToken !== 'Not provided') {
            user.refreshToken = newRefreshToken;
            await updateUserConfig(userId, 'refreshToken', newRefreshToken);
        }

        logActivity(userId, '✅ Token refresh successful. New JWT stored.');

        // Auto-fetch spinner map on refresh
        try { await fetchAndUpdateSpinnerInfo(userId, false); }
        catch (e) { logActivity(userId, `⚠️ Spinner auto-fetch: ${e.message}`); }

        scheduleNextTokenRefresh(userId);
        return true;
    } else {
        logActivity(userId, `❌ Token refresh failed: ${result.error}`);
        user.isActive = false;
        return false;
    }
}

function scheduleNextTokenRefresh(userId) {
    const user = userData[userId];
    if (!user) return;

    const { h: startH, m: startM } = parseHHMM(user.dayStart);
    let base = utcTodayAt(startH, startM, 0, 0);
    base = addMs(base, 24 * 60 * 60 * 1000);

    const jitterRangeMs = minutesToMs(20);
    const randMs = Math.floor(Math.random() * (2 * jitterRangeMs + 1)) - jitterRangeMs;
    const nextRefresh = addMs(base, randMs);

    const delay = Math.max(nextRefresh.getTime() - Date.now(), 1000);

    setTimeout(async () => {
        logActivity(userId, `🔄 Daily token refresh firing (jitter ${Math.round(randMs / 60000)}m)`);
        await refreshToken(userId);
    }, delay);

    logActivity(userId, `⏰ Next token refresh scheduled for: ${nextRefresh.toUTCString()} (jitter ${Math.round(randMs/60000)}m)`);
}

// ============================================================
// 💰 FUNDS / ACHIEVEMENTS / PACKS / SPINS
// ============================================================
async function checkFunds(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for funds check');
        return null;
    }

    const result = await makeAPIRequest(BASE_URL_MONEY, 'GET', { 'x-user-jwt': user.jwtToken }, null, userId);

    if (result.success && result.data.data) {
        const silvercoins = result.data.data.silvercoins || 0;
        const coronas = result.data.data.coronas || 0;
        const usd = result.data.data.usd || "0";
        user.lastFunds = silvercoins;
        user.lastCoronas = coronas;
        user.lastUsd = usd;
        user.dailyFundsChecks = (user.dailyFundsChecks || 0) + 1;
        logActivity(userId, `💰 Silver: ${silvercoins.toLocaleString()} | Coronas: ${coronas.toLocaleString()} | USD: ${usd}`);
        return { silvercoins, coronas, usd };
    } else {
        if (result.status === 401) {
            logActivity(userId, 'JWT expired during funds check, attempting refresh...');
            if (await refreshToken(userId)) return await checkFunds(userId);
        }
        logActivity(userId, `❌ Funds check failed: ${result.error}`);
        return null;
    }
}

async function claimAchievements(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for achievements');
        return 0;
    }

    let totalClaimed = 0;
    const headers = { 'x-user-jwt': user.jwtToken };
    logActivity(userId, '🎯 Starting achievements claim process...');

    try {
        const achievementsResult = await makeAPIRequest(
            `${BASE_URL_ACH}/${user.userId}/user`, 'GET', headers, null, userId);

        if (!achievementsResult.success) {
            if (achievementsResult.status === 401) {
                if (await refreshToken(userId)) return await claimAchievements(userId);
            }
            logActivity(userId, `❌ Achievements check failed: ${achievementsResult.error}`);
            return 0;
        }

        const validIDs = [];
        ['achievements', 'daily', 'weekly', 'monthly'].forEach((category) => {
            if (achievementsResult.data.data[category]) {
                achievementsResult.data.data[category].forEach((item) => {
                    if (item.progress?.claimAvailable) validIDs.push(item.id);
                });
            }
        });

        if (validIDs.length === 0) {
            logActivity(userId, 'ℹ️ No achievements available to claim');
            return 0;
        }

        logActivity(userId, `🎯 Found ${validIDs.length} achievements to claim`);

        const batchSize = 3;
        for (let i = 0; i < validIDs.length; i += batchSize) {
            const batch = validIDs.slice(i, i + batchSize);
            for (const achievementId of batch) {
                const claimResult = await makeAPIRequest(
                    `${BASE_URL_ACH}/${achievementId}/claim/`, 'POST', headers, null, userId);
                if (claimResult.success) {
                    totalClaimed++;
                    logActivity(userId, `✅ Claimed achievement ID: ${achievementId}`);
                } else {
                    logActivity(userId, `❌ Failed to claim ${achievementId}: ${claimResult.error}`);
                }
                await sleep(800);
            }
            await sleep(1500);
        }

        user.achievementsClaimed += totalClaimed;
        logActivity(userId, `🎉 Successfully claimed ${totalClaimed} achievements`);
        return totalClaimed;
    } catch (error) {
        logActivity(userId, `❌ Error in achievements process: ${error.message}`);
        return 0;
    }
}

async function openPack(userId, packId) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;

    const result = await makeAPIRequest(
        BASE_URL_OPENPACK, 'POST',
        { 'x-user-jwt': user.jwtToken }, { packId }, userId);

    if (result.success) {
        user.packsOpened = (user.packsOpened || 0) + 1;
        logActivity(userId, `✅ Pack opened: ${packId}`);
        return true;
    } else if (result.status === 401) {
        if (await refreshToken(userId)) return await openPack(userId, packId);
    }

    logActivity(userId, `❌ Pack open failed: ${result.error}`);
    return false;
}

async function executeSpin(userId) {
    const user = userData[userId];
    if (!user || !user.jwtToken) {
        logActivity(userId, 'ERROR: No JWT token available for spin');
        calculateNextSpinTime(userId);
        return null;
    }

    if (!isWithinActiveWindow(userId)) {
        logActivity(userId, '⏰ Outside active window, skipping spin');
        return null;
    }

    const spinnerId = globalSpinnerConfig.spinnerId;
    logActivity(userId, `🎰 Executing free spin with spinnerId: ${spinnerId}...`);

    let spinSuccess = false;
    let prizeName = 'Unknown';

    try {
        const headers = {
            'x-user-jwt': user.jwtToken,
            'Content-Type': 'application/json',
        };

        const spinResult = await makeAPIRequest(BASE_URL_SPRAY, 'POST', headers, { spinnerId }, userId);

        if (!spinResult.success) {
            if (spinResult.status === 401) {
                logActivity(userId, 'JWT expired during spin, attempting refresh...');
                if (await refreshToken(userId)) {
                    logActivity(userId, '🔄 JWT refreshed, but not retrying spin. Scheduling next spin.');
                }
            }
            logActivity(userId, `⚠️ Spin failed: ${spinResult.error} - Continuing with schedule`);
        } else {
            const spinData = spinResult.data.data;
            const resultId = spinData.id;

            const prizeMap = {
                11986: '5,000 Spraycoins',
                11981: 'Standard Box 2026',
                12053: 'EPL 23 Box 2026',
                11980: '500 Spraycoins',
                11985: '1,000,000 Spraycoins',
                11984: '100,000 Spraycoins',
                11983: '2,500 Spraycoins',
                11982: '1,000 Spraycoins'
            };

            prizeName = prizeMap[resultId] || `ID = ${resultId}`;
            user.spinCount++;
            spinSuccess = true;

            const packTriggerIds = globalSpinnerConfig.packIds;
            if (packTriggerIds.includes(resultId) && spinData.packs && spinData.packs.length > 0) {
                const packId = spinData.packs[0].id;
                logActivity(userId, `🎁 Got pack from spin: ${packId}`);
                await openPack(userId, packId);
            } else {
                logActivity(userId, `🎰 Spin result: ${prizeName}`);
            }
        }
    } catch (error) {
        logActivity(userId, `❌ Spin error: ${error.message} - Continuing with schedule`);
    } finally {
        calculateNextSpinTime(userId);
    }

    return spinSuccess ? prizeName : null;
}

function calculateNextSpinTime(userId) {
    const user = userData[userId];
    if (!user) return null;

    const baseIntervalMs = user.baseInterval * 60 * 1000;
    const randomScale1Ms = user.randomScale1 * 60 * 1000;
    const randomScale2Ms = user.randomScale2 * 60 * 1000;

    const randomAddMs = Math.floor(
        Math.random() * (randomScale2Ms - randomScale1Ms) + randomScale1Ms
    );

    const totalDelayMs = baseIntervalMs + randomAddMs;
    const nextSpinTime = new Date(Date.now() + totalDelayMs);
    user.nextSpinTime = nextSpinTime.toISOString();

    logActivity(userId, `⏰ Next spin in ${Math.round(totalDelayMs / 1000 / 60)} minutes (at ${nextSpinTime.toUTCString()})`);
    return nextSpinTime;
}

function isWithinActiveWindow(userId) {
    const user = userData[userId];
    if (!user) return false;

    const now = new Date();

    if (!user._effectiveStartUTC || !user._effectiveEndUTC) {
        const { effectiveStart, effectiveEnd, randMs } = computeEffectiveWindow(user, now);
        user._effectiveStartUTC = effectiveStart;
        user._effectiveEndUTC   = effectiveEnd;
        user._startJitterMin    = Math.round(randMs / 60000);
        logActivity(userId, `ℹ️ Effective window initialized: start=${effectiveStart.toUTCString()}, end=${effectiveEnd.toUTCString()}`);
    }

    return now >= user._effectiveStartUTC && now <= user._effectiveEndUTC;
}

function timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

async function updateUserConfig(userId, field, value) {
    try {
        const configData = await fs.readFile(USERS_CONFIG, 'utf8');
        const users = JSON.parse(configData);
        const userIndex = users.findIndex((u) => u.userId === userId);
        if (userIndex !== -1) {
            users[userIndex][field] = value;
            await fs.writeFile(USERS_CONFIG, JSON.stringify(users, null, 2));
        }
    } catch (error) {
        console.error('Error updating user config:', error);
    }
}

function logActivity(userId, message) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, userId, message };
    activityLogs.unshift(logEntry);
    activityLogs = activityLogs.slice(0, 1000);
    if (userData[userId]) {
        userData[userId].logs.unshift(logEntry);
        userData[userId].logs = userData[userId].logs.slice(0, 200);
    }
    console.log(`[${timestamp}] User ${userId}: ${message}`);
}

// ============================================================
// 🕒 TIME / SERIALIZATION
// ============================================================
function utcTodayAt(hour, minute, second = 0, ms = 0) {
    const d = new Date();
    d.setUTCHours(hour, minute, second, ms);
    return d;
}
function addMs(date, ms) { return new Date(date.getTime() + ms); }
function minutesToMs(min) { return min * 60 * 1000; }
function parseHHMM(hhmm) { const [h, m] = hhmm.split(':').map(Number); return { h, m }; }

function toISOStringOrNull(val) {
    if (!val) return null;
    try {
        const d = new Date(val);
        return isNaN(d) ? null : d.toISOString();
    } catch { return null; }
}

function safeUsersSnapshot() {
    const out = {};
    for (const [id, u] of Object.entries(userData)) {
        const { _achTimers, _dailyRolloverTimer, _listerTimer, ...rest } = u;
        out[id] = {
            ...rest,
            _effectiveStartUTC: toISOStringOrNull(u._effectiveStartUTC),
            _effectiveEndUTC: toISOStringOrNull(u._effectiveEndUTC)
        };
    }
    return out;
}

function ensureTimerHolders(user) {
    ['_achTimers', '_dailyRolloverTimer', '_listerTimer'].forEach(name => {
        const d = Object.getOwnPropertyDescriptor(user, name);
        if (!d || d.enumerable) {
            Object.defineProperty(user, name, {
                value: name === '_achTimers' ? [] : null,
                writable: true, configurable: true, enumerable: false,
            });
        }
    });
}

function computeEffectiveWindow(user, now = new Date()) {
    const { h: startH, m: startM } = parseHHMM(user.dayStart);
    const { h: endH, m: endM } = parseHHMM(user.dayEnd);

    let baseStart = utcTodayAt(startH, startM, 0, 0);
    let baseEnd   = utcTodayAt(endH, endM, 0, 0);

    if (baseEnd <= baseStart) baseEnd = addMs(baseEnd, 24 * 60 * 60 * 1000);
    if (now > baseEnd) {
        baseStart = addMs(baseStart, 24 * 60 * 60 * 1000);
        baseEnd   = addMs(baseEnd,   24 * 60 * 60 * 1000);
    }

    const jitterRangeMs = minutesToMs(20);
    const randMs = Math.floor(Math.random() * (2 * jitterRangeMs + 1)) - jitterRangeMs;
    const effectiveStart = addMs(baseStart, randMs);
    const effectiveEnd   = baseEnd;

    return { effectiveStart, effectiveEnd, randMs };
}

function clearAchievementTimers(userId) {
    const user = userData[userId];
    if (!user) return;

    ensureTimerHolders(user);

    if (Array.isArray(user._achTimers)) {
        user._achTimers.forEach(t => clearTimeout(t));
    }
    Object.defineProperty(user, '_achTimers', {
        value: [], writable: true, configurable: true, enumerable: false,
    });

    if (user._dailyRolloverTimer) clearTimeout(user._dailyRolloverTimer);
    Object.defineProperty(user, '_dailyRolloverTimer', {
        value: null, writable: true, configurable: true, enumerable: false,
    });

    if (user._listerTimer) clearTimeout(user._listerTimer);
    Object.defineProperty(user, '_listerTimer', {
        value: null, writable: true, configurable: true, enumerable: false,
    });
}

// ============================================================
// 📅 DAILY PLAN
// ============================================================
function scheduleDailyPlan(userId) {
    const user = userData[userId];
    if (!user) return;
    ensureTimerHolders(user);
    clearAchievementTimers(userId);

    const now = new Date();
    const { effectiveStart, effectiveEnd, randMs } = computeEffectiveWindow(user, now);

    user._effectiveStartUTC = effectiveStart;
    user._effectiveEndUTC   = effectiveEnd;
    user._startJitterMin    = Math.round(randMs / 60000);

    logActivity(userId,
        `📅 Daily plan set (UTC): start=${effectiveStart.toUTCString()} ` +
        `(jitter ${user._startJitterMin}m), end=${effectiveEnd.toUTCString()}`);

    const claim1 = addMs(effectiveStart, minutesToMs(35));
    const claim2 = addMs(claim1,       minutesToMs(8 * 60));
    const claim3 = addMs(effectiveEnd, -minutesToMs(25));

    const scheduleClaim = (when, label) => {
        const delay = when.getTime() - Date.now();
        if (delay <= 0) {
            logActivity(userId, `⏭️ ${label} skipped (time passed)`);
            return;
        }
        const timer = setTimeout(async () => {
            try {
                if (!user.isActive) {
                    logActivity(userId, `⏸️ ${label} skipped (user inactive)`);
                } else {
                    logActivity(userId, `🏁 ${label} firing`);
                    await claimAchievements(userId);
                }
            } catch (e) {
                logActivity(userId, `⚠️ ${label} error: ${e.message}`);
            }
        }, delay);
        user._achTimers.push(timer);
        logActivity(userId, `⏰ ${label} scheduled for ${when.toUTCString()} (in ${Math.round(delay/60000)}m)`);
    };

    scheduleClaim(claim1, 'Achievements #1 (Start+35m)');
    scheduleClaim(claim2, 'Achievements #2 (+8h)');
    scheduleClaim(claim3, 'Achievements #3 (End-25m)');

    // Lister schedule
    const listerJitterMin = Number(user.listerJitter) || 150;
    const listerAt = addMs(effectiveStart, minutesToMs(listerJitterMin));
    const listerDelay = listerAt.getTime() - Date.now();
    if (listerDelay > 0) {
        user._listerTimer = setTimeout(async () => {
            logActivity(userId, '📋 Daily lister firing');
            if (user.isActive && user.jwtToken) {
                try { await scanAndListCards(userId); }
                catch (e) { logActivity(userId, `❌ Lister: ${e.message}`); }
            }
        }, listerDelay);
        user.nextListerTime = listerAt.toISOString();
        logActivity(userId, `⏰ Lister scheduled for ${listerAt.toUTCString()} (+${listerJitterMin}m)`);
    } else {
        user.nextListerTime = null;
        logActivity(userId, `⏭️ Lister skipped (past)`);
    }

    const rolloverAt = addMs(effectiveEnd, minutesToMs(2));
    user._dailyRolloverTimer = setTimeout(() => {
        logActivity(userId, '🔁 Rollover: computing next day plan');
        scheduleDailyPlan(userId);
    }, Math.max(rolloverAt.getTime() - Date.now(), 1000));
}

function scheduleDailyPlanForAllUsers() {
    logActivity('system', '🗓️ Scheduling daily plans for all users');
    Object.keys(userData).forEach((userId) => scheduleDailyPlan(userId));
}

// ============================================================
// 📋 SCANNER / LISTER
// ============================================================
async function fetchMarketTemplatesForCollection(userId, headers, collectionId) {
    const out = {};
    if (!BASE_URL_MARKET) return out;
    let page = 1;
    while (page <= 20) {
        const url = `${BASE_URL_MARKET}/market/templates?type=card&page=${page}&categoryId=1&collectionIds=${collectionId}`;
        const r = await makeAPIRequest(url, 'GET', headers, null, userId);
        if (!r.success || !r.data?.data) break;
        const tpl = r.data.data.templates || [];
        for (const t of tpl) {
            const cardT = t.cardTemplate;
            if (!cardT?.id) continue;
            out[cardT.id] = {
                minted: Number(cardT.minted) > 0 ? Number(cardT.minted) : null,
                inCirculation: Number(cardT.inCirculation) > 0 ? Number(cardT.inCirculation) : null,
            };
        }
        if (tpl.length < 40) break;
        page++;
        await sleep(400);
    }
    return out;
}

async function scanUserCards(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) return [];
    if (!BASE_URL_COLLECTIONS) {
        logActivity(userId, '❌ Scan: BASE_URL_COLLECTIONS empty — set env var');
        return [];
    }

    const headers = { 'Content-Type': 'application/json', 'x-user-jwt': user.jwtToken };
    const collected = [];

    const summaryUrl = `${BASE_URL_COLLECTIONS}/collections/users/${user.userId}/user-summary?categoryId=1&seasons=2026`;
    const summary = await makeAPIRequest(summaryUrl, 'GET', headers, null, userId);
    if (!summary.success || !Array.isArray(summary.data?.data)) {
        logActivity(userId, `⚠️ Scan: collections fetch failed (status=${summary.status} err=${summary.error || 'none'})`);
        return [];
    }

    const collections = [];
    for (const row of summary.data.data) {
        if (!row || row.count === 0) continue;
        const coll = row.collection;
        if (!coll) continue;
        if (coll.properties?.tiers?.includes('Loadout')) continue;
        if (DEFAULT_EXCLUDED_COLLECTIONS.has(coll.id)) continue;
        const type = coll.properties?.entity_types?.[0] || 'card';
        if (type !== 'card') continue;
        if (!collections.some(c => c.id === coll.id)) collections.push({ id: coll.id });
    }
    logActivity(userId, `🔍 Scan: ${collections.length} collections`);

    for (const coll of collections) {
        if (!user.isActive) break;
        const marketTpl = await fetchMarketTemplatesForCollection(userId, headers, coll.id);
        const itemsUrl = `${BASE_URL_COLLECTIONS}/collections/${coll.id}/users/${user.userId}/owned2`;
        const items = await makeAPIRequest(itemsUrl, 'GET', headers, null, userId);
        if (!items.success) {
            logActivity(userId, `⚠️ Items fail coll ${coll.id}`);
            continue;
        }
        const cards = items.data?.data?.cards || [];
        for (const item of cards) {
            if (item.status !== 'available') continue;
            if (!item.id || item.mintNumber == null) continue;
            const templateId = item.cardTemplateId || null;
            const mkt = templateId != null ? marketTpl[templateId] : null;
            const minted = mkt?.minted || null;
            const rating = Number(item.rating) || 0;
            collected.push({
                id: item.id, mintNumber: Number(item.mintNumber) || 0,
                rating, templateId, collectionId: coll.id, minted,
            });
            if (templateId && minted) {
                recordTemplateCirculation(templateId, minted);
                mergeCollectionObservation(coll.id, minted, rating);
            }
        }
    }

    const seen = new Set();
    const unique = [];
    for (const it of collected) {
        if (!seen.has(it.id)) { seen.add(it.id); unique.push(it); }
    }
    logActivity(userId, `🔍 Scan: ${unique.length} unique available cards`);
    return unique;
}

async function listCardOnMarket(userId, cardId, price) {
    const user = userData[userId];
    if (!user?.jwtToken) return false;
    if (!BASE_URL_MARKET) return false;
    const r = await makeAPIRequest(`${BASE_URL_MARKET}/market/list`, 'POST',
        { 'Content-Type': 'application/json', 'x-user-jwt': user.jwtToken },
        { id: cardId, type: 'card', price: String(price) }, userId);
    return r.success;
}

async function scanAndListCards(userId) {
    const user = userData[userId];
    if (!user?.jwtToken) {
        logActivity(userId, '❌ Scan+list: no JWT');
        return { scanned: 0, listed: 0, failed: 0 };
    }

    logActivity(userId, '🔍 Scan+list start');
    const cards = await scanUserCards(userId);
    await saveCirculationCache();
    if (!cards.length) {
        logActivity(userId, 'ℹ️ Nothing to list');
        return { scanned: 0, listed: 0, failed: 0 };
    }

    const aggression = getUserAggression(user);
    const delay = Math.max(Number(globalListingConfig.delayMs) || 2400, 100);
    const period = new Date().toISOString().slice(0, 10);
    let listed = 0, failed = 0;

    for (let i = 0; i < cards.length; i++) {
        if (!user.isActive) {
            logActivity(userId, '⏸ Inactive mid-list');
            break;
        }
        const card = cards[i];
        const info = calculateListingPrice(card, userId, { aggression, pricingPeriod: period });
        logActivity(userId,
            `💵 [${i+1}/${cards.length}] ${card.id} M=${card.mintNumber} R=${card.rating.toFixed(2)} ` +
            `→ ${info.price.toFixed(2)} (${info.tier}, CL=${info.circulationUsed}/${info.circulationSource}, ` +
            `base=${info.basePrice.toFixed(2)}, RM=${info.randomValue.toFixed(2)}, A=${aggression})`);
        const ok = await listCardOnMarket(userId, card.id, info.price);
        if (ok) listed++; else failed++;
        if (i < cards.length - 1) await sleep(delay);
    }

    logActivity(userId, `📋 Listed ${listed}, failed ${failed} of ${cards.length}`);
    return { scanned: cards.length, listed, failed };
}

// ============================================================
// 🔁 CONTINUOUS OPS
// ============================================================
function startContinuousOperations() {
    console.log('🚀 Starting continuous operations for all users...');

    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            const user = userData[userId];
            if (!user.isActive || !isWithinActiveWindow(userId)) continue;
            if (!user.nextSpinTime || new Date() >= new Date(user.nextSpinTime)) {
                await executeSpin(userId);
            }
        }
    }, 30000);

    setInterval(async () => {
        for (const userId of Object.keys(userData)) {
            if (isWithinActiveWindow(userId) && userData[userId].isActive) {
                await checkFunds(userId);
            }
        }
    }, 60 * 60 * 1000);
}

function startScheduledTasks() {
    console.log('⏰ Starting scheduled tasks...');
    scheduleDailyPlanForAllUsers();
    console.log('✅ Scheduled tasks started');
}

// ============================================================
// 🌐 API ROUTES
// ============================================================
app.get('/api/users', (req, res) => res.json(safeUsersSnapshot()));

app.get('/api/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(activityLogs.slice(0, limit));
});

app.get('/api/user/:userId/activity', (req, res) => {
    const user = userData[req.params.userId];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.logs.slice(0, parseInt(req.query.limit) || 50));
});

app.get('/api/debug-logs', (req, res) => {
    res.json(debugLogs.slice(0, parseInt(req.query.limit) || 50));
});

// Diagnostic
app.get('/api/test-collections/:userId', async (req, res) => {
    const userId = req.params.userId;
    const user = userData[userId];
    if (!user?.jwtToken) return res.status(400).json({ error: 'No JWT for user' });
    if (!BASE_URL_COLLECTIONS) return res.status(500).json({
        error: 'BASE_URL_COLLECTIONS empty',
        KOLEX_API_BASE, BASE_URL_SPRAY,
        hint: 'Set BASE_URL_COLLECTIONS env var to the API root (e.g. https://api.kolex.gg/api/v1)',
    });
    const url = `${BASE_URL_COLLECTIONS}/collections/users/${user.userId}/user-summary?categoryId=1&seasons=2026`;
    const result = await makeAPIRequest(url, 'GET', { 'x-user-jwt': user.jwtToken }, null, userId);
    res.json({
        url, success: result.success, status: result.status, error: result.error,
        dataPreview: result.data ? JSON.stringify(result.data).slice(0, 800) : null,
    });
});

// Spinner config
app.get('/api/spinner-config', (req, res) => res.json(globalSpinnerConfig));

app.post('/api/spinner-config', async (req, res) => {
    const { spinnerId, packIds, autoFetch } = req.body;

    if (spinnerId !== undefined && spinnerId !== '') {
        globalSpinnerConfig.spinnerId = parseInt(spinnerId) || globalSpinnerConfig.spinnerId;
    }
    if (packIds !== undefined) {
        if (typeof packIds === 'string') {
            globalSpinnerConfig.packIds = packIds.split(',')
                .map(id => parseInt(id.trim()))
                .filter(id => !isNaN(id));
        } else if (Array.isArray(packIds)) {
            globalSpinnerConfig.packIds = packIds.map(id => parseInt(id)).filter(id => !isNaN(id));
        }
    }
    if (autoFetch !== undefined) {
        globalSpinnerConfig.autoFetch = !!autoFetch;
    }

    await saveSpinnerConfig();
    logActivity('system',
        `⚙️ Spinner config updated - id=${globalSpinnerConfig.spinnerId}, ` +
        `packs=[${globalSpinnerConfig.packIds.join(',')}], autoFetch=${globalSpinnerConfig.autoFetch}`);
    res.json({ success: true, config: globalSpinnerConfig });
});

// Force fetch spinner map using any user JWT
app.post('/api/spinner-check', async (req, res) => {
    let userId = req.body?.userId;
    if (!userId) userId = Object.keys(userData).find(id => userData[id].jwtToken);
    if (!userId) return res.status(400).json({ error: 'No user with JWT' });
    if (!userData[userId]?.jwtToken) return res.status(400).json({ error: 'No JWT for user' });
    const success = await fetchAndUpdateSpinnerInfo(userId, true);
    res.json({ success, config: globalSpinnerConfig, usedUserId: userId });
});

app.post('/api/user/:userId/spinner-check', async (req, res) => {
    const userId = req.params.userId;
    if (!userData[userId]) return res.status(404).json({ error: 'User not found' });
    if (!userData[userId].jwtToken) return res.status(400).json({ error: 'No JWT for user' });
    const success = await fetchAndUpdateSpinnerInfo(userId, true);
    res.json({ success, config: globalSpinnerConfig, usedUserId: userId });
});

// Listing config
app.get('/api/listing-config', (req, res) => res.json(globalListingConfig));

app.post('/api/listing-config', async (req, res) => {
    if (req.body.delayMs !== undefined) {
        globalListingConfig.delayMs = Math.max(parseInt(req.body.delayMs) || 2400, 100);
    }
    try { await fs.writeFile('listing-config.json', JSON.stringify(globalListingConfig, null, 2)); } catch {}
    logActivity('system', `⚙️ Listing delay = ${globalListingConfig.delayMs}ms`);
    res.json({ success: true, config: globalListingConfig });
});

app.get('/api/circulation-cache', (req, res) => res.json({
    templateCount: Object.keys(templateCirculationCache).length,
    collectionCount: Object.keys(collectionCirculationProfiles).length,
    collectionProfiles: collectionCirculationProfiles,
}));

// Export endpoints
app.get('/api/export/user-jwt', (req, res) => {
    const exportData = {};
    for (const [userId, user] of Object.entries(userData)) {
        exportData[userId] = { userId, jwtToken: user.jwtToken || '' };
    }
    res.json(exportData);
});

app.get('/api/export/full-data', (req, res) => {
    const exportData = [];
    for (const [userId, user] of Object.entries(userData)) {
        exportData.push({
            nick: user.userNick || '',
            userId,
            funds: user.lastFunds || 0,
            coronas: user.lastCoronas || 0,
            usd: user.lastUsd || '0',
            jwtToken: user.jwtToken || ''
        });
    }
    res.json(exportData);
});

// Manual actions
app.post('/api/user/:userId/refresh', async (req, res) => {
    const success = await refreshToken(req.params.userId);
    res.json({ success, message: success ? 'Token refreshed' : 'Refresh failed' });
});

app.post('/api/user/:userId/spin', async (req, res) => {
    const result = await executeSpin(req.params.userId);
    res.json({ success: !!result, result });
});

app.post('/api/user/:userId/claim-achievements', async (req, res) => {
    const claimed = await claimAchievements(req.params.userId);
    res.json({ success: claimed > 0, claimed });
});

app.post('/api/user/:userId/check-funds', async (req, res) => {
    const funds = await checkFunds(req.params.userId);
    res.json({ success: funds !== null, funds });
});

app.post('/api/user/:userId/scan-list', async (req, res) => {
    const userId = req.params.userId;
    if (!userData[userId]) return res.status(404).json({ error: 'User not found' });
    if (!userData[userId].jwtToken) return res.status(400).json({ error: 'No JWT' });
    try { res.json({ success: true, ...(await scanAndListCards(userId)) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 🚀 START
// ============================================================
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
    console.log(`🔍 Debug logs available at http://localhost:${PORT}/api/debug-logs`);
    console.log(`🌐 Proxy Status: ${PROXY_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    if (PROXY_ENABLED && PROXY_URL) {
        console.log(`   Using proxy: ${PROXY_URL.replace(/:[^@]*@/, ':***@')}`);
    }
    initializeApp();
});